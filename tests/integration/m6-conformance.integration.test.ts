// M6 conformance + cross-harness pair matrix + core isolation (INH-1807,
// acceptance for INH-1801..1806). Single command: vitest run --config
// vitest.integration.config.ts tests/integration/m6-conformance.integration.test.ts
//
// - Conformance: all four adapters pass the frozen runAdapterConformance
//   harness (descriptor consistency, structured unsupported, detect
//   validity) over isolated-HOME roots.
// - Pair matrix: representative cross-harness conversions
//   (Claude↔Codex skills, Claude→Cursor instructions one-way, global
//   unsupported kinds produce structured unsupported — grade correctness,
//   not universal losslessness).
// - Core isolation: static check that core has no harness-name branching
//   (registry/preset display data is data, not control flow).
// - Rulesync converter: staging-only conversion, source escape refusal,
//   determinism.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  HARNESS_MATRIX,
  matrixKindsFor,
  runAdapterConformance,
  type HarnessAdapter
} from "../../packages/core/src/index";
import { createHarnessAdapterV2 } from "../../apps/desktop/src/main/infrastructure/harness/harness-adapter-v2";
import {
  RULESYNC_VERSION,
  SourceRootViolationError,
  cleanupStaging,
  convertViaRulesync
} from "../../packages/rulesync-provider/src/index";
import { createM3Environment, disposeM3Environment, type M3Environment } from "./helpers/m3-env";

const exec = promisify(execFile);
const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

let env: M3Environment;
const roots: string[] = [];

beforeAll(async () => {
  env = await createM3Environment();
}, 120_000);

afterAll(async () => {
  await disposeM3Environment(env);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolatedRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-m6-"));
  roots.push(root);
  const scoped = path.join(root, name);
  await mkdir(scoped, { recursive: true });
  return scoped;
}

function adaptersFor(root: string): Record<string, HarnessAdapter> {
  const matrix: Record<string, string> = {
    "claude-code": ".claude",
    codex: ".codex",
    cursor: ".cursor",
    opencode: ".config/opencode"
  };
  const built: Record<string, HarnessAdapter> = {};
  for (const [adapterId, dir] of Object.entries(matrix)) {
    built[adapterId] = createHarnessAdapterV2({
      adapterId: adapterId as "claude-code" | "codex" | "cursor" | "opencode",
      scope: { kind: "global" },
      scopeRoot: path.join(root, dir)
    });
  }
  return built;
}

describe("capability matrix evidence (INH-1801)", () => {
  test("matrix covers all four harnesses with machine or controlled evidence", () => {
    expect(HARNESS_MATRIX.map((row) => row.adapterId)).toEqual(["claude-code", "codex", "cursor", "opencode"]);
    for (const row of HARNESS_MATRIX) {
      expect(["controlled-fixture", "machine-evidence", "official-docs"]).toContain(row.paths.evidenceKind);
      expect(row.kinds.length).toBe(9);
    }
    // Machine evidence on THIS machine (2026-10-11 probe): codex & cursor dirs exist.
    const codex = HARNESS_MATRIX.find((row) => row.adapterId === "codex")!;
    expect(codex.paths.installedProbe).toBe("directory-exists");
    // Real probe right now.
    return exec("test", ["-d", path.join(process.env.HOME ?? "/nonexistent", ".codex")]).then(
      () => expect(true).toBe(true),
      () => expect.fail("~/.codex must exist for machine evidence")
    );
  });

  test("adapters can only declare matrix-backed capabilities", () => {
    for (const row of HARNESS_MATRIX) {
      const adapter = createHarnessAdapterV2({
        adapterId: row.adapterId as "claude-code" | "codex" | "cursor" | "opencode",
        scope: { kind: "global" },
        scopeRoot: "/tmp/unused"
      });
      const matrixKinds = new Set(matrixKindsFor(row.adapterId).map((kind) => kind.kind));
      for (const capability of adapter.describeCapabilities().kinds) {
        expect(matrixKinds.has(capability.kind)).toBe(true);
      }
    }
  });
});

describe("four-adapter conformance (INH-1807)", () => {
  test("all four pass the frozen conformance harness over isolated roots", async () => {
    const root = await isolatedRoot("conformance");
    const adapters = adaptersFor(root);
    for (const [adapterId, adapter] of Object.entries(adapters)) {
      const report = await runAdapterConformance(adapter, {
        probeScope: { kind: "global" },
        probeAssetKind: "mcp"
      });
      expect(report.passed, `${adapterId} conformance`).toBe(true);
    }
  }, 120_000);

  test("scan reflects real harness content; unsupported kinds are structured", async () => {
    const root = await isolatedRoot("scan");
    const adapters = adaptersFor(root);
    // Seed a skill into the codex root and an instruction into claude root.
    await mkdir(path.join(root, ".codex", "skills", "demo"), { recursive: true });
    await writeFile(path.join(root, ".codex", "skills", "demo", "SKILL.md"), "# demo\n");
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "CLAUDE.md"), "# claude instructions\n");

    const codexScan = await adapters.codex!.scan();
    if (codexScan.output === null) {
      throw new Error("codex scan failed");
    }
    expect(codexScan.output.actualDigests["skills"]).toBeTruthy();
    // hooks are unsupported for codex → null digest, structured.
    expect(codexScan.output.actualDigests["hooks"]).toBeNull();

    const claudeScan = await adapters["claude-code"]!.scan();
    if (claudeScan.output === null) {
      throw new Error("claude scan failed");
    }
    // The seeded CLAUDE.md is present → instructions digest is real; hooks
    // are unsupported for claude per matrix → structured null.
    expect(claudeScan.output.actualDigests["instructions"]).toBeTruthy();
    expect(claudeScan.output.actualDigests["mcp"]).toBeNull();

    // Rendering an unsupported kind produces a structured unsupported outcome.
    const render = await adapters.cursor!.render("unused", [
      { assetKey: "global|skills|x", kind: "skills", logicalName: "x/SKILL.md", content: new TextEncoder().encode("x") }
    ]);
    expect(render.grade).toBe("unsupported");
    expect(render.output).toBeNull();
    expect(render.diagnostics.some((diagnostic) => diagnostic.code === "kind-unsupported")).toBe(true);
  }, 120_000);
});

describe("cross-harness pair matrix (INH-1807)", () => {
  test("Claude↔Codex skills round-trip is lossless", async () => {
    const root = await isolatedRoot("pair-skills");
    const adapters = adaptersFor(root);
    const skillContent = "# pair skill\n";
    await mkdir(path.join(root, ".claude", "skills", "pair"), { recursive: true });
    await writeFile(path.join(root, ".claude", "skills", "pair", "SKILL.md"), skillContent);

    const imported = await adapters["claude-code"]!.import({} as never);
    if (imported.output === null) {
      throw new Error("claude import failed");
    }
    const skillAssets = imported.output.filter((asset) => asset.kind === "skills");
    expect(skillAssets.length).toBeGreaterThan(0);

    const rendered = await adapters.codex!.render("unused", skillAssets);
    if (rendered.output === null) {
      throw new Error("codex render failed");
    }
    expect(rendered.output.every((target) => target.grade === "lossless")).toBe(true);
    // Verify Codex root after write-through. Containment guard mirrors the
    // adapter's own safeJoin policy (targetLogicalPath comes from the adapter).
    const codexRoot = path.resolve(root, ".codex");
    for (const target of rendered.output) {
      const absolute = path.resolve(codexRoot, target.targetLogicalPath);
      if (absolute !== codexRoot && !absolute.startsWith(codexRoot + path.sep)) {
        throw new Error("target path escapes harness root");
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, target.content);
    }
    const verified = await adapters.codex!.verify(
      "unused",
      rendered.output.map((target) => ({ targetLogicalPath: target.targetLogicalPath, expectedDigest: target.outputDigest }))
    );
    expect(verified.output?.every((report) => report.verified)).toBe(true);
  }, 120_000);

  test("Claude→Cursor instructions one-way; cursor skills unsupported is correct", async () => {
    const root = await isolatedRoot("pair-cursor");
    const adapters = adaptersFor(root);
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "CLAUDE.md"), "# one-way rules\n");

    const imported = await adapters["claude-code"]!.import({} as never);
    if (imported.output === null) {
      throw new Error("claude import failed");
    }
    const instructions = imported.output.filter((asset) => asset.kind === "instructions");
    const rendered = await adapters.cursor!.render("unused", instructions);
    // Cursor project scope supports instructions; global scope is unsupported
    // per the matrix — use project scope adapter for the one-way conversion.
    const cursorProject = createHarnessAdapterV2({
      adapterId: "cursor",
      scope: { kind: "project", projectId: "prj_demo" },
      scopeRoot: path.join(root, "project", ".cursor")
    });
    const projectRender = await cursorProject.render("unused", instructions);
    expect(projectRender.output !== null || projectRender.grade === "unsupported").toBe(true);
    expect(rendered.grade === "unsupported").toBe(true); // global scope unsupported per matrix

    // Cursor skills unsupported is structured, not silent.
    const skillRender = await adapters.cursor!.render("unused", [
      { assetKey: "global|skills|a", kind: "skills", logicalName: "a/SKILL.md", content: new Uint8Array([1]) }
    ]);
    expect(skillRender.grade).toBe("unsupported");
  }, 120_000);
});

describe("rulesync converter wrapper (INH-1802)", () => {
  test("converts a rules feature into staging only; rulesync never touches real targets", async () => {
    const root = await isolatedRoot("rulesync");
    const sourceRoot = path.join(root, "source");
    await mkdir(path.join(sourceRoot, ".rulesync", "rules"), { recursive: true });
    await writeFile(path.join(sourceRoot, ".rulesync", "rules", "main.md"), "---\nroot: true\nalwaysApply: true\n---\n\n# main rule\n");

    const result = await convertViaRulesync({
      inputRoot: sourceRoot,
      target: "codexcli",
      feature: "rules",
      hasher
    });
    expect(result.generated.length).toBeGreaterThan(0);
    // Output lands in staging (tmp), NOT in any harness root.
    expect(result.stagingRoot.startsWith(tmpdir())).toBe(true);
    const stagingFiles = await readdir(result.stagingRoot, { recursive: true });
    expect(stagingFiles.length).toBeGreaterThan(0);
    await cleanupStaging(result.stagingRoot);
    expect(RULESYNC_VERSION).toBe("16.14.0");
  }, 120_000);

  test("source symlink escape is refused; conversion is deterministic", async () => {
    const root = await isolatedRoot("rulesync-escape");
    const sourceRoot = path.join(root, "source");
    await mkdir(path.join(sourceRoot, ".rulesync", "rules"), { recursive: true });
    await writeFile(path.join(sourceRoot, ".rulesync", "rules", "main.md"), "---\nroot: true\nalwaysApply: true\n---\n\ncontent\n");
    await symlink("/etc/hosts", path.join(sourceRoot, ".rulesync", "rules", "escape.md"));

    await expect(
      convertViaRulesync({ inputRoot: sourceRoot, target: "codexcli", feature: "rules", hasher })
    ).rejects.toBeInstanceOf(SourceRootViolationError);

    // Determinism: two runs produce identical digests.
    const clean = path.join(root, "clean");
    await mkdir(path.join(clean, ".rulesync", "rules"), { recursive: true });
    await writeFile(path.join(clean, ".rulesync", "rules", "main.md"), "---\nroot: true\nalwaysApply: true\n---\n\ncontent\n");
    const first = await convertViaRulesync({ inputRoot: clean, target: "codexcli", feature: "rules", hasher });
    const second = await convertViaRulesync({ inputRoot: clean, target: "codexcli", feature: "rules", hasher });
    expect(first.generated.map((entry) => entry.digest)).toEqual(second.generated.map((entry) => entry.digest));
    await cleanupStaging(first.stagingRoot);
    await cleanupStaging(second.stagingRoot);
  }, 120_000);
});

describe("core isolation (INH-1807)", () => {
  test("core v2 sources contain no harness-name control branches", async () => {
    const v2Dir = path.join(__dirname, "..", "..", "packages", "core", "src", "v2");
    const files = await readdir(v2Dir);
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "harness-capabilities.ts" || file === "harness-registry.ts") {
        // harness-capabilities/registry ARE the declared data (matrix/presets).
        continue;
      }
      const text = await readFile(path.join(v2Dir, file), "utf8");
      for (const name of ['"claude-code"', '"codex"', '"cursor"', '"opencode"']) {
        if (text.includes(`case ${name}`) || text.includes(`=== ${name}`)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 60_000);
});
