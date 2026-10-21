// Path-safety guards (M9 preparation). The same logical name must be safe on
// macOS, Linux and Windows, so Windows-shaped hazards are refused on every
// platform — "works on my machine" is not a containment rule.

import { describe, expect, it } from "vitest";

import {
  assertSafeRelativePath,
  collidesCaseInsensitively,
  hasWindowsTrailingQuirk,
  isSafeRelativePath,
  isWindowsReservedName
} from "../path-safety";

describe("isSafeRelativePath", () => {
  it("accepts ordinary nested logical names", () => {
    expect(isSafeRelativePath("AGENTS.md")).toBe(true);
    expect(isSafeRelativePath("skills/review/SKILL.md")).toBe(true);
    expect(isSafeRelativePath("a.b/c-d_e.md")).toBe(true);
  });

  it("rejects traversal, absolute and drive-qualified paths", () => {
    expect(isSafeRelativePath("../AGENTS.md")).toBe(false);
    expect(isSafeRelativePath("skills/../../AGENTS.md")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:/Users/me/AGENTS.md")).toBe(false);
    expect(isSafeRelativePath("c:\\Users\\me\\AGENTS.md")).toBe(false);
    expect(isSafeRelativePath("//server/share/AGENTS.md")).toBe(false);
    expect(isSafeRelativePath("skills//SKILL.md")).toBe(false);
    expect(isSafeRelativePath("./AGENTS.md")).toBe(false);
    expect(isSafeRelativePath("AGENTS.md\0")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("rejects Windows device names even when they carry an extension", () => {
    expect(isSafeRelativePath("NUL")).toBe(false);
    expect(isSafeRelativePath("nul.md")).toBe(false);
    expect(isSafeRelativePath("COM1")).toBe(false);
    expect(isSafeRelativePath("lpt9.txt")).toBe(false);
    expect(isSafeRelativePath("CON")).toBe(false);
    expect(isSafeRelativePath("AUX")).toBe(false);
    // Adjacent names stay usable: the check is on the whole segment.
    expect(isSafeRelativePath("console.md")).toBe(true);
    expect(isSafeRelativePath("null-skill.md")).toBe(true);
  });

  it("rejects trailing dots and spaces that Windows would silently rewrite", () => {
    expect(isSafeRelativePath("AGENTS.md.")).toBe(false);
    expect(isSafeRelativePath("AGENTS.md ")).toBe(false);
    expect(isSafeRelativePath("skills/AGENTS.md .")).toBe(false);
  });
});

describe("assertSafeRelativePath", () => {
  it("returns the path when it is safe", () => {
    expect(assertSafeRelativePath("skills/review/SKILL.md", "target path")).toBe(
      "skills/review/SKILL.md"
    );
  });

  it("explains why a path was refused", () => {
    expect(() => assertSafeRelativePath("../x.md", "target path")).toThrow(/traversal/);
    expect(() => assertSafeRelativePath("D:\\x.md", "target path")).toThrow(/backslash/);
    expect(() => assertSafeRelativePath("D:/x.md", "target path")).toThrow(/drive-qualified/);
    expect(() => assertSafeRelativePath("NUL.md", "target path")).toThrow(/reserved device name/);
    expect(() => assertSafeRelativePath("x.md.", "target path")).toThrow(/trailing dot or space/);
    expect(() => assertSafeRelativePath("", "target path")).toThrow(/empty/);
  });
});

describe("case-insensitive collision detection", () => {
  it("reports names that a Windows or default macOS filesystem would merge", () => {
    expect(collidesCaseInsensitively("AGENTS.md", "agents.md")).toBe(true);
    expect(collidesCaseInsensitively("skills/A.md", "skills/a.md")).toBe(true);
  });

  it("does not treat identical or genuinely different names as collisions", () => {
    expect(collidesCaseInsensitively("AGENTS.md", "AGENTS.md")).toBe(false);
    expect(collidesCaseInsensitively("AGENTS.md", "RULES.md")).toBe(false);
  });
});

describe("Windows name quirks", () => {
  it("detects reserved device names case-insensitively", () => {
    expect(isWindowsReservedName("con")).toBe(true);
    expect(isWindowsReservedName("Com3")).toBe(true);
    expect(isWindowsReservedName("converter")).toBe(false);
  });

  it("detects trailing dots and spaces only at the end of a segment", () => {
    expect(hasWindowsTrailingQuirk("a .md")).toBe(false);
    expect(hasWindowsTrailingQuirk("a.md ")).toBe(true);
    expect(hasWindowsTrailingQuirk("")).toBe(false);
  });
});
