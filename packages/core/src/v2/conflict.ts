// Conflict model + Resolution API (INH-1787). Conflicts are first-class
// domain objects with structured payloads the UI can consume directly —
// never Git error strings or ad-hoc UI state.
//
// Rule: every resolution produces a FRESH plan binding (new snapshot/revision
// digests). Resolutions never "continue executing the old plan".

import { reconcileTarget, type ReconcileBlocker } from "./reconcile-engine";
import type { ContentDigest } from "./reconcile";

export const CONFLICT_KINDS = [
  "local-vs-desired",
  "git-diverged",
  "ownership-mismatch",
  "project-rebind-mismatch",
  "ambiguous-provenance",
  "structured-semantic",
  "degraded-conversion"
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export interface ConflictPayload {
  readonly kind: ConflictKind;
  /** Stable target/subject key this conflict belongs to. */
  readonly subjectKey: string;
  readonly message: string;
  /** Structured side data — digests, keys, revisions; UI renders from these. */
  readonly sides: {
    readonly baseline: ContentDigest | null;
    readonly local: ContentDigest | null;
    readonly desired: ContentDigest | null;
  };
  /** Extra structured fields (e.g. ambiguous candidate keys, semantic key paths). */
  readonly details: Readonly<Record<string, string>>;
}

export type Conflict =
  | (ConflictPayload & { readonly conflictId: string })
  | (ConflictPayload & { readonly conflictId: string; readonly requiresDeleteConfirmation: true })
  | (ConflictPayload & { readonly conflictId: string; readonly requiresHookConfirmation: true });

export const RESOLUTION_KINDS = [
  "choose-local-capture",
  "choose-desired-apply",
  "manual-asset-edit-replan",
  "create-native-variant",
  "cancel"
] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

export interface ConflictResolutionRequest {
  readonly conflictId: string;
  readonly resolution: ResolutionKind;
  /** Digests the user actually saw when deciding (stale-resolution guard). */
  readonly decidedOn: {
    readonly local: ContentDigest | null;
    readonly desired: ContentDigest | null;
  };
}

export type ResolutionOutcome =
  | { readonly kind: "accepted"; readonly requiresReplan: true; readonly nextAction: "capture" | "apply" | "replan" | "none" }
  | { readonly kind: "rejected-stale"; readonly message: string }
  | { readonly kind: "rejected-confirmation-required"; readonly message: string };

/** High-risk resolutions always demand their own confirmation step. */
export function requiresSeparateConfirmation(conflict: Conflict): boolean {
  return "requiresDeleteConfirmation" in conflict || "requiresHookConfirmation" in conflict;
}

export function evaluateResolution(
  conflict: Conflict,
  request: ConflictResolutionRequest,
  fresh: { readonly local: ContentDigest | null; readonly desired: ContentDigest | null }
): ResolutionOutcome {
  if (request.conflictId !== conflict.conflictId) {
    return { kind: "rejected-stale", message: "resolution targets a different conflict" };
  }
  // Stale guard: the user must have decided on the SAME local/desired
  // digests that are current now. Anything else is a replan, never a
  // continuation of an old plan.
  if (request.decidedOn.local !== fresh.local || request.decidedOn.desired !== fresh.desired) {
    return {
      kind: "rejected-stale",
      message: "target changed since the conflict was shown; the conflict will be regenerated from a fresh snapshot"
    };
  }
  if (request.resolution === "choose-local-capture" && requiresSeparateConfirmation(conflict) && "requiresDeleteConfirmation" in conflict) {
    return {
      kind: "rejected-confirmation-required",
      message: "this conflict involves a delete; confirm the delete separately"
    };
  }
  if (request.resolution === "choose-desired-apply" && "requiresHookConfirmation" in conflict) {
    return {
      kind: "rejected-confirmation-required",
      message: "this conflict involves executable hooks; confirm the hook change separately"
    };
  }
  switch (request.resolution) {
    case "choose-local-capture":
      return { kind: "accepted", requiresReplan: true, nextAction: "capture" };
    case "choose-desired-apply":
      return { kind: "accepted", requiresReplan: true, nextAction: "apply" };
    case "manual-asset-edit-replan":
      return { kind: "accepted", requiresReplan: true, nextAction: "replan" };
    case "create-native-variant":
      return { kind: "accepted", requiresReplan: true, nextAction: "replan" };
    case "cancel":
      return { kind: "accepted", requiresReplan: true, nextAction: "none" };
  }
}

/** Builds the canonical conflict for a CONFLICT reconciliation + blocker context. */
export function buildConflict(input: {
  readonly conflictId: string;
  readonly kind: ConflictKind;
  readonly subjectKey: string;
  readonly message: string;
  readonly baseline: ContentDigest | null;
  readonly local: ContentDigest | null;
  readonly desired: ContentDigest | null;
  readonly details?: Readonly<Record<string, string>>;
  readonly deleteInvolved?: boolean;
  readonly hookInvolved?: boolean;
}): Conflict {
  const base: ConflictPayload = {
    kind: input.kind,
    subjectKey: input.subjectKey,
    message: input.message,
    sides: { baseline: input.baseline, local: input.local, desired: input.desired },
    details: input.details ?? {}
  };
  if (input.deleteInvolved) {
    return { ...base, conflictId: input.conflictId, requiresDeleteConfirmation: true };
  }
  if (input.hookInvolved) {
    return { ...base, conflictId: input.conflictId, requiresHookConfirmation: true };
  }
  return { ...base, conflictId: input.conflictId };
}

/** Derives conflicts from engine reconciliations (batch classification). */
export function conflictsFromReconciliations(
  entries: readonly {
    targetKey: string;
    state: ReturnType<typeof reconcileTarget>["state"];
    blockers: readonly ReconcileBlocker[];
    revisions: { baseline: ContentDigest; local: ContentDigest; desired: ContentDigest };
  }[],
  nextConflictId: () => string
): readonly Conflict[] {
  const conflicts: Conflict[] = [];
  for (const entry of entries) {
    if (entry.state === "CONFLICT") {
      conflicts.push(
        buildConflict({
          conflictId: nextConflictId(),
          kind: "local-vs-desired",
          subjectKey: entry.targetKey,
          message: "local and desired both changed since the baseline",
          baseline: entry.revisions.baseline,
          local: entry.revisions.local,
          desired: entry.revisions.desired
        })
      );
      continue;
    }
    const ownership = entry.blockers.find((blocker) => blocker.reason === "BASELINE_CORRUPT");
    if (ownership) {
      conflicts.push(
        buildConflict({
          conflictId: nextConflictId(),
          kind: "ownership-mismatch",
          subjectKey: entry.targetKey,
          message: ownership.detail,
          baseline: entry.revisions.baseline,
          local: entry.revisions.local,
          desired: entry.revisions.desired
        })
      );
    }
  }
  return conflicts;
}
