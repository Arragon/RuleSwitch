import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type ElectronApplication } from "@playwright/test";

import { launchDesktopApp, repositoryRoot } from "./launcher";

const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "rulesync-provider", "workspace");

test("walks the real sandboxed Electron UI from source review through restore", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "RuleSwitch E2E "));
  const workspaceRoot = path.join(temporaryRoot, "工作区 with spaces");
  const appDataRoot = path.join(temporaryRoot, "electron profile");
  await cp(fixtureRoot, workspaceRoot, { recursive: true });
  await mkdir(appDataRoot, { recursive: true });

  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  const unknownPath = path.join(workspaceRoot, "unmanaged.txt");
  const originalAgents = await readFile(agentsPath);
  const originalUnknown = await readFile(unknownPath);

  let electronApp: ElectronApplication | undefined;
  try {
    const launched = await launchDesktopApp({
      extraArgs: [`--user-data-dir=${appDataRoot}`],
      env: { RULESWITCH_SMOKE_WORKSPACE: workspaceRoot }
    });
    electronApp = launched.electronApp;
    const page = launched.page;
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (entry) => {
      if (entry.type() === "error") rendererErrors.push(entry.text());
    });
    await page.waitForLoadState("domcontentloaded");

    const boundary = await page.evaluate(() => ({
      requireType: typeof (globalThis as { require?: unknown }).require,
      processType: typeof (globalThis as { process?: unknown }).process,
      ipcRendererType: typeof (globalThis as { ipcRenderer?: unknown }).ipcRenderer,
      methods: Object.keys(window.ruleswitch).sort()
    }));
    expect(boundary).toEqual({
      requireType: "undefined",
      processType: "undefined",
      ipcRendererType: "undefined",
      methods: [
        "applyChangeSet",
        "listHistory",
        "openExternal",
        "openWorkspace",
        "readResource",
        "restoreHistory",
        "stageTarget"
      ]
    });

    await page.getByTestId("open-workspace").click();
    await expect(page.getByTestId("workspace-name")).toContainText("工作区 with spaces");
    await expect(page.getByTestId("source-item").first()).toContainText("rules/base.md");

    await page.getByTestId("source-item").first().click();
    await page.getByTestId("raw-tab").click();
    await expect(page.getByTestId("raw-editor").locator(".view-lines")).toContainText(
      "RULESWITCH_REAL_RULE"
    );

    await page.getByTestId("rendered-tab").click();
    await expect(page.getByTestId("rendered-preview")).toContainText("RuleSwitch Integration Rule");
    await expect(page.getByTestId("rendered-preview")).toContainText("RULESWITCH_REAL_RULE");

    await page.getByTestId("open-external").click();
    await expect(page.getByTestId("external-status")).toHaveText(
      "Opened in the system default application."
    );

    await page.getByTestId("stage-target").click();
    await expect(page.getByTestId("change-set-status")).toContainText("ChangeSet ready");
    await expect(page.getByTestId("generated-editor").locator(".view-lines")).toContainText(
      "RULESWITCH_REAL_RULE"
    );

    await page.getByTestId("diff-tab").click();
    const diffEditor = page.getByTestId("diff-editor").locator(".monaco-diff-editor");
    await expect(diffEditor).toBeVisible();
    await expect(diffEditor).toContainText("Existing Workspace Instructions");
    await expect(diffEditor).toContainText("RULESWITCH_REAL_RULE");

    await page.getByTestId("apply-change-set").click();
    await expect(page.getByTestId("apply-status")).toHaveText("Apply · COMMITTED");

    await page.getByTestId("list-history").click();
    await expect(page.getByTestId("history-list")).toContainText("apply");
    await expect(page.getByTestId("restore-history")).toBeEnabled();

    await page.getByTestId("restore-history").click();
    await expect(page.getByTestId("restore-status")).toHaveText("Restore · COMMITTED");

    expect(await readFile(agentsPath)).toEqual(originalAgents);
    expect(await readFile(unknownPath)).toEqual(originalUnknown);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
