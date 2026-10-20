// Shared Electron launcher for every Playwright E2E spec.
//
// Why this exists: the specs previously each built their own `electron.launch`
// call, and only one of them honoured `RULESWITCH_E2E_ELECTRON`. That made the
// two suites behave differently under restricted runners (containers, CI
// sandboxes, nested sandboxes) where Chromium's own process sandbox cannot
// initialise. A single launcher keeps the launch contract identical and makes
// the environment escape hatches explicit:
//
//   RULESWITCH_E2E_ELECTRON       override the Electron executable
//   RULESWITCH_E2E_ELECTRON_ARGS  extra flags, e.g. "--no-sandbox --disable-gpu"
//
// `ELECTRON_RUN_AS_NODE` is always stripped: when a parent process exports it,
// Electron runs as plain Node and the ESM main entry fails on the first
// `import ... from "electron"`.

import path from "node:path";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export interface DesktopLaunchOptions {
  /** Extra flags placed before the application path. */
  readonly extraArgs?: readonly string[];
  /** Additional environment variables for the launched process. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface LaunchedDesktop {
  readonly electronApp: ElectronApplication;
  readonly page: Page;
}

export async function launchDesktopApp(
  options: DesktopLaunchOptions = {}
): Promise<LaunchedDesktop> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    environment[key] = value;
  }

  const extraFlags = (process.env.RULESWITCH_E2E_ELECTRON_ARGS ?? "")
    .split(/\s+/)
    .filter((flag) => flag.length > 0);
  const executablePath = process.env.RULESWITCH_E2E_ELECTRON;

  const electronApp = await electron.launch({
    ...(executablePath !== undefined && executablePath.length > 0 ? { executablePath } : {}),
    args: [...extraFlags, ...(options.extraArgs ?? []), path.join(repositoryRoot, "apps", "desktop")],
    cwd: repositoryRoot,
    env: environment
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { electronApp, page };
}
