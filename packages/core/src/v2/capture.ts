// M3 Capture service (INH-1777): harness-local skill modifications become
// a CapturePlan that writes ONLY the managed repo paths for that skill.
// Direct directory-copy overwrite of the config repo is structurally
// impossible — the output is a list of repo file deltas, and the caller
// (transaction/apply layer) performs the writes.
//
// Forced behavior:
// - Fresh scan + baseline comparison first (B/L/D from the frozen
//   reconcile contract); only LOCAL_CHANGED produces a capture plan.
// - No trusted baseline → BLOCKED pending ownership confirmation; there
//   is no automatic capture of an unowned target.
// - The plan binds the scanned digest; a second modification before
//   execution makes the plan stale (re-scan mismatch → refuse).

import { reconcileState } from "./reconcile";
import { fileChangeKind, skillFileDeltas, type SkillAsset, type SkillFileDelta } from "./skill-asset";

export interface RepoFileWrite {
  readonly logicalPath: string;
  readonly content: Uint8Array | null; // null = delete
  readonly executable: boolean;
}

export interface CapturePlan {
  readonly planKind: "runtime-to-git-capture";
  readonly scope: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string };
  readonly skillName: string;
  readonly changeKind: "create" | "modify" | "delete";
  /** Repo path prefix this plan is allowed to touch — nothing else may change. */
  readonly managedPathPrefix: string;
  readonly writes: readonly RepoFileWrite[];
  /** Digest of the scanned skill at plan time; execution re-verifies. */
  readonly scannedDigest: string | null;
  /** Digest of the baseline skill when one exists. */
  readonly baselineDigest: string | null;
  /**
   * Plan identity (INH-1785): the plan is bound to ALL of these inputs;
   * any change makes the plan stale and forces a rebuild.
   */
  readonly identity: {
    readonly baselineRevision: string | null;
    readonly localSnapshotDigest: string | null;
    readonly repoRevision: string;
    readonly converterId: string;
    readonly converterVersion: string;
  };
}

export type CaptureDecision =
  | { readonly ok: true; readonly plan: CapturePlan }
  | { readonly ok: false; readonly code: "OWNERSHIP_CONFIRMATION_REQUIRED" | "NOT_LOCAL_CHANGED" | "STALE_PLAN"; readonly message: string };

function repoPrefix(scope: CapturePlan["scope"], skillName: string): string {
  return scope.kind === "global"
    ? `global/skills/${skillName}/`
    : `projects/${scope.projectId}/skills/${skillName}/`;
}

/**
 * Builds a capture plan for one skill. `baseline` is the last applied
 * skill state recorded by RuleSwitch (trusted); `scanned` is the fresh
 * harness-side scan. Missing baseline → explicit ownership confirmation
 * gate, never an automatic capture.
 */
export function buildCapturePlan(input: {
  readonly scope: CapturePlan["scope"];
  readonly skillName: string;
  readonly baseline: SkillAsset | null;
  readonly scanned: SkillAsset | null;
  /** Plan identity inputs (INH-1785); missing repoRevision refuses the plan. */
  readonly planIdentity: {
    readonly baselineRevision: string | null;
    readonly repoRevision: string;
    readonly converterId: string;
    readonly converterVersion: string;
  };
}): CaptureDecision {
  const { scope, skillName, baseline, scanned } = input;

  if (input.planIdentity.repoRevision.trim().length === 0) {
    return {
      ok: false,
      code: "NOT_LOCAL_CHANGED",
      message: "capture plan requires the current repo revision binding"
    };
  }

  if (baseline === null && scanned !== null) {
    return {
      ok: false,
      code: "OWNERSHIP_CONFIRMATION_REQUIRED",
      message: `skill '${skillName}' has no trusted baseline; confirm ownership before capture`
    };
  }

  const state = reconcileState({
    baseline: baseline === null ? null : baseline.digest,
    local: scanned === null ? null : scanned.digest,
    desired: baseline === null ? null : baseline.digest
  });

  if (baseline !== null && scanned !== null && state !== "LOCAL_CHANGED") {
    if (state === "CLEAN") {
      return { ok: false, code: "NOT_LOCAL_CHANGED", message: `skill '${skillName}' matches its baseline; nothing to capture` };
    }
    return {
      ok: false,
      code: "NOT_LOCAL_CHANGED",
      message: `skill '${skillName}' reconcile state is ${state}; capture only applies to LOCAL_CHANGED`
    };
  }

  const changeKind = fileChangeKind(baseline, scanned);
  if (changeKind === "unchanged") {
    return { ok: false, code: "NOT_LOCAL_CHANGED", message: `skill '${skillName}' is unchanged` };
  }
  if (changeKind === "create") {
    return { ok: false, code: "OWNERSHIP_CONFIRMATION_REQUIRED", message: "unreachable without baseline" };
  }

  const prefix = repoPrefix(scope, skillName);
  const deltas: readonly SkillFileDelta[] = skillFileDeltas(baseline, scanned);
  const writes: RepoFileWrite[] = deltas.map((delta) => ({
    logicalPath: `${prefix}${delta.relativePath}`,
    content: delta.after === null ? null : delta.after.content,
    executable: delta.after?.executable ?? false
  }));

  return {
    ok: true,
    plan: {
      planKind: "runtime-to-git-capture",
      scope,
      skillName,
      changeKind,
      managedPathPrefix: prefix,
      writes,
      scannedDigest: scanned === null ? null : scanned.digest,
      baselineDigest: baseline === null ? null : baseline.digest,
      identity: {
        baselineRevision: input.planIdentity.baselineRevision,
        localSnapshotDigest: scanned === null ? null : scanned.digest,
        repoRevision: input.planIdentity.repoRevision,
        converterId: input.planIdentity.converterId,
        converterVersion: input.planIdentity.converterVersion
      }
    }
  };
}

/**
 * Execution-time staleness guard: the harness skill must still hash to the
 * plan's scanned digest, and every plan-identity input must be unchanged,
 * or the plan is refused.
 */
export function verifyCapturePlanFreshness(
  plan: CapturePlan,
  currentScanned: SkillAsset | null,
  currentIdentity?: {
    readonly repoRevision: string;
    readonly converterId: string;
    readonly converterVersion: string;
  }
): CaptureDecision {
  const currentDigest = currentScanned === null ? null : currentScanned.digest;
  if (plan.scannedDigest !== currentDigest) {
    return {
      ok: false,
      code: "STALE_PLAN",
      message: `skill '${plan.skillName}' changed again after the capture plan was built; rebuild the plan`
    };
  }
  if (currentIdentity) {
    const drifted =
      currentIdentity.repoRevision !== plan.identity.repoRevision ||
      currentIdentity.converterId !== plan.identity.converterId ||
      currentIdentity.converterVersion !== plan.identity.converterVersion;
    if (drifted) {
      return {
        ok: false,
        code: "STALE_PLAN",
        message: `plan identity drifted (repo/converter) for skill '${plan.skillName}'; rebuild the plan`
      };
    }
  }
  return { ok: true, plan };
}
