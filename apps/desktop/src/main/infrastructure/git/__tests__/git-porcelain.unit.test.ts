import { describe, expect, it } from "vitest";

import {
  decodeLogCursor,
  encodeLogCursor,
  parseLsFiles,
  parseLsTree,
  parseNameStatus,
  parsePorcelainV2,
  parseStructuredLog
} from "../git-porcelain";

function nul(...parts: string[]): string {
  return parts.join("\0");
}

describe("porcelain v2 status parsing (INH-1760/1846)", () => {
  it("parses branch headers, ahead/behind, and changed entries", () => {
    const output = nul(
      "# branch.oid 4f5e6d7c8b9a",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -2",
      "1 .M N... 100644 100644 100644 abcdef1 abcdef1 global/skills/a/SKILL.md",
      "1 M. N... 100644 100644 100644 1234567 89abcde global/instructions/AGENTS.md",
      "? notes.md",
      "! build-output.log"
    );
    const parsed = parsePorcelainV2(output);
    if ("failure" in parsed) {
      throw new Error(parsed.failure.reason);
    }
    const status = parsed.status;
    expect(status.headRevision).toBe("4f5e6d7c8b9a");
    expect(status.branch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(2);
    expect(status.entries).toHaveLength(4);
    expect(status.entries[0]).toMatchObject({
      logicalPath: "global/skills/a/SKILL.md",
      staged: false,
      unstaged: true
    });
    expect(status.entries[1]).toMatchObject({
      logicalPath: "global/instructions/AGENTS.md",
      staged: true,
      unstaged: false
    });
    expect(status.entries[2]).toMatchObject({ logicalPath: "notes.md", untracked: true });
    expect(status.entries[3]).toMatchObject({ logicalPath: "build-output.log", ignored: true });
  });

  it("reports detached HEAD and empty repositories without throwing", () => {
    const detached = parsePorcelainV2(nul("# branch.oid abc", "# branch.head (detached)"));
    if ("failure" in detached) {
      throw new Error(detached.failure.reason);
    }
    expect(detached.status.branch).toBe("(detached)");
    expect(detached.status.upstream).toBeNull();
    expect(detached.status.ahead).toBeNull();

    const initial = parsePorcelainV2(nul("# branch.oid (initial)", "# branch.head main"));
    if ("failure" in initial) {
      throw new Error(initial.failure.reason);
    }
    expect(initial.status.headRevision).toBeNull();
  });

  it("parses rename records with their NUL-separated path pair", () => {
    const output = nul(
      "# branch.oid abc",
      "# branch.head main",
      "2 R. N... 100644 100644 100644 aaa bbb 100 global/new.md",
      "global/old.md"
    );
    const parsed = parsePorcelainV2(output);
    if ("failure" in parsed) {
      throw new Error(parsed.failure.reason);
    }
    expect(parsed.status.entries[0]).toMatchObject({
      logicalPath: "global/new.md",
      originalPath: "global/old.md",
      staged: true
    });
  });

  it("returns structured failures for unknown records", () => {
    const parsed = parsePorcelainV2(nul("garbage record"));
    expect("failure" in parsed).toBe(true);
  });
});

describe("name-status diff parsing (INH-1846)", () => {
  it("parses adds, deletes, modifies, and renames", () => {
    const parsed = parseNameStatus(nul("A", "global/new.md", "D", "global/gone.md", "M", "ruleswitch.yaml", "R100", "global/old.md", "global/moved.md"));
    if ("failure" in parsed) {
      throw new Error(parsed.failure.reason);
    }
    expect(parsed.entries).toEqual([
      { kind: "create", newPath: "global/new.md", originalPath: null },
      { kind: "delete", newPath: "global/gone.md", originalPath: null },
      { kind: "modify", newPath: "ruleswitch.yaml", originalPath: null },
      { kind: "rename", newPath: "global/moved.md", originalPath: "global/old.md" }
    ]);
  });

  it("rejects malformed token streams explicitly", () => {
    expect("failure" in parseNameStatus(nul("X", "a.md"))).toBe(true);
    expect("failure" in parseNameStatus(nul("R100", "only-one-path"))).toBe(true);
  });
});

describe("blob listing parsers", () => {
  it("parses ls-tree blob lines and skips submodules", () => {
    const tree = parseLsTree("100644 blob abc123\tglobal/a.md\n160000 commit def456\tvendor/lib\n");
    expect(tree.get("global/a.md")).toBe("abc123");
    expect(tree.has("vendor/lib")).toBe(false);
  });

  it("parses ls-files staged entries and skips conflicts", () => {
    const files = parseLsFiles("100644 abc123 0\tglobal/a.md\n100644 def456 2\tglobal/conflict.md\n");
    expect(files.get("global/a.md")).toBe("abc123");
    expect(files.has("global/conflict.md")).toBe(false);
  });
});

describe("structured log (INH-1846)", () => {
  it("round-trips the frozen log format", () => {
    const sample = `rev1${"\x1f"}parent1 parent2${"\x1f"}Alice${"\x1f"}2026-10-07T10:00:00+08:00${"\x1f"}subject one${"\x1e"}rev2${"\x1f"}parent1${"\x1f"}Bob${"\x1f"}2026-10-06T09:00:00Z${"\x1f"}subject two${"\x1e"}`;
    const parsed = parseStructuredLog(sample);
    expect(parsed).toEqual([
      {
        revision: "rev1",
        parents: ["parent1", "parent2"],
        authorName: "Alice",
        authoredAt: "2026-10-07T10:00:00+08:00",
        subject: "subject one"
      },
      {
        revision: "rev2",
        parents: ["parent1"],
        authorName: "Bob",
        authoredAt: "2026-10-06T09:00:00Z",
        subject: "subject two"
      }
    ]);
  });

  it("encodes and decodes opaque cursors, rejecting garbage", () => {
    expect(decodeLogCursor(null)).toBe(0);
    expect(decodeLogCursor("")).toBe(0);
    expect(decodeLogCursor(encodeLogCursor(40))).toBe(40);
    expect(decodeLogCursor("not-a-cursor")).toBeNull();
    expect(decodeLogCursor(Buffer.from("offset:-1").toString("base64url"))).toBeNull();
  });
});
