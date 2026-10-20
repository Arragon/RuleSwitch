// Frozen M0 contract (INH-1754): Binding modes, provenance, B/L/D reconcile
// state model, and ApplyMode policy. The reconcile function is a pure
// deterministic function of content digests only — no mtimes, no
// last-write-wins. Later Capture/Apply/Conflict implementations must reuse
// these states instead of inventing their own.

import { z } from "zod";

import type { AssetKind } from "./identity";

// ---------------------------------------------------------------------------
// Binding modes
// ---------------------------------------------------------------------------

export const BINDING_MODES = ["mirror", "structured-merge", "generated", "native"] as const;
export type BindingMode = (typeof BINDING_MODES)[number];
export const bindingModeSchema = z.enum(BINDING_MODES);

// ---------------------------------------------------------------------------
// Conversion grades (shared with Adapter v2)
// ---------------------------------------------------------------------------

export const CONVERSION_GRADES = ["lossless", "equivalent", "degraded", "unsupported"] as const;
export type ConversionGrade = (typeof CONVERSION_GRADES)[number];
export const conversionGradeSchema = z.enum(CONVERSION_GRADES);

// ---------------------------------------------------------------------------
// Provenance record
// ---------------------------------------------------------------------------

export const provenanceRecordSchema = z.strictObject({
  /** Logical path of the rendered target inside the harness instance. */
  targetLogicalPath: z.string().min(1),
  /** Serialized "scope|kind|logicalName" asset key (see identity.serializeAssetKey). */
  sourceAssetKey: z.string().min(1),
  /** Git revision or revision-aggregate digest the render was produced from. */
  sourceRevision: z.string().min(1),
  converterId: z.string().min(1),
  converterVersion: z.string().min(1),
  /**
   * Managed region for structured bindings (e.g. JSON pointer list or
   * top-level key), or null for whole-file bindings.
   */
  managedRegion: z.string().min(1).nullable(),
  outputDigest: z.string().min(1),
  conversionGrade: conversionGradeSchema,
  recordedAt: z.string().datetime({ offset: true })
});
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;

// ---------------------------------------------------------------------------
// Reconcile: B / L / D
// ---------------------------------------------------------------------------

export const SYNC_STATES = [
  "CLEAN",
  "LOCAL_CHANGED",
  "REMOTE_CHANGED",
  "CONFLICT",
  "UNMANAGED",
  "PENDING_APPLY",
  "PENDING_PUBLISH",
  "BLOCKED_SECRET",
  "BLOCKED_DEPENDENCY",
  "DEGRADED",
  "RECOVERY_REQUIRED"
] as const;
export type SyncState = (typeof SYNC_STATES)[number];
export const syncStateSchema = z.enum(SYNC_STATES);

/**
 * Content digest: null means "absent". Absence is a first-class value:
 * two absent states are equal; absent never equals a digest.
 */
export type ContentDigest = string | null;

export interface ReconcileInput {
  /** B — last applied baseline digest, null when the target is not yet managed. */
  readonly baseline: ContentDigest;
  /** L — current local harness state digest (fresh scan). */
  readonly local: ContentDigest;
  /** D — desired state digest from Git (repo HEAD or working draft). */
  readonly desired: ContentDigest;
}

const digestsEqual = (a: ContentDigest, b: ContentDigest): boolean => a === b;

/**
 * Deterministic B/L/D classification. "BOTH_CHANGED" from the issue maps to
 * CONFLICT, except when local and desired converged to the same content,
 * which is CLEAN (both sides made the identical change).
 *
 * Truth table (digest equality only):
 *   B=null                    → UNMANAGED  (first adoption: preview + ownership confirmation)
 *   B=L=D                     → CLEAN
 *   L≠B, D=B                  → LOCAL_CHANGED   (capture/publish candidate)
 *   L=B, D≠B                  → REMOTE_CHANGED  (apply candidate)
 *   L≠B, D≠B, L=D             → CLEAN           (converged)
 *   L≠B, D≠B, L≠D             → CONFLICT        (explicit resolution required)
 *
 * PENDING_APPLY / PENDING_PUBLISH / BLOCKED_SECRET / BLOCKED_DEPENDENCY /
 * DEGRADED / RECOVERY_REQUIRED are lifecycle overlays assigned by the sync
 * engine from operation state, never from digest comparison alone.
 */
export function reconcileState(input: ReconcileInput): SyncState {
  const { baseline: b, local: l, desired: d } = input;
  if (b === null) {
    return "UNMANAGED";
  }
  const localChanged = !digestsEqual(l, b);
  const desiredChanged = !digestsEqual(d, b);
  if (!localChanged && !desiredChanged) {
    return "CLEAN";
  }
  if (localChanged && !desiredChanged) {
    return "LOCAL_CHANGED";
  }
  if (!localChanged && desiredChanged) {
    return "REMOTE_CHANGED";
  }
  return digestsEqual(l, d) ? "CLEAN" : "CONFLICT";
}

/** Recommended next action for a reconciled target. */
export type SyncAction =
  | "none"
  | "capture"
  | "apply"
  | "resolve-conflict"
  | "confirm-ownership";

export function recommendedAction(state: SyncState): SyncAction {
  switch (state) {
    case "CLEAN":
      return "none";
    case "LOCAL_CHANGED":
      return "capture";
    case "REMOTE_CHANGED":
      return "apply";
    case "CONFLICT":
      return "resolve-conflict";
    case "UNMANAGED":
      return "confirm-ownership";
    default:
      // Lifecycle states are resolved by their owning operation, not by
      // digest reconcile.
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Apply modes (2026-10-07 prototype alignment)
// ---------------------------------------------------------------------------

export const APPLY_MODES = ["overwrite", "merge-add", "add-only"] as const;
export type BaseApplyMode = (typeof APPLY_MODES)[number];
export const baseApplyModeSchema = z.enum(APPLY_MODES);

export interface PerTargetApplyMode {
  readonly kind: "per-target";
  /** Overrides per harness-instance target; targets absent from the map use defaultMode. */
  readonly defaultMode: BaseApplyMode;
  readonly targets: Readonly<Record<string, BaseApplyMode>>;
}

export type ApplyMode = BaseApplyMode | PerTargetApplyMode;

export const perTargetApplyModeSchema: z.ZodType<PerTargetApplyMode> = z.strictObject({
  kind: z.literal("per-target"),
  defaultMode: baseApplyModeSchema,
  targets: z.record(z.string(), baseApplyModeSchema)
});

/**
 * Plan kinds are strictly separated (2026-10-07 supplement): a repo-set
 * comparison plan writes only the repo working tree; a Git→runtime apply
 * plan writes only harness targets; a runtime→Git capture plan writes only
 * managed repo paths. Each plan carries its own fresh revision binding,
 * ownership proofs, and snapshot reference; plans are never interchangeable.
 */
export const PLAN_KINDS = ["repo-set-sync", "git-to-runtime-apply", "runtime-to-git-capture"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const planKindSchema = z.enum(PLAN_KINDS);

export interface PlanBinding {
  readonly planId: string;
  readonly planKind: PlanKind;
  /** Fresh revision captured when the plan was built; stale on mismatch. */
  readonly revision: string;
  readonly snapshotRef: string | null;
  readonly ownershipProofRefs: readonly string[];
}
export const planBindingSchema: z.ZodType<PlanBinding> = z.strictObject({
  planId: z.string().min(1),
  planKind: planKindSchema,
  revision: z.string().min(1),
  snapshotRef: z.string().min(1).nullable(),
  ownershipProofRefs: z.array(z.string().min(1))
});

/**
 * Textual/directory asset kinds cannot be safely auto-merged line-by-line;
 * merge-add on them must be blocked unless the user made an explicit
 * per-target choice. Structured kinds (mcp, hooks, settings) support
 * structured merge with unknown-field preservation, which overwrite never
 * disables (STRUCTURED_MERGE_PRESERVES_UNKNOWN).
 */
const TEXTUAL_ASSET_KINDS: readonly AssetKind[] = [
  "instructions",
  "skills",
  "commands",
  "prompts",
  "agents",
  "native"
];

export const STRUCTURED_MERGE_PRESERVES_UNKNOWN = true as const;

export interface ApplyModeDecision {
  readonly allowed: boolean;
  readonly requiresExplicitConfirmation: boolean;
  readonly reason: string | null;
}

export function resolveApplyMode(
  assetKind: AssetKind,
  requested: ApplyMode
): ApplyModeDecision {
  if (typeof requested !== "string") {
    // per-target: each explicit target choice is a user decision.
    return { allowed: true, requiresExplicitConfirmation: false, reason: null };
  }
  if (requested !== "merge-add") {
    return { allowed: true, requiresExplicitConfirmation: false, reason: null };
  }
  if (TEXTUAL_ASSET_KINDS.includes(assetKind)) {
    return {
      allowed: false,
      requiresExplicitConfirmation: true,
      reason: `merge-add cannot safely auto-merge textual ${assetKind} assets; choose per-target modes`
    };
  }
  return { allowed: true, requiresExplicitConfirmation: false, reason: null };
}

/**
 * Cross-collection (repo set ↔ repo set) comparison requires a trusted
 * common baseline. Without one, differences are reported as unknown rather
 * than guessed.
 */
export interface CollectionComparisonBasis {
  readonly trustedCommonBaseline: boolean;
  readonly commonRevision: string | null;
}

export function collectionComparisonConfidence(
  basis: CollectionComparisonBasis
): "trusted" | "unknown-baseline" {
  return basis.trustedCommonBaseline ? "trusted" : "unknown-baseline";
}

// ---------------------------------------------------------------------------
// Generated reverse mapping (manual attribution rule)
// ---------------------------------------------------------------------------

/**
 * When a Generated target changed locally, the change can be attributed to a
 * canonical asset only if exactly one candidate provenance matches the
 * current output digest. Zero or multiple candidates require explicit
 * human attribution or saving the delta as a native variant — never an
 * implicit guess.
 */
export type ReverseMappingOutcome =
  | { readonly kind: "unique"; readonly assetKey: string }
  | { readonly kind: "ambiguous"; readonly candidateCount: number }
  | { readonly kind: "unattributable" };

export function attributeGeneratedChange(
  candidates: readonly { assetKey: string; expectedDigest: string }[],
  actualDigest: string
): ReverseMappingOutcome {
  const matches = candidates.filter((candidate) => candidate.expectedDigest === actualDigest);
  const uniqueMatch = matches[0];
  if (matches.length === 1 && uniqueMatch !== undefined) {
    return { kind: "unique", assetKey: uniqueMatch.assetKey };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidateCount: matches.length };
  }
  return { kind: "unattributable" };
}
