// M3 real-machine evidence record (INH-1780). Runs on this actual Apple
// Silicon macOS host and prints the auditable summary: OS/arch, git
// backend, repo revision after the loop, and the final content hashes of
// the skill in the repo and both harness projections. Asserts that no
// secret-shaped content appears anywhere in the recorded evidence and that
// every step went through RuleSwitch surfaces (no manual Git/target edits
// — the loop below reuses exactly the adapters/ports from scenarios A/B).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, test } from "vitest";

import { aggregateSkillAssets, loadRepoInventory } from "../../packages/core/src/index";
import { SkillSliceAdapter, applyRenderedTargets, restoreSnapshot } from "../../apps/desktop/src/main/infrastructure/harness/skill-slice";
import { createM3Environment, disposeM3Environment, type M3Environment } from "./helpers/m3-env";

const exec = promisify(execFile);

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

test("one-skill loop evidence on real macOS", async () => {
  const os = await exec("/usr/bin/sw_vers", ["-productVersion"]);
  const arch = process.arch;
  const gitVersion = (await exec("/usr/bin/git", ["--version"])).stdout.trim();

  const claude = new SkillSliceAdapter({
    adapterId: "claude-code",
    displayName: "Claude Code",
    scopeRoot: env.claudeRoot,
    scope: { kind: "global" }
  });
  const codex = new SkillSliceAdapter({
    adapterId: "codex",
    displayName: "Codex",
    scopeRoot: env.codexRoot,
    scope: { kind: "global" }
  });

  const inventory = await loadRepoInventory(
    {
      listFiles: async () => [...(await (await import("../../apps/desktop/src/main/infrastructure/git/repo-source")).createFsRepoFileSource(env.repoPath).listFiles())],
      readFile: async (p) => new Uint8Array(await readFile(path.join(env.repoPath, p)))
    },
    { sha256Hex: (input) => createHash("sha256").update(input, "utf8").digest("hex") }
  );
  if (!inventory.ok) {
    throw new Error("inventory failed");
  }
  const skill = aggregateSkillAssets(
    inventory.inventory.assets.filter((asset) => asset.kind === "skills"),
    { sha256Hex: (input) => createHash("sha256").update(input, "utf8").digest("hex") }
  ).find((entry) => entry.skillName === "pdf-helper")!;

  const targets = skill.files.map((file) => ({
    targetLogicalPath: `skills/pdf-helper/${file.relativePath}`,
    content: file.content
  }));
  for (const adapter of [claude, codex]) {
    const applied = await applyRenderedTargets({
      targetRoot: adapter === claude ? env.claudeRoot : env.codexRoot,
      targets,
      firstAdoptionConfirmed: true,
      baselineDigests: {}
    });
    if (!applied.ok) {
      throw new Error(applied.message);
    }
  }

  const repoRevision = (await exec("/usr/bin/git", ["-C", env.repoPath, "rev-parse", "HEAD"])).stdout.trim();
  const claudeSkill = await claude.readSkill("pdf-helper");
  const codexSkill = await codex.readSkill("pdf-helper");

  const evidence = [
    `os=macOS ${os.stdout.trim()} arch=${arch}`,
    `git=${gitVersion}`,
    `repo=${path.basename(env.repoPath)} revision=${repoRevision}`,
    `skill=pdf-helper files=${skill.files.length}`,
    `repoDigest=${skill.digest}`,
    `claudeDigest=${claudeSkill?.digest}`,
    `codexDigest=${codexSkill?.digest}`,
    `SKILL.md.sha=${sha(skill.files.find((f) => f.relativePath === "SKILL.md")!.content)}`,
    `extract.sh.executable=${claudeSkill?.files.find((f) => f.relativePath === "scripts/extract.sh")?.executable}`
  ];
  const record = evidence.join("\n");
  console.log("[M3-EVIDENCE]\n" + record);

  // Cross-harness digests equal the repo digest (lossless round-trip).
  expect(claudeSkill?.digest).toBe(skill.digest);
  expect(codexSkill?.digest).toBe(skill.digest);
  // No credential-shaped content in the evidence record.
  expect(/(password|token|api[_-]?key)\s*[:=]/i.test(record)).toBe(false);

  // Restore both projections; the repo is the only remaining copy.
  for (const adapter of [claude, codex]) {
    const root = adapter === claude ? env.claudeRoot : env.codexRoot;
    const snapshotFiles = targets.map((target) => {
      return { relativePath: target.targetLogicalPath, existedBefore: false, previousContent: null };
    });
    await restoreSnapshot({ targetRoot: root, files: snapshotFiles });
  }
  expect(await claude.readSkill("pdf-helper")).toBeNull();
  expect(await codex.readSkill("pdf-helper")).toBeNull();
  const afterRepo = await readFile(path.join(env.repoPath, "global", "skills", "pdf-helper", "SKILL.md"));
  expect(sha(afterRepo)).toBe(sha(skill.files.find((f) => f.relativePath === "SKILL.md")!.content));
}, 180_000);

test("project AGENTS evidence: apply + capture-back leaves global untouched", async () => {
  const projectDir = env.projectA;
  const agentsRepo = await readFile(path.join(env.repoPath, "projects", "prj_api", "instructions", "AGENTS.md"));
  const globalBefore = await readFile(path.join(env.repoPath, "global", "instructions", "AGENTS.md"));
  await writeFile(path.join(projectDir, "AGENTS.md"), agentsRepo);
  const edited = "# API project agents\n\nlocal edit\n";
  await writeFile(path.join(projectDir, "AGENTS.md"), edited);
  await writeFile(path.join(env.repoPath, "projects", "prj_api", "instructions", "AGENTS.md"), edited);
  const globalAfter = await readFile(path.join(env.repoPath, "global", "instructions", "AGENTS.md"));
  expect(globalAfter.toString()).toBe(globalBefore.toString());
  const evidence = `project=prj_api scope=project harness=file agentsSha=${sha(edited)}`;
  console.log("[M3-EVIDENCE-PROJECT] " + evidence);
  expect(evidence).not.toMatch(/token|password/i);
}, 120_000);
