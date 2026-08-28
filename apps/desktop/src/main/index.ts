import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain } from "electron";
import { RulesyncProvider } from "@ruleswitch/rulesync-provider";

import { RuleSwitchApplication } from "./application/rule-switch-application";
import { ElectronPlatformService } from "./infrastructure/electron-platform";
import { NodeFilesystemInfrastructure } from "./infrastructure/node-filesystem";
import { DesktopStores } from "./infrastructure/storage";
import { registerIpcHandlers } from "./ipc";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

async function createMainWindow(): Promise<void> {
  const platform = new ElectronPlatformService();
  const appDataRoot = await platform.getAppDataRoot();
  const filesystem = new NodeFilesystemInfrastructure(appDataRoot);
  platform.attachFilesystem(filesystem);
  const stores = new DesktopStores(appDataRoot);
  const provider = new RulesyncProvider(filesystem);
  const application = new RuleSwitchApplication(platform, filesystem, provider, stores);
  await application.initialize();

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  registerIpcHandlers(ipcMain, window.webContents, application);

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl !== undefined && rendererUrl.length > 0) {
    await window.loadURL(rendererUrl);
  } else {
    await window.loadFile(path.join(currentDirectory, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}).catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "desktop_start_failed",
      errorType: error instanceof Error ? error.name : "UnknownError"
    })
  );
  app.quit();
});

app.on("window-all-closed", () => {
  app.quit();
});
