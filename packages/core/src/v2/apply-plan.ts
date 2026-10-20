// Apply-plan policy (INH-1849) + in-repo collection comparison (INH-1850).
//
// buildApplyPlan turns (asset set × harness instances × scopes) into unique
// per-target plan entries honoring the frozen ApplyMode contract
// (overwrite / merge-add / add-only / per-target override), with explicit
// blocked reasons — an unbound project or unsupported mapping never fakes
// success.
//
// compareCollections compares two harness configuration collections INSIDE
// the same Git repo (source set vs target set) using only trusted common
// baselines; without one it reports unknown-baseline instead of guessing.

import { resolveApplyMode, collectionComparisonConfidence, type ApplyMode, type BaseApplyMode } from "./reconcile";
import type { AssetKind } from "./identity";
import type { HarnessInstanceId, ProjectId, RepositoryId } from "./identity";

// ---------------------------------------------------------------------------
// INH-1849: apply-plan policy
// ---------------------------------------------------------------------------

export interface ApplyTargetInput {
  readonly targetKey: string;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly scope: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: ProjectId };
  readonly assetKind: AssetKind;
  readonly requestedMode: ApplyMode;
  /** Fresh digests of the target's current local state (from the scanner). */
  readonly localDigest: string | null;
  /**
   * Aggregate digest of the bytes that WOULD be written for this target.
   * `noop` is decided by comparing this to `localDigest`; without it the
   * planner cannot prove the target is already in sync and must re-apply.
   */
  readonly sourceDigest?: string | null;
  /** True when a trusted baseline/ownership record exists for the target. */
  readonly hasOwnership: boolean;
  /** Adapter capability for this kind on this harness (read-write etc). */
  readonly capability: "read-write" | "read-only" | "unsupported";
  readonly runtimeReady: boolean;
  readonly secretReady: boolean;
}

export type ApplyPlanEntryAction = "apply" | "skip-add-only-exists" | "needs-adoption" | "blocked" | "noop";

export interface ApplyPlanEntry {
  readonly targetKey: string;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly scope: ApplyTargetInput["scope"];
  readonly assetKind: AssetKind;
  readonly effectiveMode: BaseApplyMode;
  readonly action: ApplyPlanEntryAction;
  readonly blockedReason: string | null;
  readonly requiresExplicitConfirmation: boolean;
  /** Fresh digest binding — any input change after Preview forces replan. */
  readonly localDigest: string | null;
  readonly planRevision: string;
}

export type ApplyPlanResult =
  | { readonly ok: true; readonly entries: readonly ApplyPlanEntry[]; readonly planRevision: string }
  | { readonly ok: false; readonly message: string };

/**
 * Builds per-target plan entries. Duplicate targets are a hard error (the
 * plan must be unambiguous); blocked targets still appear with reasons so
 * the batch journal can record them.
 */
export function buildApplyPlan(
  targets: readonly ApplyTargetInput[],
  sourceDeleted: boolean,
  planRevision: string
): ApplyPlanResult {
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.targetKey)) {
      return { ok: false, message: `duplicate plan target: ${target.targetKey}` };
    }
    seen.add(target.targetKey);
  }
  if (targets.length === 0) {
    return { ok: false, message: "empty target selection" };
  }

  const entries: ApplyPlanEntry[] = [];
  for (const target of [...targets].sort((left, right) => (left.targetKey < right.targetKey ? -1 : 1))) {
    const modeDecision = resolveApplyMode(target.assetKind, target.requestedMode);
    const entry = buildEntry(target, modeDecision, sourceDeleted, planRevision);
    entries.push(entry);
  }
  return { ok: true, entries, planRevision };
}

function buildEntry(
  target: ApplyTargetInput,
  modeDecision: { allowed: boolean; requiresExplicitConfirmation: boolean; reason: string | null },
  sourceDeleted: boolean,
  planRevision: string
): ApplyPlanEntry {
  const base = {
    targetKey: target.targetKey,
    harnessInstanceId: target.harnessInstanceId,
    scope: target.scope,
    assetKind: target.assetKind,
    localDigest: target.localDigest,
    planRevision
  };
  const effectiveMode =
    typeof target.requestedMode === "string" ? target.requestedMode : target.requestedMode.defaultMode;

  const blocked = (reason: string): ApplyPlanEntry => ({
    ...base,
    effectiveMode,
    action: "blocked",
    blockedReason: reason,
    requiresExplicitConfirmation: false
  });

  if (target.capability !== "read-write") {
    return blocked(
      target.capability === "unsupported"
        ? `harness does not support kind '${target.assetKind}'`
        : `harness mapping is read-only for kind '${target.assetKind}'`
    );
  }
  if (!target.runtimeReady) {
    return blocked("harness runtime dependency missing");
  }
  if (!target.secretReady) {
    return blocked("a secret reference cannot be resolved");
  }
  if (sourceDeleted) {
    return blocked("source asset deleted in the repository; delete requires explicit confirmation");
  }
  if (!modeDecision.allowed) {
    return {
      ...base,
      effectiveMode,
      action: "blocked",
      blockedReason: modeDecision.reason ?? "mode not allowed for this asset kind",
      requiresExplicitConfirmation: true
    };
  }
  // add-only means "never touch an existing target". It therefore cannot also
  // require an adoption decision: the local file is left exactly as it is, so
  // this check must precede the ownership gate below. Treating it as
  // needs-adoption would ask the user to consent to a write that must not
  // happen.
  if (effectiveMode === "add-only" && target.localDigest !== null) {
    return {
      ...base,
      effectiveMode,
      action: "skip-add-only-exists",
      blockedReason: "add-only: target already exists and is skipped",
      requiresExplicitConfirmation: false
    };
  }
  if (!target.hasOwnership && target.localDigest !== null) {
    return {
      ...base,
      effectiveMode,
      action: "needs-adoption",
      blockedReason: "target exists without a RuleSwitch baseline; confirm ownership first",
      requiresExplicitConfirmation: true
    };
  }
  // Already in sync: the local bytes equal what we would write. This used to
  // compare against `planRevision` (a plan-wide hash), which could never
  // match a per-target digest, so `noop` was unreachable and every apply
  // rewrote an unchanged target.
  const unchanged =
    target.localDigest !== null &&
    target.sourceDigest !== undefined &&
    target.sourceDigest !== null &&
    target.localDigest === target.sourceDigest;
  if (unchanged) {
    return { ...base, effectiveMode, action: "noop", blockedReason: null, requiresExplicitConfirmation: false };
  }
  return {
    ...base,
    effectiveMode,
    action: "apply",
    blockedReason: null,
    requiresExplicitConfirmation: modeDecision.requiresExplicitConfirmation
  };
}

// ---------------------------------------------------------------------------
// INH-1850: in-repo collection comparison
// ---------------------------------------------------------------------------

export type CollectionAssetRelation =
  | "identical"
  | "source-only"
  | "target-only"
  | "source-updated"
  | "target-modified"
  | "both-modified"
  | "unsupported";

export interface CollectionAssetDiff {
  /** Semantic identity: kind + logicalName (scope-free within the comparison). */
  readonly semanticKey: string;
  readonly kind: AssetKind;
  readonly relation: CollectionAssetRelation;
  readonly sourceDigest: string | null;
  readonly targetDigest: string | null;
  readonly baselineDigest: string | null;
}

export interface CollectionComparison {
  readonly confidence: "trusted" | "unknown-baseline";
  readonly repositoryId: RepositoryId;
  readonly diffs: readonly CollectionAssetDiff[];
  /** True when any relation requires conflict resolution before sync. */
  readonly hasBlockingDiffs: boolean;
}

export interface CollectionSideInput {
  readonly label: string;
  readonly assets: readonly { readonly kind: AssetKind; readonly logicalName: string; readonly digest: string }[];
  readonly supportedKinds: ReadonlySet<AssetKind>;
}

/**
 * Compares two repo-internal collections. Relations need a trusted common
 * baseline per asset; without one the relation is reported against an
 * unknown-baseline confidence and single/double modification claims are
 * NOT made.
 */
export function compareCollections(input: {
  readonly repositoryId: RepositoryId;
  readonly source: CollectionSideInput;
  readonly target: CollectionSideInput;
  /** Trusted baseline digests per semantic key, when recorded. */
  readonly baselines: Readonly<Record<string, string>>;
  readonly trustedBaseline: boolean;
}): CollectionComparison {
  const semantic = (kind: AssetKind, logicalName: string): string => `${kind}|${logicalName}`;
  const sourceMap = new Map(input.source.assets.map((asset) => [semantic(asset.kind, asset.logicalName), asset]));
  const targetMap = new Map(input.target.assets.map((asset) => [semantic(asset.kind, asset.logicalName), asset]));
  const keys = [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort();

  const diffs: CollectionAssetDiff[] = [];
  for (const key of keys) {
    const source = sourceMap.get(key) ?? null;
    const target = targetMap.get(key) ?? null;
    const kind = (source ?? target)!.kind;
    if (!input.source.supportedKinds.has(kind) || !input.target.supportedKinds.has(kind)) {
      diffs.push({
        semanticKey: key,
        kind,
        relation: "unsupported",
        sourceDigest: source?.digest ?? null,
        targetDigest: target?.digest ?? null,
        baselineDigest: input.baselines[key] ?? null
      });
      continue;
    }
    const baselineDigest = input.baselines[key] ?? null;
    const relation = classifyRelation(source?.digest ?? null, target?.digest ?? null, baselineDigest, input.trustedBaseline);
    diffs.push({
      semanticKey: key,
      kind,
      relation,
      sourceDigest: source?.digest ?? null,
      targetDigest: target?.digest ?? null,
      baselineDigest
    });
  }

  return {
    confidence: collectionComparisonConfidence({ trustedCommonBaseline: input.trustedBaseline, commonRevision: null }),
    repositoryId: input.repositoryId,
    diffs,
    hasBlockingDiffs: diffs.some((diff) => diff.relation === "both-modified" || diff.relation === "unsupported")
  };
}

function classifyRelation(
  sourceDigest: string | null,
  targetDigest: string | null,
  baselineDigest: string | null,
  trusted: boolean
): CollectionAssetRelation {
  if (sourceDigest !== null && targetDigest !== null && sourceDigest === targetDigest) {
    return "identical";
  }
  if (sourceDigest !== null && targetDigest === null) {
    return "source-only";
  }
  if (sourceDigest === null && targetDigest !== null) {
    return "target-only";
  }
  // Both exist and differ:
  if (!trusted || baselineDigest === null) {
    // Cannot claim single/double modification without a trusted baseline;
    // surface as both-modified-but-unverified? No — fail closed to a
    // relation the UI must confirm manually.
    return "both-modified";
  }
  if (sourceDigest === baselineDigest && targetDigest !== baselineDigest) {
    return "target-modified";
  }
  if (targetDigest === baselineDigest && sourceDigest !== baselineDigest) {
    return "source-updated";
  }
  return "both-modified";
}

/** Target-only assets are preserved by default; explicit delete needs proof. */
export function syncableRelations(): readonly CollectionAssetRelation[] {
  return ["source-only", "source-updated", "identical"];
}
