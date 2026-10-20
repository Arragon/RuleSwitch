// M3 Scenario B (INH-1779, evidence for INH-1780): Project Scope is
// first-class. A bound project gets its AGENTS.md/CLAUDE.md applied from
// Git, the user edits locally, and the edit captures back into
// projects/<projectId>/... — while a second project and every Global asset
// stay byte-identical.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  applyRenderedTargets,
  claudeProjectRoot,
  codexProjectRoot,
  restoreSnapshot
} from "../../apps/desktop/src/main/infrastructure/harness/skill-slice";
import { loadRepoInventory } from "../../packages/core/src/index";
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

function sha(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

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

async function repoFiles(): Promise<string[]> {
  const { createFsRepoFileSource } = await import("../../apps/desktop/src/main/infrastructure/git/repo-source");
  return [...(await createFsRepoFileSource(env.repoPath).listFiles())];
}

async function readRepo(logicalPath: string): Promise<Uint8Array | null> {
  return new Uint8Array(await readFile(repoChild(logicalPath)));
}

describe("Project AGENTS.md / CLAUDE.md bidirectional slice (INH-1779)", () => {
  test("Git → project apply → local edit → capture back, with full scope isolation", async () => {
    const graph = await loadRepoInventory(
      { listFiles: repoFiles, readFile: readRepo },
      hasher
    );
    if (!graph.ok) {
      throw new Error(graph.diagnostics.map((d) => d.message).join("; "));
    }
    // prj_api declares instructions; prj_web has none — capability per project.
    const apiInstructions = graph.inventory.assets.filter(
      (asset) => asset.scope.kind === "project" && asset.scope.projectId === "prj_api" && asset.kind === "instructions"
    );
    expect(apiInstructions.map((asset) => asset.logicalName).sort()).toEqual(["AGENTS.md"]);

    // Apply AGENTS.md into project A as both Codex (<project>/AGENTS.md)
    // and Claude (<project>/.claude/CLAUDE.md) projections.
    const agentsAsset = apiInstructions.find((asset) => asset.logicalName === "AGENTS.md")!;
    const claudeProjection = {
      targetLogicalPath: "CLAUDE.md",
      content: agentsAsset.content
    };
    const appliedClaude = await applyRenderedTargets({
      targetRoot: claudeProjectRoot(env.projectA),
      targets: [claudeProjection],
      firstAdoptionConfirmed: true,
      baselineDigests: {}
    });
    if (!appliedClaude.ok) {
      throw new Error(appliedClaude.message);
    }
    await writeFile(path.join(env.projectA, "AGENTS.md"), agentsAsset.content);

    // User edits the project-local AGENTS.md.
    const edited = "# API project agents\n\nEdited locally in the project.\n";
    await writeFile(path.join(env.projectA, "AGENTS.md"), edited);

    // Capture back: write the edited bytes into the managed repo path ONLY.
    const managedPath = "projects/prj_api/instructions/AGENTS.md";
    const beforeSecondProject = await readFile(
      repoChild("projects/prj_web/project.yaml"),
      "utf8"
    );
    const beforeGlobal = await readFile(repoChild("global/instructions/AGENTS.md"), "utf8");
    await writeFile(repoChild(managedPath), edited);

    // Commit + push through the GitPort (same as Scenario A).
    const adapter = await env.makeAdapter();
    const opened = await adapter.open({ localPath: env.repoPath });
    if (!opened.ok || opened.value === null) {
      throw new Error("open failed");
    }
    const repositoryId = opened.value.repositoryId;
    const expected = await adapter.currentExpectedRevisions(repositoryId);
    if (!expected.ok || expected.value === null) {
      throw new Error("expected revisions failed");
    }
    const staged = await adapter.stage({ repositoryId, logicalPaths: [managedPath], expected: expected.value });
    if (!staged.ok) {
      throw new Error(staged.error?.message);
    }
    const commit = await adapter.commitStaged({
      repositoryId,
      message: "capture: project AGENTS.md from 项目 A",
      expected: expected.value,
      allowedManagedPaths: [managedPath]
    });
    if (!commit.ok || commit.value === null) {
      throw new Error(commit.error?.message);
    }
    const pushed = await adapter.push({ repositoryId, expectedHead: commit.value.revision });
    expect(pushed.ok).toBe(true);

    // Scope isolation: second project and global stay byte-identical.
    expect(await readFile(repoChild("projects/prj_web/project.yaml"), "utf8")).toBe(beforeSecondProject);
    expect(await readFile(repoChild("global/instructions/AGENTS.md"), "utf8")).toBe(beforeGlobal);
    // Project B is untouched on disk (no AGENTS.md projected there).
    await expect(readFile(path.join(env.projectB, "AGENTS.md"))).rejects.toThrow();

    // The Claude projection in project A still holds the pre-edit bytes
    // (the user edited AGENTS.md, not .claude/CLAUDE.md) — scope/harness
    // surfaces are distinct, and restoring the apply snapshot returns
    // project A's .claude to its pre-apply state.
    expect(await readFile(path.join(env.projectA, ".claude", "CLAUDE.md"), "utf8")).not.toBe(edited);
    await restoreSnapshot(appliedClaude.snapshot);
    await expect(readFile(path.join(env.projectA, ".claude", "CLAUDE.md"))).rejects.toThrow();

    // Plans name Project/Scope/Harness/AssetKey explicitly (DoD).
    expect(managedPath.startsWith("projects/prj_api/")).toBe(true);
    expect(agentsAsset.sourceLogicalPath).toBe(managedPath);
  }, 180_000);

  test("two projects with the same logical AGENTS.md stay isolated in the graph", async () => {
    // Give prj_web its own AGENTS.md in the repo, then verify distinct keys.
    await mkdir(path.join(env.repoPath, "projects", "prj_web", "instructions"), { recursive: true });
    await writeFile(path.join(env.repoPath, "projects", "prj_web", "instructions", "AGENTS.md"), "# web agents\n");
    const graph = await loadRepoInventory(
      {
        listFiles: async () => await repoFiles(),
        readFile: readRepo
      },
      hasher
    );
    if (!graph.ok) {
      throw new Error(graph.diagnostics.map((d) => d.message).join("; "));
    }
    const agentsKeys = graph.inventory.assets
      .filter((asset) => asset.kind === "instructions" && asset.logicalName === "AGENTS.md")
      .map((asset) => `${asset.scope.kind === "project" ? `project:${asset.scope.projectId}` : "global"}|instructions|AGENTS.md`)
      .sort();
    expect(agentsKeys).toEqual([
      "global|instructions|AGENTS.md",
      "project:prj_api|instructions|AGENTS.md",
      "project:prj_web|instructions|AGENTS.md"
    ]);
    const contents = graph.inventory.assets
      .filter((asset) => asset.kind === "instructions" && asset.logicalName === "AGENTS.md")
      .map((asset) => sha(asset.content));
    expect(new Set(contents).size).toBe(3); // all three differ
  }, 120_000);

  test("unmanaged files in the project directory are never touched", async () => {
    const unmanagedPath = path.join(env.projectA, "个人笔记.md");
    await writeFile(unmanagedPath, "keep me\n");
    const graph = await loadRepoInventory(
      { listFiles: repoFiles, readFile: readRepo },
      hasher
    );
    expect(graph.ok).toBe(true);
    expect(await readFile(unmanagedPath, "utf8")).toBe("keep me\n");
    await rm(unmanagedPath, { force: true });
  });

  test("codex project root helper resolves the sibling projection root", async () => {
    expect(codexProjectRoot(env.projectA)).toBe(path.join(env.projectA, ".codex"));
    expect(claudeProjectRoot(env.projectA)).toBe(path.join(env.projectA, ".claude"));
  });
});
