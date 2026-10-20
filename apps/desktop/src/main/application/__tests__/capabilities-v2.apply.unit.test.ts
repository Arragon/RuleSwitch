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
import { SyncBaselineStore } from "../../infrastructure/git/baseline-store";
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
  const baselineStore = new SyncBaselineStore(path.join(root, "state", "baselines.json"));
  await baselineStore.load();

  // A private HOME per test so harness roots never touch the real machine.
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;

  const service = new CapabilityServiceV2({
    gitPort,
    projectsStore,
    settingsStore,
    operationsStore,
    baselineStore,
    harnessRegistry: { listRegistrations: () => registrations },
    hasher
  });
  return { root, repo, home, service, projectsStore, baselineStore };
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

  it("records a verified baseline and reports a repeat apply as unchanged", async () => {
    const { repo, home, service, baselineStore } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const first = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    expect(first.appliedCount).toBe(1);

    // Baseline advanced only after verify: ownership now exists for this
    // repository + harness instance.
    const repositoryId = (await service.repositoryStatus())?.repositoryId ?? "";
    const record = baselineStore.find(repositoryId, "harn_codex", "AGENTS.md");
    expect(record).not.toBeNull();
    expect(record?.conversionGrade).toBe("lossless");

    // Second apply must be a no-op, not another "needs adoption" prompt and
    // not a rewrite. This is the regression that `planRevision` comparison
    // previously made impossible.
    const second = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    expect(second.appliedCount).toBe(0);
    expect(second.unchangedCount).toBe(1);
    expect(second.blockedCount).toBe(0);
    expect(second.entries[0]?.action).toBe("noop");
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# global\n");
  }, 90_000);

  it("treats a user edit after adoption as drift, not as a silent overwrite", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# user changed this\n", "utf8");

    const drift = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    // Baseline digest no longer matches the local file, so the write is
    // refused with UNMANAGED_TARGET_CHANGED rather than clobbering the edit.
    expect(drift.appliedCount).toBe(0);
    expect(drift.failedCount).toBe(1);
    expect(drift.entries[0]?.detail).toMatch(/changed since the recorded baseline/);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# user changed this\n");
  }, 90_000);

  it("previews without writing and reports per-target actions", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# user local\n", "utf8");

    const preview = await service.previewApply({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]?.action).toBe("needs-adoption");
    expect(preview.entries[0]?.requiresConfirmation).toBe(true);
    expect(preview.needsAdoptionCount).toBe(1);
    expect(preview.planRevision.length).toBeGreaterThan(0);
    // Preview is read-only: the user's file is untouched.
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# user local\n");
  }, 90_000);

  it("refuses an apply whose preview revision no longer matches", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const preview = await service.previewApply({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    // Consent changed after preview, so the plan hash changes: the stale
    // preview must not be executable.
    await expect(
      service.applyToHarnesses({
        assets: [
          { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
        ],
        mode: "overwrite",
        confirmAdoption: true,
        targets: [{ harnessInstanceId: "harn_codex" }],
        planRevision: preview.planRevision
      })
    ).rejects.toThrow(/stale/);

    // Nothing was written by the refused apply.
    await expect(readFile(path.join(home, ".codex", "AGENTS.md"))).rejects.toThrow();
  }, 90_000);
});
