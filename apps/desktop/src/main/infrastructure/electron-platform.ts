import path from "node:path";

import { app, dialog, shell } from "electron";
import type { EntityId, PlatformService, WorkspaceSelection } from "@ruleswitch/core";

import { NodeFilesystemInfrastructure } from "./node-filesystem";

export class ElectronPlatformService implements PlatformService {
  private filesystem: NodeFilesystemInfrastructure | null = null;

  attachFilesystem(filesystem: NodeFilesystemInfrastructure): void {
    if (this.filesystem !== null) {
      throw new Error("The Electron platform filesystem is already attached.");
    }
    this.filesystem = filesystem;
  }

  async selectWorkspace(): Promise<WorkspaceSelection | null> {
    // This override is read only in Main and does not widen the Renderer request DTO.
    const smokeWorkspace = process.env["RULESWITCH_SMOKE_WORKSPACE"];
    if (smokeWorkspace !== undefined && smokeWorkspace.length > 0) {
      return {
        selectedRoot: smokeWorkspace,
        displayName: path.basename(path.resolve(smokeWorkspace)) || "Workspace"
      };
    }
    const result = await dialog.showOpenDialog({
      title: "Open RuleSwitch Workspace",
      properties: ["openDirectory"]
    });
    const selectedRoot = result.filePaths[0];
    if (result.canceled || selectedRoot === undefined) {
      return null;
    }
    return {
      selectedRoot,
      displayName: path.basename(selectedRoot) || "Workspace"
    };
  }

  async openExternal(resourceId: EntityId): Promise<void> {
    if (this.filesystem === null) {
      throw new Error("The Electron platform filesystem is unavailable.");
    }
    const authorized = await this.filesystem.authorizeResource(resourceId, "open-external");
    const error = await shell.openPath(authorized.absolutePath);
    if (error.length > 0) {
      throw new Error("The operating system did not open the authorized resource.");
    }
  }

  async getAppDataRoot(): Promise<string> {
    return app.getPath("userData");
  }
}
