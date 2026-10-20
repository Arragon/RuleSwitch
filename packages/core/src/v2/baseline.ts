// SyncBaseline records (INH-1781): the persisted "last successful sync
// fact" for every managed target/binding, supporting B/L/D reconciliation
// across restarts. Target identity is stable (repository + harness
// instance + logical target identity) and never depends on absolute
// paths — moving a harness root or rebinding a project does not
// invalidate a baseline.
//
// Invariants:
// - A baseline is only written after Verify succeeded (see
//   baselineOutcome); Apply/Capture mid-flight failures never advance it.
// - Every baseline can EXPLAIN its target: which Git asset, at which
//   source revision, through which converter produced the current bytes.
//   When explanation is impossible the target is NEEDS_ADOPTION, never a
//   guess.

import type { BindingMode, ConversionGrade, ProvenanceRecord } from "./reconcile";
import type { HarnessInstanceId, RepositoryId } from "./identity";

export interface SyncBaselineRecord {
  /** Stable target identity: repository + harness instance + logical target. */
  readonly repositoryId: RepositoryId;
  readonly harnessInstanceId: HarnessInstanceId;
  /** Logical path inside the harness root (e.g. skills/demo/SKILL.md). */
  readonly targetLogicalPath: string;
  readonly bindingMode: BindingMode;
  /** Git revision of the config repo when this baseline was recorded. */
  readonly repositoryRevision: string;
  /** Serialized source asset key ("scope|kind|logicalName"). */
  readonly sourceAssetKey: string;
  /** Source revision/digest the target was rendered from. */
  readonly sourceRevision: string;
  readonly converterId: string;
  readonly converterVersion: string;
  /** Managed top-level keys (structured bindings) or null. */
  readonly managedKeys: readonly string[] | null;
  /** Output digest + byte metadata of the verified target bytes. */
  readonly outputDigest: string;
  readonly outputByteLength: number;
  readonly conversionGrade: ConversionGrade;
  readonly lastOperationId: string;
  readonly recordedAt: string;
}

export type BaselineExplanation =
  | { readonly kind: "explained"; readonly provenance: ProvenanceRecord }
  | { readonly kind: "needs-adoption"; readonly reason: string };

/**
 * Explains whether a baseline still accounts for a target's current state:
 * the recorded provenance must reference the baseline's own asset/revision
 * and its output digest must match what verification last saw. Used when a
 * baseline is loaded after corruption, converter upgrades, or manual edits.
 */
export function explainBaseline(record: SyncBaselineRecord, provenance: readonly ProvenanceRecord[]): BaselineExplanation {
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
      reason: `no provenance explains target ${record.targetLogicalPath}: expected ${record.sourceAssetKey}@${record.sourceRevision} via ${record.converterId}@${record.converterVersion}`
    };
  }
  if (match.outputDigest !== record.outputDigest) {
    return {
      kind: "needs-adoption",
      reason: `provenance output digest ${match.outputDigest} does not match baseline digest ${record.outputDigest}`
    };
  }
  return { kind: "explained", provenance: match };
}

/** Converter-version drift check: a changed converter invalidates reuse of the old output. */
export function converterDrifted(record: SyncBaselineRecord, current: { converterId: string; converterVersion: string }): boolean {
  return record.converterId !== current.converterId || record.converterVersion !== current.converterVersion;
}

export type BaselineOutcome =
  | { readonly ok: true; readonly record: SyncBaselineRecord }
  | { readonly ok: false; readonly reason: "VERIFY_FAILED" | "OPERATION_INCOMPLETE"; readonly detail: string };

/**
 * The ONLY sanctioned way to produce a baseline record: verify must have
 * succeeded and the operation (apply or capture) must be complete. This
 * function exists so stores can refuse records that claim otherwise.
 */
export function baselineOutcome(input: {
  verified: boolean;
  operationComplete: boolean;
  record: SyncBaselineRecord;
}): BaselineOutcome {
  if (!input.operationComplete) {
    return { ok: false, reason: "OPERATION_INCOMPLETE", detail: "baseline may only advance after the operation completes" };
  }
  if (!input.verified) {
    return { ok: false, reason: "VERIFY_FAILED", detail: "baseline may only advance after verify succeeds" };
  }
  return { ok: true, record: input.record };
}

/** Stable lookup key for a target — absolute paths never participate. */
export function baselineTargetKey(record: Pick<SyncBaselineRecord, "repositoryId" | "harnessInstanceId" | "targetLogicalPath">): string {
  return `${record.repositoryId}|${record.harnessInstanceId}|${record.targetLogicalPath}`;
}
