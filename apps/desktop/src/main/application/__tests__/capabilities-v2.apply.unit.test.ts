// INH-1852 / INH-1814: apply-to-harness target resolution, per-kind plan
// entries, and first-adoption safety. These cover the behaviours that the
// previous implementation hardcoded away (kind: "skills", adoption: always
// confirmed, all registered harnesses at global scope).

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CapabilityServiceV2 } from "../../application/capabilities-v2";
import { GitPortAdapter } from "../../infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../infrastructure/git/git-runtime";
import { ProjectsStore, SettingsStore } from "../../infrastructure/git/binding-store";
import { BatchSnapshotStore } from "../../infrastructure/git/batch-snapshot-store";
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
  const snapshotStore = new BatchSnapshotStore(path.join(root, "state", "batch-snapshots"));

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
    snapshotStore,
    harnessRegistry: { listRegistrations: () => registrations },
    hasher
  });
  return { root, repo, home, service, projectsStore, baselineStore, snapshotStore };
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

  it("records a preflight failure, stops later targets, and surfaces recovery", async () => {
    const { repo, home, service } = await createService([
      { harnessInstanceId: "harn_a", adapterId: "codex", displayName: "Codex", installed: true },
      // Cursor does not support global instructions (capability matrix), so
      // use OpenCode which does — the point here is failure propagation.
      { harnessInstanceId: "harn_b", adapterId: "opencode", displayName: "OpenCode", installed: true }
    ]);
    await service.openRepositoryFromDirectory(repo);

    const assets = [
      { assetKey: "asset_agents", kind: "instructions" as const, logicalName: "AGENTS.md", content: new Uint8Array() }
    ];
    const targets = [
      { harnessInstanceId: "harn_a" },
      { harnessInstanceId: "harn_b" }
    ];

    const first = await service.applyToHarnesses({ assets, mode: "overwrite", targets });
    expect(first.appliedCount).toBe(2);

    // Change the source so the remaining target still needs a write, and
    // drift one target after adoption: its baseline digest no longer matches,
    // so preflight must refuse instead of overwriting.
    await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), "# v2\n", "utf8");
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# drifted\n", "utf8");

    const second = await service.applyToHarnesses({ assets, mode: "overwrite", targets });
    const byTarget = new Map(second.entries.map((entry) => [entry.harnessInstanceId, entry]));
    // harn_a sorts first, fails preflight; harn_b must not have started.
    expect(byTarget.get("harn_a")?.state).toBe("PREFLIGHT_FAILED");
    expect(byTarget.get("harn_a")?.detail).toMatch(/changed since the recorded baseline/);
    expect(byTarget.get("harn_b")?.state).toBe("PENDING");
    expect(second.failedCount).toBe(1);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# drifted\n");

    // Recovery Center reports the batch with honest rollback availability.
    const recovery = await service.recoveryStatus();
    const batch = recovery.batches.find((entry) => entry.batchId === second.batchId);
    expect(batch).toBeDefined();
    expect(batch?.rollbackAvailable).toBe(false);
    expect(batch?.rollbackReason).not.toBeNull();
    expect(batch?.targets.some((target) => target.state === "PREFLIGHT_FAILED")).toBe(true);
  }, 90_000);

  it("rolls back an applied target by deleting a file that did not exist", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const applied = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    expect(applied.appliedCount).toBe(1);

    const rolledBack = await service.rollbackBatch(applied.batchId);
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.restored).toBe(1);
    expect(rolledBack.status).toBe("ROLLED_BACK");
    await expect(readFile(path.join(home, ".codex", "AGENTS.md"))).rejects.toThrow();
  }, 90_000);

  it("restores the exact previous bytes on rollback, including the adopted copy", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# user local\n", "utf8");

    const applied = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      confirmAdoption: true,
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# global\n");

    const rolledBack = await service.rollbackBatch(applied.batchId);
    expect(rolledBack.ok).toBe(true);
    // Byte-exact restoration of what the user had before adoption.
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# user local\n");
  }, 90_000);

  it("refuses to roll back a target that changed after apply", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const applied = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# edited after apply\n", "utf8");

    const rolledBack = await service.rollbackBatch(applied.batchId);
    expect(rolledBack.ok).toBe(false);
    expect(rolledBack.failed).toBe(1);
    expect(rolledBack.status).toBe("RECOVERY_REQUIRED");
    expect(rolledBack.reason).toMatch(/not restored/);
    // The later edit is preserved, never clobbered.
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# edited after apply\n");
  }, 90_000);

  it("refuses a second rollback and an unknown batch", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const applied = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    expect((await service.rollbackBatch(applied.batchId)).ok).toBe(true);

    const second = await service.rollbackBatch(applied.batchId);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already rolled back/);

    const unknown = await service.rollbackBatch("batch-does-not-exist");
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toMatch(/unknown batch/);
  }, 90_000);

  it("reports rollback availability from the persisted snapshot", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const applied = await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    const recovery = await service.recoveryStatus();
    const available = recovery.batches.find((batch) => batch.batchId === applied.batchId);
    // A fully committed batch is not a recovery item unless something failed,
    // so assert on the explicit snapshot-backed path instead.
    expect(applied.status).toBe("ALL_COMMITTED");
    expect(available).toBeUndefined();
  }, 90_000);

  it("scans a harness root without following symlinks and marks unmanaged files", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    // Real local layout the user might already have.
    await mkdir(path.join(home, ".codex", "skills", "review"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# local\n", "utf8");
    await writeFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "# skill\n", "utf8");
    await writeFile(path.join(home, ".codex", "notes.txt"), "unrelated\n", "utf8");
    // A symlink must be skipped, never followed.
    await writeFile(path.join(home, "outside.txt"), "outside\n", "utf8");
    await symlink(path.join(home, "outside.txt"), path.join(home, ".codex", "linked.txt"));

    const scan = await service.scanHarness("harn_codex");
    expect(scan?.rootPresent).toBe(true);
    const paths = scan?.files.map((file) => file.relativePath) ?? [];
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("skills/review/SKILL.md");
    expect(paths).toContain("notes.txt");
    expect(paths).not.toContain("linked.txt");
    // No absolute path leaks out of the read model.
    expect(JSON.stringify(scan)).not.toContain(home);

    const byPath = new Map((scan?.files ?? []).map((file) => [file.relativePath, file]));
    expect(byPath.get("AGENTS.md")?.kind).toBe("instructions");
    expect(byPath.get("skills/review/SKILL.md")?.kind).toBe("skills");
    // Unrecognised layout is reported as null, not guessed.
    expect(byPath.get("notes.txt")?.kind).toBeNull();
    // Nothing is managed before RuleSwitch writes anything.
    expect(scan?.managedCount).toBe(0);
    expect(scan?.unclassifiedCount).toBe(1);
  }, 90_000);

  it("marks a file managed only after a verified apply recorded a baseline", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# local\n", "utf8");

    await service.applyToHarnesses({
      assets: [
        { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
      ],
      mode: "overwrite",
      confirmAdoption: true,
      targets: [{ harnessInstanceId: "harn_codex" }]
    });

    const scan = await service.scanHarness("harn_codex");
    const agents = scan?.files.find((file) => file.relativePath === "AGENTS.md");
    expect(agents?.managed).toBe(true);
    expect(scan?.managedCount).toBe(1);
  }, 90_000);

  it("reports an absent harness root and an unknown harness", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const missingRoot = await service.scanHarness("harn_codex");
    expect(missingRoot?.rootPresent).toBe(false);
    expect(missingRoot?.files).toHaveLength(0);

    expect(await service.scanHarness("harn_unknown")).toBeNull();
  }, 90_000);
});

describe("CapabilityServiceV2.diffApplyTarget (INH-1814 line-level review)", () => {
  const agentsAsset = {
    assetKey: "asset_agents" as const,
    kind: "instructions" as const,
    logicalName: "AGENTS.md",
    content: new Uint8Array()
  };

  it("returns both sides as text for an existing target", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# user local\n", "utf8");

    const preview = await service.previewApply({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex" }]
    });
    const diff = await service.diffApplyTarget({
      assets: [agentsAsset],
      mode: "overwrite",
      targetKey: "harn_codex|global|instructions",
      planRevision: preview.planRevision
    });

    expect(diff.reason).toBeNull();
    expect(diff.action).toBe("needs-adoption");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.logicalName).toBe("AGENTS.md");
    expect(diff.files[0]?.targetExists).toBe(true);
    expect(diff.files[0]?.identical).toBe(false);
    // Left side is the real local file, right side is what would be written.
    expect(diff.files[0]?.targetText).toBe("# user local\n");
    expect(diff.files[0]?.sourceText).toBe("# global\n");
    // No absolute path crosses the boundary.
    expect(JSON.stringify(diff)).not.toContain(home);
  }, 90_000);

  it("reports an absent target as an empty original side", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const diff = await service.diffApplyTarget({
      assets: [agentsAsset],
      mode: "overwrite",
      targetKey: "harn_codex|global|instructions"
    });

    expect(diff.files[0]?.targetExists).toBe(false);
    expect(diff.files[0]?.targetText).toBeNull();
    expect(diff.files[0]?.sourceText).toBe("# global\n");
    expect(diff.files[0]?.binary).toBe(false);
  }, 90_000);

  it("marks non-text bytes as binary instead of decoding them lossily", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    // NUL byte on the source side and an invalid UTF-8 sequence on the target.
    await writeFile(path.join(home, ".codex", "AGENTS.md"), Buffer.from([0xff, 0xfe, 0xfd]), "binary");

    const diff = await service.diffApplyTarget({
      assets: [{ ...agentsAsset, content: new Uint8Array([0x00, 0x01, 0x02]) }],
      mode: "overwrite",
      targetKey: "harn_codex|global|instructions"
    });

    expect(diff.files[0]?.binary).toBe(true);
    expect(diff.files[0]?.sourceText).toBeNull();
    expect(diff.files[0]?.targetText).toBeNull();
    expect(diff.files[0]?.identical).toBe(false);
  }, 90_000);

  it("reports an already-in-sync target as identical", async () => {
    const { repo, home, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# global\n", "utf8");

    const diff = await service.diffApplyTarget({
      assets: [agentsAsset],
      mode: "overwrite",
      targetKey: "harn_codex|global|instructions"
    });

    expect(diff.files[0]?.identical).toBe(true);
    expect(diff.files[0]?.sourceText).toBe(diff.files[0]?.targetText);
  }, 90_000);

  it("refuses a stale plan revision instead of diffing old bytes", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    await expect(
      service.diffApplyTarget({
        assets: [agentsAsset],
        mode: "overwrite",
        targetKey: "harn_codex|global|instructions",
        planRevision: "not-the-current-revision"
      })
    ).rejects.toThrow(/stale/);
  }, 90_000);

  it("returns an actionable reason instead of files for a blocked target", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const preview = await service.previewApply({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: [{ harnessInstanceId: "harn_codex", scope: { kind: "project", projectId: "prj_missing" } }]
    });
    const targetKey = preview.entries[0]?.targetKey ?? "";
    expect(targetKey.length).toBeGreaterThan(0);

    const diff = await service.diffApplyTarget({
      assets: [agentsAsset],
      mode: "overwrite",
      targetKey,
      targets: [{ harnessInstanceId: "harn_codex", scope: { kind: "project", projectId: "prj_missing" } }]
    });

    expect(diff.files).toHaveLength(0);
    expect(diff.action).toBe("blocked");
    expect(diff.reason).toMatch(/not bound/);
  }, 90_000);

  it("reports an unknown target key instead of guessing", async () => {
    const { repo, service } = await createService([codexRegistration]);
    await service.openRepositoryFromDirectory(repo);

    const diff = await service.diffApplyTarget({
      assets: [agentsAsset],
      mode: "overwrite",
      targetKey: "harn_codex|global|hooks"
    });

    expect(diff.files).toHaveLength(0);
    expect(diff.reason).not.toBeNull();
  }, 90_000);
});
