import { randomBytes } from "node:crypto";

import {
  assertTransactionTransition,
  changeSetSchema,
  type ApiErrorCode,
  type ApplyTransaction,
  type Change,
  type ChangeSet,
  type ConfigProvider,
  type FileResource,
  type HistoryEntry,
  type PlatformService,
  type Profile,
  type ResourceContentDto,
  type Snapshot,
  type SnapshotFile,
  type Target,
  type Workspace,
  type WorkspaceSessionDto
} from "@ruleswitch/core";

import { NodeFilesystemInfrastructure } from "../infrastructure/node-filesystem";
import {
  DesktopStores,
  type OwnershipEntry,
  type StoredSnapshotRecord,
  type TransactionLedgerEntry,
  type TransactionManifest
} from "../infrastructure/storage";

interface Session {
  readonly dto: WorkspaceSessionDto;
  readonly rootResourceId: string;
  readonly rootIdentity: string;
}

interface StagedContext {
  readonly changeSet: ChangeSet;
  readonly sourceResourceId: string;
}

export class ApplicationError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

/** Main-process application service implementing the seven frozen DesktopApi operations. */
export class RuleSwitchApplication {
  private readonly sessions = new Map<string, Session>();
  private readonly staged = new Map<string, StagedContext>();
  private readonly mutexes = new Map<string, WorkspaceMutex>();
  private readonly recoveryGates = new Set<string>();
  private readonly recoveryRootIdentities = new Set<string>();
  private readonly activeManifests = new Map<string, TransactionManifest>();

  constructor(
    private readonly platform: PlatformService,
    private readonly filesystem: NodeFilesystemInfrastructure,
    private readonly provider: ConfigProvider,
    private readonly stores: DesktopStores
  ) {}

  async initialize(): Promise<void> {
    const incomplete = await this.stores.scanIncompleteTransactions();
    for (const manifest of incomplete) {
      this.recoveryGates.add(manifest.transaction.workspaceId);
      this.recoveryRootIdentities.add(manifest.workspaceRootIdentity);
      console.error(
        JSON.stringify({
          event: "transaction_recovery_gate",
          transactionId: manifest.transaction.id,
          workspaceId: manifest.transaction.workspaceId,
          state: manifest.transaction.state
        })
      );
    }
  }

  async openWorkspace(): Promise<WorkspaceSessionDto> {
    const selection = await this.platform.selectWorkspace();
    if (selection === null) {
      throw new ApplicationError("WORKSPACE_UNAVAILABLE", "No workspace was selected.", true);
    }

    const workspaceId = opaqueId("workspace");
    let rootResourceId: string;
    try {
      rootResourceId = await this.filesystem.registerWorkspaceRoot(
        workspaceId,
        selection.selectedRoot
      );
    } catch {
      throw new ApplicationError("WORKSPACE_UNAVAILABLE", "The selected workspace is unavailable.");
    }

    let detection;
    try {
      detection = await this.provider.detect({ workspaceId, rootResourceId });
    } catch {
      throw new ApplicationError("PROVIDER_ERROR", "The Rulesync source tree is unsafe or unreadable.");
    }
    if (!detection.detected) {
      throw new ApplicationError(
        "PROVIDER_ERROR",
        "The workspace must contain .rulesync with at least one Markdown source."
      );
    }

    const profileId = opaqueId("profile");
    const targetId = opaqueId("target");
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: workspaceId,
      name: selection.displayName,
      rootResourceId,
      profileIds: [profileId],
      createdAt: now,
      updatedAt: now
    };
    const profile: Profile = {
      id: profileId,
      workspaceId,
      name: "Universal Rulesync Profile",
      kind: "universal",
      provider: this.provider.descriptor.id,
      sourceRootResourceId: detection.sourceRootResourceId,
      targetIds: [targetId]
    };
    const descriptor = this.provider.descriptor.targets.find(
      (candidate) => candidate.providerTarget === "codexcli"
    );
    if (descriptor === undefined || !descriptor.features.includes("rules")) {
      throw new ApplicationError("PROVIDER_ERROR", "The required Rulesync target is unavailable.");
    }
    const target: Target = {
      id: targetId,
      workspaceId,
      name: descriptor.name,
      provider: this.provider.descriptor.id,
      providerTarget: descriptor.providerTarget,
      features: descriptor.features
    };
    const dto: WorkspaceSessionDto = {
      workspace,
      profile,
      target,
      sourceResources: detection.sourceResources
    };
    const rootIdentity = await this.filesystem.getRootIdentity(workspaceId, rootResourceId);
    this.sessions.set(workspaceId, { dto, rootResourceId, rootIdentity });
    if (this.recoveryRootIdentities.has(rootIdentity)) {
      this.recoveryGates.add(workspaceId);
    }
    return dto;
  }

  async readResource(resourceId: string): Promise<ResourceContentDto> {
    try {
      const result = await this.filesystem.readRegisteredResource(resourceId);
      this.requireSession(result.resource.workspaceId);
      return result;
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError("UNAUTHORIZED_RESOURCE", "The resource capability is not authorized.");
    }
  }

  async openExternal(resourceId: string): Promise<null> {
    try {
      const resource = this.filesystem.getResource(resourceId);
      if (resource?.origin !== "source") {
        throw new ApplicationError(
          "UNAUTHORIZED_RESOURCE",
          "Only source resources may be opened externally."
        );
      }
      const authorized = await this.filesystem.authorizeResource(resourceId, "open-external");
      if (authorized.resource.origin !== "source") {
        throw new ApplicationError(
          "UNAUTHORIZED_RESOURCE",
          "Only source resources may be opened externally."
        );
      }
      this.requireSession(authorized.workspaceId);
      await this.platform.openExternal(resourceId);
      return null;
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError("UNAUTHORIZED_RESOURCE", "The resource cannot be opened externally.");
    }
  }

  async stageTarget(
    workspaceId: string,
    profileId: string,
    sourceResourceId: string,
    targetId: string
  ): Promise<ChangeSet> {
    const session = this.requireRelationship(workspaceId, profileId, targetId);
    if (!session.dto.sourceResources.some((resource) => resource.id === sourceResourceId)) {
      throw new ApplicationError("UNAUTHORIZED_RESOURCE", "The source capability is not in this workspace.");
    }
    const validation = await this.provider.validate({ workspaceId, profileId, sourceResourceId });
    if (!validation.valid) {
      throw new ApplicationError("PROVIDER_ERROR", "The selected Rulesync source failed validation.");
    }
    try {
      const output = await this.provider.stage({
        workspaceId,
        profileId,
        sourceResourceId,
        targetId
      });
      const changeSet = changeSetSchema.parse(
        await this.provider.preview({
          workspaceId,
          profileId,
          targetId,
          stagedOutputId: output.id
        })
      );
      this.staged.set(changeSet.id, { changeSet, sourceResourceId });
      return changeSet;
    } catch {
      throw new ApplicationError("PROVIDER_ERROR", "Rulesync could not safely stage the target.", true);
    }
  }

  async applyChangeSet(changeSetId: string): Promise<ApplyTransaction> {
    const context = this.staged.get(changeSetId);
    if (context === undefined || context.changeSet.status !== "ready") {
      throw new ApplicationError("NOT_FOUND", "The staged change set is unavailable.");
    }
    const session = this.requireRelationship(
      context.changeSet.workspaceId,
      context.changeSet.profileId,
      context.changeSet.targetId
    );
    this.assertMutationAllowed(session.dto.workspace.id);
    return this.mutexFor(session.dto.workspace.id).runExclusive(async () =>
      this.executeApply(session, context)
    );
  }

  async listHistory(workspaceId: string): Promise<readonly HistoryEntry[]> {
    this.requireSession(workspaceId);
    return this.stores.listHistory(workspaceId);
  }

  async restoreHistory(historyEntryId: string): Promise<ApplyTransaction> {
    const entry = await this.stores.findHistoryEntry(historyEntryId);
    if (entry === null) {
      throw new ApplicationError("NOT_FOUND", "The history entry is unavailable.");
    }
    const session = this.requireSession(entry.workspaceId);
    this.assertMutationAllowed(entry.workspaceId);
    return this.mutexFor(entry.workspaceId).runExclusive(async () =>
      this.executeRestore(session, entry)
    );
  }

  private async executeApply(session: Session, context: StagedContext): Promise<ApplyTransaction> {
    const changeSet = context.changeSet;
    let manifest = this.newManifest(session, "apply", changeSet.id, null, changeSet.changes);
    let snapshotRecord: StoredSnapshotRecord | null = null;
    let appendedHistoryId: string | null = null;
    let ownershipBeforeCommit: readonly OwnershipEntry[] | null = null;
    await this.persist(manifest);

    try {
      manifest = await this.transition(manifest, "STAGED");
      await this.verifyGenerated(changeSet);
      manifest = await this.transition(manifest, "PREFLIGHT");
      await this.preflightApply(session, context);

      snapshotRecord = await this.captureSnapshot(
        session,
        manifest.transaction.id,
        changeSet.changes
      );
      await this.stores.saveSnapshot(snapshotRecord);
      manifest = this.withSnapshot(manifest, snapshotRecord.snapshot.id);
      manifest = await this.transition(manifest, "BACKED_UP");
      manifest = await this.transition(manifest, "APPLYING");
      manifest = await this.applyChanges(session, manifest, changeSet.changes);
      manifest = await this.transition(manifest, "VERIFYING");
      await this.verifyApplied(session, changeSet.changes);

      const history = this.makeHistory(
        session,
        "apply",
        manifest.transaction.id,
        snapshotRecord.snapshot.id,
        changeSet.id,
        null
      );
      ownershipBeforeCommit = await this.stores.listOwnership(session.dto.workspace.id);
      await this.updateOwnershipAfterApply(session, changeSet.changes);
      await this.stores.appendHistory(history);
      appendedHistoryId = history.id;
      manifest = await this.transition(manifest, "COMMITTED");
      return manifest.transaction;
    } catch (error) {
      const latest = this.activeManifests.get(manifest.transaction.id) ?? manifest;
      await this.failAndRollback(
        session,
        latest,
        snapshotRecord?.snapshot ?? null,
        error,
        () => this.restoreCommitMetadata(session, appendedHistoryId, ownershipBeforeCommit)
      );
      throw toApplicationError(error);
    }
  }

  private async executeRestore(session: Session, sourceHistory: HistoryEntry): Promise<ApplyTransaction> {
    let desiredRecord: StoredSnapshotRecord;
    try {
      desiredRecord = await this.stores.loadSnapshot(
        sourceHistory.workspaceId,
        sourceHistory.snapshotId
      );
    } catch {
      throw new ApplicationError("TRANSACTION_ERROR", "The selected history snapshot is invalid.");
    }
    const desired = desiredRecord.snapshot;
    if (
      desired.workspaceId !== session.dto.workspace.id ||
      desired.transactionId !== sourceHistory.transactionId ||
      desired.profileId !== session.dto.profile.id ||
      !desired.targetIds.includes(session.dto.target.id) ||
      desired.provider !== this.provider.descriptor.id ||
      desired.providerVersion !== this.provider.descriptor.version
    ) {
      throw new ApplicationError("UNAUTHORIZED_RESOURCE", "The history snapshot is not owned by this session.");
    }

    const changes = await this.restoreChanges(session, desired.files);
    let manifest = this.newManifest(session, "restore", null, sourceHistory.id, changes);
    let currentSnapshotRecord: StoredSnapshotRecord | null = null;
    let appendedHistoryId: string | null = null;
    let ownershipBeforeCommit: readonly OwnershipEntry[] | null = null;
    await this.persist(manifest);
    try {
      manifest = await this.transition(manifest, "STAGED");
      await this.verifySnapshotPayloads(desired);
      manifest = await this.transition(manifest, "PREFLIGHT");
      await this.preflightRestore(session, desired);

      currentSnapshotRecord = await this.captureSnapshot(
        session,
        manifest.transaction.id,
        changes,
        desired.files.map((file) => file.logicalPath)
      );
      await this.stores.saveSnapshot(currentSnapshotRecord);
      manifest = this.withSnapshot(manifest, currentSnapshotRecord.snapshot.id);
      manifest = await this.transition(manifest, "BACKED_UP");
      manifest = await this.transition(manifest, "APPLYING");
      manifest = await this.applySnapshot(session, manifest, desired);
      manifest = await this.transition(manifest, "VERIFYING");
      await this.verifyRestored(session, desired);

      const history = this.makeHistory(
        session,
        "restore",
        manifest.transaction.id,
        currentSnapshotRecord.snapshot.id,
        null,
        sourceHistory.id
      );
      ownershipBeforeCommit = await this.stores.listOwnership(session.dto.workspace.id);
      await this.replaceAffectedOwnershipFromSnapshot(session, desiredRecord);
      await this.stores.appendHistory(history);
      appendedHistoryId = history.id;
      manifest = await this.transition(manifest, "COMMITTED");
      return manifest.transaction;
    } catch (error) {
      const latest = this.activeManifests.get(manifest.transaction.id) ?? manifest;
      await this.failAndRollback(
        session,
        latest,
        currentSnapshotRecord?.snapshot ?? null,
        error,
        () => this.restoreCommitMetadata(session, appendedHistoryId, ownershipBeforeCommit)
      );
      throw toApplicationError(error);
    }
  }

  private async preflightApply(session: Session, context: StagedContext): Promise<void> {
    const changeSet = context.changeSet;
    const validation = await this.provider.validate({
      workspaceId: changeSet.workspaceId,
      profileId: changeSet.profileId,
      sourceResourceId: context.sourceResourceId
    });
    if (!validation.valid || !sameAggregate(validation.sourceRevision, changeSet.previewRevision.sourceState)) {
      throw new ApplicationError("STALE_CHANGE_SET", "Rulesync sources changed after preview.", true);
    }

    const currentResources: FileResource[] = [];
    for (const change of changeSet.changes) {
      const current = await this.filesystem.readTargetFile(
        session.dto.workspace.id,
        session.rootResourceId,
        change.logicalPath
      );
      if (change.kind === "create") {
        if (current !== null) {
          throw new ApplicationError("STALE_CHANGE_SET", "A target was created after preview.", true);
        }
      } else {
        if (
          current === null ||
          change.before === null ||
          this.filesystem.hashBytes(current) !== change.before.hash.digest ||
          current.byteLength !== change.before.byteLength
        ) {
          throw new ApplicationError("STALE_CHANGE_SET", "A target changed after preview.", true);
        }
        currentResources.push(
          await this.filesystem.refreshFileResource(changeSet.workspaceId, change.before.resourceId)
        );
      }
    }
    const aggregate = await this.filesystem.aggregateRevision(currentResources);
    if (!sameAggregate(aggregate, changeSet.previewRevision.targetState)) {
      throw new ApplicationError("STALE_CHANGE_SET", "The target revision no longer matches preview.", true);
    }
    await this.verifyGenerated(changeSet);
  }

  private async verifyGenerated(changeSet: ChangeSet): Promise<void> {
    const generated: FileResource[] = [];
    for (const change of changeSet.changes) {
      if (change.after !== null) {
        const resource = this.filesystem.getResource(change.after.resourceId);
        if (
          resource === undefined ||
          resource.workspaceId !== changeSet.workspaceId ||
          resource.origin !== "generated" ||
          resource.logicalPath !== change.logicalPath
        ) {
          throw new ApplicationError("TRANSACTION_ERROR", "Staged output authorization is invalid.");
        }
        generated.push(
          await this.filesystem.refreshFileResource(changeSet.workspaceId, change.after.resourceId)
        );
      }
    }
    const aggregate = await this.filesystem.aggregateRevision(generated);
    if (!sameAggregate(aggregate, changeSet.previewRevision.generatedState)) {
      throw new ApplicationError("STALE_CHANGE_SET", "Generated staging changed after preview.", true);
    }
  }

  private async captureSnapshot(
    session: Session,
    transactionId: string,
    changes: readonly Change[],
    logicalPaths = changes.map((change) => change.logicalPath)
  ): Promise<StoredSnapshotRecord> {
    const files: SnapshotFile[] = [];
    const ownership: OwnershipEntry[] = [];
    const ownershipByPath = new Map(
      (await this.stores.listOwnership(session.dto.workspace.id)).map((entry) => [
        entry.logicalPath,
        entry
      ])
    );
    for (const logicalPath of logicalPaths) {
      const content = await this.filesystem.readTargetFile(
        session.dto.workspace.id,
        session.rootResourceId,
        logicalPath
      );
      const digest = content === null ? null : this.filesystem.hashBytes(content);
      files.push({
        logicalPath,
        existed: content !== null,
        hash: digest === null ? null : { algorithm: "sha256", digest },
        content
      });
      const capturedOwnership = ownershipByPath.get(logicalPath);
      if (capturedOwnership !== undefined && capturedOwnership.digest === digest) {
        ownership.push(capturedOwnership);
      }
    }
    return {
      snapshot: {
        id: opaqueId("snapshot"),
        workspaceId: session.dto.workspace.id,
        transactionId,
        profileId: session.dto.profile.id,
        targetIds: [session.dto.target.id],
        provider: this.provider.descriptor.id,
        providerVersion: this.provider.descriptor.version,
        createdAt: new Date().toISOString(),
        files
      },
      ownership
    };
  }

  private async applyChanges(
    session: Session,
    initial: TransactionManifest,
    changes: readonly Change[]
  ): Promise<TransactionManifest> {
    let manifest = initial;
    for (const change of [...changes].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))) {
      if (change.kind === "unchanged") {
        continue;
      }
      manifest = await this.markLedger(manifest, change.logicalPath, true, false);
      if (change.kind === "delete") {
        await this.assertOwnedDelete(session, change);
        if (change.before === null) {
          throw new Error("Delete change has no before revision.");
        }
        await this.filesystem.deleteAuthorizedTarget(
          session.dto.workspace.id,
          session.rootResourceId,
          change.logicalPath,
          change.before.hash.digest,
          { transactionId: manifest.transaction.id, ledgerRecorded: true }
        );
      } else {
        if (change.after === null) {
          throw new Error("A generated change has no after revision.");
        }
        const content = await this.filesystem.readResourceBytes(
          session.dto.workspace.id,
          change.after.resourceId
        );
        const written = await this.filesystem.atomicWriteTarget(
          session.dto.workspace.id,
          session.rootResourceId,
          change.logicalPath,
          content
        );
        if (
          written.hash.digest !== change.after.hash.digest ||
          written.byteLength !== change.after.byteLength
        ) {
          throw new Error("Atomic write verification failed.");
        }
      }
      manifest = await this.markLedger(manifest, change.logicalPath, true, true);
    }
    return manifest;
  }

  private async verifyApplied(session: Session, changes: readonly Change[]): Promise<void> {
    for (const change of changes) {
      const content = await this.filesystem.readTargetFile(
        session.dto.workspace.id,
        session.rootResourceId,
        change.logicalPath
      );
      if (change.kind === "delete") {
        if (content !== null) {
          throw new Error("Deleted output still exists after apply.");
        }
      } else if (
        content === null ||
        change.after === null ||
        this.filesystem.hashBytes(content) !== change.after.hash.digest ||
        content.byteLength !== change.after.byteLength
      ) {
        throw new Error("Applied output does not match staged bytes.");
      }
    }
  }

  private async restoreChanges(session: Session, files: readonly SnapshotFile[]): Promise<readonly Change[]> {
    const changes: Change[] = [];
    for (const file of files) {
      const current = await this.filesystem.readTargetFile(
        session.dto.workspace.id,
        session.rootResourceId,
        file.logicalPath
      );
      const currentRevision =
        current === null
          ? null
          : {
              resourceId: opaqueId("restore-current"),
              hash: { algorithm: "sha256" as const, digest: this.filesystem.hashBytes(current) },
              byteLength: current.byteLength
            };
      const desiredRevision =
        !file.existed || file.content === null || file.hash === null
          ? null
          : {
              resourceId: opaqueId("restore-desired"),
              hash: file.hash,
              byteLength: file.content.byteLength
            };
      const kind =
        currentRevision === null
          ? desiredRevision === null
            ? "unchanged"
            : "create"
          : desiredRevision === null
            ? "delete"
            : currentRevision.hash.digest === desiredRevision.hash.digest &&
                currentRevision.byteLength === desiredRevision.byteLength
              ? "unchanged"
              : "modify";
      changes.push({
        id: opaqueId("change"),
        targetId: session.dto.target.id,
        logicalPath: file.logicalPath,
        kind,
        before: currentRevision,
        after: desiredRevision
      });
    }
    return changes;
  }

  private async preflightRestore(session: Session, desired: Snapshot): Promise<void> {
    const ownership = await this.stores.listOwnership(session.dto.workspace.id);
    for (const file of desired.files) {
      const current = await this.filesystem.readTargetFile(
        session.dto.workspace.id,
        session.rootResourceId,
        file.logicalPath
      );
      if (!file.existed && current !== null) {
        const digest = this.filesystem.hashBytes(current);
        const owned = ownership.some(
          (entry) =>
            entry.logicalPath === file.logicalPath &&
            entry.profileId === session.dto.profile.id &&
            entry.provider === this.provider.descriptor.id &&
            entry.digest === digest
        );
        if (!owned) {
          throw new ApplicationError(
            "TRANSACTION_ERROR",
            "Restore refused to delete a target without ownership proof."
          );
        }
      }
    }
  }

  private async verifySnapshotPayloads(snapshot: Snapshot): Promise<void> {
    for (const file of snapshot.files) {
      if (
        file.existed &&
        (file.content === null ||
          file.hash === null ||
          this.filesystem.hashBytes(file.content) !== file.hash.digest)
      ) {
        throw new Error("A restore snapshot payload is corrupt.");
      }
    }
  }

  private async applySnapshot(
    session: Session,
    initial: TransactionManifest,
    desired: Snapshot
  ): Promise<TransactionManifest> {
    let manifest = initial;
    for (const file of [...desired.files].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))) {
      const current = await this.filesystem.readTargetFile(
        session.dto.workspace.id,
        session.rootResourceId,
        file.logicalPath
      );
      const alreadyDesired =
        file.existed &&
        file.content !== null &&
        current !== null &&
        this.filesystem.hashBytes(current) === file.hash?.digest;
      if (alreadyDesired || (!file.existed && current === null)) {
        continue;
      }
      manifest = await this.markLedger(manifest, file.logicalPath, true, false);
      if (file.existed) {
        if (file.content === null || file.hash === null) {
          throw new Error("Restore payload is unavailable.");
        }
        const written = await this.filesystem.atomicWriteTarget(
          session.dto.workspace.id,
          session.rootResourceId,
          file.logicalPath,
          file.content
        );
        if (written.hash.digest !== file.hash.digest) {
          throw new Error("Restore write verification failed.");
        }
      } else if (current !== null) {
        await this.filesystem.deleteAuthorizedTarget(
          session.dto.workspace.id,
          session.rootResourceId,
          file.logicalPath,
          this.filesystem.hashBytes(current),
          { transactionId: manifest.transaction.id, ledgerRecorded: true }
        );
      }
      manifest = await this.markLedger(manifest, file.logicalPath, true, true);
    }
    return manifest;
  }

  private async verifyRestored(session: Session, desired: Snapshot): Promise<void> {
    for (const file of desired.files) {
      const current = await this.filesystem.readTargetFile(
        session.dto.workspace.id,
        session.rootResourceId,
        file.logicalPath
      );
      if (!file.existed) {
        if (current !== null) {
          throw new Error("Restore absence verification failed.");
        }
      } else if (
        current === null ||
        file.hash === null ||
        this.filesystem.hashBytes(current) !== file.hash.digest
      ) {
        throw new Error("Restored bytes do not match the snapshot.");
      }
    }
  }

  private async failAndRollback(
    session: Session,
    initial: TransactionManifest,
    snapshot: Snapshot | null,
    cause: unknown,
    restoreCommitMetadata: () => Promise<void> = async () => undefined
  ): Promise<void> {
    let manifest = initial;
    const failureCode = cause instanceof ApplicationError ? cause.code : "TRANSACTION_ERROR";
    try {
      if (manifest.transaction.state !== "FAILED") {
        manifest = this.withFailure(manifest, failureCode);
        manifest = await this.transition(manifest, "FAILED");
      }
      manifest = await this.transition(manifest, "ROLLING_BACK");
      if (snapshot !== null) {
        await this.rollbackSnapshot(session, manifest, snapshot);
      }
      await restoreCommitMetadata();
      await this.transition(manifest, "ROLLED_BACK");
    } catch {
      try {
        if (manifest.transaction.state !== "FAILED" && manifest.transaction.state !== "ROLLING_BACK") {
          manifest = this.withFailure(manifest, failureCode);
          manifest = await this.transition(manifest, "FAILED");
        }
        if (manifest.transaction.state === "FAILED") {
          manifest = await this.transition(manifest, "RECOVERY_REQUIRED");
        } else if (manifest.transaction.state === "ROLLING_BACK") {
          manifest = await this.transition(manifest, "RECOVERY_REQUIRED");
        }
      } finally {
        this.recoveryGates.add(session.dto.workspace.id);
      }
      throw new ApplicationError(
        "RECOVERY_REQUIRED",
        "Rollback could not be verified; recovery evidence was retained."
      );
    }
  }

  private async rollbackSnapshot(
    session: Session,
    manifest: TransactionManifest,
    snapshot: Snapshot
  ): Promise<void> {
    for (const file of [...snapshot.files].reverse()) {
      const ledger = manifest.ledger.find((entry) => entry.logicalPath === file.logicalPath);
      if (file.existed) {
        if (file.content === null || file.hash === null) {
          throw new Error("Rollback snapshot payload is invalid.");
        }
        await this.filesystem.atomicWriteTarget(
          session.dto.workspace.id,
          session.rootResourceId,
          file.logicalPath,
          file.content
        );
      } else {
        const current = await this.filesystem.readTargetFile(
          session.dto.workspace.id,
          session.rootResourceId,
          file.logicalPath
        );
        if (current !== null) {
          if (
            ledger === undefined ||
            !ledger.mutationCompleted ||
            ledger.expectedAfterDigest === null ||
            this.filesystem.hashBytes(current) !== ledger.expectedAfterDigest
          ) {
            throw new Error("Rollback refused to delete an unproven newly-created file.");
          }
          await this.filesystem.deleteAuthorizedTarget(
            session.dto.workspace.id,
            session.rootResourceId,
            file.logicalPath,
            ledger.expectedAfterDigest,
            { transactionId: manifest.transaction.id, ledgerRecorded: true }
          );
        }
      }
    }
    await this.verifyRestored(session, snapshot);
  }

  private async assertOwnedDelete(session: Session, change: Change): Promise<void> {
    const entries = await this.stores.listOwnership(session.dto.workspace.id);
    const digest = change.before?.hash.digest;
    if (
      digest === undefined ||
      !entries.some(
        (entry) =>
          entry.logicalPath === change.logicalPath &&
          entry.profileId === session.dto.profile.id &&
          entry.provider === this.provider.descriptor.id &&
          entry.digest === digest
      )
    ) {
      throw new ApplicationError("TRANSACTION_ERROR", "Delete lacks committed ownership proof.");
    }
  }

  private async updateOwnershipAfterApply(session: Session, changes: readonly Change[]): Promise<void> {
    const byPath = new Map(
      (await this.stores.listOwnership(session.dto.workspace.id)).map((entry) => [entry.logicalPath, entry])
    );
    for (const change of changes) {
      if (change.kind === "delete") {
        byPath.delete(change.logicalPath);
      } else if (change.after !== null) {
        byPath.set(change.logicalPath, {
          logicalPath: change.logicalPath,
          profileId: session.dto.profile.id,
          provider: this.provider.descriptor.id,
          digest: change.after.hash.digest
        });
      }
    }
    await this.stores.replaceOwnership(session.dto.workspace.id, [...byPath.values()]);
  }

  private async restoreCommitMetadata(
    session: Session,
    historyEntryId: string | null,
    ownership: readonly OwnershipEntry[] | null
  ): Promise<void> {
    const operations: Array<Promise<void>> = [];
    if (historyEntryId !== null) {
      operations.push(this.stores.removeHistory(session.dto.workspace.id, historyEntryId));
    }
    if (ownership !== null) {
      operations.push(this.stores.replaceOwnership(session.dto.workspace.id, ownership));
    }
    await Promise.all(operations);
  }

  private async replaceAffectedOwnershipFromSnapshot(
    session: Session,
    source: StoredSnapshotRecord
  ): Promise<void> {
    const affected = new Set(source.snapshot.files.map((file) => file.logicalPath));
    const byPath = new Map(
      (await this.stores.listOwnership(session.dto.workspace.id))
        .filter((entry) => !affected.has(entry.logicalPath))
        .map((entry) => [entry.logicalPath, entry])
    );
    for (const ownership of source.ownership) {
      if (!affected.has(ownership.logicalPath)) {
        throw new Error("Snapshot ownership references an unaffected path.");
      }
      byPath.set(ownership.logicalPath, ownership);
    }
    await this.stores.replaceOwnership(session.dto.workspace.id, [...byPath.values()]);
  }

  private newManifest(
    session: Session,
    operation: "apply" | "restore",
    changeSetId: string | null,
    restoreHistoryEntryId: string | null,
    changes: readonly Change[]
  ): TransactionManifest {
    const now = new Date().toISOString();
    const transaction: ApplyTransaction = {
      id: opaqueId("transaction"),
      operation,
      workspaceId: session.dto.workspace.id,
      changeSetId,
      restoreHistoryEntryId,
      snapshotId: null,
      state: "PREPARING",
      failure: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null
    };
    const ledger: TransactionLedgerEntry[] = changes.map((change) => ({
      logicalPath: change.logicalPath,
      kind: change.kind,
      expectedAfterDigest: change.after?.hash.digest ?? null,
      mutationStarted: false,
      mutationCompleted: false
    }));
    return {
      version: 1,
      transaction,
      profileId: session.dto.profile.id,
      targetId: session.dto.target.id,
      rootResourceId: session.rootResourceId,
      workspaceRootIdentity: session.rootIdentity,
      provider: this.provider.descriptor.id,
      providerVersion: this.provider.descriptor.version,
      ledger,
      failureCode: null
    };
  }

  private withSnapshot(manifest: TransactionManifest, snapshotId: string): TransactionManifest {
    return {
      ...manifest,
      transaction: { ...manifest.transaction, snapshotId, updatedAt: new Date().toISOString() }
    };
  }

  private withFailure(manifest: TransactionManifest, code: string): TransactionManifest {
    return {
      ...manifest,
      failureCode: code,
      transaction: {
        ...manifest.transaction,
        failure: {
          code,
          message: "The transaction failed and did not commit.",
          affectedResourceIds: []
        },
        updatedAt: new Date().toISOString()
      }
    };
  }

  private async transition(
    manifest: TransactionManifest,
    state: ApplyTransaction["state"]
  ): Promise<TransactionManifest> {
    assertTransactionTransition(manifest.transaction.state, state);
    const now = new Date().toISOString();
    const next: TransactionManifest = {
      ...manifest,
      transaction: {
        ...manifest.transaction,
        state,
        updatedAt: now,
        completedAt: ["COMMITTED", "ROLLED_BACK", "RECOVERY_REQUIRED"].includes(state) ? now : null
      }
    };
    await this.persist(next);
    return next;
  }

  private async markLedger(
    manifest: TransactionManifest,
    logicalPath: string,
    mutationStarted: boolean,
    mutationCompleted: boolean
  ): Promise<TransactionManifest> {
    const next = {
      ...manifest,
      ledger: manifest.ledger.map((entry) =>
        entry.logicalPath === logicalPath
          ? { ...entry, mutationStarted, mutationCompleted }
          : entry
      )
    };
    await this.persist(next);
    return next;
  }

  private async persist(manifest: TransactionManifest): Promise<void> {
    await this.stores.saveTransaction(manifest);
    this.activeManifests.set(manifest.transaction.id, manifest);
    console.info(
      JSON.stringify({
        event: "transaction_state",
        transactionId: manifest.transaction.id,
        workspaceId: manifest.transaction.workspaceId,
        operation: manifest.transaction.operation,
        state: manifest.transaction.state
      })
    );
  }

  private makeHistory(
    session: Session,
    kind: "apply" | "restore",
    transactionId: string,
    snapshotId: string,
    changeSetId: string | null,
    restoredFromHistoryEntryId: string | null
  ): HistoryEntry {
    return {
      id: opaqueId("history"),
      workspaceId: session.dto.workspace.id,
      kind,
      transactionId,
      snapshotId,
      changeSetId,
      restoredFromHistoryEntryId,
      createdAt: new Date().toISOString(),
      summary: kind === "apply" ? "Applied staged Rulesync changes" : "Restored a previous snapshot"
    };
  }

  private requireSession(workspaceId: string): Session {
    const session = this.sessions.get(workspaceId);
    if (session === undefined) {
      throw new ApplicationError("WORKSPACE_UNAVAILABLE", "The workspace session is unavailable.");
    }
    return session;
  }

  private requireRelationship(workspaceId: string, profileId: string, targetId: string): Session {
    const session = this.requireSession(workspaceId);
    if (
      session.dto.profile.id !== profileId ||
      session.dto.target.id !== targetId ||
      session.dto.profile.provider !== this.provider.descriptor.id ||
      session.dto.target.provider !== this.provider.descriptor.id ||
      session.dto.target.providerTarget !== "codexcli" ||
      !session.dto.target.features.includes("rules")
    ) {
      throw new ApplicationError("UNAUTHORIZED_RESOURCE", "Workspace, profile, target, or provider ownership is invalid.");
    }
    return session;
  }

  private assertMutationAllowed(workspaceId: string): void {
    if (this.recoveryGates.has(workspaceId)) {
      throw new ApplicationError(
        "RECOVERY_REQUIRED",
        "This workspace is blocked by an incomplete transaction."
      );
    }
  }

  private mutexFor(workspaceId: string): WorkspaceMutex {
    const existing = this.mutexes.get(workspaceId);
    if (existing !== undefined) {
      return existing;
    }
    const mutex = new WorkspaceMutex();
    this.mutexes.set(workspaceId, mutex);
    return mutex;
  }
}

class WorkspaceMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function sameAggregate(
  left: ChangeSet["previewRevision"]["sourceState"],
  right: ChangeSet["previewRevision"]["sourceState"]
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.serialization === right.serialization &&
    left.digest === right.digest
  );
}

function opaqueId(kind: string): string {
  return `${kind}_${randomBytes(24).toString("base64url")}`;
}

function toApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  return new ApplicationError("TRANSACTION_ERROR", "The transaction failed and was rolled back.", true);
}
