import { describe, expect, it } from "vitest";

import { baselineOutcome, baselineTargetKey, converterDrifted, explainBaseline } from "../baseline";
import {
  createBatchJournal,
  nextBatchStep,
  recordRollback,
  replayBatchJournal,
  rollbackCandidates,
  settleBatch
} from "../batch-apply";
import { buildConflict, evaluateResolution, conflictsFromReconciliations } from "../conflict";
import { reconcileTarget, reconcileTargets, batchGated } from "../reconcile-engine";
import { decidePendingPublish, rebindHistoryEntry, verdictForInterruptedPhase } from "../recovery";
import { planRepoEdit } from "../repo-edit";
import { detectCaseCollisions, fingerprintFiles, treeChanged, validateScanPath } from "../scanner";
import { applyStructuredEdit, semanticFingerprint, mapJsonTopLevelKeys } from "../structured-edit";
import { assertNoContentInInvalidation, WatchInvalidationCoalescer } from "../watch";
import { buildApplyPlan, compareCollections } from "../apply-plan";
import { testHasher } from "./test-hasher";
import { utf8Decode, utf8Encode } from "../utf8";

describe("reconcile engine (INH-1784)", () => {
  it("maps digest states to actions and honors blockers", () => {
    const clean = reconcileTarget({ targetKey: "t", baseline: "x", local: "x", desired: "x" });
    expect(clean.state).toBe("CLEAN");
    expect(clean.allowedActions).toEqual([]);

    const remote = reconcileTarget({ targetKey: "t", baseline: "x", local: "x", desired: "y" });
    expect(remote.state).toBe("REMOTE_CHANGED");
    expect(remote.allowedActions).toEqual(["apply"]);

    const blocked = reconcileTarget({
      targetKey: "t",
      baseline: "x",
      local: "x",
      desired: "y",
      overlays: ["BLOCKED_SECRET"]
    });
    expect(blocked.state).toBe("REMOTE_CHANGED");
    expect(blocked.allowedActions).toEqual([]);

    const conflict = reconcileTarget({ targetKey: "t", baseline: "x", local: "y", desired: "z" });
    expect(conflict.state).toBe("CONFLICT");
    expect(conflict.allowedActions).toEqual(["resolve-conflict"]);

    const unmanaged = reconcileTarget({ targetKey: "t", baseline: null, local: "y", desired: null });
    expect(unmanaged.state).toBe("UNMANAGED");
    expect(unmanaged.allowedActions).toEqual(["confirm-ownership"]);

    // Recovery gate blocks even conflict resolution.
    const gated = reconcileTarget({
      targetKey: "t",
      baseline: "x",
      local: "y",
      desired: "z",
      overlays: ["RECOVERY_REQUIRED"]
    });
    expect(gated.allowedActions).toEqual([]);
  });

  it("is deterministic and batch-sorted; corruption/drift add blockers", () => {
    const inputs = [
      { targetKey: "b", baseline: "x", local: "y", desired: "z" },
      { targetKey: "a", baseline: null, local: null, desired: null, baselineCorrupt: true, converterDrift: true }
    ];
    const first = reconcileTargets(inputs);
    const second = reconcileTargets([...inputs].reverse());
    expect(first.map((entry) => entry.targetKey)).toEqual(["a", "b"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first[0]?.blockers.map((blocker) => blocker.reason)).toContain("BASELINE_CORRUPT");
    expect(first[0]?.blockers.map((blocker) => blocker.reason)).toContain("CONVERTER_DRIFT");
    expect(batchGated(first)).toBe(false);
    expect(
      batchGated([reconcileTarget({ targetKey: "t", baseline: null, local: null, desired: null, overlays: ["RECOVERY_REQUIRED"] })])
    ).toBe(true);
  });
});

describe("sync baseline records (INH-1781)", () => {
  const record = {
    repositoryId: "repo_" + "a".repeat(64),
    harnessInstanceId: "harn_" + "b".repeat(64),
    targetLogicalPath: "skills/demo/SKILL.md",
    bindingMode: "mirror" as const,
    repositoryRevision: "rev1",
    sourceAssetKey: "global|skills|demo",
    sourceRevision: "src1",
    converterId: "skills",
    converterVersion: "1.0.0",
    managedKeys: null,
    outputDigest: "out1",
    outputByteLength: 10,
    conversionGrade: "lossless" as const,
    lastOperationId: "op1",
    recordedAt: "2026-10-09T00:00:00Z"
  };

  it("only advances after verify + completion; target key is path-stable", () => {
    expect(baselineOutcome({ verified: false, operationComplete: true, record }).ok).toBe(false);
    expect(baselineOutcome({ verified: true, operationComplete: false, record }).ok).toBe(false);
    expect(baselineOutcome({ verified: true, operationComplete: true, record }).ok).toBe(true);
    expect(baselineTargetKey(record)).toBe(`${record.repositoryId}|${record.harnessInstanceId}|skills/demo/SKILL.md`);
  });

  it("explains provenance or demands adoption; detects converter drift", () => {
    const provenance = [
      {
        targetLogicalPath: record.targetLogicalPath,
        sourceAssetKey: record.sourceAssetKey,
        sourceRevision: record.sourceRevision,
        converterId: record.converterId,
        converterVersion: record.converterVersion,
        managedRegion: null,
        outputDigest: record.outputDigest,
        conversionGrade: "lossless" as const,
        recordedAt: record.recordedAt
      }
    ];
    expect(explainBaseline(record, provenance).kind).toBe("explained");
    expect(explainBaseline(record, []).kind).toBe("needs-adoption");
    const wrongDigest = provenance.map((entry) => ({ ...entry, outputDigest: "other" }));
    expect(explainBaseline(record, wrongDigest).kind).toBe("needs-adoption");
    expect(converterDrifted(record, { converterId: "skills", converterVersion: "2.0.0" })).toBe(true);
    expect(converterDrifted(record, { converterId: "skills", converterVersion: "1.0.0" })).toBe(false);
  });
});

describe("structured edit primitive (INH-1786)", () => {
  const hasher = testHasher;
  const base = `{\n  "mcpServers": {\n    "owned": {"command": "npx x"},\n    "user-server": {"command": "custom"}\n  },\n  // user comment\n  "theme": "dark"\n}\n`;
  const parseJsonc = (text: string): Record<string, unknown> =>
    JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;

  it("preserves unmanaged keys byte-for-byte including comments and order", () => {
    const result = applyStructuredEdit({
      rawSource: utf8Encode(base),
      setEntries: [{ key: "owned", jsonValue: '{"command":"npx y","args":["-y"]}' }],
      deleteEntries: [],
      hasher
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    const text = utf8Decode(result.output);
    expect(text).toContain('"user-server"');
    expect(text).toContain("// user comment");
    expect(text).toContain('"theme": "dark"');
    expect(text).toContain('"command":"npx y","args":["-y"]');
    expect(result.changedKeys).toEqual(["owned"]);
    // Key order of untouched entries preserved.
    const userIndex = text.indexOf('"user-server"');
    const themeIndex = text.indexOf('"theme"');
    expect(userIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeGreaterThan(userIndex);
  });

  it("deletes only with a matching ownership fingerprint", () => {
    // The primitive edits TOP-LEVEL keys; nested managed regions (MCP server
    // entries) build on this in M5 with per-region document maps.
    const parsed = parseJsonc(base);
    const themeFingerprint = semanticFingerprint(parsed.theme, hasher);
    const good = applyStructuredEdit({
      rawSource: utf8Encode(base),
      setEntries: [],
      deleteEntries: [{ key: "theme", ownedFingerprint: themeFingerprint }],
      hasher
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      const text = utf8Decode(good.output);
      expect(text).not.toContain('"theme"');
      expect(text).toContain("// user comment");
    }

    const bad = applyStructuredEdit({
      rawSource: utf8Encode(base),
      setEntries: [],
      deleteEntries: [{ key: "theme", ownedFingerprint: "stale" }],
      hasher
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("OWNERSHIP_FINGERPRINT_MISMATCH");
    }
  });

  it("refuses duplicate keys, non-objects, and unmanaged value drift", () => {
    const duplicate = applyStructuredEdit({
      rawSource: utf8Encode('{"a": 1,\n"a": 2}'),
      setEntries: [],
      deleteEntries: [],
      hasher
    });
    expect(duplicate.ok).toBe(false);
    expect(applyStructuredEdit({ rawSource: utf8Encode("[1,2]"), setEntries: [], deleteEntries: [], hasher }).ok).toBe(false);

    // Simulate a mid-edit external change: fingerprint mismatch surfaces as refusal.
    const parsed = parseJsonc(base);
    const fingerprint = semanticFingerprint(parsed.theme, hasher);
    const refused = applyStructuredEdit({
      rawSource: utf8Encode(base.replace('"dark"', '"light"')),
      setEntries: [],
      deleteEntries: [{ key: "theme", ownedFingerprint: fingerprint }],
      hasher
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("OWNERSHIP_FINGERPRINT_MISMATCH");
    }
  });

  it("maps top-level key spans for surgery", () => {
    const map = mapJsonTopLevelKeys(base);
    expect(map.spans.map((span) => span.key).sort()).toEqual(["mcpServers", "theme"]);
    expect(map.duplicateKeys).toEqual([]);
  });
});

describe("conflict model + resolution (INH-1787)", () => {
  const conflict = buildConflict({
    conflictId: "c1",
    kind: "local-vs-desired",
    subjectKey: "t",
    message: "both changed",
    baseline: "b",
    local: "l",
    desired: "d"
  });

  it("accepts resolutions on fresh digests and refuses stale ones", () => {
    const fresh = { local: "l", desired: "d" };
    expect(evaluateResolution(conflict, { conflictId: "c1", resolution: "choose-local-capture", decidedOn: fresh }, fresh)).toMatchObject({
      kind: "accepted",
      nextAction: "capture"
    });
    expect(
      evaluateResolution(conflict, { conflictId: "c1", resolution: "choose-desired-apply", decidedOn: fresh }, fresh)
    ).toMatchObject({ kind: "accepted", nextAction: "apply" });
    const stale = evaluateResolution(
      conflict,
      { conflictId: "c1", resolution: "choose-local-capture", decidedOn: { local: "old", desired: "d" } },
      fresh
    );
    expect(stale.kind).toBe("rejected-stale");
  });

  it("requires separate confirmation for delete/hook conflicts", () => {
    const deleteConflict = buildConflict({
      conflictId: "c2",
      kind: "ownership-mismatch",
      subjectKey: "t",
      message: "delete involved",
      baseline: "b",
      local: "l",
      desired: null,
      deleteInvolved: true
    });
    const outcome = evaluateResolution(
      deleteConflict,
      { conflictId: "c2", resolution: "choose-local-capture", decidedOn: { local: "l", desired: null } },
      { local: "l", desired: null }
    );
    expect(outcome.kind).toBe("rejected-confirmation-required");
  });

  it("derives conflicts from engine reconciliations", () => {
    const conflicts = conflictsFromReconciliations(
      [
        {
          targetKey: "t1",
          state: "CONFLICT",
          blockers: [],
          revisions: { baseline: "b", local: "l", desired: "d" }
        },
        {
          targetKey: "t2",
          state: "UNMANAGED",
          blockers: [{ reason: "BASELINE_CORRUPT", detail: "unexplainable" }],
          revisions: { baseline: null, local: "x", desired: null }
        }
      ],
      (() => {
        let counter = 0;
        return () => `c${(counter += 1)}`;
      })()
    );
    expect(conflicts.map((conflict) => conflict.kind)).toEqual(["local-vs-desired", "ownership-mismatch"]);
  });
});

describe("journaled batch apply (INH-1789)", () => {
  const entries = [
    { targetKey: "t1", mode: "overwrite" as const, revision: "r1", executable: true, blockedReason: null },
    { targetKey: "t2", mode: "overwrite" as const, revision: "r1", executable: true, blockedReason: null },
    { targetKey: "t3", mode: "add-only" as const, revision: "r1", executable: false, blockedReason: "read-only mapping" }
  ];
  const now = () => "2026-10-09T00:00:00Z";

  it("skips blocked targets, halts on first failure, and labels partial success honestly", () => {
    const journal = createBatchJournal("batch1", "plan1", entries, now);
    expect(journal.entries.find((entry) => entry.targetKey === "t3")?.state).toBe("SKIPPED_BLOCKED");

    let step = nextBatchStep(journal);
    expect(step.action).toBe("execute");
    if (step.action === "execute") {
      step.entry.state = "COMMITTED";
    }
    step = nextBatchStep(journal);
    if (step.action === "execute") {
      step.entry.state = "APPLY_FAILED";
      step.entry.failureDetail = "disk full";
    }
    // Next executable target halts.
    expect(nextBatchStep(journal)).toMatchObject({ action: "halt" });
    settleBatch(journal, now);
    expect(journal.status).toBe("PARTIAL_SUCCESS");
    expect(rollbackCandidates(journal)).toEqual(["t1"]);
  });

  it("rollback failure moves the batch to RECOVERY_REQUIRED", () => {
    const journal = createBatchJournal("batch1", "plan1", entries.slice(0, 1), now);
    const step = nextBatchStep(journal);
    if (step.action === "execute") {
      step.entry.state = "COMMITTED";
    }
    settleBatch(journal, now);
    recordRollback(journal, "t1", false, now);
    expect(journal.status).toBe("RECOVERY_REQUIRED");
    expect(replayBatchJournal(journal).needsRecovery).toBe(true);
  });

  it("replays a crashed journal and refuses to resume an APPLYING entry", () => {
    const journal = createBatchJournal("batch1", "plan1", entries.slice(0, 2), now);
    journal.entries[0]!.state = "APPLYING";
    const replay = replayBatchJournal(journal);
    expect(replay.resumable).toBe(false);
    expect(replay.needsRecovery).toBe(true);
  });
});

describe("pending publish + recovery (INH-1788/1790)", () => {
  const record = {
    repositoryId: "repo_" + "a".repeat(64),
    pendingRevision: "p1",
    captureOperationId: "op1",
    branch: "main",
    recordedAt: "2026-10-09T00:00:00Z"
  };

  it("retries when FF-compatible, conflicts when diverged, voids when the commit vanished", () => {
    expect(decidePendingPublish({ record, relation: "up-to-date", commitStillPresent: true, headRevision: "p1" })).toMatchObject({ action: "retry-push" });
    expect(decidePendingPublish({ record, relation: "ahead", commitStillPresent: true, headRevision: "p1" })).toMatchObject({ action: "retry-push" });
    expect(decidePendingPublish({ record, relation: "diverged", commitStillPresent: true, headRevision: "p1" }).action).toBe("conflict");
    expect(decidePendingPublish({ record, relation: "behind-ff", commitStillPresent: true, headRevision: "p1" }).action).toBe("conflict");
    expect(decidePendingPublish({ record, relation: "unreachable", commitStillPresent: true, headRevision: "p1" }).action).toBe("conflict");
    const voided = decidePendingPublish({ record, relation: "up-to-date", commitStillPresent: false, headRevision: null });
    expect(voided.action).toBe("void");
  });

  it("maps interrupted phases to safe-rollback / manual-recovery / no-op", () => {
    expect(verdictForInterruptedPhase("SNAPSHOTTED", "snap1").action).toBe("safe-rollback");
    expect(verdictForInterruptedPhase("APPLYING", "snap1")).toMatchObject({ action: "manual-recovery", gateMutations: true });
    expect(verdictForInterruptedPhase("VERIFYING", null).action).toBe("manual-recovery");
    expect(verdictForInterruptedPhase("ROLLING_BACK", "snap1").action).toBe("manual-recovery");
    expect(verdictForInterruptedPhase("COMMITTED", null).action).toBe("no-op");
  });

  it("keeps Phase A random-id history read-only; matches root identity exactly", () => {
    const outcome = rebindHistoryEntry({ workspaceId: "ws-random", createdAt: "t", summary: "s" }, null);
    expect(outcome.kind).toBe("legacy-read-only");
    expect(rebindHistoryEntry({ workspaceId: "ws-random", createdAt: "t", summary: "s" }, "repo_" + "a".repeat(64)).kind).toBe(
      "v2-bound"
    );
    expect(rebindHistoryEntry({ workspaceId: "w", createdAt: "t", summary: "s" }, "repo_" + "a".repeat(64))).toMatchObject({
      kind: "v2-bound"
    });
  });
});

describe("repo edit transactions (INH-1848)", () => {
  const repoId = "repo_" + "a".repeat(64);

  it("plans working-tree edits only, with delete guards", () => {
    const decision = planRepoEdit({
      target: {
        logicalPaths: ["global/instructions/AGENTS.md"],
        repositoryId: repoId,
        baseRevision: "r1",
        ownershipDigests: {}
      },
      writes: [{ logicalPath: "global/instructions/AGENTS.md", content: utf8Encode("new") }],
      currentRevision: "r1",
      currentDigests: {},
      affectedAssetKeys: [],
      deleteConfirmed: false
    });
    expect(decision.ok).toBe(true);

    const stale = planRepoEdit({
      target: { logicalPaths: [], repositoryId: repoId, baseRevision: "r1", ownershipDigests: {} },
      writes: [],
      currentRevision: "r2",
      currentDigests: {},
      affectedAssetKeys: [],
      deleteConfirmed: false
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("STALE_BASE");
    }

    const unmanaged = planRepoEdit({
      target: { logicalPaths: [], repositoryId: repoId, baseRevision: "r1", ownershipDigests: {} },
      writes: [{ logicalPath: "notes.md", content: utf8Encode("x") }],
      currentRevision: "r1",
      currentDigests: {},
      affectedAssetKeys: [],
      deleteConfirmed: false
    });
    expect(unmanaged.ok).toBe(false);
    if (!unmanaged.ok) {
      expect(unmanaged.code).toBe("SCOPE_VIOLATION");
    }

    const deleteUnowned = planRepoEdit({
      target: { logicalPaths: [], repositoryId: repoId, baseRevision: "r1", ownershipDigests: {} },
      writes: [{ logicalPath: "global/skills/a/SKILL.md", content: null }],
      currentRevision: "r1",
      currentDigests: { "global/skills/a/SKILL.md": "d1" },
      affectedAssetKeys: ["global|skills|a"],
      deleteConfirmed: true
    });
    expect(deleteUnowned.ok).toBe(false);
    if (!deleteUnowned.ok) {
      expect(deleteUnowned.code).toBe("OWNERSHIP_MISSING");
    }

    const deleteUnconfirmed = planRepoEdit({
      target: {
        logicalPaths: [],
        repositoryId: repoId,
        baseRevision: "r1",
        ownershipDigests: { "global/skills/a/SKILL.md": "d1" }
      },
      writes: [{ logicalPath: "global/skills/a/SKILL.md", content: null }],
      currentRevision: "r1",
      currentDigests: { "global/skills/a/SKILL.md": "d1" },
      affectedAssetKeys: ["global|skills|a"],
      deleteConfirmed: false
    });
    expect(deleteUnconfirmed.ok).toBe(false);
    if (!deleteUnconfirmed.ok) {
      expect(deleteUnconfirmed.code).toBe("DELETE_REFUSED");
    }

    const deleteStale = planRepoEdit({
      target: {
        logicalPaths: [],
        repositoryId: repoId,
        baseRevision: "r1",
        ownershipDigests: { "global/skills/a/SKILL.md": "d1" }
      },
      writes: [{ logicalPath: "global/skills/a/SKILL.md", content: null }],
      currentRevision: "r1",
      currentDigests: { "global/skills/a/SKILL.md": "changed" },
      affectedAssetKeys: [],
      deleteConfirmed: true
    });
    expect(deleteStale.ok).toBe(false);
    if (!deleteStale.ok) {
      expect(deleteStale.code).toBe("DELETE_REFUSED");
    }
  });
});

describe("scanner policy (INH-1783)", () => {
  it("validates paths and detects case collisions structurally", () => {
    expect(validateScanPath("../escape")).toMatchObject({ code: "PATH_UNSAFE" });
    expect(validateScanPath("a\\b")).toMatchObject({ code: "PATH_UNSAFE" });
    expect(validateScanPath("em\u0065\u0301.md")).toMatchObject({ code: "PATH_NOT_NFC" });
    expect(validateScanPath("ok/path.md")).toBeNull();
    expect(detectCaseCollisions(["A.md", "a.md"])).toHaveLength(1);
    expect(detectCaseCollisions(["A.md", "b.md"])).toHaveLength(0);
  });

  it("fingerprints file sets deterministically and detects tree changes", () => {
    const files = [
      { logicalPath: "b", digest: "d2", mode: 420 },
      { logicalPath: "a", digest: "d1", mode: 493 }
    ];
    const left = fingerprintFiles(files, testHasher);
    const right = fingerprintFiles([...files].reverse(), testHasher);
    expect(left).toBe(right);
    expect(
      treeChanged(
        { root: "r", rootFingerprint: left, files: [] },
        { root: "r", rootFingerprint: fingerprintFiles([...files, { logicalPath: "c", digest: "d3", mode: 420 }], testHasher), files: [] }
      )
    ).toBe(true);
  });
});

describe("apply plan policy (INH-1849)", () => {
  const baseTarget = {
    targetKey: "h1|global|skills|demo",
    harnessInstanceId: "harn_" + "1".repeat(64),
    scope: { kind: "global" } as const,
    assetKind: "skills" as const,
    requestedMode: "overwrite" as const,
    localDigest: null,
    hasOwnership: true,
    capability: "read-write" as const,
    runtimeReady: true,
    secretReady: true
  };

  it("produces unique entries with modes, skips, blocks, and adoption gates", () => {
    const plan = buildApplyPlan(
      [
        baseTarget,
        { ...baseTarget, targetKey: "h2|global|skills|demo", localDigest: "exists", hasOwnership: false },
        { ...baseTarget, targetKey: "h3|global|skills|demo", capability: "unsupported" as const },
        { ...baseTarget, targetKey: "h4|global|skills|demo", requestedMode: "add-only", localDigest: "exists" },
        { ...baseTarget, targetKey: "h5|global|skills|demo", runtimeReady: false },
        { ...baseTarget, targetKey: "h6|global|skills|demo", assetKind: "instructions", requestedMode: "merge-add" }
      ],
      false,
      "rev1"
    );
    if (!plan.ok) {
      throw new Error(plan.message);
    }
    const byKey = new Map(plan.entries.map((entry) => [entry.targetKey, entry]));
    expect(byKey.get("h1|global|skills|demo")?.action).toBe("apply");
    expect(byKey.get("h2|global|skills|demo")?.action).toBe("needs-adoption");
    expect(byKey.get("h3|global|skills|demo")?.action).toBe("blocked");
    expect(byKey.get("h4|global|skills|demo")?.action).toBe("skip-add-only-exists");
    expect(byKey.get("h5|global|skills|demo")?.blockedReason).toContain("runtime");
    // merge-add on textual kind is blocked with per-target guidance.
    expect(byKey.get("h6|global|skills|demo")?.action).toBe("blocked");
    expect(byKey.get("h6|global|skills|demo")?.requiresExplicitConfirmation).toBe(true);
    // Determinism.
    expect(JSON.stringify(buildApplyPlan([], false, "rev1"))).not.toBeUndefined();
    expect(buildApplyPlan([], false, "rev1")).toMatchObject({ ok: false });
    expect(buildApplyPlan([baseTarget, baseTarget], false, "rev1")).toMatchObject({ ok: false });
    // Source deleted blocks everything.
    const deleted = buildApplyPlan([baseTarget], true, "rev1");
    expect(deleted.ok && deleted.entries[0]?.action).toBe("blocked");
  });

  it("per-target mode override does not affect other targets", () => {
    const plan = buildApplyPlan(
      [
        { ...baseTarget, targetKey: "a", requestedMode: { kind: "per-target", defaultMode: "overwrite", targets: {} } },
        { ...baseTarget, targetKey: "b", requestedMode: "add-only" }
      ],
      false,
      "rev1"
    );
    if (!plan.ok) {
      throw new Error(plan.message);
    }
    const byKey = new Map(plan.entries.map((entry) => [entry.targetKey, entry]));
    expect(byKey.get("a")?.effectiveMode).toBe("overwrite");
    expect(byKey.get("b")?.effectiveMode).toBe("add-only");
  });
});

describe("collection comparison (INH-1850)", () => {
  const repoId = "repo_" + "a".repeat(64);
  const source = {
    label: "claude",
    assets: [
      { kind: "skills" as const, logicalName: "a/SKILL.md", digest: "s1" },
      { kind: "skills" as const, logicalName: "b/SKILL.md", digest: "s2" },
      { kind: "skills" as const, logicalName: "c/SKILL.md", digest: "same" }
    ],
    supportedKinds: new Set(["skills" as const])
  };
  const target = {
    label: "codex",
    assets: [
      { kind: "skills" as const, logicalName: "a/SKILL.md", digest: "t1" },
      { kind: "skills" as const, logicalName: "b/SKILL.md", digest: "t2" },
      { kind: "skills" as const, logicalName: "d/SKILL.md", digest: "t4" },
      { kind: "skills" as const, logicalName: "c/SKILL.md", digest: "same" }
    ],
    supportedKinds: new Set(["skills" as const])
  };

  it("classifies relations; without a trusted baseline it does not claim single-sided updates", () => {
    const untrusted = compareCollections({ repositoryId: repoId, source, target, baselines: {}, trustedBaseline: false });
    expect(untrusted.confidence).toBe("unknown-baseline");
    const byKey = new Map(untrusted.diffs.map((diff) => [diff.semanticKey, diff]));
    expect(byKey.get("skills|a/SKILL.md")?.relation).toBe("both-modified");
    expect(byKey.get("skills|b/SKILL.md")?.relation).toBe("both-modified");
    expect(byKey.get("skills|d/SKILL.md")?.relation).toBe("target-only");
    expect(byKey.get("skills|c/SKILL.md")?.relation).toBe("identical");

    const trusted = compareCollections({
      repositoryId: repoId,
      source,
      target,
      baselines: { "skills|a/SKILL.md": "t1", "skills|b/SKILL.md": "s2" },
      trustedBaseline: true
    });
    const trustedByKey = new Map(trusted.diffs.map((diff) => [diff.semanticKey, diff]));
    // Target == baseline, source moved → source-updated.
    expect(trustedByKey.get("skills|a/SKILL.md")?.relation).toBe("source-updated");
    // Source == baseline, target moved → target-modified.
    expect(trustedByKey.get("skills|b/SKILL.md")?.relation).toBe("target-modified");
  });

  it("marks unsupported kinds as blocking diffs", () => {
    const comparison = compareCollections({
      repositoryId: repoId,
      source: { ...source, assets: [...source.assets, { kind: "mcp" as const, logicalName: "s", digest: "m" }] },
      target,
      baselines: {},
      trustedBaseline: false
    });
    const unsupported = comparison.diffs.find((diff) => diff.kind === "mcp");
    expect(unsupported?.relation).toBe("unsupported");
    expect(comparison.hasBlockingDiffs).toBe(true);
  });
});

describe("watch invalidation policy (INH-1782)", () => {
  it("coalesces event storms into one generation advance", () => {
    const emitted: number[] = [];
    let fire: (() => void) | undefined;
    const coalescer = new WatchInvalidationCoalescer(
      {
        debounceMs: 100,
        subjectId: "repo_x",
        reason: "repository-working-tree",
        schedule: (callback) => {
          fire = callback;
          return () => {
            fire = undefined;
          };
        }
      },
      (invalidation) => emitted.push(invalidation.generation)
    );
    coalescer.push({ watchRoot: "repo", kind: "modify", relativePath: "a.md", occurredAtMs: 1 });
    coalescer.push({ watchRoot: "repo", kind: "delete", relativePath: "a.md", occurredAtMs: 2 });
    coalescer.push({ watchRoot: "repo", kind: "create", relativePath: "a.md", occurredAtMs: 3 });
    expect(emitted).toHaveLength(0);
    fire?.();
    expect(emitted).toEqual([1]);
    expect(coalescer.currentGeneration()).toBe(1);
    // Flush with no pending events emits nothing.
    expect(coalescer.flush()).toBeNull();
    coalescer.dispose();
  });

  it("flush emits for pending events and invalidations carry no content", () => {
    const emitted: { generation: number }[] = [];
    const coalescer = new WatchInvalidationCoalescer(
      {
        debounceMs: 1000,
        subjectId: "repo_x",
        reason: "harness-global-config",
        schedule: (callback) => {
          void callback;
          return () => undefined;
        }
      },
      (invalidation) => {
        emitted.push(invalidation);
      }
    );
    coalescer.push({ watchRoot: "harness", kind: "modify", relativePath: "x", occurredAtMs: 1 });
    const flushed = coalescer.flush();
    expect(flushed?.generation).toBe(1);
    expect(emitted[0]?.generation).toBe(1);
    expect(
      assertNoContentInInvalidation({
        reason: "harness-global-config",
        subjectId: "repo_x",
        occurredAt: "2026-10-09T00:00:00Z"
      })
    ).toBe(true);
    coalescer.dispose();
  });
});
