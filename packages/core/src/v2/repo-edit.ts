// Repo edit/delete transaction contract (INH-1848): user edits to config
// repo content produce working-tree changes ONLY — staging, commit, and
// push are separate confirmations (frozen GitPort policy). Deletes follow
// the binding-engine delete guard: owned + digest proof + explicit
// confirmation; unmanaged/unknown content is preserved.

import { evaluateDelete, type DeleteDecision } from "./binding-engine";
import type { RepositoryId } from "./identity";

export interface RepoEditTarget {
  /** Repo-relative managed path(s) the edit will touch. */
  readonly logicalPaths: readonly string[];
  readonly repositoryId: RepositoryId;
  /** HEAD revision the editor based on — stale guard. */
  readonly baseRevision: string;
  /** Digest(s) of the content being replaced, for ownership proof. */
  readonly ownershipDigests: Readonly<Record<string, string>>;
}

export interface RepoEditWrite {
  readonly logicalPath: string;
  readonly content: Uint8Array | null; // null = delete
}

export interface RepoEditPreview {
  readonly planKind: "repo-set-sync";
  readonly writes: readonly RepoEditWrite[];
  /** Assets/bindings affected by a delete — shown in the confirmation. */
  readonly affectedAssetKeys: readonly string[];
  readonly preserveUnmanagedNote: true;
}

export type RepoEditDecision =
  | { readonly ok: true; readonly preview: RepoEditPreview }
  | {
      readonly ok: false;
      readonly code:
        | "STALE_BASE"
        | "PATH_UNSAFE"
        | "OWNERSHIP_MISSING"
        | "DELETE_REFUSED"
        | "SCOPE_VIOLATION";
      readonly message: string;
    };

const MANAGED_ROOTS = ["global/", "projects/", "profiles/", "native/", ".ruleswitch/"];

export function isManagedRepoPath(logicalPath: string): boolean {
  return logicalPath === "ruleswitch.yaml" || MANAGED_ROOTS.some((root) => logicalPath.startsWith(root));
}

function validatePath(logicalPath: string): string | null {
  if (
    logicalPath.length === 0 ||
    logicalPath.includes("\0") ||
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return `unsafe repo path: ${JSON.stringify(logicalPath)}`;
  }
  return null;
}

/**
 * Plans a direct repo edit/delete. The output writes the working tree only;
 * the caller stages/commits through the GitPort as separate steps.
 */
export function planRepoEdit(input: {
  readonly target: RepoEditTarget;
  readonly writes: readonly RepoEditWrite[];
  readonly currentRevision: string;
  /** Current on-disk digests of the paths being deleted/replaced. */
  readonly currentDigests: Readonly<Record<string, string>>;
  readonly affectedAssetKeys: readonly string[];
  readonly deleteConfirmed: boolean;
}): RepoEditDecision {
  if (input.target.baseRevision !== input.currentRevision) {
    return { ok: false, code: "STALE_BASE", message: "repository HEAD moved since the edit started; reload and re-edit" };
  }
  for (const write of input.writes) {
    const unsafe = validatePath(write.logicalPath);
    if (unsafe) {
      return { ok: false, code: "PATH_UNSAFE", message: unsafe };
    }
    if (!isManagedRepoPath(write.logicalPath)) {
      return { ok: false, code: "SCOPE_VIOLATION", message: `path outside managed areas: ${write.logicalPath}` };
    }
    if (write.content === null) {
      // Delete path: ownership + digest proof + explicit confirmation.
      const owned = input.target.ownershipDigests[write.logicalPath];
      if (owned === undefined) {
        return {
          ok: false,
          code: "OWNERSHIP_MISSING",
          message: `no RuleSwitch ownership proof for ${write.logicalPath}; adopt it first`
        };
      }
      const guard: DeleteDecision = evaluateDelete({
        mode: "mirror",
        owned: true,
        ownershipDigest: owned,
        currentDigest: input.currentDigests[write.logicalPath] ?? null,
        firstAdoption: false
      });
      if (!guard.allowed) {
        return { ok: false, code: "DELETE_REFUSED", message: guard.reason };
      }
      if (!input.deleteConfirmed) {
        return {
          ok: false,
          code: "DELETE_REFUSED",
          message: `deleting ${write.logicalPath} requires explicit confirmation of the affected assets`
        };
      }
    }
  }
  return {
    ok: true,
    preview: {
      planKind: "repo-set-sync",
      writes: input.writes,
      affectedAssetKeys: input.affectedAssetKeys,
      preserveUnmanagedNote: true
    }
  };
}

/** Restores deleted/edited repo files from a snapshot (rollback path). */
export interface RepoEditSnapshot {
  readonly repositoryId: RepositoryId;
  readonly files: readonly { readonly logicalPath: string; readonly existedBefore: boolean; readonly previousContent: Uint8Array | null }[];
}
