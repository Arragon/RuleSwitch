// v2 typed IPC channel registry (INH-1757 contract, M7 wiring). Each
// channel is purposeful, schema-checked on both sides, and grouped under
// the frozen 8 capability groups. No generic fs/shell/path channels.

import { z } from "zod";

import type {
  GitAreaReadModel,
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
  "repository.status",
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
  "harnesses.list",
  "history.operations",
  "settings.get",
  "settings.setTheme",
  "apply.toHarnesses"
] as const;
export type IpcV2Method = (typeof IPC_V2_METHODS)[number];

export const IPC_V2_CHANNELS: Record<IpcV2Method, string> = Object.freeze({
  "repository.openFromDirectory": "ruleswitch:v2:repository:open-from-directory",
  "repository.status": "ruleswitch:v2:repository:status",
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
  "harnesses.list": "ruleswitch:v2:harnesses:list",
  "history.operations": "ruleswitch:v2:history:operations",
  "settings.get": "ruleswitch:v2:settings:get",
  "settings.setTheme": "ruleswitch:v2:settings:set-theme",
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
  readonly blockedCount: number;
  readonly failedCount: number;
  readonly entries: readonly ApplyOutcomeEntry[];
}

const applyScopeSchema = z.union([
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: z.string().trim().min(1) })
]);

/** Per-method request schemas (Renderer→Main). Responses are Main DTOs. */
export const IPC_V2_REQUEST_SCHEMAS: Record<IpcV2Method, z.ZodTypeAny> = Object.freeze({
  "repository.openFromDirectory": z.strictObject({ directory: z.string().trim().min(1) }),
  "repository.status": emptyRequestSchema,
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
  "harnesses.list": emptyRequestSchema,
  "history.operations": emptyRequestSchema,
  "settings.get": emptyRequestSchema,
  "settings.setTheme": setThemeRequestSchema,
  "apply.toHarnesses": z.strictObject({
    assets: z
      .array(
        z.strictObject({
          assetKey: z.string().min(1),
          kind: z.string().min(1),
          logicalName: z.string().min(1),
          contentBase64: z.string().min(1)
        })
      )
      .min(1),
    mode: z.enum(APPLY_MODE_NAMES),
    confirmAdoption: z.boolean().optional(),
    targets: z
      .array(
        z.strictObject({
          harnessInstanceId: z.string().trim().min(1),
          mode: z.enum(APPLY_MODE_NAMES).optional(),
          scope: applyScopeSchema.optional()
        })
      )
      .min(1)
      .optional()
  })
});

/** The v2 Renderer API surface (exposed via contextBridge as ruleswitchV2). */
export interface DesktopApiV2 {
  openRepositoryFromDirectory(directory: string): Promise<OverviewReadModel | null>;
  repositoryStatus(): Promise<OverviewReadModel | null>;
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
  operationHistory(): Promise<readonly OperationHistoryDto[]>;
  getSettings(): Promise<SettingsReadModel>;
  setTheme(theme: "light" | "dark" | "system"): Promise<SettingsReadModel>;
  applyToHarnesses(
    assets: readonly ApplyAssetInput[],
    mode: ApplyModeName,
    options?: ApplyOptions
  ): Promise<ApplyOutcome>;
}

/** Frozen mapping: v2 method name → DesktopApiV2 key. */
export const IPC_V2_METHOD_TO_API: Record<IpcV2Method, keyof DesktopApiV2> = Object.freeze({
  "repository.openFromDirectory": "openRepositoryFromDirectory",
  "repository.status": "repositoryStatus",
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
  "harnesses.list": "listHarnesses",
  "history.operations": "operationHistory",
  "settings.get": "getSettings",
  "settings.setTheme": "setTheme",
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
