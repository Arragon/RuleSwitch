// M4 integration matrix (INH-1781..1790, 1848..1850): journaled batch
// apply across real harness directories, pending-publish recovery across
// simulated restarts, repo edit/delete working-tree transactions, and
// in-repo collection comparison driving working-tree-only sync. All Git
// operations go through the GitPort; all harness writes through the
// transactional apply.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  applyRenderedTargets,
  restoreSnapshot,
  SkillSliceAdapter
} from "../../apps/desktop/src/main/infrastructure/harness/skill-slice";
import { OperationsStore } from "../../apps/desktop/src/main/infrastructure/git/sync-state";
import {
  aggregateSkillAssets,
  loadRepoInventory,
  nextBatchStep,
  planRepoEdit,
  compareCollections,
  settleBatch,
  recordRollback,
  rollbackCandidates,
  utf8Encode
} from "../../packages/core/src/index";
import type { BatchJournal, BatchTargetPlanEntry } from "../../packages/core/src/index";
import { createM3Environment, disposeM3Environment, type M3Environment } from "./helpers/m3-env";

const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

let env: M3Environment;

beforeAll(async () => {
  env = await createM3Environment();
}, 120_000);

afterAll(async () => {
  await disposeM3Environment(env);
});

function repoChild(logicalPath: string): string {
  if (
    logicalPath.length === 0 ||
    logicalPath.includes("\0") ||
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("refusing unsafe repo-relative path: " + JSON.stringify(logicalPath));
  }
  const target = path.resolve(env.repoPath, logicalPath);
  if (target !== env.repoPath && !target.startsWith(env.repoPath + path.sep)) {
    throw new Error("repo path escapes root: " + JSON.stringify(logicalPath));
  }
  return target;
}

async function loadGraph() {
  const { createFsRepoFileSource } = await import("../../apps/desktop/src/main/infrastructure/git/repo-source");
  const result = await loadRepoInventory(createFsRepoFileSource(env.repoPath), hasher);
  if (!result.ok) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  }
  return result.inventory;
}

describe("journaled batch apply to multiple harnesses (INH-1789)", () => {
  test("applies one skill to Claude and Codex with per-target journal outcomes", async () => {
    const inventory = await loadGraph();
    const skills = aggregateSkillAssets(
      inventory.assets.filter((asset) => asset.kind === "skills"),
      hasher
    );
    const skill = skills.find((entry) => entry.skillName === "pdf-helper")!;

    const harnesses = [
      { key: "claude|global", root: env.claudeRoot, adapter: new SkillSliceAdapter({ adapterId: "claude-code", displayName: "Claude", scopeRoot: env.claudeRoot, scope: { kind: "global" as const } }) },
      { key: "codex|global", root: env.codexRoot, adapter: new SkillSliceAdapter({ adapterId: "codex", displayName: "Codex", scopeRoot: env.codexRoot, scope: { kind: "global" as const } }) }
    ];

    const planEntries: BatchTargetPlanEntry[] = harnesses.map((harness) => ({
      targetKey: harness.key,
      mode: "overwrite",
      revision: skill.digest,
      executable: true,
      blockedReason: null
    }));
    const journal: BatchJournal = {
      batchId: "batch-m4-1",
      planId: "plan-m4-1",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "RUNNING",
      entries: planEntries.map((entry) => ({
        targetKey: entry.targetKey,
        mode: entry.mode,
        planRevision: entry.revision,
        state: "PENDING" as const,
        snapshotRef: null,
        verifyDigest: null,
        failureDetail: null,
        rollbackOf: false
      }))
    };

    for (const harness of harnesses) {
      const step = nextBatchStep(journal);
      if (step.action !== "execute") {
        throw new Error(step.action === "halt" ? step.reason : "unexpected skip");
      }
      const rendered = await harness.adapter.render("unused", [
        ...skill.files.map((file) => ({
          assetKey: "global|skills|" + skill.skillName + "/" + file.relativePath,
          kind: "skills" as const,
          logicalName: skill.skillName + "/" + file.relativePath,
          content: file.content
        }))
      ]);
      if (rendered.output === null) {
        throw new Error("render failed");
      }
      const applied = await applyRenderedTargets({
        targetRoot: harness.root,
        targets: rendered.output.map((target) => ({ targetLogicalPath: target.targetLogicalPath, content: target.content })),
        firstAdoptionConfirmed: true,
        baselineDigests: {}
      });
      if (!applied.ok) {
        step.entry.state = "APPLY_FAILED";
        step.entry.failureDetail = applied.message;
        continue;
      }
      const verified = await harness.adapter.verify(
        "unused",
        rendered.output.map((target) => ({ targetLogicalPath: target.targetLogicalPath, expectedDigest: target.outputDigest }))
      );
      const allVerified = verified.output?.every((report) => report.verified) ?? false;
      step.entry.state = allVerified ? "COMMITTED" : "VERIFY_FAILED";
      step.entry.snapshotRef = "snap-" + harness.key;
      step.entry.verifyDigest = skill.digest;
    }
    settleBatch(journal, () => new Date().toISOString());
    expect(journal.status).toBe("ALL_COMMITTED");
    expect(journal.entries.every((entry) => entry.state === "COMMITTED")).toBe(true);

    expect((await harnesses[0].adapter.readSkill("pdf-helper"))?.digest).toBe(skill.digest);
    expect((await harnesses[1].adapter.readSkill("pdf-helper"))?.digest).toBe(skill.digest);

    for (const key of rollbackCandidates(journal)) {
      const harness = harnesses.find((candidate) => candidate.key === key)!;
      await restoreSnapshot({
        targetRoot: harness.root,
        files: skill.files.map((file) => ({
          relativePath: "skills/pdf-helper/" + file.relativePath,
          existedBefore: false,
          previousContent: null
        }))
      });
      recordRollback(journal, key, true, () => new Date().toISOString());
    }
    expect(journal.status).toBe("ROLLED_BACK");
    expect(await harnesses[0].adapter.readSkill("pdf-helper")).toBeNull();
    expect(await harnesses[1].adapter.readSkill("pdf-helper")).toBeNull();
  }, 180_000);

  test("a failing target halts the rest and partial success is labeled honestly", async () => {
    const inventory = await loadGraph();
    const skill = aggregateSkillAssets(
      inventory.assets.filter((asset) => asset.kind === "skills"),
      hasher
    ).find((entry) => entry.skillName === "pdf-helper")!;

    const first = new SkillSliceAdapter({ adapterId: "claude-code", displayName: "C", scopeRoot: env.claudeRoot, scope: { kind: "global" } });
    const secondRoot = path.join(env.root, "harness-conflict");
    await mkdir(path.join(secondRoot, "skills", "pdf-helper"), { recursive: true });
    await writeFile(path.join(secondRoot, "skills", "pdf-helper", "SKILL.md"), "# user's own version\n");

    const rendered = await first.render("unused", [
      ...skill.files.map((file) => ({
        assetKey: "global|skills|" + skill.skillName + "/" + file.relativePath,
        kind: "skills" as const,
        logicalName: skill.skillName + "/" + file.relativePath,
        content: file.content
      }))
    ]);
    if (rendered.output === null) {
      throw new Error("render failed");
    }
    const targets = rendered.output.map((target) => ({ targetLogicalPath: target.targetLogicalPath, content: target.content }));

    const appliedFirst = await applyRenderedTargets({
      targetRoot: env.claudeRoot,
      targets,
      firstAdoptionConfirmed: true,
      baselineDigests: {}
    });
    expect(appliedFirst.ok).toBe(true);

    const appliedSecond = await applyRenderedTargets({
      targetRoot: secondRoot,
      targets,
      firstAdoptionConfirmed: false,
      baselineDigests: {}
    });
    expect(appliedSecond.ok).toBe(false);
    if (!appliedSecond.ok) {
      expect(appliedSecond.code).toBe("FIRST_ADOPTION_CONFIRMATION_REQUIRED");
    }
    expect(await readFile(path.join(secondRoot, "skills", "pdf-helper", "SKILL.md"), "utf8")).toBe("# user's own version\n");

    const journal: BatchJournal = {
      batchId: "batch-m4-2",
      planId: "plan-m4-2",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "RUNNING",
      entries: [
        { targetKey: "claude", mode: "overwrite", planRevision: skill.digest, state: "COMMITTED", snapshotRef: "s1", verifyDigest: skill.digest, failureDetail: null, rollbackOf: false },
        { targetKey: "conflicting", mode: "overwrite", planRevision: skill.digest, state: "APPLY_FAILED", snapshotRef: null, verifyDigest: null, failureDetail: "first adoption required", rollbackOf: false },
        { targetKey: "never-started", mode: "overwrite", planRevision: skill.digest, state: "PENDING", snapshotRef: null, verifyDigest: null, failureDetail: null, rollbackOf: false }
      ]
    };
    const step = nextBatchStep(journal);
    expect(step.action).toBe("halt");
    settleBatch(journal, () => new Date().toISOString());
    expect(journal.status).toBe("PARTIAL_SUCCESS");
  }, 180_000);
});

describe("pending publish recovery across restart (INH-1788)", () => {
  test("offline commit → restart → remote restored → retry push succeeds", async () => {
    const adapter = await env.makeAdapter();
    const opened = await adapter.open({ localPath: env.repoPath });
    if (!opened.ok || opened.value === null) {
      throw new Error("open failed");
    }
    const repositoryId = opened.value.repositoryId;

    await rm(env.bareRemotePath, { recursive: true, force: true });
    await writeFile(repoChild("global/instructions/AGENTS.md"), "# pending publish recovery\n");
    const expected = await adapter.currentExpectedRevisions(repositoryId);
    if (!expected.ok || expected.value === null) {
      throw new Error("expected failed");
    }
    const staged = await adapter.stage({ repositoryId, logicalPaths: ["global/instructions/AGENTS.md"], expected: expected.value });
    if (!staged.ok) {
      throw new Error(staged.error?.message);
    }
    const commit = await adapter.commitStaged({
      repositoryId,
      message: "pending publish candidate",
      expected: expected.value,
      allowedManagedPaths: ["global/instructions/AGENTS.md"]
    });
    if (!commit.ok || commit.value === null) {
      throw new Error(commit.error?.message);
    }
    const failedPush = await adapter.push({ repositoryId, expectedHead: commit.value.revision });
    expect(failedPush.ok).toBe(false);

    const operations = new OperationsStore(path.join(env.root, "state", "operations-v1.json"));
    await operations.load();
    await operations.recordPendingPublish(repositoryId, commit.value.revision, "op-pp-1", "main");

    // Simulated restart with the remote restored from the current repo.
    const restoredBare = path.join(env.root, "config-bare-restored.git");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("/usr/bin/git", ["clone", "-q", "--bare", env.repoPath, restoredBare]);
    await exec("/usr/bin/git", ["-C", env.repoPath, "remote", "set-url", "origin", restoredBare]);

    const restarted = await env.makeAdapter();
    const reopened = await restarted.open({ localPath: env.repoPath });
    if (!reopened.ok || reopened.value === null) {
      throw new Error("reopen failed");
    }
    // The restored remote is a different path → a new canonical remote and
    // repository id; recovery rebinds through the identity store, and the
    // pending publish is retried against the CURRENT identity.
    const currentRepositoryId = reopened.value.repositoryId;
    const retried = await restarted.push({ repositoryId: currentRepositoryId, expectedHead: commit.value.revision });
    if (!retried.ok) {
      console.log("RETRY-PUSH-ERROR:", retried.error?.kind, retried.error?.message);
    }
    expect(retried.ok).toBe(true);
    const cleared = await restarted.status(currentRepositoryId);
    if (!cleared.ok || cleared.value === null) {
      throw new Error("status failed");
    }
    expect(cleared.value.pendingPublish).toBe(false);
    await operations.clearPendingPublish(repositoryId);
  }, 180_000);
});

describe("repo edit/delete working-tree transactions (INH-1848)", () => {
  test("edit forms working-tree changes only; delete requires ownership+digest+confirmation", async () => {
    const adapter = await env.makeAdapter();
    const opened = await adapter.open({ localPath: env.repoPath });
    if (!opened.ok || opened.value === null) {
      throw new Error("open failed");
    }
    const repositoryId = opened.value.repositoryId;
    const status = await adapter.status(repositoryId);
    if (!status.ok || status.value === null) {
      throw new Error("status failed");
    }

    const editPlan = planRepoEdit({
      target: {
        logicalPaths: ["global/instructions/AGENTS.md"],
        repositoryId,
        baseRevision: status.value.headRevision ?? "",
        ownershipDigests: {}
      },
      writes: [{ logicalPath: "global/instructions/AGENTS.md", content: utf8Encode("# edited in the Library\n") }],
      currentRevision: status.value.headRevision ?? "",
      currentDigests: {},
      affectedAssetKeys: ["global|instructions|AGENTS.md"],
      deleteConfirmed: false
    });
    if (!editPlan.ok) {
      throw new Error(editPlan.message);
    }
    for (const write of editPlan.preview.writes) {
      if (write.content !== null) {
        await writeFile(repoChild(write.logicalPath), write.content);
      }
    }
    const afterEdit = await adapter.status(repositoryId);
    if (!afterEdit.ok || afterEdit.value === null) {
      throw new Error("status failed");
    }
    const editedPath = afterEdit.value.paths.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md");
    expect(editedPath?.staged).toBe(false);
    expect(editedPath?.worktreeDigest).not.toBe(editedPath?.headDigest);

    const expected = await adapter.currentExpectedRevisions(repositoryId);
    if (!expected.ok || expected.value === null) {
      throw new Error("expected failed");
    }
    await adapter.stage({ repositoryId, logicalPaths: ["global/instructions/AGENTS.md"], expected: expected.value });
    const commit = await adapter.commitStaged({
      repositoryId,
      message: "library edit: AGENTS.md",
      expected: expected.value,
      allowedManagedPaths: ["global/instructions/AGENTS.md"]
    });
    expect(commit.ok).toBe(true);

    const fresh = await adapter.status(repositoryId);
    if (!fresh.ok || fresh.value === null) {
      throw new Error("status failed");
    }
    const headDigest = fresh.value.paths.find((entry) => entry.logicalPath === "global/instructions/AGENTS.md")?.headDigest ?? null;
    const unconfirmed = planRepoEdit({
      target: {
        logicalPaths: ["global/instructions/AGENTS.md"],
        repositoryId,
        baseRevision: fresh.value.headRevision ?? "",
        ownershipDigests: { "global/instructions/AGENTS.md": headDigest ?? "" }
      },
      writes: [{ logicalPath: "global/instructions/AGENTS.md", content: null }],
      currentRevision: fresh.value.headRevision ?? "",
      currentDigests: { "global/instructions/AGENTS.md": headDigest ?? "" },
      affectedAssetKeys: ["global|instructions|AGENTS.md"],
      deleteConfirmed: false
    });
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) {
      expect(unconfirmed.code).toBe("DELETE_REFUSED");
    }

    const confirmed = planRepoEdit({
      target: {
        logicalPaths: ["global/instructions/AGENTS.md"],
        repositoryId,
        baseRevision: fresh.value.headRevision ?? "",
        ownershipDigests: { "global/instructions/AGENTS.md": headDigest ?? "" }
      },
      writes: [{ logicalPath: "global/instructions/AGENTS.md", content: null }],
      currentRevision: fresh.value.headRevision ?? "",
      currentDigests: { "global/instructions/AGENTS.md": headDigest ?? "" },
      affectedAssetKeys: ["global|instructions|AGENTS.md"],
      deleteConfirmed: true
    });
    expect(confirmed.ok).toBe(true);
    await writeFile(repoChild("global/instructions/AGENTS.md"), "# edited in the Library\n");
  }, 180_000);
});

describe("in-repo collection comparison → working-tree sync (INH-1850)", () => {
  test("source collection diffs drive target-side repo writes only", async () => {
    await mkdir(path.join(env.repoPath, "native", "codex", "skills", "pdf-helper", "scripts"), { recursive: true });
    await writeFile(path.join(env.repoPath, "native", "codex", "skills", "pdf-helper", "SKILL.md"), "# codex copy (older)\n");
    await writeFile(path.join(env.repoPath, "native", "codex", "skills", "pdf-helper", "scripts", "extract.sh"), "#!/bin/sh\necho extract\n");

    const inventory = await loadGraph();
    const skill = aggregateSkillAssets(
      inventory.assets.filter((asset) => asset.kind === "skills"),
      hasher
    ).find((entry) => entry.skillName === "pdf-helper")!;

    const codexAssets = [
      { kind: "skills" as const, logicalName: "pdf-helper/SKILL.md", digest: hasher.sha256Hex("# codex copy (older)\n") },
      { kind: "skills" as const, logicalName: "pdf-helper/scripts/extract.sh", digest: hasher.sha256Hex("#!/bin/sh\necho extract\n") }
    ];
    const sourceAssets = skill.files.map((file) => ({
      kind: "skills" as const,
      logicalName: "pdf-helper/" + file.relativePath,
      digest: hasher.sha256Hex(Buffer.from(file.content).toString("binary"))
    }));

    const comparison = compareCollections({
      repositoryId: "repo_" + "a".repeat(64),
      source: { label: "global-skills", assets: sourceAssets, supportedKinds: new Set(["skills" as const]) },
      target: { label: "codex-collection", assets: codexAssets, supportedKinds: new Set(["skills" as const]) },
      baselines: {},
      trustedBaseline: false
    });
    expect(comparison.confidence).toBe("unknown-baseline");
    const byKey = new Map(comparison.diffs.map((diff) => [diff.semanticKey, diff]));
    expect(byKey.get("skills|pdf-helper/SKILL.md")?.relation).toBe("both-modified");
    expect(byKey.get("skills|pdf-helper/references/usage.md")?.relation).toBe("source-only");

    // User confirms overwrite for the modified asset; sync writes ONLY the
    // target collection's repo file with the SOURCE bytes (no commit, no
    // push, no harness write).
    const sourceSkillMd = skill.files.find((file) => file.relativePath === "SKILL.md")!;
    await writeFile(repoChild("native/codex/skills/pdf-helper/SKILL.md"), sourceSkillMd.content);
    expect(await readFile(repoChild("global/skills/pdf-helper/SKILL.md"))).toBeDefined();
    const adapter = await env.makeAdapter();
    const opened = await adapter.open({ localPath: env.repoPath });
    if (!opened.ok || opened.value === null) {
      throw new Error("open failed");
    }
    const status = await adapter.status(opened.value.repositoryId);
    if (!status.ok || status.value === null) {
      throw new Error("status failed");
    }
    const syncedPath = status.value.paths.find((entry) => entry.logicalPath === "native/codex/skills/pdf-helper/SKILL.md");
    if (syncedPath === undefined) {
      console.log("STATUS-PATHS:", JSON.stringify(status.value.paths.map((entry) => entry.logicalPath)));
      console.log("WORKING-TREE:", status.value.workingTree);
    }
    expect(syncedPath?.staged).toBe(false);
  }, 180_000);
});
