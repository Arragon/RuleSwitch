// Sync-state stores (INH-1781/1789): the SyncBaseline store ("last
// successful sync fact" per managed target) and the operations journal
// (batch apply journals + pending publish linkage), both versioned
// envelopes with atomic writes. Baselines only ever advance through
// core's baselineOutcome gate (verify + completion required).

import { readFile, rename } from "node:fs/promises";

import { writeFileDurably } from "../durable-write";

import {
  baselineOutcome,
  parseStoreEnvelope,
  type BatchJournal,
  type BaselineExplanation,
  type ProvenanceRecord,
  type RepositoryId,
  type StoreLoadResult,
  type StoreName,
  type SyncBaselineRecord
} from "@ruleswitch/core";

export class SyncStateStoreError extends Error {
  constructor(
    message: string,
    readonly gate: "blocked-corrupt" | "blocked-future-version"
  ) {
    super(message);
    this.name = "SyncStateStoreError";
  }
}

export class VersionedSyncStore<T extends object> {
  private data: T | null = null;

  constructor(
    private readonly storePath: string,
    private readonly storeName: StoreName,
    private readonly createEmpty: () => T
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = this.createEmpty();
        return;
      }
      throw error;
    }
    const result: StoreLoadResult<unknown> = parseStoreEnvelope(raw, this.storeName);
    if (result.kind !== "ok") {
      if (result.kind === "corrupt" || result.kind === "wrong-store") {
        await rename(this.storePath, `${this.storePath}.corrupt-${Date.now()}`);
      }
      throw new SyncStateStoreError(
        result.kind === "future-version"
          ? `${this.storeName} store version ${result.version} is newer than supported`
          : `${this.storeName} store is ${result.kind}`,
        result.kind === "future-version" ? "blocked-future-version" : "blocked-corrupt"
      );
    }
    this.data = result.envelope.data as T;
  }

  current(): T {
    if (this.data === null) {
      throw new Error(`${this.storeName} store used before load()`);
    }
    return this.data;
  }

  async mutate(mutate: (data: T) => void): Promise<void> {
    mutate(this.current());
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.data === null) {
      return;
    }
    const envelope = {
      store: this.storeName,
      version: 1,
      writtenAt: new Date().toISOString(),
      data: this.data
    };
    // Durable atomic write: fsynced bytes, then rename, then directory flush.
    // A crash can otherwise leave a renamed journal backed by unwritten
    // blocks, which the recovery surface would read as truth.
    await writeFileDurably(this.storePath, `${JSON.stringify(envelope, null, 2)}\n`, {
      mode: 0o600
    });
  }
}

// ---------------------------------------------------------------------------
// SyncBaseline store (INH-1781)
// ---------------------------------------------------------------------------

export interface SyncBaselinesData {
  readonly baselines: Record<string, SyncBaselineRecord>;
}

export class SyncBaselineStore extends VersionedSyncStore<SyncBaselinesData> {
  constructor(storePath: string) {
    super(storePath, "sync-baselines", () => ({ baselines: {} }));
  }

  /**
   * The ONLY write path: refuses records that claim success without a
   * completed, verified operation (core baselineOutcome gate).
   */
  async advanceAfterVerify(
    record: SyncBaselineRecord,
    facts: { readonly verified: boolean; readonly operationComplete: boolean }
  ): Promise<void> {
    const outcome = baselineOutcome({ verified: facts.verified, operationComplete: facts.operationComplete, record });
    if (!outcome.ok) {
      throw new Error(`baseline refused: ${outcome.reason} — ${outcome.detail}`);
    }
    await this.mutate((data) => {
      data.baselines[baselineTargetKey(record)] = record;
    });
  }

  find(targetKey: string): SyncBaselineRecord | null {
    return this.current().baselines[targetKey] ?? null;
  }

  explain(targetKey: string, provenance: readonly ProvenanceRecord[]): BaselineExplanation {
    const record = this.find(targetKey);
    if (record === null) {
      return { kind: "needs-adoption", reason: "no baseline recorded for this target" };
    }
    return explainBaselineInternal(record, provenance);
  }

  async clear(targetKey: string): Promise<void> {
    await this.mutate((data) => {
      delete data.baselines[targetKey];
    });
  }
}

function baselineTargetKey(record: Pick<SyncBaselineRecord, "repositoryId" | "harnessInstanceId" | "targetLogicalPath">): string {
  return `${record.repositoryId}|${record.harnessInstanceId}|${record.targetLogicalPath}`;
}

function explainBaselineInternal(record: SyncBaselineRecord, provenance: readonly ProvenanceRecord[]): BaselineExplanation {
  const match = provenance.find(
    (entry) =>
      entry.sourceAssetKey === record.sourceAssetKey &&
      entry.sourceRevision === record.sourceRevision &&
      entry.converterId === record.converterId &&
      entry.converterVersion === record.converterVersion
  );
  if (match === undefined) {
    return {
      kind: "needs-adoption",
      reason: `no provenance explains target ${record.targetLogicalPath}`
    };
  }
  if (match.outputDigest !== record.outputDigest) {
    return {
      kind: "needs-adoption",
      reason: `provenance digest ${match.outputDigest} differs from baseline ${record.outputDigest}`
    };
  }
  return { kind: "explained", provenance: match };
}

// ---------------------------------------------------------------------------
// Operations journal store (INH-1789/1788)
// ---------------------------------------------------------------------------

export interface OperationsData {
  readonly batchJournals: Record<string, BatchJournal>;
  readonly pendingPublishes: Record<
    string,
    { readonly repositoryId: RepositoryId; readonly pendingRevision: string; readonly captureOperationId: string; readonly branch: string; readonly recordedAt: string }
  >;
}

export class OperationsStore extends VersionedSyncStore<OperationsData> {
  constructor(storePath: string) {
    super(storePath, "operations-history", () => ({ batchJournals: {}, pendingPublishes: {} }));
  }

  async saveBatchJournal(journal: BatchJournal): Promise<void> {
    await this.mutate((data) => {
      data.batchJournals[journal.batchId] = journal;
    });
  }

  /** Mutates and persists one journal (rollback bookkeeping). */
  async updateBatchJournal(
    batchId: string,
    mutate: (journal: BatchJournal) => void
  ): Promise<BatchJournal | null> {
    const existing = this.current().batchJournals[batchId];
    if (existing === undefined) {
      return null;
    }
    mutate(existing);
    await this.mutate((data) => {
      data.batchJournals[batchId] = existing;
    });
    return existing;
  }

  findBatchJournal(batchId: string): BatchJournal | null {
    return this.current().batchJournals[batchId] ?? null;
  }

  /** Every recorded batch, newest first — used by the recovery surface. */
  listAllBatches(): readonly BatchJournal[] {
    return Object.values(this.current().batchJournals).sort((left, right) =>
      left.updatedAt < right.updatedAt ? 1 : -1
    );
  }

  listUnsettledBatches(): readonly BatchJournal[] {
    return Object.values(this.current().batchJournals).filter(
      (journal) => journal.status === "RUNNING" || journal.status === "RECOVERY_REQUIRED"
    );
  }

  async recordPendingPublish(repositoryId: RepositoryId, pendingRevision: string, captureOperationId: string, branch: string): Promise<void> {
    await this.mutate((data) => {
      data.pendingPublishes[repositoryId] = {
        repositoryId,
        pendingRevision,
        captureOperationId,
        branch,
        recordedAt: new Date().toISOString()
      };
    });
  }

  async clearPendingPublish(repositoryId: RepositoryId): Promise<void> {
    await this.mutate((data) => {
      delete data.pendingPublishes[repositoryId];
    });
  }

  findPendingPublish(repositoryId: RepositoryId): OperationsData["pendingPublishes"][string] | null {
    return this.current().pendingPublishes[repositoryId] ?? null;
  }
}
