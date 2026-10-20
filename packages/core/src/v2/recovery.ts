// Recovery strategy (INH-1788 pending publish, INH-1790 crash recovery +
// history rebind). Pure decision logic; hosts execute.
//
// - Pending publish: after restart, re-fetch and classify. FF-compatible
//   remote → retry push allowed; advanced/diverged → conflict (never
//   amend/rebase/force); missing local commit (reset externally) → the
//   pending record is voided as unexplainable, never faked as synced.
// - Interrupted operations: phase-based verdicts. A "state unknown but
//   writes allowed" outcome is impossible by construction here.
// - History rebind: Phase A random-ID history is legacy-read-only; v2
//   history entries rebind through stable identities only.

import type { RepositoryId } from "./identity";

// ---------------------------------------------------------------------------
// Pending publish (INH-1788)
// ---------------------------------------------------------------------------

export interface PendingPublishRecord {
  readonly repositoryId: RepositoryId;
  readonly pendingRevision: string;
  readonly captureOperationId: string;
  readonly branch: string;
  readonly recordedAt: string;
}

export type RemoteRelationAfterFetch = "up-to-date" | "behind-ff" | "ahead" | "diverged" | "unreachable" | "branch-missing";

export type PendingPublishVerdict =
  | { readonly action: "retry-push" }
  | { readonly action: "conflict"; readonly reason: string }
  | { readonly action: "void"; readonly reason: string };

export function decidePendingPublish(input: {
  readonly record: PendingPublishRecord;
  readonly relation: RemoteRelationAfterFetch;
  /** True when the pending revision is still reachable from HEAD. */
  readonly commitStillPresent: boolean;
  readonly headRevision: string | null;
}): PendingPublishVerdict {
  if (!input.commitStillPresent) {
    return {
      action: "void",
      reason: `pending commit ${input.record.pendingRevision} is no longer reachable (external reset); the pending publish record cannot be honored`
    };
  }
  if (input.headRevision !== null && input.headRevision !== input.record.pendingRevision && input.relation === "up-to-date") {
    return {
      action: "void",
      reason: "HEAD moved past the pending revision while the remote stayed put; re-evaluate the branch state"
    };
  }
  switch (input.relation) {
    case "up-to-date":
      return { action: "retry-push" };
    case "behind-ff":
      // Remote advanced but our commit sits on top after an FF would lose
      // it — this is the diverged case in disguise. FF-only policy: the
      // push retry is only safe when remote is strictly behind our commit.
      return {
        action: "conflict",
        reason: "remote advanced; fast-forwarding would drop the pending commit — resolve explicitly (no rebase/force)"
      };
    case "ahead":
      return { action: "retry-push" };
    case "diverged":
      return { action: "conflict", reason: "local and remote diverged; explicit resolution required (no amend/rebase/force)" };
    case "branch-missing":
      return { action: "retry-push" };
    case "unreachable":
      return { action: "conflict", reason: "remote unreachable; the local commit is retained as pending publish" };
  }
}

// ---------------------------------------------------------------------------
// Interrupted operation phases (INH-1790)
// ---------------------------------------------------------------------------

export const OPERATION_PHASES = [
  "PLANNED",
  "PREFLIGHT",
  "SNAPSHOTTED",
  "APPLYING",
  "VERIFYING",
  "COMMITTED",
  "FAILED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "RECOVERY_REQUIRED"
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number];

export type RecoveryVerdict =
  | { readonly action: "safe-rollback"; readonly detail: string }
  | { readonly action: "safe-resume"; readonly detail: string }
  | { readonly action: "manual-recovery"; readonly detail: string; readonly gateMutations: true }
  | { readonly action: "no-op"; readonly detail: string };

/**
 * Phase-based verdict for an interrupted operation found at startup.
 * PLANNED/PREFLIGHT/SNAPSHOTTED made no target writes → safe rollback of
 * the ledger (nothing to restore). APPLYING/VERIFYING may have written →
 * manual recovery with a mutation gate. Terminal phases → no-op.
 */
export function verdictForInterruptedPhase(phase: OperationPhase, snapshotRef: string | null): RecoveryVerdict {
  switch (phase) {
    case "PLANNED":
    case "PREFLIGHT":
      return { action: "safe-rollback", detail: "no target writes were made; close the ledger" };
    case "SNAPSHOTTED":
      return {
        action: "safe-rollback",
        detail: snapshotRef ? `snapshot ${snapshotRef} exists but no writes were made; close the ledger` : "no writes were made; close the ledger"
      };
    case "APPLYING":
      return {
        action: "manual-recovery",
        detail: "the apply was interrupted mid-write; targets must be inspected against the snapshot before anything else runs",
        gateMutations: true
      };
    case "VERIFYING":
      return {
        action: "manual-recovery",
        detail: "verification did not complete; the target state is unknown — inspect before continuing",
        gateMutations: true
      };
    case "ROLLING_BACK":
      return {
        action: "manual-recovery",
        detail: "a rollback itself was interrupted; targets may be partially restored",
        gateMutations: true
      };
    case "FAILED":
      return { action: "safe-rollback", detail: "operation failed cleanly; roll back from the snapshot" };
    case "COMMITTED":
    case "ROLLED_BACK":
    case "RECOVERY_REQUIRED":
      return { action: "no-op", detail: `operation already terminal (${phase})` };
  }
}

// ---------------------------------------------------------------------------
// History rebind (INH-1790)
// ---------------------------------------------------------------------------

export interface LegacyHistoryEntry {
  readonly workspaceId: string; // Phase A session-random id
  readonly createdAt: string;
  readonly summary: string;
}

export type HistoryRebindOutcome =
  | { readonly kind: "v2-bound"; readonly repositoryId: RepositoryId }
  | { readonly kind: "legacy-read-only"; readonly workspaceId: string; readonly reason: string };

/**
 * Phase A history entries carry session-random workspace IDs with no
 * origin/identity information: they cannot be proven to belong to any
 * repository, so they are kept read-only (never deleted, never guessed
 * onto a stable identity). Only v2 entries (written with stable IDs) bind.
 */
export function rebindHistoryEntry(entry: LegacyHistoryEntry, repositoryId: RepositoryId | null): HistoryRebindOutcome {
  if (repositoryId === null) {
    return {
      kind: "legacy-read-only",
      workspaceId: entry.workspaceId,
      reason: "Phase A random workspace id carries no repository identity; kept as legacy read-only evidence"
    };
  }
  return { kind: "v2-bound", repositoryId };
}

/** Root identity mismatch blocks automatic recovery actions. */
export function rootIdentityMatches(recorded: string, current: string): boolean {
  return recorded === current;
}
