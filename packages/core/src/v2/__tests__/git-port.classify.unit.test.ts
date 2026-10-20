import { describe, expect, it } from "vitest";

import {
  classifyCommitReadiness,
  classifyPublishDecision,
  GIT_FORBIDDEN_OPERATIONS,
  type GitRepositoryStatus
} from "../git-port";

function status(overrides: Partial<GitRepositoryStatus>): GitRepositoryStatus {
  return {
    repositoryId: "repo_f80ba2ec8e9be38851196514b9bb92903b3d51001e7fbcb7cf7896e479a5f3d0",
    headRevision: "abc",
    upstreamRevision: "abc",
    remoteStatus: "up-to-date",
    ahead: 0,
    behind: 0,
    workingTree: "clean",
    paths: [],
    pendingPublish: false,
    ...overrides
  };
}

describe("GitPort port surface (INH-1756)", () => {
  it("exposes no merge/rebase/stash/force-push/reset-hard operations", () => {
    // The port interface itself omits them; this constant documents the
    // frozen prohibition and is asserted so it cannot drift silently.
    expect(GIT_FORBIDDEN_OPERATIONS).toEqual(["merge", "rebase", "stash", "force-push", "reset --hard"]);
  });
});

describe("publish decision classification", () => {
  it("blocks dirty, diverged, and unreachable states by default", () => {
    expect(classifyPublishDecision(status({ workingTree: "dirty-managed" })).action).toBe("blocked");
    expect(classifyPublishDecision(status({ workingTree: "dirty-mixed" })).action).toBe("blocked");
    expect(classifyPublishDecision(status({ remoteStatus: "diverged" }))).toEqual({
      action: "blocked",
      reason: expect.stringContaining("diverged")
    });
    expect(classifyPublishDecision(status({ remoteStatus: "remote-unreachable" })).action).toBe("blocked");
  });

  it("requires fetch-first when the remote is ahead (fast-forward only)", () => {
    expect(classifyPublishDecision(status({ remoteStatus: "behind-ff", behind: 2 })).action).toBe("fetch-first");
  });

  it("pushes when ahead or when local commits await publish", () => {
    expect(classifyPublishDecision(status({ remoteStatus: "ahead", ahead: 1 })).action).toBe("push");
    expect(classifyPublishDecision(status({ pendingPublish: true })).action).toBe("push");
    expect(classifyPublishDecision(status({ remoteStatus: "up-to-date" })).action).toBe("push");
  });

  it("does not block on unmanaged-only dirt (scoped commit policy handles commits)", () => {
    expect(classifyPublishDecision(status({ workingTree: "dirty-unmanaged" })).action).not.toBe("blocked");
  });
});

describe("scoped commit readiness", () => {
  it("blocks commits that contain unmanaged staged paths", () => {
    const withUnmanagedStaged = status({
      paths: [
        { logicalPath: "global/skills/a/SKILL.md", managed: true, staged: true, headDigest: null, indexDigest: "d1", worktreeDigest: "d1" },
        { logicalPath: "notes.md", managed: false, staged: true, headDigest: null, indexDigest: "d2", worktreeDigest: "d2" }
      ]
    });
    const readiness = classifyCommitReadiness(withUnmanagedStaged, ["global/skills/a/SKILL.md"]);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers[0]).toContain("unmanaged staged path");
  });

  it("allows commits whose staged paths are all managed or explicitly allowed", () => {
    const managedOnly = status({
      paths: [
        { logicalPath: "global/skills/a/SKILL.md", managed: true, staged: true, headDigest: null, indexDigest: "d1", worktreeDigest: "d1" }
      ]
    });
    expect(classifyCommitReadiness(managedOnly, ["global/skills/a/SKILL.md"]).ready).toBe(true);

    const unmanagedUnstaged = status({
      workingTree: "dirty-unmanaged",
      paths: [
        { logicalPath: "notes.md", managed: false, staged: false, headDigest: null, indexDigest: null, worktreeDigest: "d2" }
      ]
    });
    expect(classifyCommitReadiness(unmanagedUnstaged, []).ready).toBe(true);
  });
});
