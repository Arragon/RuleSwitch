import { describe, expect, it } from "vitest";

import { resolveAssetSet } from "../profiles";
import type { RepoInventory } from "../repo-layout";
import { loadRepoInventory } from "../repo-layout";
import { utf8Decode, utf8Encode } from "../utf8";
import { testHasher } from "./test-hasher";

async function inventory(files: Record<string, string>): Promise<RepoInventory> {
  const result = await loadRepoInventory(
    {
      listFiles: async () => Object.keys(files).sort(),
      readFile: async (path) => (path in files ? utf8Encode(files[path] ?? "") : null)
    },
    testHasher
  );
  if (!result.ok) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  }
  return result.inventory;
}

const FILES = {
  "ruleswitch.yaml": "schemaVersion: 1\ndefaults:\n  profile: default\n",
  "global/instructions/AGENTS.md": "# global agents\n",
  "global/native/codex/AGENTS.md": "# codex variant\n",
  "global/native/claude-code/CLAUDE.md": "# claude variant\n",
  "projects/prj_demo/project.yaml": "projectId: prj_demo\ndisplayName: Demo\n",
  "projects/prj_demo/instructions/AGENTS.md": "# project agents\n",
  "projects/prj_demo/.ruleswitch/native/codex/AGENTS.md": "# project codex\n",
  "profiles/default.yaml": "description: base\n",
  "profiles/strict.yaml": "description: strict\nreplacements:\n  instructions/AGENTS.md: \"# replaced by profile\"\n"
};

describe("precedence resolver (INH-1770)", () => {
  it("composes layers in the frozen order with provenance", async () => {
    const graph = await inventory(FILES);
    const result = resolveAssetSet(
      { inventory: graph, profile: null, projectId: "prj_demo", adapterId: "codex" },
      testHasher
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.blockedReason);
    }
    const byKey = new Map(result.assets.map((asset) => [asset.assetKey, asset]));
    // Project shared overrides global shared for the same semantic key; the
    // winning asset carries the project-scoped serialized key.
    expect(utf8Decode(byKey.get("project:prj_demo|instructions|AGENTS.md")?.content ?? new Uint8Array())).toBe(
      "# project agents\n"
    );
    expect(byKey.has("global|instructions|AGENTS.md")).toBe(false);
    // Project harness variant wins over the global one and over shared layers.
    expect(utf8Decode(byKey.get("project:prj_demo|native|codex/AGENTS.md")?.content ?? new Uint8Array())).toBe(
      "# project codex\n"
    );
    expect(byKey.get("project:prj_demo|native|codex/AGENTS.md")?.provenance[0]?.layer).toBe("project-harness-variant");
    // Exactly one resolved asset per semantic key.
    expect(result.assets.filter((asset) => asset.logicalName === "AGENTS.md" && asset.kind === "instructions")).toHaveLength(1);
    // Other adapters' variants are excluded.
    expect([...byKey.keys()].some((key) => key.includes("claude-code"))).toBe(false);
  });

  it("applies profile replacements over global-shared content", async () => {
    const graph = await inventory(FILES);
    const result = resolveAssetSet(
      { inventory: graph, profile: "strict", projectId: null, adapterId: "codex" },
      testHasher
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.blockedReason);
    }
    const asset = result.assets.find((candidate) => candidate.assetKey === "global|instructions|AGENTS.md");
    expect(asset && utf8Decode(asset.content)).toBe("# replaced by profile");
    expect(asset?.provenance.map((entry) => entry.layer)).toContain("profile");
    // Ignored replacement (no project bound) surfaces as a note.
    expect(result.notes.join(" ")).not.toContain("has no matching asset");
  });

  it("blocks on missing profiles and projects", async () => {
    const graph = await inventory(FILES);
    const profile = resolveAssetSet(
      { inventory: graph, profile: "ghost", projectId: null, adapterId: "codex" },
      testHasher
    );
    expect(profile.ok).toBe(false);
    if (!profile.ok) {
      expect(profile.blockedReason).toContain("profile 'ghost'");
    }

    const project = resolveAssetSet(
      { inventory: graph, profile: null, projectId: "prj_missing", adapterId: "codex" },
      testHasher
    );
    expect(project.ok).toBe(false);
    if (!project.ok) {
      expect(project.blockedReason).toContain("project 'prj_missing'");
    }
  });

  it("reports unsupported harness variants as an empty layer, not a failure", async () => {
    const graph = await inventory(FILES);
    const result = resolveAssetSet(
      { inventory: graph, profile: null, projectId: "prj_demo", adapterId: "cursor" },
      testHasher
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notes.join(" ")).toContain("no native variants for adapter 'cursor'");
      expect(result.assets.every((asset) => asset.kind !== "native")).toBe(true);
    }
  });

  it("is fully deterministic for identical inputs", async () => {
    const graph = await inventory(FILES);
    const input = { inventory: graph, profile: "default", projectId: "prj_demo", adapterId: "codex" } as const;
    const first = resolveAssetSet(input, testHasher);
    const second = resolveAssetSet(input, testHasher);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
