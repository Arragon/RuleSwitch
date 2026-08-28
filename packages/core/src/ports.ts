import type {
  ChangeSet,
  EntityId,
  FileResource,
  PreviewRevision,
  RevisionAggregate,
  Sha256Digest
} from "./contracts";

export interface ProviderDetectionRequest {
  readonly workspaceId: EntityId;
  readonly rootResourceId: EntityId;
}

export type ProviderDetectionResult =
  | {
      readonly detected: false;
      readonly sourceRootResourceId: null;
      readonly sourceResources: readonly [];
    }
  | {
      readonly detected: true;
      readonly sourceRootResourceId: EntityId;
      readonly sourceResources: readonly FileResource[];
    };

export interface ProviderValidationRequest {
  readonly workspaceId: EntityId;
  readonly profileId: EntityId;
  readonly sourceResourceId: EntityId;
}

export interface ProviderValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly resourceId: EntityId | null;
}

export interface ProviderValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ProviderValidationIssue[];
  readonly sourceRevision: RevisionAggregate;
}

export interface ProviderStageRequest {
  readonly workspaceId: EntityId;
  readonly profileId: EntityId;
  readonly sourceResourceId: EntityId;
  readonly targetId: EntityId;
}

export interface StagedOutput {
  readonly id: EntityId;
  readonly generatedResources: readonly FileResource[];
  readonly previewRevision: PreviewRevision;
}

export interface ProviderPreviewRequest {
  readonly workspaceId: EntityId;
  readonly profileId: EntityId;
  readonly targetId: EntityId;
  readonly stagedOutputId: EntityId;
}

export interface ProviderTargetDescriptor {
  readonly providerTarget: string;
  readonly name: string;
  readonly features: readonly string[];
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly version: string;
  readonly targets: readonly ProviderTargetDescriptor[];
}

export interface ConfigProvider {
  readonly descriptor: ProviderDescriptor;
  detect(request: ProviderDetectionRequest): Promise<ProviderDetectionResult>;
  validate(request: ProviderValidationRequest): Promise<ProviderValidationResult>;
  stage(request: ProviderStageRequest): Promise<StagedOutput>;
  preview(request: ProviderPreviewRequest): Promise<ChangeSet>;
}

export interface WorkspaceSelection {
  readonly selectedRoot: string;
  readonly displayName: string;
}

export interface PlatformService {
  selectWorkspace(): Promise<WorkspaceSelection | null>;
  openExternal(resourceId: EntityId): Promise<void>;
  getAppDataRoot(): Promise<string>;
}

export interface HashService {
  hashBytes(content: Uint8Array): Promise<Sha256Digest>;
  hashRevision(files: readonly FileResource[]): Promise<RevisionAggregate>;
}
