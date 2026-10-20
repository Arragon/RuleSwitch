import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CapabilityServiceV2 } from "../../application/capabilities-v2";
import { GitPortAdapter } from "../../infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../infrastructure/git/git-runtime";
import { ProjectsStore, SettingsStore } from "../../infrastructure/git/binding-store";
import { OperationsStore } from "../../infrastructure/git/sync-state";
import { RepositoryIdentityStore } from "../../infrastructure/git/identity-store";
import { assertV2Surface } from "@ruleswitch/core";

const temporaryRoots: string[] = [];
const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-capv2-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createService() {
  const root = await temporaryDirectory();
  const bare = path.join(root, "bare.git");
  const repo = path.join(root, "配置 repo");
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  await runtime.run(["init", "--bare", "-q", "--initial-branch=main", bare], { cwd: root });
  await runtime.run(["clone", "-q", bare, repo], { cwd: root });
  await runtime.run(["config", "user.name", "T"], { cwd: repo });
  await runtime.run(["config", "user.email", "t@t"], { cwd: repo });
  await mkdir(path.join(repo, "global", "instructions"), { recursive: true });
  await writeFile(path.join(repo, "ruleswitch.yaml"), "schemaVersion: 1\n", "utf8");
  await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), "# global\n", "utf8");
  await runtime.run(["add", "."], { cwd: repo });
  await runtime.run(["commit", "-q", "-m", "seed"], { cwd: repo });
  await runtime.run(["push", "-q", "-u", "origin", "main"], { cwd: repo });

  const identityStore = new RepositoryIdentityStore(path.join(root, "state", "identity.json"));
  await identityStore.load();
  const gitPort = new GitPortAdapter({ gitRuntime: runtime, identityStore });
  const projectsStore = new ProjectsStore(path.join(root, "state", "projects.json"));
  await projectsStore.load();
  const settingsStore = new SettingsStore(path.join(root, "state", "settings.json"));
  await settingsStore.load();
  const operationsStore = new OperationsStore(path.join(root, "state", "operations.json"));
  await operationsStore.load();
  const service = new CapabilityServiceV2({
    gitPort,
    projectsStore,
    settingsStore,
    operationsStore,
    hasher
  });
  return { root, repo, service, projectsStore, settingsStore };
}

describe("CapabilityServiceV2 (M7)", () => {
  it("exposes exactly the frozen v2 surface", () => {
    const methods: Record<string, unknown> = {
      openRepositoryFromDirectory: () => undefined,
      repositoryStatus: () => undefined,
      validateRepository: () => undefined,
      bindProject: () => undefined,
      unbindProject: () => undefined,
      browseLibrary: () => undefined,
      readRepoFile: () => undefined,
      editRepoFile: () => undefined,
      deleteRepoAsset: () => undefined,
      gitArea: () => undefined,
      setCompare: () => undefined,
      stagePaths: () => undefined,
      unstagePaths: () => undefined,
      commit: () => undefined,
      push: () => undefined,
      fetchRemote: () => undefined,
      fastForward: () => undefined,
      logPage: () => undefined,
      listProjects: () => undefined,
      listHarnesses: () => undefined,
      operationHistory: () => undefined,
      getSettings: () => undefined,
      setTheme: () => undefined,
      previewApply: () => undefined,
      applyToHarnesses: () => undefined
    };
    expect(assertV2Surface(methods as never)).toEqual([]);
    expect(assertV2Surface({} as never).length).toBe(25);
  });

  it("opens a repository and shapes the library read model with draft markers", async () => {
    const { repo, service } = await createService();
    const overview = await service.openRepositoryFromDirectory(repo);
    expect(overview).toMatchObject({ repositoryBound: true, workingTree: "clean" });

    const library = await service.browseLibrary();
    expect(library).not.toBeNull();
    expect(library?.entries).toHaveLength(1); // AGENTS.md (manifest is not an asset)
    expect(library?.entries.every((entry) => entry.state === "head")).toBe(true);

    // A working-tree edit becomes a draft in the read model.
    await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), "# edited\n", "utf8");
    const draftLibrary = await service.browseLibrary();
    expect(draftLibrary?.draftCount).toBe(1);
    expect(draftLibrary?.entries.find((entry) => entry.state === "draft")?.logicalName).toBe("AGENTS.md");
  }, 90_000);

  it("shapes the git area with managed/unmanaged split and settings persist theme", async () => {
    const { repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);
    await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), "# edited\n", "utf8");
    await writeFile(path.join(repo, "个人笔记.md"), "unmanaged\n", "utf8");

    const gitArea = await service.gitArea();
    expect(gitArea?.changes.some((change) => change.managed && change.logicalPath === "global/instructions/AGENTS.md")).toBe(true);
    expect(gitArea?.changes.some((change) => !change.managed && change.logicalPath === "个人笔记.md")).toBe(true);

    const themed = await service.setTheme("dark");
    expect(themed.theme).toBe("dark");
    expect((await service.getSettings()).theme).toBe("dark");
  }, 90_000);

  it("refuses non-repository directories with null instead of paths", async () => {
    const root = await temporaryDirectory();
    const { service } = await createService();
    const result = await service.openRepositoryFromDirectory(path.join(root, "not-a-repo-xyz"));
    expect(result).toBeNull();
  }, 90_000);
});
