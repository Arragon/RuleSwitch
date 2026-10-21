// v2 IPC registration (M7): purposeful read-model channels only. Each
// channel validates its request against the frozen v2 schema, matches the
// sender's main-frame identity (same policy as v1), and returns
// Main-produced DTOs. No generic fs/shell/path capability exists here.

import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import {
  IPC_V2_CHANNELS,
  IPC_V2_REQUEST_SCHEMAS,
  type IpcV2Method
} from "@ruleswitch/core";

import type { AssetKind } from "@ruleswitch/core";

import type { CapabilityServiceV2 } from "./application/capabilities-v2";

type Handler = (request: unknown) => Promise<unknown>;

interface ApplyAssetPayload {
  readonly assetKey: string;
  readonly kind: string;
  readonly logicalName: string;
  readonly contentBase64: string;
}

/** Decodes asset bytes once for both preview and apply. */
function decodeApplyAssets(
  assets: readonly ApplyAssetPayload[]
): { assetKey: string; kind: AssetKind; logicalName: string; content: Uint8Array }[] {
  return assets.map((asset) => ({
    assetKey: asset.assetKey,
    kind: asset.kind as AssetKind,
    logicalName: asset.logicalName,
    content: new Uint8Array(Buffer.from(asset.contentBase64, "base64"))
  }));
}

export function registerV2IpcHandlers(
  ipcMain: IpcMain,
  mainWindowContents: WebContents,
  capabilities: CapabilityServiceV2
): void {
  const handlers: Record<IpcV2Method, Handler> = {
    "repository.openFromDirectory": async (request) => {
      const directory = (request as { directory: string }).directory;
      return capabilities.openRepositoryFromDirectory(directory);
    },
    "repository.clone": async (request) => {
      const { remoteUrl, targetDirectory } = request as {
        remoteUrl: string;
        targetDirectory: string;
      };
      return capabilities.cloneRepository(remoteUrl, targetDirectory);
    },
    "repository.status": async () => capabilities.repositoryStatus(),
    "repository.validate": async () => capabilities.validateRepository(),
    "library.browse": async () => capabilities.browseLibrary(),
    "library.readFile": async (request) => {
      const { logicalPath } = request as { logicalPath: string };
      return capabilities.readRepoFile(logicalPath);
    },
    "library.editFile": async (request) => {
      const { logicalPath, contentBase64 } = request as { logicalPath: string; contentBase64: string };
      return capabilities.editRepoFile(logicalPath, new Uint8Array(Buffer.from(contentBase64, "base64")));
    },
    "library.deleteAsset": async (request) => {
      const { logicalPaths } = request as { logicalPaths: readonly string[] };
      return capabilities.deleteRepoAsset(logicalPaths, true);
    },
    "changes.gitArea": async () => capabilities.gitArea(),
    "changes.setCompare": async () => capabilities.setCompare(),
    "changes.stage": async (request) => {
      const { logicalPaths } = request as { logicalPaths: readonly string[] };
      return capabilities.stagePaths(logicalPaths);
    },
    "changes.unstage": async (request) => {
      const { logicalPaths } = request as { logicalPaths: readonly string[] };
      return capabilities.unstagePaths(logicalPaths);
    },
    "changes.commit": async (request) => {
      const { message } = request as { message: string };
      return capabilities.commit(message);
    },
    "changes.push": async () => capabilities.push(),
    "changes.fetch": async () => capabilities.fetchRemote(),
    "changes.fastForward": async () => capabilities.fastForward(),
    "changes.log": async (request) => {
      const { cursor, pageSize } = request as { cursor: string | null; pageSize: number };
      return capabilities.logPage(cursor, pageSize);
    },
    "projects.list": async () => capabilities.listProjects(),
    "projects.bind": async (request) => {
      const { projectId, displayName, localPath, rebind } = request as {
        projectId: string;
        displayName: string;
        localPath: string;
        rebind?: boolean;
      };
      return capabilities.bindProject({
        projectId,
        displayName,
        localPath,
        ...(rebind === undefined ? {} : { rebind })
      });
    },
    "projects.unbind": async (request) => {
      const { projectId } = request as { projectId: string };
      return capabilities.unbindProject(projectId);
    },
    "harnesses.list": async () => capabilities.listHarnesses(),
    "history.operations": async () => capabilities.operationHistory(),
    "history.recovery": async () => capabilities.recoveryStatus(),
    "operations.rollback": async (request) => {
      const { batchId } = request as { batchId: string };
      return capabilities.rollbackBatch(batchId);
    },
    "settings.get": async () => capabilities.getSettings(),
    "settings.setTheme": async (request) => {
      const { theme } = request as { theme: "light" | "dark" | "system" };
      return capabilities.setTheme(theme);
    },
    "apply.preview": async (request) => {
      const { assets, mode, confirmAdoption, targets } = request as {
        assets: readonly { assetKey: string; kind: string; logicalName: string; contentBase64: string }[];
        mode: "overwrite" | "merge-add" | "add-only";
        confirmAdoption?: boolean;
        targets?: readonly {
          harnessInstanceId: string;
          mode?: "overwrite" | "merge-add" | "add-only";
          scope?: { kind: "global" } | { kind: "project"; projectId: string };
        }[];
      };
      return capabilities.previewApply({
        assets: decodeApplyAssets(assets),
        mode,
        ...(confirmAdoption === undefined ? {} : { confirmAdoption }),
        ...(targets === undefined ? {} : { targets })
      });
    },
    "apply.toHarnesses": async (request) => {
      const { assets, mode, confirmAdoption, targets, planRevision } = request as {
        assets: readonly { assetKey: string; kind: string; logicalName: string; contentBase64: string }[];
        mode: "overwrite" | "merge-add" | "add-only";
        confirmAdoption?: boolean;
        targets?: readonly {
          harnessInstanceId: string;
          mode?: "overwrite" | "merge-add" | "add-only";
          scope?: { kind: "global" } | { kind: "project"; projectId: string };
        }[];
        planRevision?: string;
      };
      return capabilities.applyToHarnesses({
        assets: decodeApplyAssets(assets),
        mode,
        ...(confirmAdoption === undefined ? {} : { confirmAdoption }),
        ...(targets === undefined ? {} : { targets }),
        ...(planRevision === undefined ? {} : { planRevision })
      });
    }
  };

  for (const method of Object.keys(handlers) as IpcV2Method[]) {
    const channel = IPC_V2_CHANNELS[method];
    const schema = IPC_V2_REQUEST_SCHEMAS[method];
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      // Same sender policy as v1: only the app's own main frame may invoke.
      const senderFrame = event.senderFrame;
      const expectedFrame = mainWindowContents.mainFrame;
      if (
        event.sender.id !== mainWindowContents.id ||
        senderFrame === null ||
        senderFrame.processId !== expectedFrame.processId ||
        senderFrame.routingId !== expectedFrame.routingId
      ) {
        return { ok: false, error: { code: "UNAUTHORIZED_RESOURCE", message: "v2 channel invoked from an unauthorized frame" } };
      }
      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) {
        return { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "invalid request" } };
      }
      try {
        return { ok: true, data: await handlers[method](parsed.data) };
      } catch (error) {
        return {
          ok: false,
          error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "v2 capability failed" }
        };
      }
    });
  }
}
