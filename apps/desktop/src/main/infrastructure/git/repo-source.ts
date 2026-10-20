// Filesystem-backed RepoFileSource (INH-1767 desktop adapter): enumerates
// a config-repo working tree deterministically. Symlinks anywhere under
// the repository are rejected fail-closed (the Phase A source-root policy
// extended to the whole v1 layout), so a symlink can never smuggle
// content from outside the clone. Every constructed path is containment-
// checked against the repository root after lexical validation.

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { RepoFileSource } from "@ruleswitch/core";

export class SymlinkRejectedError extends Error {
  constructor(readonly logicalPath: string) {
    super(`symlink rejected inside config repository: ${logicalPath}`);
    this.name = "SymlinkRejectedError";
  }
}

/** Validates a repo-relative logical path and joins it under the root, proving containment. */
function safeJoin(root: string, logicalPath: string): string {
  if (logicalPath.length === 0) {
    return root; // the walk starts at the repository root itself
  }
  if (
    logicalPath.length === 0 ||
    logicalPath.includes("\0") ||
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`refusing unsafe repository-relative path: ${JSON.stringify(logicalPath)}`);
  }
  const target = path.resolve(root, logicalPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the repository root: ${JSON.stringify(logicalPath)}`);
  }
  return target;
}

export function createFsRepoFileSource(repositoryRoot: string): RepoFileSource {
  const root = path.resolve(repositoryRoot);
  return {
    async listFiles(): Promise<readonly string[]> {
      const files: string[] = [];
      await walk(root, "", files);
      return files.sort();
    },
    async readFile(logicalPath: string): Promise<Uint8Array | null> {
      const bytes = await readFile(safeJoin(root, logicalPath));
      return new Uint8Array(bytes);
    }
  };
}

async function walk(root: string, relativeDir: string, files: string[]): Promise<void> {
  const entries = await readdir(safeJoin(root, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const relative = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    const info = await lstat(safeJoin(root, relative));
    if (info.isSymbolicLink()) {
      throw new SymlinkRejectedError(relative);
    }
    if (info.isDirectory()) {
      await walk(root, relative, files);
      continue;
    }
    if (info.isFile()) {
      files.push(relative);
    }
  }
}
