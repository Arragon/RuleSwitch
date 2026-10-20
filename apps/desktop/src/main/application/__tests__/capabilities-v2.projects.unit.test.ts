// INH-1855 / INH-1809: project binding and manifest validation.
//
// These cover the honest-reporting contract: a directory that cannot be
// validated is refused, and a remote identity that cannot be proven is
// reported `unknown` rather than `matched`.

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

const temporaryRoots: string[] = [];
const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-proj-"));
  temporaryRoots.push(root);
  return root;
}

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
  await mkdir(path.join(repo, "projects", "prj_demo"), { recursive: true });
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
  return { root, repo, service };
}

describe("CapabilityServiceV2 project binding (INH-1855)", () => {
  it("validates the manifest and reports asset/project counts", async () => {
    const { repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);

    const validation = await service.validateRepository();
    expect(validation).toMatchObject({
      ok: true,
      schemaVersion: 1,
      assetCount: 1,
      profileCount: 0
    });
  }, 90_000);

  it("refuses binding without an open repository", async () => {
    const { root, service } = await createService();
    const directory = path.join(root, "somewhere");
    await mkdir(directory, { recursive: true });

    const outcome = await service.bindProject({
      projectId: "prj_demo",
      displayName: "Demo",
      localPath: directory
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/no repository is open/);
  }, 90_000);

  it("refuses a missing directory and does not record a binding", async () => {
    const { root, repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);

    const outcome = await service.bindProject({
      projectId: "prj_demo",
      displayName: "Demo",
      localPath: path.join(root, "does-not-exist")
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/missing or not readable/);
    expect(await service.listProjects()).toHaveLength(0);
  }, 90_000);

  it("binds a valid directory and reports remote identity as unknown when unprovable", async () => {
    const { root, repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);
    const directory = path.join(root, "工作 项目");
    await mkdir(directory, { recursive: true });

    const outcome = await service.bindProject({
      projectId: "prj_demo",
      displayName: "Demo 项目",
      localPath: directory
    });
    expect(outcome.ok).toBe(true);
    // No origin and no declared pattern: unprovable, never "matched".
    expect(outcome.remoteVerified).toBe("unknown");
    expect(outcome.diagnostic).toMatch(/could not be verified/);

    const projects = await service.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      projectId: "prj_demo",
      displayName: "Demo 项目",
      localPathPresent: true,
      available: true,
      remoteVerified: "unknown"
    });
  }, 90_000);

  it("rejects a second project claiming the same directory", async () => {
    const { root, repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);
    const directory = path.join(root, "shared");
    await mkdir(directory, { recursive: true });

    await service.bindProject({ projectId: "prj_a", displayName: "A", localPath: directory });
    const second = await service.bindProject({
      projectId: "prj_b",
      displayName: "B",
      localPath: directory
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already bound to project prj_a/);
  }, 90_000);

  it("requires an explicit rebind to move a project to another directory", async () => {
    const { root, repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    await service.bindProject({ projectId: "prj_demo", displayName: "Demo", localPath: first });

    const refused = await service.bindProject({
      projectId: "prj_demo",
      displayName: "Demo",
      localPath: second
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/confirm rebinding/);

    const accepted = await service.bindProject({
      projectId: "prj_demo",
      displayName: "Demo",
      localPath: second,
      rebind: true
    });
    expect(accepted.ok).toBe(true);
  }, 90_000);

  it("unbinds without touching repository content", async () => {
    const { root, repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);
    const directory = path.join(root, "project");
    await mkdir(directory, { recursive: true });
    await service.bindProject({ projectId: "prj_demo", displayName: "Demo", localPath: directory });

    expect(await service.unbindProject("prj_demo")).toBe(true);
    expect(await service.listProjects()).toHaveLength(0);
    expect(await service.unbindProject("prj_demo")).toBe(false);
    // Config content is untouched by a local unbind.
    expect((await service.browseLibrary())?.entries).toHaveLength(1);
  }, 90_000);

  it("refuses to clone into an existing directory", async () => {
    const { root, service } = await createService();
    const existing = path.join(root, "already-there");
    await mkdir(existing, { recursive: true });

    const outcome = await service.cloneRepository("file:///tmp/nowhere.git", existing);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/already exists/);
  }, 90_000);

  it("reports a clone failure instead of opening a half-built repository", async () => {
    const { root, service } = await createService();
    const target = path.join(root, "clone-target");

    const outcome = await service.cloneRepository(
      `file://${path.join(root, "missing-remote.git")}`,
      target
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).not.toBeNull();
    // Nothing was opened, so repository status stays null.
    expect(await service.repositoryStatus()).toBeNull();
  }, 90_000);

  it("clones a real repository and opens it with the manifest detected", async () => {
    const { root, repo, service } = await createService();
    const target = path.join(root, "cloned-config");

    const outcome = await service.cloneRepository(`file://${repo}`, target);
    expect(outcome.ok).toBe(true);
    expect(outcome.manifestPresent).toBe(true);
    const status = await service.repositoryStatus();
    expect(status?.repositoryBound).toBe(true);
  }, 90_000);
});
