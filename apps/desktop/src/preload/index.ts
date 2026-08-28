import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
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
  type DesktopApi
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

contextBridge.exposeInMainWorld("ruleswitch", ruleswitch);
