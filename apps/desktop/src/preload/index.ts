import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  IPC_V2_CHANNELS,
  applyChangeSetRequestSchema,
  applyChangeSetResponseSchema,
  listHistoryRequestSchema,
  listHistoryResponseSchema,
  openExternalRequestSchema,
  openExternalResponseSchema,
  openWorkspaceRequestSchema,
  openWorkspaceResponseSchema,
  readResourceRequestSchema,
  readResourceResponseSchema,
  restoreHistoryRequestSchema,
  restoreHistoryResponseSchema,
  stageTargetRequestSchema,
  stageTargetResponseSchema,
  type DesktopApi,
  type DesktopApiV2
} from "@ruleswitch/core";
import type { z } from "zod";

async function invoke<TRequest, TResponse>(
  channel: string,
  requestSchema: z.ZodType<TRequest>,
  responseSchema: z.ZodType<TResponse>,
  request: TRequest
): Promise<TResponse> {
  const validatedRequest = requestSchema.parse(request);
  const response: unknown = await ipcRenderer.invoke(channel, validatedRequest);
  return responseSchema.parse(response);
}

const ruleswitch: DesktopApi = Object.freeze({
  openWorkspace: async () =>
    invoke(
      IPC_CHANNELS.openWorkspace,
      openWorkspaceRequestSchema,
      openWorkspaceResponseSchema,
      {}
    ),
  readResource: async (resourceId: string) =>
    invoke(
      IPC_CHANNELS.readResource,
      readResourceRequestSchema,
      readResourceResponseSchema,
      { resourceId }
    ),
  openExternal: async (resourceId: string) =>
    invoke(
      IPC_CHANNELS.openExternal,
      openExternalRequestSchema,
      openExternalResponseSchema,
      { resourceId }
    ),
  stageTarget: async (
    workspaceId: string,
    profileId: string,
    sourceResourceId: string,
    targetId: string
  ) =>
    invoke(
      IPC_CHANNELS.stageTarget,
      stageTargetRequestSchema,
      stageTargetResponseSchema,
      { workspaceId, profileId, sourceResourceId, targetId }
    ),
  applyChangeSet: async (changeSetId: string) =>
    invoke(
      IPC_CHANNELS.applyChangeSet,
      applyChangeSetRequestSchema,
      applyChangeSetResponseSchema,
      { changeSetId }
    ),
  listHistory: async (workspaceId: string) =>
    invoke(
      IPC_CHANNELS.listHistory,
      listHistoryRequestSchema,
      listHistoryResponseSchema,
      { workspaceId }
    ),
  restoreHistory: async (historyEntryId: string) =>
    invoke(
      IPC_CHANNELS.restoreHistory,
      restoreHistoryRequestSchema,
      restoreHistoryResponseSchema,
      { historyEntryId }
    )
});

const ruleswitchV2: DesktopApiV2 = Object.freeze({
  openRepositoryFromDirectory: async (directory: string) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["repository.openFromDirectory"], { directory })
    ) as Awaited<ReturnType<DesktopApiV2["openRepositoryFromDirectory"]>>,
  repositoryStatus: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["repository.status"], {})) as Awaited<
      ReturnType<DesktopApiV2["repositoryStatus"]>
    >,
  cloneRepository: async (remoteUrl: string, targetDirectory: string) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["repository.clone"], { remoteUrl, targetDirectory })
    ) as Awaited<ReturnType<DesktopApiV2["cloneRepository"]>>,
  validateRepository: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["repository.validate"], {})) as Awaited<
      ReturnType<DesktopApiV2["validateRepository"]>
    >,
  bindProject: async (request: {
    projectId: string;
    displayName: string;
    localPath: string;
    rebind?: boolean;
  }) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["projects.bind"], request)
    ) as Awaited<ReturnType<DesktopApiV2["bindProject"]>>,
  unbindProject: async (projectId: string) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["projects.unbind"], { projectId })
    ) as boolean,
  browseLibrary: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["library.browse"], {})) as Awaited<
      ReturnType<DesktopApiV2["browseLibrary"]>
    >,
  readRepoFile: async (logicalPath: string) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["library.readFile"], { logicalPath })
    ) as Awaited<ReturnType<DesktopApiV2["readRepoFile"]>>,
  editRepoFile: async (logicalPath: string, contentBase64: string) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["library.editFile"], { logicalPath, contentBase64 })
    ) as boolean,
  deleteRepoAsset: async (logicalPaths: readonly string[], confirmed: true) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["library.deleteAsset"], { logicalPaths, confirmed })
    ) as boolean,
  gitArea: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.gitArea"], {})) as Awaited<
      ReturnType<DesktopApiV2["gitArea"]>
    >,
  setCompare: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.setCompare"], {})) as Awaited<
      ReturnType<DesktopApiV2["setCompare"]>
    >,
  stagePaths: async (logicalPaths: readonly string[]) =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.stage"], { logicalPaths })) as boolean,
  unstagePaths: async (logicalPaths: readonly string[]) =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.unstage"], { logicalPaths })) as boolean,
  commit: async (message: string) =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.commit"], { message })) as Awaited<
      ReturnType<DesktopApiV2["commit"]>
    >,
  push: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.push"], {})) as Awaited<
      ReturnType<DesktopApiV2["push"]>
    >,
  fetchRemote: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.fetch"], {})) as boolean,
  fastForward: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.fastForward"], {})) as Awaited<
      ReturnType<DesktopApiV2["fastForward"]>
    >,
  logPage: async (cursor: string | null, pageSize: number) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["changes.log"], { cursor, pageSize })
    ) as Awaited<ReturnType<DesktopApiV2["logPage"]>>,
  listProjects: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["projects.list"], {})) as Awaited<
      ReturnType<DesktopApiV2["listProjects"]>
    >,
  listHarnesses: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["harnesses.list"], {})) as Awaited<
      ReturnType<DesktopApiV2["listHarnesses"]>
    >,
  scanHarness: async (harnessInstanceId: string) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["harnesses.scan"], { harnessInstanceId })
    ) as Awaited<ReturnType<DesktopApiV2["scanHarness"]>>,
  operationHistory: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["history.operations"], {})) as Awaited<
      ReturnType<DesktopApiV2["operationHistory"]>
    >,
  rollbackBatch: async (batchId: string) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["operations.rollback"], { batchId })
    ) as Awaited<ReturnType<DesktopApiV2["rollbackBatch"]>>,
  recoveryStatus: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["history.recovery"], {})) as Awaited<
      ReturnType<DesktopApiV2["recoveryStatus"]>
    >,
  getSettings: async () =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["settings.get"], {})) as Awaited<
      ReturnType<DesktopApiV2["getSettings"]>
    >,
  setTheme: async (theme: "light" | "dark" | "system") =>
    unwrap(await ipcRenderer.invoke(IPC_V2_CHANNELS["settings.setTheme"], { theme })) as Awaited<
      ReturnType<DesktopApiV2["setTheme"]>
    >,
  previewApply: async (
    assets: readonly { assetKey: string; kind: string; logicalName: string; contentBase64: string }[],
    mode: "overwrite" | "merge-add" | "add-only",
    options?: {
      readonly confirmAdoption?: boolean;
      readonly targets?: readonly {
        readonly harnessInstanceId: string;
        readonly mode?: "overwrite" | "merge-add" | "add-only";
        readonly scope?: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string };
      }[];
    }
  ) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["apply.preview"], {
        assets,
        mode,
        ...(options?.confirmAdoption === undefined ? {} : { confirmAdoption: options.confirmAdoption }),
        ...(options?.targets === undefined ? {} : { targets: options.targets })
      })
    ) as Awaited<ReturnType<DesktopApiV2["previewApply"]>>,
  diffApplyTarget: async (
    assets: readonly { assetKey: string; kind: string; logicalName: string; contentBase64: string }[],
    mode: "overwrite" | "merge-add" | "add-only",
    targetKey: string,
    options?: {
      readonly confirmAdoption?: boolean;
      readonly targets?: readonly {
        readonly harnessInstanceId: string;
        readonly mode?: "overwrite" | "merge-add" | "add-only";
        readonly scope?: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string };
      }[];
      readonly planRevision?: string;
    }
  ) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["apply.diff"], {
        assets,
        mode,
        targetKey,
        ...(options?.confirmAdoption === undefined ? {} : { confirmAdoption: options.confirmAdoption }),
        ...(options?.targets === undefined ? {} : { targets: options.targets }),
        ...(options?.planRevision === undefined ? {} : { planRevision: options.planRevision })
      })
    ) as Awaited<ReturnType<DesktopApiV2["diffApplyTarget"]>>,
  applyToHarnesses: async (
    assets: readonly { assetKey: string; kind: string; logicalName: string; contentBase64: string }[],
    mode: "overwrite" | "merge-add" | "add-only",
    options?: {
      readonly confirmAdoption?: boolean;
      readonly targets?: readonly {
        readonly harnessInstanceId: string;
        readonly mode?: "overwrite" | "merge-add" | "add-only";
        readonly scope?: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string };
      }[];
      readonly planRevision?: string;
    }
  ) =>
    unwrap(
      await ipcRenderer.invoke(IPC_V2_CHANNELS["apply.toHarnesses"], {
        assets,
        mode,
        ...(options?.confirmAdoption === undefined ? {} : { confirmAdoption: options.confirmAdoption }),
        ...(options?.targets === undefined ? {} : { targets: options.targets }),
        ...(options?.planRevision === undefined ? {} : { planRevision: options.planRevision })
      })
    ) as Awaited<ReturnType<DesktopApiV2["applyToHarnesses"]>>
});

function unwrap(response: unknown): unknown {
  const record = response as { ok: boolean; data?: unknown; error?: { message: string } };
  if (record !== null && typeof record === "object" && record.ok === true) {
    return record.data ?? null;
  }
  throw new Error(record?.error?.message ?? "v2 capability failed");
}

// v1 E2E smoke override: when Main was launched with the walking-skeleton
// env, the renderer mounts the v1 workbench (compatibility window).
const v1SmokeMode = typeof process.env["RULESWITCH_SMOKE_WORKSPACE"] === "string";

contextBridge.exposeInMainWorld("ruleswitch", ruleswitch);
contextBridge.exposeInMainWorld("ruleswitchV2", ruleswitchV2);
contextBridge.exposeInMainWorld("ruleswitchV1SmokeMode", v1SmokeMode);
