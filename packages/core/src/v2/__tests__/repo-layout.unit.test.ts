import { describe, expect, it } from "vitest";

import { utf8Encode } from "../utf8";
import type { RepoFileSource } from "../repo-layout";
import { loadRepoInventory } from "../repo-layout";
import { testHasher } from "./test-hasher";

function sourceOf(files: Record<string, string>, shuffled = false): RepoFileSource {
  const names = Object.keys(files);
  const ordered = shuffled ? [...names].reverse() : names;
  return {
    listFiles: async () => ordered,
    readFile: async (logicalPath) => (logicalPath in files ? utf8Encode(files[logicalPath] ?? "") : null)
  };
}

const BASE_MANIFEST = "schemaVersion: 1\n";
const PROJECT_YAML = [
  "projectId: prj_demo",
  "displayName: Demo 项目",
  "gitRemotes:",
  "  - git://github.com/acme/api"
].join("\n");

describe("repo layout loader (INH-1767)", () => {
  it("builds a deterministic inventory independent of listing order", async () => {
    const files: Record<string, string> = {
      "ruleswitch.yaml": BASE_MANIFEST,
      "global/instructions/AGENTS.md": "# global\n",
      "global/skills/python/SKILL.md": "# skill\n",
      "global/native/codex/config.toml": "native = true\n",
      "global/mcp/servers.json": "{}",
      "profiles/default.yaml": "description: 主配置\n",
      "profiles/work.yaml": "description: work\n",
      "projects/prj_demo/project.yaml": PROJECT_YAML,
      "projects/prj_demo/instructions/AGENTS.md": "# project\n",
      "projects/prj_demo/.ruleswitch/native/claude-code/settings.json": "{}",
      ".ruleswitch/cache.bin": "internal",
      "README.md": "ignored"
    };
    const first = await loadRepoInventory(sourceOf(files, false), testHasher);
    const second = await loadRepoInventory(sourceOf(files, true), testHasher);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("inventory failed");
    }
    expect(first.inventory.graphDigest).toBe(second.inventory.graphDigest);
    expect(first.inventory.assets.map((asset) => asset.sourceLogicalPath)).toEqual(
      second.inventory.assets.map((asset) => asset.sourceLogicalPath)
    );

    const byPath = new Map(first.inventory.assets.map((asset) => [asset.sourceLogicalPath, asset]));
    expect(byPath.get("global/instructions/AGENTS.md")).toMatchObject({
      kind: "instructions",
      logicalName: "AGENTS.md",
      scope: { kind: "global" }
    });
    expect(byPath.get("global/native/codex/config.toml")).toMatchObject({
      kind: "native",
      logicalName: "codex/config.toml"
    });
    expect(byPath.get("projects/prj_demo/instructions/AGENTS.md")).toMatchObject({
      kind: "instructions",
      logicalName: "AGENTS.md",
      scope: { kind: "project", projectId: "prj_demo" }
    });
    expect(byPath.get("projects/prj_demo/.ruleswitch/native/claude-code/settings.json")).toMatchObject({
      kind: "native",
      logicalName: "claude-code/settings.json",
      scope: { kind: "project", projectId: "prj_demo" }
    });
    // Same logical name in global and project scopes is legal (distinct keys).
    expect(
      first.inventory.assets.filter((asset) => asset.kind === "instructions" && asset.logicalName === "AGENTS.md")
    ).toHaveLength(2);
    // Tool metadata and unmanaged content never become assets.
    expect([...byPath.keys()].some((path) => path.startsWith(".ruleswitch/") && !path.includes("native"))).toBe(false);
    expect(byPath.has("README.md")).toBe(false);

    expect(first.inventory.projects[0]).toMatchObject({
      projectId: "prj_demo",
      displayName: "Demo 项目",
      remoteMatch: ["git://github.com/acme/api"]
    });
    expect(first.inventory.profiles.map((profile) => profile.name)).toEqual(["default", "work"]);
  });

  it("fails closed when the manifest is missing or invalid", async () => {
    const missing = await loadRepoInventory(sourceOf({ "global/instructions/A.md": "x" }), testHasher);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.diagnostics[0]?.code).toBe("MANIFEST_MISSING");
    }

    const invalid = await loadRepoInventory(
      sourceOf({ "ruleswitch.yaml": "schemaVersion: 1\nunknownField: 1\n" }),
      testHasher
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.diagnostics[0]?.code).toBe("SEMANTIC_UNKNOWN_FIELD");
    }
  });

  it("rejects unsafe paths, NFC duplicates, and case collisions", async () => {
    const traversal = await loadRepoInventory(
      sourceOf({ "ruleswitch.yaml": BASE_MANIFEST, "global/../escape.md": "x" }),
      testHasher
    );
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) {
      expect(traversal.diagnostics[0]?.code).toBe("PATH_UNSAFE");
    }

    const nfc = await loadRepoInventory(
      sourceOf({ "ruleswitch.yaml": BASE_MANIFEST, "global/instructions/em\u0065\u0301.md": "x" }),
      testHasher
    );
    expect(nfc.ok).toBe(false);
    if (!nfc.ok) {
      expect(nfc.diagnostics[0]?.code).toBe("PATH_NOT_NFC");
    }

    const collision = await loadRepoInventory(
      sourceOf({
        "ruleswitch.yaml": BASE_MANIFEST,
        "global/instructions/AGENTS.md": "a",
        "global/instructions/agents.md": "b"
      }),
      testHasher
    );
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.diagnostics.some((diagnostic) => diagnostic.code === "PATH_CASE_COLLISION")).toBe(true);
    }
  });

  it("rejects unknown kind directories and orphan project assets", async () => {
    const unknownKind = await loadRepoInventory(
      sourceOf({ "ruleswitch.yaml": BASE_MANIFEST, "global/unknown-kind/x.md": "x" }),
      testHasher
    );
    expect(unknownKind.ok).toBe(false);
    if (!unknownKind.ok) {
      expect(unknownKind.diagnostics[0]?.code).toBe("KIND_UNKNOWN");
    }

    const orphan = await loadRepoInventory(
      sourceOf({ "ruleswitch.yaml": BASE_MANIFEST, "projects/prj_ghost/instructions/A.md": "x" }),
      testHasher
    );
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) {
      expect(orphan.diagnostics[0]?.code).toBe("PROJECT_MISSING_DEFINITION");
    }
  });

  it("rejects invalid project.yaml (id mismatch, bad remote pattern, syntax)", async () => {
    const mismatch = await loadRepoInventory(
      sourceOf({
        "ruleswitch.yaml": BASE_MANIFEST,
        "projects/prj_demo/project.yaml": "projectId: prj_other\ndisplayName: X\n"
      }),
      testHasher
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.diagnostics[0]?.code).toBe("PROJECT_ID_MISMATCH");
    }

    const badRemote = await loadRepoInventory(
      sourceOf({
        "ruleswitch.yaml": BASE_MANIFEST,
        "projects/prj_demo/project.yaml": "projectId: prj_demo\ndisplayName: X\ngitRemotes:\n  - ../escape\n"
      }),
      testHasher
    );
    expect(badRemote.ok).toBe(false);
    if (!badRemote.ok) {
      expect(badRemote.diagnostics[0]?.code).toBe("PROJECT_MATCH_INVALID");
    }

    const badSyntax = await loadRepoInventory(
      sourceOf({
        "ruleswitch.yaml": BASE_MANIFEST,
        "projects/prj_demo/project.yaml": "projectId: prj_demo\nbroken [\n"
      }),
      testHasher
    );
    expect(badSyntax.ok).toBe(false);
    if (!badSyntax.ok) {
      expect(badSyntax.diagnostics[0]?.code).toBe("PROJECT_YAML_SYNTAX");
    }
  });
});

describe("asset graph determinism (INH-1768)", () => {
  it("derives identical graph digests for identical content and no absolute paths", async () => {
    const files: Record<string, string> = {
      "ruleswitch.yaml": BASE_MANIFEST,
      "global/instructions/AGENTS.md": "# same\n",
      "projects/prj_demo/project.yaml": PROJECT_YAML
    };
    const first = await loadRepoInventory(sourceOf(files), testHasher);
    const second = await loadRepoInventory(sourceOf(files), testHasher);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("failed");
    }
    expect(first.inventory.graphDigest).toBe(second.inventory.graphDigest);
    const serialized = JSON.stringify(first.inventory.assets);
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);
    expect(first.inventory.assets.every((asset) => asset.logicalName === asset.logicalName.normalize("NFC"))).toBe(
      true
    );
  });

  it("changes the graph digest when any asset content changes", async () => {
    const base: Record<string, string> = {
      "ruleswitch.yaml": BASE_MANIFEST,
      "global/instructions/AGENTS.md": "# v1\n"
    };
    const changed = { ...base, "global/instructions/AGENTS.md": "# v2\n" };
    const first = await loadRepoInventory(sourceOf(base), testHasher);
    const second = await loadRepoInventory(sourceOf(changed), testHasher);
    if (!first.ok || !second.ok) {
      throw new Error("failed");
    }
    expect(first.inventory.graphDigest).not.toBe(second.inventory.graphDigest);
  });
});
