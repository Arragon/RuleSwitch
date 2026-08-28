export const CONTRACT_VERSION = "v1" as const;
export const HASH_ALGORITHM = "sha256" as const;
export const REVISION_SERIALIZATION = "ruleswitch:file-revision-set:v1" as const;

export type EntityId = string;
export type IsoDateTime = string;
export type Sha256Digest = string;

export const PROFILE_KINDS = ["universal", "native"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const FILE_RESOURCE_ORIGINS = [
  "source",
  "generated",
  "workspace",
  "snapshot"
] as const;
export type FileResourceOrigin = (typeof FILE_RESOURCE_ORIGINS)[number];

export const FILE_RESOURCE_FORMATS = [
  "markdown",
  "json",
  "jsonc",
  "yaml",
  "toml",
  "text",
  "unknown"
] as const;
export type FileResourceFormat = (typeof FILE_RESOURCE_FORMATS)[number];

export const CHANGE_KINDS = ["create", "modify", "delete", "unchanged"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_SET_STATUSES = ["ready", "stale"] as const;
export type ChangeSetStatus = (typeof CHANGE_SET_STATUSES)[number];

export const TRANSACTION_STATES = [
  "PREPARING",
  "STAGED",
  "PREFLIGHT",
  "BACKED_UP",
  "APPLYING",
  "VERIFYING",
  "COMMITTED",
  "FAILED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "RECOVERY_REQUIRED"
] as const;
export type TransactionState = (typeof TRANSACTION_STATES)[number];

export const HISTORY_KINDS = ["apply", "restore"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface Workspace {
  readonly id: EntityId;
  readonly name: string;
  readonly rootResourceId: EntityId;
  readonly profileIds: readonly EntityId[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface Profile {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly name: string;
  readonly kind: ProfileKind;
  readonly provider: string;
  readonly sourceRootResourceId: EntityId;
  readonly targetIds: readonly EntityId[];
}

export interface Target {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly name: string;
  readonly provider: string;
  readonly providerTarget: string;
  readonly features: readonly string[];
}

export interface HashDescriptor {
  readonly algorithm: typeof HASH_ALGORITHM;
  readonly digest: Sha256Digest;
}

export interface FileResource {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly logicalPath: string;
  readonly origin: FileResourceOrigin;
  readonly format: FileResourceFormat;
  readonly readonly: boolean;
  readonly hash: HashDescriptor;
  readonly byteLength: number;
}

export interface FileRevision {
  readonly resourceId: EntityId;
  readonly hash: HashDescriptor;
  readonly byteLength: number;
}

// The v1 digest hashes UTF-8 JSON of [resourceId, digest, byteLength] tuples sorted by resourceId.
export interface RevisionAggregate {
  readonly algorithm: typeof HASH_ALGORITHM;
  readonly serialization: typeof REVISION_SERIALIZATION;
  readonly digest: Sha256Digest;
  readonly files: readonly FileRevision[];
}

export interface PreviewRevision {
  readonly sourceState: RevisionAggregate;
  readonly targetState: RevisionAggregate;
  readonly generatedState: RevisionAggregate;
}

export interface Change {
  readonly id: EntityId;
  readonly targetId: EntityId;
  readonly logicalPath: string;
  readonly kind: ChangeKind;
  readonly before: FileRevision | null;
  readonly after: FileRevision | null;
}

export interface ChangeSet {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly profileId: EntityId;
  readonly targetId: EntityId;
  readonly status: ChangeSetStatus;
  readonly previewRevision: PreviewRevision;
  readonly changes: readonly Change[];
  readonly createdAt: IsoDateTime;
}

export interface SnapshotFile {
  readonly logicalPath: string;
  readonly existed: boolean;
  readonly hash: HashDescriptor | null;
  readonly content: Uint8Array | null;
}

export interface Snapshot {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly transactionId: EntityId;
  readonly profileId: EntityId;
  readonly targetIds: readonly EntityId[];
  readonly provider: string;
  readonly providerVersion: string;
  readonly createdAt: IsoDateTime;
  readonly files: readonly SnapshotFile[];
}

export interface TransactionFailure {
  readonly code: string;
  readonly message: string;
  readonly affectedResourceIds: readonly EntityId[];
}

export interface ApplyTransaction {
  readonly id: EntityId;
  readonly operation: HistoryKind;
  readonly workspaceId: EntityId;
  readonly changeSetId: EntityId | null;
  readonly restoreHistoryEntryId: EntityId | null;
  readonly snapshotId: EntityId | null;
  readonly state: TransactionState;
  readonly failure: TransactionFailure | null;
  readonly startedAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly completedAt: IsoDateTime | null;
}

export interface HistoryEntry {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly kind: HistoryKind;
  readonly transactionId: EntityId;
  readonly snapshotId: EntityId;
  readonly changeSetId: EntityId | null;
  readonly restoredFromHistoryEntryId: EntityId | null;
  readonly createdAt: IsoDateTime;
  readonly summary: string;
}
