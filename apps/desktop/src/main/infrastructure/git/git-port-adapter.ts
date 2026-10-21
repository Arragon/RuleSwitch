// GitPort adapter over the controlled Git runtime (INH-1760/1761/1762/1846).
// Implements the frozen @ruleswitch/core v2 GitPort contract:
//
// - Fast-forward only; no merge/rebase/stash/force-push operations exist.
// - Scoped commits: unmanaged staged content blocks commits explicitly.
// - Push requires fetch + revalidation of the confirmed HEAD revision;
//   non-FF/network/auth failures set PENDING_PUBLISH (persisted) and keep
//   local commits.
// - Mutating requests carry expected revisions; mismatch = stale-revision,
//   so late worktree edits after staging never enter a commit.
//
// Repository-root canonicalization is delegated to Git itself: the raw
// caller path is only ever used as a spawn working directory, Git reports
// the canonical root, and the caller path is accepted only when it
// lexically matches that root — a repository subpath can never register.

import { copyFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type {
  CanonicalRemote,
  GitDiffEntry,
  GitLogEntry,
  GitLogPage,
  GitOperationError,
  GitPort,
  GitRepositoryStatus,
  GitResult,
  DiffVersion,
  RemoteSyncStatus,
  RepositoryId,
  StableIdHasher,
  CommitStagedRequest,
  DiscardWorktreeRequest,
  ExpectedRevisions,
  FastForwardRequest,
  OpenRepositoryRequest,
  CloneRepositoryRequest,
  StageRequest,
  PushRequest
} from "@ruleswitch/core";
import {
  createLocalOnlyRepositoryIdentity,
  createRemoteRepositoryIdentity,
  normalizeGitRemoteUrl
} from "@ruleswitch/core";

import type { GitRuntime } from "./git-runtime";
import {
  decodeLogCursor,
  encodeLogCursor,
  gitLogFormat,
  parseLsFiles,
  parseLsTree,
  parseNameStatus,
  parsePorcelainV2,
  parseStructuredLog,
  type PorcelainStatus
} from "./git-porcelain";
import type { RepositoryIdentityStore } from "./identity-store";

export type ManagedPathPolicy = (logicalPath: string) => boolean;

/** Default managed roots follow the frozen ADR-0007 config-repo layout. */
export function defaultManagedPathPolicy(logicalPath: string): boolean {
  const managedRoots = ["global/", "projects/", "profiles/", "native/", ".ruleswitch/"];
  return logicalPath === "ruleswitch.yaml" || managedRoots.some((root) => logicalPath.startsWith(root));
}

/** True when both paths refer to the same directory (stat device/inode). */
async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
  return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
}

export interface GitPortAdapterOptions {
  readonly gitRuntime: GitRuntime;
  readonly hasher?: StableIdHasher;
  readonly managedPathPolicy?: ManagedPathPolicy;
  readonly identityStore?: RepositoryIdentityStore;
  /** Directory where discard backups are written before restoring. */
  readonly backupRoot?: string;
}

interface RegisteredRepository {
  readonly repositoryId: RepositoryId;
  localPath: string;
  readonly canonicalRemote: CanonicalRemote;
}

const nodeHasher: StableIdHasher = {
  sha256Hex(input) {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

function ok<T>(value: T): GitResult<T> {
  return { ok: true, value, error: null };
}

function err(
  kind: GitOperationError["kind"],
  message: string,
  retryable = false
): { ok: false; value: null; error: GitOperationError } {
  return { ok: false, value: null, error: { kind, message, retryable } };
}

export class GitPortAdapter implements GitPort {
  private readonly registry = new Map<RepositoryId, RegisteredRepository>();
  /**
   * The most recently opened repository. Root-based reads must follow it:
   * with two repositories open, "the first one registered" would silently
   * serve another repository's bytes.
   */
  private activeRepositoryId: RepositoryId | null = null;

  /** Canonical root of the active repository (Main-side only; never a Renderer DTO). */
  currentRoot(): string {
    const active =
      this.activeRepositoryId === null ? undefined : this.registry.get(this.activeRepositoryId);
    const resolved = active ?? this.registry.values().next().value;
    if (resolved === undefined) {
      throw new Error("no repository is currently open");
    }
    return resolved.localPath;
  }

  /** Id of the active repository, or null when none is open. */
  currentRepositoryId(): RepositoryId | null {
    return this.activeRepositoryId;
  }

  constructor(private readonly options: GitPortAdapterOptions) {}

  async clone(request: CloneRepositoryRequest): Promise<GitResult<GitRepositoryStatus>> {
    if (request.targetDirectory.length === 0 || request.targetDirectory.includes("\0")) {
      return err("local-error", "invalid clone target directory");
    }
    // Normalize the target directory lexically (collapses ".." segments)
    // and validate the remote URL shape before either reaches argv.
    const targetDirectory = path.resolve(request.targetDirectory);
    const remoteUrl = request.remoteUrl.trim();
    if (
      remoteUrl.length === 0 ||
      remoteUrl.includes("\0") ||
      remoteUrl.startsWith("-") ||
      targetDirectory.startsWith("-")
    ) {
      return err("local-error", "invalid clone remote URL or target directory");
    }
    const cloneResult = await this.options.gitRuntime.run(
      ["clone", "--", remoteUrl, targetDirectory],
      { isNetworkCommand: true }
    );
    if (!cloneResult.ok) {
      return this.runtimeError(cloneResult.failure);
    }
    return this.open({ localPath: targetDirectory });
  }

  async status(repositoryId: RepositoryId): Promise<GitResult<GitRepositoryStatus>> {
    const repo = this.registry.get(repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${repositoryId}`);
    }
    const result = await this.buildStatus(repo.localPath, repositoryId);
    if (result.error) {
      return { ok: false, value: null, error: result.error };
    }
    return ok(result.value.status);
  }

  /** Extra repository diagnostics beyond the frozen port surface. */
  async describeRepository(
    repositoryId: RepositoryId
  ): Promise<
    GitResult<{
      repositoryId: RepositoryId;
      localPath: string;
      canonicalRemote: CanonicalRemote;
      branch: string | null;
      detached: boolean;
      manifestPresent: boolean;
      remotes: readonly { name: string; url: string }[];
    }>
  > {
    const repo = this.registry.get(repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${repositoryId}`);
    }
    const porcelain = await this.readPorcelain(repo.localPath);
    if (porcelain.error) {
      return { ok: false, value: null, error: porcelain.error };
    }
    const remotes = await this.listRemotes(repo.localPath);
    const manifest = await this.options.gitRuntime.run(["ls-files", "--", "ruleswitch.yaml"], {
      cwd: repo.localPath
    });
    const branch = porcelain.value.branch;
    return ok({
      repositoryId,
      localPath: repo.localPath,
      canonicalRemote: repo.canonicalRemote,
      branch,
      detached: branch === "(detached)",
      manifestPresent: manifest.ok && manifest.stdout.trim().length > 0,
      remotes
    });
  }

  async fetch(repositoryId: RepositoryId): Promise<GitResult<RemoteSyncStatus>> {
    const repo = this.registry.get(repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${repositoryId}`);
    }
    const fetchResult = await this.options.gitRuntime.run(["fetch", "--no-tags", "--prune", "origin"], {
      cwd: repo.localPath,
      isNetworkCommand: true
    });
    if (!fetchResult.ok) {
      return this.runtimeError(fetchResult.failure);
    }
    const relation = await this.remoteRelation(repo.localPath);
    if (!relation.ok) {
      return { ok: false, value: null, error: relation.error };
    }
    return ok(relation.value);
  }

  async fastForwardOnly(request: FastForwardRequest): Promise<GitResult<RemoteSyncStatus>> {
    const repo = this.registry.get(request.repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${request.repositoryId}`);
    }
    const status = await this.buildStatus(repo.localPath, repo.repositoryId);
    if (status.error) {
      return { ok: false, value: null, error: status.error };
    }
    const current = status.value.status;
    const stale = this.checkExpected(current, request.expected, { requireWorktree: true });
    if (stale) {
      return stale;
    }
    if (current.workingTree !== "clean") {
      return err("local-error", `fast-forward blocked: working tree is ${current.workingTree}`);
    }
    if (current.remoteStatus !== "behind-ff" || current.upstreamRevision === null) {
      return err("local-error", `fast-forward blocked: remote relation is ${current.remoteStatus}`);
    }
    const upstreamNow = await this.revParse(repo.localPath, "@{upstream}");
    if (!upstreamNow.ok || upstreamNow.value !== current.upstreamRevision) {
      return err("stale-revision", "upstream ref moved between status and fast-forward; retry with fresh status");
    }
    const merge = await this.options.gitRuntime.run(["merge", "--ff-only", current.upstreamRevision], {
      cwd: repo.localPath
    });
    if (!merge.ok) {
      return this.runtimeError(merge.failure);
    }
    const newHead = await this.revParse(repo.localPath, "HEAD");
    if (!newHead.ok || newHead.value !== current.upstreamRevision) {
      return err("local-error", "fast-forward completed but HEAD does not match the upstream revision");
    }
    return ok("up-to-date");
  }

  async stage(request: StageRequest): Promise<GitResult<GitRepositoryStatus>> {
    return this.stageOrUnstage(request, "add");
  }

  async unstage(request: StageRequest): Promise<GitResult<GitRepositoryStatus>> {
    return this.stageOrUnstage(request, "restore");
  }

  private async stageOrUnstage(
    request: StageRequest,
    operation: "add" | "restore"
  ): Promise<GitResult<GitRepositoryStatus>> {
    const repo = this.registry.get(request.repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${request.repositoryId}`);
    }
    if (request.logicalPaths.length === 0) {
      return err("local-error", "stage/unstage requires at least one logical path");
    }
    const guard = this.validatePaths(request.logicalPaths);
    if (guard) {
      return guard;
    }
    const status = await this.buildStatus(repo.localPath, repo.repositoryId);
    if (status.error) {
      return { ok: false, value: null, error: status.error };
    }
    const stale = this.checkExpected(status.value.status, request.expected, { requireWorktree: true });
    if (stale) {
      return stale;
    }
    const args =
      operation === "add"
        ? ["add", "--", ...request.logicalPaths]
        : ["restore", "--staged", "--", ...request.logicalPaths];
    const run = await this.options.gitRuntime.run(args, { cwd: repo.localPath });
    if (!run.ok) {
      return this.runtimeError(run.failure);
    }
    const updated = await this.buildStatus(repo.localPath, repo.repositoryId);
    if (updated.error) {
      return { ok: false, value: null, error: updated.error };
    }
    return ok(updated.value.status);
  }

  async commitStaged(request: CommitStagedRequest): Promise<GitResult<{ revision: string }>> {
    const repo = this.registry.get(request.repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${request.repositoryId}`);
    }
    const message = request.message.trim();
    if (message.length === 0) {
      return err("local-error", "commit message must not be empty");
    }
    const head = await this.revParse(repo.localPath, "HEAD");
    if (!head.ok) {
      return { ok: false, value: null, error: head.error };
    }
    if (request.expected.head !== null && head.value !== request.expected.head) {
      return err(
        "stale-revision",
        `HEAD moved from ${request.expected.head} to ${head.value}; re-confirm before committing`
      );
    }
    const unmerged = await this.options.gitRuntime.run(["ls-files", "--unmerged"], { cwd: repo.localPath });
    if (!unmerged.ok) {
      return this.runtimeError(unmerged.failure);
    }
    if (unmerged.stdout.trim().length > 0) {
      return err("local-error", "repository has unresolved conflicts; resolve them before committing");
    }
    const stagedList = await this.options.gitRuntime.run(["diff", "--cached", "--name-only", "-z"], {
      cwd: repo.localPath
    });
    if (!stagedList.ok) {
      return this.runtimeError(stagedList.failure);
    }
    const stagedPaths = stagedList.stdout.split("\0").filter((entry) => entry.length > 0);
    if (stagedPaths.length === 0) {
      return err("local-error", "nothing staged to commit");
    }
    const allowed = new Set(request.allowedManagedPaths);
    const offending = stagedPaths.filter(
      (stagedPath) => !allowed.has(stagedPath) && !this.isManaged(stagedPath)
    );
    if (offending.length > 0) {
      return err("unmanaged-staged-content", `unmanaged staged content blocks commit: ${offending.join(", ")}`);
    }
    const commit = await this.options.gitRuntime.run(["commit", "-m", message], { cwd: repo.localPath });
    if (!commit.ok) {
      return this.runtimeError(commit.failure);
    }
    const revision = await this.revParse(repo.localPath, "HEAD");
    if (!revision.ok) {
      return { ok: false, value: null, error: revision.error };
    }
    return ok({ revision: revision.value });
  }

  async push(request: PushRequest): Promise<GitResult<RemoteSyncStatus>> {
    const repo = this.registry.get(request.repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${request.repositoryId}`);
    }
    const head = await this.revParse(repo.localPath, "HEAD");
    if (!head.ok) {
      return { ok: false, value: null, error: head.error };
    }
    if (head.value !== request.expectedHead) {
      return err(
        "stale-revision",
        `HEAD moved from ${request.expectedHead} to ${head.value}; re-confirm before pushing`
      );
    }
    const branch = await this.options.gitRuntime.run(["symbolic-ref", "--short", "HEAD"], {
      cwd: repo.localPath
    });
    if (!branch.ok) {
      return err("local-error", "detached HEAD cannot be pushed; fast-forward a branch first");
    }
    // Fetch + revalidate before publishing.
    const fetch = await this.options.gitRuntime.run(["fetch", "--no-tags", "--prune", "origin"], {
      cwd: repo.localPath,
      isNetworkCommand: true
    });
    if (!fetch.ok) {
      await this.markPendingPublish(repo.repositoryId, true);
      return this.runtimeError(fetch.failure);
    }
    const upstream = await this.revParse(repo.localPath, "@{upstream}");
    if (!upstream.ok) {
      return { ok: false, value: null, error: upstream.error };
    }
    const ancestry = await this.options.gitRuntime.run(
      ["merge-base", "--is-ancestor", upstream.value, "HEAD"],
      { cwd: repo.localPath }
    );
    if (!ancestry.ok) {
      await this.markPendingPublish(repo.repositoryId, true);
      return err(
        "remote-error",
        `remote race: remote advanced to ${upstream.value} beyond confirmed ${request.expectedHead}; local commits retained as pending publish`,
        false
      );
    }
    const pushRun = await this.options.gitRuntime.run(
      ["push", "origin", `HEAD:refs/heads/${branch.stdout.trim()}`],
      { cwd: repo.localPath, isNetworkCommand: true }
    );
    if (!pushRun.ok) {
      await this.markPendingPublish(repo.repositoryId, true);
      return this.runtimeError(pushRun.failure);
    }
    await this.markPendingPublish(repo.repositoryId, false);
    return ok("up-to-date");
  }

  async diff(repositoryId: RepositoryId, version: DiffVersion): Promise<GitResult<readonly GitDiffEntry[]>> {
    const repo = this.registry.get(repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${repositoryId}`);
    }
    const headTree = await this.options.gitRuntime.run(["ls-tree", "-r", "HEAD"], { cwd: repo.localPath });
    const indexList = await this.options.gitRuntime.run(["ls-files", "-s"], { cwd: repo.localPath });
    if (!indexList.ok) {
      return this.runtimeError(indexList.failure);
    }
    const headDigests = headTree.ok ? parseLsTree(headTree.stdout) : new Map<string, string>();
    const indexDigests = parseLsFiles(indexList.stdout);

    if (version === "head-to-index") {
      const cached = await this.options.gitRuntime.run(["diff", "--cached", "--name-status", "-z"], {
        cwd: repo.localPath
      });
      if (!cached.ok) {
        return this.runtimeError(cached.failure);
      }
      const parsed = parseNameStatus(cached.stdout);
      if ("failure" in parsed) {
        return err("local-error", `failed to parse staged diff: ${parsed.failure.reason}`);
      }
      return ok(
        parsed.entries.flatMap((entry): readonly GitDiffEntry[] => {
          if (entry.kind === "rename") {
            return [
              {
                logicalPath: entry.originalPath ?? "",
                version,
                changeKind: "delete",
                beforeDigest: headDigests.get(entry.originalPath ?? "") ?? null,
                afterDigest: null
              },
              {
                logicalPath: entry.newPath,
                version,
                changeKind: "create",
                beforeDigest: null,
                afterDigest: indexDigests.get(entry.newPath) ?? null
              }
            ];
          }
          if (entry.kind === "copy") {
            return [
              {
                logicalPath: entry.newPath,
                version,
                changeKind: "create",
                beforeDigest: null,
                afterDigest: indexDigests.get(entry.newPath) ?? null
              }
            ];
          }
          return [
            {
              logicalPath: entry.newPath,
              version,
              changeKind: entry.kind,
              beforeDigest: entry.kind === "create" ? null : headDigests.get(entry.newPath) ?? null,
              afterDigest: entry.kind === "delete" ? null : indexDigests.get(entry.newPath) ?? null
            }
          ];
        })
      );
    }

    const unstaged = await this.options.gitRuntime.run(["diff", "--name-status", "-z"], {
      cwd: repo.localPath
    });
    if (!unstaged.ok) {
      return this.runtimeError(unstaged.failure);
    }
    const porcelain = await this.readPorcelain(repo.localPath);
    if (porcelain.error) {
      return { ok: false, value: null, error: porcelain.error };
    }
    const untrackedPaths = porcelain.value.entries
      .filter((entry) => entry.untracked && !entry.ignored)
      .map((entry) => entry.logicalPath);
    const diffPaths = unstaged.stdout
      .split("\0")
      .filter((token) => token.length > 0 && !/^[ADRTC]\d*$/.test(token));
    const worktreeDigests = await this.hashWorktreePaths(repo.localPath, [...diffPaths, ...untrackedPaths]);
    const parsed = parseNameStatus(unstaged.stdout);
    if ("failure" in parsed) {
      return err("local-error", `failed to parse worktree diff: ${parsed.failure.reason}`);
    }
    const entries: GitDiffEntry[] = parsed.entries.flatMap((entry): readonly GitDiffEntry[] => {
      if (entry.kind === "rename") {
        return [
          {
            logicalPath: entry.originalPath ?? "",
            version,
            changeKind: "delete",
            beforeDigest: indexDigests.get(entry.originalPath ?? "") ?? null,
            afterDigest: null
          },
          {
            logicalPath: entry.newPath,
            version,
            changeKind: "create",
            beforeDigest: null,
            afterDigest: worktreeDigests.get(entry.newPath) ?? null
          }
        ];
      }
      if (entry.kind === "copy") {
        return [
          {
            logicalPath: entry.newPath,
            version,
            changeKind: "create",
            beforeDigest: null,
            afterDigest: worktreeDigests.get(entry.newPath) ?? null
          }
        ];
      }
      return [
        {
          logicalPath: entry.newPath,
          version,
          changeKind: entry.kind,
          beforeDigest: entry.kind === "create" ? null : indexDigests.get(entry.newPath) ?? null,
          afterDigest: entry.kind === "delete" ? null : worktreeDigests.get(entry.newPath) ?? null
        }
      ];
    });
    for (const untrackedPath of untrackedPaths) {
      entries.push({
        logicalPath: untrackedPath,
        version,
        changeKind: "create",
        beforeDigest: null,
        afterDigest: worktreeDigests.get(untrackedPath) ?? null
      });
    }
    return ok(entries);
  }

  async log(
    repositoryId: RepositoryId,
    cursor: string | null,
    pageSize: number
  ): Promise<GitResult<GitLogPage>> {
    const repo = this.registry.get(repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${repositoryId}`);
    }
    const offset = decodeLogCursor(cursor);
    if (offset === null) {
      return err("local-error", `invalid log cursor: ${cursor}`);
    }
    const size = Math.min(Math.max(pageSize, 1), 100);
    const run = await this.options.gitRuntime.run(
      ["log", `--format=${gitLogFormat()}`, `--skip=${offset}`, `--max-count=${size + 1}`],
      { cwd: repo.localPath }
    );
    if (!run.ok) {
      return this.runtimeError(run.failure);
    }
    const parsed = parseStructuredLog(run.stdout).map(
      (entry): GitLogEntry => ({
        revision: entry.revision,
        parents: entry.parents,
        authorName: entry.authorName,
        authoredAt: entry.authoredAt,
        subject: entry.subject
      })
    );
    const hasMore = parsed.length > size;
    const commits = hasMore ? parsed.slice(0, size) : parsed;
    return ok({
      commits,
      nextCursor: hasMore ? encodeLogCursor(offset + size) : null
    });
  }

  async discardWorktreeChanges(request: DiscardWorktreeRequest): Promise<GitResult<GitRepositoryStatus>> {
    const repo = this.registry.get(request.repositoryId);
    if (!repo) {
      return err("local-error", `unknown repository ${request.repositoryId}`);
    }
    if (request.backupSnapshotRef.trim().length === 0) {
      return err("local-error", "discard requires a backup snapshot reference");
    }
    if (request.logicalPaths.length === 0) {
      return err("local-error", "discard requires at least one logical path");
    }
    const guard = this.validatePaths(request.logicalPaths);
    if (guard) {
      return guard;
    }
    const status = await this.buildStatus(repo.localPath, repo.repositoryId);
    if (status.error) {
      return { ok: false, value: null, error: status.error };
    }
    const stale = this.checkExpected(status.value.status, request.expected, { requireWorktree: true });
    if (stale) {
      return stale;
    }
    const entryMap = new Map(status.value.status.paths.map((pathStatus) => [pathStatus.logicalPath, pathStatus]));
    for (const logicalPath of request.logicalPaths) {
      const pathStatus = entryMap.get(logicalPath);
      if (!pathStatus) {
        return err("local-error", `cannot discard unchanged or unknown path: ${logicalPath}`);
      }
      if (pathStatus.headDigest === null && pathStatus.indexDigest === null) {
        return err(
          "local-error",
          `discarding untracked paths requires the M4 repo-edit transaction; refused: ${logicalPath}`
        );
      }
    }
    const backupDir = await this.prepareDiscardBackup(repo.localPath, request.backupSnapshotRef, [
      ...entryMap.values()
    ]);
    if ("error" in backupDir) {
      return { ok: false, value: null, error: backupDir.error };
    }
    const restore = await this.options.gitRuntime.run(
      ["restore", "--worktree", "--", ...request.logicalPaths],
      { cwd: repo.localPath }
    );
    if (!restore.ok) {
      return this.runtimeError(restore.failure);
    }
    const updated = await this.buildStatus(repo.localPath, repo.repositoryId);
    if (updated.error) {
      return { ok: false, value: null, error: updated.error };
    }
    return ok(updated.value.status);
  }

  async open(request: OpenRepositoryRequest): Promise<GitResult<GitRepositoryStatus>> {
    if (request.localPath.length === 0 || request.localPath.includes("\0")) {
      return err("local-error", "invalid repository path");
    }
    const identityResult = await this.resolveRepositoryIdentity(request.localPath);
    if (identityResult.error) {
      return { ok: false, value: null, error: identityResult.error };
    }
    const { repositoryId, canonicalRemote, canonicalRoot } = identityResult.value;
    this.registry.set(repositoryId, { repositoryId, localPath: canonicalRoot, canonicalRemote });
    this.activeRepositoryId = repositoryId;
    if (this.options.identityStore) {
      await this.options.identityStore.bindRepository(repositoryId, canonicalRemote, canonicalRoot);
    }
    const status = await this.buildStatus(canonicalRoot, repositoryId);
    if (status.error) {
      return { ok: false, value: null, error: status.error };
    }
    return ok(status.value.status);
  }

  // -------------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------------

  private isManaged(logicalPath: string): boolean {
    return (this.options.managedPathPolicy ?? defaultManagedPathPolicy)(logicalPath);
  }

  /**
   * Validates repository-relative logical paths: non-empty, relative,
   * traversal-free (".." rejected), and inside the managed areas.
   */
  private validatePaths(
    logicalPaths: readonly string[]
  ): { ok: false; value: null; error: GitOperationError } | null {
    for (const logicalPath of logicalPaths) {
      if (
        logicalPath.length === 0 ||
        logicalPath.includes("\0") ||
        logicalPath.startsWith("/") ||
        /^[A-Za-z]:/.test(logicalPath) ||
        logicalPath.split("/").some((segment) => segment === ".." || segment.length === 0)
      ) {
        return err("local-error", `invalid logical path: ${logicalPath}`);
      }
      if (!this.isManaged(logicalPath)) {
        return err("local-error", `path is outside the managed repository areas: ${logicalPath}`);
      }
    }
    return null;
  }

  /**
   * Copies the current bytes of to-be-discarded files into a flattened,
   * traversal-proof backup directory. Returns the backup directory path.
   */
  private async prepareDiscardBackup(
    repoRoot: string,
    snapshotRef: string,
    pathStatuses: readonly { logicalPath: string; worktreeDigest: string | null }[]
  ): Promise<{ backupDir: string } | { error: GitOperationError }> {
    if (!this.options.backupRoot) {
      return { backupDir: "" };
    }
    // Snapshot refs and logical paths are flattened to [A-Za-z0-9_-], so
    // the constructed backup paths stay inside backupRoot by construction.
    const flatten = (value: string): string =>
      value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "file";
    const backupDir = path.join(path.resolve(this.options.backupRoot), flatten(snapshotRef));
    await mkdir(backupDir, { recursive: true });
    for (const pathStatus of pathStatuses) {
      if (!pathStatus.worktreeDigest) {
        continue;
      }
      if (this.validatePaths([pathStatus.logicalPath])) {
        continue;
      }
      // Source side uses the validated real logical segments; the backup
      // side uses flattened segments so it cannot escape the backup root.
      const sourceSegments = pathStatus.logicalPath.split("/");
      const backupSegments = sourceSegments.map((segment) => flatten(segment));
      await mkdir(path.join(backupDir, ...backupSegments.slice(0, -1)), { recursive: true });
      await copyFile(
        path.join(path.resolve(repoRoot), ...sourceSegments),
        path.join(backupDir, ...backupSegments)
      );
    }
    return { backupDir };
  }

  private async resolveRepositoryIdentity(
    callerPath: string
  ): Promise<
    | {
        value: { repositoryId: RepositoryId; canonicalRemote: CanonicalRemote; canonicalRoot: string };
        error: null;
      }
    | { value: null; error: GitOperationError }
  > {
    // The raw caller path is used only as the Git working directory; Git
    // itself resolves symlinks and reports the canonical repository root.
    const topLevel = await this.options.gitRuntime.run(["rev-parse", "--show-toplevel"], {
      cwd: callerPath
    });
    if (!topLevel.ok) {
      return this.runtimeError(topLevel.failure);
    }
    const canonicalRoot = path.resolve(topLevel.stdout.trim());
    const isRoot = await sameDirectory(callerPath, canonicalRoot).catch(() => false);
    if (!isRoot) {
      return err("local-error", "path is inside a Git repository but is not its root");
    }
    const originUrl = await this.options.gitRuntime.run(["remote", "get-url", "origin"], {
      cwd: canonicalRoot
    });
    const hasher = this.options.hasher ?? nodeHasher;
    if (originUrl.ok) {
      const identity = createRemoteRepositoryIdentity(originUrl.stdout.trim(), hasher);
      return {
        value: {
          repositoryId: identity.repositoryId,
          canonicalRemote: identity.canonicalRemote,
          canonicalRoot
        },
        error: null
      };
    }
    // No origin: a persistent identity store is required so the local-only
    // repositoryId survives restarts; otherwise refuse rather than guess.
    const store = this.options.identityStore;
    if (!store) {
      return {
        value: null,
        error: {
          kind: "local-error",
          message: "repository has no origin remote and no persistent identity store is configured",
          retryable: false
        }
      };
    }
    const existing = store.findByLocalPath(canonicalRoot);
    if (existing) {
      return {
        value: {
          repositoryId: existing.repositoryId,
          canonicalRemote: existing.canonicalRemote,
          canonicalRoot
        },
        error: null
      };
    }
    const identity = createLocalOnlyRepositoryIdentity(
      `local-${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24)}`,
      hasher
    );
    return {
      value: {
        repositoryId: identity.repositoryId,
        canonicalRemote: identity.canonicalRemote,
        canonicalRoot
      },
      error: null
    };
  }

  private async listRemotes(localPath: string): Promise<readonly { name: string; url: string }[]> {
    const list = await this.options.gitRuntime.run(["remote"], { cwd: localPath });
    if (!list.ok) {
      return [];
    }
    const remotes: { name: string; url: string }[] = [];
    for (const name of list.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)) {
      const url = await this.options.gitRuntime.run(["remote", "get-url", name], { cwd: localPath });
      if (url.ok) {
        remotes.push({ name, url: url.stdout.trim() });
      }
    }
    return remotes;
  }

  private async readPorcelain(
    localPath: string
  ): Promise<{ value: PorcelainStatus; error: null } | { value: null; error: GitOperationError }> {
    const run = await this.options.gitRuntime.run(
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
      {
        cwd: localPath
      }
    );
    if (!run.ok) {
      return { value: null, error: this.toError(run.failure) };
    }
    const parsed = parsePorcelainV2(run.stdout);
    if ("failure" in parsed) {
      return {
        value: null,
        error: {
          kind: "local-error",
          message: `failed to parse git status: ${parsed.failure.reason}`,
          retryable: false
        }
      };
    }
    return { value: parsed.status, error: null };
  }

  private toError(failure: { kind: string; message: string; retryable: boolean } | null): GitOperationError {
    if (!failure) {
      return { kind: "local-error", message: "unknown git failure", retryable: false };
    }
    return {
      kind: failure.kind as GitOperationError["kind"],
      message: failure.message,
      retryable: failure.retryable
    };
  }

  private async revParse(
    localPath: string,
    revision: string
  ): Promise<{ ok: true; value: string } | { ok: false; value: null; error: GitOperationError }> {
    const run = await this.options.gitRuntime.run(["rev-parse", revision], { cwd: localPath });
    const value = run.stdout.trim();
    if (!run.ok || value.length === 0) {
      return { ok: false, value: null, error: this.toError(run.failure) };
    }
    return { ok: true, value };
  }

  private async remoteRelation(
    localPath: string
  ): Promise<{ ok: true; value: RemoteSyncStatus } | { ok: false; value: null; error: GitOperationError }> {
    const porcelain = await this.readPorcelain(localPath);
    if (porcelain.error) {
      return { ok: false, value: null, error: porcelain.error };
    }
    return { ok: true, value: this.relationFrom(porcelain.value) };
  }

  private relationFrom(status: PorcelainStatus): RemoteSyncStatus {
    if (status.upstream === null || status.ahead === null || status.behind === null) {
      // No upstream (or detached HEAD): reported as unreachable because no
      // remote relation exists to act on.
      return "remote-unreachable";
    }
    if (status.ahead > 0 && status.behind > 0) {
      return "diverged";
    }
    if (status.behind > 0) {
      return "behind-ff";
    }
    if (status.ahead > 0) {
      return "ahead";
    }
    return "up-to-date";
  }

  private async hashWorktreePaths(
    localPath: string,
    logicalPaths: readonly string[]
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(logicalPaths)].filter(
      (logicalPath) => logicalPath.length > 0 && !logicalPath.includes("\n")
    );
    const map = new Map<string, string>();
    if (unique.length === 0) {
      return map;
    }
    const run = await this.options.gitRuntime.run(["hash-object", "--stdin-paths"], {
      cwd: localPath,
      stdin: `${unique.join("\n")}\n`
    });
    if (!run.ok) {
      return map;
    }
    const digests = run.stdout.trim().split("\n");
    unique.forEach((logicalPath, index) => {
      const digest = digests[index];
      if (digest && digest.length > 0) {
        map.set(logicalPath, digest);
      }
    });
    return map;
  }

  private async buildStatus(
    localPath: string,
    repositoryId: RepositoryId
  ): Promise<
    | { value: { status: GitRepositoryStatus; expected: ExpectedRevisions }; error: null }
    | { value: null; error: GitOperationError }
  > {
    const porcelain = await this.readPorcelain(localPath);
    if (porcelain.error) {
      return { value: null, error: porcelain.error };
    }
    const status = porcelain.value;
    const headTree = await this.options.gitRuntime.run(["ls-tree", "-r", "HEAD"], { cwd: localPath });
    const indexList = await this.options.gitRuntime.run(["ls-files", "-s"], { cwd: localPath });
    if (!indexList.ok) {
      return { value: null, error: this.toError(indexList.failure) };
    }
    const headDigests =
      status.headRevision && headTree.ok ? parseLsTree(headTree.stdout) : new Map<string, string>();
    const indexDigests = parseLsFiles(indexList.stdout);

    const interesting = status.entries.filter(
      (entry) => !entry.ignored && (entry.staged || entry.unstaged || entry.untracked || entry.conflict)
    );
    const worktreeDigests = await this.hashWorktreePaths(
      localPath,
      interesting.filter((entry) => !entry.conflict).map((entry) => entry.logicalPath)
    );

    const paths = interesting.map((entry) => ({
      logicalPath: entry.logicalPath,
      managed: this.isManaged(entry.logicalPath),
      staged: entry.staged || entry.conflict,
      headDigest: headDigests.get(entry.logicalPath) ?? null,
      indexDigest: indexDigests.get(entry.logicalPath) ?? null,
      worktreeDigest: worktreeDigests.get(entry.logicalPath) ?? null
    }));

    const managedDirty = paths.some((pathStatus) => pathStatus.managed);
    const unmanagedDirty = paths.some((pathStatus) => !pathStatus.managed);
    const workingTree: GitRepositoryStatus["workingTree"] =
      managedDirty && unmanagedDirty
        ? "dirty-mixed"
        : managedDirty
          ? "dirty-managed"
          : unmanagedDirty
            ? "dirty-unmanaged"
            : "clean";

    let upstreamRevision: string | null = null;
    if (status.upstream !== null) {
      const upstream = await this.revParse(localPath, "@{upstream}");
      upstreamRevision = upstream.ok ? upstream.value : null;
    }

    const pendingPublish =
      this.options.identityStore?.findRepository(repositoryId)?.pendingPublish ?? false;

    const result: GitRepositoryStatus = {
      repositoryId,
      headRevision: status.headRevision,
      upstreamRevision,
      remoteStatus: this.relationFrom(status),
      ahead: status.ahead ?? 0,
      behind: status.behind ?? 0,
      workingTree,
      paths,
      pendingPublish
    };
    return { value: { status: result, expected: this.expectedRevisions(result) }, error: null };
  }

  expectedRevisions(status: GitRepositoryStatus): ExpectedRevisions {
    // The fingerprint tracks external worktree/HEAD state only; index
    // content is excluded because staging is our own operation between a
    // plan and its execution (late worktree edits still invalidate).
    const fingerprintSource = status.paths
      .map(
        (pathStatus) =>
          `${pathStatus.logicalPath}|${pathStatus.headDigest ?? "-"}|${pathStatus.worktreeDigest ?? "-"}`
      )
      .sort()
      .join("\n");
    const hasher = this.options.hasher ?? nodeHasher;
    return { head: status.headRevision, worktreeDigest: hasher.sha256Hex(fingerprintSource) };
  }

  /** Current expected revisions for a repository (callers build plans from this). */
  async currentExpectedRevisions(repositoryId: RepositoryId): Promise<GitResult<ExpectedRevisions>> {
    const status = await this.status(repositoryId);
    if (!status.ok || !status.value) {
      return { ok: false, value: null, error: status.error };
    }
    return ok(this.expectedRevisions(status.value));
  }

  private checkExpected(
    current: GitRepositoryStatus,
    expected: ExpectedRevisions,
    guard: { requireWorktree: boolean }
  ): { ok: false; value: null; error: GitOperationError } | null {
    if (expected.head !== null && current.headRevision !== expected.head) {
      return {
        ok: false,
        value: null,
        error: {
          kind: "stale-revision",
          message: `HEAD moved from ${expected.head} to ${current.headRevision ?? "(none)"}`,
          retryable: false
        }
      };
    }
    if (guard.requireWorktree) {
      const currentFingerprint = this.expectedRevisions(current).worktreeDigest;
      if (expected.worktreeDigest !== null && currentFingerprint !== expected.worktreeDigest) {
        return {
          ok: false,
          value: null,
          error: {
            kind: "stale-revision",
            message:
              "working tree changed since the plan was confirmed; rebuild the plan from a fresh status",
            retryable: false
          }
        };
      }
    }
    return null;
  }

  private async markPendingPublish(repositoryId: RepositoryId, pendingPublish: boolean): Promise<void> {
    if (this.options.identityStore) {
      await this.options.identityStore.setPendingPublish(repositoryId, pendingPublish);
    }
  }

  private runtimeError(
    failure: { kind: string; message: string; retryable: boolean } | null
  ): { ok: false; value: null; error: GitOperationError } {
    return { ok: false, value: null, error: this.toError(failure) };
  }
}

// Re-export canonical remote normalization for application-layer identity use.
export { normalizeGitRemoteUrl };

