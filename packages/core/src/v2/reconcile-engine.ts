// B/L/D Reconcile Engine (INH-1784): turns Baseline/Local/Desired digests
// plus lifecycle overlays into THE sync state, allowed actions, and blocked
// reasons. Built on the M0 frozen truth table (reconcileState) — this file
// adds the per-target engine view: blockers, actions, freshness bindings.
// Deterministic: same input → same output; ambiguous states fail closed.

import { reconcileState, recommendedAction, SYNC_STATES, type ContentDigest, type SyncAction, type SyncState } from "./reconcile";

export type BlockerReason =
  | "BLOCKED_SECRET"
  | "BLOCKED_DEPENDENCY"
  | "BLOCKED_DEGRADED"
  | "BLOCKED_HOOK_CONFIRMATION"
  | "BLOCKED_DELETE_CONFIRMATION"
  | "RECOVERY_REQUIRED"
  | "BASELINE_CORRUPT"
  | "CONVERTER_DRIFT";

export interface ReconcileBlocker {
  readonly reason: BlockerReason;
  readonly detail: string;
}

export interface TargetReconciliation {
  /** Stable target identity (repository|harness|logical path), no absolute paths. */
  readonly targetKey: string;
  readonly state: SyncState;
  readonly action: SyncAction;
  readonly blockers: readonly ReconcileBlocker[];
  /** Actions actually executable now (action minus blocked ones). */
  readonly allowedActions: readonly SyncAction[];
  /** Fresh digests the decision was made from — plans must re-bind to these. */
  readonly revisions: {
    readonly baseline: ContentDigest;
    readonly local: ContentDigest;
    readonly desired: ContentDigest;
  };
}

export interface ReconcileEngineInput {
  readonly targetKey: string;
  readonly baseline: ContentDigest;
  readonly local: ContentDigest;
  readonly desired: ContentDigest;
  /** Lifecycle overlays recorded by the engine (never derived from digests). */
  readonly overlays?: readonly BlockerReason[];
  /** True when the baseline record failed its explanation check (INH-1781). */
  readonly baselineCorrupt?: boolean;
  /** True when the converter that produced the baseline differs from the current one. */
  readonly converterDrift?: boolean;
}

const ACTION_BLOCKERS: Readonly<Record<BlockerReason, readonly SyncAction[]>> = Object.freeze({
  BLOCKED_SECRET: ["apply", "capture"],
  BLOCKED_DEPENDENCY: ["apply"],
  BLOCKED_DEGRADED: ["apply", "capture"],
  BLOCKED_HOOK_CONFIRMATION: ["apply"],
  BLOCKED_DELETE_CONFIRMATION: ["apply"],
  RECOVERY_REQUIRED: ["apply", "capture", "resolve-conflict"],
  BASELINE_CORRUPT: ["apply", "capture"],
  CONVERTER_DRIFT: ["apply"]
});

/**
 * Reconciles one target. Lifecycle states from the frozen SYNC_STATES that
 * cannot arise from digest comparison (PENDING_APPLY, PENDING_PUBLISH,
 * BLOCKED_* reasons, RECOVERY_REQUIRED) are expressed as the digest state
 * PLUS blockers — the state column stays pure so the truth table remains
 * authoritative, and UI shows state + blockers.
 */
export function reconcileTarget(input: ReconcileEngineInput): TargetReconciliation {
  const state = reconcileState({
    baseline: input.baseline,
    local: input.local,
    desired: input.desired
  });

  const blockers: ReconcileBlocker[] = [];
  if (input.baselineCorrupt) {
    blockers.push({ reason: "BASELINE_CORRUPT", detail: "baseline record failed its provenance explanation; adopt explicitly" });
  }
  if (input.converterDrift) {
    blockers.push({ reason: "CONVERTER_DRIFT", detail: "converter changed since the baseline was recorded; re-render before applying" });
  }
  for (const reason of input.overlays ?? []) {
    blockers.push({ reason, detail: overlayDetail(reason) });
  }

  const baseAction = recommendedAction(state);
  const blockedActions = new Set<SyncAction>();
  for (const blocker of blockers) {
    for (const action of ACTION_BLOCKERS[blocker.reason]) {
      blockedActions.add(action);
    }
  }
  const allowedActions = baseAction === "none" ? [] : blockedActions.has(baseAction) ? [] : [baseAction];
  // Conflict resolution stays available even when apply/capture are blocked,
  // unless recovery gate is on.
  if (state === "CONFLICT" && !blockedActions.has("resolve-conflict") && !allowedActions.includes("resolve-conflict")) {
    allowedActions.push("resolve-conflict");
  }
  // Adoption is always available for unmanaged targets unless recovery-gated.
  if (state === "UNMANAGED" && !blockedActions.has("apply")) {
    if (!allowedActions.includes("confirm-ownership")) {
      allowedActions.unshift("confirm-ownership");
    }
  }

  return {
    targetKey: input.targetKey,
    state,
    action: baseAction,
    blockers,
    allowedActions: [...allowedActions].sort(),
    revisions: {
      baseline: input.baseline,
      local: input.local,
      desired: input.desired
    }
  };
}

function overlayDetail(reason: BlockerReason): string {
  switch (reason) {
    case "BLOCKED_SECRET":
      return "a secret reference in this target cannot be resolved";
    case "BLOCKED_DEPENDENCY":
      return "a runtime dependency of the harness is missing";
    case "BLOCKED_DEGRADED":
      return "conversion is degraded and requires explicit confirmation";
    case "BLOCKED_HOOK_CONFIRMATION":
      return "executable hook changes require explicit confirmation";
    case "BLOCKED_DELETE_CONFIRMATION":
      return "a delete requires explicit confirmation with ownership proof";
    case "RECOVERY_REQUIRED":
      return "an earlier operation ended in RECOVERY_REQUIRED; resolve it first";
    case "BASELINE_CORRUPT":
      return "baseline record is unexplainable";
    case "CONVERTER_DRIFT":
      return "converter version drifted from the baseline";
  }
}

/** Batch reconcile over many targets; deterministic order by targetKey. */
export function reconcileTargets(inputs: readonly ReconcileEngineInput[]): readonly TargetReconciliation[] {
  return [...inputs]
    .sort((left, right) => (left.targetKey < right.targetKey ? -1 : 1))
    .map((input) => reconcileTarget(input));
}

/** Fail-closed check: any target with RECOVERY_REQUIRED blocks the whole batch. */
export function batchGated(reconciliations: readonly TargetReconciliation[]): boolean {
  return reconciliations.some((entry) => entry.blockers.some((blocker) => blocker.reason === "RECOVERY_REQUIRED"));
}

export { SYNC_STATES };
