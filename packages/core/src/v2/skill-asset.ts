// Skill Directory Asset semantics (INH-1774, M3): a skill is a WHOLE
// directory — SKILL.md plus scripts/references/assets and other controlled
// files — not a single file. The M2 graph keeps file-level asset keys
// (frozen); this module aggregates them into the directory-level view the
// adapters render/import as one unit.
//
// Frozen semantics:
// - Ordering: files sorted bytewise by relative path; aggregation is
//   deterministic regardless of filesystem enumeration order.
// - Digest: SHA-256 over sorted "relativePath|executable|contentDigest"
//   lines — any managed file change moves the skill digest, and the skill
//   asset key (`scope|skills|<name>`) stays the same, so any file edit
//   localizes to the same asset.
// - Executable bit: preserved where the platform expresses it (POSIX);
//   round-trip keeps mode 0o755 for scripts.
// - Symlinks: rejected by the file sources (repo + harness) before
//   aggregation ever sees them; undeclared/escaping links cannot enter a
//   skill asset.
// - Deletion: removing a managed file inside the skill is a skill-asset
//   change; deleting the whole skill follows binding-engine delete
//   semantics (owned + digest proof, never on first adoption).

import type { StableIdHasher } from "./identity";

export interface SkillFile {
  readonly relativePath: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export interface SkillAsset {
  readonly skillName: string;
  readonly files: readonly SkillFile[];
  readonly digest: string;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Deterministic binary digest via the frozen string-hasher contract (hash of the hex encoding). */
export function digestSkillFile(content: Uint8Array, hasher: StableIdHasher): string {
  return hasher.sha256Hex(toHex(content));
}

export function digestSkillFiles(files: readonly SkillFile[], hasher: StableIdHasher): string {
  const serialized = [...files]
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
    .map((file) => `${file.relativePath}|${file.executable ? "x" : "-"}|${digestSkillFile(file.content, hasher)}`)
    .join("\n");
  return hasher.sha256Hex(serialized);
}

/** Aggregates file-level assets (kind=skills, logicalName "<name>/<rest>") into directory-level skills. */
export function aggregateSkillAssets(
  files: readonly { logicalName: string; content: Uint8Array }[],
  hasher: StableIdHasher
): readonly SkillAsset[] {
  const byName = new Map<string, SkillFile[]>();
  for (const file of files) {
    const separator = file.logicalName.indexOf("/");
    if (separator <= 0) {
      continue; // a bare file directly under skills/ is not a directory skill
    }
    const skillName = file.logicalName.slice(0, separator);
    const relativePath = file.logicalName.slice(separator + 1);
    if (relativePath.length === 0) {
      continue;
    }
    const bucket = byName.get(skillName) ?? [];
    bucket.push({ relativePath, content: file.content, executable: inferExecutable(relativePath, file.content) });
    byName.set(skillName, bucket);
  }
  return [...byName.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([skillName, skillFiles]) => ({
      skillName,
      files: [...skillFiles].sort((left, right) =>
        left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
      ),
      digest: digestSkillFiles(skillFiles, hasher)
    }));
}

/** Marks script-like files executable per the frozen heuristic (POSIX shebang or scripts/ path). */
export function inferExecutable(relativePath: string, content: Uint8Array): boolean {
  if (relativePath.startsWith("scripts/")) {
    return true;
  }
  const header = content.subarray(0, 2);
  return header[0] === 0x23 && header[1] === 0x21; // "#!"
}

export function fileChangeKind(
  before: SkillAsset | null,
  after: SkillAsset | null
): "create" | "delete" | "modify" | "unchanged" {
  if (before === null && after === null) {
    return "unchanged";
  }
  if (before === null) {
    return "create";
  }
  if (after === null) {
    return "delete";
  }
  return before.digest === after.digest ? "unchanged" : "modify";
}

/** Per-file deltas inside one skill, sorted by path. */
export interface SkillFileDelta {
  readonly relativePath: string;
  readonly kind: "create" | "modify" | "delete";
  readonly after: SkillFile | null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function skillFileDeltas(before: SkillAsset | null, after: SkillAsset | null): readonly SkillFileDelta[] {
  const beforeFiles = new Map((before?.files ?? []).map((file) => [file.relativePath, file]));
  const afterFiles = new Map((after?.files ?? []).map((file) => [file.relativePath, file]));
  const deltas: SkillFileDelta[] = [];
  for (const relativePath of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
    const left = beforeFiles.get(relativePath) ?? null;
    const right = afterFiles.get(relativePath) ?? null;
    if (left === null && right !== null) {
      deltas.push({ relativePath, kind: "create", after: right });
    } else if (left !== null && right === null) {
      deltas.push({ relativePath, kind: "delete", after: null });
    } else if (left !== null && right !== null && (left.executable !== right.executable || !bytesEqual(left.content, right.content))) {
      deltas.push({ relativePath, kind: "modify", after: right });
    }
  }
  return deltas.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
}
