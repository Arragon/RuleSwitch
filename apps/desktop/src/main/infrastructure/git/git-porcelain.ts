// Pure parsers for Git plumbing output (NUL-delimited porcelain v2 status,
// name-status diffs, ls-tree/ls-files listings, structured log). All parsers
// are total: malformed input yields structured parse errors, never throws.

export interface PorcelainPathEntry {
  readonly logicalPath: string;
  readonly originalPath: string | null;
  /** Index-side change (staged): X != '.' */
  readonly staged: boolean;
  /** Worktree-side change: Y != '.' */
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly ignored: boolean;
  readonly conflict: boolean;
}

export interface PorcelainStatus {
  readonly headRevision: string | null;
  /** Branch name; "(detached)" when HEAD is detached. */
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly entries: readonly PorcelainPathEntry[];
}

export interface PorcelainParseFailure {
  readonly reason: string;
  readonly record: string;
}

function splitNulRecords(output: string): string[] {
  return output.split("\0").filter((record) => record.length > 0);
}

/**
 * Parses `git status --porcelain=v2 --branch -z`. With -z, header lines and
 * entries are NUL-terminated; rename records use NUL between the record and
 * the two paths.
 */
export function parsePorcelainV2(output: string): { status: PorcelainStatus } | { failure: PorcelainParseFailure } {
  const records = splitNulRecords(output);
  let headRevision: string | null = null;
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const entries: PorcelainPathEntry[] = [];

  let index = 0;
  while (index < records.length) {
    const record = records[index] ?? "";
    if (record.startsWith("# branch.oid ")) {
      headRevision = record.slice("# branch.oid ".length);
      if (headRevision === "(initial)") {
        headRevision = null;
      }
      index += 1;
    } else if (record.startsWith("# branch.head ")) {
      branch = record.slice("# branch.head ".length);
      index += 1;
    } else if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
      index += 1;
    } else if (record.startsWith("# branch.ab ")) {
      const match = record.match(/^# branch\.ab \+(-?\d+) -(-?\d+)$/);
      if (!match) {
        return { failure: { reason: "malformed branch.ab record", record } };
      }
      ahead = Number.parseInt(match[1] ?? "0", 10);
      behind = Number.parseInt(match[2] ?? "0", 10);
      index += 1;
    } else if (record.startsWith("# ")) {
      index += 1;
    } else if (record.startsWith("1 ") || record.startsWith("u ")) {
      // "1 XY sub mH mI mW hH hI path" — path is the rest after 8 fields.
      const parts = record.split(" ");
      const xy = parts[1] ?? "";
      const path = parts.slice(8).join(" ");
      if (path.length === 0) {
        return { failure: { reason: "changed entry without path", record } };
      }
      entries.push({
        logicalPath: path,
        originalPath: null,
        staged: record.startsWith("1 ") && xy.length >= 1 && xy[0] !== ".",
        unstaged: xy.length >= 2 && (xy[1] ?? ".") !== ".",
        untracked: false,
        ignored: false,
        conflict: record.startsWith("u ")
      });
      index += 1;
    } else if (record.startsWith("2 ")) {
      // "2 XY sub mH mI mW hH hI XScore path\0origPath"
      const parts = record.split(" ");
      const xy = parts[1] ?? "";
      const path = parts.slice(9).join(" ");
      const originalPath = records[index + 1] ?? null;
      if (path.length === 0 || originalPath === null) {
        return { failure: { reason: "rename entry missing path pair", record } };
      }
      entries.push({
        logicalPath: path,
        originalPath,
        staged: xy.length >= 1 && xy[0] !== ".",
        unstaged: xy.length >= 2 && (xy[1] ?? ".") !== ".",
        untracked: false,
        ignored: false,
        conflict: false
      });
      index += 2;
    } else if (record.startsWith("? ") || record.startsWith("! ")) {
      const path = record.slice(2);
      if (path.length === 0) {
        return { failure: { reason: "untracked entry without path", record } };
      }
      entries.push({
        logicalPath: path,
        originalPath: null,
        staged: false,
        unstaged: false,
        untracked: record.startsWith("? "),
        ignored: record.startsWith("! "),
        conflict: false
      });
      index += 1;
    } else {
      return { failure: { reason: "unknown porcelain record", record } };
    }
  }

  return { status: { headRevision, branch, upstream, ahead, behind, entries } };
}

// ---------------------------------------------------------------------------
// name-status diff parsing
// ---------------------------------------------------------------------------

export type NameStatusKind = "create" | "delete" | "modify" | "rename" | "copy";

export interface NameStatusEntry {
  readonly kind: NameStatusKind;
  readonly newPath: string;
  readonly originalPath: string | null;
}

/** Parses `git diff --name-status -z` (also `--cached`). */
export function parseNameStatus(output: string): { entries: readonly NameStatusEntry[] } | { failure: PorcelainParseFailure } {
  const tokens = splitNulRecords(output);
  const entries: NameStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusToken = tokens[index] ?? "";
    const match = statusToken.match(/^([ADRTCM])(\d+)?$/);
    if (!match) {
      return { failure: { reason: "unknown name-status token", record: statusToken } };
    }
    const letter = match[1];
    if (letter === "R" || letter === "C") {
      const originalPath = tokens[index + 1] ?? null;
      const newPath = tokens[index + 2] ?? null;
      if (originalPath === null || newPath === null) {
        return { failure: { reason: "rename/copy missing path pair", record: statusToken } };
      }
      entries.push({
        kind: letter === "R" ? "rename" : "copy",
        newPath,
        originalPath
      });
      index += 3;
    } else {
      const path = tokens[index + 1] ?? null;
      if (path === null) {
        return { failure: { reason: "status token without path", record: statusToken } };
      }
      entries.push({ kind: letter === "A" ? "create" : letter === "D" ? "delete" : "modify", newPath: path, originalPath: null });
      index += 2;
    }
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// ls-tree / ls-files parsing (blob digests)
// ---------------------------------------------------------------------------

export interface BlobListing {
  readonly logicalPath: string;
  readonly blobDigest: string | null;
}

/** Parses `git ls-tree -r HEAD` lines: "<mode> <type> <digest>\t<path>". */
export function parseLsTree(output: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const match = line.match(/^(\d+) (blob|commit|tree) ([0-9a-f]+)\t(.+)$/);
    if (match && match[2] === "blob") {
      map.set(match[4] ?? "", match[3] ?? "");
    }
  }
  return map;
}

/** Parses `git ls-files -s` lines: "<mode> <digest> <stage>\t<path>". */
export function parseLsFiles(output: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const match = line.match(/^(\d+) ([0-9a-f]+) (\d+)\t(.+)$/);
    if (match && (match[3] ?? "0") === "0") {
      map.set(match[4] ?? "", match[2] ?? "");
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// structured log
// ---------------------------------------------------------------------------

export interface StructuredLogEntry {
  readonly revision: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authoredAt: string;
  readonly subject: string;
}

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

export function gitLogFormat(): string {
  return `%H${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`;
}

/** Parses output produced with gitLogFormat(). */
export function parseStructuredLog(output: string): readonly StructuredLogEntry[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/\n$/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [revision, parents, authorName, authoredAt, subject] = record.split(FIELD_SEPARATOR);
      return {
        revision: revision ?? "",
        parents: (parents ?? "").length > 0 ? (parents ?? "").split(" ") : [],
        authorName: authorName ?? "",
        authoredAt: authoredAt ?? "",
        subject: subject ?? ""
      };
    })
    .filter((entry) => entry.revision.length > 0);
}

// ---------------------------------------------------------------------------
// log cursor (opaque offset)
// ---------------------------------------------------------------------------

export function encodeLogCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

export function decodeLogCursor(cursor: string | null): number | null {
  if (cursor === null || cursor.length === 0) {
    return 0;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = decoded.match(/^offset:(\d+)$/);
  return match ? Number.parseInt(match[1] ?? "0", 10) : null;
}
