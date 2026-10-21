// INH-1857: per-item repository comparison.
//
// The DTO must carry both sides' repository paths, including the destination
// for a side that does not exist yet, so the Renderer can resolve one item at
// a time without assembling paths itself.

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CapabilityServiceV2 } from "../../application/capabilities-v2";
import { GitPortAdapter } from "../../infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../infrastructure/git/git-runtime";
import { ProjectsStore, SettingsStore } from "../../infrastructure/git/binding-store";
import { OperationsStore } from "../../infrastructure/git/sync-state";
import { RepositoryIdentityStore } from "../../infrastructure/git/identity-store";

const temporaryRoots: string[] = [];
const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createService() {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-compare-"));
  temporaryRoots.push(root);
  const bare = path.join(root, "bare.git");
  const repo = path.join(root, "配置 repo");
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  await runtime.run(["init", "--bare", "-q", "--initial-branch=main", bare], { cwd: root });
  await runtime.run(["clone", "-q", bare, repo], { cwd: root });
  await runtime.run(["config", "user.name", "T"], { cwd: repo });
  await runtime.run(["config", "user.email", "t@t"], { cwd: repo });
  await writeFile(path.join(repo, "ruleswitch.yaml"), "schemaVersion: 1\n", "utf8");

  // Source collection holds two skills; the native collection holds one of
  // them with different bytes, and a target-only entry.
  await mkdir(path.join(repo, "global", "skills", "review"), { recursive: true });
  await mkdir(path.join(repo, "global", "skills", "shared"), { recursive: true });
  await mkdir(path.join(repo, "global", "native", "codex", "skills", "review"), { recursive: true });
  await mkdir(path.join(repo, "global", "native", "codex", "skills", "legacy"), { recursive: true });
  await writeFile(path.join(repo, "global", "skills", "review", "SKILL.md"), "# source review\n", "utf8");
  await writeFile(path.join(repo, "global", "skills", "shared", "SKILL.md"), "# shared\n", "utf8");
  await writeFile(path.join(repo, "global", "native", "codex", "skills", "review", "SKILL.md"), "# native review\n", "utf8");
  await writeFile(path.join(repo, "global", "native", "codex", "skills", "legacy", "SKILL.md"), "# legacy\n", "utf8");

  await runtime.run(["add", "."], { cwd: repo });
  await runtime.run(["commit", "-q", "-m", "seed"], { cwd: repo });
  await runtime.run(["push", "-q", "-u", "origin", "main"], { cwd: repo });

  const identityStore = new RepositoryIdentityStore(path.join(root, "state", "identity.json"));
  await identityStore.load();
  const gitPort = new GitPortAdapter({ gitRuntime: runtime, identityStore });
  const projectsStore = new ProjectsStore(path.join(root, "state", "projects.json"));
  await projectsStore.load();
  const settingsStore = new SettingsStore(path.join(root, "state", "settings.json"));
  await settingsStore.load();
  const operationsStore = new OperationsStore(path.join(root, "state", "operations.json"));
  await operationsStore.load();

  const service = new CapabilityServiceV2({
    gitPort,
    projectsStore,
    settingsStore,
    operationsStore,
    hasher
  });
  return { root, repo, service };
}

describe("CapabilityServiceV2.setCompare (INH-1857)", () => {
  it("returns both sides' repository paths for a modified asset", async () => {
    const { repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);

    const compare = await service.setCompare();
    expect(compare).not.toBeNull();
    const review = compare?.diffs.find((diff) => diff.assetKey === "skills|review/SKILL.md");
    expect(review?.sourceAssetKey).toBe("global/skills/review/SKILL.md");
    expect(review?.targetAssetKey).toBe("global/native/codex/skills/review/SKILL.md");
    // No trusted common baseline, so single/double modification is not claimed.
    expect(review?.relation).toBe("both-modified");
  }, 90_000);

  it("suggests the destination path for a source-only asset", async () => {
    const { repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);

    const compare = await service.setCompare();
    const shared = compare?.diffs.find((diff) => diff.assetKey === "skills|shared/SKILL.md");
    expect(shared?.relation).toBe("source-only");
    expect(shared?.sourceAssetKey).toBe("global/skills/shared/SKILL.md");
    // Destination is provided even though the file does not exist yet.
    expect(shared?.targetAssetKey).toBe("global/native/codex/skills/shared/SKILL.md");
  }, 90_000);

  it("resolves one item by copying the source over the target", async () => {
    const { repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);

    const compare = await service.setCompare();
    const review = compare?.diffs.find((diff) => diff.assetKey === "skills|review/SKILL.md");
    expect(review?.sourceAssetKey).toBeTruthy();
    expect(review?.targetAssetKey).toBeTruthy();

    const source = await service.readRepoFile(review!.sourceAssetKey!);
    expect(source).not.toBeNull();
    // The service takes raw bytes; only the IPC layer accepts base64.
    expect(
      await service.editRepoFile(
        review!.targetAssetKey!,
        new Uint8Array(Buffer.from(source!.contentBase64, "base64"))
      )
    ).toBe(true);

    // The target now matches the source byte for byte, so the relation
    // collapses to identical.
    expect(await readFile(path.join(repo, "global", "native", "codex", "skills", "review", "SKILL.md"), "utf8")).toBe(
      await readFile(path.join(repo, "global", "skills", "review", "SKILL.md"), "utf8")
    );
    const after = await service.setCompare();
    expect(after?.diffs.find((diff) => diff.assetKey === "skills|review/SKILL.md")?.relation).toBe(
      "identical"
    );
  }, 90_000);

  it("creates a missing destination file when promoting a source-only asset", async () => {
    const { repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);

    const compare = await service.setCompare();
    const shared = compare?.diffs.find((diff) => diff.assetKey === "skills|shared/SKILL.md");
    const source = await service.readRepoFile(shared!.sourceAssetKey!);
    expect(source).not.toBeNull();
    expect(
      await service.editRepoFile(
        shared!.targetAssetKey!,
        new Uint8Array(Buffer.from(source!.contentBase64, "base64"))
      )
    ).toBe(true);

    expect(
      await readFile(path.join(repo, "global", "native", "codex", "skills", "shared", "SKILL.md"), "utf8")
    ).toBe(await readFile(path.join(repo, "global", "skills", "shared", "SKILL.md"), "utf8"));
    const after = await service.setCompare();
    expect(after?.diffs.find((diff) => diff.assetKey === "skills|shared/SKILL.md")?.relation).toBe(
      "identical"
    );
  }, 90_000);

  it("repo-internal sync leaves unstaged working-tree changes only, never an automatic commit", async () => {
    const { repo, service } = await createService();
    await service.openRepositoryFromDirectory(repo);

    const compare = await service.setCompare();
    const review = compare?.diffs.find((diff) => diff.assetKey === "skills|review/SKILL.md");
    const source = await service.readRepoFile(review!.sourceAssetKey!);
    expect(source).not.toBeNull();
    expect(
      await service.editRepoFile(
        review!.targetAssetKey!,
        new Uint8Array(Buffer.from(source!.contentBase64, "base64"))
      )
    ).toBe(true);

    // Acceptance (INH-1857 #4): 仓库内同步只生成 Git 未暂存更改；
    // commit / push / apply 各自独立。Nothing staged, nothing committed.
    const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
    const status = await runtime.run(["status", "--porcelain"], { cwd: repo });
    // trimEnd only: porcelain encodes state in leading characters, and the
    // unstaged-modification prefix is exactly " M " (space, M, space).
    const lines = status.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(" M global/native/codex/skills/review/SKILL.md");

    // HEAD still holds the seeded bytes: the change lives in the worktree only.
    const head = await runtime.run(["show", "HEAD:global/native/codex/skills/review/SKILL.md"], { cwd: repo });
    expect(head.stdout).toBe("# native review\n");
  }, 90_000);
});
