import type {
  EntityId,
  FileResource,
  FileResourceFormat,
  FileResourceOrigin,
  RevisionAggregate
} from "@ruleswitch/core";

export type SymlinkPolicy = "allow-contained" | "reject";

export interface SafeFileEntry {
  readonly logicalPath: string;
}

export interface RegisterRootRequest {
  readonly workspaceId: EntityId;
  readonly parentRootResourceId: EntityId;
  readonly logicalPath: string;
}

export interface RegisterFileRequest {
  readonly workspaceId: EntityId;
  readonly rootResourceId: EntityId;
  readonly logicalPath: string;
  readonly origin: FileResourceOrigin;
  readonly format: FileResourceFormat;
  readonly readonly: boolean;
  readonly symlinkPolicy: SymlinkPolicy;
}

/**
 * Main will implement this capability-oriented boundary. Absolute paths never
 * cross into the core contract or Renderer-facing DTOs.
 */
export interface RulesyncProviderInfrastructure {
  resolveAuthorizedRootPath(workspaceId: EntityId, rootResourceId: EntityId): Promise<string>;
  resolveAuthorizedResourcePath(workspaceId: EntityId, resourceId: EntityId): Promise<string>;
  registerDirectoryRoot(request: RegisterRootRequest): Promise<EntityId | null>;
  createEmptyStagingRoot(workspaceId: EntityId): Promise<EntityId>;
  enumerateSafeFiles(
    workspaceId: EntityId,
    rootResourceId: EntityId,
    symlinkPolicy: SymlinkPolicy
  ): Promise<readonly SafeFileEntry[]>;
  registerFileResource(request: RegisterFileRequest): Promise<FileResource>;
  registerFileResourceIfExists(request: RegisterFileRequest): Promise<FileResource | null>;
  refreshFileResource(workspaceId: EntityId, resourceId: EntityId): Promise<FileResource>;
  readResourceBytes(workspaceId: EntityId, resourceId: EntityId): Promise<Uint8Array>;
  aggregateRevision(resources: readonly FileResource[]): Promise<RevisionAggregate>;
  createOpaqueId(kind: "staged-output" | "change-set" | "change"): EntityId;
  nowIso(): string;
}
