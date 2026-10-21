// v2 capability service (M7): the Main-side application layer that turns
// M1–M6 business capabilities into the frozen v2 read models. This is the
// ONLY code the v2 UI talks to; it never exposes absolute paths and every
// read goes through fresh GitPort/scanner reads.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  GitAreaReadModel,
  HarnessDto,
  LibraryEntryDto,
  LibraryReadModel,
  OperationHistoryDto,
  OverviewReadModel,
  ProjectBindRequest,
  ProjectBindingOutcome,
  ProjectDto,
  HarnessFileDto,
  HarnessScanReadModel,
  RecoveryReadModel,
  RepositoryCloneOutcome,
  RollbackOutcome,
  RepositoryValidation,
  SetCompareReadModel,
  SettingsReadModel,
  ApplyDiffReadModel,
  ApplyFileDiff
} from "@ruleswitch/core";
import {
  buildApplyPlan,
  compareCollections,
  loadRepoInventory,
  matchesRemote,
  matrixKindsFor,
  matrixRowFor,
  planRepoEdit,
  resolveAssetSet,
  settleBatch,
  type ApplyModeName,
  type ApplyOutcome,
  type ApplyOutcomeEntry,
  type ApplyPreview,
  type ApplyPreviewEntry,
  type ApplyPlanEntry,
  type ApplyTargetInput,
  type ApplyTargetSelection,
  type AssetKind,
  type BatchJournal,
  type HarnessInstanceId,
  type RepositoryId,
  type StableIdHasher,
  type RemoteMatchPattern,
  type SyncBaselineRecord
} from "@ruleswitch/core";

import type { GitPortAdapter } from "../infrastructure/git/git-port-adapter";
import type { ProjectsStore, SettingsStore } from "../infrastructure/git/binding-store";
import type { SyncBaselineStore } from "../infrastructure/git/baseline-store";
import type { BatchSnapshotStore, BatchSnapshotManifest } from "../infrastructure/git/batch-snapshot-store";
import type { OperationsStore } from "../infrastructure/git/sync-state";
import { isSafeRelativePath } from "../infrastructure/path-safety";
import { applyRenderedTargets } from "../infrastructure/harness/skill-slice";

export interface CapabilityV2Options {
  readonly gitPort: GitPortAdapter;
  readonly projectsStore: ProjectsStore;
  readonly settingsStore: SettingsStore;
  readonly operationsStore: OperationsStore;
  /**
   * Sync baselines. When present, apply consults real ownership instead of
   * assuming none — repeat applies become noop rather than needs-adoption.
   */
  readonly baselineStore?: SyncBaselineStore;
  /** Persists pre-apply bytes so a finished batch can be rolled back. */
  readonly snapshotStore?: BatchSnapshotStore;
  readonly harnessRegistry?: {
    listRegistrations(): readonly {
      harnessInstanceId: string;
      adapterId: string;
      displayName: string;
      installed: boolean;
    }[];
  };
  readonly hasher: StableIdHasher;
  /**
   * Process-crash drill seam (test/CI only). Called at every durable phase
   * of a batch apply so a drill can kill the process — by SIGKILL, not by
   * throwing — and then inspect what survived on disk. Production never
   * supplies it, so the call sites cost nothing.
   */
  readonly crashHook?: (phase: ApplyCrashPhase) => void;
}

/**
 * Durable phases of one batch apply. Everything between two phases must be
 * reconstructible from the journal + snapshot store after a hard kill.
 */
export type ApplyCrashPhase =
  | "journal-started"
  | "snapshot-recorded"
  | "write-started"
  | "write-finished"
  | "target-committed";

function kindGroupOf(kind: AssetKind): string {
  const groups: Record<AssetKind, string> = {
    instructions: "Rules",
    skills: "Skills",
    mcp: "MCP",
    hooks: "Hooks",
    commands: "Commands",
    prompts: "Prompts",
    agents: "Agents",
    settings: "Settings",
    native: "Native"
  };
  return groups[kind];
}

export class CapabilityServiceV2 {
  /** Currently-open repository (opaque id → adapter registry inside GitPort). */
  private openRepositoryId: RepositoryId | null = null;

  constructor(private readonly options: CapabilityV2Options) {}

  async openRepositoryFromDirectory(directory: string): Promise<OverviewReadModel | null> {
    const opened = await this.options.gitPort.open({ localPath: directory });
    if (!opened.ok || opened.value === null) {
      return null;
    }
    this.openRepositoryId = opened.value.repositoryId;
    return this.overviewFrom(opened.value);
  }

  /**
   * Clones a config repo and opens it. Refuses an existing target directory:
   * cloning into a non-empty tree would merge unrelated content.
   */
  async cloneRepository(
    remoteUrl: string,
    targetDirectory: string
  ): Promise<RepositoryCloneOutcome> {
    const directory = targetDirectory.trim();
    if (directory.length === 0 || remoteUrl.trim().length === 0) {
      return { ok: false, reason: "remote URL and target directory are required", manifestPresent: false };
    }
    try {
      await stat(directory);
      return {
        ok: false,
        reason: "the target directory already exists; choose a new directory or open it instead",
        manifestPresent: false
      };
    } catch {
      // Absent target directory is the expected case.
    }
    const cloned = await this.options.gitPort.clone({
      remoteUrl: remoteUrl.trim(),
      targetDirectory: directory
    });
    if (!cloned.ok || cloned.value === null) {
      return {
        ok: false,
        reason: cloned.error?.message ?? "clone failed",
        manifestPresent: false
      };
    }
    this.openRepositoryId = cloned.value.repositoryId;
    const described = await this.options.gitPort.describeRepository(cloned.value.repositoryId);
    return {
      ok: true,
      reason: null,
      manifestPresent: described.ok && described.value !== null ? described.value.manifestPresent : false
    };
  }

  async repositoryStatus(): Promise<OverviewReadModel | null> {
    if (this.openRepositoryId === null) {
      return null;
    }
    const status = await this.options.gitPort.status(this.openRepositoryId);
    if (!status.ok || status.value === null) {
      return null;
    }
    return this.overviewFrom(status.value);
  }

  private async overviewFrom(status: {
    repositoryId: RepositoryId;
    headRevision: string | null;
    workingTree: string;
    pendingPublish: boolean;
  }): Promise<OverviewReadModel> {
    const projects = await this.listProjects();
    const harnesses = await this.listHarnesses();
    let libraryDrafts = 0;
    const library = await this.browseLibrary().catch(() => null);
    if (library !== null) {
      libraryDrafts = library.draftCount;
    }
    return {
      repositoryBound: true,
      repositoryId: status.repositoryId,
      branch: null,
      workingTree: status.workingTree,
      pendingPublish: status.pendingPublish,
      projectCount: projects.length,
      harnessCount: harnesses.length,
      libraryDrafts
    };
  }

  /** Library read model: HEAD entries with draft markers (INH-1851 core shaping). */
  async browseLibrary(): Promise<LibraryReadModel | null> {
    if (this.openRepositoryId === null) {
      return null;
    }
    const status = await this.options.gitPort.status(this.openRepositoryId);
    if (!status.ok || status.value === null) {
      return null;
    }
    const { createFsRepoFileSource } = await import("../infrastructure/git/repo-source");
    const inventoryResult = await loadRepoInventory(createFsRepoFileSource(this.options.gitPort.currentRoot()), this.options.hasher);
    if (!inventoryResult.ok) {
      return null;
    }
    const inventory = inventoryResult.inventory;
    const worktreeByPath = new Map(
      status.value.paths.map((pathStatus) => [pathStatus.logicalPath, pathStatus])
    );
    const headByPath = new Map(
      status.value.paths
        .filter((pathStatus) => pathStatus.headDigest !== null)
        .map((pathStatus) => [pathStatus.logicalPath, pathStatus.headDigest ?? ""])
    );

    const entries: LibraryEntryDto[] = inventory.assets.map((asset) => {
      const pathStatus = worktreeByPath.get(asset.sourceLogicalPath);
      const headDigest = headByPath.get(asset.sourceLogicalPath) ?? null;
      const isDraft =
        pathStatus !== undefined &&
        pathStatus.worktreeDigest !== null &&
        (headDigest === null || pathStatus.worktreeDigest !== headDigest);
      return {
        assetKey: asset.sourceLogicalPath,
        kind: asset.kind,
        logicalName: asset.logicalName,
        state: isDraft ? "draft" : "head",
        digest: asset.contentDigest,
        byteLength: asset.content.byteLength,
        kindGroup: kindGroupOf(asset.kind)
      };
    });
    entries.sort((left, right) => (left.assetKey < right.assetKey ? -1 : 1));
    return {
      repositoryId: this.openRepositoryId,
      headRevision: status.value.headRevision,
      branch: null,
      entries,
      draftCount: entries.filter((entry) => entry.state === "draft").length
    };
  }

  /**
   * Reads one repository asset for the editor. `logicalPath` is the opaque
   * source-relative key (`assetKey`); Main resolves it against a fresh
   * inventory, so the Renderer still never handles a filesystem path.
   */
  async readRepoFile(
    logicalPath: string
  ): Promise<{ readonly logicalPath: string; readonly contentBase64: string } | null> {
    if (this.openRepositoryId === null) {
      return null;
    }
    const { createFsRepoFileSource } = await import("../infrastructure/git/repo-source");
    const inventoryResult = await loadRepoInventory(
      createFsRepoFileSource(this.options.gitPort.currentRoot()),
      this.options.hasher
    );
    if (!inventoryResult.ok) {
      return null;
    }
    const asset = inventoryResult.inventory.assets.find(
      (candidate) => candidate.sourceLogicalPath === logicalPath
    );
    if (asset === undefined) {
      return null;
    }
    return {
      logicalPath,
      contentBase64: Buffer.from(asset.content).toString("base64")
    };
  }

  /** Git working area read model (INH-1856 core shaping). */  async gitArea(): Promise<GitAreaReadModel | null> {
    if (this.openRepositoryId === null) {
      return null;
    }
    const status = await this.options.gitPort.status(this.openRepositoryId);
    if (!status.ok || status.value === null) {
      return null;
    }
    const stagedDiff = await this.options.gitPort.diff(this.openRepositoryId, "head-to-index");
    const worktreeDiff = await this.options.gitPort.diff(this.openRepositoryId, "index-to-worktree");
    const changes: { logicalPath: string; managed: boolean; staged: boolean; kind: "create" | "modify" | "delete" }[] = [];
    const seen = new Set<string>();
    for (const source of [stagedDiff, worktreeDiff]) {
      if (!source.ok || source.value === null) {
        continue;
      }
      for (const entry of source.value) {
        if (seen.has(entry.logicalPath)) {
          continue;
        }
        seen.add(entry.logicalPath);
        const pathStatus = status.value.paths.find((candidate) => candidate.logicalPath === entry.logicalPath);
        changes.push({
          logicalPath: entry.logicalPath,
          managed: pathStatus?.managed ?? false,
          staged: pathStatus?.staged ?? false,
          kind: entry.changeKind
        });
      }
    }
    changes.sort((left, right) => (left.logicalPath < right.logicalPath ? -1 : 1));
    return {
      headRevision: status.value.headRevision,
      upstreamRevision: status.value.upstreamRevision,
      remoteStatus: status.value.remoteStatus,
      ahead: status.value.ahead,
      behind: status.value.behind,
      workingTree: status.value.workingTree,
      pendingPublish: status.value.pendingPublish,
      changes
    };
  }

  /** Harness set comparison (INH-1857 core shaping): global collection vs codex native collection. */
  async setCompare(): Promise<SetCompareReadModel | null> {
    if (this.openRepositoryId === null) {
      return null;
    }
    const { createFsRepoFileSource } = await import("../infrastructure/git/repo-source");
    const inventoryResult = await loadRepoInventory(
      createFsRepoFileSource(this.options.gitPort.currentRoot()),
      this.options.hasher
    );
    if (!inventoryResult.ok) {
      return null;
    }
    const inventory = inventoryResult.inventory;
    const SOURCE_PREFIX = "global/skills/";
    // Native variants live under global/native/<adapter>/..., so the logical
    // prefix (what the target collection calls the asset) and the repository
    // path prefix are different strings.
    const TARGET_LOGICAL_PREFIX = "codex/skills/";
    const TARGET_PATH_PREFIX = "global/native/codex/skills/";

    // Real repository paths are kept alongside the semantic key so the UI can
    // resolve one item at a time (INH-1857) without a second lookup channel.
    const sourcePaths = new Map<string, string>();
    const targetPaths = new Map<string, string>();
    const sourceAssets = inventory.assets
      .filter((asset) => asset.kind === "skills" && asset.sourceLogicalPath.startsWith(SOURCE_PREFIX))
      .map((asset) => {
        const logicalName = asset.sourceLogicalPath.slice(SOURCE_PREFIX.length);
        sourcePaths.set(`skills|${logicalName}`, asset.sourceLogicalPath);
        return { kind: "skills" as const, logicalName, digest: asset.contentDigest };
      });
    const targetAssets = inventory.assets
      .filter(
        (asset) => asset.kind === "native" && asset.logicalName.startsWith(TARGET_LOGICAL_PREFIX)
      )
      .map((asset) => {
        const logicalName = asset.logicalName.slice(TARGET_LOGICAL_PREFIX.length);
        targetPaths.set(`skills|${logicalName}`, asset.sourceLogicalPath);
        return { kind: "skills" as const, logicalName, digest: asset.contentDigest };
      });

    const comparison = compareCollections({
      repositoryId: this.openRepositoryId,
      source: { label: "global-skills", assets: sourceAssets, supportedKinds: new Set(["skills"] as const) },
      target: { label: "codex-collection", assets: targetAssets, supportedKinds: new Set(["skills"] as const) },
      baselines: {},
      trustedBaseline: false
    });
    return {
      confidence: comparison.confidence,
      diffs: comparison.diffs.map((diff) => {
        // A side that does not exist yet still gets its destination path, so
        // the UI never assembles repository paths itself.
        const logicalName = diff.semanticKey.slice("skills|".length);
        const existingSource = sourcePaths.get(diff.semanticKey) ?? null;
        const existingTarget = targetPaths.get(diff.semanticKey) ?? null;
        return {
          assetKey: diff.semanticKey,
          sourceAssetKey: existingSource ?? (existingTarget !== null ? `${SOURCE_PREFIX}${logicalName}` : null),
          targetAssetKey:
            existingTarget ?? (existingSource !== null ? `${TARGET_PATH_PREFIX}${logicalName}` : null),
          kind: diff.kind,
          relation: diff.relation
        };
      })
    };
  }

  async listProjects(): Promise<readonly ProjectDto[]> {
    const bindings = this.options.projectsStore.current().bindings;
    const patternsByProject = await this.projectPatterns();
    return Promise.all(
      Object.values(bindings).map(async (binding) => ({
        projectId: binding.projectId,
        displayName: binding.displayName,
        localPathPresent: binding.localPath.length > 0,
        available: binding.available,
        remoteVerified: await this.verifyProjectRemote(
          binding.localPath,
          patternsByProject.get(binding.projectId) ?? []
        )
      }))
    ).then((projects) =>
      [...projects].sort((left, right) => (left.projectId < right.projectId ? -1 : 1))
    );
  }

  /** Manifest validation without writes (INH-1809 connect step). */
  async validateRepository(): Promise<RepositoryValidation | null> {
    if (this.openRepositoryId === null) {
      return null;
    }
    const { createFsRepoFileSource } = await import("../infrastructure/git/repo-source");
    const result = await loadRepoInventory(
      createFsRepoFileSource(this.options.gitPort.currentRoot()),
      this.options.hasher
    );
    if (!result.ok) {
      return {
        ok: false,
        schemaVersion: null,
        assetCount: 0,
        projectCount: 0,
        profileCount: 0,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          logicalPath: diagnostic.logicalPath,
          message: diagnostic.message
        }))
      };
    }
    return {
      ok: true,
      schemaVersion: result.inventory.manifest.schemaVersion,
      assetCount: result.inventory.assets.length,
      projectCount: result.inventory.projects.length,
      profileCount: result.inventory.profiles.length,
      diagnostics: []
    };
  }

  /**
   * Binds a project directory. Never fakes a remote match: v1 patterns only
   * express `git://` / `file://`, so an https origin reports `unknown`.
   */
  async bindProject(request: ProjectBindRequest): Promise<ProjectBindingOutcome> {
    if (this.openRepositoryId === null) {
      return {
        ok: false,
        reason: "no repository is open",
        remoteVerified: "unknown",
        diagnostic: null
      };
    }
    const directory = request.localPath.trim();
    try {
      const info = await stat(directory);
      if (!info.isDirectory()) {
        return {
          ok: false,
          reason: "the path is not a directory",
          remoteVerified: "unknown",
          diagnostic: null
        };
      }
    } catch {
      return {
        ok: false,
        reason: "the directory is missing or not readable",
        remoteVerified: "unknown",
        diagnostic: null
      };
    }

    const bindings = Object.values(this.options.projectsStore.current().bindings);
    const samePath = bindings.find(
      (binding) => binding.localPath === directory && binding.projectId !== request.projectId
    );
    if (samePath !== undefined) {
      return {
        ok: false,
        reason: `the directory is already bound to project ${samePath.projectId}`,
        remoteVerified: "unknown",
        diagnostic: null
      };
    }
    const existing = bindings.find((binding) => binding.projectId === request.projectId);
    if (existing !== undefined && existing.localPath !== directory && request.rebind !== true) {
      return {
        ok: false,
        reason: "the project is already bound to another directory; confirm rebinding first",
        remoteVerified: "unknown",
        diagnostic: null
      };
    }

    const patterns = (await this.projectPatterns()).get(request.projectId) ?? [];
    const remoteVerified = await this.verifyProjectRemote(directory, patterns);

    await this.options.projectsStore.bindProject({
      projectId: request.projectId,
      repositoryId: this.openRepositoryId,
      localPath: directory,
      displayName: request.displayName.trim()
    });

    return {
      ok: true,
      reason: null,
      remoteVerified,
      diagnostic:
        remoteVerified === "unknown"
          ? "remote identity could not be verified: no matching git:// or file:// pattern for this project"
          : remoteVerified === "mismatch"
            ? "the directory's git origin does not match the project's remote patterns"
            : null
    };
  }

  async unbindProject(projectId: string): Promise<boolean> {
    return this.options.projectsStore.unbind(projectId);
  }

  /** Remote match patterns declared in the repository manifest, per project. */
  private async projectPatterns(): Promise<Map<string, readonly RemoteMatchPattern[]>> {
    const patterns = new Map<string, readonly RemoteMatchPattern[]>();
    if (this.openRepositoryId === null) {
      return patterns;
    }
    const { createFsRepoFileSource } = await import("../infrastructure/git/repo-source");
    const result = await loadRepoInventory(
      createFsRepoFileSource(this.options.gitPort.currentRoot()),
      this.options.hasher
    );
    if (!result.ok) {
      return patterns;
    }
    for (const project of result.inventory.projects) {
      patterns.set(project.projectId, project.remoteMatch);
    }
    return patterns;
  }

  /**
   * Reads the directory's origin URL and checks it against the declared
   * patterns. https/ssh origins are reported `unknown` because v1 patterns
   * cannot express them — reporting `matched` there would be a guess.
   */
  private async verifyProjectRemote(
    directory: string,
    patterns: readonly RemoteMatchPattern[]
  ): Promise<"matched" | "mismatch" | "unknown"> {
    if (patterns.length === 0) {
      return "unknown";
    }
    let config: string;
    try {
      config = await readFile(path.join(directory, ".git", "config"), "utf8");
    } catch {
      return "unknown";
    }
    const originMatch = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config);
    const origin = originMatch?.[1] ?? null;
    if (origin === null) {
      return "unknown";
    }
    const canonical = origin.replace(/\.git$/, "");
    if (!canonical.startsWith("git://") && !canonical.startsWith("file://")) {
      return "unknown";
    }
    return patterns.some((pattern) => matchesRemote(pattern, canonical))
      ? "matched"
      : "mismatch";
  }

  async listHarnesses(): Promise<readonly HarnessDto[]> {
    // Registered harnesses come from the harness registry store; readiness
    // from the M5 classifier facts (installed/mapping/supported/writable).
    const registrations = this.options.harnessRegistry?.listRegistrations() ?? [];
    return registrations
      .map((registration) => {
        const kinds = matrixKindsFor(registration.adapterId);
        return {
          harnessInstanceId: registration.harnessInstanceId,
          adapterId: registration.adapterId,
          displayName: registration.displayName,
          installed: registration.installed,
          readiness: registration.installed ? "READY" : "not-installed",
          // Honest capability surface: only kinds this adapter can write.
          globalKinds: kinds.filter((row) => row.global === "read-write").map((row) => row.kind),
          projectKinds: kinds.filter((row) => row.project === "read-write").map((row) => row.kind)
        };
      })
      .sort((left, right) => (left.displayName < right.displayName ? -1 : 1));
  }

  /**
   * Scans a harness root and reports what is really on disk (INH-1854).
   *
   * Safety: symlinks are skipped (never followed), traversal is bounded, only
   * relative paths are returned, and `managed` is true only when a
   * SyncBaseline proves RuleSwitch wrote that path — an unmanaged local file
   * is never claimed.
   */
  async scanHarness(harnessInstanceId: string): Promise<HarnessScanReadModel | null> {
    const registrations = this.options.harnessRegistry?.listRegistrations() ?? [];
    const registration = registrations.find(
      (candidate) => candidate.harnessInstanceId === harnessInstanceId
    );
    if (registration === undefined) {
      return null;
    }
    const matrixRow = matrixRowFor(registration.adapterId);
    const base = {
      harnessInstanceId: registration.harnessInstanceId,
      adapterId: registration.adapterId,
      displayName: registration.displayName,
      scannedAt: new Date().toISOString()
    };
    if (matrixRow === null) {
      return {
        ...base,
        rootPresent: false,
        truncated: false,
        files: [],
        managedCount: 0,
        unclassifiedCount: 0
      };
    }
    const root = path.join(process.env.HOME ?? "", matrixRow.paths.globalRoot);
    const rootPresent = await isDirectory(root);
    if (!rootPresent) {
      return {
        ...base,
        rootPresent: false,
        truncated: false,
        files: [],
        managedCount: 0,
        unclassifiedCount: 0
      };
    }

    const { files, truncated } = await walkHarnessRoot(root, MAX_HARNESS_FILES, MAX_HARNESS_DEPTH);
    const mapped: HarnessFileDto[] = [];
    for (const file of files) {
      const digest = digestBytes(file.content);
      mapped.push({
        relativePath: file.relativePath,
        byteLength: file.content.byteLength,
        digest,
        kind: classifyHarnessPath(file.relativePath),
        managed:
          this.options.baselineStore !== undefined && this.openRepositoryId !== null
            ? this.options.baselineStore.find(
                this.openRepositoryId,
                registration.harnessInstanceId,
                file.relativePath
              ) !== null
            : false
      });
    }
    mapped.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
    return {
      ...base,
      rootPresent: true,
      truncated,
      files: mapped,
      managedCount: mapped.filter((file) => file.managed).length,
      unclassifiedCount: mapped.filter((file) => file.kind === null).length
    };
  }

  async operationHistory(): Promise<readonly OperationHistoryDto[]> {
    return Object.values(this.options.operationsStore.current().batchJournals)
      .map((journal) => ({
        batchId: journal.batchId,
        planId: journal.planId,
        status: journal.status,
        updatedAt: journal.updatedAt,
        targets: journal.entries.map((entry) => ({
          targetKey: entry.targetKey,
          state: entry.state,
          mode: entry.mode
        }))
      }))
      .sort((left, right) => (right.updatedAt < left.updatedAt ? -1 : 1));
  }

  /**
   * Batches needing operator attention (INH-1821). Deliberately does not
   * offer rollback: the pre-apply snapshot payload is not persisted yet, so
   * a "restore" button would be a lie. Guidance points at Git instead.
   */
  async recoveryStatus(): Promise<RecoveryReadModel> {
    const snapshotStore = this.options.snapshotStore;
    const batches = this.options.operationsStore.listAllBatches().filter(
      (journal) =>
        journal.status !== "ALL_COMMITTED" ||
        journal.entries.some(
          (entry) =>
            entry.state === "PREFLIGHT_FAILED" ||
            entry.state === "APPLY_FAILED" ||
            entry.state === "VERIFY_FAILED" ||
            entry.state === "ROLLBACK_FAILED"
        )
    );
    const withAvailability = await Promise.all(
      batches.map(async (journal) => {
        const snapshot = snapshotStore === undefined ? null : await snapshotStore.load(journal.batchId);
        // "A snapshot exists" is not the same as "it can be restored": every
        // file must still hold the bytes apply wrote (or be absent when it
        // never existed). Otherwise the button would be a lie.
        const restorable = snapshot === null ? false : await this.snapshotRestorable(snapshot);
        return { journal, snapshotAvailable: snapshot !== null, restorable };
      })
    );
    return {
      batches: withAvailability.map(({ journal, snapshotAvailable, restorable }) => ({
        batchId: journal.batchId,
        planId: journal.planId,
        status: journal.status,
        startedAt: journal.startedAt,
        updatedAt: journal.updatedAt,
        targets: journal.entries
          .filter((entry) => entry.state !== "COMMITTED")
          .map((entry) => ({
            targetKey: entry.targetKey,
            mode: entry.mode,
            state: entry.state,
            detail: entry.failureDetail
          })),
        rollbackAvailable:
          snapshotAvailable &&
          restorable &&
          journal.status !== "ROLLED_BACK" &&
          journal.status !== "RUNNING",
        rollbackReason:
          journal.status === "ROLLED_BACK"
            ? "该批次已回滚"
            : journal.status === "RUNNING"
              ? "批次仍在执行，不能回滚"
              : !snapshotAvailable
                ? "该批次没有记录 apply 前快照（早于快照持久化），无法自动回滚"
                : !restorable
                  ? "目标内容与 apply 写入的字节已不一致，回滚无法自证安全"
                  : null,
        guidance:
          journal.status === "RECOVERY_REQUIRED"
            ? "该批次无法自证回滚。请用 Git 恢复受影响文件，确认真实状态后再重新应用。"
            : "有目标未完成或被拒绝。核对下方每个目标的状态，修正原因后重新预览并应用。"
      }))
    };
  }

  async getSettings(): Promise<SettingsReadModel> {
    const data = this.options.settingsStore.current();
    return { theme: data.theme, selectedProfile: null };
  }

  async setTheme(theme: "light" | "dark" | "system"): Promise<SettingsReadModel> {
    await this.options.settingsStore.setTheme(theme);
    return this.getSettings();
  }

  /** Resolved asset set for the UI's project/preview flows (v2 read path). */
  async resolvedAssets(profile: string | null, projectId: string | null, adapterId: "claude-code" | "codex" | "cursor" | "opencode") {
    const { createFsRepoFileSource } = await import("../infrastructure/git/repo-source");
    const currentRoot = this.options.gitPort.currentRoot();
    const inventory = await loadRepoInventory(createFsRepoFileSource(currentRoot), this.options.hasher);
    if (!inventory.ok) {
      return null;
    }
    return resolveAssetSet(
      { inventory: inventory.inventory, profile, projectId, adapterId },
      this.options.hasher
    );
  }

  // -------------------------------------------------------------------------
  // Git working-area operations (INH-1856): stage/unstage/commit/push/FF/log
  // -------------------------------------------------------------------------

  async stagePaths(logicalPaths: readonly string[]): Promise<boolean> {
    if (this.openRepositoryId === null) {
      return false;
    }
    const expected = await this.options.gitPort.currentExpectedRevisions(this.openRepositoryId);
    if (!expected.ok || expected.value === null) {
      return false;
    }
    const staged = await this.options.gitPort.stage({
      repositoryId: this.openRepositoryId,
      logicalPaths,
      expected: expected.value
    });
    return staged.ok;
  }

  async unstagePaths(logicalPaths: readonly string[]): Promise<boolean> {
    if (this.openRepositoryId === null) {
      return false;
    }
    const expected = await this.options.gitPort.currentExpectedRevisions(this.openRepositoryId);
    if (!expected.ok || expected.value === null) {
      return false;
    }
    const unstaged = await this.options.gitPort.unstage({
      repositoryId: this.openRepositoryId,
      logicalPaths,
      expected: expected.value
    });
    return unstaged.ok;
  }

  async commit(message: string): Promise<{ readonly ok: true; readonly revision: string } | { readonly ok: false; readonly reason: string }> {
    if (this.openRepositoryId === null) {
      return { ok: false, reason: "no repository open" };
    }
    const status = await this.options.gitPort.status(this.openRepositoryId);
    if (!status.ok || status.value === null) {
      return { ok: false, reason: "status failed" };
    }
    const stagedPaths = status.value.paths.filter((pathStatus) => pathStatus.staged).map((pathStatus) => pathStatus.logicalPath);
    if (stagedPaths.length === 0) {
      return { ok: false, reason: "nothing staged" };
    }
    const commit = await this.options.gitPort.commitStaged({
      repositoryId: this.openRepositoryId,
      message,
      expected: { head: status.value.headRevision, worktreeDigest: null },
      allowedManagedPaths: stagedPaths
    });
    if (!commit.ok || commit.value === null) {
      return { ok: false, reason: commit.error?.message ?? "commit failed" };
    }
    return { ok: true, revision: commit.value.revision };
  }

  async push(): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
    if (this.openRepositoryId === null) {
      return { ok: false, reason: "no repository open" };
    }
    const head = await this.options.gitPort.status(this.openRepositoryId);
    if (!head.ok || head.value === null || head.value.headRevision === null) {
      return { ok: false, reason: "no HEAD" };
    }
    const pushed = await this.options.gitPort.push({
      repositoryId: this.openRepositoryId,
      expectedHead: head.value.headRevision
    });
    return { ok: pushed.ok, reason: pushed.ok ? null : (pushed.error?.message ?? "push failed") };
  }

  async fetchRemote(): Promise<boolean> {
    if (this.openRepositoryId === null) {
      return false;
    }
    const fetched = await this.options.gitPort.fetch(this.openRepositoryId);
    return fetched.ok;
  }

  async fastForward(): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
    if (this.openRepositoryId === null) {
      return { ok: false, reason: "no repository open" };
    }
    const expected = await this.options.gitPort.currentExpectedRevisions(this.openRepositoryId);
    if (!expected.ok || expected.value === null) {
      return { ok: false, reason: "stale" };
    }
    const ff = await this.options.gitPort.fastForwardOnly({
      repositoryId: this.openRepositoryId,
      expected: expected.value
    });
    return { ok: ff.ok, reason: ff.ok ? null : (ff.error?.message ?? "fast-forward failed") };
  }

  async logPage(cursor: string | null, pageSize: number) {
    if (this.openRepositoryId === null) {
      return { commits: [], nextCursor: null };
    }
    const page = await this.options.gitPort.log(this.openRepositoryId, cursor, pageSize);
    if (!page.ok || page.value === null) {
      return { commits: [], nextCursor: null };
    }
    return page.value;
  }

  // -------------------------------------------------------------------------
  // Library edit/delete (INH-1853): working-tree writes only
  // -------------------------------------------------------------------------

  async editRepoFile(logicalPath: string, content: Uint8Array): Promise<boolean> {
    if (this.openRepositoryId === null) {
      return false;
    }
    const status = await this.options.gitPort.status(this.openRepositoryId);
    if (!status.ok || status.value === null) {
      return false;
    }
    const plan = planRepoEdit({
      target: {
        logicalPaths: [logicalPath],
        repositoryId: this.openRepositoryId,
        baseRevision: status.value.headRevision ?? "",
        ownershipDigests: {}
      },
      writes: [{ logicalPath, content }],
      currentRevision: status.value.headRevision ?? "",
      currentDigests: {},
      affectedAssetKeys: [],
      deleteConfirmed: false
    });
    if (!plan.ok) {
      return false;
    }
    const { mkdir, writeFile } = await import("node:fs/promises");
    for (const write of plan.preview.writes) {
      if (write.content !== null) {
        const absolute = this.safeRepoPath(write.logicalPath);
        // New repository files (e.g. promoting a target-only asset) need their
        // parent directories; containment is already enforced by safeRepoPath.
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, write.content);
      }
    }
    return true;
  }

  async deleteRepoAsset(logicalPaths: readonly string[], confirmed: boolean): Promise<boolean> {
    if (this.openRepositoryId === null) {
      return false;
    }
    const status = await this.options.gitPort.status(this.openRepositoryId);
    if (!status.ok || status.value === null) {
      return false;
    }
    const ownershipDigests: Record<string, string> = {};
    const currentDigests: Record<string, string> = {};
    for (const logicalPath of logicalPaths) {
      const pathStatus = status.value.paths.find((candidate) => candidate.logicalPath === logicalPath);
      ownershipDigests[logicalPath] = pathStatus?.headDigest ?? "";
      currentDigests[logicalPath] = pathStatus?.worktreeDigest ?? "";
    }
    const plan = planRepoEdit({
      target: {
        logicalPaths,
        repositoryId: this.openRepositoryId,
        baseRevision: status.value.headRevision ?? "",
        ownershipDigests
      },
      writes: logicalPaths.map((logicalPath) => ({ logicalPath, content: null })),
      currentRevision: status.value.headRevision ?? "",
      currentDigests,
      affectedAssetKeys: logicalPaths,
      deleteConfirmed: confirmed
    });
    if (!plan.ok) {
      return false;
    }
    const { rm } = await import("node:fs/promises");
    for (const write of plan.preview.writes) {
      if (write.content === null) {
        await rm(this.safeRepoPath(write.logicalPath), { force: true });
      }
    }
    return true;
  }

  private safeRepoPath(logicalPath: string): string {
    if (
      logicalPath.length === 0 ||
      logicalPath.includes("\0") ||
      logicalPath.includes("\\") ||
      logicalPath.startsWith("/") ||
      /^[A-Za-z]:/.test(logicalPath) ||
      logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new Error(`refusing unsafe repo-relative path: ${JSON.stringify(logicalPath)}`);
    }
    const root = this.options.gitPort.currentRoot();
    const resolved = path.resolve(root, logicalPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`repo path escapes root`);
    }
    return resolved;
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Apply preview + apply (INH-1852 / INH-1814)
  // -------------------------------------------------------------------------
  //
  // Contract notes:
  // - Planning is shared. `previewApply` returns the plan without writing;
  //   `applyToHarnesses` executes the same planning function. A preview
  //   revision can be echoed back on apply so a stale plan is rejected
  //   instead of executed against changed bytes.
  // - Bytes always come from the repository; the Renderer never supplies
  //   asset content (an empty content field means "load from repo").
  // - Asset kind is taken from each asset, never hardcoded: one plan entry per
  //   (harness target x asset kind).
  // - Ownership comes from the SyncBaseline store. An existing target with no
  //   baseline is `needs-adoption` and is only written when the caller
  //   explicitly sets `confirmAdoption`.
  // - Targets resolve from the harness registry and the frozen capability
  //   matrix. An unregistered harness is a hard error (never auto-configured);
  //   an unbound project is a blocked entry, not a fake success.

  async previewApply(input: ApplyInput): Promise<ApplyPreview> {
    const planned = await this.planApply(input);
    const entries: ApplyPreviewEntry[] = planned.planEntries.map((entry) => {
      const meta = planned.entryMeta.get(entry.targetKey);
      return {
        targetKey: entry.targetKey,
        harnessInstanceId: meta?.target.harnessInstanceId ?? "",
        adapterId: meta?.target.adapterId ?? "",
        displayName: meta?.target.displayName ?? "",
        scopeKind: meta?.target.scopeKind ?? "global",
        projectId: meta?.target.projectId ?? null,
        assetKind: entry.assetKind,
        mode: entry.effectiveMode,
        action: entry.action,
        blockedReason: entry.blockedReason,
        requiresConfirmation: entry.requiresExplicitConfirmation
      };
    });
    return {
      planRevision: planned.planRevision,
      entries,
      applyCount: entries.filter((entry) => entry.action === "apply").length,
      unchangedCount: entries.filter((entry) => entry.action === "noop").length,
      blockedCount: entries.filter((entry) => entry.action === "blocked").length,
      needsAdoptionCount: entries.filter((entry) => entry.action === "needs-adoption").length
    };
  }

  /**
   * Line-level diff material for ONE planned target (INH-1814). Read-only:
   * the target bytes are read fresh from disk and nothing is written. Both
   * sides are decoded here because only Main may touch the harness
   * filesystem — the Renderer receives text, never a path.
   */
  async diffApplyTarget(
    input: ApplyInput & { readonly targetKey: string; readonly planRevision?: string }
  ): Promise<ApplyDiffReadModel> {
    const planned = await this.planApply(input);
    if (input.planRevision !== undefined && input.planRevision !== planned.planRevision) {
      throw new Error(
        "plan is stale: the repository, targets or adoption consent changed since the preview; re-run preview before reviewing the diff"
      );
    }
    const meta = planned.entryMeta.get(input.targetKey);
    if (meta === undefined) {
      return {
        targetKey: input.targetKey,
        planRevision: planned.planRevision,
        displayName: "",
        assetKind: "",
        mode: input.mode,
        action: "unknown",
        files: [],
        reason: `预览计划中已无此目标，请重新预览后再查看差异`
      };
    }
    const planEntry = planned.planEntries.find((entry) => entry.targetKey === input.targetKey);
    const action = planEntry?.action ?? "blocked";
    const executable = planned.executable.find((candidate) => candidate.targetKey === input.targetKey);
    if (executable === undefined || meta.target.scopeRoot === null) {
      return {
        targetKey: input.targetKey,
        planRevision: planned.planRevision,
        displayName: meta.target.displayName,
        assetKind: meta.kind,
        mode: meta.target.mode,
        action,
        files: [],
        reason: meta.target.blockedReason ?? "目标当前不可写，无法读取其现有内容"
      };
    }

    const files: ApplyFileDiff[] = [];
    for (const asset of executable.kindAssets) {
      const source = decodeTextBytes(asset.content);
      let targetText: string | null = null;
      let targetExists = false;
      let binary = source.binary;
      if (isSafeRelativePath(asset.logicalName)) {
        try {
          const current = new Uint8Array(
            await readFile(path.join(meta.target.scopeRoot, asset.logicalName))
          );
          const decoded = decodeTextBytes(current);
          targetExists = true;
          binary = binary || decoded.binary;
          targetText = decoded.text;
        } catch {
          targetExists = false;
        }
      }
      files.push({
        logicalName: asset.logicalName,
        sourceText: source.text,
        targetText,
        targetExists,
        binary,
        identical: !binary && source.text === targetText
      });
    }

    return {
      targetKey: input.targetKey,
      planRevision: planned.planRevision,
      displayName: meta.target.displayName,
      assetKind: meta.kind,
      mode: executable.mode,
      action,
      files,
      reason: null
    };
  }

  async applyToHarnesses(input: ApplyInput & { readonly planRevision?: string }): Promise<ApplyOutcome> {
    const planned = await this.planApply(input);
    if (input.planRevision !== undefined && input.planRevision !== planned.planRevision) {
      throw new Error(
        "plan is stale: the repository, targets or adoption consent changed since the preview; re-run preview before applying"
      );
    }
    const confirmAdoption = input.confirmAdoption === true;

    const journal: BatchJournal = {
      batchId: `batch-${Date.now()}`,
      planId: planned.planRevision,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "RUNNING",
      entries: planned.planEntries.map((entry) => {
        const adoptionPending = entry.action === "needs-adoption" && !confirmAdoption;
        const runnable =
          entry.action === "apply" ||
          (entry.action === "needs-adoption" && confirmAdoption);
        return {
          targetKey: entry.targetKey,
          mode: entry.effectiveMode,
          planRevision: entry.planRevision,
          state: runnable ? ("PENDING" as const) : ("SKIPPED_BLOCKED" as const),
          snapshotRef: null,
          verifyDigest: null,
          failureDetail: adoptionPending
            ? "target exists without a RuleSwitch baseline; adoption must be confirmed"
            : entry.action === "noop"
              ? "already in sync with the repository; no write needed"
              : entry.blockedReason,
          rollbackOf: false
        };
      })
    };

    // Crash-safety rule: the journal is persisted before any byte is touched
    // and after every phase transition, so a killed process leaves a record
    // that explains itself (see `reconcileInterruptedBatches`).
    await this.options.operationsStore.saveBatchJournal(journal);
    this.options.crashHook?.("journal-started");

    const headRevision = await this.headRevision();

    for (const entry of journal.entries) {
      if (entry.state !== "PENDING") {
        continue;
      }
      const work = planned.executable.find((candidate) => candidate.targetKey === entry.targetKey);
      if (work === undefined || work.target.scopeRoot === null) {
        entry.state = "APPLY_FAILED";
        entry.failureDetail = "harness root not resolvable";
        continue;
      }

      // 1) Snapshot the pre-apply bytes BEFORE the write: a crash after this
      //    point can always be restored, whether or not the write landed.
      const preApplyFiles = await readExistingTargetFiles(
        work.target.scopeRoot,
        work.kindAssets.map((asset) => asset.logicalName)
      );
      await this.recordSnapshot({
        batchId: journal.batchId,
        targetKey: entry.targetKey,
        targetRoot: work.target.scopeRoot,
        files: preApplyFiles,
        assets: work.kindAssets
      });
      entry.state = "SNAPSHOTTED";
      entry.snapshotRef = `snap-${entry.targetKey}`;
      await this.persistJournal(journal);
      this.options.crashHook?.("snapshot-recorded");

      // 2) Mark the write as started and persist, so an interrupted write is
      //    distinguishable from one that never began.
      entry.state = "APPLYING";
      await this.persistJournal(journal);
      this.options.crashHook?.("write-started");

      const applied = await applyRenderedTargets({
        targetRoot: work.target.scopeRoot,
        targets: work.kindAssets.map((asset) => ({
          targetLogicalPath: asset.logicalName,
          content: asset.content
        })),
        firstAdoptionConfirmed: confirmAdoption,
        baselineDigests: work.baselines
      });
      this.options.crashHook?.("write-finished");

      if (applied.ok) {
        entry.state = "COMMITTED";
        entry.verifyDigest = work.kindAssets.map((asset) => digestBytes(asset.content)).join(",");
        await this.advanceBaselines({
          target: work.target,
          assets: work.kindAssets,
          repositoryRevision: headRevision,
          batchId: journal.batchId
        });
        await this.persistJournal(journal);
        this.options.crashHook?.("target-committed");
      } else {
        // Distinguish preflight refusals from write/verify failures so the
        // recovery surface can tell the operator what actually happened.
        entry.state =
          applied.code === "FIRST_ADOPTION_CONFIRMATION_REQUIRED" ||
          applied.code === "UNMANAGED_TARGET_CHANGED"
            ? "PREFLIGHT_FAILED"
            : applied.code === "VERIFY_FAILED"
              ? "VERIFY_FAILED"
              : "APPLY_FAILED";
        entry.failureDetail = applied.message;
        await this.persistJournal(journal);
        // Frozen batch rule: a failing target stops not-yet-started targets.
        break;
      }
    }

    settleBatch(journal, () => new Date().toISOString());
    await this.options.operationsStore.saveBatchJournal(journal);

    const actionByTargetKey = new Map(planned.planEntries.map((entry) => [entry.targetKey, entry.action]));
    const outcomes: ApplyOutcomeEntry[] = journal.entries.map((entry) => {
      const meta = planned.entryMeta.get(entry.targetKey);
      return {
        targetKey: entry.targetKey,
        harnessInstanceId: meta?.target.harnessInstanceId ?? "",
        adapterId: meta?.target.adapterId ?? "",
        displayName: meta?.target.displayName ?? "",
        scopeKind: meta?.target.scopeKind ?? "global",
        projectId: meta?.target.projectId ?? null,
        assetKind: meta?.kind ?? "instructions",
        mode: entry.mode,
        action: actionByTargetKey.get(entry.targetKey) ?? "blocked",
        state: entry.state,
        detail: entry.failureDetail
      };
    });

    return {
      batchId: journal.batchId,
      status: journal.status,
      appliedCount: outcomes.filter((entry) => entry.state === "COMMITTED").length,
      unchangedCount: outcomes.filter((entry) => entry.action === "noop").length,
      blockedCount: outcomes.filter(
        (entry) => entry.state === "SKIPPED_BLOCKED" && entry.action !== "noop"
      ).length,
      failedCount: outcomes.filter(
        (entry) =>
          entry.state === "APPLY_FAILED" ||
          entry.state === "PREFLIGHT_FAILED" ||
          entry.state === "VERIFY_FAILED" ||
          entry.state === "ROLLBACK_FAILED"
      ).length,
      entries: outcomes
    };
  }

  /**
   * The single planning pass behind both preview and apply. Performs no
   * writes and records no journal — safe to call from a read-only preview.
   */
  private async planApply(input: ApplyInput): Promise<PlannedApply> {
    if (input.assets.length === 0) {
      throw new Error("no assets selected");
    }
    const confirmAdoption = input.confirmAdoption === true;
    const assets = await this.resolveApplyAssetBytes(input.assets);

    const assetsByKind = new Map<AssetKind, (typeof assets)[number][]>();
    for (const asset of assets) {
      const bucket = assetsByKind.get(asset.kind);
      if (bucket === undefined) {
        assetsByKind.set(asset.kind, [asset]);
      } else {
        bucket.push(asset);
      }
    }

    const targets = await this.resolveApplyTargets(input.targets);
    if (targets.length === 0) {
      throw new Error("no harness target selected");
    }

    const planRevision = this.options.hasher.sha256Hex(
      [
        ...assets.map((asset) => `${asset.assetKey}:${digestBytes(asset.content)}`),
        input.mode,
        ...targets.map(
          (target) =>
            `${target.harnessInstanceId}|${target.scopeKind}|${target.projectId ?? ""}|${target.mode}|${target.blockedReason ?? ""}`
        ),
        confirmAdoption ? "adopt" : "no-adopt"
      ].join("\n")
    );

    const executable: {
      target: ResolvedApplyTarget;
      kind: AssetKind;
      kindAssets: readonly { readonly logicalName: string; readonly content: Uint8Array }[];
      targetKey: string;
      mode: ApplyModeName;
      baselines: Readonly<Record<string, string>>;
    }[] = [];
    const planInputs: ApplyTargetInput[] = [];
    const entryMeta = new Map<string, { readonly target: ResolvedApplyTarget; readonly kind: AssetKind }>();

    for (const target of targets) {
      for (const [kind, kindAssets] of assetsByKind) {
        const targetKey = applyEntryKey(target, kind);
        entryMeta.set(targetKey, { target, kind });
        if (target.blockedReason !== null || target.scopeRoot === null) {
          continue;
        }
        const kindRow = matrixKindsFor(target.adapterId).find((row) => row.kind === kind);
        const capability =
          kindRow === undefined
            ? ("unsupported" as const)
            : target.scopeKind === "global"
              ? kindRow.global
              : kindRow.project;
        const baselines = this.baselinesFor(target);
        const hasOwnership =
          kindAssets.length > 0 &&
          kindAssets.every((asset) => baselines[asset.logicalName] !== undefined);
        planInputs.push({
          targetKey,
          harnessInstanceId: target.harnessInstanceId as HarnessInstanceId,
          scope: target.scope,
          assetKind: kind,
          requestedMode: target.mode,
          localDigest: await digestExistingTargets(target, kindAssets),
          sourceDigest: digestSourceTargets(kindAssets),
          hasOwnership,
          capability,
          runtimeReady: target.runtimeReady,
          secretReady: true
        });
        executable.push({ target, kind, kindAssets, targetKey, mode: target.mode, baselines });
      }
    }

    const planEntries: ApplyPlanEntry[] = [];
    if (planInputs.length > 0) {
      const plan = buildApplyPlan(planInputs, false, planRevision);
      if (!plan.ok) {
        throw new Error(plan.message);
      }
      planEntries.push(...plan.entries);
    }

    // Targets that could not even be resolved still appear in the plan with
    // their exact reason, so the UI never shows a silent no-op.
    for (const [targetKey, meta] of entryMeta) {
      if (planEntries.some((entry) => entry.targetKey === targetKey)) {
        continue;
      }
      planEntries.push({
        targetKey,
        harnessInstanceId: meta.target.harnessInstanceId as HarnessInstanceId,
        scope: meta.target.scope,
        assetKind: meta.kind,
        effectiveMode: meta.target.mode,
        action: "blocked",
        blockedReason: meta.target.blockedReason ?? "target could not be resolved",
        requiresExplicitConfirmation: false,
        localDigest: null,
        planRevision
      });
    }
    planEntries.sort((left, right) => (left.targetKey < right.targetKey ? -1 : 1));

    return { planRevision, planEntries, entryMeta, executable, assets, targets };
  }

  /**
   * Whether every file in a snapshot still holds exactly the bytes apply
   * wrote. A file that is absent and never existed counts as restorable:
   * nothing was written, so the pre-apply state is already in place.
   */
  private async snapshotRestorable(manifest: BatchSnapshotManifest): Promise<boolean> {
    for (const target of manifest.targets) {
      for (const file of target.files) {
        if (!isSafeRelativePath(file.relativePath)) {
          return false;
        }
        let digest: string | null = null;
        try {
          digest = digestBytes(new Uint8Array(await readFile(path.join(target.targetRoot, file.relativePath))));
        } catch {
          digest = null;
        }
        if (digest === file.appliedDigest) {
          continue;
        }
        if (digest === null && !file.existedBefore) {
          continue;
        }
        return false;
      }
    }
    return true;
  }

  /** Journal write used between phases so a kill never loses the state. */
  private async persistJournal(journal: BatchJournal): Promise<void> {
    journal.updatedAt = new Date().toISOString();
    await this.options.operationsStore.saveBatchJournal(journal);
  }

  /**
   * Crash reconciliation (INH-1789). A batch left RUNNING on disk means the
   * process died mid-apply. For every target that was mid-flight this reads
   * the real bytes and decides from them:
   * - bytes == what we meant to write  → the write landed, verify it;
   * - bytes == what was there before   → nothing was written;
   * - anything else                     → unknown, operator must verify.
   * No guessing: an unknown outcome stays RECOVERY_REQUIRED.
   */
  async reconcileInterruptedBatches(): Promise<readonly string[]> {
    const snapshotStore = this.options.snapshotStore;
    const reconciled: string[] = [];
    for (const journal of this.options.operationsStore.listUnsettledBatches()) {
      if (journal.status !== "RUNNING") {
        continue;
      }
      const snapshot = snapshotStore === undefined ? null : await snapshotStore.load(journal.batchId);
      let unknown = false;
      for (const entry of journal.entries) {
        if (entry.state !== "SNAPSHOTTED" && entry.state !== "APPLYING") {
          continue;
        }
        const files = snapshot?.targets.find((target) => target.targetKey === entry.targetKey)?.files;
        if (files === undefined) {
          // No snapshot survived: the write outcome cannot be proven.
          entry.state = "APPLY_FAILED";
          entry.failureDetail = "进程在写入过程中被中断，且没有可用的 apply 前快照，无法自证结果";
          unknown = true;
          continue;
        }
        let allApplied = true;
        let allPrevious = true;
        for (const file of files) {
          if (!isSafeRelativePath(file.relativePath)) {
            allApplied = false;
            allPrevious = false;
            continue;
          }
          const root = snapshot?.targets.find((target) => target.targetKey === entry.targetKey)?.targetRoot;
          if (root === undefined) {
            allApplied = false;
            allPrevious = false;
            continue;
          }
          let digest: string | null = null;
          try {
            digest = digestBytes(new Uint8Array(await readFile(path.join(root, file.relativePath))));
          } catch {
            digest = null;
          }
          if (digest !== file.appliedDigest) {
            allApplied = false;
          }
          if (file.existedBefore ? digest !== file.previousDigest : digest !== null) {
            allPrevious = false;
          }
        }
        if (allApplied) {
          entry.state = "COMMITTED";
          entry.verifyDigest = files.map((file) => file.appliedDigest).join(",");
          entry.failureDetail = null;
        } else if (allPrevious) {
          entry.state = "PENDING";
          entry.failureDetail = "进程在写入前被中断，本目标未写入";
        } else {
          entry.state = "APPLY_FAILED";
          entry.failureDetail = "进程在写入过程中被中断，目标内容与预期不一致，需人工核对";
          unknown = true;
        }
      }
      for (const entry of journal.entries) {
        if (entry.state === "PENDING" && entry.failureDetail === null) {
          entry.failureDetail = "进程在批次执行中被中断，本目标未开始写入";
        }
      }
      if (unknown) {
        journal.status = "RECOVERY_REQUIRED";
      } else {
        settleBatch(journal, () => new Date().toISOString());
      }
      journal.updatedAt = new Date().toISOString();
      await this.options.operationsStore.saveBatchJournal(journal);
      reconciled.push(journal.batchId);
    }
    return reconciled;
  }

  /**
   * Persists the pre-apply bytes for one target. Saved per target (not once
   * per batch) so a crash mid-batch still leaves earlier targets restorable.
   */
  private async recordSnapshot(input: {
    readonly batchId: string;
    readonly targetKey: string;
    readonly targetRoot: string;
    readonly files: readonly {
      readonly relativePath: string;
      readonly existedBefore: boolean;
      readonly previousContent: Uint8Array | null;
    }[];
    readonly assets: readonly { readonly logicalName: string; readonly content: Uint8Array }[];
  }): Promise<void> {
    const store = this.options.snapshotStore;
    if (store === undefined) {
      return;
    }
    const appliedByPath = new Map(input.assets.map((asset) => [asset.logicalName, asset.content]));
    await store.save({
      batchId: input.batchId,
      targetKey: input.targetKey,
      targetRoot: input.targetRoot,
      files: input.files.map((file) => ({
        relativePath: file.relativePath,
        existedBefore: file.existedBefore,
        previousContent: file.previousContent,
        appliedContent: appliedByPath.get(file.relativePath) ?? new Uint8Array()
      }))
    });
  }

  /**
   * Restores the pre-apply bytes of one finished batch.
   *
   * Refuses when:
   * - the batch is unknown, still running, or already rolled back;
   * - no snapshot was recorded (batches created before this store existed);
   * - a target changed after apply — that file is reported as failed instead
   *   of being clobbered, and the batch moves to RECOVERY_REQUIRED.
   */
  async rollbackBatch(batchId: string): Promise<RollbackOutcome> {
    const store = this.options.snapshotStore;
    if (store === undefined) {
      return {
        ok: false,
        reason: "snapshot store is not configured",
        restored: 0,
        failed: 0,
        status: "UNKNOWN"
      };
    }
    const journal = this.options.operationsStore.findBatchJournal(batchId);
    if (journal === null) {
      return { ok: false, reason: "unknown batch", restored: 0, failed: 0, status: "UNKNOWN" };
    }
    if (journal.status === "RUNNING") {
      return {
        ok: false,
        reason: "batch is still running; wait for it to settle before rolling back",
        restored: 0,
        failed: 0,
        status: journal.status
      };
    }
    if (journal.status === "ROLLED_BACK") {
      return {
        ok: false,
        reason: "batch is already rolled back",
        restored: 0,
        failed: 0,
        status: journal.status
      };
    }
    const manifest = await store.load(batchId);
    if (manifest === null) {
      return {
        ok: false,
        reason: "no snapshot was recorded for this batch, so it cannot be restored",
        restored: 0,
        failed: 0,
        status: journal.status
      };
    }

    let restored = 0;
    let failed = 0;
    for (const target of manifest.targets) {
      for (const file of target.files) {
        if (!isSafeRelativePath(file.relativePath)) {
          failed += 1;
          continue;
        }
        const absolute = path.join(target.targetRoot, file.relativePath);
        let current: Uint8Array | null = null;
        try {
          current = new Uint8Array(await readFile(absolute));
        } catch {
          current = null;
        }
        const currentDigest = current === null ? null : digestBytes(current);
        if (current === null && !file.existedBefore) {
          // The write never landed (crash before apply): the target is
          // already in its pre-apply state, so this counts as restored
          // instead of a divergence failure.
          restored += 1;
          continue;
        }
        if (currentDigest !== file.appliedDigest) {
          // Diverged since apply: never clobber a later edit.
          failed += 1;
          continue;
        }
        if (file.existedBefore) {
          const blob = await store.readBlob(batchId, file.blobFile);
          if (blob === null) {
            failed += 1;
            continue;
          }
          await mkdir(path.dirname(absolute), { recursive: true });
          const temporaryPath = `${absolute}.ruleswitch-restore-${process.pid}-${Date.now()}`;
          await writeFile(temporaryPath, blob);
          await rename(temporaryPath, absolute);
          const verified = new Uint8Array(await readFile(absolute));
          if (digestBytes(verified) === file.previousDigest) {
            restored += 1;
          } else {
            failed += 1;
          }
        } else {
          await rm(absolute, { force: true });
          restored += 1;
        }
      }
    }

    const status = failed === 0 ? "ROLLED_BACK" : "RECOVERY_REQUIRED";
    const updated = await this.options.operationsStore.updateBatchJournal(batchId, (current) => {
      current.status = status;
      current.updatedAt = new Date().toISOString();
      for (const entry of current.entries) {
        if (entry.state === "COMMITTED") {
          entry.state = failed === 0 ? "ROLLED_BACK" : "ROLLBACK_FAILED";
          entry.failureDetail =
            failed === 0 ? null : "rollback could not verify every file; inspect before continuing";
        }
      }
    });

    if (failed === 0) {
      await store.remove(batchId);
    }

    return {
      ok: failed === 0,
      reason:
        failed === 0
          ? null
          : `${failed} file(s) were not restored (changed after apply or missing snapshot bytes)`,
      restored,
      failed,
      status: updated?.status ?? status
    };
  }

  /** Current HEAD revision of the open repository (empty string when unknown). */
  private async headRevision(): Promise<string> {
    if (this.openRepositoryId === null) {
      return "";
    }
    const status = await this.options.gitPort.status(this.openRepositoryId);
    return status.ok && status.value !== null ? status.value.headRevision ?? "" : "";
  }

  /** Baseline digests owned by this repository + harness instance for a target. */
  private baselinesFor(target: ResolvedApplyTarget): Readonly<Record<string, string>> {
    if (this.options.baselineStore === undefined || this.openRepositoryId === null) {
      return {};
    }
    return this.options.baselineStore.digestsFor(this.openRepositoryId, target.harnessInstanceId);
  }

  /**
   * Advances the SyncBaseline after a verified commit. This is the only place
   * apply writes ownership; a failed target never reaches here.
   */
  private async advanceBaselines(input: {
    readonly target: ResolvedApplyTarget;
    readonly assets: readonly { readonly logicalName: string; readonly content: Uint8Array }[];
    readonly repositoryRevision: string;
    readonly batchId: string;
  }): Promise<void> {
    const store = this.options.baselineStore;
    if (store === undefined || this.openRepositoryId === null) {
      return;
    }
    const recordedAt = new Date().toISOString();
    for (const asset of input.assets) {
      const digest = digestBytes(asset.content);
      await store.advance({
        verified: true,
        operationComplete: true,
        record: {
          repositoryId: this.openRepositoryId as SyncBaselineRecord["repositoryId"],
          harnessInstanceId: input.target
            .harnessInstanceId as SyncBaselineRecord["harnessInstanceId"],
          targetLogicalPath: asset.logicalName,
          bindingMode: "mirror",
          repositoryRevision: input.repositoryRevision,
          sourceAssetKey: asset.logicalName,
          sourceRevision: digest,
          converterId: "passthrough",
          converterVersion: "1",
          managedKeys: null,
          outputDigest: digest,
          outputByteLength: asset.content.byteLength,
          conversionGrade: "lossless",
          lastOperationId: input.batchId,
          recordedAt
        }
      });
    }
  }

  /** Repository is the single source of asset bytes. */
  private async resolveApplyAssetBytes(
    requested: readonly {
      readonly assetKey: string;
      readonly kind: AssetKind;
      readonly logicalName: string;
      readonly content: Uint8Array;
    }[]
  ): Promise<
    {
      readonly assetKey: string;
      readonly kind: AssetKind;
      readonly logicalName: string;
      readonly content: Uint8Array;
    }[]
  > {
    const { createFsRepoFileSource } = await import("../infrastructure/git/repo-source");
    const inventoryResult = await loadRepoInventory(
      createFsRepoFileSource(this.options.gitPort.currentRoot()),
      this.options.hasher
    );
    if (!inventoryResult.ok) {
      throw new Error("repository inventory unavailable");
    }
    return requested.map((asset) => {
      if (asset.content.byteLength > 0) {
        return asset;
      }
      const source = inventoryResult.inventory.assets.find(
        (candidate) => candidate.logicalName === asset.logicalName && candidate.kind === asset.kind
      );
      if (source === undefined) {
        throw new Error(`asset not found in repository: ${asset.logicalName}`);
      }
      return { ...asset, content: source.content };
    });
  }

  /**
   * Resolves the requested target list against the harness registry and the
   * frozen capability matrix. Omitting `targets` preserves the legacy
   * behaviour (every installed registered harness, global scope).
   */
  private async resolveApplyTargets(
    requested: readonly ApplyTargetSelection[] | undefined
  ): Promise<ResolvedApplyTarget[]> {
    const registrations = this.options.harnessRegistry?.listRegistrations() ?? [];
    const byId = new Map(registrations.map((registration) => [registration.harnessInstanceId, registration]));
    const home = process.env.HOME ?? "";

    const selections: ApplyTargetSelection[] =
      requested !== undefined
        ? [...requested]
        : registrations
            .filter((registration) => registration.installed)
            .map((registration) => ({ harnessInstanceId: registration.harnessInstanceId }));

    const resolved: ResolvedApplyTarget[] = [];
    for (const selection of selections) {
      const registration = byId.get(selection.harnessInstanceId);
      if (registration === undefined) {
        // No silent auto-configuration of an unregistered tool.
        throw new Error(`harness is not registered: ${selection.harnessInstanceId}`);
      }
      const scope = selection.scope ?? { kind: "global" as const };
      const mode = selection.mode ?? "overwrite";
      const matrixRow = matrixRowFor(registration.adapterId);
      const base = {
        harnessInstanceId: registration.harnessInstanceId,
        adapterId: registration.adapterId,
        displayName: registration.displayName,
        mode,
        runtimeReady: registration.installed
      };

      if (!registration.installed) {
        resolved.push({
          ...base,
          scopeKind: scope.kind,
          projectId: scope.kind === "project" ? scope.projectId : null,
          scope,
          scopeRoot: null,
          blockedReason: "harness is not installed on this device"
        });
        continue;
      }
      if (matrixRow === null) {
        resolved.push({
          ...base,
          scopeKind: scope.kind,
          projectId: scope.kind === "project" ? scope.projectId : null,
          scope,
          scopeRoot: null,
          blockedReason: `no path capability evidence for adapter '${registration.adapterId}'`
        });
        continue;
      }

      if (scope.kind === "global") {
        resolved.push({
          ...base,
          scopeKind: "global",
          projectId: null,
          scope,
          scopeRoot: path.join(home, matrixRow.paths.globalRoot),
          blockedReason: null
        });
        continue;
      }

      const project = this.options.projectsStore.findProject(scope.projectId);
      if (project === null) {
        resolved.push({
          ...base,
          scopeKind: "project",
          projectId: scope.projectId,
          scope,
          scopeRoot: null,
          blockedReason: `project is not bound on this device: ${scope.projectId}`
        });
        continue;
      }
      if (!project.available) {
        resolved.push({
          ...base,
          scopeKind: "project",
          projectId: scope.projectId,
          scope,
          scopeRoot: null,
          blockedReason: `project directory is missing or moved: ${scope.projectId}`
        });
        continue;
      }
      resolved.push({
        ...base,
        scopeKind: "project",
        projectId: scope.projectId,
        scope,
        scopeRoot: path.join(project.localPath, matrixRow.paths.projectRoot),
        blockedReason: null
      });
    }
    return resolved;
  }
}

interface ResolvedApplyTarget {
  readonly harnessInstanceId: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly mode: ApplyModeName;
  readonly runtimeReady: boolean;
  readonly scopeKind: "global" | "project";
  readonly projectId: string | null;
  readonly scope: ApplyTargetInput["scope"];
  readonly scopeRoot: string | null;
  readonly blockedReason: string | null;
}

function applyEntryKey(target: ResolvedApplyTarget, kind: AssetKind): string {
  const scopeKey = target.scopeKind === "global" ? "global" : `project:${target.projectId ?? ""}`;
  return `${target.harnessInstanceId}|${scopeKey}|${kind}`;
}

/**
 * Reads the current bytes of the target files before any write. `null`
 * content means "the file does not exist yet" — the snapshot must be able to
 * restore that absence, not an empty file.
 */
async function readExistingTargetFiles(
  targetRoot: string,
  logicalNames: readonly string[]
): Promise<
  readonly { readonly relativePath: string; readonly existedBefore: boolean; readonly previousContent: Uint8Array | null }[]
> {
  const files: {
    relativePath: string;
    existedBefore: boolean;
    previousContent: Uint8Array | null;
  }[] = [];
  for (const logicalName of logicalNames) {
    if (!isSafeRelativePath(logicalName)) {
      continue;
    }
    try {
      files.push({
        relativePath: logicalName,
        existedBefore: true,
        previousContent: new Uint8Array(await readFile(path.join(targetRoot, logicalName)))
      });
    } catch {
      files.push({ relativePath: logicalName, existedBefore: false, previousContent: null });
    }
  }
  return files;
}

function digestBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * UTF-8 decode with an honest binary verdict: a NUL byte or an invalid
 * sequence is reported instead of silently replaced, so the diff surface
 * never renders a lossy approximation of the bytes it is about to write.
 */
function decodeTextBytes(content: Uint8Array): { readonly text: string | null; readonly binary: boolean } {
  if (content.includes(0)) {
    return { text: null, binary: true };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(content), binary: false };
  } catch {
    return { text: null, binary: true };
  }
}

/**
 * Aggregate digest of the bytes that would be written. Uses the same encoding
 * as `digestExistingTargets` so the two are directly comparable for `noop`.
 */
function digestSourceTargets(
  assets: readonly { readonly logicalName: string; readonly content: Uint8Array }[]
): string {
  const parts = assets
    .map((asset) => `${asset.logicalName}:${digestBytes(asset.content)}`)
    .sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * Aggregate digest of the target's current local state for one asset kind:
 * null when none of the paths exist (a clean create), otherwise a hash over
 * present/absent markers so any local edit changes the digest.
 */
async function digestExistingTargets(
  target: ResolvedApplyTarget,
  assets: readonly { readonly logicalName: string }[]
): Promise<string | null> {
  if (target.scopeRoot === null) {
    return null;
  }
  const parts: string[] = [];
  let anyPresent = false;
  for (const asset of assets) {
    const absolute = path.join(target.scopeRoot, asset.logicalName);
    try {
      const content = new Uint8Array(await readFile(absolute));
      anyPresent = true;
      parts.push(`${asset.logicalName}:${digestBytes(content)}`);
    } catch {
      parts.push(`${asset.logicalName}:-`);
    }
  }
  if (!anyPresent) {
    return null;
  }
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}

/** Main-side apply request: asset bytes are already decoded. */
export interface ApplyInput {
  readonly assets: readonly {
    readonly assetKey: string;
    readonly kind: AssetKind;
    readonly logicalName: string;
    readonly content: Uint8Array;
  }[];
  readonly mode: ApplyModeName;
  readonly confirmAdoption?: boolean;
  readonly targets?: readonly ApplyTargetSelection[];
}

/** Result of the shared planning pass (no writes, no journal). */
interface PlannedApply {
  readonly planRevision: string;
  readonly planEntries: readonly ApplyPlanEntry[];
  readonly entryMeta: Map<string, { readonly target: ResolvedApplyTarget; readonly kind: AssetKind }>;
  readonly executable: readonly {
    readonly target: ResolvedApplyTarget;
    readonly kind: AssetKind;
    readonly kindAssets: readonly { readonly logicalName: string; readonly content: Uint8Array }[];
    readonly targetKey: string;
    readonly mode: ApplyModeName;
    readonly baselines: Readonly<Record<string, string>>;
  }[];
  readonly assets: readonly {
    readonly assetKey: string;
    readonly kind: AssetKind;
    readonly logicalName: string;
    readonly content: Uint8Array;
  }[];
  readonly targets: readonly ResolvedApplyTarget[];
}

/** Bounds for harness scanning: enough to be useful, small enough to stay fast. */
const MAX_HARNESS_FILES = 2000;
const MAX_HARNESS_DEPTH = 6;

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Depth- and count-bounded walk. Symlinks are skipped entirely: following one
 * would let a harness root point the scanner outside itself.
 */
async function walkHarnessRoot(
  root: string,
  maxFiles: number,
  maxDepth: number
): Promise<{ files: { relativePath: string; content: Uint8Array }[]; truncated: boolean }> {
  const files: { relativePath: string; content: Uint8Array }[] = [];
  let truncated = false;

  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    if (truncated || depth > maxDepth) {
      truncated = truncated || depth > maxDepth;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        files.push({ relativePath, content: new Uint8Array(await readFile(path.join(directory, entry.name))) });
      } catch {
        // Unreadable file: report nothing rather than a fabricated entry.
      }
    }
  }

  await visit(root, "", 0);
  return { files, truncated };
}

/**
 * Classifies a harness-relative path into an asset kind using layout
 * conventions that hold across the four adapters. Unknown layouts return
 * null instead of a guess.
 */
function classifyHarnessPath(relativePath: string): AssetKind | null {
  const segments = relativePath.split("/");
  const first = segments[0] ?? "";
  if (first === "skills") {
    return "skills";
  }
  if (first === "prompts" || first === "commands") {
    return "commands";
  }
  if (first === "rules") {
    return "instructions";
  }
  if (first === "agents" || first === "subagents") {
    return "agents";
  }
  if (first === "hooks") {
    return "hooks";
  }
  if (first === "native") {
    return "native";
  }
  if (segments.length === 1 && (first === "AGENTS.md" || first === "CLAUDE.md")) {
    return "instructions";
  }
  if (segments.length === 1 && (first === "config.toml" || first === "settings.json")) {
    return "settings";
  }
  if (segments.length === 1 && first === "mcp.json") {
    return "mcp";
  }
  return null;
}
