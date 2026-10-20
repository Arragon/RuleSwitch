// v2 read models (INH-1757 IPC v2 / M7 UI): Main-produced DTOs only.
// Renderer never assembles business truth from JSON fragments. Absolute
// paths never appear here; opaque stable IDs only.

import type { AssetKind } from "./identity";

// ---------------------------------------------------------------------------
// Library (配置库): repo HEAD browsing + working-draft markers
// ---------------------------------------------------------------------------

export interface LibraryEntryDto {
  readonly assetKey: string;
  readonly kind: AssetKind;
  readonly logicalName: string;
  /** "head" = committed; "draft" = working-tree differs from HEAD. */
  readonly state: "head" | "draft";
  readonly digest: string;
  readonly byteLength: number;
  readonly kindGroup: string;
}

export interface LibraryReadModel {
  readonly repositoryId: string;
  readonly headRevision: string | null;
  readonly branch: string | null;
  readonly entries: readonly LibraryEntryDto[];
  readonly draftCount: number;
}

// ---------------------------------------------------------------------------
// Changes (同步变更): Git working area + harness set comparison
// ---------------------------------------------------------------------------

export interface GitChangeDto {
  readonly logicalPath: string;
  readonly managed: boolean;
  readonly staged: boolean;
  readonly kind: "create" | "modify" | "delete";
}

export interface GitAreaReadModel {
  readonly headRevision: string | null;
  readonly upstreamRevision: string | null;
  readonly remoteStatus: string;
  readonly ahead: number;
  readonly behind: number;
  readonly workingTree: string;
  readonly pendingPublish: boolean;
  readonly changes: readonly GitChangeDto[];
}

export interface HarnessChangeDto {
  readonly assetKey: string;
  readonly kind: AssetKind;
  readonly relation:
    | "identical"
    | "source-only"
    | "target-only"
    | "source-updated"
    | "target-modified"
    | "both-modified"
    | "unsupported";
}

export interface SetCompareReadModel {
  readonly confidence: "trusted" | "unknown-baseline";
  readonly diffs: readonly HarnessChangeDto[];
}

// ---------------------------------------------------------------------------
// Projects / Harnesses
// ---------------------------------------------------------------------------

export interface ProjectDto {
  readonly projectId: string;
  readonly displayName: string;
  readonly localPathPresent: boolean;
  readonly available: boolean;
  /**
   * Whether the bound directory's git origin matches the project's remote
   * patterns. `unknown` when the project declares no pattern or the origin is
   * an https/ssh URL that v1 patterns cannot express.
   */
  readonly remoteVerified: "matched" | "mismatch" | "unknown";
}

export interface HarnessDto {
  readonly harnessInstanceId: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly installed: boolean;
  readonly readiness: string;
}

// ---------------------------------------------------------------------------
// History / Overview / Settings
// ---------------------------------------------------------------------------

export interface OperationHistoryDto {
  readonly batchId: string;
  readonly planId: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly targets: readonly { readonly targetKey: string; readonly state: string; readonly mode: string }[];
}

export interface OverviewReadModel {
  readonly repositoryBound: boolean;
  readonly repositoryId: string | null;
  readonly branch: string | null;
  readonly workingTree: string;
  readonly pendingPublish: boolean;
  readonly projectCount: number;
  readonly harnessCount: number;
  readonly libraryDrafts: number;
}

export interface SettingsReadModel {
  readonly theme: "light" | "dark" | "system";
  readonly selectedProfile: string | null;
}

export const DEFAULT_SETTINGS: SettingsReadModel = { theme: "light", selectedProfile: null };
