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

  test("exposes only the named ruleswitch DesktopApi bridge", async () => {
    const source = await readFile(preloadSource, "utf8");
    expect(source).toContain('contextBridge.exposeInMainWorld("ruleswitch", ruleswitch)');
    expect(source.match(/exposeInMainWorld/g)).toHaveLength(1);
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
  });
});
