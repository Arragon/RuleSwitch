// Unified Preview/Diff/Confirm model (INH-1814): presentation shaping over
// apply-plan entries + journaled batch results. Distinct confirm semantics
// per risk (delete/hook/degraded/adoption) — never a generic "are you
// sure". Stale plans return to preview.

import type { BatchJournal, BatchTargetJournalEntry } from "@ruleswitch/core";

export type PreviewRowKind = "create" | "modify" | "delete" | "no-op" | "blocked" | "degraded";

export interface PreviewRow {
  readonly targetKey: string;
  readonly kind: PreviewRowKind;
  readonly mode: string;
  readonly detail: string | null;
  /** Which confirm semantics this row requires, if any. */
  readonly confirmKind: "delete" | "hook" | "degraded" | "adoption" | null;
}

export interface BatchResultView {
  readonly status: string;
  readonly successful: readonly string[];
  readonly failed: readonly { readonly targetKey: string; readonly detail: string }[];
  readonly notStarted: readonly string[];
  readonly rollbackAvailable: boolean;
  readonly recoveryRequired: boolean;
}

/** Shapes apply-plan entries into preview rows with per-risk confirm kinds. */
export function shapePreviewRows(
  entries: readonly {
    readonly targetKey: string;
    readonly action: string;
    readonly effectiveMode: string;
    readonly blockedReason: string | null;
    readonly requiresExplicitConfirmation: boolean;
  }[],
  sourceDeleted: boolean
): readonly PreviewRow[] {
  return [...entries]
    .sort((left, right) => (left.targetKey < right.targetKey ? -1 : 1))
    .map((entry) => {
      switch (entry.action) {
        case "apply":
          return {
            targetKey: entry.targetKey,
            kind: "modify" as const,
            mode: entry.effectiveMode,
            detail: null,
            confirmKind: null
          };
        case "skip-add-only-exists":
          return {
            targetKey: entry.targetKey,
            kind: "no-op" as const,
            mode: entry.effectiveMode,
            detail: entry.blockedReason,
            confirmKind: null
          };
        case "needs-adoption":
          return {
            targetKey: entry.targetKey,
            kind: "blocked" as const,
            mode: entry.effectiveMode,
            detail: entry.blockedReason,
            confirmKind: "adoption" as const
          };
        case "blocked":
          return {
            targetKey: entry.targetKey,
            kind: sourceDeleted ? ("delete" as const) : ("blocked" as const),
            mode: entry.effectiveMode,
            detail: entry.blockedReason,
            confirmKind:
              entry.effectiveMode === "overwrite" && sourceDeleted
                ? ("delete" as const)
                : entry.requiresExplicitConfirmation
                  ? ("degraded" as const)
                  : null
          };
        default:
          return {
            targetKey: entry.targetKey,
            kind: "no-op" as const,
            mode: entry.effectiveMode,
            detail: entry.blockedReason,
            confirmKind: null
          };
      }
    });
}

/** Shapes a settled batch journal into the result view (honest partial states). */
export function shapeBatchResult(journal: BatchJournal): BatchResultView {
  const successful = journal.entries
    .filter((entry) => entry.state === "COMMITTED")
    .map((entry) => entry.targetKey);
  const failed = journal.entries
    .filter((entry) => entry.state === "PREFLIGHT_FAILED" || entry.state === "APPLY_FAILED" || entry.state === "VERIFY_FAILED")
    .map((entry) => ({ targetKey: entry.targetKey, detail: entry.failureDetail ?? "failed" }));
  const notStarted = journal.entries
    .filter((entry) => entry.state === "PENDING")
    .map((entry) => entry.targetKey);
  return {
    status: journal.status,
    successful,
    failed,
    notStarted,
    rollbackAvailable: successful.length > 0,
    recoveryRequired: journal.status === "RECOVERY_REQUIRED"
  };
}

/** Stale plan guard: an APPLYING/ROLLBACK_FAILED entry forces re-preview. */
export function planIsStale(journal: BatchJournal): boolean {
  return journal.entries.some(
    (entry: BatchTargetJournalEntry) => entry.state === "APPLYING" || entry.state === "ROLLBACK_FAILED"
  );
}
