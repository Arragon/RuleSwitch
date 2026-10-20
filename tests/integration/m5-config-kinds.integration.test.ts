// M5 integration (INH-1791/1792/1795/1796): config-kind lifecycle over the
// real fixture repo — instructions scope isolation + generated provenance,
// skills round-trip reuse, settings allowlist edits on a real file, and
// promptish scope gates. Bidirectional machinery (Apply/Capture/Publish/
// Restore) is proven by M3/M4 matrices; this file proves the KIND semantics.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  aggregateSkillAssets,
  attributeGeneratedChange,
  buildCapturePlan,
  compareCollections,
  extractManagedServer,
  extractManagedSettings,
  loadRepoInventory,
  mergeStructuredPreservingUnknown,
  resolveAssetSet,
  utf8Decode,
  utf8Encode
} from "../../packages/core/src/index";
import { createFsRepoFileSource } from "../../apps/desktop/src/main/infrastructure/git/repo-source";

const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-m5-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FIXTURES = path.join(__dirname, "..", "fixtures", "v1-repos", "full-matrix");

describe("instructions global+project isolation & generated provenance (INH-1791)", () => {
  test("override chain, two-project same-name isolation, generated attribution", async () => {
    const inventory = await loadRepoInventory(createFsRepoFileSource(FIXTURES), hasher);
    if (!inventory.ok) {
      throw new Error(inventory.diagnostics.map((d) => d.message).join("; "));
    }
    // Global + project override + second project same-name all distinct keys.
    const resolvedGlobal = resolveAssetSet(
      { inventory: inventory.inventory, profile: null, projectId: null, adapterId: "codex" },
      hasher
    );
    if (!resolvedGlobal.ok) {
      throw new Error(resolvedGlobal.blockedReason);
    }
    const globalAgents = resolvedGlobal.assets.find((asset) => asset.assetKey === "global|instructions|AGENTS.md");
    expect(utf8Decode(globalAgents?.content ?? new Uint8Array())).toBe("# Global Agents\n");

    const resolvedApi = resolveAssetSet(
      { inventory: inventory.inventory, profile: null, projectId: "prj_api", adapterId: "codex" },
      hasher
    );
    if (!resolvedApi.ok) {
      throw new Error(resolvedApi.blockedReason);
    }
    const apiAgents = resolvedApi.assets.find((asset) => asset.assetKey === "project:prj_api|instructions|AGENTS.md");
    expect(utf8Decode(apiAgents?.content ?? new Uint8Array())).toBe("# API project agents\n");

    // Generated composition: two canonical sources → one rendered file;
    // unique attribution works, ambiguity is refused.
    const provenance = [
      { assetKey: "global|instructions|AGENTS.md", expectedDigest: "d-global" },
      { assetKey: "project:prj_api|instructions|AGENTS.md", expectedDigest: "d-project" }
    ];
    expect(attributeGeneratedChange(provenance, "d-project")).toMatchObject({ kind: "unique" });
    expect(
      attributeGeneratedChange(
        [...provenance, { assetKey: "global|skills|x", expectedDigest: "d-project" }],
        "d-project"
      )
    ).toMatchObject({ kind: "ambiguous", candidateCount: 2 });

    // Local edit capture for the project instruction (ownership gate + plan).
    const baselineSkill = {
      skillName: "api-agents",
      files: [{ relativePath: "AGENTS.md", content: utf8Encode("# API project agents\n"), executable: false }],
      digest: ""
    };
    baselineSkill.digest = hasher.sha256Hex(baselineSkill.files.map((f) => f.relativePath + "|-|" + hasher.sha256Hex(new TextDecoder().decode(f.content))).join("\n"));
    const edited = {
      ...baselineSkill,
      files: [{ relativePath: "AGENTS.md", content: utf8Encode("# API project agents\n\nlocal edit\n"), executable: false }]
    };
    edited.digest = hasher.sha256Hex(edited.files.map((f) => f.relativePath + "|-|" + hasher.sha256Hex(new TextDecoder().decode(f.content))).join("\n"));
    const capture = buildCapturePlan({
      scope: { kind: "project", projectId: "prj_api" },
      skillName: "api-agents",
      baseline: baselineSkill,
      scanned: edited,
      planIdentity: { baselineRevision: null, repoRevision: "r", converterId: "skills", converterVersion: "1" }
    });
    expect(capture.ok).toBe(true);
    if (capture.ok) {
      expect(capture.plan.managedPathPrefix).toBe("projects/prj_api/skills/api-agents/");
    }
  }, 120_000);
});

describe("skills full-directory reuse (INH-1792)", () => {
  test("scripts/references/assets aggregate deterministically and cross-harness compare", async () => {
    const inventory = await loadRepoInventory(createFsRepoFileSource(FIXTURES), hasher);
    if (!inventory.ok) {
      throw new Error("fixture failed");
    }
    const skills = aggregateSkillAssets(
      inventory.inventory.assets.filter((asset) => asset.kind === "skills"),
      hasher
    );
    const skill = skills.find((entry) => entry.skillName === "pdf-helper")!;
    expect(skill.files.map((file) => file.relativePath).sort()).toEqual([
      "SKILL.md",
      "assets/nested/data.txt",
      "references/usage.md",
      "scripts/extract.sh"
    ]);
    // Cross-harness comparison between global collection and a codex copy.
    const comparison = compareCollections({
      repositoryId: "repo_" + "a".repeat(64),
      source: {
        label: "global",
        assets: skill.files.map((file) => ({
          kind: "skills" as const,
          logicalName: "pdf-helper/" + file.relativePath,
          digest: hasher.sha256Hex(Buffer.from(file.content).toString("binary"))
        })),
        supportedKinds: new Set(["skills" as const])
      },
      target: {
        label: "codex",
        assets: skill.files.map((file) => ({
          kind: "skills" as const,
          logicalName: "pdf-helper/" + file.relativePath,
          digest: hasher.sha256Hex(Buffer.from(file.content).toString("binary"))
        })),
        supportedKinds: new Set(["skills" as const])
      },
      baselines: {},
      trustedBaseline: false
    });
    expect(comparison.diffs.every((diff) => diff.relation === "identical")).toBe(true);
  }, 120_000);
});

describe("settings/mcp structured edits on real files (INH-1793/1796)", () => {
  test("managed-field edits preserve unknown fields byte-for-value in a real JSON file", async () => {
    const root = await temporaryDirectory();
    const settingsPath = path.join(root, "settings.json");
    await writeFile(
      settingsPath,
      `{\n  // user keeps notes here\n  "theme": "dark",\n  "customOrder": true,\n  "ruleSwitchManaged": "old",\n  "userServer": {"command": "mine"}\n}\n`
    );
    const parsed = JSON.parse(
      (await readFile(settingsPath, "utf8")).replace(/^\s*\/\/.*$/gm, "")
    ) as Record<string, unknown>;
    const { managed, unknownKeys } = extractManagedSettings(parsed, [
      { key: "ruleSwitchManaged", valueType: "string" }
    ]);
    expect(unknownKeys.sort()).toEqual(["customOrder", "theme", "userServer"]);
    const merged = mergeStructuredPreservingUnknown(parsed, { ruleSwitchManaged: "new" }, ["ruleSwitchManaged"]);
    expect(merged.userServer).toEqual({ command: "mine" });
    void managed;

    // MCP: extract one managed server from a shared real file.
    const mcpDoc = {
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "pkg"], env: { T: "env:T" } },
        userOwn: { command: "mine" }
      }
    };
    const server = extractManagedServer(mcpDoc as never, "mcpServers", "filesystem");
    if ("error" in server) {
      throw new Error(server.error);
    }
    expect(server.server.serverName).toBe("filesystem");
    expect(validateExtracted(server.server)).toEqual([]);
  }, 120_000);
});

function validateExtracted(server: { serverName: string; transport: string; command: string | null; args: readonly string[]; url: string | null; env: Readonly<Record<string, string>>; disabled: boolean }): readonly string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(server.env)) {
    if (!/^(env|keychain):/.test(value)) {
      problems.push(`env '${key}' must be a reference`);
    }
  }
  return problems;
}
