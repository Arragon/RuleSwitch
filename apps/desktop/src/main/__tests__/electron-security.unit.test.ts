import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

const mainSource = new URL("../index.ts", import.meta.url);
const ipcSource = new URL("../ipc.ts", import.meta.url);
const preloadSource = new URL("../../preload/index.ts", import.meta.url);
const rendererDocument = new URL("../../renderer/index.html", import.meta.url);

describe("Electron capability boundary", () => {
  test("pins hardened BrowserWindow preferences and denies navigation/window creation", async () => {
    const source = await readFile(mainSource, "utf8");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).not.toMatch(/webSecurity\s*:\s*false/);
    expect(source).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
    expect(source).toContain('on("will-navigate", (event) => event.preventDefault())');
    expect(source).toContain('on("will-redirect", (event) => event.preventDefault())');
  });

  test("loads the Vite renderer and pins its production CSP", async () => {
    const [main, html] = await Promise.all([
      readFile(mainSource, "utf8"),
      readFile(rendererDocument, "utf8")
    ]);
    expect(main).toContain('process.env["ELECTRON_RENDERER_URL"]');
    expect(main).toContain('loadFile(path.join(currentDirectory, "../renderer/index.html"))');
    expect(html).toContain(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    );
    expect(html).not.toMatch(/https?:\/\//);
  });

  test("authorizes IPC by stable main-frame process and routing identity", async () => {
    const source = await readFile(ipcSource, "utf8");
    expect(source).toContain("senderFrame === null");
    expect(source).toContain("senderFrame.processId === expectedFrame.processId");
    expect(source).toContain("senderFrame.routingId === expectedFrame.routingId");
    expect(source).not.toContain("event.senderFrame !== mainWindowContents.mainFrame");
  });

  test("exposes only the two named bridges plus the v1 smoke flag", async () => {
    const source = await readFile(preloadSource, "utf8");
    expect(source).toContain('contextBridge.exposeInMainWorld("ruleswitch", ruleswitch)');
    expect(source).toContain('contextBridge.exposeInMainWorld("ruleswitchV2", ruleswitchV2)');
    // Exactly three exposures: frozen v1 7-method API, versioned v2
    // read-model API (M0 INH-1757), and the boolean v1-smoke-mode flag for
    // the walking-skeleton E2E. No generic fs/shell/path bridge.
    expect(source.match(/exposeInMainWorld/g)).toHaveLength(3);
    expect(source).toContain('exposeInMainWorld("ruleswitchV1SmokeMode", v1SmokeMode)');
    expect(source).not.toContain("ipcRenderer:");
    for (const method of [
      "openWorkspace",
      "readResource",
      "openExternal",
      "stageTarget",
      "applyChangeSet",
      "listHistory",
      "restoreHistory"
    ]) {
      expect(source).toContain(`${method}:`);
    }
    // v2 surface is exactly the frozen method set — no extras.
    for (const method of [
      "openRepositoryFromDirectory",
      "repositoryStatus",
      "browseLibrary",
      "gitArea",
      "setCompare",
      "listProjects",
      "listHarnesses",
      "operationHistory",
      "getSettings",
      "setTheme"
    ]) {
      expect(source).toContain(`${method}:`);
    }
    expect(source).toContain("IPC_V2_CHANNELS");
    // Request schemas are enforced Main-side (ipc-v2.ts) — the preload sends
    // plain DTOs, the Main validates against the frozen registry.
    const ipcV2Source = await readFile(new URL("../ipc-v2.ts", import.meta.url), "utf8");
    expect(ipcV2Source).toContain("IPC_V2_REQUEST_SCHEMAS");
    expect(ipcV2Source).toContain("schema.safeParse");
  });
});
