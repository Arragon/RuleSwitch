import { describe, expect, it } from "vitest";

import {
  attributeGeneratedChange,
  collectionComparisonConfidence,
  reconcileState,
  recommendedAction,
  resolveApplyMode,
  type ContentDigest
} from "../reconcile";

/**
 * Exhaustive B/L/D truth table over the representative digest lattice
 * { absent(null), "x", "y" }: 27 combinations, each with a frozen expected
 * state. The same inputs must always produce the same state; there is no
 * mtime input at all.
 */
const DIGESTS: readonly ContentDigest[] = [null, "x", "y"];

const EXPECTED: Record<string, string> = {
  // baseline absent → unmanaged (first adoption)
  "null|null|null": "UNMANAGED",
  "null|null|x": "UNMANAGED",
  "null|null|y": "UNMANAGED",
  "null|x|null": "UNMANAGED",
  "null|x|x": "UNMANAGED",
  "null|x|y": "UNMANAGED",
  "null|y|null": "UNMANAGED",
  "null|y|x": "UNMANAGED",
  "null|y|y": "UNMANAGED",
  // baseline = x
  "x|x|x": "CLEAN",
  "x|x|null": "REMOTE_CHANGED", // deleted in repo → apply the deletion
  "x|x|y": "REMOTE_CHANGED",
  "x|null|x": "LOCAL_CHANGED", // deleted locally → capture the deletion
  "x|null|null": "CLEAN", // both deleted → converged
  "x|null|y": "CONFLICT",
  "x|y|x": "LOCAL_CHANGED",
  "x|y|null": "CONFLICT",
  "x|y|y": "CLEAN", // both changed to the same content → converged
  // baseline = y (symmetry)
  "y|y|y": "CLEAN",
  "y|y|null": "REMOTE_CHANGED",
  "y|y|x": "REMOTE_CHANGED",
  "y|null|y": "LOCAL_CHANGED",
  "y|null|null": "CLEAN",
  "y|null|x": "CONFLICT",
  "y|x|y": "LOCAL_CHANGED",
  "y|x|null": "CONFLICT",
  "y|x|x": "CLEAN"
};

describe("B/L/D reconcile truth table (INH-1754)", () => {
  it("covers every B/L/D combination over {absent, x, y} deterministically", () => {
    for (const baseline of DIGESTS) {
      for (const local of DIGESTS) {
        for (const desired of DIGESTS) {
          const key = `${baseline ?? "null"}|${local ?? "null"}|${desired ?? "null"}`;
          const state = reconcileState({ baseline, local, desired });
          expect(state, `B/L/D = ${key}`).toBe(EXPECTED[key]);
          // Determinism: identical inputs produce identical outputs.
          expect(reconcileState({ baseline, local, desired })).toBe(state);
        }
      }
    }
  });

  it("has an entry for every combination (no holes in the expectation table)", () => {
    const total = DIGESTS.length ** 3;
    expect(Object.keys(EXPECTED).length).toBe(total);
  });

  it("maps states to their recommended actions", () => {
    expect(recommendedAction("CLEAN")).toBe("none");
    expect(recommendedAction("LOCAL_CHANGED")).toBe("capture");
    expect(recommendedAction("REMOTE_CHANGED")).toBe("apply");
    expect(recommendedAction("CONFLICT")).toBe("resolve-conflict");
    expect(recommendedAction("UNMANAGED")).toBe("confirm-ownership");
    expect(recommendedAction("RECOVERY_REQUIRED")).toBe("none");
  });
});

describe("apply mode policy (2026-10-07 supplement)", () => {
  it("blocks merge-add on textual kinds and points to per-target choices", () => {
    const decision = resolveApplyMode("skills", "merge-add");
    expect(decision.allowed).toBe(false);
    expect(decision.requiresExplicitConfirmation).toBe(true);
    expect(decision.reason).toContain("per-target");
    expect(resolveApplyMode("instructions", "merge-add").allowed).toBe(false);
    expect(resolveApplyMode("native", "merge-add").allowed).toBe(false);
  });

  it("allows merge-add on structured kinds where unknown fields are preserved", () => {
    expect(resolveApplyMode("mcp", "merge-add").allowed).toBe(true);
    expect(resolveApplyMode("settings", "merge-add").allowed).toBe(true);
    expect(resolveApplyMode("hooks", "merge-add").allowed).toBe(true);
  });

  it("allows overwrite and add-only everywhere; per-target overrides are explicit user choices", () => {
    expect(resolveApplyMode("skills", "overwrite").allowed).toBe(true);
    expect(resolveApplyMode("skills", "add-only").allowed).toBe(true);
    expect(
      resolveApplyMode("skills", { kind: "per-target", defaultMode: "add-only", targets: {} }).allowed
    ).toBe(true);
  });
});

describe("collection comparison basis", () => {
  it("reports unknown instead of guessing when no trusted common baseline exists", () => {
    expect(collectionComparisonConfidence({ trustedCommonBaseline: false, commonRevision: null })).toBe(
      "unknown-baseline"
    );
    expect(
      collectionComparisonConfidence({ trustedCommonBaseline: true, commonRevision: "abc" })
    ).toBe("trusted");
  });
});

describe("generated reverse mapping attribution", () => {
  const candidates = [
    { assetKey: "global|skills|a", expectedDigest: "d1" },
    { assetKey: "global|skills|b", expectedDigest: "d2" }
  ];

  it("attributes uniquely matching digests", () => {
    expect(attributeGeneratedChange(candidates, "d1")).toEqual({
      kind: "unique",
      assetKey: "global|skills|a"
    });
  });

  it("refuses ambiguity and never guesses", () => {
    const duplicated = [
      ...candidates,
      { assetKey: "global|skills|c", expectedDigest: "d1" }
    ];
    expect(attributeGeneratedChange(duplicated, "d1")).toEqual({ kind: "ambiguous", candidateCount: 2 });
    expect(attributeGeneratedChange(candidates, "d3")).toEqual({ kind: "unattributable" });
  });
});
