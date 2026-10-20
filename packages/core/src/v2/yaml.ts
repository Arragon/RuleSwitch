// Restricted YAML subset parser for RuleSwitch's own frozen config formats
// (ruleswitch.yaml v1, project.yaml, profiles/*.yaml).
//
// Supported grammar (anything else is a syntax error — deliberate fail
// closed): nested mappings with consistent 2-space indentation, scalar
// values (plain / single-quoted / double-quoted), scalar lists with
// "- item", comments (#) outside quotes. No anchors, no flow collections,
// no block scalars, no multi-document.
//
// Errors carry { code, line, column, message } so diagnostics can point at
// the exact source location.

export type YamlValue = string | number | boolean | null | YamlMapping | YamlList;
export interface YamlMapping {
  readonly [key: string]: YamlValue | undefined;
}
export interface YamlList {
  readonly items: readonly YamlValue[];
}

export interface YamlSyntaxError {
  readonly code: "YAML_SYNTAX";
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export type YamlParseResult = { ok: true; value: YamlValue } | { ok: false; error: YamlSyntaxError };

interface Line {
  readonly indent: number;
  readonly content: string;
  readonly number: number;
}

const LIST_ITEM_PATTERN = /^-\s?(.*)$/;

export function parseYamlSubset(text: string): YamlParseResult {
  const lines: Line[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const withoutComment = stripComment(rawLines[index] ?? "");
    if (withoutComment.trim().length === 0) {
      continue;
    }
    const indentMatch = withoutComment.match(/^ */);
    const indent = indentMatch ? indentMatch[0].length : 0;
    if (indent % 2 !== 0) {
      return {
        ok: false,
        error: {
          code: "YAML_SYNTAX",
          line: index + 1,
          column: indent + 1,
          message: "indentation must use 2-space steps"
        }
      };
    }
    lines.push({ indent, content: withoutComment.trim(), number: index + 1 });
  }
  if (lines.length === 0) {
    return { ok: true, value: {} };
  }
  const parsed = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  if (parsed.error) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.nextIndex < lines.length) {
    const stray = lines[parsed.nextIndex];
    return {
      ok: false,
      error: {
        code: "YAML_SYNTAX",
        line: stray?.number ?? 1,
        column: (stray?.indent ?? 0) + 1,
        message: "unexpected content: indentation is inconsistent"
      }
    };
  }
  return { ok: true, value: parsed.value };
}

function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble && (index === 0 || raw[index - 1] === " " || raw[index - 1] === "\t")) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

interface BlockParse {
  value: YamlValue;
  nextIndex: number;
  error?: YamlSyntaxError;
}

function parseBlock(lines: readonly Line[], start: number, indent: number): BlockParse {
  const first = lines[start];
  if (!first) {
    return { value: {}, nextIndex: start };
  }
  if (LIST_ITEM_PATTERN.test(first.content)) {
    return parseListBlock(lines, start, indent);
  }
  return parseMappingBlock(lines, start, indent);
}

function parseListBlock(lines: readonly Line[], start: number, indent: number): BlockParse {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      return {
        value: null,
        nextIndex: index,
        error: {
          code: "YAML_SYNTAX",
          line: line.number,
          column: line.indent + 1,
          message: "unexpected indentation inside a scalar list"
        }
      };
    }
    const match = line.content.match(LIST_ITEM_PATTERN);
    if (!match) {
      break;
    }
    const scalarText = (match[1] ?? "").trim();
    if (scalarText.length === 0) {
      return {
        value: null,
        nextIndex: index,
        error: {
          code: "YAML_SYNTAX",
          line: line.number,
          column: 1,
          message: "list items must be scalars"
        }
      };
    }
    const scalar = parseScalar(scalarText, line);
    if (scalar.error) {
      return { value: null, nextIndex: index, error: scalar.error };
    }
    items.push(scalar.value);
    index += 1;
  }
  return { value: { items }, nextIndex: index };
}

function parseMappingBlock(lines: readonly Line[], start: number, indent: number): BlockParse {
  const mapping: Record<string, YamlValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      return {
        value: null,
        nextIndex: index,
        error: { code: "YAML_SYNTAX", line: line.number, column: line.indent + 1, message: "unexpected indentation" }
      };
    }
    const separator = findKeySeparator(line.content);
    if (separator < 0) {
      return {
        value: null,
        nextIndex: index,
        error: { code: "YAML_SYNTAX", line: line.number, column: 1, message: "expected 'key: value'" }
      };
    }
    const keyText = line.content.slice(0, separator).trim();
    const keyResult = unquoteOrError(keyText, line);
    if (!keyResult.ok) {
      return { value: null, nextIndex: index, error: keyResult.error };
    }
    const key = keyResult.value;
    if (key.length === 0) {
      return {
        value: null,
        nextIndex: index,
        error: { code: "YAML_SYNTAX", line: line.number, column: 1, message: "empty mapping key" }
      };
    }
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      return {
        value: null,
        nextIndex: index,
        error: { code: "YAML_SYNTAX", line: line.number, column: 1, message: `duplicate key '${key}'` }
      };
    }
    const valueText = line.content.slice(separator + 1).trim();
    if (valueText.length === 0) {
      const next = lines[index + 1];
      if (next && next.indent > indent) {
        const child = parseBlock(lines, index + 1, next.indent);
        if (child.error) {
          return { value: null, nextIndex: index + 1, error: child.error };
        }
        mapping[key] = child.value;
        index = child.nextIndex;
        continue;
      }
      mapping[key] = null;
      index += 1;
      continue;
    }
    const scalar = parseScalar(valueText, line);
    if (scalar.error) {
      return { value: null, nextIndex: index, error: scalar.error };
    }
    mapping[key] = scalar.value;
    index += 1;
  }
  return { value: mapping, nextIndex: index };
}

function findKeySeparator(content: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === ":" && !inSingle && !inDouble) {
      if (index + 1 >= content.length || content[index + 1] === " ") {
        return index;
      }
    }
  }
  return -1;
}

function parseScalar(
  text: string,
  line: Line
): { value: YamlValue; error?: never } | { value: null; error: YamlSyntaxError } {
  if (text.startsWith("[") || text.startsWith("{")) {
    return {
      value: null,
      error: { code: "YAML_SYNTAX", line: line.number, column: 1, message: "flow collections are not part of the frozen subset" }
    };
  }
  if (text.startsWith("&") || text.startsWith("*") || text.startsWith("!")) {
    return {
      value: null,
      error: { code: "YAML_SYNTAX", line: line.number, column: 1, message: "anchors, aliases and tags are not part of the frozen subset" }
    };
  }
  if (text.startsWith("'") || text.startsWith('"')) {
    const unquoted = unquoteOrError(text, line);
    if (!unquoted.ok) {
      return { value: null, error: unquoted.error };
    }
    return { value: unquoted.value };
  }
  if (text === "true") {
    return { value: true };
  }
  if (text === "false") {
    return { value: false };
  }
  if (text === "null" || text === "~") {
    return { value: null };
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return { value: Number(text) };
  }
  return { value: text.normalize("NFC") };
}

function unquoteOrError(text: string, line: Line): { ok: true; value: string } | { ok: false; error: YamlSyntaxError } {
  try {
    return { ok: true, value: unquote(text) };
  } catch (error) {
    return {
      ok: false,
      error: { code: "YAML_SYNTAX", line: line.number, column: 1, message: (error as Error).message }
    };
  }
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    // Double-quoted scalars interpret the common escapes; anything else
    // after a backslash is rejected fail-closed rather than guessed.
    let result = "";
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index];
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escape = inner[index + 1];
      if (escape === "n") {
        result += "\n";
      } else if (escape === "t") {
        result += "\t";
      } else if (escape === "\\") {
        result += "\\";
      } else if (escape === '"') {
        result += '"';
      } else {
        throw new Error(`unsupported escape sequence '\\${escape ?? ""}' in double-quoted scalar`);
      }
      index += 1;
    }
    return result.normalize("NFC");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).normalize("NFC");
  }
  return trimmed.normalize("NFC");
}
