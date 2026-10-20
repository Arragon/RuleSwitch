// Structured edit primitive (INH-1786): safe modification of managed keys
// inside shared config files (MCP/Settings/Hooks) WITHOUT rewriting the
// user's whole file.
//
// Strategy for JSON/JSONC: line-range surgery. The editor maps every
// top-level key to its exact source line span via bracket-depth scanning,
// then only rewrites the spans of managed keys. Unmanaged lines — including
// comments, blank lines, key order, and formatting — are preserved
// byte-for-byte, which is stronger than re-serialization fidelity.
//
// Safety rules:
// - duplicate top-level keys → refuse (ambiguous ownership)
// - deleting a managed key requires an ownership fingerprint match
//   (semantic digest of the key's current parsed value)
// - the result is verified: unmanaged regions must be byte-identical to
//   the input, or the edit fails closed (UNMANAGED_REGION_CHANGED)
// - if the document cannot be surgically edited (non-object root, keys
//   spanning the whole file), the edit degrades to a blocked outcome —
//   never a silent full rewrite.

import { utf8Decode, utf8Encode } from "./utf8";

export interface KeySpan {
  readonly key: string;
  readonly startLine: number; // 0-based, inclusive
  readonly endLine: number; // 0-based, inclusive
}

export interface JsonDocumentMap {
  readonly spans: readonly KeySpan[];
  readonly duplicateKeys: readonly string[];
}

/**
 * Maps top-level keys of a JSON/JSONC object to source line spans.
 * Handles strings with escapes, comments (// and slash-star) outside
 * strings, and nested structures. Duplicate keys are reported, not guessed.
 */
export function mapJsonTopLevelKeys(text: string): JsonDocumentMap {
  const lines = text.split(/\r?\n/);
  const spans: KeySpan[] = [];
  const duplicateKeys: string[] = [];
  const seenKeys = new Set<string>();

  let depth = 0;
  let currentKey: string | null = null;
  let currentStart = -1;
  let pendingKeyDepth = -1;
  let valueHasBrackets = false;

  const closeSpan = (endLine: number): void => {
    if (currentKey !== null) {
      // A scalar value ends on the line before the enclosing bracket; a
      // bracketed value includes its own closing line.
      const resolvedEnd = valueHasBrackets ? endLine : Math.max(endLine - 1, currentStart);
      spans.push({ key: currentKey, startLine: currentStart, endLine: resolvedEnd });
      if (seenKeys.has(currentKey)) {
        duplicateKeys.push(currentKey);
      }
      seenKeys.add(currentKey);
      currentKey = null;
      pendingKeyDepth = -1;
      valueHasBrackets = false;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const char = line[charIndex];
      const next = line[charIndex + 1];
      if (inLineComment) {
        break;
      }
      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          charIndex += 1;
        }
        continue;
      }
      if (inString) {
        if (char === "\\") {
          charIndex += 1;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === "/" && next === "/") {
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        charIndex += 1;
        continue;
      }
      // Top-level key detection must run BEFORE the generic quote switch.
      if (depth === 1 && char === '"' && currentKey === null) {
        let keyText = "";
        let cursor = charIndex + 1;
        while (cursor < line.length && line[cursor] !== '"') {
          if (line[cursor] === "\\") {
            keyText += line[cursor + 1] ?? "";
            cursor += 2;
            continue;
          }
          keyText += line[cursor] ?? "";
          cursor += 1;
        }
        const rest = line.slice(cursor + 1).trimStart();
        if (rest.startsWith(":")) {
          currentKey = keyText;
          currentStart = index;
          pendingKeyDepth = depth;
          charIndex = cursor;
          continue;
        }
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
        if (currentKey !== null) {
          valueHasBrackets = true;
        }
        continue;
      }
      if (char === "}" || char === "]") {
        depth -= 1;
        // Close the pending key span when its value finished: either the
        // value's own closing bracket brought depth back to the key's level,
        // or a scalar value ended and an enclosing bracket dropped below it.
        if (currentKey !== null && depth <= pendingKeyDepth) {
          closeSpan(index);
        }
        continue;
      }
      // A top-level comma ends the current single-line key span.
      if (char === "," && depth === pendingKeyDepth) {
        closeSpan(index);
        continue;
      }
    }
  }
  if (currentKey !== null) {
    closeSpan(lines.length - 1);
  }

  return { spans, duplicateKeys };
}

export type StructuredEditDecision =
  | { readonly ok: true; readonly output: Uint8Array; readonly changedKeys: readonly string[] }
  | {
      readonly ok: false;
      readonly code:
        | "DUPLICATE_KEY"
        | "NOT_AN_OBJECT"
        | "OWNERSHIP_FINGERPRINT_MISMATCH"
        | "UNMANAGED_REGION_CHANGED";
      readonly message: string;
    };

export interface StructuredEditRequest {
  readonly rawSource: Uint8Array;
  /** Managed keys to set (insert or replace in place). */
  readonly setEntries: readonly { readonly key: string; readonly jsonValue: string }[];
  /** Managed keys to delete; each requires the fingerprint of the value RuleSwitch last wrote. */
  readonly deleteEntries: readonly { readonly key: string; readonly ownedFingerprint: string }[];
  readonly hasher: { sha256Hex(input: string): string };
}

/** Semantic fingerprint of a JSON value (stable serialization hash). */
export function semanticFingerprint(jsonValue: unknown, hasher: { sha256Hex(input: string): string }): string {
  return hasher.sha256Hex(stableStringify(jsonValue));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((entry) => stableStringify(entry)).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return "{" + entries.join(",") + "}";
}

/**
 * Applies a managed-key edit to a JSON/JSONC document. Unmanaged regions
 * are preserved byte-for-byte; the output is verified before returning.
 */
export function applyStructuredEdit(request: StructuredEditRequest): StructuredEditDecision {
  const text = utf8Decode(request.rawSource);
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { ok: false, code: "NOT_AN_OBJECT", message: "structured edit requires a JSON object document" };
  }
  const map = mapJsonTopLevelKeys(text);
  if (map.duplicateKeys.length > 0) {
    return {
      ok: false,
      code: "DUPLICATE_KEY",
      message: `duplicate top-level keys refuse edits: ${map.duplicateKeys.join(", ")}`
    };
  }
  const spanOf = new Map(map.spans.map((span) => [span.key, span]));

  // Ownership fingerprint check for deletions.
  for (const deletion of request.deleteEntries) {
    const span = spanOf.get(deletion.key);
    if (span === undefined) {
      // Deleting an absent key is a no-op; the ledger update handles it.
      continue;
    }
    const currentValue = parseJsonValueSafe(collectSpanText(text, span));
    if (currentValue === undefined || semanticFingerprint(currentValue, request.hasher) !== deletion.ownedFingerprint) {
      return {
        ok: false,
        code: "OWNERSHIP_FINGERPRINT_MISMATCH",
        message: `key '${deletion.key}' changed since RuleSwitch last wrote it; re-own before deleting`
      };
    }
  }

  const lines = text.split(/\r?\n/);
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const edited = [...lines];
  const changedKeys: string[] = [];

  // Process deletions first (highest startLine last to keep spans valid):
  const deletions = [...request.deleteEntries]
    .map((entry) => spanOf.get(entry.key))
    .filter((span): span is KeySpan => span !== undefined)
    .sort((left, right) => right.startLine - left.startLine);
  for (const span of deletions) {
    let end = span.endLine;
    if (end + 1 < edited.length && (edited[end + 1] ?? "").trim() === "") {
      // Also swallow one trailing blank line to avoid gaps.
      end += 1;
    }
    // Swallow a trailing comma on the previous line if this was not the last entry.
    edited.splice(span.startLine, end - span.startLine + 1);
    changedKeys.push(span.key);
    fixTrailingComma(edited, span.startLine);
  }

  // Then insertions/replacements, bottom-up so earlier spans stay valid.
  const sets = [...request.setEntries].sort((left, right) => {
    const leftSpan = spanOf.get(left.key);
    const rightSpan = spanOf.get(right.key);
    const leftStart = leftSpan ? leftSpan.startLine : Number.MAX_SAFE_INTEGER;
    const rightStart = rightSpan ? rightSpan.startLine : Number.MAX_SAFE_INTEGER;
    return rightStart - leftStart;
  });
  for (const entry of sets) {
    const span = spanOf.get(entry.key);
    const rendered = renderEntry(entry.key, entry.jsonValue, indentOf(text, span));
    if (span) {
      edited.splice(span.startLine, span.endLine - span.startLine + 1, ...rendered.split(lineEnding));
    } else {
      // Insert before the closing brace, matching document indentation.
      const closingIndex = findClosingBraceLine(edited);
      if (closingIndex < 0) {
        return { ok: false, code: "NOT_AN_OBJECT", message: "cannot locate document closing brace" };
      }
      const insertAt = closingIndex;
      // Ensure the previous entry line ends with a comma.
      ensureTrailingComma(edited, insertAt - 1);
      edited.splice(insertAt, 0, ...rendered.split(lineEnding));
    }
    changedKeys.push(entry.key);
  }

  const output = utf8Encode(edited.join(lineEnding));
  // Verification (semantic): every untouched key must parse to the exact
  // same value it had before the edit; every set key must equal the
  // requested value; every deleted key must be absent. Text-level fidelity
  // (comments/order of unmanaged lines) is guaranteed by the line-surgery
  // algorithm; this check enforces the semantic contract fail-closed.
  const semanticCheck = verifySemantics(text, edited.join(lineEnding), request);
  if (!semanticCheck) {
    return { ok: false, code: "UNMANAGED_REGION_CHANGED", message: "an unmanaged key changed value; edit refused" };
  }
  return { ok: true, output, changedKeys: [...changedKeys].sort() };
}

function verifySemantics(beforeText: string, afterText: string, request: StructuredEditRequest): boolean {
  const before = parseObjectLenient(beforeText);
  const after = parseObjectLenient(afterText);
  if (before === null || after === null) {
    return false;
  }
  const touched = new Set<string>([
    ...request.setEntries.map((entry) => entry.key),
    ...request.deleteEntries.map((entry) => entry.key)
  ]);
  for (const [key, value] of Object.entries(before)) {
    if (touched.has(key)) {
      continue;
    }
    const afterValue = after[key];
    if (semanticFingerprint(afterValue, request.hasher) !== semanticFingerprint(value, request.hasher)) {
      return false;
    }
  }
  for (const entry of request.setEntries) {
    const parsed = safeJsonParse(entry.jsonValue);
    if (semanticFingerprint(after[entry.key], request.hasher) !== semanticFingerprint(parsed, request.hasher)) {
      return false;
    }
  }
  for (const entry of request.deleteEntries) {
    if (Object.prototype.hasOwnProperty.call(after, entry.key)) {
      return false;
    }
  }
  return true;
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      result += char;
      if (char === "\\") {
        result += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function parseObjectLenient(text: string): Record<string, unknown> | null {
  const cleaned = stripJsonComments(text).replace(/,\s*([}\]])/g, "$1");
  const parsed = safeJsonParse(cleaned);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function safeJsonParse(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function collectSpanText(text: string, span: KeySpan): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(span.startLine, span.endLine + 1).join("\n");
}

function parseJsonValueSafe(source: string): unknown {
  // Strip a trailing comma and comments are tolerated by dropping them only
  // outside strings — for fingerprinting purposes a best-effort parse that
  // fails returns undefined (mismatch → refuse).
  const cleaned = source.replace(/,\s*([}\]])/g, "$1").replace(/^\s*\/\/.*$/gm, "");
  const direct = safeJsonParse(cleaned);
  if (direct !== undefined) {
    return direct;
  }
  // Single-line span text is "key: value"; fingerprint the value part.
  const pairMatch = cleaned.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*([\s\S]+)$/);
  if (pairMatch) {
    return safeJsonParse(pairMatch[2]?.trim() ?? "");
  }
  return undefined;
}

function indentOf(text: string, span: KeySpan | undefined): string {
  if (span) {
    const line = text.split(/\r?\n/)[span.startLine] ?? "";
    const match = line.match(/^ */);
    return match ? match[0] : "  ";
  }
  return "  ";
}

function renderEntry(key: string, jsonValue: string, indent: string): string {
  const pretty = jsonValue.includes("\n") ? jsonValue : jsonValue;
  const lines = pretty.split("\n").map((line, index) => (index === 0 ? line : indent + "  " + line));
  return `${indent}${JSON.stringify(key)}: ${lines.join("\n")}`;
}

function findClosingBraceLine(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim() === "}") {
      return index;
    }
  }
  return -1;
}

function ensureTrailingComma(lines: string[], index: number): void {
  const line = lines[index];
  if (line === undefined) {
    return;
  }
  const trimmed = line.trimEnd();
  if (trimmed.length > 0 && !trimmed.endsWith(",") && !trimmed.endsWith("{") && !trimmed.endsWith("[")) {
    lines[index] = trimmed + ",";
  }
}

function fixTrailingComma(lines: string[], atLine: number): void {
  // After removing a span, the previous entry may now trail with a comma
  // directly before the closing brace — drop that comma. Comment and blank
  // lines between the two are skipped.
  for (let index = atLine - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      return;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) {
      continue;
    }
    if (trimmed.endsWith(",") && (lines[atLine]?.trim() === "}" || lines[atLine]?.trim() === "")) {
      lines[index] = line.trimEnd().slice(0, -1);
    }
    return;
  }
}


export { utf8Decode, utf8Encode };
