import type { FileResourceDto, FileResourceFormat } from "@ruleswitch/core";

export const CONFIGURATION_GROUPS = ["Rules", "Skills", "Commands", "MCP", "Other"] as const;
export type ConfigurationGroup = (typeof CONFIGURATION_GROUPS)[number];

export interface ConfigurationGroupModel {
  readonly name: ConfigurationGroup;
  readonly resources: readonly FileResourceDto[];
}

export interface MarkdownDocument {
  readonly frontmatter: string | null;
  readonly body: string;
}

export function groupConfigurationResources(
  resources: readonly FileResourceDto[]
): readonly ConfigurationGroupModel[] {
  const grouped = new Map<ConfigurationGroup, FileResourceDto[]>(
    CONFIGURATION_GROUPS.map((name) => [name, []])
  );
  for (const resource of resources) {
    grouped.get(configurationGroupForPath(resource.logicalPath))?.push(resource);
  }
  return CONFIGURATION_GROUPS.map((name) => ({
    name,
    resources: [...(grouped.get(name) ?? [])].sort((left, right) =>
      left.logicalPath.localeCompare(right.logicalPath, "en")
    )
  })).filter((group) => group.resources.length > 0);
}

export function configurationGroupForPath(logicalPath: string): ConfigurationGroup {
  const [first = ""] = logicalPath.toLocaleLowerCase("en-US").split("/");
  if (first === "rules") return "Rules";
  if (first === "skills") return "Skills";
  if (first === "commands") return "Commands";
  if (first === "mcp" || first === "mcp.json" || first === "mcp.jsonc") return "MCP";
  return "Other";
}

export function editorLanguageForFormat(format: FileResourceFormat): string {
  switch (format) {
    case "markdown":
      return "markdown";
    case "json":
    case "jsonc":
      return "json";
    case "yaml":
      return "yaml";
    case "toml":
      return "toml";
    default:
      return "plaintext";
  }
}

export function splitMarkdownDocument(content: string): MarkdownDocument {
  const normalized = content.startsWith("\ufeff") ? content.slice(1) : content;
  const opening = normalized.match(/^---(?:\r?\n|$)/);
  if (opening === null) return { frontmatter: null, body: normalized };
  const offset = opening[0].length;
  const closing = normalized.slice(offset).match(/^(?:.|\r?\n)*?^---[\t ]*(?:\r?\n|$)/m);
  if (closing === null) return { frontmatter: null, body: normalized };
  const block = closing[0];
  const closingStart = block.lastIndexOf("---");
  return {
    frontmatter: block.slice(0, closingStart).replace(/\r?\n$/, ""),
    body: normalized.slice(offset + block.length)
  };
}

export function fileFormatLabel(format: FileResourceFormat): string {
  return format === "unknown" ? "FILE" : format.toLocaleUpperCase("en-US");
}
