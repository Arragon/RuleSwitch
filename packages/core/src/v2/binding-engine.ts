// Binding Engine (INH-1771): one abstraction for the four frozen binding
// modes. The engine only emits intents and change metadata — it never
// writes real targets.
//
// - Mirror: full file/directory ownership.
// - StructuredMerge: only declared managed keys; unknown fields preserved
//   (STRUCTURED_MERGE_PRESERVES_UNKNOWN from the reconcile contract).
// - Generated: one target rendered from one or more canonical sources;
//   provenance records every source.
// - Native: harness-specific raw semantics, same-harness round-trip.
//
// Delete semantics: a DELETE intent is only produced when the binding is
// explicitly owned AND the ownership digest proof matches the current
// target digest. First adoption (no ownership proof) can never delete.

import type { AssetKind } from "./identity";
import type { BindingMode, ConversionGrade, ProvenanceRecord } from "./reconcile";

export interface BindingIntent {
  readonly assetKey: string;
  readonly kind: AssetKind;
  readonly mode: BindingMode;
  /** Target selection is decided by the adapter/plan layer, not here. */
  readonly targetHint: string | null;
  readonly ownership: {
    readonly requiresOwnershipProof: boolean;
    readonly firstAdoptionRequiresConfirmation: boolean;
  };
}

export type BindingModeForKind = (kind: AssetKind) => BindingMode;

export function defaultBindingModeForKind(kind: AssetKind): BindingMode {
  if (kind === "mcp" || kind === "hooks" || kind === "settings") {
    return "structured-merge";
  }
  if (kind === "native") {
    return "native";
  }
  return "mirror";
}

export function buildBindingIntents(
  assets: readonly { assetKey: string; kind: AssetKind; logicalName: string }[],
  overrides: Partial<Record<AssetKind, BindingMode>> = {}
): readonly BindingIntent[] {
  return [...assets]
    .sort((left, right) => (left.assetKey < right.assetKey ? -1 : 1))
    .map((asset) => ({
      assetKey: asset.assetKey,
      kind: asset.kind,
      mode: overrides[asset.kind] ?? defaultBindingModeForKind(asset.kind),
      targetHint: null,
      ownership: {
        requiresOwnershipProof: true,
        firstAdoptionRequiresConfirmation: true
      }
    }));
}

// ---------------------------------------------------------------------------
// Delete guard
// ---------------------------------------------------------------------------

export interface DeleteGuardInput {
  readonly mode: BindingMode;
  readonly owned: boolean;
  /** Digest recorded in the ownership ledger. */
  readonly ownershipDigest: string | null;
  /** Digest of the target as it exists right now (fresh scan). */
  readonly currentDigest: string | null;
  readonly firstAdoption: boolean;
}

export type DeleteDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export function evaluateDelete(input: DeleteGuardInput): DeleteDecision {
  if (input.firstAdoption) {
    return { allowed: false, reason: "first adoption never deletes; ownership must be confirmed first" };
  }
  if (!input.owned) {
    return { allowed: false, reason: "target is not owned by any binding" };
  }
  if (input.ownershipDigest === null || input.currentDigest === null) {
    return { allowed: false, reason: "ownership digest proof is missing" };
  }
  if (input.ownershipDigest !== input.currentDigest) {
    return {
      allowed: false,
      reason: "target changed since the ownership proof was recorded; re-own or resolve explicitly"
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Structured merge with unknown preservation
// ---------------------------------------------------------------------------

export type StructuredDocument = Record<string, unknown>;

/**
 * Merges `managed` into `base` touching only `managedKeys`; every other
 * key of `base` (unknown/unmanaged fields) is preserved byte-for-value.
 * Works for parsed JSON/YAML/TOML documents alike.
 */
export function mergeStructuredPreservingUnknown(
  base: StructuredDocument,
  managed: StructuredDocument,
  managedKeys: readonly string[]
): StructuredDocument {
  const merged: StructuredDocument = { ...base };
  for (const key of managedKeys) {
    if (Object.prototype.hasOwnProperty.call(managed, key)) {
      merged[key] = managed[key];
    } else {
      delete merged[key];
    }
  }
  return merged;
}

/** Lists which managed keys are actually present — structured adapters declare their key set from this. */
export function declaredManagedKeys(managed: StructuredDocument): readonly string[] {
  return Object.keys(managed).sort();
}

// ---------------------------------------------------------------------------
// Generated provenance (multi-source)
// ---------------------------------------------------------------------------

export interface GeneratedSourceRef {
  readonly assetKey: string;
  readonly sourceRevision: string;
}

/**
 * Builds provenance for a generated target that renders from one or more
 * canonical sources (e.g. multiple instruction files → one AGENTS.md).
 */
export function buildGeneratedProvenance(
  sources: readonly GeneratedSourceRef[],
  output: {
    readonly targetLogicalPath: string;
    readonly outputDigest: string;
    readonly converterId: string;
    readonly converterVersion: string;
    readonly conversionGrade: ConversionGrade;
    readonly recordedAt: string;
  }
): readonly ProvenanceRecord[] {
  return sources.map((source) => ({
    targetLogicalPath: output.targetLogicalPath,
    sourceAssetKey: source.assetKey,
    sourceRevision: source.sourceRevision,
    converterId: output.converterId,
    converterVersion: output.converterVersion,
    managedRegion: null,
    outputDigest: output.outputDigest,
    conversionGrade: output.conversionGrade,
    recordedAt: output.recordedAt
  }));
}
