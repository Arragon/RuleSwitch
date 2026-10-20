import { describe, expect, it } from "vitest";

import { parseYamlSubset } from "../yaml";

describe("restricted YAML subset parser", () => {
  it("parses nested mappings, lists, scalars, and comments", () => {
    const text = [
      "# top comment",
      "schemaVersion: 1",
      "repository:",
      "  name: 我的 配置",
      "profiles:",
      "  - default",
      "  - work",
      "quoted: \"hello: world\"",
      "single: 'it''s fine'",
      "number: 42",
      "flag: true",
      "empty: null"
    ].join("\n");
    const parsed = parseYamlSubset(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const value = parsed.value as Record<string, unknown>;
      expect(value.schemaVersion).toBe(1);
      expect((value.repository as Record<string, unknown>).name).toBe("我的 配置");
      expect((value.profiles as { items: unknown[] }).items).toEqual(["default", "work"]);
      expect(value.quoted).toBe("hello: world");
      expect(value.number).toBe(42);
      expect(value.flag).toBe(true);
      expect(value.empty).toBeNull();
    }
  });

  it("reports line and column for syntax errors", () => {
    const badIndent = parseYamlSubset("a:\n   b: 1\n");
    expect(badIndent.ok).toBe(false);
    if (!badIndent.ok) {
      expect(badIndent.error.line).toBe(2);
      expect(badIndent.error.message).toContain("2-space");
    }

    const noColon = parseYamlSubset("just text\n");
    expect(noColon.ok).toBe(false);
    if (!noColon.ok) {
      expect(noColon.error.code).toBe("YAML_SYNTAX");
      expect(noColon.error.line).toBe(1);
    }

    const duplicate = parseYamlSubset("a: 1\na: 2\n");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.message).toContain("duplicate key 'a'");
    }
  });

  it("rejects grammar outside the frozen subset (fail closed)", () => {
    expect(parseYamlSubset("flow: [1, 2]\n").ok).toBe(false);
    expect(parseYamlSubset("anchor: &x 1\n").ok).toBe(false);
    expect(parseYamlSubset("alias: *x\n").ok).toBe(false);
    expect(parseYamlSubset("tag: !!str x\n").ok).toBe(false);
  });

  it("treats empty input as an empty mapping", () => {
    const parsed = parseYamlSubset("\n# only a comment\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({});
    }
  });

  it("NFC-normalizes scalar values", () => {
    const parsed = parseYamlSubset("key: em\u0065\u0301\n".replace("em\u0065\u0301", "em\u0065\u0301"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.value as Record<string, unknown>).key).toBe("em\u00e9".normalize("NFC"));
    }
  });
});
