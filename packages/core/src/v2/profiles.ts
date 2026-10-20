// Profile + Global/Project/Harness-variant precedence resolver (INH-1770).
//
// Frozen composition order (baseline §4):
//   Global Shared → Selected Profile → Global Harness Variant
//   → Project Shared → Project Harness Variant
//
// Later layers override earlier ones per semantic key (the serialized asset
// key). Two definitions of the SAME key inside ONE layer are an
// unorderable conflict → the whole resolution is BLOCKED (never implicit
// last-write-wins). Profile replacement content overrides the global asset
// bytes; the provenance chain records which layer produced each key.

import type { StableIdHasher } from "./identity";
import { serializeAssetKey, type AdapterId, type AssetKind, type ProjectId } from "./identity";
import type { InventoryAsset, RepoInventory } from "./repo-layout";
import { utf8Encode } from "./utf8";

export const PRECEDENCE_LAYERS = [
  "global-shared",
  "profile",
  "global-harness-variant",
  "project-shared",
  "project-harness-variant"
] as const;
export type PrecedenceLayer = (typeof PRECEDENCE_LAYERS)[number];

export interface ResolvedAsset {
  readonly assetKey: string;
  readonly kind: AssetKind;
  readonly logicalName: string;
  readonly content: Uint8Array;
  readonly contentDigest: string;
  readonly provenance: readonly { readonly layer: PrecedenceLayer; readonly sourceLogicalPath: string }[];
}

export type ResolutionResult =
  | { readonly ok: true; readonly assets: readonly ResolvedAsset[]; readonly notes: readonly string[] }
  | { readonly ok: false; readonly blockedReason: string };

export interface ResolveInput {
  readonly inventory: RepoInventory;
  readonly profile: string | null;
  readonly projectId: ProjectId | null;
  readonly adapterId: AdapterId;
}

function layerOf(asset: InventoryAsset, input: ResolveInput): PrecedenceLayer | null {
  if (asset.kind === "native") {
    const [owner, ...rest] = asset.logicalName.split("/");
    if (owner !== input.adapterId || rest.length === 0) {
      return null;
    }
    return asset.scope.kind === "global" ? "global-harness-variant" : "project-harness-variant";
  }
  if (asset.scope.kind === "global") {
    return "global-shared";
  }
  return "project-shared";
}

export function resolveAssetSet(input: ResolveInput, hasher: StableIdHasher): ResolutionResult {
  const notes: string[] = [];
  const selectedProfile =
    input.profile === null
      ? null
      : (input.inventory.profiles.find((profile) => profile.name === input.profile) ?? null);

  if (input.profile !== null && selectedProfile === null) {
    return { ok: false, blockedReason: `profile '${input.profile}' is not defined in this repository` };
  }
  if (input.projectId !== null && !input.inventory.projects.some((project) => project.projectId === input.projectId)) {
    return { ok: false, blockedReason: `project '${input.projectId}' is not defined in this repository` };
  }

  const buckets = new Map<PrecedenceLayer, Map<string, InventoryAsset>>();
  for (const asset of input.inventory.assets) {
    const scopeMatches =
      asset.scope.kind === "global" || (input.projectId !== null && asset.scope.kind === "project" && asset.scope.projectId === input.projectId);
    if (!scopeMatches) {
      continue;
    }
    const layer = layerOf(asset, input);
    if (layer === null) {
      continue;
    }
    const bucket = buckets.get(layer) ?? new Map<string, InventoryAsset>();
    // Semantic key is scope-free: later layers override earlier ones for
    // the same kind + logical name (project beats global, variant beats
    // shared). The winning asset keeps its full serialized key.
    const key = `${asset.kind}|${asset.logicalName}`;
    const existing = bucket.get(key);
    if (existing !== undefined) {
      return {
        ok: false,
        blockedReason: `unorderable conflict in layer '${layer}': '${key}' defined by both ${existing.sourceLogicalPath} and ${asset.sourceLogicalPath}`
      };
    }
    bucket.set(key, asset);
    buckets.set(layer, bucket);
  }

  if (!buckets.has("global-harness-variant")) {
    notes.push(`no native variants for adapter '${input.adapterId}' in global scope`);
  }

  const resolved = new Map<string, ResolvedAsset>();
  const apply = (layer: PrecedenceLayer, asset: InventoryAsset, replacedBy: string | null): void => {
    const semanticKey = `${asset.kind}|${asset.logicalName}`;
    const provenance: { layer: PrecedenceLayer; sourceLogicalPath: string }[] = [];
    if (replacedBy !== null) {
      provenance.push({ layer: "profile", sourceLogicalPath: replacedBy });
    }
    provenance.push({ layer, sourceLogicalPath: asset.sourceLogicalPath });
    resolved.set(semanticKey, {
      assetKey: serializeAssetKey(asset),
      kind: asset.kind,
      logicalName: asset.logicalName,
      content: asset.content,
      contentDigest: asset.contentDigest,
      provenance
    });
  };

  for (const layer of PRECEDENCE_LAYERS) {
    if (layer === "profile") {
      continue; // the profile layer materializes inside global-shared below
    }
    const bucket = buckets.get(layer);
    if (bucket === undefined) {
      continue;
    }
    for (const [key, asset] of [...bucket.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
      void key;
      let effective = asset;
      let replacementSource: string | null = null;
      if (layer === "global-shared" && selectedProfile !== null) {
        const replacementKey = `${asset.kind}/${asset.logicalName}`;
        const replacement = selectedProfile.replacements[replacementKey];
        if (replacement !== undefined) {
          effective = {
            ...asset,
            content: utf8Encode(replacement),
            contentDigest: hasher.sha256Hex(replacement)
          };
          replacementSource = `profiles/${selectedProfile.name}.yaml#${replacementKey}`;
        }
      }
      apply(layer, effective, replacementSource);
    }
  }

  // Profile replacement content for keys that have no global asset → ignored
  // with a note (profiles are replace-only in v1).
  if (selectedProfile !== null) {
    const present = new Set(input.inventory.assets.map((asset) => `${asset.kind}/${asset.logicalName}`));
    for (const replacementKey of Object.keys(selectedProfile.replacements)) {
      if (!present.has(replacementKey)) {
        notes.push(`profile '${selectedProfile.name}' replacement '${replacementKey}' has no matching asset and was ignored`);
      }
    }
  }

  const assets = [...resolved.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, asset]) => asset);

  return { ok: true, assets, notes };
}
