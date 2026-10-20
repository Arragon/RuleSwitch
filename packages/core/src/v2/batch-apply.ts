// Journaled Batch Apply (INH-1789): one asset set applied to many harness
// targets with per-target preflight→snapshot→apply→verify. There is NO
// distributed atomicity claim: partial success is an honest outcome, and
// the journal makes every step recoverable/explainable after a crash.
//
// Rules (frozen):
// - A failing target stops not-yet-started targets; already-committed
//   targets stay COMMITTED.
// - Rollback of successful targets is an explicit operation; a failed
//   rollback moves the batch to RECOVERY_REQUIRED and gates destructive
//   mutations.
// - Targets that are unbound/unsupported enter the journal with their
//   blocked reason — they are never counted as successes.
// - Per-target mode/revision are recorded so recovery reports can be
//   checked target by target.

export const BATCH_TARGET_STATES = [
  "PENDING",
  "PREFLIGHT_FAILED",
  "SNAPSHOTTED",
  "APPLYING",
  "APPLY_FAILED",
  "VERIFY_FAILED",
  "COMMITTED",
  "ROLLED_BACK",
  "ROLLBACK_FAILED",
  "SKIPPED_BLOCKED"
] as const;
export type BatchTargetState = (typeof BATCH_TARGET_STATES)[number];

export interface BatchTargetPlanEntry {
  readonly targetKey: string;
  readonly mode: "overwrite" | "merge-add" | "add-only";
  /** Fresh digests this plan entry was built from. */
  readonly revision: string;
  readonly executable: boolean;
  readonly blockedReason: string | null;
}

export interface BatchTargetJournalEntry {
  readonly targetKey: string;
  readonly mode: "overwrite" | "merge-add" | "add-only";
  readonly planRevision: string;
  state: BatchTargetState;
  snapshotRef: string | null;
  verifyDigest: string | null;
  failureDetail: string | null;
  readonly rollbackOf: boolean;
}

export interface BatchJournal {
  readonly batchId: string;
  readonly planId: string;
  readonly startedAt: string;
  updatedAt: string;
  status: "RUNNING" | "PARTIAL_SUCCESS" | "ALL_COMMITTED" | "FAILED" | "ROLLED_BACK" | "RECOVERY_REQUIRED";
  entries: BatchTargetJournalEntry[];
}

export function createBatchJournal(batchId: string, planId: string, entries: readonly BatchTargetPlanEntry[], now: () => string): BatchJournal {
  return {
    batchId,
    planId,
    startedAt: now(),
    updatedAt: now(),
    status: "RUNNING",
    entries: [...entries]
      .sort((left, right) => (left.targetKey < right.targetKey ? -1 : 1))
      .map((entry) => ({
        targetKey: entry.targetKey,
        mode: entry.mode,
        planRevision: entry.revision,
        state: entry.executable ? "PENDING" : "SKIPPED_BLOCKED",
        snapshotRef: null,
        verifyDigest: null,
        failureDetail: entry.executable ? null : (entry.blockedReason ?? "target not executable"),
        rollbackOf: false
      }))
  };
}

export type BatchStepDecision =
  | { readonly action: "execute"; readonly entry: BatchTargetJournalEntry }
  | { readonly action: "skip-blocked"; readonly entry: BatchTargetJournalEntry }
  | { readonly action: "halt"; readonly reason: string };

/**
 * Picks the next executable target: blocked targets are skipped (recorded),
 * the first failure halts not-yet-started targets.
 */
export function nextBatchStep(journal: BatchJournal): BatchStepDecision {
  if (journal.status !== "RUNNING") {
    return { action: "halt", reason: `batch is ${journal.status}` };
  }
  let sawFailure = false;
  for (const entry of journal.entries) {
    if (entry.state === "SKIPPED_BLOCKED") {
      continue;
    }
    if (entry.state === "PREFLIGHT_FAILED" || entry.state === "APPLY_FAILED" || entry.state === "VERIFY_FAILED") {
      sawFailure = true;
      continue;
    }
    if (entry.state === "COMMITTED" || entry.state === "ROLLED_BACK" || entry.state === "ROLLBACK_FAILED") {
      continue;
    }
    if (sawFailure) {
      return { action: "halt", reason: `earlier target failed (${entry.targetKey} not started)` };
    }
    return { action: "execute", entry };
  }
  return { action: "halt", reason: "no executable targets remain" };
}

/** Final status after execution stops: honest partial-success labeling. */
export function settleBatch(journal: BatchJournal, now: () => string): void {
  journal.updatedAt = now();
  const executable = journal.entries.filter((entry) => entry.state !== "SKIPPED_BLOCKED");
  const committed = executable.filter((entry) => entry.state === "COMMITTED");
  const failed = executable.filter(
    (entry) => entry.state === "PREFLIGHT_FAILED" || entry.state === "APPLY_FAILED" || entry.state === "VERIFY_FAILED"
  );
  const rolledBack = executable.filter((entry) => entry.state === "ROLLED_BACK");
  const rollbackFailed = executable.filter((entry) => entry.state === "ROLLBACK_FAILED");
  if (rollbackFailed.length > 0) {
    journal.status = "RECOVERY_REQUIRED";
    return;
  }
  if (failed.length === 0 && committed.length === executable.length) {
    journal.status = "ALL_COMMITTED";
    return;
  }
  if (committed.length === 0 && rolledBack.length === 0) {
    journal.status = "FAILED";
    return;
  }
  journal.status = "PARTIAL_SUCCESS";
}

/** Targets eligible for the explicit rollback-successful-targets operation. */
export function rollbackCandidates(journal: BatchJournal): readonly string[] {
  return journal.entries.filter((entry) => entry.state === "COMMITTED").map((entry) => entry.targetKey);
}

/** Marks a rollback outcome for one target; failure moves the batch to recovery. */
export function recordRollback(journal: BatchJournal, targetKey: string, rolledBack: boolean, now: () => string): void {
  const entry = journal.entries.find((candidate) => candidate.targetKey === targetKey);
  if (entry === undefined || entry.state !== "COMMITTED") {
    return;
  }
  entry.state = rolledBack ? "ROLLED_BACK" : "ROLLBACK_FAILED";
  journal.updatedAt = now();
  if (!rolledBack) {
    journal.status = "RECOVERY_REQUIRED";
    return;
  }
  const executable = journal.entries.filter((candidate) => candidate.state !== "SKIPPED_BLOCKED");
  const allSettled = executable.every(
    (candidate) => candidate.state === "ROLLED_BACK" || candidate.state === "COMMITTED" || candidate.state === "ROLLBACK_FAILED"
  );
  if (allSettled) {
    const rollbackFailed = executable.some((candidate) => candidate.state === "ROLLBACK_FAILED");
    const anyCommitted = executable.some((candidate) => candidate.state === "COMMITTED");
    journal.status = rollbackFailed ? "RECOVERY_REQUIRED" : anyCommitted ? "PARTIAL_SUCCESS" : "ROLLED_BACK";
    journal.updatedAt = now();
  }
}

/** Journal replay after a crash: states must explain themselves. */
export function replayBatchJournal(journal: BatchJournal): {
  readonly resumable: boolean;
  readonly committedTargets: readonly string[];
  readonly needsRecovery: boolean;
  readonly detail: string;
} {
  const committedTargets = journal.entries.filter((entry) => entry.state === "COMMITTED").map((entry) => entry.targetKey);
  const needsRecovery =
    journal.status === "RECOVERY_REQUIRED" ||
    journal.entries.some((entry) => entry.state === "ROLLBACK_FAILED" || entry.state === "APPLYING");
  // An entry stuck in APPLYING is an interrupted write: not resumable without recovery.
  const resumable = !needsRecovery && journal.status === "RUNNING";
  return {
    resumable,
    committedTargets,
    needsRecovery,
    detail: needsRecovery
      ? "journal contains an APPLYING/ROLLBACK_FAILED entry; recovery must verify targets before any further mutation"
      : journal.status === "RUNNING"
        ? "batch can resume from its journal"
        : `batch settled as ${journal.status}`
  };
}
