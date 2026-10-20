import { describe, expect, it } from "vitest";

import {
  canProceedFromDetect,
  initialOnboardingState,
  reduceOnboarding
} from "../onboarding-model";
import { planIsStale, shapeBatchResult, shapePreviewRows } from "../preview-model";

describe("onboarding wizard model (INH-1809)", () => {
  const overview = {
    repositoryBound: true,
    repositoryId: "repo_x",
    branch: "main",
    workingTree: "clean",
    pendingPublish: false,
    projectCount: 0,
    harnessCount: 0,
    libraryDrafts: 0
  };

  it("walks connect → detect → bind → preview with adoption gate", () => {
    let state = initialOnboardingState();
    expect(state.step).toBe("connect");

    state = reduceOnboarding(state, { type: "connected", overview });
    expect(state.step).toBe("detect");

    state = reduceOnboarding(state, {
      type: "harnesses-detected",
      harnesses: [
        { harnessInstanceId: "h1", displayName: "Codex", installed: true },
        { harnessInstanceId: "h2", displayName: "Cursor", installed: false }
      ]
    });
    // Installed harnesses preselected; zero-selection blocks proceeding.
    expect(state.selectedHarnessIds).toEqual(["h1"]);
    expect(canProceedFromDetect(state)).toBe(true);
    state = reduceOnboarding(state, { type: "deselect-all-harnesses" });
    expect(canProceedFromDetect(state)).toBe(false);
    state = reduceOnboarding(state, { type: "select-all-harnesses" });
    expect(state.selectedHarnessIds).toEqual(["h1", "h2"]);
    state = reduceOnboarding(state, { type: "toggle-harness", harnessInstanceId: "h2" });
    expect(state.selectedHarnessIds).toEqual(["h1"]);

    state = reduceOnboarding(state, { type: "projects-loaded", projects: [] });
    expect(state.step).toBe("bind");

    // First discovery of existing targets requires adoption preview.
    state = reduceOnboarding(state, { type: "adoption-required" });
    expect(state.adoptionRequired).toBe(true);
    expect(state.step).toBe("preview");
  });

  it("surfaces connect errors with a message, not a silent step skip", () => {
    let state = initialOnboardingState();
    state = reduceOnboarding(state, { type: "connect-failed", message: "不是 Git 仓库" });
    expect(state.error).toContain("Git");
    expect(state.step).toBe("connect");
  });
});

describe("unified preview/confirm model (INH-1814)", () => {
  it("shapes plan entries into rows with per-risk confirm kinds", () => {
    const rows = shapePreviewRows(
      [
        { targetKey: "a", action: "apply", effectiveMode: "overwrite", blockedReason: null, requiresExplicitConfirmation: false },
        { targetKey: "b", action: "needs-adoption", effectiveMode: "overwrite", blockedReason: "no baseline", requiresExplicitConfirmation: true },
        { targetKey: "c", action: "blocked", effectiveMode: "overwrite", blockedReason: "source deleted", requiresExplicitConfirmation: false },
        { targetKey: "d", action: "blocked", effectiveMode: "merge-add", blockedReason: "textual kind", requiresExplicitConfirmation: true }
      ],
      true
    );
    const byKey = new Map(rows.map((row) => [row.targetKey, row]));
    expect(byKey.get("a")?.confirmKind).toBeNull();
    expect(byKey.get("b")?.confirmKind).toBe("adoption");
    expect(byKey.get("c")?.confirmKind).toBe("delete");
    expect(byKey.get("d")?.confirmKind).toBe("degraded");
  });

  it("shapes batch results honestly: successful/failed/not-started + rollback CTA", () => {
    const view = shapeBatchResult({
      batchId: "b1",
      planId: "p1",
      startedAt: "t",
      updatedAt: "t",
      status: "PARTIAL_SUCCESS",
      entries: [
        { targetKey: "t1", mode: "overwrite", planRevision: "r", state: "COMMITTED", snapshotRef: "s", verifyDigest: "d", failureDetail: null, rollbackOf: false },
        { targetKey: "t2", mode: "overwrite", planRevision: "r", state: "APPLY_FAILED", snapshotRef: null, verifyDigest: null, failureDetail: "disk full", rollbackOf: false },
        { targetKey: "t3", mode: "overwrite", planRevision: "r", state: "PENDING", snapshotRef: null, verifyDigest: null, failureDetail: null, rollbackOf: false }
      ]
    });
    expect(view.successful).toEqual(["t1"]);
    expect(view.failed).toEqual([{ targetKey: "t2", detail: "disk full" }]);
    expect(view.notStarted).toEqual(["t3"]);
    expect(view.rollbackAvailable).toBe(true);
    expect(view.recoveryRequired).toBe(false);
  });

  it("flags stale plans (APPLYING/ROLLBACK_FAILED) to force re-preview", () => {
    expect(
      planIsStale({
        batchId: "b",
        planId: "p",
        startedAt: "t",
        updatedAt: "t",
        status: "RUNNING",
        entries: [
          { targetKey: "t", mode: "overwrite", planRevision: "r", state: "APPLYING", snapshotRef: "s", verifyDigest: null, failureDetail: null, rollbackOf: false }
        ]
      })
    ).toBe(true);
  });
});
