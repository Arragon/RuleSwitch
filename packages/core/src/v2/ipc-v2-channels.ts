// v2 typed IPC channel registry (INH-1757 contract, M7 wiring). Each
// channel is purposeful, schema-checked on both sides, and grouped under
// the frozen 8 capability groups. No generic fs/shell/path channels.

import { z } from "zod";

import type {
  GitAreaReadModel,
  HarnessScanReadModel,
  RecoveryReadModel,
  LibraryReadModel,
  OperationHistoryDto,
  OverviewReadModel,
  ProjectDto,
  HarnessDto,
  SetCompareReadModel,
  SettingsReadModel
} from "./read-models";

export const IPC_V2_METHODS = [
  "repository.openFromDirectory",
  "repository.clone",
  "repository.status",
  "repository.validate",
  "library.browse",
  "library.readFile",
  "library.editFile",
  "library.deleteAsset",
  "changes.gitArea",
  "changes.setCompare",
  "changes.stage",
  "changes.unstage",
  "changes.commit",
  "changes.push",
  "changes.fetch",
  "changes.fastForward",
  "changes.log",
  "projects.list",
  "projects.bind",
  "projects.unbind",
  "harnesses.list",
  "harnesses.scan",
  "history.operations",
  "history.recovery",
  "operations.rollback",
  "settings.get",
  "settings.setTheme",
  "apply.preview",
  "apply.diff",
  "apply.toHarnesses"
] as const;
export type IpcV2Method = (typeof IPC_V2_METHODS)[number];

export const IPC_V2_CHANNELS: Record<IpcV2Method, string> = Object.freeze({
  "repository.openFromDirectory": "ruleswitch:v2:repository:open-from-directory",
  "repository.clone": "ruleswitch:v2:repository:clone",
  "repository.status": "ruleswitch:v2:repository:status",
  "repository.validate": "ruleswitch:v2:repository:validate",
  "library.browse": "ruleswitch:v2:assets:library",
  "library.readFile": "ruleswitch:v2:assets:read-file",
  "library.editFile": "ruleswitch:v2:assets:edit-file",
  "library.deleteAsset": "ruleswitch:v2:assets:delete-asset",
  "changes.gitArea": "ruleswitch:v2:changes:git-area",
  "changes.setCompare": "ruleswitch:v2:changes:set-compare",
  "changes.stage": "ruleswitch:v2:changes:stage",
  "changes.unstage": "ruleswitch:v2:changes:unstage",
  "changes.commit": "ruleswitch:v2:changes:commit",
  "changes.push": "ruleswitch:v2:changes:push",
  "changes.fetch": "ruleswitch:v2:changes:fetch",
  "changes.fastForward": "ruleswitch:v2:changes:fast-forward",
  "changes.log": "ruleswitch:v2:changes:log",
  "projects.list": "ruleswitch:v2:projects:list",
  "projects.bind": "ruleswitch:v2:projects:bind",
  "projects.unbind": "ruleswitch:v2:projects:unbind",
  "harnesses.list": "ruleswitch:v2:harnesses:list",
  "harnesses.scan": "ruleswitch:v2:harnesses:scan",
  "history.operations": "ruleswitch:v2:history:operations",
  "history.recovery": "ruleswitch:v2:history:recovery",
  "operations.rollback": "ruleswitch:v2:operations:rollback",
  "settings.get": "ruleswitch:v2:settings:get",
  "settings.setTheme": "ruleswitch:v2:settings:set-theme",
  "apply.preview": "ruleswitch:v2:operations:preview-apply",
  "apply.diff": "ruleswitch:v2:operations:diff-apply",
  "apply.toHarnesses": "ruleswitch:v2:operations:apply-to-harnesses"
});

const emptyRequestSchema = z.strictObject({});
const setThemeRequestSchema = z.strictObject({ theme: z.enum(["light", "dark", "system"]) });

/**
 * Apply mode names accepted at the IPC boundary. Kept in lockstep with the
 * frozen ApplyMode contract in `reconcile.ts`; per-kind admissibility is
 * decided by `resolveApplyMode`, never by the Renderer.
 */
export const APPLY_MODE_NAMES = ["overwrite", "merge-add", "add-only"] as const;
export type ApplyModeName = (typeof APPLY_MODE_NAMES)[number];

export type ApplyScopeSelection =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly projectId: string };

/**
 * One explicitly selected apply target (INH-1852). Omitting `targets` from the
 * request keeps the legacy behaviour: every installed, registered harness at
 * global scope with the request-level default mode. Supplying `targets` makes
 * the selection exhaustive — an unregistered harness is rejected rather than
 * silently configured, and a per-target `mode` overrides the default.
 */
export interface ApplyTargetSelection {
  readonly harnessInstanceId: string;
  readonly mode?: ApplyModeName;
  readonly scope?: ApplyScopeSelection;
}

export interface ApplyAssetInput {
  readonly assetKey: string;
  readonly kind: string;
  readonly logicalName: string;
  readonly contentBase64: string;
}

export interface ApplyOptions {
  /** Explicit first-adoption consent for targets that already exist. */
  readonly confirmAdoption?: boolean;
  readonly targets?: readonly ApplyTargetSelection[];
}

/** Per-target result surfaced to the UI (INH-1814 progress/result surface). */
export interface ApplyOutcomeEntry {
  readonly targetKey: string;
  readonly harnessInstanceId: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly scopeKind: "global" | "project";
  readonly projectId: string | null;
  readonly assetKind: string;
  readonly mode: ApplyModeName;
  /** Plan action chosen before execution (apply / needs-adoption / blocked / ...). */
  readonly action: string;
  /** Journal state after execution (COMMITTED / APPLY_FAILED / SKIPPED_BLOCKED / ...). */
  readonly state: string;
  readonly detail: string | null;
}

export interface ApplyOutcome {
  readonly batchId: string;
  readonly status: string;
  readonly appliedCount: number;
  /** Targets already byte-identical to the repository (no write performed). */
  readonly unchangedCount: number;
  readonly blockedCount: number;
  readonly failedCount: number;
  readonly entries: readonly ApplyOutcomeEntry[];
}

const applyScopeSchema = z.union([
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: z.string().trim().min(1) })
]);

/** One planned apply target, surfaced before any write (INH-1814 preview). */
export interface ApplyPreviewEntry {
  readonly targetKey: string;
  readonly harnessInstanceId: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly scopeKind: "global" | "project";
  readonly projectId: string | null;
  readonly assetKind: string;
  readonly mode: ApplyModeName;
  /** apply | noop | needs-adoption | skip-add-only-exists | blocked */
  readonly action: string;
  readonly blockedReason: string | null;
  readonly requiresConfirmation: boolean;
}

/** Result of restoring a finished batch from its persisted snapshot. */
export interface RollbackOutcome {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly restored: number;
  readonly failed: number;
  readonly status: string;
}

/**
 * Read-only plan. `planRevision` is echoed back on apply; a mismatch means
 * the repository, targets or consent changed since preview and the apply is
 * refused (stale plan guard).
 */
export interface ApplyPreview {
  readonly planRevision: string;
  readonly entries: readonly ApplyPreviewEntry[];
  readonly applyCount: number;
  readonly unchangedCount: number;
  readonly blockedCount: number;
  readonly needsAdoptionCount: number;
}

/**
 * One file-level diff for the Preview surface (INH-1814 line-level review).
 * Both sides are decoded on the Main side because only Main may touch the
 * harness filesystem; the Renderer receives text, never a path. `binary`
 * content is reported, not guessed — the UI then refuses to render it.
 */
export interface ApplyFileDiff {
  /** Repository-relative logical name (opaque). */
  readonly logicalName: string;
  /** Bytes RuleSwitch would write, decoded as UTF-8 (null when binary). */
  readonly sourceText: string | null;
  /** Bytes currently on disk, decoded as UTF-8 (null when absent/binary). */
  readonly targetText: string | null;
  readonly targetExists: boolean;
  readonly binary: boolean;
  readonly identical: boolean;
}

export interface ApplyDiffReadModel {
  readonly targetKey: string;
  readonly planRevision: string;
  readonly displayName: string;
  readonly assetKind: string;
  readonly mode: ApplyModeName;
  readonly action: string;
  readonly files: readonly ApplyFileDiff[];
  /** Set when the target cannot be diffed (blocked target, unknown key). */
  readonly reason: string | null;
}

const applyAssetRequestSchema = z.array(
  z.strictObject({
    assetKey: z.string().min(1),
    kind: z.string().min(1),
    logicalName: z.string().min(1),
    /**
     * Optional payload override. An EMPTY string is meaningful: Main resolves
     * the bytes from the open repository by (logicalName, kind), which is what
     * the library surface does — it never ships file bytes through IPC just to
     * apply what is already in the repo. A non-empty value wins and is used
     * verbatim (draft/ad-hoc content).
     */
    contentBase64: z.string()
  })
).min(1);

const applyTargetRequestSchema = z.array(
  z.strictObject({
    harnessInstanceId: z.string().trim().min(1),
    mode: z.enum(APPLY_MODE_NAMES).optional(),
    scope: applyScopeSchema.optional()
  })
).min(1);

const applyRequestSchema = z.strictObject({
  assets: applyAssetRequestSchema,
  mode: z.enum(APPLY_MODE_NAMES),
  confirmAdoption: z.boolean().optional(),
  targets: applyTargetRequestSchema.optional()
});

/** Per-method request schemas (Renderer→Main). Responses are Main DTOs. */
export const IPC_V2_REQUEST_SCHEMAS: Record<IpcV2Method, z.ZodTypeAny> = Object.freeze({
  "repository.openFromDirectory": z.strictObject({ directory: z.string().trim().min(1) }),
  "repository.clone": z.strictObject({
    remoteUrl: z.string().trim().min(1),
    targetDirectory: z.string().trim().min(1)
  }),
  "repository.status": emptyRequestSchema,
  "repository.validate": emptyRequestSchema,
  "library.browse": emptyRequestSchema,
  "library.readFile": z.strictObject({ logicalPath: z.string().trim().min(1) }),
  "library.editFile": z.strictObject({
    logicalPath: z.string().trim().min(1),
    contentBase64: z.string().min(1)
  }),
  "library.deleteAsset": z.strictObject({
    logicalPaths: z.array(z.string().trim().min(1)).min(1),
    confirmed: z.literal(true)
  }),
  "changes.gitArea": emptyRequestSchema,
  "changes.setCompare": emptyRequestSchema,
  "changes.stage": z.strictObject({ logicalPaths: z.array(z.string().trim().min(1)).min(1) }),
  "changes.unstage": z.strictObject({ logicalPaths: z.array(z.string().trim().min(1)).min(1) }),
  "changes.commit": z.strictObject({ message: z.string().trim().min(1) }),
  "changes.push": emptyRequestSchema,
  "changes.fetch": emptyRequestSchema,
  "changes.fastForward": emptyRequestSchema,
  "changes.log": z.strictObject({
    cursor: z.string().nullable(),
    pageSize: z.number().int().min(1).max(100)
  }),
  "projects.list": emptyRequestSchema,
  "projects.bind": z.strictObject({
    projectId: z.string().trim().min(1),
    displayName: z.string().trim().min(1).max(200),
    localPath: z.string().trim().min(1),
    rebind: z.boolean().optional()
  }),
  "projects.unbind": z.strictObject({ projectId: z.string().trim().min(1) }),
  "harnesses.list": emptyRequestSchema,
  "harnesses.scan": z.strictObject({ harnessInstanceId: z.string().trim().min(1) }),
  "history.operations": emptyRequestSchema,
  "history.recovery": emptyRequestSchema,
  "operations.rollback": z.strictObject({ batchId: z.string().trim().min(1) }),
  "settings.get": emptyRequestSchema,
  "settings.setTheme": setThemeRequestSchema,
  "apply.preview": applyRequestSchema,
  "apply.diff": applyRequestSchema.extend({
    targetKey: z.string().trim().min(1),
    planRevision: z.string().min(1).optional()
  }),
  "apply.toHarnesses": applyRequestSchema.extend({
    planRevision: z.string().min(1).optional()
  })
});

export interface RepositoryCloneOutcome {
  readonly ok: boolean;
  readonly reason: string | null;
  /** Whether the cloned tree actually contains a ruleswitch.yaml at HEAD. */
  readonly manifestPresent: boolean;
}

export interface RepositoryValidationDiagnostic {
  readonly code: string;
  readonly logicalPath: string | null;
  readonly message: string;
}

/** Structured result of a manifest/asset-graph validation pass. */
export interface RepositoryValidation {
  readonly ok: boolean;
  readonly schemaVersion: number | null;
  readonly assetCount: number;
  readonly projectCount: number;
  readonly profileCount: number;
  readonly diagnostics: readonly RepositoryValidationDiagnostic[];
}

export interface ProjectBindRequest {
  readonly projectId: string;
  readonly displayName: string;
  /** Absolute local directory. Accepted only on the Main side. */
  readonly localPath: string;
  /** Required to move an already-bound project to a new directory. */
  readonly rebind?: boolean;
}

/**
 * `remoteVerified` is deliberately tri-state: v1 remote patterns only accept
 * `git://` / `file://` forms, so an https origin cannot be proven and must
 * not be reported as matched.
 */
export interface ProjectBindingOutcome {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly remoteVerified: "matched" | "mismatch" | "unknown";
  readonly diagnostic: string | null;
}

/** The v2 Renderer API surface (exposed via contextBridge as ruleswitchV2). */
export interface DesktopApiV2 {
  openRepositoryFromDirectory(directory: string): Promise<OverviewReadModel | null>;
  /**
   * Clones a config repository and opens it. The target directory must not
   * exist yet; Main refuses instead of merging into an existing tree.
   */
  cloneRepository(remoteUrl: string, targetDirectory: string): Promise<RepositoryCloneOutcome>;
  repositoryStatus(): Promise<OverviewReadModel | null>;
  /**
   * Re-validates the open repository's manifest and asset graph without
   * writing. Diagnostics are structured so the UI can show an actionable
   * next step instead of a bare failure.
   */
  validateRepository(): Promise<RepositoryValidation | null>;
  bindProject(request: ProjectBindRequest): Promise<ProjectBindingOutcome>;
  unbindProject(projectId: string): Promise<boolean>;
  browseLibrary(): Promise<LibraryReadModel | null>;
  /**
   * Reads one repository asset for the editor. Request/response use the
   * opaque logical name only; Main resolves it against the fresh inventory,
   * so no filesystem path crosses the boundary.
   */
  readRepoFile(logicalPath: string): Promise<{ readonly logicalPath: string; readonly contentBase64: string } | null>;
  editRepoFile(logicalPath: string, contentBase64: string): Promise<boolean>;
  deleteRepoAsset(logicalPaths: readonly string[], confirmed: true): Promise<boolean>;
  gitArea(): Promise<GitAreaReadModel | null>;
  setCompare(): Promise<SetCompareReadModel | null>;
  stagePaths(logicalPaths: readonly string[]): Promise<boolean>;
  unstagePaths(logicalPaths: readonly string[]): Promise<boolean>;
  commit(message: string): Promise<{ readonly ok: true; readonly revision: string } | { readonly ok: false; readonly reason: string }>;
  push(): Promise<{ readonly ok: boolean; readonly reason: string | null }>;
  fetchRemote(): Promise<boolean>;
  fastForward(): Promise<{ readonly ok: boolean; readonly reason: string | null }>;
  logPage(cursor: string | null, pageSize: number): Promise<{ readonly commits: readonly { revision: string; parents: readonly string[]; authorName: string; authoredAt: string; subject: string }[]; readonly nextCursor: string | null }>;
  listProjects(): Promise<readonly ProjectDto[]>;
  listHarnesses(): Promise<readonly HarnessDto[]>;
  /**
   * Scans one harness root for real files. Returns relative paths only, skips
   * symlinks, and marks a file managed only when a SyncBaseline proves it.
   */
  scanHarness(harnessInstanceId: string): Promise<HarnessScanReadModel | null>;
  operationHistory(): Promise<readonly OperationHistoryDto[]>;
  /** Batches that need operator attention, with honest rollback availability. */
  recoveryStatus(): Promise<RecoveryReadModel>;
  /**
   * Restores the pre-apply bytes of a finished batch. Refuses when a target
   * diverged after apply (the file is reported, not overwritten).
   */
  rollbackBatch(batchId: string): Promise<RollbackOutcome>;
  getSettings(): Promise<SettingsReadModel>;
  setTheme(theme: "light" | "dark" | "system"): Promise<SettingsReadModel>;
  previewApply(
    assets: readonly ApplyAssetInput[],
    mode: ApplyModeName,
    options?: ApplyOptions
  ): Promise<ApplyPreview>;
  /**
   * Text for one planned target: repository bytes vs the bytes currently on
   * disk. Read-only; a stale `planRevision` is refused like `applyToHarnesses`.
   */
  diffApplyTarget(
    assets: readonly ApplyAssetInput[],
    mode: ApplyModeName,
    targetKey: string,
    options?: ApplyOptions & { readonly planRevision?: string }
  ): Promise<ApplyDiffReadModel>;
  applyToHarnesses(
    assets: readonly ApplyAssetInput[],
    mode: ApplyModeName,
    options?: ApplyOptions & { readonly planRevision?: string }
  ): Promise<ApplyOutcome>;
}

/** Frozen mapping: v2 method name → DesktopApiV2 key. */
export const IPC_V2_METHOD_TO_API: Record<IpcV2Method, keyof DesktopApiV2> = Object.freeze({
  "repository.openFromDirectory": "openRepositoryFromDirectory",
  "repository.clone": "cloneRepository",
  "repository.status": "repositoryStatus",
  "repository.validate": "validateRepository",
  "library.browse": "browseLibrary",
  "library.readFile": "readRepoFile",
  "library.editFile": "editRepoFile",
  "library.deleteAsset": "deleteRepoAsset",
  "changes.gitArea": "gitArea",
  "changes.setCompare": "setCompare",
  "changes.stage": "stagePaths",
  "changes.unstage": "unstagePaths",
  "changes.commit": "commit",
  "changes.push": "push",
  "changes.fetch": "fetchRemote",
  "changes.fastForward": "fastForward",
  "changes.log": "logPage",
  "projects.list": "listProjects",
  "projects.bind": "bindProject",
  "projects.unbind": "unbindProject",
  "harnesses.list": "listHarnesses",
  "harnesses.scan": "scanHarness",
  "history.operations": "operationHistory",
  "history.recovery": "recoveryStatus",
  "operations.rollback": "rollbackBatch",
  "settings.get": "getSettings",
  "settings.setTheme": "setTheme",
  "apply.preview": "previewApply",
  "apply.diff": "diffApplyTarget",
  "apply.toHarnesses": "applyToHarnesses"
});

/** Shape guard used by both sides in tests: every method must be registered. */
export function assertV2Surface(api: DesktopApiV2): readonly string[] {
  const problems: string[] = [];
  for (const method of IPC_V2_METHODS) {
    if (typeof api[IPC_V2_METHOD_TO_API[method]] !== "function") {
      problems.push(`missing v2 method: ${method}`);
    }
  }
  return problems;
}
