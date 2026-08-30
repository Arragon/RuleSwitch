import type { FileResourceDto, FileResourceFormat } from "@ruleswitch/core";
import { describe, expect, test } from "vitest";

import {
  configurationGroupForPath,
  editorLanguageForFormat,
  groupConfigurationResources,
  splitMarkdownDocument
} from "../viewer-model";

function resource(logicalPath: string, format: FileResourceFormat): FileResourceDto {
  return {
    id: `resource-${logicalPath}`,
    workspaceId: "workspace-1",
    logicalPath,
    origin: "source",
    format,
    readonly: true,
    hash: { algorithm: "sha256", digest: "0".repeat(64) },
    byteLength: 1
  };
}

describe("configuration explorer model", () => {
  test("groups every Rulesync source without creating feature-specific viewers", () => {
    const groups = groupConfigurationResources([
      resource("skills/review/SKILL.md", "markdown"),
      resource("rules/base.md", "markdown"),
      resource("commands/release.md", "markdown"),
      resource("mcp.json", "json"),
      resource("settings/project.toml", "toml")
    ]);

    expect(groups.map((group) => [group.name, group.resources.map((item) => item.logicalPath)])).toEqual([
      ["Rules", ["rules/base.md"]],
      ["Skills", ["skills/review/SKILL.md"]],
      ["Commands", ["commands/release.md"]],
      ["MCP", ["mcp.json"]],
      ["Other", ["settings/project.toml"]]
    ]);
  });

  test("uses portable case folding for category names", () => {
    expect(configurationGroupForPath("RULES/Upper.md")).toBe("Rules");
    expect(configurationGroupForPath("MCP/config.jsonc")).toBe("MCP");
    expect(configurationGroupForPath("other/file.txt")).toBe("Other");
  });
});

describe("unified viewer model", () => {
  test.each([
    ["markdown", "markdown"],
    ["json", "json"],
    ["jsonc", "json"],
    ["yaml", "yaml"],
    ["toml", "toml"],
    ["text", "plaintext"],
    ["unknown", "plaintext"]
  ] as const)("maps %s resources to the %s Monaco language", (format, language) => {
    expect(editorLanguageForFormat(format)).toBe(language);
  });

  test("separates LF frontmatter from Markdown body", () => {
    expect(splitMarkdownDocument("---\nroot: true\ntags: [one, two]\n---\n# Body\n")).toEqual({
      frontmatter: "root: true\ntags: [one, two]",
      body: "# Body\n"
    });
  });

  test("preserves CRLF body content and ignores an unclosed frontmatter fence", () => {
    expect(splitMarkdownDocument("\ufeff---\r\nroot: true\r\n---\r\n# Body\r\n")).toEqual({
      frontmatter: "root: true",
      body: "# Body\r\n"
    });
    const unclosed = "---\nroot: true\n# Still source\n";
    expect(splitMarkdownDocument(unclosed)).toEqual({ frontmatter: null, body: unclosed });
  });
});
