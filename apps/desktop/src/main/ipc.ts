import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
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
  type ApiErrorDto
} from "@ruleswitch/core";
import type { z } from "zod";

import { ApplicationError, RuleSwitchApplication } from "./application/rule-switch-application";

export function registerIpcHandlers(
  ipcMain: IpcMain,
  mainWindowContents: WebContents,
  application: RuleSwitchApplication
): void {
  register(
    ipcMain,
    IPC_CHANNELS.openWorkspace,
    mainWindowContents,
    openWorkspaceRequestSchema,
    openWorkspaceResponseSchema,
    async () => application.openWorkspace()
  );
  register(
    ipcMain,
    IPC_CHANNELS.readResource,
    mainWindowContents,
    readResourceRequestSchema,
    readResourceResponseSchema,
    async (request) => application.readResource(request.resourceId)
  );
  register(
    ipcMain,
    IPC_CHANNELS.openExternal,
    mainWindowContents,
    openExternalRequestSchema,
    openExternalResponseSchema,
    async (request) => application.openExternal(request.resourceId)
  );
  register(
    ipcMain,
    IPC_CHANNELS.stageTarget,
    mainWindowContents,
    stageTargetRequestSchema,
    stageTargetResponseSchema,
    async (request) =>
      application.stageTarget(
        request.workspaceId,
        request.profileId,
        request.sourceResourceId,
        request.targetId
      )
  );
  register(
    ipcMain,
    IPC_CHANNELS.applyChangeSet,
    mainWindowContents,
    applyChangeSetRequestSchema,
    applyChangeSetResponseSchema,
    async (request) => application.applyChangeSet(request.changeSetId)
  );
  register(
    ipcMain,
    IPC_CHANNELS.listHistory,
    mainWindowContents,
    listHistoryRequestSchema,
    listHistoryResponseSchema,
    async (request) => application.listHistory(request.workspaceId)
  );
  register(
    ipcMain,
    IPC_CHANNELS.restoreHistory,
    mainWindowContents,
    restoreHistoryRequestSchema,
    restoreHistoryResponseSchema,
    async (request) => application.restoreHistory(request.historyEntryId)
  );
}

function register<TRequest, TResponse>(
  ipcMain: IpcMain,
  channel: string,
  mainWindowContents: WebContents,
  requestSchema: z.ZodType<TRequest>,
  responseSchema: z.ZodType<TResponse>,
  operation: (request: TRequest) => Promise<unknown>
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, rawRequest: unknown) => {
    try {
      if (!isAuthorizedMainFrame(event, mainWindowContents)) {
        throw new ApplicationError("UNAUTHORIZED_RESOURCE", "The IPC sender is not authorized.");
      }
      const request = requestSchema.parse(rawRequest);
      const data = await operation(request);
      return responseSchema.parse({ ok: true, data });
    } catch (error) {
      const apiError = mapApiError(error);
      return responseSchema.parse({ ok: false, error: apiError });
    }
  });
}

function isAuthorizedMainFrame(
  event: IpcMainInvokeEvent,
  mainWindowContents: WebContents
): boolean {
  const senderFrame = event.senderFrame;
  if (event.sender.id !== mainWindowContents.id || senderFrame === null) {
    return false;
  }
  const expectedFrame = mainWindowContents.mainFrame;
  return (
    senderFrame.processId === expectedFrame.processId &&
    senderFrame.routingId === expectedFrame.routingId
  );
}

function mapApiError(error: unknown): ApiErrorDto {
  if (error instanceof ApplicationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: {}
    };
  }
  if (isZodError(error)) {
    return {
      code: "VALIDATION_ERROR",
      message: "The request or response did not match the v1 contract.",
      retryable: false,
      details: {}
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The operation failed safely.",
    retryable: false,
    details: {}
  };
}

function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}
