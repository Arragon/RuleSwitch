// macOS Git credential readiness diagnostics (INH-1763).
//
// RuleSwitch never stores credentials and never builds its own token
// database. This module only probes the standard ecosystem read-only and
// reports facts safe for UI display:
//
// - Which git credential helpers are configured (names only).
// - Whether an SSH agent is reachable and how many identities it lists
//   (counts only — identity file paths and key comments are discarded).
// - Host-key verification failures are recognized distinctly in errors.
//
// Nothing here writes to ~/.ssh/config, the Keychain, or any helper. The
// Keychain write path for RuleSwitch-owned secret references is M5
// (INH-1798) and stays out of this boundary.

import type { GitRuntime } from "./git-runtime";

export interface SshAgentProbeResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  /** Number of listed identities when the agent answered, else null. */
  readonly identityCount: number | null;
}

export type SshAgentProbe = () => Promise<SshAgentProbeResult>;

export interface SshAgentStatus {
  readonly agentAvailable: boolean;
  readonly identityCount: number | null;
  readonly note: string | null;
}

export interface HttpsCredentialStatus {
  readonly helperConfigured: boolean;
  readonly helperNames: readonly string[];
}

export interface CredentialReadiness {
  readonly ssh: SshAgentStatus;
  readonly https: HttpsCredentialStatus;
  readonly diagnostics: readonly string[];
}

/** Default probe: `ssh-add -l` via direct argv (no shell, no prompts). */
export const defaultSshAgentProbe: SshAgentProbe = () =>
  import("node:child_process").then(({ spawn }) => {
    return new Promise<SshAgentProbeResult>((resolve) => {
      const child = spawn("ssh-add", ["-l"], {
        env: { ...process.env, SSH_ASKPASS: "/bin/true", SSH_ASKPASS_REQUIRE: "never" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", () => {
        resolve({ exitCode: null, stderr: "ssh-add could not be started", identityCount: null });
      });
      child.on("close", (code) => {
        const identityCount =
          code === 0
            ? stdout
                .split("\n")
                .filter((line) => line.trim().length > 0).length
            : null;
        resolve({ exitCode: code, stderr, identityCount });
      });
    });
  });

function sshStatusFrom(result: SshAgentProbeResult): SshAgentStatus {
  if (result.exitCode === null) {
    return { agentAvailable: false, identityCount: null, note: "ssh-add is not available on PATH" };
  }
  if (result.exitCode === 0) {
    return { agentAvailable: true, identityCount: result.identityCount, note: null };
  }
  if (result.exitCode === 1 && /no identities/i.test(result.stderr)) {
    return { agentAvailable: true, identityCount: 0, note: "agent reachable, no identities loaded" };
  }
  if (result.exitCode === 2 || /error connecting to agent|could not (open|connect)/i.test(result.stderr)) {
    return { agentAvailable: false, identityCount: null, note: "no reachable SSH agent" };
  }
  return { agentAvailable: false, identityCount: null, note: "ssh agent probe failed" };
}

/** Collects credential readiness facts without touching any secret value. */
export async function diagnoseCredentialReadiness(
  gitRuntime: GitRuntime,
  sshProbe: SshAgentProbe = defaultSshAgentProbe
): Promise<CredentialReadiness> {
  const diagnostics: string[] = [];

  const home = process.env.HOME;
  const helperRun =
    home === undefined
      ? { ok: false, stdout: "" }
      : await gitRuntime.run(["config", "--get-all", "credential.helper"], { cwd: home });
  const helperNames = helperRun.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const https: HttpsCredentialStatus = {
    helperConfigured: helperRun.ok && helperNames.length > 0,
    helperNames
  };
  if (!https.helperConfigured) {
    diagnostics.push("no git credential helper configured; HTTPS private remotes will fail authentication");
  }

  const ssh = sshStatusFrom(await sshProbe());
  if (!ssh.agentAvailable) {
    diagnostics.push(`SSH agent unavailable (${ssh.note ?? "unknown"}); SSH remotes using agent keys will fail`);
  } else if (ssh.identityCount === 0) {
    diagnostics.push("SSH agent has no loaded identities");
  }

  return { ssh, https, diagnostics };
}

/** Host-key failures are recognized distinctly inside auth diagnostics. */
export function isHostKeyFailure(gitStderr: string): boolean {
  return /Host key verification failed/i.test(gitStderr);
}
