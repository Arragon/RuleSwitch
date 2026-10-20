import { describe, expect, it } from "vitest";

import {
  buildGitEnv,
  classifyGitFailure,
  parseGitVersion,
  redactGitText,
  safeCommandForLog,
  type GitRuntimeFailure
} from "../git-runtime";

function failure(overrides: Partial<GitRuntimeFailure> = {}): GitRuntimeFailure {
  return { kind: "local-error", message: "", retryable: false, exitCode: 1, timedOut: false, ...overrides };
}

describe("git spawn environment (INH-1759)", () => {
  it("disables interactive credential prompts for deterministic failures", () => {
    const env = buildGitEnv({ PATH: "/usr/bin" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("/bin/true");
    expect(env.LC_ALL).toBe("C");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("never passes credential-like variables through log output helpers", () => {
    const logged = safeCommandForLog("/usr/bin/git", [
      "clone",
      "--",
      "https://user:secret@example.com/repo.git",
      "/tmp/target"
    ]);
    expect(logged).not.toContain("secret");
    expect(logged).toContain("https://***@example.com/repo.git");
  });
});

describe("credential redaction", () => {
  it("strips userinfo from HTTPS URLs echoed by git", () => {
    expect(redactGitText("fatal: unable to access 'https://alice:tok123@github.com/x/y/'")).toBe(
      "fatal: unable to access 'https://***@github.com/x/y/'"
    );
    expect(redactGitText("http://bob:p@host/path")).toBe("http://***@host/path");
  });

  it("leaves plain URLs and text untouched", () => {
    expect(redactGitText("https://github.com/x/y")).toBe("https://github.com/x/y");
    expect(redactGitText("nothing to see")).toBe("nothing to see");
  });
});

describe("git error taxonomy mapping (INH-1759/1763)", () => {
  it("maps authentication failures to auth-error", () => {
    const auth = classifyGitFailure(128, "fatal: Authentication failed for 'https://github.com/x/y'", false, true);
    expect(auth.kind).toBe("auth-error");
    expect(auth.retryable).toBe(false);

    const publicKey = classifyGitFailure(255, "git@github.com: Permission denied (publickey).", false, true);
    expect(publicKey.kind).toBe("auth-error");

    const username = classifyGitFailure(128, "fatal: could not read Username for 'https://...': terminal prompts disabled", false, true);
    expect(username.kind).toBe("auth-error");
  });

  it("maps network problems to retryable remote-error", () => {
    const dns = classifyGitFailure(128, "fatal: unable to access 'https://x/': Could not resolve host: x", false, true);
    expect(dns.kind).toBe("remote-error");
    expect(dns.retryable).toBe(true);
  });

  it("classifies an explicitly missing remote as non-retryable remote-error", () => {
    const missing = classifyGitFailure(
      128,
      "fatal: '远端 bare.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
      false,
      true
    );
    expect(missing.kind).toBe("remote-error");
    expect(missing.retryable).toBe(false);
  });

  it("maps timeouts on network commands to retryable remote-error and local timeouts to local-error", () => {
    expect(classifyGitFailure(null, "", true, true).kind).toBe("remote-error");
    expect(classifyGitFailure(null, "", true, true).retryable).toBe(true);
    expect(classifyGitFailure(null, "", true, false).kind).toBe("local-error");
  });

  it("maps repository shape problems to local-error", () => {
    expect(classifyGitFailure(128, "fatal: not a git repository (or any of the parent directories): .git", false, false).kind).toBe("local-error");
    expect(classifyGitFailure(128, "fatal: detected dubious ownership in repository at '/x'", false, false).kind).toBe("local-error");
  });

  it("falls back to remote-error for unknown network failures and local-error otherwise", () => {
    expect(classifyGitFailure(1, "something odd", false, true).kind).toBe("remote-error");
    expect(classifyGitFailure(1, "something odd", false, false).kind).toBe("local-error");
  });

  it("redacts credentials inside classified messages", () => {
    const result = classifyGitFailure(128, "fatal: unable to access 'https://u:pw@h/x/': failed", false, true);
    expect(result.message).not.toContain("pw");
    expect(result.message).toContain("***");
  });
});

describe("git version parsing", () => {
  it("extracts the version from `git --version` output", () => {
    expect(parseGitVersion("git version 2.54.0\n")).toBe("2.54.0");
    expect(parseGitVersion("git version 2.39.5 (Apple Git-161)\n")).toBe("2.39.5 (Apple Git-161)");
    expect(parseGitVersion("random output")).toBeNull();
  });
});

describe("runtime failure normalization", () => {
  it("keeps a stable shape for spawn errors", () => {
    const f = failure({ kind: "remote-error", message: "x", retryable: true, exitCode: null, timedOut: true });
    expect(f.kind).toBe("remote-error");
    expect(f.timedOut).toBe(true);
  });
});
