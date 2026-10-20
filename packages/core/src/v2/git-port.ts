// Frozen M0 contract (INH-1756): GitPort — platform-agnostic Git interface
// with publish safety and credential boundary, plus the IDE-style Index
// contract (stage/unstage/selected commit/three-version diff/paged log/
// confirmed discard).
//
// Safety invariants (frozen):
// - Fast-forward only; the port exposes no merge/rebase/stash/force-push/
//   reset-hard operations at all — absence is the enforcement.
// - Commits are scoped to RuleSwitch-managed repo paths; unmanaged staged
//   content blocks the commit explicitly.
// - Push requires a prior fetch + remote revalidation of the exact local
//   revision; a remote that moved on is "remote-race", never auto-resolved.
// - Every mutating request carries expected revisions (HEAD / index /
//   worktree digest); mismatch → "stale-revision" and no write. Staged-later
//   edits therefore never enter a commit silently.
// - Credentials live only in SSH agent/config, Git credential helpers, or
//   OS secure storage; they never appear in port types, repos, or logs.

import { z } from "zod";

import type { RepositoryId } from "./identity";

// ---------------------------------------------------------------------------
// Structured states
// ---------------------------------------------------------------------------

export const REMOTE_SYNC_STATUSES = [
  "up-to-date",
  "behind-ff",
  "ahead",
  "diverged",
  "remote-unreachable"
] as const;
export type RemoteSyncStatus = (typeof REMOTE_SYNC_STATUSES)[number];

export const WORKING_TREE_STATUSES = ["clean", "dirty-managed", "dirty-unmanaged", "dirty-mixed"] as const;
export type WorkingTreeStatus = (typeof WORKING_TREE_STATUSES)[number];

export const GIT_ERROR_KINDS = ["auth-error", "remote-error", "local-error", "stale-revision", "unmanaged-staged-content"] as const;
export type GitErrorKind = (typeof GIT_ERROR_KINDS)[number];

export interface GitOperationError {
  readonly kind: GitErrorKind;
  readonly message: string;
  readonly retryable: boolean;
}

/** Destructive/ambiguous situations are blocked by default (see classifyPublishDecision). */
export const GIT_FORBIDDEN_OPERATIONS: readonly string[] = Object.freeze([
  "merge",
  "rebase",
  "stash",
  "force-push",
  "reset --hard"
]);

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

export interface GitPathStatus {
  readonly logicalPath: string;
  readonly managed: boolean;
  readonly staged: boolean;
  readonly headDigest: string | null;
  readonly indexDigest: string | null;
  readonly worktreeDigest: string | null;
}

export interface GitRepositoryStatus {
  readonly repositoryId: RepositoryId;
  readonly headRevision: string | null;
  readonly upstreamRevision: string | null;
  readonly remoteStatus: RemoteSyncStatus;
  readonly ahead: number;
  readonly behind: number;
  readonly workingTree: WorkingTreeStatus;
  readonly paths: readonly GitPathStatus[];
  /** Set by the application layer when local commits await a successful push. */
  readonly pendingPublish: boolean;
}

// ---------------------------------------------------------------------------
// Revision binding (stale guards)
// ---------------------------------------------------------------------------

export interface ExpectedRevisions {
  readonly head: string | null;
  readonly worktreeDigest: string | null;
}

export const expectedRevisionsSchema: z.ZodType<ExpectedRevisions> = z.strictObject({
  head: z.string().min(1).nullable(),
  worktreeDigest: z.string().min(1).nullable()
});

// ---------------------------------------------------------------------------
// Diff / log models
// ---------------------------------------------------------------------------

export const DIFF_VERSIONS = ["head-to-index", "index-to-worktree"] as const;
export type DiffVersion = (typeof DIFF_VERSIONS)[number];

export interface GitDiffEntry {
  readonly logicalPath: string;
  readonly version: DiffVersion;
  readonly changeKind: "create" | "modify" | "delete";
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
}

export interface GitLogPage {
  readonly commits: readonly GitLogEntry[];
  readonly nextCursor: string | null;
}

export interface GitLogEntry {
  readonly revision: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authoredAt: string;
  readonly subject: string;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface OpenRepositoryRequest {
  readonly localPath: string;
}

export interface CloneRepositoryRequest {
  readonly remoteUrl: string;
  readonly targetDirectory: string;
}

export interface StageRequest {
  readonly repositoryId: RepositoryId;
  readonly logicalPaths: readonly string[];
  readonly expected: ExpectedRevisions;
}

export interface CommitStagedRequest {
  readonly repositoryId: RepositoryId;
  readonly message: string;
  readonly expected: ExpectedRevisions;
  /** Managed paths allowed in this commit; any other staged path blocks it. */
  readonly allowedManagedPaths: readonly string[];
}

export interface FastForwardRequest {
  readonly repositoryId: RepositoryId;
  readonly expected: ExpectedRevisions;
}

export interface PushRequest {
  readonly repositoryId: RepositoryId;
  readonly expectedHead: string;
}

export interface DiscardWorktreeRequest {
  readonly repositoryId: RepositoryId;
  readonly logicalPaths: readonly string[];
  readonly expected: ExpectedRevisions;
  /** Discard requires a prior preview confirmation and a backup snapshot ref. */
  readonly backupSnapshotRef: string;
}

export interface GitResult<T> {
  readonly ok: boolean;
  readonly value: T | null;
  readonly error: GitOperationError | null;
}

/**
 * Platform-agnostic Git port. Core depends only on this interface; hosts
 * (GitHub/GitLab/Gitee/Forgejo/bare remotes) are indistinguishable to Core.
 */
export interface GitPort {
  open(request: OpenRepositoryRequest): Promise<GitResult<GitRepositoryStatus>>;
  clone(request: CloneRepositoryRequest): Promise<GitResult<GitRepositoryStatus>>;
  status(repositoryId: RepositoryId): Promise<GitResult<GitRepositoryStatus>>;
  fetch(repositoryId: RepositoryId): Promise<GitResult<RemoteSyncStatus>>;
  fastForwardOnly(request: FastForwardRequest): Promise<GitResult<RemoteSyncStatus>>;
  stage(request: StageRequest): Promise<GitResult<GitRepositoryStatus>>;
  unstage(request: StageRequest): Promise<GitResult<GitRepositoryStatus>>;
  /** Commits exactly the staged index content; refuses unmanaged staged paths and stale revisions. */
  commitStaged(request: CommitStagedRequest): Promise<GitResult<{ readonly revision: string }>>;
  /** Publishes committed revisions only; requires fetch + revalidation of expectedHead. */
  push(request: PushRequest): Promise<GitResult<RemoteSyncStatus>>;
  diff(repositoryId: RepositoryId, version: DiffVersion): Promise<GitResult<readonly GitDiffEntry[]>>;
  log(repositoryId: RepositoryId, cursor: string | null, pageSize: number): Promise<GitResult<GitLogPage>>;
  discardWorktreeChanges(request: DiscardWorktreeRequest): Promise<GitResult<GitRepositoryStatus>>;
}

// ---------------------------------------------------------------------------
// Publish decision classification (pure; reused by UI and engine)
// ---------------------------------------------------------------------------

export type PublishDecision =
  | { readonly action: "push" }
  | { readonly action: "fetch-first"; readonly reason: string }
  | { readonly action: "blocked"; readonly reason: string };

export function classifyPublishDecision(status: GitRepositoryStatus): PublishDecision {
  if (status.workingTree === "dirty-mixed" || status.workingTree === "dirty-managed") {
    return { action: "blocked", reason: "working tree has uncommitted managed changes" };
  }
  if (status.remoteStatus === "diverged") {
    return { action: "blocked", reason: "local and remote diverged; explicit resolution required" };
  }
  if (status.remoteStatus === "remote-unreachable") {
    return { action: "blocked", reason: "remote unreachable" };
  }
  if (status.remoteStatus === "behind-ff") {
    return { action: "fetch-first", reason: "remote is ahead; fast-forward before pushing" };
  }
  if (status.remoteStatus === "ahead" || status.pendingPublish) {
    return { action: "push" };
  }
  return { action: "push" };
}

export function classifyCommitReadiness(
  status: GitRepositoryStatus,
  allowedManagedPaths: readonly string[]
): { readonly ready: boolean; readonly blockers: readonly string[] } {
  const blockers: string[] = [];
  const allowed = new Set(allowedManagedPaths);
  for (const pathStatus of status.paths) {
    if (!pathStatus.staged) {
      continue;
    }
    if (!pathStatus.managed && !allowed.has(pathStatus.logicalPath)) {
      blockers.push(`unmanaged staged path blocks commit: ${pathStatus.logicalPath}`);
    }
  }
  return { ready: blockers.length === 0, blockers };
}
