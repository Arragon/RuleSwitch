// GitPort integration matrix (INH-1765 automated suite, plus acceptance
// coverage for INH-1760/1761/1762/1846) against a real local bare remote
// and the real Git executable on this machine (macOS, Apple Git).
//
// The matrix asserts the frozen safety semantics: FF-only, scoped commits,
// late-edit-after-stage never enters a commit, unmanaged content is never
// swept into commits, remote races keep local commits as pending publish,
// and blocked states leave fixture bytes untouched.
//
// All git invocations — including fixture setup — go through the same
// controlled GitRuntime (direct argv array, prompt-free env, redaction).

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { GitPortAdapter, defaultManagedPathPolicy } from "../../apps/desktop/src/main/infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../apps/desktop/src/main/infrastructure/git/git-runtime";
import { RepositoryIdentityStore } from "../../apps/desktop/src/main/infrastructure/git/identity-store";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-git-"));
  temporaryRoots.push(root);
  return root;
}

/** Fixture-setup git access via the controlled runtime (argv array, never a shell). */
async function fixtureGit(cwd: string, args: readonly string[]): Promise<string> {
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  const result = await runtime.run(args, { cwd });
  if (!result.ok) {
    throw new Error("fixture git failed: " + (result.failure === null ? "unknown" : result.failure.message));
  }
  return result.stdout;
}

interface Fixture {
  readonly root: string;
  readonly bareRemotePath: string;
  readonly clonePath: string;
  readonly storePath: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectory("matrix");
  // Unicode + space in both remote and clone paths (INH-1765 requirement).
  const bareRemotePath = path.join(root, "远端 bare.git");
  const clonePath = path.join(root, "工作 clone");
  await fixtureGit(root, ["init", "--bare", "--initial-branch=main", bareRemotePath]);
  await fixtureGit(root, ["clone", bareRemotePath, clonePath]);
  await fixtureGit(clonePath, ["config", "user.name", "RuleSwitch Test"]);
  await fixtureGit(clonePath, ["config", "user.email", "test@ruleswitch.invalid"]);
  await mkdir(path.join(clonePath, "global", "instructions"), { recursive: true });
  await writeFile(path.join(clonePath, "ruleswitch.yaml"), "version: 1\n", "utf8");
  await writeFile(path.join(clonePath, "global", "instructions", "AGENTS.md"), "# Global agents\n", "utf8");
  await fixtureGit(clonePath, ["add", "."]);
  await fixtureGit(clonePath, ["commit", "-m", "seed"]);
  await fixtureGit(clonePath, ["push", "-u", "origin", "main"]);
  const storePath = path.join(root, "state", "v1.json");
  return { root, bareRemotePath, clonePath, storePath };
}

/** Reads a committed blob's content for assertions. */
async function committedContent(cwd: string, revision: string, logicalPath: string): Promise<string> {
  return fixtureGit(cwd, ["show", revision + ":" + logicalPath]);
}

async function createAdapter(fixture: Fixture): Promise<GitPortAdapter> {
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  const identityStore = new RepositoryIdentityStore(fixture.storePath);
  await identityStore.load();
  return new GitPortAdapter({
    gitRuntime: runtime,
    identityStore,
    managedPathPolicy: defaultManagedPathPolicy,
    backupRoot: path.join(fixture.root, "backups")
  });
}

function requireOk<T>(result: { ok: boolean; value: T | null; error: { message: string } | null }): T {
  if (!result.ok || result.value === null) {
    throw new Error("git operation failed: " + (result.error === null ? "unknown" : result.error.message));
  }
  return result.value;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitPort repository lifecycle (INH-1760)", () => {
  test("clones from a unicode/space bare remote, opens, and keeps identity stable across three restarts", async () => {
    const fixture = await createFixture();
    await rm(fixture.clonePath, { recursive: true, force: true });

    const first = await createAdapter(fixture);
    const cloneStatus = requireOk(
      await first.clone({ remoteUrl: fixture.bareRemotePath, targetDirectory: fixture.clonePath })
    );
    const repositoryId = cloneStatus.repositoryId;
    expect(repositoryId).toMatch(/^repo_[0-9a-f]{64}$/);
    expect(cloneStatus.headRevision).toBeTruthy();
    expect(cloneStatus.remoteStatus).toBe("up-to-date");

    // Three simulated restarts: fresh adapter + identity store each time.
    for (let restart = 0; restart < 3; restart += 1) {
      const adapter = await createAdapter(fixture);
      const status = requireOk(await adapter.open({ localPath: fixture.clonePath }));
      expect(status.repositoryId).toBe(repositoryId);
    }
  }, 60_000);

  test("status distinguishes managed and unmanaged dirt with per-path digests", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));
    expect(opened.workingTree).toBe("clean");

    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# Changed\n", "utf8");
    await writeFile(path.join(fixture.clonePath, "notes.md"), "personal\n", "utf8");

    const status = requireOk(await adapter.status(opened.repositoryId));
    expect(status.workingTree).toBe("dirty-mixed");
    const managed = status.paths.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md");
    const unmanaged = status.paths.find((entry) => entry.logicalPath === "notes.md");
    expect(managed?.managed).toBe(true);
    expect(managed?.worktreeDigest).not.toBeNull();
    expect(managed?.headDigest).not.toBeNull();
    expect(managed?.worktreeDigest).not.toBe(managed?.headDigest);
    expect(unmanaged?.managed).toBe(false);
  }, 60_000);

  test("structured diagnostics for non-git directories, subpaths, detached HEAD, and missing manifest", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);

    const notAGit = await adapter.open({ localPath: fixture.root });
    expect(notAGit.ok).toBe(false);
    expect(notAGit.error?.kind).toBe("local-error");
    expect(notAGit.error?.message).toContain("not a git repository");

    const subpath = await adapter.open({ localPath: path.join(fixture.clonePath, "global") });
    expect(subpath.ok).toBe(false);
    expect(subpath.error?.message).toContain("not its root");

    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));
    const details = requireOk(await adapter.describeRepository(opened.repositoryId));
    expect(details.manifestPresent).toBe(true);
    expect(details.remotes.map((remote) => remote.name)).toContain("origin");

    // A second remote must not change the repository identity.
    await fixtureGit(fixture.clonePath, ["remote", "add", "backup", fixture.bareRemotePath]);
    const reopened = requireOk(await adapter.open({ localPath: fixture.clonePath }));
    expect(reopened.repositoryId).toBe(opened.repositoryId);
    const afterSecondRemote = await adapter.describeRepository(opened.repositoryId);
    if (!afterSecondRemote.ok) {
      console.log("describe error:", JSON.stringify(afterSecondRemote.error));
    }
    expect(requireOk(afterSecondRemote).remotes).toHaveLength(2);

    // Detached HEAD is reported structurally.
    await fixtureGit(fixture.clonePath, ["checkout", "--detach", "HEAD"]);
    const detachedDetails = requireOk(await adapter.describeRepository(opened.repositoryId));
    expect(detachedDetails.detached).toBe(true);

    // A repo whose index no longer tracks ruleswitch.yaml reports the
    // missing manifest (worktree file removed and unstaged from the index).
    await rm(path.join(fixture.clonePath, "ruleswitch.yaml"));
    await fixtureGit(fixture.clonePath, ["rm", "--cached", "ruleswitch.yaml"]);
    const manifestMissing = requireOk(await adapter.describeRepository(opened.repositoryId));
    expect(manifestMissing.manifestPresent).toBe(false);
  }, 60_000);

  test("no-origin repositories need the persistent identity store and stay stable", async () => {
    const fixture = await createFixture();
    await fixtureGit(fixture.clonePath, ["remote", "remove", "origin"]);

    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));
    expect(opened.repositoryId).toMatch(/^repo_[0-9a-f]{64}$/);

    const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
    const bareAdapter = new GitPortAdapter({ gitRuntime: runtime });
    const refused = await bareAdapter.open({ localPath: fixture.clonePath });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("no persistent identity store");
  }, 60_000);
});

describe("safe fetch / fast-forward / divergence guard (INH-1761)", () => {
  test("fast-forwards when behind and updates worktree content", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    // Remote advances: commit from an independent clone.
    const otherClone = path.join(fixture.root, "other clone");
    await fixtureGit(fixture.root, ["clone", fixture.bareRemotePath, otherClone]);
    await fixtureGit(otherClone, ["config", "user.name", "Other"]);
    await fixtureGit(otherClone, ["config", "user.email", "other@ruleswitch.invalid"]);
    await writeFile(path.join(otherClone, "global", "instructions", "AGENTS.md"), "# From remote\n", "utf8");
    await fixtureGit(otherClone, ["add", "."]);
    await fixtureGit(otherClone, ["commit", "-m", "remote advance"]);
    await fixtureGit(otherClone, ["push"]);

    const fetched = requireOk(await adapter.fetch(opened.repositoryId));
    expect(fetched).toBe("behind-ff");

    const before = await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8");
    const expectedBefore = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    const advanced = requireOk(
      await adapter.fastForwardOnly({ repositoryId: opened.repositoryId, expected: expectedBefore })
    );
    expect(advanced).toBe("up-to-date");
    const after = await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8");
    expect(after).toBe("# From remote\n");
    expect(after).not.toBe(before);
  }, 90_000);

  test("diverged and dirty states block fast-forward and leave fixture bytes unchanged", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    // Local commit (ahead).
    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# Local\n", "utf8");
    await fixtureGit(fixture.clonePath, ["add", "."]);
    await fixtureGit(fixture.clonePath, ["commit", "-m", "local"]);
    const aheadExpected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    const aheadStatus = requireOk(await adapter.status(opened.repositoryId));
    expect(aheadStatus.remoteStatus).toBe("ahead");
    const blocked = await adapter.fastForwardOnly({
      repositoryId: opened.repositoryId,
      expected: aheadExpected
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toContain("remote relation is ahead");

    // Remote advances too → diverged.
    const otherClone = path.join(fixture.root, "diverge clone");
    await fixtureGit(fixture.root, ["clone", fixture.bareRemotePath, otherClone]);
    await fixtureGit(otherClone, ["config", "user.name", "Other"]);
    await fixtureGit(otherClone, ["config", "user.email", "other@ruleswitch.invalid"]);
    await writeFile(path.join(otherClone, "ruleswitch.yaml"), "version: 1\n# remote\n", "utf8");
    await fixtureGit(otherClone, ["add", "."]);
    await fixtureGit(otherClone, ["commit", "-m", "remote"]);
    await fixtureGit(otherClone, ["push"]);

    await adapter.fetch(opened.repositoryId);
    const divergedStatus = requireOk(await adapter.status(opened.repositoryId));
    expect(divergedStatus.remoteStatus).toBe("diverged");
    const divergedExpected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    const divergedBlocked = await adapter.fastForwardOnly({
      repositoryId: opened.repositoryId,
      expected: divergedExpected
    });
    expect(divergedBlocked.ok).toBe(false);
    expect(divergedBlocked.error?.message).toContain("diverged");

    const agentsBytes = await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8");
    expect(agentsBytes).toBe("# Local\n");

    // Dirty worktree blocks fast-forward.
    const dirtyClone = path.join(fixture.root, "dirty clone");
    await fixtureGit(fixture.root, ["clone", fixture.bareRemotePath, dirtyClone]);
    const dirtyAdapter = await createAdapter(fixture);
    const dirtyOpened = requireOk(await dirtyAdapter.open({ localPath: dirtyClone }));
    await writeFile(path.join(dirtyClone, "global", "instructions", "AGENTS.md"), "# Dirty\n", "utf8");
    const dirtyExpected = requireOk(await dirtyAdapter.currentExpectedRevisions(dirtyOpened.repositoryId));
    const dirtyBlocked = await dirtyAdapter.fastForwardOnly({
      repositoryId: dirtyOpened.repositoryId,
      expected: dirtyExpected
    });
    expect(dirtyBlocked.ok).toBe(false);
    expect(dirtyBlocked.error?.message).toContain("working tree is dirty-managed");
    expect(await readFile(path.join(dirtyClone, "global", "instructions", "AGENTS.md"), "utf8")).toBe("# Dirty\n");
  }, 120_000);

  test("remote deletion surfaces as remote-error without breaking local state", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    await rm(fixture.bareRemotePath, { recursive: true, force: true });
    const failed = await adapter.fetch(opened.repositoryId);
    expect(failed.ok).toBe(false);
    expect(failed.error?.kind).toBe("remote-error");

    const status = requireOk(await adapter.status(opened.repositoryId));
    expect(status.headRevision).toBe(opened.headRevision);
    expect(await readFile(path.join(fixture.clonePath, "ruleswitch.yaml"), "utf8")).toContain("version: 1");
  }, 60_000);
});

describe("index operations, scoped commit, push (INH-1762/1846)", () => {
  test("stage/unstage managed paths; unstage never touches the worktree; unmanaged staging is rejected", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# Staged version\n", "utf8");
    const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));

    const staged = requireOk(
      await adapter.stage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/AGENTS.md"],
        expected
      })
    );
    const stagedPath = staged.paths.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md");
    expect(stagedPath?.staged).toBe(true);
    expect(stagedPath?.worktreeDigest).toBe(stagedPath?.indexDigest);

    const unstaged = requireOk(
      await adapter.unstage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/AGENTS.md"],
        expected
      })
    );
    expect(unstaged.paths.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md")?.staged).toBe(false);
    // Worktree bytes untouched by unstage.
    expect(await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8")).toBe(
      "# Staged version\n"
    );

    // Untracked managed file can be staged as a create.
    await writeFile(path.join(fixture.clonePath, "global", "instructions", "NEW.md"), "new\n", "utf8");
    const expected2 = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    const stagedCreate = requireOk(
      await adapter.stage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/NEW.md"],
        expected: expected2
      })
    );
    expect(stagedCreate.paths.find((entry) => entry.logicalPath === "global/instructions/NEW.md")?.staged).toBe(true);

    // Unmanaged paths are refused outright.
    await writeFile(path.join(fixture.clonePath, "personal.txt"), "mine\n", "utf8");
    const expected3 = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    const refused = await adapter.stage({
      repositoryId: opened.repositoryId,
      logicalPaths: ["personal.txt"],
      expected: expected3
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("managed repository areas");

    // Traversal-shaped paths are refused.
    const traversal = await adapter.stage({
      repositoryId: opened.repositoryId,
      logicalPaths: ["../outside.md"],
      expected: expected3
    });
    expect(traversal.ok).toBe(false);
  }, 90_000);

  test("late edit after staging stays out of the commit; only the staged version is committed", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# staged content\n", "utf8");
    const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    requireOk(
      await adapter.stage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/AGENTS.md"],
        expected
      })
    );

    // Late edit AFTER staging: must remain unstaged.
    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# late edit\n", "utf8");

    const commit = requireOk(
      await adapter.commitStaged({
        repositoryId: opened.repositoryId,
        message: "commit staged version only",
        expected: { head: expected.head, worktreeDigest: null },
        allowedManagedPaths: ["global/instructions/AGENTS.md"]
      })
    );
    expect(commit.revision).not.toBe(opened.headRevision);

    // The commit contains the staged bytes, not the late edit.
    const committed = await committedContent(fixture.clonePath, commit.revision, "global/instructions/AGENTS.md");
    expect(committed).toBe("# staged content\n");
    // The late edit is still an unstaged worktree change.
    expect(await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8")).toBe(
      "# late edit\n"
    );
    const status = requireOk(await adapter.status(opened.repositoryId));
    expect(status.paths.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md")?.staged).toBe(false);
  }, 90_000);

  test("rejects empty commits, empty messages, unmanaged staged content, and stale HEAD", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));
    const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));

    const emptyIndex = await adapter.commitStaged({
      repositoryId: opened.repositoryId,
      message: "nothing staged",
      expected,
      allowedManagedPaths: []
    });
    expect(emptyIndex.ok).toBe(false);
    expect(emptyIndex.error?.message).toContain("nothing staged");

    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# x\n", "utf8");
    const expected2 = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    requireOk(
      await adapter.stage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/AGENTS.md"],
        expected: expected2
      })
    );
    const emptyMessage = await adapter.commitStaged({
      repositoryId: opened.repositoryId,
      message: "   ",
      expected: expected2,
      allowedManagedPaths: ["global/instructions/AGENTS.md"]
    });
    expect(emptyMessage.ok).toBe(false);
    expect(emptyMessage.error?.message).toContain("empty");

    // Unmanaged staged content blocks the commit (staged directly with fixture git).
    await writeFile(path.join(fixture.clonePath, "rogue.txt"), "rogue\n", "utf8");
    await fixtureGit(fixture.clonePath, ["add", "rogue.txt"]);
    const blocked = await adapter.commitStaged({
      repositoryId: opened.repositoryId,
      message: "must be blocked",
      expected: expected2,
      allowedManagedPaths: ["global/instructions/AGENTS.md"]
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.kind).toBe("unmanaged-staged-content");
    expect(blocked.error?.message).toContain("rogue.txt");
    await fixtureGit(fixture.clonePath, ["restore", "--staged", "rogue.txt"]);

    // External HEAD movement between confirmation and commit → stale-revision.
    await fixtureGit(fixture.clonePath, ["commit", "-m", "external commit", "--allow-empty"]);
    const stale = await adapter.commitStaged({
      repositoryId: opened.repositoryId,
      message: "stale attempt",
      expected: expected2,
      allowedManagedPaths: ["global/instructions/AGENTS.md"]
    });
    expect(stale.ok).toBe(false);
    expect(stale.error?.kind).toBe("stale-revision");
  }, 90_000);

  test("push succeeds, then a concurrent remote push yields remote-race + persisted pending publish", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    const commitAndPush = async (): Promise<void> => {
      await writeFile(path.join(fixture.clonePath, "ruleswitch.yaml"), "version: 1\n# a\n", "utf8");
      const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
      requireOk(
        await adapter.stage({
          repositoryId: opened.repositoryId,
          logicalPaths: ["ruleswitch.yaml"],
          expected
        })
      );
      const commit = requireOk(
        await adapter.commitStaged({
          repositoryId: opened.repositoryId,
          message: "managed change",
          expected,
          allowedManagedPaths: ["ruleswitch.yaml"]
        })
      );
      const pushed = await adapter.push({ repositoryId: opened.repositoryId, expectedHead: commit.revision });
      if (!pushed.ok || pushed.value === null) {
        throw new Error("push failed: " + (pushed.error === null ? "unknown" : pushed.error.message));
      }
    };

    await commitAndPush();
    const cleanStatus = requireOk(await adapter.status(opened.repositoryId));
    expect(cleanStatus.remoteStatus).toBe("up-to-date");
    expect(cleanStatus.pendingPublish).toBe(false);

    // Another clone pushes a conflicting advance.
    const racer = path.join(fixture.root, "racer clone");
    await fixtureGit(fixture.root, ["clone", fixture.bareRemotePath, racer]);
    await fixtureGit(racer, ["config", "user.name", "Racer"]);
    await fixtureGit(racer, ["config", "user.email", "racer@ruleswitch.invalid"]);
    await writeFile(path.join(racer, "global", "instructions", "AGENTS.md"), "# raced\n", "utf8");
    await fixtureGit(racer, ["add", "."]);
    await fixtureGit(racer, ["commit", "-m", "race"]);
    await fixtureGit(racer, ["push"]);

    // Local commit without fetching first.
    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# local after race\n", "utf8");
    const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    requireOk(
      await adapter.stage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/AGENTS.md"],
        expected
      })
    );
    const localCommit = requireOk(
      await adapter.commitStaged({
        repositoryId: opened.repositoryId,
        message: "local unaware",
        expected,
        allowedManagedPaths: ["global/instructions/AGENTS.md"]
      })
    );

    const raced = await adapter.push({ repositoryId: opened.repositoryId, expectedHead: localCommit.revision });
    expect(raced.ok).toBe(false);
    expect(raced.error?.kind).toBe("remote-error");
    expect(raced.error?.message).toContain("remote race");

    // Pending publish survives a restart (fresh adapter + store).
    const restarted = await createAdapter(fixture);
    const reopened = requireOk(await restarted.open({ localPath: fixture.clonePath }));
    expect(reopened.pendingPublish).toBe(true);
    expect(reopened.remoteStatus).toBe("diverged");

    // The confirmed local commit is still present.
    const log = requireOk(await restarted.log(reopened.repositoryId, null, 5));
    expect(log.commits[0]?.revision).toBe(localCommit.revision);

    // Conflict resolution is M4 scope; assert the local commit bytes were
    // not rolled back or disguised as published.
    expect(
      await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8")
    ).toBe("# local after race\n");
  }, 120_000);

  test("offline push keeps the local commit and records pending publish", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    await writeFile(path.join(fixture.clonePath, "ruleswitch.yaml"), "version: 1\n# offline\n", "utf8");
    const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    requireOk(
      await adapter.stage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["ruleswitch.yaml"],
        expected
      })
    );
    const commit = requireOk(
      await adapter.commitStaged({
        repositoryId: opened.repositoryId,
        message: "offline commit",
        expected,
        allowedManagedPaths: ["ruleswitch.yaml"]
      })
    );

    await rm(fixture.bareRemotePath, { recursive: true, force: true });
    const failed = await adapter.push({ repositoryId: opened.repositoryId, expectedHead: commit.revision });
    expect(failed.ok).toBe(false);
    expect(["remote-error", "auth-error"]).toContain(failed.error?.kind);

    const status = requireOk(await adapter.status(opened.repositoryId));
    expect(status.pendingPublish).toBe(true);
    expect(status.headRevision).toBe(commit.revision);
  }, 90_000);
});

describe("diffs, history, and discard (INH-1846)", () => {
  test("head-to-index and index-to-worktree diffs are separate; untracked files appear as creates", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# v2\n", "utf8");
    const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));
    requireOk(
      await adapter.stage({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/AGENTS.md"],
        expected
      })
    );
    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# v3 late\n", "utf8");
    await writeFile(path.join(fixture.clonePath, "global", "instructions", "untracked.md"), "new file\n", "utf8");

    const stagedDiff = requireOk(await adapter.diff(opened.repositoryId, "head-to-index"));
    const stagedEntry = stagedDiff.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md");
    expect(stagedEntry?.changeKind).toBe("modify");
    expect(stagedEntry?.beforeDigest).not.toBe(stagedEntry?.afterDigest);

    const worktreeDiff = requireOk(await adapter.diff(opened.repositoryId, "index-to-worktree"));
    const lateEntry = worktreeDiff.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md");
    expect(lateEntry?.changeKind).toBe("modify");
    expect(lateEntry?.beforeDigest).toBe(stagedEntry?.afterDigest);
    const untrackedEntry = worktreeDiff.find((entry) => entry.logicalPath === "global/instructions/untracked.md");
    expect(untrackedEntry?.changeKind).toBe("create");
    expect(untrackedEntry?.beforeDigest).toBeNull();
  }, 90_000);

  test("log paginates with opaque cursors and carries sha/parents/author/time/subject", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    for (let index = 0; index < 3; index += 1) {
      await writeFile(path.join(fixture.clonePath, "ruleswitch.yaml"), "version: 1\n# " + index + "\n", "utf8");
      await fixtureGit(fixture.clonePath, ["add", "ruleswitch.yaml"]);
      await fixtureGit(fixture.clonePath, ["commit", "-m", "commit " + index]);
    }

    const firstPage = requireOk(await adapter.log(opened.repositoryId, null, 2));
    expect(firstPage.commits).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.commits[0]?.subject).toBe("commit 2");
    expect(firstPage.commits[0]?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(firstPage.commits[0]?.parents).toHaveLength(1);
    expect(firstPage.commits[0]?.authorName).toBe("RuleSwitch Test");
    expect(firstPage.commits[0]?.authoredAt).toBeTruthy();

    const secondPage = requireOk(await adapter.log(opened.repositoryId, firstPage.nextCursor, 2));
    expect(secondPage.commits[0]?.subject).toBe("commit 0");
    expect(secondPage.commits).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.commits[secondPage.commits.length - 1]?.subject).toBe("seed");

    const badCursor = await adapter.log(opened.repositoryId, "garbage", 2);
    expect(badCursor.ok).toBe(false);
  }, 90_000);

  test("discard restores tracked files after a flattened backup and rejects races", async () => {
    const fixture = await createFixture();
    const adapter = await createAdapter(fixture);
    const opened = requireOk(await adapter.open({ localPath: fixture.clonePath }));

    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# discard me\n", "utf8");
    const expected = requireOk(await adapter.currentExpectedRevisions(opened.repositoryId));

    const missingRef = await adapter.discardWorktreeChanges({
      repositoryId: opened.repositoryId,
      logicalPaths: ["global/instructions/AGENTS.md"],
      expected,
      backupSnapshotRef: "  "
    });
    expect(missingRef.ok).toBe(false);

    const discarded = requireOk(
      await adapter.discardWorktreeChanges({
        repositoryId: opened.repositoryId,
        logicalPaths: ["global/instructions/AGENTS.md"],
        expected,
        backupSnapshotRef: "snap-1"
      })
    );
    expect(discarded.workingTree).toBe("clean");
    expect(await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8")).toBe(
      "# Global agents\n"
    );
    const backups = await readdir(path.join(fixture.root, "backups", "snap-1"));
    expect(backups.length).toBeGreaterThan(0);

    // Race: worktree changes between the plan and the discard.
    await writeFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "# changed later\n", "utf8");
    const raced = await adapter.discardWorktreeChanges({
      repositoryId: opened.repositoryId,
      logicalPaths: ["global/instructions/AGENTS.md"],
      expected,
      backupSnapshotRef: "snap-2"
    });
    expect(raced.ok).toBe(false);
    expect(raced.error?.kind).toBe("stale-revision");
    expect(await readFile(path.join(fixture.clonePath, "global", "instructions", "AGENTS.md"), "utf8")).toBe(
      "# changed later\n"
    );
  }, 90_000);
});
