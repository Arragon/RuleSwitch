// Unified Fresh Scanner contract (INH-1783): every reconcile/plan path
// reads real state through ONE scanner — Apply, Capture, and Conflict
// resolution share these snapshot semantics; no module may consult mtimes
// or caches on its own.
//
// Guarantees carried by this contract:
// - Digests are SHA-256 over raw bytes, plus byteLength and mode metadata.
// - Every read is verified against a mid-read replacement: the file is
//   re-stat'ed after hashing; size/mtime-inode changes → structured
//   FILE_REPLACED_DURING_READ failure (the host impl re-tries once and
//   fails closed on the second mismatch).
// - Symlinks anywhere under a scanned root are rejected; case-collision
//   pairs are rejected; permission failures are structured.
// - Structured bindings keep the RAW source bytes as evidence before any
//   managed-key parsing (rawEvidence on the snapshot).
// - Project root identity is re-verified per critical operation by the
//   caller comparing `rootFingerprint` between snapshots.

export interface ScannedFile {
  readonly logicalPath: string;
  readonly digest: string; // sha256 hex over raw bytes
  readonly byteLength: number;
  readonly mode: number; // platform permission bits
  readonly executable: boolean;
  readonly content: Uint8Array;
  /** Raw bytes preserved as evidence for structured-binding parsing. */
  readonly rawEvidence: Uint8Array;
}

export interface ScannedTree {
  readonly root: string; // logical root label (repo/scope/harness), never absolute
  readonly rootFingerprint: string; // digest over sorted "path|digest|mode"
  readonly files: readonly ScannedFile[];
}

export type ScanFailureCode =
  | "PATH_UNSAFE"
  | "PATH_NOT_NFC"
  | "PATH_DUPLICATE"
  | "PATH_CASE_COLLISION"
  | "SYMLINK_REJECTED"
  | "PERMISSION_DENIED"
  | "FILE_REPLACED_DURING_READ"
  | "READ_FAILED"
  | "FILE_TOO_LARGE";

export interface ScanFailure {
  readonly code: ScanFailureCode;
  readonly logicalPath: string | null;
  readonly message: string;
}

export type TreeScanResult = { ok: true; tree: ScannedTree } | { ok: false; failures: readonly ScanFailure[] };

/** Files larger than this policy limit fail closed instead of being hashed in memory. */
export const SCAN_MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface TreeScanner {
  /** Scans one logical root (repository working tree, scope dir, or harness dir). */
  scanTree(root: string, absoluteRoot: string): Promise<TreeScanResult>;
}

export function validateScanPath(logicalPath: string): ScanFailure | null {
  if (
    logicalPath.length === 0 ||
    logicalPath.includes("\0") ||
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return { code: "PATH_UNSAFE", logicalPath, message: `unsafe path: ${JSON.stringify(logicalPath)}` };
  }
  if (logicalPath.normalize("NFC") !== logicalPath) {
    return { code: "PATH_NOT_NFC", logicalPath, message: "path must be NFC-normalized" };
  }
  return null;
}

/** Shared case-collision detection over a list of scanned/declared paths. */
export function detectCaseCollisions(logicalPaths: readonly string[]): readonly ScanFailure[] {
  const seen = new Map<string, string>();
  const failures: ScanFailure[] = [];
  for (const logicalPath of logicalPaths) {
    const folded = logicalPath.toLowerCase();
    const previous = seen.get(folded);
    if (previous !== undefined && previous !== logicalPath) {
      failures.push({
        code: "PATH_CASE_COLLISION",
        logicalPath,
        message: `case collision with ${previous}`
      });
      continue;
    }
    seen.set(folded, logicalPath);
  }
  return failures;
}

/** Deterministic fingerprint over a scanned file set (sorted path|digest|mode). */
export function fingerprintFiles(files: readonly { logicalPath: string; digest: string; mode: number }[], hasher: {
  sha256Hex(input: string): string;
}): string {
  const serialized = [...files]
    .sort((left, right) => (left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0))
    .map((file) => `${file.logicalPath}|${file.digest}|${file.mode}`)
    .join("\n");
  return hasher.sha256Hex(serialized);
}

/** Staleness between two snapshots of the same logical root. */
export function treeChanged(before: ScannedTree, after: ScannedTree): boolean {
  return before.rootFingerprint !== after.rootFingerprint;
}
