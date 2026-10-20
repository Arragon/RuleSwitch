import { describe, expect, it } from "vitest";

import {
  diagnoseCredentialReadiness,
  isHostKeyFailure,
  type SshAgentProbeResult
} from "../credential-diagnostics";
import type { GitRuntime } from "../git-runtime";

function fakeRuntime(configOutput: string, configOk: boolean): GitRuntime {
  return {
    executable: "/usr/bin/git",
    source: "explicit",
    version: "2.54.0",
    run: async () => ({
      ok: configOk,
      stdout: configOutput,
      stderr: configOk ? "" : "exit code 1",
      failure: configOk
        ? null
        : { kind: "local-error", message: "exit code 1", retryable: false, exitCode: 1, timedOut: false }
    })
  };
}

function probe(result: SshAgentProbeResult) {
  return async (): Promise<SshAgentProbeResult> => result;
}

describe("credential readiness diagnostics (INH-1763)", () => {
  it("reports configured helpers and a healthy agent with identities", async () => {
    const readiness = await diagnoseCredentialReadiness(
      fakeRuntime("osxkeychain\n", true),
      probe({ exitCode: 0, stderr: "", identityCount: 2 })
    );
    expect(readiness.https.helperConfigured).toBe(true);
    expect(readiness.https.helperNames).toEqual(["osxkeychain"]);
    expect(readiness.ssh.agentAvailable).toBe(true);
    expect(readiness.ssh.identityCount).toBe(2);
    expect(readiness.diagnostics).toEqual([]);
  }, 30_000);

  it("reports an agent with no identities and no helper with actionable diagnostics", async () => {
    const readiness = await diagnoseCredentialReadiness(
      fakeRuntime("", false),
      probe({ exitCode: 1, stderr: "The agent has no identities.", identityCount: null })
    );
    expect(readiness.https.helperConfigured).toBe(false);
    expect(readiness.ssh.agentAvailable).toBe(true);
    expect(readiness.ssh.identityCount).toBe(0);
    expect(readiness.diagnostics.join(" ")).toContain("no git credential helper");
    expect(readiness.diagnostics.join(" ")).toContain("no loaded identities");
  }, 30_000);

  it("classifies an unreachable agent and a missing ssh-add distinctly", async () => {
    const unreachable = await diagnoseCredentialReadiness(
      fakeRuntime("osxkeychain\n", true),
      probe({ exitCode: 2, stderr: "error connecting to agent: No such file or directory", identityCount: null })
    );
    expect(unreachable.ssh.agentAvailable).toBe(false);
    expect(unreachable.ssh.note).toContain("no reachable SSH agent");

    const missing = await diagnoseCredentialReadiness(
      fakeRuntime("osxkeychain\n", true),
      probe({ exitCode: null, stderr: "ssh-add could not be started", identityCount: null })
    );
    expect(missing.ssh.agentAvailable).toBe(false);
    expect(missing.ssh.note).toContain("not available on PATH");
  }, 30_000);

  it("never surfaces identity details, only counts", async () => {
    const readiness = await diagnoseCredentialReadiness(
      fakeRuntime("store\n", true),
      probe({ exitCode: 0, stderr: "", identityCount: 3 })
    );
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain("id_rsa");
    expect(serialized).not.toContain("ecdsa");
    expect(readiness.ssh.identityCount).toBe(3);
  }, 30_000);

  it("recognizes host-key verification failures", () => {
    expect(isHostKeyFailure("Host key verification failed.")).toBe(true);
    expect(isHostKeyFailure("fatal: Authentication failed")).toBe(false);
  });
});
