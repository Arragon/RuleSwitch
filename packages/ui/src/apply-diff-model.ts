// Presentation helpers for the Preview line-level diff (INH-1814). Pure
// functions: no filesystem, no IPC, no React. The Renderer receives both
// sides as text from Main and only decides how to show them.

import type { ApplyFileDiff } from "@ruleswitch/core";

export interface DiffLineStats {
  readonly added: number;
  readonly removed: number;
  /** False when the LCS was skipped (very large file) and the counts are approximate. */
  readonly exact: boolean;
}

/** Above this many lines per side the O(n*m) LCS is skipped. */
const MAX_LCS_LINES = 1000;

function splitLines(content: string | null): readonly string[] {
  if (content === null || content.length === 0) {
    return [];
  }
  return content.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Line-level added/removed counts via an LCS table. A missing side counts as
 * all-inserted / all-deleted, which is what "create a new file" and "remove"
 * mean for the operator reviewing the plan.
 */
export function diffLineStats(before: string | null, after: string | null): DiffLineStats {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length === 0) {
    return { added: afterLines.length, removed: 0, exact: true };
  }
  if (afterLines.length === 0) {
    return { added: 0, removed: beforeLines.length, exact: true };
  }
  if (beforeLines.length > MAX_LCS_LINES || afterLines.length > MAX_LCS_LINES) {
    const beforeSet = new Set(beforeLines);
    const afterSet = new Set(afterLines);
    let added = 0;
    for (const line of afterLines) {
      if (!beforeSet.has(line)) {
        added += 1;
      }
    }
    let removed = 0;
    for (const line of beforeLines) {
      if (!afterSet.has(line)) {
        removed += 1;
      }
    }
    return { added, removed, exact: false };
  }

  const rows = beforeLines.length + 1;
  const columns = afterLines.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      table[row * columns + column] =
        beforeLines[row - 1] === afterLines[column - 1]
          ? (table[(row - 1) * columns + (column - 1)] ?? 0) + 1
          : Math.max(table[(row - 1) * columns + column] ?? 0, table[row * columns + (column - 1)] ?? 0);
    }
  }
  const common = table[rows * columns - 1] ?? 0;
  return {
    added: afterLines.length - common,
    removed: beforeLines.length - common,
    exact: true
  };
}

export interface ApplyDiffSummary {
  readonly fileCount: number;
  readonly created: number;
  readonly modified: number;
  readonly unchanged: number;
  readonly binary: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly exact: boolean;
}

export function summarizeApplyDiff(files: readonly ApplyFileDiff[]): ApplyDiffSummary {
  let created = 0;
  let modified = 0;
  let unchanged = 0;
  let binary = 0;
  let addedLines = 0;
  let removedLines = 0;
  let exact = true;
  for (const file of files) {
    if (file.binary) {
      binary += 1;
      continue;
    }
    if (!file.targetExists) {
      created += 1;
    } else if (file.identical) {
      unchanged += 1;
    } else {
      modified += 1;
    }
    const stats = diffLineStats(file.targetText, file.sourceText);
    addedLines += stats.added;
    removedLines += stats.removed;
    exact = exact && stats.exact;
  }
  return {
    fileCount: files.length,
    created,
    modified,
    unchanged,
    binary,
    addedLines,
    removedLines,
    exact
  };
}

export function applyDiffSummaryText(summary: ApplyDiffSummary): string {
  const parts = [`${summary.fileCount} 个文件`];
  if (summary.created > 0) {
    parts.push(`新建 ${summary.created}`);
  }
  if (summary.modified > 0) {
    parts.push(`修改 ${summary.modified}`);
  }
  if (summary.unchanged > 0) {
    parts.push(`无变化 ${summary.unchanged}`);
  }
  if (summary.binary > 0) {
    parts.push(`二进制 ${summary.binary}`);
  }
  const lines = `${summary.exact ? "" : "≈"}+${summary.addedLines} / -${summary.removedLines}`;
  return `${parts.join(" · ")} · ${lines}`;
}

/** Monaco language id from the logical file name (Main owns the paths). */
export function editorLanguageForName(logicalName: string): string {
  const name = logicalName.toLocaleLowerCase("en-US");
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".json") || name.endsWith(".jsonc")) return "json";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".toml")) return "toml";
  if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) return "javascript";
  if (name.endsWith(".ts")) return "typescript";
  if (name.endsWith(".sh")) return "shell";
  return "plaintext";
}

/** Index of the file most worth showing first: changed before unchanged. */
export function preferredDiffFileIndex(files: readonly ApplyFileDiff[]): number {
  const index = files.findIndex((file) => !file.binary && !file.identical);
  return index === -1 ? 0 : index;
}
