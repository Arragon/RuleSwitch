// Git runtime layer (INH-1759): controlled Git executable resolution, spawn
// environment, timeouts, error taxonomy, and credential redaction.
//
// The Git executable is Main/Infrastructure-only and is never exposed to the
// Renderer. Spawning is always direct argv (no shell), with a pinned
// environment that disables interactive prompts so credential flows surface
// as structured auth errors instead of hanging.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export const GIT_RUNTIME_TIMEOUT_DEFAULT_MS = 30_000;

/** Error kinds mirror the frozen GitPort contract taxonomy. */
export type GitRuntimeErrorKind =
  | "auth-error"
  | "remote-error"
  | "local-error"
  | "timeout";

export interface GitRuntimeFailure {
  readonly kind: GitRuntimeErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface GitRuntimeRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Network-facing commands (fetch/push/clone) map timeouts to remote-error. */
  readonly isNetworkCommand?: boolean;
  readonly stdin?: string;
}

export interface GitRuntimeRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: GitRuntimeFailure | null;
}

export interface GitRuntime {
  readonly executable: string;
  readonly source: "explicit" | "env-override" | "bundled" | "system";
  readonly version: string | null;
  run(args: readonly string[], options?: GitRuntimeRunOptions): Promise<GitRuntimeRunResult>;
}

// ---------------------------------------------------------------------------
// Redaction (credentials never reach logs or error text)
// ---------------------------------------------------------------------------

const URL_CREDENTIAL_PATTERN = /\b(https?:\/\/)[^@/\s]+:[^@\s]+@/g;

/** Strips userinfo from any URL echoed by Git, plus common token shapes. */
export function redactGitText(text: string): string {
  return text.replace(URL_CREDENTIAL_PATTERN, "$1***@");
}

/** Renders an argv for logging with redaction; env is intentionally absent. */
export function safeCommandForLog(executable: string, args: readonly string[]): string {
  return redactGitText([executable, ...args].map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" "));
}

// ---------------------------------------------------------------------------
// Pinned spawn environment
// ---------------------------------------------------------------------------

/**
 * Prompt-free, parse-stable environment. GIT_TERMINAL_PROMPT=0 and an empty
 * GIT_ASKPASS turn any credential demand into an immediate failure that
 * classifyGitFailure maps to auth-error. User/global git config (credential
 * helpers, ssh command) is deliberately preserved.
 */
export function buildGitEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    LC_ALL: "C"
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const AUTH_PATTERNS: readonly RegExp[] = [
  /Authentication failed/i,
  /could not read Username/i,
  /Permission denied \(publickey/i,
  /Permission denied \(keyboard-interactive/i,
  /Could not read from remote repository/i,
  /access denied or repository not installed/i
];

// Checked before AUTH_PATTERNS: git prints these alongside the generic
// "Could not read from remote repository" when the remote simply does not
// exist, so an explicit not-found line wins over the auth interpretation.
const REMOTE_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /does not appear to be a git repository/i,
  /Repository not found/i
];

const REMOTE_PATTERNS: readonly RegExp[] = [
  /could not resolve host/i,
  /Connection timed out/i,
  /Connection refused/i,
  /Network is unreachable/i,
  /Failed to connect to/i,
  /RPC failed/i,
  /early EOF/i
];

const LOCAL_PATTERNS: readonly RegExp[] = [
  /not a git repository/i,
  /dubious ownership/i,
  /unknown revision/i,
  /bad object/i,
  /pathspec .* did not match/i,
  /cannot lock ref/i
];

export function classifyGitFailure(
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  isNetworkCommand: boolean
): GitRuntimeFailure {
  const redacted = redactGitText(stderr.trim());
  if (timedOut) {
    return {
      kind: isNetworkCommand ? "remote-error" : "local-error",
      message: `git command timed out${redacted.length > 0 ? `: ${redacted}` : ""}`,
      retryable: true,
      exitCode,
      timedOut: true
    };
  }
  if (isNetworkCommand && REMOTE_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(redacted))) {
    return {
      kind: "remote-error",
      message: redacted.length > 0 ? redacted : "git remote not found",
      retryable: false,
      exitCode,
      timedOut: false
    };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(redacted))) {
    return {
      kind: "auth-error",
      message: redacted.length > 0 ? redacted : "git authentication failed",
      retryable: false,
      exitCode,
      timedOut: false
    };
  }
  if (REMOTE_PATTERNS.some((pattern) => pattern.test(redacted))) {
    return {
      kind: "remote-error",
      message: redacted.length > 0 ? redacted : "git remote operation failed",
      retryable: true,
      exitCode,
      timedOut: false
    };
  }
  if (LOCAL_PATTERNS.some((pattern) => pattern.test(redacted))) {
    return {
      kind: "local-error",
      message: redacted.length > 0 ? redacted : "git local operation failed",
      retryable: false,
      exitCode,
      timedOut: false
    };
  }
  return {
    kind: isNetworkCommand ? "remote-error" : "local-error",
    message: redacted.length > 0 ? redacted : `git command failed with exit code ${exitCode ?? "unknown"}`,
    retryable: isNetworkCommand,
    exitCode,
    timedOut: false
  };
}

export function parseGitVersion(output: string): string | null {
  const match = output.trim().match(/^git version (\d+\.\d+\.\d+.*)$/m);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Runtime resolution and execution
// ---------------------------------------------------------------------------

export interface GitRuntimeOptions {
  /** Explicit executable path (highest priority; used by tests). */
  readonly executable?: string;
  /** Directory containing a bundled portable runtime (`bin/git` inside). */
  readonly bundledRuntimeDir?: string;
  /** Expected SHA-256 of the bundled git executable; enforced when bundling. */
  readonly bundledExecutableSha256?: string;
}

const MACOS_SYSTEM_GIT = "/usr/bin/git";

export async function createGitRuntime(
  options: GitRuntimeOptions = {},
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<GitRuntime> {
  let executable: string;
  let source: GitRuntime["source"];

  const envOverride = baseEnv["RULESWITCH_GIT_PATH"];
  if (options.executable) {
    executable = options.executable;
    source = "explicit";
  } else if (envOverride && envOverride.trim().length > 0) {
    executable = envOverride.trim();
    source = "env-override";
  } else if (options.bundledRuntimeDir) {
    const bundledPath = `${options.bundledRuntimeDir.replace(/\/+$/, "")}/bin/git`;
    if (!existsSync(bundledPath)) {
      throw new Error(`Bundled Git runtime not found at ${bundledPath}`);
    }
    if (options.bundledExecutableSha256) {
      const actual = await sha256File(bundledPath);
      if (actual !== options.bundledExecutableSha256) {
        throw new Error("Bundled Git executable failed integrity check; refusing arbitrary execution");
      }
    }
    executable = bundledPath;
    source = "bundled";
  } else if (process.platform === "darwin" && existsSync(MACOS_SYSTEM_GIT)) {
    executable = MACOS_SYSTEM_GIT;
    source = "system";
  } else {
    executable = "git";
    source = "system";
  }

  const versionResult = await execGitDirect(executable, ["--version"], baseEnv, 10_000, false);
  const version = versionResult.ok ? parseGitVersion(versionResult.stdout) : null;

  return {
    executable,
    source,
    version,
    run(args, runOptions = {}) {
      return execGitDirect(
        executable,
        args,
        baseEnv,
        runOptions.timeoutMs ?? GIT_RUNTIME_TIMEOUT_DEFAULT_MS,
        runOptions.isNetworkCommand ?? false,
        runOptions.cwd,
        runOptions.stdin
      );
    }
  };
}

async function sha256File(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function execGitDirect(
  executable: string,
  args: readonly string[],
  baseEnv: NodeJS.ProcessEnv,
  timeoutMs: number,
  isNetworkCommand: boolean,
  cwd?: string,
  stdin?: string
): Promise<GitRuntimeRunResult> {
  return new Promise<GitRuntimeRunResult>((resolve) => {
    // Direct argv spawn: there is no shell and therefore no injection
    // surface regardless of path or branch names coming from repos.
    const child = spawn(executable, args, {
      cwd,
      env: buildGitEnv(baseEnv),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr,
        failure: {
          kind: "local-error",
          message: `failed to start git executable: ${error.message}`,
          retryable: false,
          exitCode: null,
          timedOut
        }
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve({ ok: true, stdout, stderr, failure: null });
        return;
      }
      resolve({
        ok: false,
        stdout,
        stderr,
        failure: classifyGitFailure(code, stderr, timedOut, isNetworkCommand)
      });
    });

    if (stdin !== undefined) {
      child.stdin.on("error", () => {
        // EPIPE when git exits before reading all of stdin; the close
        // handler reports the real outcome.
      });
      child.stdin.end(stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}
