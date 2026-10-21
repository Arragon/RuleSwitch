// Process-level kill-point matrix (INH-1789). Each case launches a real
// child process, lets it run a real batch apply, and kills it with SIGKILL at
// a different durable phase. The assertions are made on what survived on
// disk — the journal, the snapshot store and the target bytes — and on what
// reconciliation concludes from those bytes.
//
// This is not a simulated throw: SIGKILL terminates the process without
// running finally blocks or unwinding, which is the only way to prove the
// crash-safety claim.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CapabilityServiceV2 } from "../../apps/desktop/src/main/application/capabilities-v2";
import { GitPortAdapter } from "../../apps/desktop/src/main/infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../apps/desktop/src/main/infrastructure/git/git-runtime";
import { ProjectsStore, SettingsStore } from "../../apps/desktop/src/main/infrastructure/git/binding-store";
import { BatchSnapshotStore } from "../../apps/desktop/src/main/infrastructure/git/batch-snapshot-store";
import { SyncBaselineStore } from "../../apps/desktop/src/main/infrastructure/git/baseline-store";
import { OperationsStore } from "../../apps/desktop/src/main/infrastructure/git/sync-state";
import { RepositoryIdentityStore } from "../../apps/desktop/src/main/infrastructure/git/identity-store";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-crash-"));
  temporaryRoots.push(root);
  return root;
}

interface DrillSandbox {
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  readonly state: string;
}

/** A real git repository plus a private HOME and state directory. */
async function createSandbox(): Promise<DrillSandbox> {
  const root = await temporaryDirectory();
  const bare = path.join(root, "bare.git");
  const repo = path.join(root, "repo");
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  await runtime.run(["init", "--bare", "-q", "--initial-branch=main", bare], { cwd: root });
  await runtime.run(["clone", "-q", bare, repo], { cwd: root });
  await runtime.run(["config", "user.name", "T"], { cwd: repo });
  await runtime.run(["config", "user.email", "t@t"], { cwd: repo });
  await mkdir(path.join(repo, "global", "instructions"), { recursive: true });
  await writeFile(path.join(repo, "ruleswitch.yaml"), "schemaVersion: 1\n", "utf8");
  await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), "# from repository\n", "utf8");
  await runtime.run(["add", "."], { cwd: repo });
  await runtime.run(["commit", "-q", "-m", "seed"], { cwd: repo });
  await runtime.run(["push", "-q", "-u", "origin", "main"], { cwd: repo });

  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true });
  return { root, repo, home, state };
}

/** Runs the drill child until it is killed; returns the termination signal. */
async function runDrill(sandbox: DrillSandbox, phase: string): Promise<string | null> {
  const child = spawn(
    path.join(repositoryRoot, "node_modules", ".bin", "vitest"),
    ["run", "--config", "vitest.crash-drill.config.ts", "--root", repositoryRoot],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: sandbox.home,
        RULESWITCH_DRILL_PHASE: phase,
        RULESWITCH_DRILL_REPO: sandbox.repo,
        RULESWITCH_DRILL_STATE: sandbox.state
      },
      stdio: "ignore"
    }
  );
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (_code, signal) => resolve(signal));
  });
}

/** Re-opens the same state directory the way Main would after a restart. */
async function reopenAfterCrash(sandbox: DrillSandbox) {
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  const identityStore = new RepositoryIdentityStore(path.join(sandbox.state, "identity.json"));
  await identityStore.load();
  const projectsStore = new ProjectsStore(path.join(sandbox.state, "projects.json"));
  await projectsStore.load();
  const settingsStore = new SettingsStore(path.join(sandbox.state, "settings.json"));
  await settingsStore.load();
  const operationsStore = new OperationsStore(path.join(sandbox.state, "operations.json"));
  await operationsStore.load();
  const baselineStore = new SyncBaselineStore(path.join(sandbox.state, "baselines.json"));
  await baselineStore.load();
  const snapshotStore = new BatchSnapshotStore(path.join(sandbox.state, "batch-snapshots"));
  const service = new CapabilityServiceV2({
    gitPort: new GitPortAdapter({ gitRuntime: runtime, identityStore }),
    projectsStore,
    settingsStore,
    operationsStore,
    baselineStore,
    snapshotStore,
    harnessRegistry: {
      listRegistrations: () => [
        { harnessInstanceId: "harn_codex", adapterId: "codex", displayName: "Codex", installed: true }
      ]
    },
    hasher: {
      sha256Hex(input: string): string {
        return createHash("sha256").update(input, "utf8").digest("hex");
      }
    }
  });
  return { service, operationsStore, snapshotStore };
}

async function targetBytes(sandbox: DrillSandbox): Promise<string | null> {
  try {
    return await readFile(path.join(sandbox.home, ".codex", "AGENTS.md"), "utf8");
  } catch {
    return null;
  }
}

describe("process kill-point matrix (INH-1789)", () => {
  it("kill after the journal is written: nothing was written and the batch is settled as failed", async () => {
    const sandbox = await createSandbox();
    expect(await runDrill(sandbox, "journal-started")).toBe("SIGKILL");

    // Nothing reached the harness.
    expect(await targetBytes(sandbox)).toBeNull();

    const { service, operationsStore } = await reopenAfterCrash(sandbox);
    const before = operationsStore.listUnsettledBatches();
    expect(before).toHaveLength(1);
    expect(before[0]?.status).toBe("RUNNING");
    expect(before[0]?.entries[0]?.state).toBe("PENDING");

    const reconciled = await service.reconcileInterruptedBatches();
    expect(reconciled).toHaveLength(1);
    const settled = operationsStore.findBatchJournal(reconciled[0] ?? "");
    expect(settled?.status).toBe("FAILED");
    expect(settled?.entries[0]?.failureDetail).toMatch(/中断/);
  }, 120_000);

  it("kill after the snapshot: pre-apply bytes survive and rollback is a no-op success", async () => {
    const sandbox = await createSandbox();
    expect(await runDrill(sandbox, "snapshot-recorded")).toBe("SIGKILL");
    expect(await targetBytes(sandbox)).toBeNull();

    const { service, operationsStore, snapshotStore } = await reopenAfterCrash(sandbox);
    const batchId = operationsStore.listUnsettledBatches()[0]?.batchId ?? "";
    // The pre-apply snapshot was persisted BEFORE the write.
    const snapshot = await snapshotStore.load(batchId);
    expect(snapshot?.targets).toHaveLength(1);
    expect(snapshot?.targets[0]?.files[0]?.existedBefore).toBe(false);

    await service.reconcileInterruptedBatches();
    const settled = operationsStore.findBatchJournal(batchId);
    expect(settled?.status).toBe("FAILED");
    expect(settled?.entries[0]?.state).toBe("PENDING");
    expect(settled?.entries[0]?.failureDetail).toMatch(/未写入|中断/);

    // Restore is provable: no bytes were ever written, so the target is
    // already in its pre-apply state.
    const rollback = await service.rollbackBatch(batchId);
    expect(rollback.ok).toBe(true);
    expect(rollback.restored).toBe(1);
    expect(rollback.status).toBe("ROLLED_BACK");
  }, 120_000);

  it("kill after the write started but before it landed: reported as not written", async () => {
    const sandbox = await createSandbox();
    expect(await runDrill(sandbox, "write-started")).toBe("SIGKILL");
    expect(await targetBytes(sandbox)).toBeNull();

    const { service, operationsStore } = await reopenAfterCrash(sandbox);
    const batchId = operationsStore.listUnsettledBatches()[0]?.batchId ?? "";
    expect(operationsStore.findBatchJournal(batchId)?.entries[0]?.state).toBe("APPLYING");

    await service.reconcileInterruptedBatches();
    const settled = operationsStore.findBatchJournal(batchId);
    // Byte evidence decides: the file is still absent, so no write happened.
    expect(settled?.entries[0]?.state).toBe("PENDING");
    expect(settled?.status).toBe("FAILED");
  }, 120_000);

  it("kill after the write finished but before it was journalled: byte evidence promotes it to committed", async () => {
    const sandbox = await createSandbox();
    expect(await runDrill(sandbox, "write-finished")).toBe("SIGKILL");
    // The bytes are on disk even though the journal never recorded them.
    expect(await targetBytes(sandbox)).toBe("# from repository\n");

    const { service, operationsStore } = await reopenAfterCrash(sandbox);
    const batchId = operationsStore.listUnsettledBatches()[0]?.batchId ?? "";
    expect(operationsStore.findBatchJournal(batchId)?.entries[0]?.state).toBe("APPLYING");

    await service.reconcileInterruptedBatches();
    const settled = operationsStore.findBatchJournal(batchId);
    expect(settled?.entries[0]?.state).toBe("COMMITTED");
    expect(settled?.status).toBe("ALL_COMMITTED");

    // And the recognised write is still rollback-able from its snapshot.
    const rollback = await service.rollbackBatch(batchId);
    expect(rollback.ok).toBe(true);
    expect(await targetBytes(sandbox)).toBeNull();
  }, 120_000);

  it("kill after commit is journalled: the batch is already settled and needs no reconciliation", async () => {
    const sandbox = await createSandbox();
    expect(await runDrill(sandbox, "target-committed")).toBe("SIGKILL");
    expect(await targetBytes(sandbox)).toBe("# from repository\n");

    const { service, operationsStore } = await reopenAfterCrash(sandbox);
    // The kill landed after the COMMITTED journal write but before the final
    // settle, so reconciliation finishes the bookkeeping from the journal.
    const reconciled = await service.reconcileInterruptedBatches();
    expect(reconciled).toHaveLength(1);
    const batches = operationsStore.listAllBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.status).toBe("ALL_COMMITTED");
    expect(batches[0]?.entries[0]?.state).toBe("COMMITTED");
  }, 120_000);

  it("an unrecognisable post-crash state stays RECOVERY_REQUIRED instead of guessing", async () => {
    const sandbox = await createSandbox();
    expect(await runDrill(sandbox, "write-finished")).toBe("SIGKILL");

    // Simulate a target that changed for reasons RuleSwitch cannot prove
    // (another process edited the file after the crash).
    await writeFile(path.join(sandbox.home, ".codex", "AGENTS.md"), "# somebody else\n", "utf8");

    const { service, operationsStore } = await reopenAfterCrash(sandbox);
    const batchId = operationsStore.listUnsettledBatches()[0]?.batchId ?? "";
    await service.reconcileInterruptedBatches();
    const settled = operationsStore.findBatchJournal(batchId);
    expect(settled?.status).toBe("RECOVERY_REQUIRED");
    expect(settled?.entries[0]?.state).toBe("APPLY_FAILED");
    expect(settled?.entries[0]?.failureDetail).toMatch(/中断|不一致/);

    // Recovery guidance is honest, and the later edit is never clobbered.
    const recovery = await service.recoveryStatus();
    const batch = recovery.batches.find((entry) => entry.batchId === batchId);
    expect(batch?.rollbackAvailable).toBe(false);
    expect(await targetBytes(sandbox)).toBe("# somebody else\n");
  }, 120_000);
});
