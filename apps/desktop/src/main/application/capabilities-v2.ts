// v2 capability service (M7): the Main-side application layer that turns
// M1–M6 business capabilities into the frozen v2 read models. This is the
// ONLY code the v2 UI talks to; it never exposes absolute paths and every
// read goes through fresh GitPort/scanner reads.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  GitAreaReadModel,
  HarnessDto,
  LibraryEntryDto,
  LibraryReadModel,
  OperationHistoryDto,
  OverviewReadModel,
  ProjectDto,
  SetCompareReadModel,
  SettingsReadModel
} from "@ruleswitch/core";
import {
  aggregateSkillAssets,
  buildApplyPlan,
  compareCollections,
  loadRepoInventory,
  matrixKindsFor,
  matrixRowFor,
  planRepoEdit,
  resolveAssetSet,
  settleBatch,
  type ApplyModeName,
  type ApplyOutcome,
  type ApplyOutcomeEntry,
  type ApplyPlanEntry,
  type ApplyTargetInput,
  type ApplyTargetSelection,
  type AssetKind,
  type BatchJournal,
  type HarnessInstanceId,
  type RepositoryId,
  type StableIdHasher
} from "@ruleswitch/core";

import type { GitPortAdapter } from "../infrastructure/git/git-port-adapter";
import type { ProjectsStore, SettingsStore } from "../infrastructure/git/binding-store";
import type { OperationsStore } from "../infrastructure/git/sync-state";
import { applyRenderedTargets } from "../infrastructure/harness/skill-slice";

export interface CapabilityV2Options {
  readonly gitPort: GitPortAdapter;
  readonly projectsStore: ProjectsStore;
  readonly settingsStore: SettingsStore;
  readonly operationsStore: OperationsStore;
  readonly harnessRegistry?: {
    listRegistrations(): readonly {
      harnessInstanceId: string;
      adapterId: string;
      displayName: string;
      installed: boolean;
    }[];
  };
  readonly hasher: StableIdHasher;
}

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
    const currentRoot = this.options.gitPort.currentRoot();
    const inventoryResult = await loadRepoInventory(createFsRepoFileSource(currentRoot), this.options.hasher);
    if (!inventoryResult.ok) {
      return null;
    }
    const inventory = inventoryResult.inventory;
    const sourceSkills = aggregateSkillAssets(
      inventory.assets.filter((asset) => asset.kind === "skills"),
      this.options.hasher
    );
    const source = {
      label: "global-skills",
      assets: sourceSkills.flatMap((skill) =>
        skill.files.map((file) => ({
          kind: "skills" as const,
          logicalName: `${skill.skillName}/${file.relativePath}`,
          digest: this.options.hasher.sha256Hex(
            skill.files.find((candidate) => candidate === file) === undefined
              ? ""
              : Buffer.from(file.content).toString("binary")
          )
        }))
      ),
      supportedKinds: new Set(["skills"] as const)
    };
    const codexNative = inventory.assets.filter(
      (asset) => asset.kind === "native" && asset.logicalName.startsWith("codex/skills/")
    );
    const target = {
      label: "codex-collection",
      assets: codexNative.map((asset) => ({
        kind: "skills" as const,
        logicalName: asset.logicalName.slice("codex/skills/".length),
        digest: asset.contentDigest
      })),
      supportedKinds: new Set(["skills" as const])
    };
    const comparison = compareCollections({
      repositoryId: this.openRepositoryId,
      source,
      target,
      baselines: {},
      trustedBaseline: false
    });
    return {
      confidence: comparison.confidence,
      diffs: comparison.diffs.map((diff) => ({
        assetKey: diff.semanticKey,
        kind: diff.kind,
        relation: diff.relation
      }))
    };
  }

  async listProjects(): Promise<readonly ProjectDto[]> {
    const bindings = this.options.projectsStore.current().bindings;
    return Object.values(bindings)
      .map((binding) => ({
        projectId: binding.projectId,
        displayName: binding.displayName,
        localPathPresent: binding.localPath.length > 0,
        available: binding.available
      }))
      .sort((left, right) => (left.projectId < right.projectId ? -1 : 1));
  }

  async listHarnesses(): Promise<readonly HarnessDto[]> {
    // Registered harnesses come from the harness registry store; readiness
    // from the M5 classifier facts (installed/mapping/supported/writable).
    const registrations = this.options.harnessRegistry?.listRegistrations() ?? [];
    return registrations
      .map((registration) => ({
        harnessInstanceId: registration.harnessInstanceId,
        adapterId: registration.adapterId,
        displayName: registration.displayName,
        installed: registration.installed,
        readiness: registration.installed ? "READY" : "not-installed"
      }))
      .sort((left, right) => (left.displayName < right.displayName ? -1 : 1));
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
    const { writeFile } = await import("node:fs/promises");
    for (const write of plan.preview.writes) {
      if (write.content !== null) {
        await writeFile(this.safeRepoPath(write.logicalPath), write.content);
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
  // Apply to harness targets (INH-1852 / INH-1814)
  // -------------------------------------------------------------------------
  //
  // Contract notes:
  // - Bytes always come from the repository; the Renderer never supplies asset
  //   content (an empty content field means "load from repo").
  // - Asset kind is taken from each asset, never hardcoded: one plan entry per
  //   (harness target x asset kind).
  // - An existing target with no RuleSwitch baseline is `needs-adoption`. It is
  //   only written when the caller explicitly sets `confirmAdoption`, so a
  //   first adoption can never silently overwrite a user's local config.
  // - Targets are resolved from the harness registry and the frozen capability
  //   matrix. An unregistered harness is a hard error (never auto-configured);
  //   an unbound project is a blocked entry, not a fake success.

  async applyToHarnesses(input: {
    readonly assets: readonly {
      readonly assetKey: string;
      readonly kind: AssetKind;
      readonly logicalName: string;
      readonly content: Uint8Array;
    }[];
    readonly mode: ApplyModeName;
    readonly confirmAdoption?: boolean;
    readonly targets?: readonly ApplyTargetSelection[];
  }): Promise<ApplyOutcome> {
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
      readonly target: ResolvedApplyTarget;
      readonly kind: AssetKind;
      readonly kindAssets: readonly { readonly logicalName: string; readonly content: Uint8Array }[];
      readonly targetKey: string;
      readonly mode: ApplyModeName;
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
        const capability = kindRow === undefined
          ? ("unsupported" as const)
          : target.scopeKind === "global"
            ? kindRow.global
            : kindRow.project;
        planInputs.push({
          targetKey,
          harnessInstanceId: target.harnessInstanceId as HarnessInstanceId,
          scope: target.scope,
          assetKind: kind,
          requestedMode: target.mode,
          localDigest: await digestExistingTargets(target, kindAssets),
          // No baseline store is consulted here yet (INH-1781 baselines are
          // recorded per project/harness binding), so ownership is reported
          // honestly as unknown and existing files become needs-adoption.
          hasOwnership: false,
          capability,
          runtimeReady: target.runtimeReady,
          secretReady: true
        });
        executable.push({ target, kind, kindAssets, targetKey, mode: target.mode });
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

    // Targets that could not even be resolved still appear in the journal with
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

    const journal: BatchJournal = {
      batchId: `batch-${Date.now()}`,
      planId: planRevision,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "RUNNING",
      entries: planEntries.map((entry) => {
        const adoptionPending =
          entry.action === "needs-adoption" && !confirmAdoption;
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
            : entry.blockedReason,
          rollbackOf: false
        };
      })
    };

    for (const entry of journal.entries) {
      if (entry.state !== "PENDING") {
        continue;
      }
      const work = executable.find((candidate) => candidate.targetKey === entry.targetKey);
      if (work === undefined || work.target.scopeRoot === null) {
        entry.state = "APPLY_FAILED";
        entry.failureDetail = "harness root not resolvable";
        continue;
      }
      entry.state = "APPLYING";
      const applied = await applyRenderedTargets({
        targetRoot: work.target.scopeRoot,
        targets: work.kindAssets.map((asset) => ({
          targetLogicalPath: asset.logicalName,
          content: asset.content
        })),
        firstAdoptionConfirmed: confirmAdoption,
        baselineDigests: {}
      });
      if (applied.ok) {
        entry.state = "COMMITTED";
        entry.snapshotRef = `snap-${entry.targetKey}`;
        entry.verifyDigest = work.kindAssets
          .map((asset) => digestBytes(asset.content))
          .join(",");
      } else {
        entry.state = "APPLY_FAILED";
        entry.failureDetail = applied.message;
        // Frozen batch rule: a failing target stops not-yet-started targets.
        break;
      }
    }

    settleBatch(journal, () => new Date().toISOString());
    await this.options.operationsStore.saveBatchJournal(journal);

    const actionByTargetKey = new Map(planEntries.map((entry) => [entry.targetKey, entry.action]));
    const outcomes: ApplyOutcomeEntry[] = journal.entries.map((entry) => {
      const meta = entryMeta.get(entry.targetKey);
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
      blockedCount: outcomes.filter((entry) => entry.state === "SKIPPED_BLOCKED").length,
      failedCount: outcomes.filter(
        (entry) => entry.state === "APPLY_FAILED" || entry.state === "VERIFY_FAILED"
      ).length,
      entries: outcomes
    };
  }

  /** Repository is the single source of asset bytes. */
  private async resolveApplyAssetBytes(
    requested: readonly {
      readonly assetKey: string;
      readonly kind: AssetKind;
      readonly logicalName: string;
      readonly content: Uint8Array;
    }[]
  ): Promise<{ readonly assetKey: string; readonly kind: AssetKind; readonly logicalName: string; readonly content: Uint8Array }[]> {
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

function digestBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
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
