// Shared M3 integration environment: a real git config repo (seeded from
// the canonical full-matrix fixture) with a bare remote, plus isolated
// fake HOME / project directories for the Claude Code and Codex slices.

import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createGitRuntime } from "../../../apps/desktop/src/main/infrastructure/git/git-runtime";
import { GitPortAdapter } from "../../../apps/desktop/src/main/infrastructure/git/git-port-adapter";
import { RepositoryIdentityStore } from "../../../apps/desktop/src/main/infrastructure/git/identity-store";
import { createFsRepoFileSource } from "../../../apps/desktop/src/main/infrastructure/git/repo-source";

const exec = promisify(execFile);

export interface M3Environment {
  readonly root: string;
  readonly bareRemotePath: string;
  readonly repoPath: string;
  readonly homeRoot: string;
  readonly claudeRoot: string;
  readonly codexRoot: string;
  readonly projectA: string;
  readonly projectB: string;
  makeAdapter(): Promise<GitPortAdapter>;
}

export async function createM3Environment(): Promise<M3Environment> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-m3-"));
  const bareRemotePath = path.join(root, "config-bare.git");
  const repoPath = path.join(root, "配置 repo");
  const homeRoot = path.join(root, "隔离 home");
  const projectA = path.join(root, "项目 A");
  const projectB = path.join(root, "项目B");

  await exec("/usr/bin/git", ["init", "--bare", "-q", "--initial-branch=main", bareRemotePath]);
  await cp(path.join(__dirname, "..", "..", "fixtures", "v1-repos", "full-matrix"), repoPath, { recursive: true });
  await exec("/usr/bin/git", ["-C", repoPath, "init", "-q", "-b", "main"]);
  await exec("/usr/bin/git", ["-C", repoPath, "config", "user.name", "M3 Test"]);
  await exec("/usr/bin/git", ["-C", repoPath, "config", "user.email", "m3@ruleswitch.invalid"]);
  await exec("/usr/bin/git", ["-C", repoPath, "add", "."]);
  await exec("/usr/bin/git", ["-C", repoPath, "commit", "-q", "-m", "seed full-matrix fixture"]);
  await exec("/usr/bin/git", ["-C", repoPath, "remote", "add", "origin", bareRemotePath]);
  await exec("/usr/bin/git", ["-C", repoPath, "push", "-q", "-u", "origin", "main"]);

  await mkdir(homeRoot, { recursive: true });
  await mkdir(path.join(homeRoot, ".claude"), { recursive: true });
  await mkdir(path.join(homeRoot, ".codex"), { recursive: true });
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  return {
    root,
    bareRemotePath,
    repoPath,
    homeRoot,
    claudeRoot: path.join(homeRoot, ".claude"),
    codexRoot: path.join(homeRoot, ".codex"),
    projectA,
    projectB,
    makeAdapter: async () => {
      const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
      const identityStore = new RepositoryIdentityStore(path.join(root, "state", "v1.json"));
      await identityStore.load();
      const adapter = new GitPortAdapter({ gitRuntime: runtime, identityStore });
      const opened = await adapter.open({ localPath: repoPath });
      if (!opened.ok || opened.value === null) {
        throw new Error(opened.error?.message ?? "repo open failed");
      }
      return adapter;
    }
  };
}

export async function disposeM3Environment(environment: M3Environment): Promise<void> {
  await rm(environment.root, { recursive: true, force: true });
}

export function repoFileSourceOf(environment: M3Environment) {
  return createFsRepoFileSource(environment.repoPath);
}
