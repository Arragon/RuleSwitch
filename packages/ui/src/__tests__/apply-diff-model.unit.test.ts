// Presentation helpers for the Preview diff: pure counting/labelling over
// Main-produced text. Run in the unit suite (node env, no React, no Monaco).

import { describe, expect, it } from "vitest";

import type { ApplyFileDiff } from "@ruleswitch/core";

import {
  applyDiffSummaryText,
  diffLineStats,
  editorLanguageForName,
  preferredDiffFileIndex,
  summarizeApplyDiff
} from "../apply-diff-model";

function file(overrides: Partial<ApplyFileDiff> & { readonly logicalName: string }): ApplyFileDiff {
  return {
    sourceText: null,
    targetText: null,
    targetExists: false,
    binary: false,
    identical: false,
    ...overrides
  };
}

describe("diffLineStats", () => {
  it("counts a missing original as a full insertion", () => {
    expect(diffLineStats(null, "a\nb\nc")).toEqual({ added: 3, removed: 0, exact: true });
  });

  it("counts a missing modified side as a full deletion", () => {
    expect(diffLineStats("a\nb", null)).toEqual({ added: 0, removed: 2, exact: true });
  });

  it("counts only the changed lines when both sides exist", () => {
    const stats = diffLineStats("# old\nshared\n", "# new\nshared\n");
    expect(stats).toEqual({ added: 1, removed: 1, exact: true });
  });

  it("reports no change for identical text", () => {
    expect(diffLineStats("same\n", "same\n")).toEqual({ added: 0, removed: 0, exact: true });
  });

  it("normalises CRLF so Windows files do not count as fully changed", () => {
    expect(diffLineStats("a\r\nb\r\n", "a\nb\n")).toEqual({ added: 0, removed: 0, exact: true });
  });

  it("falls back to an approximate count for very large files and says so", () => {
    const big = Array.from({ length: 1200 }, (_unused, index) => `line ${index}`).join("\n");
    const stats = diffLineStats(big, `${big}\nextra`);
    expect(stats.exact).toBe(false);
    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(0);
  });
});

describe("summarizeApplyDiff", () => {
  it("splits files into created / modified / unchanged / binary", () => {
    const summary = summarizeApplyDiff([
      file({ logicalName: "AGENTS.md", sourceText: "# new\n", targetText: null, targetExists: false }),
      file({ logicalName: "RULES.md", sourceText: "# b\n", targetText: "# a\n", targetExists: true }),
      file({ logicalName: "SAME.md", sourceText: "# s\n", targetText: "# s\n", targetExists: true, identical: true }),
      file({ logicalName: "blob.bin", binary: true, targetExists: true })
    ]);

    expect(summary).toMatchObject({
      fileCount: 4,
      created: 1,
      modified: 1,
      unchanged: 1,
      binary: 1,
      addedLines: 3
    });
    expect(applyDiffSummaryText(summary)).toContain("新建 1");
    expect(applyDiffSummaryText(summary)).toContain("二进制 1");
  });

  it("excludes binary files from line counting", () => {
    const summary = summarizeApplyDiff([file({ logicalName: "blob.bin", binary: true })]);
    expect(summary.addedLines).toBe(0);
    expect(summary.removedLines).toBe(0);
  });

  it("describes an empty file list without pretending there is a diff", () => {
    const summary = summarizeApplyDiff([]);
    expect(summary.fileCount).toBe(0);
    expect(applyDiffSummaryText(summary)).toBe("0 个文件 · +0 / -0");
  });
});

describe("editorLanguageForName", () => {
  it("maps configuration extensions to Monaco language ids", () => {
    expect(editorLanguageForName("AGENTS.md")).toBe("markdown");
    expect(editorLanguageForName("mcp.json")).toBe("json");
    expect(editorLanguageForName("config.yaml")).toBe("yaml");
    expect(editorLanguageForName("config.toml")).toBe("toml");
    expect(editorLanguageForName("notes.txt")).toBe("plaintext");
  });
});

describe("preferredDiffFileIndex", () => {
  it("opens on the first file that actually changes", () => {
    const index = preferredDiffFileIndex([
      file({ logicalName: "SAME.md", identical: true, targetExists: true }),
      file({ logicalName: "CHANGED.md" })
    ]);
    expect(index).toBe(1);
  });

  it("falls back to the first file when everything is unchanged", () => {
    expect(preferredDiffFileIndex([file({ logicalName: "a.md", identical: true })])).toBe(0);
  });

  it("skips binary files when picking the default", () => {
    const index = preferredDiffFileIndex([
      file({ logicalName: "blob.bin", binary: true }),
      file({ logicalName: "CHANGED.md" })
    ]);
    expect(index).toBe(1);
  });
});
