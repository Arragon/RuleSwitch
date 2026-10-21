// Path-safety guards shared by every Main-side write path (M9 preparation).
//
// Rules are platform-independent by design: the same logical name must be
// safe on macOS, Linux and Windows, so a name that Windows would reinterpret
// (device names, trailing dots/spaces, backslashes, drive letters) is refused
// everywhere instead of "working on my machine".

import path from "node:path";

/** Windows device names are reserved even with an extension (`NUL.md`). */
const WINDOWS_RESERVED_NAMES: readonly string[] = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`)
];

export function isWindowsReservedName(segment: string): boolean {
  const stem = segment.split(".")[0] ?? "";
  return WINDOWS_RESERVED_NAMES.includes(stem.toLocaleUpperCase("en-US"));
}

/** Windows silently strips trailing dots and spaces (`AGENTS.md.`). */
export function hasWindowsTrailingQuirk(segment: string): boolean {
  return segment.length > 0 && (segment.endsWith(".") || segment.endsWith(" "));
}

/**
 * Rejects any relative path that could escape its root or be reinterpreted by
 * a filesystem. Snapshot manifests live on disk and are therefore untrusted
 * input, so containment is re-checked on every read, never assumed.
 */
export function isSafeRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.includes("\0") &&
    !relativePath.includes("\\") &&
    !relativePath.startsWith("/") &&
    !/^[A-Za-z]:/.test(relativePath) &&
    relativePath
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !isWindowsReservedName(segment) &&
          !hasWindowsTrailingQuirk(segment)
      )
  );
}

/** Same check, with an actionable message for logs and operators. */
export function assertSafeRelativePath(relativePath: string, what: string): string {
  if (relativePath.length === 0) {
    throw new Error(`refusing empty ${what}`);
  }
  if (relativePath.includes("\0")) {
    throw new Error(`refusing ${what} containing a NUL byte: ${JSON.stringify(relativePath)}`);
  }
  if (relativePath.includes("\\")) {
    throw new Error(`refusing ${what} containing a backslash: ${JSON.stringify(relativePath)}`);
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`refusing absolute or drive-qualified ${what}: ${JSON.stringify(relativePath)}`);
  }
  for (const segment of relativePath.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error(`refusing ${what} with a traversal segment: ${JSON.stringify(relativePath)}`);
    }
    if (isWindowsReservedName(segment)) {
      throw new Error(`refusing ${what} using a reserved device name: ${JSON.stringify(relativePath)}`);
    }
    if (hasWindowsTrailingQuirk(segment)) {
      throw new Error(
        `refusing ${what} with a trailing dot or space (silently rewritten on Windows): ${JSON.stringify(relativePath)}`
      );
    }
  }
  return relativePath;
}

/**
 * True when two logical names would collide on a case-insensitive filesystem
 * (Windows, default macOS). A collision must be reported, never resolved by
 * picking one of them.
 */
export function collidesCaseInsensitively(left: string, right: string): boolean {
  return (
    left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US") && left !== right
  );
}

/** Joins a root with a logical name using the platform separator. */
export function joinTargetPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}
