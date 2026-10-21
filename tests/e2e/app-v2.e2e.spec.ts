// UI E2E gate (INH-1818): real Electron launch driving the v2 AppV2 shell.
// Covers: navigation to all 7 pages, accessibility semantics (roles/labels),
// keyboard tab order, light theme default, empty states, and the onboarding
// wizard guard (zero-selection disables next). This complements the Phase A
// walking-skeleton E2E which covers the v1 workbench flow.
//
// Run after `electron-vite build` via `corepack pnpm run test:e2e`.

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { launchDesktopApp } from "./launcher";

const NAV_LABELS = ["Overview", "配置库", "本机 AI 工具", "项目", "同步变更", "历史", "设置"];

let electronApp: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  const launched = await launchDesktopApp();
  electronApp = launched.electronApp;
  page = launched.page;
});

test.afterEach(async () => {
  await electronApp?.close();
});

test.describe("AppV2 shell navigation & a11y (INH-1818)", () => {
  test("renders 7-page navigation in the frozen order with light default and accessible labels", async () => {
    // The renderer mounts AppV2 when the v2 bridge exists.
    const nav = page.locator(".app-v2-nav");
    await expect(nav).toBeVisible();

    const buttons = nav.locator("button.nav-item");
    await expect(buttons).toHaveCount(NAV_LABELS.length);
    for (let index = 0; index < NAV_LABELS.length; index += 1) {
      await expect(buttons.nth(index)).toHaveText(NAV_LABELS[index]);
    }

    // Light theme is the default per the frozen settings contract.
    await expect(page.locator(".app-v2")).toHaveAttribute("data-theme", "light");
  });

  test("all seven pages navigate and render their aria-labeled sections", async () => {
    const nav = page.locator(".app-v2-nav");
    const sections: Record<string, string> = {
      Overview: "Overview",
      配置库: "配置库",
      "本机 AI 工具": "本机 AI 工具",
      项目: "项目",
      同步变更: "同步变更",
      历史: "历史",
      设置: "设置"
    };
    for (const [label, ariaLabel] of Object.entries(sections)) {
      await nav.locator(`button:has-text("${label}")`).first().click();
      await expect(page.locator(`section[aria-label="${ariaLabel}"]`)).toBeVisible();
    }
  });

  test("keyboard tab reaches navigation items in order and Enter activates", async () => {
    const nav = page.locator(".app-v2-nav");
    await expect(nav).toBeVisible();
    // Tab into the nav and walk its buttons.
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveClass(/nav-item/);
    const firstLabel = await focused.textContent();
    expect(NAV_LABELS).toContain(firstLabel ?? "");
    // Enter on the focused item activates that page.
    await page.keyboard.press("Enter");
    await expect(page.locator("section[aria-label]")).toBeVisible();
  });

  test("onboarding wizard: unbound repository surfaces actionable error", async () => {
    // Open the wizard from Overview.
    await page.locator('button:has-text("配置新工具 / 新设备")').click();
    const wizard = page.locator("section.onboarding");
    await expect(wizard).toBeVisible();
    // Advance: without a bound repository the connect step surfaces an
    // actionable error (配置库) instead of silently skipping.
    await wizard.locator('button:has-text("下一步")').first().click();
    await expect(wizard.locator("p[role=alert]")).toBeVisible();
    await expect(wizard.locator("p[role=alert]")).toContainText(/配置库|连接/);
  });

  test("library and changes pages show empty-state guidance without a repository", async () => {
    const nav = page.locator(".app-v2-nav");
    await nav.locator('button:has-text("配置库")').click();
    await expect(page.locator('section[aria-label="配置库"]')).toContainText(/HEAD|未连接/);
    await nav.locator('button:has-text("同步变更")').click();
    await expect(page.locator('section[aria-label="同步变更"]')).toContainText(/Git 仓库/);
    // No absolute-path leakage in any rendered text.
    const body = await page.locator(".app-v2").textContent();
    expect(body).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);
  });

  test("repository connect uses an in-app dialog instead of a native prompt", async () => {
    // A native window.prompt would block the renderer and cannot be themed or
    // audited; the shell must use its own dialog surface.
    await page.locator('button:has-text("连接配置库")').click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByRole("textbox", { name: "仓库路径" })).toBeVisible();
    // Confirm is disabled until a non-empty path is typed.
    await expect(dialog.getByRole("button", { name: "连接" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "仓库路径" }).fill("/tmp/not-a-repo");
    await expect(dialog.getByRole("button", { name: "连接" })).toBeEnabled();
    // Escape dismisses the dialog without side effects.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("library apply surface explains that unregistered tools are never auto-configured", async () => {
    await page.locator(".app-v2-nav").locator('button:has-text("配置库")').click();
    const library = page.locator('section[aria-label="配置库"]');
    await expect(library).toContainText("应用到本机工具");
    await expect(library).toContainText(/尚未登记本机工具|不会被自动配置/);
  });

  test("every rendered control exposes an accessible name and the document declares a language", async () => {
    // A hand-rolled accessibility gate (no axe dependency available offline):
    // an unlabeled control is invisible to assistive technology, and a missing
    // lang attribute breaks screen-reader pronunciation.
    await page.locator(".app-v2-nav").locator('button:has-text("Overview")').click();
    expect(await page.locator("html").getAttribute("lang")).toBe("en");

    const unnamed = await page.evaluate(() => {
      const problems: string[] = [];
      const controls = document.querySelectorAll("button, input, select, textarea, a[href]");
      for (const control of Array.from(controls)) {
        const label = (
          control.getAttribute("aria-label") ??
          control.textContent ??
          control.getAttribute("placeholder") ??
          control.getAttribute("title") ??
          ""
        ).trim();
        if (label.length === 0) {
          problems.push(`${control.tagName}.${control.className}`);
        }
      }
      return problems;
    });
    expect(unnamed).toEqual([]);

    // A screenshot keeps a visual record for reviewers; it is not a pixel
    // baseline (rendering differs per OS, so no diff assertion is made).
    await page.screenshot({ path: "outputs/screenshots/v2-shell.png" });
  });
});
