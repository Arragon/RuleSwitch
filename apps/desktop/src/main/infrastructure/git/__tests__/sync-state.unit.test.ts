import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SyncBaselineStore, SyncStateStoreError, OperationsStore } from "../sync-state";
import type { SyncBaselineRecord } from "@ruleswitch/core";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-syncstate-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(overrides: Partial<SyncBaselineRecord> = {}): SyncBaselineRecord {
  return {
    repositoryId: "repo_" + "a".repeat(64),
    harnessInstanceId: "harn_" + "b".repeat(64),
    targetLogicalPath: "skills/demo/SKILL.md",
    bindingMode: "mirror",
    repositoryRevision: "rev1",
    sourceAssetKey: "global|skills|demo",
    sourceRevision: "src1",
    converterId: "skills",
    converterVersion: "1.0.0",
    managedKeys: null,
    outputDigest: "out1",
    outputByteLength: 42,
    conversionGrade: "lossless",
    lastOperationId: "op1",
    recordedAt: "2026-10-09T00:00:00Z",
    ...overrides
  };
}

describe("SyncBaselineStore (INH-1781)", () => {
  it("advances only after verify + completion and survives restarts", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "sync-baselines", "v1.json");

    const first = new SyncBaselineStore(storePath);
    await first.load();
    await expect(
      first.advanceAfterVerify(record(), { verified: false, operationComplete: true })
    ).rejects.toThrow(/VERIFY_FAILED/);
    await expect(
      first.advanceAfterVerify(record(), { verified: true, operationComplete: false })
    ).rejects.toThrow(/OPERATION_INCOMPLETE/);
    await first.advanceAfterVerify(record(), { verified: true, operationComplete: true });
    const key = "repo_" + "a".repeat(64) + "|harn_" + "b".repeat(64) + "|skills/demo/SKILL.md";
    expect(first.find(key)?.outputDigest).toBe("out1");

    const second = new SyncBaselineStore(storePath);
    await second.load();
    expect(second.find(key)?.repositoryRevision).toBe("rev1");
    expect(second.explain(key, [])).toMatchObject({ kind: "needs-adoption" });
  });

  it("quarantines corrupt stores and blocks future versions", async () => {
    const root = await temporaryDirectory();
    const dir = path.join(root, "sync-baselines");
    const storePath = path.join(dir, "v1.json");
    await mkdir(dir, { recursive: true });
    await writeFile(storePath, "{ broken", "utf8");
    const store = new SyncBaselineStore(storePath);
    await expect(store.load()).rejects.toBeInstanceOf(SyncStateStoreError);
    expect((await readdir(dir)).some((name) => name.startsWith("v1.json.corrupt-"))).toBe(true);

    const futurePath = path.join(dir, "future.json");
    await writeFile(
      futurePath,
      JSON.stringify({ store: "sync-baselines", version: 9, writtenAt: "2026-10-09T00:00:00Z", data: {} }),
      "utf8"
    );
    const futureStore = new SyncBaselineStore(futurePath);
    await expect(futureStore.load()).rejects.toThrow(/newer than supported/);
    expect(JSON.parse(await readFile(futurePath, "utf8")).version).toBe(9);
  });
});

describe("OperationsStore (INH-1789/1788)", () => {
  it("persists batch journals and pending publish across restarts", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "operations", "v1.json");
    const repoId = "repo_" + "a".repeat(64);

    const first = new OperationsStore(storePath);
    await first.load();
    await first.saveBatchJournal({
      batchId: "batch1",
      planId: "plan1",
      startedAt: "2026-10-09T00:00:00Z",
      updatedAt: "2026-10-09T00:00:01Z",
      status: "PARTIAL_SUCCESS",
      entries: [
        {
          targetKey: "t1",
          mode: "overwrite",
          planRevision: "r1",
          state: "COMMITTED",
          snapshotRef: "snap1",
          verifyDigest: "d1",
          failureDetail: null,
          rollbackOf: false
        },
        {
          targetKey: "t2",
          mode: "overwrite",
          planRevision: "r1",
          state: "APPLY_FAILED",
          snapshotRef: null,
          verifyDigest: null,
          failureDetail: "disk full",
          rollbackOf: false
        }
      ]
    });
    await first.recordPendingPublish(repoId, "commit1", "op1", "main");

    const second = new OperationsStore(storePath);
    await second.load();
    const journal = second.findBatchJournal("batch1");
    expect(journal?.status).toBe("PARTIAL_SUCCESS");
    expect(journal?.entries).toHaveLength(2);
    expect(second.listUnsettledBatches()).toHaveLength(0);
    expect(second.findPendingPublish(repoId)?.pendingRevision).toBe("commit1");

    await second.clearPendingPublish(repoId);
    const third = new OperationsStore(storePath);
    await third.load();
    expect(third.findPendingPublish(repoId)).toBeNull();
    expect(third.findBatchJournal("batch1")?.entries[0]?.state).toBe("COMMITTED");
  });
});
