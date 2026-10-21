import { describe, expect, it } from "vitest";

import {
  groupLibraryEntries,
  librarySummary,
  overviewStatusLines,
  relationLabel,
  setCompareSummary,
  splitGitChanges,
  NAV_PAGES
} from "../app-v2-model";
import type { GitAreaReadModel, LibraryReadModel, OverviewReadModel, SetCompareReadModel } from "@ruleswitch/core";

function library(overrides: Partial<LibraryReadModel> = {}): LibraryReadModel {
  return {
    repositoryId: "repo_" + "a".repeat(64),
    headRevision: "abc1234def5678",
    branch: "main",
    entries: [],
    draftCount: 0,
    ...overrides
  };
}

describe("v2 UI read-model helpers (INH-1808/1810/1811)", () => {
  it("nav exposes the frozen 7-page order", () => {
    expect(NAV_PAGES.map((page) => page.id)).toEqual([
      "overview",
      "library",
      "harnesses",
      "projects",
      "changes",
      "history",
      "settings"
    ]);
  });

  it("groups library entries by kind with drafts first, deterministic", () => {
    const entries = [
      { assetKey: "b", kind: "skills" as const, logicalName: "b/SKILL.md", state: "head" as const, digest: "d", byteLength: 1, kindGroup: "Skills" },
      { assetKey: "a", kind: "instructions" as const, logicalName: "AGENTS.md", state: "draft" as const, digest: "d", byteLength: 1, kindGroup: "Rules" },
      { assetKey: "c", kind: "skills" as const, logicalName: "a/SKILL.md", state: "draft" as const, digest: "d", byteLength: 1, kindGroup: "Skills" }
    ];
    const grouped = groupLibraryEntries(entries);
    expect(grouped.map((group) => group.group)).toEqual(["Rules", "Skills"]);
    expect(grouped[1]?.entries.map((entry) => entry.logicalName)).toEqual(["a/SKILL.md", "b/SKILL.md"]);
    // Deterministic
    expect(JSON.stringify(groupLibraryEntries(entries))).toBe(JSON.stringify(groupLibraryEntries([...entries].reverse())));
  });

  it("library summary distinguishes HEAD from drafts", () => {
    expect(librarySummary(null)).toContain("未连接");
    expect(librarySummary(library())).toContain("HEAD abc1234");
    expect(librarySummary(library({ draftCount: 2 }))).toContain("2 个工作树草稿");
  });

  it("overview lines guide an unbound user and summarize a bound one", () => {
    expect(overviewStatusLines(null)[0]).toContain("尚未连接");
    const bound: OverviewReadModel = {
      repositoryBound: true,
      repositoryId: "repo_x",
      branch: "main",
      workingTree: "clean",
      pendingPublish: false,
      projectCount: 2,
      harnessCount: 3,
      libraryDrafts: 1
    };
    const lines = overviewStatusLines(bound);
    expect(lines.some((line) => line.includes("工作树：clean"))).toBe(true);
    expect(lines.some((line) => line.includes("1 个未提交草稿"))).toBe(true);
  });

  it("splits git changes into managed/unmanaged with pending publish surfaced", () => {
    const gitArea: GitAreaReadModel = {
      headRevision: "abc",
      upstreamRevision: "abc",
      remoteStatus: "up-to-date",
      ahead: 0,
      behind: 0,
      workingTree: "dirty-mixed",
      pendingPublish: true,
      changes: [
        { logicalPath: "global/a.md", managed: true, staged: false, kind: "modify" },
        { logicalPath: "notes.md", managed: false, staged: false, kind: "create" }
      ]
    };
    const split = splitGitChanges(gitArea);
    expect(split.managed).toEqual(["global/a.md"]);
    expect(split.unmanaged).toEqual(["notes.md"]);
    expect(split.summary).toContain("有待发布提交");
  });

  it("set-compare labels use prototype copy and unknown-baseline is surfaced", () => {
    expect(relationLabel("identical")).toBe("效果一致");
    expect(relationLabel("target-only")).toContain("完整保留");
    expect(relationLabel("both-modified")).toContain("需先解决");
    const compare: SetCompareReadModel = {
      confidence: "unknown-baseline",
      diffs: [
        {
          assetKey: "skills|a",
          sourceAssetKey: "global/skills/a/SKILL.md",
          targetAssetKey: "native/codex/skills/a/SKILL.md",
          kind: "skills",
          relation: "both-modified"
        }
      ]
    };
    expect(setCompareSummary(compare)).toContain("无可信共同基线");
  });
});
