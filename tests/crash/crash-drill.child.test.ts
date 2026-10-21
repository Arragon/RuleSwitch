// Process-crash drill child (INH-1789). Runs one real batch apply and then
// kills THIS process with SIGKILL at the requested durable phase — no
// exception, no unwinding, no cleanup. Whatever survives in the state
// directory is what a genuine crash would leave behind.
//
// Executed only by tests/integration/crash-matrix.integration.test.ts through
// a dedicated vitest config; it matches no default test glob.

import { createHash } from "node:crypto";

import { test } from "vitest";

import { CapabilityServiceV2, type ApplyCrashPhase } from "../../apps/desktop/src/main/application/capabilities-v2";
import { GitPortAdapter } from "../../apps/desktop/src/main/infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../apps/desktop/src/main/infrastructure/git/git-runtime";
import { ProjectsStore, SettingsStore } from "../../apps/desktop/src/main/infrastructure/git/binding-store";
import { BatchSnapshotStore } from "../../apps/desktop/src/main/infrastructure/git/batch-snapshot-store";
import { SyncBaselineStore } from "../../apps/desktop/src/main/infrastructure/git/baseline-store";
import { OperationsStore } from "../../apps/desktop/src/main/infrastructure/git/sync-state";
import { RepositoryIdentityStore } from "../../apps/desktop/src/main/infrastructure/git/identity-store";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`crash drill requires ${name}`);
  }
  return value;
}

const phase = required("RULESWITCH_DRILL_PHASE") as ApplyCrashPhase;
const repo = required("RULESWITCH_DRILL_REPO");
const state = required("RULESWITCH_DRILL_STATE");

test("applies one target and dies at the requested phase", async () => {
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  const identityStore = new RepositoryIdentityStore(`${state}/identity.json`);
  await identityStore.load();
  const projectsStore = new ProjectsStore(`${state}/projects.json`);
  await projectsStore.load();
  const settingsStore = new SettingsStore(`${state}/settings.json`);
  await settingsStore.load();
  const operationsStore = new OperationsStore(`${state}/operations.json`);
  await operationsStore.load();
  const baselineStore = new SyncBaselineStore(`${state}/baselines.json`);
  await baselineStore.load();
  const snapshotStore = new BatchSnapshotStore(`${state}/batch-snapshots`);

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
    },
    crashHook: (reached) => {
      if (reached !== phase) {
        return;
      }
      // The test runs in a forked vitest worker, so the drill kills the
      // runner first and then itself: SIGKILL cannot be caught, handled or
      // unwound, which is exactly what a real crash looks like.
      if (process.ppid > 1) {
        process.kill(process.ppid, "SIGKILL");
      }
      process.kill(process.pid, "SIGKILL");
    }
  });

  await service.openRepositoryFromDirectory(repo);
  await service.applyToHarnesses({
    assets: [
      { assetKey: "asset_agents", kind: "instructions", logicalName: "AGENTS.md", content: new Uint8Array() }
    ],
    mode: "overwrite",
    confirmAdoption: true,
    targets: [{ harnessInstanceId: "harn_codex" }]
  });
}, 120_000);
