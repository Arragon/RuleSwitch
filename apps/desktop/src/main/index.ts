import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { RulesyncProvider } from "@ruleswitch/rulesync-provider";

import { CapabilityServiceV2 } from "./application/capabilities-v2";
import { RuleSwitchApplication } from "./application/rule-switch-application";
import { HarnessRegistryStore, ProjectsStore, SettingsStore } from "./infrastructure/git/binding-store";
import { BatchSnapshotStore } from "./infrastructure/git/batch-snapshot-store";
import { SyncBaselineStore } from "./infrastructure/git/baseline-store";
import { RepositoryIdentityStore } from "./infrastructure/git/identity-store";
import { createGitRuntime } from "./infrastructure/git/git-runtime";
import { GitPortAdapter } from "./infrastructure/git/git-port-adapter";
import { OperationsStore } from "./infrastructure/git/sync-state";
import { ElectronPlatformService } from "./infrastructure/electron-platform";
import { NodeFilesystemInfrastructure } from "./infrastructure/node-filesystem";
import { DesktopStores } from "./infrastructure/storage";
import { registerIpcHandlers } from "./ipc";
import { registerV2IpcHandlers } from "./ipc-v2";

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

  // v2 capability layer (M7): real GitPort + stable-identity stores.
  const gitRuntime = await createGitRuntime();
  const identityStore = new RepositoryIdentityStore(path.join(appDataRoot, "v2", "identity-v1.json"));
  await identityStore.load();
  const gitPort = new GitPortAdapter({ gitRuntime, identityStore });
  const projectsStore = new ProjectsStore(path.join(appDataRoot, "v2", "projects-v1.json"));
  await projectsStore.load();
  const settingsStore = new SettingsStore(path.join(appDataRoot, "v2", "settings-v1.json"));
  await settingsStore.load();
  const operationsStore = new OperationsStore(path.join(appDataRoot, "v2", "operations-v1.json"));
  await operationsStore.load();
  const harnessRegistry = new HarnessRegistryStore(path.join(appDataRoot, "v2", "harness-registry-v1.json"));
  await harnessRegistry.load();
  const baselineStore = new SyncBaselineStore(path.join(appDataRoot, "v2", "sync-baselines-v1.json"));
  await baselineStore.load();
  const snapshotStore = new BatchSnapshotStore(path.join(appDataRoot, "v2", "batch-snapshots"));
  const capabilities = new CapabilityServiceV2({
    gitPort,
    projectsStore,
    settingsStore,
    operationsStore,
    baselineStore,
    snapshotStore,
    harnessRegistry,
    hasher: {
      sha256Hex(input) {
        return createHash("sha256").update(input, "utf8").digest("hex");
      }
    }
  });

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
  registerV2IpcHandlers(ipcMain, window.webContents, capabilities);
  installApplicationMenu(window);

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl !== undefined && rendererUrl.length > 0) {
    await window.loadURL(rendererUrl);
  } else {
    await window.loadFile(path.join(currentDirectory, "../renderer/index.html"));
  }
}

/**
 * macOS application menu (INH-1817): standard Edit menu roles for
 * copy/paste in Monaco, a Launch-at-Login toggle backed by
 * app.setLoginItemSettings, and no shell-opening items.
 */
function installApplicationMenu(window: BrowserWindow): void {
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const menu = Menu.buildFromTemplate([
    {
      label: "RuleSwitch",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "登录时启动",
          type: "checkbox",
          checked: launchAtLogin,
          click: () => {
            const openAtLogin = !app.getLoginItemSettings().openAtLogin;
            app.setLoginItemSettings({ openAtLogin });
          }
        },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "窗口",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }]
    }
  ]);
  Menu.setApplicationMenu(menu);
  void window;
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
