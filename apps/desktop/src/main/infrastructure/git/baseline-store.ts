// SyncBaseline store (INH-1781 / R-07): the persisted "last successful sync
// fact" per managed target. Apply consults it to decide `hasOwnership`
// instead of assuming no baseline, which previously forced every existing
// target through needs-adoption.
//
// Rules enforced here:
// - A baseline is only written through `advance()`, which requires the
//   verified+complete outcome from core (`baselineOutcome`). Mid-flight
//   failures never advance it.
// - Lookups use the stable target key (repository + harness instance +
//   logical target path). Absolute paths never participate, so moving a
//   harness root or rebinding a project does not lose ownership.
// - Corrupt/future-version stores quarantine and block mutation, matching
//   the other versioned stores.

import {
  baselineOutcome,
  baselineTargetKey,
  type SyncBaselineRecord
} from "@ruleswitch/core";

import { VersionedStore, type WriteFaultInjector } from "./binding-store";

export interface SyncBaselineStoreData {
  /** records[targetKey] — targetKey is repositoryId|harnessInstanceId|targetLogicalPath */
  records: Record<string, SyncBaselineRecord>;
}

export class SyncBaselineStore extends VersionedStore<SyncBaselineStoreData> {
  constructor(storePath: string, faults?: WriteFaultInjector) {
    super(storePath, "sync-baselines", () => ({ records: {} }), faults);
  }

  /** Returns the baseline for a target, or null when it was never managed. */
  find(
    repositoryId: string,
    harnessInstanceId: string,
    targetLogicalPath: string
  ): SyncBaselineRecord | null {
    return (
      this.current().records[
        baselineTargetKey({
          repositoryId: repositoryId as SyncBaselineRecord["repositoryId"],
          harnessInstanceId: harnessInstanceId as SyncBaselineRecord["harnessInstanceId"],
          targetLogicalPath
        })
      ] ?? null
    );
  }

  /**
   * Per-target-path digest map for the apply planner. Only records that
   * belong to this repository + harness instance are considered.
   */
  digestsFor(
    repositoryId: string,
    harnessInstanceId: string
  ): Record<string, string> {
    const digests: Record<string, string> = {};
    for (const record of Object.values(this.current().records)) {
      if (
        record.repositoryId === repositoryId &&
        record.harnessInstanceId === harnessInstanceId
      ) {
        digests[record.targetLogicalPath] = record.outputDigest;
      }
    }
    return digests;
  }

  /**
   * Records one verified target. Refuses records that were not produced by a
   * completed, verified operation — the only sanctioned path is
   * `baselineOutcome`.
   */
  async advance(input: {
    readonly verified: boolean;
    readonly operationComplete: boolean;
    readonly record: SyncBaselineRecord;
  }): Promise<boolean> {
    const outcome = baselineOutcome(input);
    if (!outcome.ok) {
      return false;
    }
    await this.mutate((data) => {
      data.records[baselineTargetKey(outcome.record)] = outcome.record;
    });
    return true;
  }

  /** Drops a baseline after a confirmed delete so it stops claiming ownership. */
  async forget(
    repositoryId: string,
    harnessInstanceId: string,
    targetLogicalPath: string
  ): Promise<void> {
    await this.mutate((data) => {
      delete data.records[
        baselineTargetKey({
          repositoryId: repositoryId as SyncBaselineRecord["repositoryId"],
          harnessInstanceId: harnessInstanceId as SyncBaselineRecord["harnessInstanceId"],
          targetLogicalPath
        })
      ];
    });
  }
}
