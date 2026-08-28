import { z } from "zod";

import type {
  ApplyTransaction,
  ChangeSet,
  FileResource,
  HistoryEntry,
  Profile,
  Target,
  Workspace
} from "./contracts";
import {
  applyTransactionSchema,
  changeSetSchema,
  fileResourceSchema,
  historyEntrySchema,
  profileSchema,
  targetSchema,
  workspaceSchema
} from "./schemas";

export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "UNAUTHORIZED_RESOURCE",
  "WORKSPACE_UNAVAILABLE",
  "STALE_CHANGE_SET",
  "PROVIDER_ERROR",
  "TRANSACTION_ERROR",
  "RECOVERY_REQUIRED",
  "INTERNAL_ERROR"
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorDto {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string>>;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiErrorDto };

export type WorkspaceDto = Workspace;
export type ProfileDto = Profile;
export type TargetDto = Target;
export type FileResourceDto = FileResource;
export type ChangeSetDto = ChangeSet;
export type ApplyTransactionDto = ApplyTransaction;
export type HistoryEntryDto = HistoryEntry;

export interface WorkspaceSessionDto {
  readonly workspace: WorkspaceDto;
  readonly profile: ProfileDto;
  readonly target: TargetDto;
  readonly sourceResources: readonly FileResourceDto[];
}

export interface ResourceContentDto {
  readonly resource: FileResourceDto;
  readonly content: Uint8Array;
}

export const apiErrorDtoSchema: z.ZodType<ApiErrorDto> = z.strictObject({
  code: z.enum(API_ERROR_CODES),
  message: z.string().trim().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.string())
});

function apiResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data: dataSchema }),
    z.strictObject({ ok: z.literal(false), error: apiErrorDtoSchema })
  ]);
}

const resourceIdRequestSchema = z.strictObject({
  resourceId: z.string().trim().min(1)
});

export const openWorkspaceRequestSchema = z.strictObject({});
export const readResourceRequestSchema = resourceIdRequestSchema;
export const openExternalRequestSchema = resourceIdRequestSchema;
export const stageTargetRequestSchema = z.strictObject({
  workspaceId: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
  sourceResourceId: z.string().trim().min(1),
  targetId: z.string().trim().min(1)
});
export const applyChangeSetRequestSchema = z.strictObject({
  changeSetId: z.string().trim().min(1)
});
export const listHistoryRequestSchema = z.strictObject({
  workspaceId: z.string().trim().min(1)
});
export const restoreHistoryRequestSchema = z.strictObject({
  historyEntryId: z.string().trim().min(1)
});

export type OpenWorkspaceRequest = z.infer<typeof openWorkspaceRequestSchema>;
export type ReadResourceRequest = z.infer<typeof readResourceRequestSchema>;
export type OpenExternalRequest = z.infer<typeof openExternalRequestSchema>;
export type StageTargetRequest = z.infer<typeof stageTargetRequestSchema>;
export type ApplyChangeSetRequest = z.infer<typeof applyChangeSetRequestSchema>;
export type ListHistoryRequest = z.infer<typeof listHistoryRequestSchema>;
export type RestoreHistoryRequest = z.infer<typeof restoreHistoryRequestSchema>;

export const workspaceSessionDtoSchema: z.ZodType<WorkspaceSessionDto> = z
  .strictObject({
    workspace: workspaceSchema,
    profile: profileSchema,
    target: targetSchema,
    sourceResources: z.array(fileResourceSchema).min(1)
  })
  .superRefine((session, context) => {
    if (
      session.workspace.profileIds.length !== 1 ||
      session.workspace.profileIds[0] !== session.profile.id
    ) {
      context.addIssue({
        code: "custom",
        message: "WorkspaceSession requires exactly its single v0.1 profile"
      });
    }
    if (
      session.profile.targetIds.length !== 1 ||
      session.profile.targetIds[0] !== session.target.id
    ) {
      context.addIssue({
        code: "custom",
        message: "WorkspaceSession requires exactly its single v0.1 target"
      });
    }
    if (
      session.profile.workspaceId !== session.workspace.id ||
      session.target.workspaceId !== session.workspace.id
    ) {
      context.addIssue({ code: "custom", message: "WorkspaceSession workspace IDs must match" });
    }
    if (session.profile.provider !== session.target.provider) {
      context.addIssue({ code: "custom", message: "WorkspaceSession provider IDs must match" });
    }

    const resourceIds = session.sourceResources.map((resource) => resource.id);
    const logicalPaths = session.sourceResources.map((resource) => resource.logicalPath);
    if (new Set(resourceIds).size !== resourceIds.length) {
      context.addIssue({ code: "custom", message: "Source resource IDs must be unique" });
    }
    if (new Set(logicalPaths).size !== logicalPaths.length) {
      context.addIssue({ code: "custom", message: "Source logical paths must be unique" });
    }
    if (
      session.sourceResources.some(
        (resource) => resource.workspaceId !== session.workspace.id || resource.origin !== "source"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Source resources must belong to the session workspace and have source origin"
      });
    }
  });

export const resourceContentDtoSchema: z.ZodType<ResourceContentDto> = z.strictObject({
  resource: fileResourceSchema,
  content: z.instanceof(Uint8Array)
});

export const openWorkspaceResponseSchema = apiResultSchema(workspaceSessionDtoSchema);
export const readResourceResponseSchema = apiResultSchema(resourceContentDtoSchema);
export const openExternalResponseSchema = apiResultSchema(z.null());
export const stageTargetResponseSchema = apiResultSchema(changeSetSchema);
export const applyChangeSetResponseSchema = apiResultSchema(applyTransactionSchema);
export const listHistoryResponseSchema = apiResultSchema(z.array(historyEntrySchema));
export const restoreHistoryResponseSchema = apiResultSchema(applyTransactionSchema);

export interface IpcContract {
  readonly openWorkspace: {
    readonly request: OpenWorkspaceRequest;
    readonly response: ApiResult<WorkspaceSessionDto>;
  };
  readonly readResource: {
    readonly request: ReadResourceRequest;
    readonly response: ApiResult<ResourceContentDto>;
  };
  readonly openExternal: {
    readonly request: OpenExternalRequest;
    readonly response: ApiResult<null>;
  };
  readonly stageTarget: {
    readonly request: StageTargetRequest;
    readonly response: ApiResult<ChangeSetDto>;
  };
  readonly applyChangeSet: {
    readonly request: ApplyChangeSetRequest;
    readonly response: ApiResult<ApplyTransactionDto>;
  };
  readonly listHistory: {
    readonly request: ListHistoryRequest;
    readonly response: ApiResult<readonly HistoryEntryDto[]>;
  };
  readonly restoreHistory: {
    readonly request: RestoreHistoryRequest;
    readonly response: ApiResult<ApplyTransactionDto>;
  };
}

export const IPC_CHANNELS = Object.freeze({
  openWorkspace: "ruleswitch:v1:workspace:open",
  readResource: "ruleswitch:v1:resource:read",
  openExternal: "ruleswitch:v1:resource:open-external",
  stageTarget: "ruleswitch:v1:target:stage",
  applyChangeSet: "ruleswitch:v1:change-set:apply",
  listHistory: "ruleswitch:v1:history:list",
  restoreHistory: "ruleswitch:v1:history:restore"
} as const satisfies Record<keyof IpcContract, string>);

export const IPC_SCHEMAS = Object.freeze({
  openWorkspace: {
    request: openWorkspaceRequestSchema,
    response: openWorkspaceResponseSchema
  },
  readResource: {
    request: readResourceRequestSchema,
    response: readResourceResponseSchema
  },
  openExternal: {
    request: openExternalRequestSchema,
    response: openExternalResponseSchema
  },
  stageTarget: {
    request: stageTargetRequestSchema,
    response: stageTargetResponseSchema
  },
  applyChangeSet: {
    request: applyChangeSetRequestSchema,
    response: applyChangeSetResponseSchema
  },
  listHistory: {
    request: listHistoryRequestSchema,
    response: listHistoryResponseSchema
  },
  restoreHistory: {
    request: restoreHistoryRequestSchema,
    response: restoreHistoryResponseSchema
  }
});

export interface DesktopApi {
  openWorkspace(): Promise<ApiResult<WorkspaceSessionDto>>;
  readResource(resourceId: string): Promise<ApiResult<ResourceContentDto>>;
  openExternal(resourceId: string): Promise<ApiResult<null>>;
  stageTarget(
    workspaceId: string,
    profileId: string,
    sourceResourceId: string,
    targetId: string
  ): Promise<ApiResult<ChangeSetDto>>;
  applyChangeSet(changeSetId: string): Promise<ApiResult<ApplyTransactionDto>>;
  listHistory(workspaceId: string): Promise<ApiResult<readonly HistoryEntryDto[]>>;
  restoreHistory(historyEntryId: string): Promise<ApiResult<ApplyTransactionDto>>;
}
