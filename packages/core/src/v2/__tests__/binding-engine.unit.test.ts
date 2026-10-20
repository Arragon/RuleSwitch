import { describe, expect, it } from "vitest";

import {
  buildBindingIntents,
  buildGeneratedProvenance,
  declaredManagedKeys,
  defaultBindingModeForKind,
  evaluateDelete,
  mergeStructuredPreservingUnknown
} from "../binding-engine";

describe("binding engine (INH-1771)", () => {
  it("assigns the frozen default mode per kind with deterministic ordering", () => {
    expect(defaultBindingModeForKind("instructions")).toBe("mirror");
    expect(defaultBindingModeForKind("skills")).toBe("mirror");
    expect(defaultBindingModeForKind("mcp")).toBe("structured-merge");
    expect(defaultBindingModeForKind("settings")).toBe("structured-merge");
    expect(defaultBindingModeForKind("native")).toBe("native");

    const intents = buildBindingIntents([
      { assetKey: "global|skills|b", kind: "skills", logicalName: "b" },
      { assetKey: "global|skills|a", kind: "skills", logicalName: "a" },
      { assetKey: "global|mcp|servers", kind: "mcp", logicalName: "servers" }
    ]);
    expect(intents.map((intent) => intent.assetKey)).toEqual([
      "global|mcp|servers",
      "global|skills|a",
      "global|skills|b"
    ]);
    expect(intents[0]?.mode).toBe("structured-merge");
    expect(intents.every((intent) => intent.ownership.requiresOwnershipProof)).toBe(true);
    expect(intents.every((intent) => intent.ownership.firstAdoptionRequiresConfirmation)).toBe(true);
  });

  it("supports explicit mode overrides (e.g. generated)", () => {
    const intents = buildBindingIntents(
      [{ assetKey: "global|instructions|AGENTS.md", kind: "instructions", logicalName: "AGENTS.md" }],
      { instructions: "generated" }
    );
    expect(intents[0]?.mode).toBe("generated");
  });

  it("only deletes with ownership proof matching the current digest", () => {
    expect(evaluateDelete({ mode: "mirror", owned: false, ownershipDigest: "d", currentDigest: "d", firstAdoption: false }).allowed).toBe(false);
    expect(evaluateDelete({ mode: "mirror", owned: true, ownershipDigest: null, currentDigest: "d", firstAdoption: false }).allowed).toBe(false);
    expect(evaluateDelete({ mode: "mirror", owned: true, ownershipDigest: "d", currentDigest: null, firstAdoption: false }).allowed).toBe(false);
    const stale = evaluateDelete({ mode: "mirror", owned: true, ownershipDigest: "d1", currentDigest: "d2", firstAdoption: false });
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) {
      expect(stale.reason).toContain("changed since");
    }
    expect(evaluateDelete({ mode: "mirror", owned: true, ownershipDigest: "d", currentDigest: "d", firstAdoption: false }).allowed).toBe(true);
    // First adoption never deletes.
    const first = evaluateDelete({ mode: "mirror", owned: true, ownershipDigest: "d", currentDigest: "d", firstAdoption: true });
    expect(first.allowed).toBe(false);
    if (!first.allowed) {
      expect(first.reason).toContain("first adoption");
    }
  });

  it("structured merge preserves unknown fields and only touches declared keys", () => {
    const base = { keep_me: "original", managed: "old", nested: { inner: 1 } };
    const managed = { managed: "new", added: true };
    const merged = mergeStructuredPreservingUnknown(base, managed, ["managed"]);
    expect(merged).toEqual({ keep_me: "original", managed: "new", nested: { inner: 1 } });
    expect(declaredManagedKeys({ b: 1, a: 2 })).toEqual(["a", "b"]);
    // Removing a declared key removes it from the merged output.
    const removed = mergeStructuredPreservingUnknown(base, {}, ["managed"]);
    expect("managed" in removed).toBe(false);
  });

  it("records multi-source provenance for generated targets", () => {
    const records = buildGeneratedProvenance(
      [
        { assetKey: "global|instructions|AGENTS.md", sourceRevision: "rev1" },
        { assetKey: "project:prj_demo|instructions|AGENTS.md", sourceRevision: "rev2" }
      ],
      {
        targetLogicalPath: "AGENTS.md",
        outputDigest: "abc",
        converterId: "ruleswitch.instructions",
        converterVersion: "1.0.0",
        conversionGrade: "equivalent",
        recordedAt: "2026-10-08T00:00:00Z"
      }
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.sourceAssetKey).toBe("global|instructions|AGENTS.md");
    expect(records[1]?.sourceAssetKey).toBe("project:prj_demo|instructions|AGENTS.md");
    expect(records.every((record) => record.outputDigest === "abc" && record.managedRegion === null)).toBe(true);
  });

  it("emits intents only — the engine performs no writes", () => {
    const intents = buildBindingIntents([{ assetKey: "global|native|x", kind: "native", logicalName: "x" }]);
    // The output type is plain metadata; there is no fs/shell surface here.
    expect(JSON.parse(JSON.stringify(intents))[0].mode).toBe("native");
  });
});
