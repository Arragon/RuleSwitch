// M3 Scenario A (INH-1774/1775/1776/1777/1778, evidence for INH-1780):
// the full One-Skill bidirectional loop on real macOS:
//
//   config repo → Claude render → verify
//   → local edits in Claude (modify + create + delete)
//   → CapturePlan → managed repo writes only → stale guards
//   → scoped commit → push to bare remote
//   → apply same skill to Codex → verify → restore
//   → push failure keeps local commit (pending publish)
//
// No step hand-edits Git or bypasses RuleSwitch surfaces: repo writes come
// from the capture plan, harness writes from the transactional apply.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  aggregateSkillAssets,
  buildCapturePlan,
  loadRepoInventory,
  verifyCapturePlanFreshness,
  type CapturePlan,
  type SkillAsset
} from "../../packages/core/src/index";
import { SkillSliceAdapter, SymlinkInHarnessError, applyRenderedTargets, restoreSnapshot } from "../../apps/desktop/src/main/infrastructure/harness/skill-slice";
import { createM3Environment, disposeM3Environment, type M3Environment } from "./helpers/m3-env";

const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

let env: M3Environment;
let repoSkill: SkillAsset;
let claude: SkillSliceAdapter;
let codex: SkillSliceAdapter;

beforeAll(async () => {
  env = await createM3Environment();
  claude = new SkillSliceAdapter({
    adapterId: "claude-code",
    displayName: "Claude Code",
    scopeRoot: env.claudeRoot,
    scope: { kind: "global" }
  });
  codex = new SkillSliceAdapter({
    adapterId: "codex",
    displayName: "Codex",
    scopeRoot: env.codexRoot,
    scope: { kind: "global" }
  });
}, 120_000);

afterAll(async () => {
  await disposeM3Environment(env);
});

function sha(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Validated repo-relative join with root-containment proof. */
function repoChild(logicalPath: string): string {
  if (
    logicalPath.length === 0 ||
    logicalPath.includes("\0") ||
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`refusing unsafe repo-relative path: ${JSON.stringify(logicalPath)}`);
  }
  const target = path.resolve(env.repoPath, logicalPath);
  if (target !== env.repoPath && !target.startsWith(env.repoPath + path.sep)) {
    throw new Error(`repo path escapes root: ${JSON.stringify(logicalPath)}`);
  }
  return target;
}

async function listRepoFiles(): Promise<string[]> {
  const { createFsRepoFileSource } = await import("../../apps/desktop/src/main/infrastructure/git/repo-source");
  return [...(await createFsRepoFileSource(env.repoPath).listFiles())];
}

async function readRepoFile(logicalPath: string): Promise<Uint8Array | null> {
  const bytes = await readFile(repoChild(logicalPath));
  return new Uint8Array(bytes);
}

describe("Git → Claude render + verify (INH-1774/1775)", () => {
  test("the canonical skill round-trips as a whole directory with metadata", async () => {
    const graph = await loadRepoInventory({ listFiles: listRepoFiles, readFile: readRepoFile }, hasher);
    if (!graph.ok) {
      throw new Error(graph.diagnostics.map((d) => d.message).join("; "));
    }
    const skills = aggregateSkillAssets(
      graph.inventory.assets.filter((asset) => asset.kind === "skills"),
      hasher
    );
    repoSkill = skills.find((skill) => skill.skillName === "pdf-helper")!;
    expect(repoSkill).toBeDefined();
    expect(repoSkill.files.map((file) => file.relativePath).sort()).toEqual([
      "SKILL.md",
      "assets/nested/data.txt",
      "references/usage.md",
      "scripts/extract.sh"
    ]);

    const rendered = await claude.render("unused", [
      ...repoSkill.files.map((file) => ({
        assetKey: `global|skills|${repoSkill.skillName}/${file.relativePath}`,
        kind: "skills" as const,
        logicalName: `${repoSkill.skillName}/${file.relativePath}`,
        content: file.content
      }))
    ]);
    if (rendered.output === null) {
      throw new Error("render failed");
    }
    const applied = await applyRenderedTargets({
      targetRoot: env.claudeRoot,
      targets: rendered.output.map((target) => ({ targetLogicalPath: target.targetLogicalPath, content: target.content })),
      firstAdoptionConfirmed: true,
      baselineDigests: {}
    });
    if (!applied.ok) {
      throw new Error(applied.message);
    }

    const verified = await claude.verify(
      "unused",
      rendered.output.map((target) => ({ targetLogicalPath: target.targetLogicalPath, expectedDigest: target.outputDigest }))
    );
    if (verified.output === null) {
      throw new Error("verify failed");
    }
    expect(verified.output.every((report) => report.verified)).toBe(true);

    const readBack = await claude.readSkill("pdf-helper");
    expect(readBack?.files.map((f) => f.relativePath).sort()).toEqual(repoSkill.files.map((f) => f.relativePath).sort());
    for (const file of repoSkill.files) {
      const actual = readBack?.files.find((f) => f.relativePath === file.relativePath);
      expect(actual && sha(actual.content)).toBe(sha(file.content));
    }
    expect(readBack?.files.find((f) => f.relativePath === "scripts/extract.sh")?.executable).toBe(true);
  }, 120_000);

  test("symlinks inside the harness directory are rejected", async () => {
    const outside = path.join(env.root, "outside-target.md");
    await writeFile(outside, "x");
    const linkPath = path.join(env.claudeRoot, "skills", "pdf-helper", "escape.md");
    await symlink(outside, linkPath);
    await expect(claude.readSkill("pdf-helper")).rejects.toBeInstanceOf(SymlinkInHarnessError);
    await rm(linkPath);
  });
});

describe("Claude local edits → CapturePlan → managed repo writes (INH-1777)", () => {
  test("modify + create + delete produce an exact managed delta and nothing else changes", async () => {
    const skillDir = path.join(env.claudeRoot, "skills", "pdf-helper");
    await writeFile(path.join(skillDir, "SKILL.md"), "# pdf-helper\n\nEdited by the user in Claude Code.\n");
    await writeFile(path.join(skillDir, "scripts", "new-tool.sh"), "#!/bin/sh\necho new\n");
    await rm(path.join(skillDir, "references", "usage.md"));

    const scanned = await claude.readSkill("pdf-helper");
    const planIdentity = {
      baselineRevision: null,
      repoRevision: (await currentRepoRevision()) ?? "seed",
      converterId: "ruleswitch.skills",
      converterVersion: "1.0.0"
    };
    const decision = buildCapturePlan({
      scope: { kind: "global" },
      skillName: "pdf-helper",
      baseline: repoSkill,
      scanned,
      planIdentity
    });
    if (!decision.ok) {
      throw new Error(decision.message);
    }
    const plan: CapturePlan = decision.plan;
    expect(plan.managedPathPrefix).toBe("global/skills/pdf-helper/");
    expect(plan.writes.map((w) => w.logicalPath).sort()).toEqual([
      "global/skills/pdf-helper/SKILL.md",
      "global/skills/pdf-helper/references/usage.md",
      "global/skills/pdf-helper/scripts/new-tool.sh"
    ]);
    const readmeBefore = await readFile(repoChild("README.md"), "utf8");

    await writeFile(path.join(skillDir, "SKILL.md"), "# pdf-helper\n\nEdited TWICE.\n");
    const staleCheck = verifyCapturePlanFreshness(plan, await claude.readSkill("pdf-helper"));
    expect(staleCheck.ok).toBe(false);
    if (!staleCheck.ok) {
      expect(staleCheck.code).toBe("STALE_PLAN");
    }
    const fresh = buildCapturePlan({
      scope: { kind: "global" },
      skillName: "pdf-helper",
      baseline: repoSkill,
      scanned: await claude.readSkill("pdf-helper"),
      planIdentity: {
        baselineRevision: null,
        repoRevision: (await currentRepoRevision()) ?? "seed",
        converterId: "ruleswitch.skills",
        converterVersion: "1.0.0"
      }
    });
    if (!fresh.ok) {
      throw new Error(fresh.message);
    }
    for (const write of fresh.plan.writes) {
      const absolute = repoChild(write.logicalPath);
      if (write.content === null) {
        await rm(absolute, { force: true });
        continue;
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, write.content);
    }

    expect(await readFile(repoChild("global/skills/pdf-helper/SKILL.md"), "utf8")).toBe(
      "# pdf-helper\n\nEdited TWICE.\n"
    );
    expect(await readFile(repoChild("README.md"), "utf8")).toBe(readmeBefore);
    await expect(readFile(repoChild("global/skills/pdf-helper/references/usage.md"))).rejects.toThrow();
  }, 120_000);

  test("capture without a trusted baseline is refused (ownership gate)", async () => {
    await mkdir(path.join(env.claudeRoot, "skills", "rogue-skill"), { recursive: true });
    await writeFile(path.join(env.claudeRoot, "skills", "rogue-skill", "SKILL.md"), "# rogue\n");
    const scanned = await claude.readSkill("rogue-skill");
    const decision = buildCapturePlan({
      scope: { kind: "global" },
      skillName: "rogue-skill",
      baseline: null,
      scanned,
      planIdentity: {
        baselineRevision: null,
        repoRevision: (await currentRepoRevision()) ?? "seed",
        converterId: "ruleswitch.skills",
        converterVersion: "1.0.0"
      }
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("OWNERSHIP_CONFIRMATION_REQUIRED");
    }
  });
});

describe("scoped commit → push → Codex apply → verify → restore (INH-1778)", () => {
  test("publishes to the bare remote and projects the same skill to Codex", async () => {
    const adapter = await env.makeAdapter();
    const repositoryId = await openedRepositoryId(adapter);
    const expected = await adapter.currentExpectedRevisions(repositoryId);
    if (!expected.ok || expected.value === null) {
      throw new Error("expected revisions failed");
    }
    const managedPaths = [
      "global/skills/pdf-helper/SKILL.md",
      "global/skills/pdf-helper/scripts/new-tool.sh",
      "global/skills/pdf-helper/references/usage.md"
    ];
    const staged = await adapter.stage({
      repositoryId,
      logicalPaths: managedPaths,
      expected: expected.value
    });
    if (!staged.ok) {
      throw new Error(staged.error?.message);
    }
    const commit = await adapter.commitStaged({
      repositoryId,
      message: "capture: pdf-helper edits from Claude Code",
      expected: expected.value,
      allowedManagedPaths: managedPaths
    });
    if (!commit.ok || commit.value === null) {
      throw new Error(commit.error?.message);
    }
    const pushed = await adapter.push({ repositoryId, expectedHead: commit.value.revision });
    expect(pushed.ok).toBe(true);

    const graph = await loadRepoInventory({ listFiles: listRepoFiles, readFile: readRepoFile }, hasher);
    if (!graph.ok) {
      throw new Error(graph.diagnostics.map((d) => d.message).join("; "));
    }
    const published = aggregateSkillAssets(
      graph.inventory.assets.filter((asset) => asset.kind === "skills"),
      hasher
    ).find((skill) => skill.skillName === "pdf-helper")!;

    const rendered = await codex.render("unused", [
      ...published.files.map((file) => ({
        assetKey: `global|skills|${published.skillName}/${file.relativePath}`,
        kind: "skills" as const,
        logicalName: `${published.skillName}/${file.relativePath}`,
        content: file.content
      }))
    ]);
    if (rendered.output === null) {
      throw new Error("codex render failed");
    }
    const codexApplied = await applyRenderedTargets({
      targetRoot: env.codexRoot,
      targets: rendered.output.map((target) => ({ targetLogicalPath: target.targetLogicalPath, content: target.content })),
      firstAdoptionConfirmed: true,
      baselineDigests: {}
    });
    if (!codexApplied.ok) {
      throw new Error(codexApplied.message);
    }

    const claudeSkill = await claude.readSkill("pdf-helper");
    const codexSkill = await codex.readSkill("pdf-helper");
    expect(codexSkill?.digest).toBe(published.digest);
    expect(claudeSkill?.digest).toBe(published.digest);

    await restoreSnapshot(codexApplied.snapshot);
    expect(await codex.readSkill("pdf-helper")).toBeNull();
    expect((await claude.readSkill("pdf-helper"))?.digest).toBe(published.digest);
  }, 180_000);

  test("push failure keeps the local commit as pending publish", async () => {
    const adapter = await env.makeAdapter();
    const repositoryId = await openedRepositoryId(adapter);
    await writeFile(repoChild("global/instructions/AGENTS.md"), "# offline change\n");
    const expected = await adapter.currentExpectedRevisions(repositoryId);
    if (!expected.ok || expected.value === null) {
      throw new Error("expected revisions failed");
    }
    const staged = await adapter.stage({
      repositoryId,
      logicalPaths: ["global/instructions/AGENTS.md"],
      expected: expected.value
    });
    if (!staged.ok) {
      throw new Error(staged.error?.message);
    }
    const commit = await adapter.commitStaged({
      repositoryId,
      message: "offline skill-era commit",
      expected: expected.value,
      allowedManagedPaths: ["global/instructions/AGENTS.md"]
    });
    if (!commit.ok || commit.value === null) {
      throw new Error(commit.error?.message);
    }
    await rm(env.bareRemotePath, { recursive: true, force: true });
    const failed = await adapter.push({ repositoryId, expectedHead: commit.value.revision });
    expect(failed.ok).toBe(false);
    const status = await adapter.status(repositoryId);
    if (!status.ok || status.value === null) {
      throw new Error("status failed");
    }
    expect(status.value.pendingPublish).toBe(true);
    expect(status.value.headRevision).toBe(commit.value.revision);
  }, 120_000);
});

async function currentRepoRevision(): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const result = await exec("/usr/bin/git", ["-C", env.repoPath, "rev-parse", "HEAD"]).catch(() => null);
  return result?.stdout.trim() ?? null;
}

async function openedRepositoryId(adapter: Awaited<ReturnType<M3Environment["makeAdapter"]>>): Promise<string> {
  const opened = await adapter.open({ localPath: env.repoPath });
  if (!opened.ok || opened.value === null) {
    throw new Error(opened.error?.message ?? "open failed");
  }
  return opened.value.repositoryId;
}
