// INH-1852 / INH-1814: apply-to-harness target resolution, per-kind plan
// entries, and first-adoption safety. These cover the behaviours that the
// previous implementation hardcoded away (kind: "skills", adoption: always
// confirmed, all registered harnesses at global scope).

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-apply-"));
  temporaryRoots.push(root);
  return root;
}

interface HarnessRegistration {
  harnessInstanceId: string;
  adapterId: string;
  displayName: string;
  installed: boolean;
}

async function createService(registrations: readonly HarnessRegistration[] = []) {
  const root = await temporaryDirectory();
  const bare = path.join(root, "bare.git");
  const repo = path.join(root, "配置 repo");
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  await runtime.run(["init", "--bare", "-q", "--initial-branch=main", bare], { cwd: root });
  await runtime.run(["clone", "-q", bare, repo], { cwd: root });
  await runtime.run(["config", "user.name", "T"], { cwd: repo });
  await runtime.run(["config", "user.email", "t@t"], { cwd: repo });
  await mkdir(path.join(repo, "global", "instructions"), { recursive: true });
  await mkdir(path.join(repo, "global", "skills", "review"), { recursive: true });
  await writeFile(path.join(repo, "ruleswitch.yaml"), "schemaVersion: 1\n", "utf8");
  await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), "# global\n", "utf8");
  await writeFile(path.join(repo, "global", "skills", "review", "SKILL.md"), "# review skill\n", "utf8");
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

  // A private HOME per test so harness roots never touch the real machine.
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;

  const service = new CapabilityServiceV2({
    gitPort,
    projectsStore,
    settingsStore,
    operationsStore,
    harnessRegistry: { listRegistrations: () => registrations },
    hasher
  });
  return { root, repo, home, service, projectsStore };
}

const codexRegistration: HarnessRegistration = {
  harnessInstanceId: "harn_codex",
  adapterId: "codex",
  displayName: "Codex",
  installed: true
};

describe("CapabilityServiceV2.applyToHarnesses (INH-1852)", () => {
  it("writes an absent target from repository bytes and reports a committed entry", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const outcome = await service.applyToHarnesses({
      assets: [
        {
          assetKey: "asset_agents",
          kind: "instructions",
          logicalName: "AGENTS.md",
          content: new Uint8Array()
        }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    expect(outcome.appliedCount).toBe(1);
    expect(outcome.entries[0]).toMatchObject({
      harnessInstanceId: "harn_codex",
      adapterId: "codex",
      assetKind: "instructions",
      state: "COMMITTED"
    });
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# global\n");
  }, 90_000);

  it("plans one entry per asset kind instead of assuming skills", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const outcome = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() },
        { assetKey: "asset_skill", kind: "skills", logicalName: "review/SKILL.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    const kinds = outcome.entries.map((entry) => entry.assetKind).sort();
    expect(kinds).toEqual(["instructions", "skills"]);
  }, 90_000);

  it("blocks an existing target until adoption is explicitly confirmed", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# user local\n", "utf8");

    const withoutConsent = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    expect(withoutConsent.appliedCount).toBe(0);
    expect(withoutConsent.blockedCount).toBe(1);
    expect(withoutConsent.entries[0]?.action).toBe("needs-adoption");
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# user local\n");

    const withConsent = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      confirmAdoption: true,
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    expect(withConsent.appliedCount).toBe(1);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# global\n");
  }, 90_000);

  it("honours a per-target mode override (add-only leaves an existing file alone)", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# user local\n", "utf8");

    const outcome = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      confirmAdoption: true,
      targets: [{ harnessInstanceId: "harn_codex", mode: "add-only" }]
    });

    expect(outcome.appliedCount).toBe(0);
    expect(outcome.entries[0]?.mode).toBe("add-only");
    expect(outcome.entries[0]?.action).toBe("skip-add-only-exists");
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# user local\n");
  }, 90_000);

  it("rejects an unregistered harness instead of auto-configuring it", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    await expect(
      service.applyToHarnesses({
        assets: [
          { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
        ],
        mode: "overwrite",
        targets: [{ harnessInstanceId: "harn_unknown" }]
      })
    ).rejects.toThrow(/not registered/);
  }, 90_000);

  it("reports an unbound project as a blocked entry, never a global fallback", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const outcome = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex", scope: { kind: "project", projectId: "prj_missing" } }]
    });

    expect(outcome.appliedCount).toBe(0);
    expect(outcome.blockedCount).toBe(1);
    expect(outcome.entries[0]?.scopeKind).toBe("project");
    expect(outcome.entries[0]?.detail).toMatch(/not bound/);
  }, 90_000);

  it("blocks an installed=false harness with an actionable reason", async () => {
    const { repo, service } = await createService([
      { ...codexRegistration, installed: false }
    ]);
    await service.openRepositoryFromDirectory(repo);

    const outcome = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    expect(outcome.blockedCount).toBe(1);
    expect(outcome.entries[0]?.detail).toMatch(/not installed/);
  }, 90_000);
});
