// Business-level UI E2E (INH-1857): the real Electron app against a real Git
// repository and a real harness directory, driven only through the UI.
//
// Why this exists: the shell E2E proves navigation and accessibility but never
// proves that a user can actually get bytes from the repository onto a harness.
// This spec connects a temporary repository, previews, opens the line-level
// diff, confirms, and then asserts the bytes on disk — the whole path the
// product exists for.
//
// Two environment seams make it hermetic, and both are product seams rather
// than test hacks:
//   HOME                → harness roots resolve from `process.env.HOME`
//   --user-data-dir     → Electron's `app.getPath("userData")`, where the v2
//                         stores (harness registry, identity, journals) live.
// The harness registration is seeded as the store's own envelope so the test
// never depends on a real Claude/Codex install on the machine.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { launchDesktopApp } from "./launcher";

const run = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await run("/usr/bin/git", args, { cwd });
}

test("applies a repository asset to a registered harness through preview, diff and confirm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-e2e-apply-"));
  const home = path.join(root, "home");
  const userData = path.join(root, "user-data");
  const repo = path.join(root, "config-repo");
  const registryDir = path.join(userData, "v2");

  await mkdir(home, { recursive: true });
  await mkdir(registryDir, { recursive: true });
  await mkdir(path.join(repo, "global", "instructions"), { recursive: true });
  await writeFile(path.join(repo, "ruleswitch.yaml"), "schemaVersion: 1\n", "utf8");
  await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), "# global from repo\n", "utf8");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "E2E"]);
  await git(repo, ["config", "user.email", "e2e@example.com"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "seed"]);

  await writeFile(
    path.join(registryDir, "harness-registry-v1.json"),
    `${JSON.stringify(
      {
        store: "harness-registry",
        version: 1,
        writtenAt: new Date().toISOString(),
        data: {
          registrations: {
            harn_codex: {
              harnessInstanceId: "harn_codex",
              adapterId: "codex",
              displayName: "Codex",
              presetMatched: true,
              customIcon: null,
              customFormatHints: [],
              installed: true,
              registeredAt: new Date().toISOString()
            }
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const { electronApp, page } = await launchDesktopApp({
    env: { HOME: home },
    extraArgs: [`--user-data-dir=${userData}`]
  });

  try {
    // 1) Connect the real repository through the in-app dialog. Opening goes
    //    through IPC, so wait for the bound state instead of the section
    //    heading (which renders even while unbound).
    await page.locator('button:has-text("连接配置库")').click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "仓库路径" }).fill(repo);
    await dialog.getByRole("button", { name: "连接" }).click();
    const overview = page.locator('section[aria-label="Overview"]');
    await expect(overview).toContainText("配置库已连接");
    await expect(overview).toContainText("本机工具 1");

    // 2) The library shows the repository asset (HEAD, not a draft).
    await page.locator(".app-v2-nav").locator('button:has-text("配置库")').click();
    const library = page.locator('section[aria-label="配置库"]');
    await expect(library).toContainText("AGENTS.md");
    await expect(library).not.toContainText("未连接配置库");

    // 3) Pick the registered harness and preview.
    await library.getByRole("checkbox", { name: "选择 Codex" }).check();
    await library.locator('button:has-text("预览变更")').click();
    const preview = library.getByRole("group", { name: "变更预览" });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("将写入 1");

    // 4) Line-level diff before any write: the review gate the product promises.
    await preview.locator('button:has-text("查看差异")').first().click();
    const diff = library.getByRole("group", { name: "差异详情" });
    await expect(diff).toBeVisible();
    await expect(diff.locator(".app-v2-diff")).toBeVisible();
    // Nothing has been written at review time.
    await expect(readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).rejects.toThrow();

    // 5) Confirm: bytes land in the harness root and the result is reported.
    await library.locator('button:has-text("确认应用")').click();
    const outcome = library.getByRole("status", { name: "应用结果" });
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText("已应用 1");

    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# global from repo\n");

    // 6) Clearing a repository file must also work: the boundary used to
    //    reject an empty base64 payload, so "save an emptied file" failed in
    //    the app while the service happily wrote zero bytes.
    await library.locator("li", { hasText: "AGENTS.md" }).locator('button:has-text("编辑")').click();
    const editor = library.getByRole("group", { name: "编辑仓库文件" });
    await expect(editor).toBeVisible();
    await editor.getByRole("textbox", { name: "文件内容" }).fill("");
    await editor.locator('button:has-text("保存到工作树")').click();
    // Shell-level feedback is visible on every page (it used to render only
    // inside the changes page, so a library save looked like a no-op).
    await expect(page.locator(".app-v2-message")).toContainText("已保存");
    expect(await readFile(path.join(repo, "global", "instructions", "AGENTS.md"), "utf8")).toBe("");
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});
