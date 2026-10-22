// Business-level UI E2E (INH-1857): the real Electron app against a real Git
// repository and a real harness directory, driven only through the UI.
//
// Why this exists: the shell E2E proves navigation and accessibility but never
// proves that a user can actually get bytes from the repository onto a harness
// — or that the app refuses to write when the plan no longer matches reality.
// These specs cover both directions.
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

import { expect, test, type Page } from "@playwright/test";

import { launchDesktopApp } from "./launcher";

const run = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await run("/usr/bin/git", args, { cwd });
}

interface SeededEnvironment {
  readonly root: string;
  readonly home: string;
  readonly userData: string;
  readonly repo: string;
}

async function seedEnvironment(): Promise<SeededEnvironment> {
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
  return { root, home, userData, repo };
}

async function connectRepository(page: Page, repo: string): Promise<void> {
  await page.locator('button:has-text("连接配置库")').click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "仓库路径" }).fill(repo);
  await dialog.getByRole("button", { name: "连接" }).click();
  const overview = page.locator('section[aria-label="Overview"]');
  await expect(overview).toContainText("配置库已连接");
  await expect(overview).toContainText("本机工具 1");
}

async function openLibrary(page: Page) {
  await page.locator(".app-v2-nav").locator('button:has-text("配置库")').click();
  const library = page.locator('section[aria-label="配置库"]');
  await expect(library).toContainText("AGENTS.md");
  return library;
}

async function editAsset(page: Page, content: string): Promise<void> {
  const library = page.locator('section[aria-label="配置库"]');
  await library.locator("li", { hasText: "AGENTS.md" }).locator('button:has-text("编辑")').click();
  const editor = library.getByRole("group", { name: "编辑仓库文件" });
  await expect(editor).toBeVisible();
  await editor.getByRole("textbox", { name: "文件内容" }).fill(content);
  await editor.locator('button:has-text("保存到工作树")').click();
  await expect(page.locator(".app-v2-message")).toContainText("已保存");
}

async function previewForCodex(library: ReturnType<Page["locator"]>) {
  await library.getByRole("checkbox", { name: "选择 Codex" }).check();
  await library.locator('button:has-text("预览变更")').click();
  const preview = library.getByRole("group", { name: "变更预览" });
  await expect(preview).toBeVisible();
  return preview;
}

test("applies a repository asset to a registered harness through preview, diff and confirm", async () => {
  const env = await seedEnvironment();
  const { electronApp, page } = await launchDesktopApp({
    env: { HOME: env.home },
    extraArgs: [`--user-data-dir=${env.userData}`]
  });

  try {
    await connectRepository(page, env.repo);
    const library = await openLibrary(page);
    await expect(library).not.toContainText("未连接配置库");

    const preview = await previewForCodex(library);
    await expect(preview).toContainText("将写入 1");

    // Line-level diff before any write: the review gate the product promises.
    await preview.locator('button:has-text("查看差异")').first().click();
    const diff = library.getByRole("group", { name: "差异详情" });
    await expect(diff).toBeVisible();
    await expect(diff.locator(".app-v2-diff")).toBeVisible();
    // Nothing has been written at review time.
    await expect(readFile(path.join(env.home, ".codex", "AGENTS.md"), "utf8")).rejects.toThrow();

    await library.locator('button:has-text("确认应用")').click();
    const outcome = library.getByRole("status", { name: "应用结果" });
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText("已应用 1");

    expect(await readFile(path.join(env.home, ".codex", "AGENTS.md"), "utf8")).toBe("# global from repo\n");

    // Clearing a repository file must also work: the boundary used to reject
    // an empty base64 payload, so "save an emptied file" failed in the app
    // while the service happily wrote zero bytes.
    await editAsset(page, "");
    expect(await readFile(path.join(env.repo, "global", "instructions", "AGENTS.md"), "utf8")).toBe("");
  } finally {
    await electronApp.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("refuses to apply a plan whose preview is stale after an edit", async () => {
  const env = await seedEnvironment();
  const { electronApp, page } = await launchDesktopApp({
    env: { HOME: env.home },
    extraArgs: [`--user-data-dir=${env.userData}`]
  });

  try {
    await connectRepository(page, env.repo);
    const library = await openLibrary(page);

    const preview = await previewForCodex(library);
    await expect(preview).toContainText("将写入 1");

    // Editing the source after the preview changes every digest in the plan;
    // confirming must therefore be refused instead of writing from old bytes.
    await editAsset(page, "# draft v2\n");
    await library.locator('button:has-text("确认应用")').click();
    await expect(page.locator(".app-v2-error")).toContainText("预览已过期");
    // The preview is cleared and nothing was written.
    await expect(library.getByRole("group", { name: "变更预览" })).toHaveCount(0);
    await expect(readFile(path.join(env.home, ".codex", "AGENTS.md"), "utf8")).rejects.toThrow();

    // A fresh preview of the current bytes applies the draft as-is.
    const fresh = await previewForCodex(library);
    await expect(fresh).toContainText("将写入 1");
    await library.locator('button:has-text("确认应用")').click();
    await expect(library.getByRole("status", { name: "应用结果" })).toContainText("已应用 1");
    expect(await readFile(path.join(env.home, ".codex", "AGENTS.md"), "utf8")).toBe("# draft v2\n");
  } finally {
    await electronApp.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("refuses to apply over a target the user changed after the preview", async () => {
  const env = await seedEnvironment();
  const { electronApp, page } = await launchDesktopApp({
    env: { HOME: env.home },
    extraArgs: [`--user-data-dir=${env.userData}`]
  });

  try {
    await connectRepository(page, env.repo);
    const library = await openLibrary(page);

    // First apply establishes ownership: baseline bytes are recorded.
    await previewForCodex(library);
    await library.locator('button:has-text("确认应用")').click();
    await expect(library.getByRole("status", { name: "应用结果" })).toContainText("已应用 1");
    expect(await readFile(path.join(env.home, ".codex", "AGENTS.md"), "utf8")).toBe("# global from repo\n");

    // New repository revision so the plan is not a noop.
    await editAsset(page, "# repo v2\n");
    const preview = await previewForCodex(library);
    await expect(preview).toContainText("将写入 1");

    // The user edits the harness copy between preview and confirm. The apply
    // must refuse (drift), never overwrite a change it did not write.
    await writeFile(path.join(env.home, ".codex", "AGENTS.md"), "# user edit\n", "utf8");
    await library.locator('button:has-text("确认应用")').click();

    const outcome = library.getByRole("status", { name: "应用结果" });
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText("失败 1");
    await expect(outcome).toContainText("已应用 0");
    expect(await readFile(path.join(env.home, ".codex", "AGENTS.md"), "utf8")).toBe("# user edit\n");
  } finally {
    await electronApp.close();
    await rm(env.root, { recursive: true, force: true });
  }
});
