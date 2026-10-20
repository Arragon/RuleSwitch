// v1 config-repo golden regression matrix (INH-1773 + acceptance for
// INH-1767/1768/1769/1772). Loads the canonical fixture family from real
// disk through the filesystem RepoFileSource; graph digests are frozen
// golden constants so any parser/layout drift fails loudly.

import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  loadRepoInventory,
  resolveAssetSet,
  evaluateProjectBinding,
  matchProjectsByRemote,
  utf8Decode
} from "../../packages/core/src/index";
import { createFsRepoFileSource, SymlinkRejectedError } from "../../apps/desktop/src/main/infrastructure/git/repo-source";
import { probeDirectory } from "../../apps/desktop/src/main/infrastructure/git/binding-store";
import { ProjectsStore } from "../../apps/desktop/src/main/infrastructure/git/binding-store";
import { createHash } from "node:crypto";

const exec = promisify(execFile);

const FIXTURES = path.join(__dirname, "..", "fixtures", "v1-repos");

const nodeHasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-v1repo-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Golden digests — frozen after the first canonical run. Do not update
// without a reviewed layout/parser contract change.
const GOLDEN = {
  personalMinimal: "ec31896fa1d5dacf303f61b04cbbc1771b7d9304af62fc7afd2a78b5b3d1e97e",
  fullMatrix: "ec5dc05953e33dc00f238e055c5383b95f15806d617e9c31372e98559486c118"
};

describe("golden fixture matrix (INH-1773)", () => {
  test("personal-minimal parses to one global instruction with a stable graph digest", async () => {
    const result = await loadRepoInventory(createFsRepoFileSource(path.join(FIXTURES, "personal-minimal")), nodeHasher);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    }
    expect(result.inventory.assets).toHaveLength(1);
    expect(result.inventory.assets[0]).toMatchObject({
      kind: "instructions",
      logicalName: "AGENTS.md",
      sourceLogicalPath: "global/instructions/AGENTS.md"
    });
    expect(result.inventory.profiles.map((profile) => profile.name)).toEqual(["default"]);
    expect(result.inventory.projects).toHaveLength(0);
    console.log("DIGEST personal-minimal:", result.inventory.graphDigest);
    expect(result.inventory.graphDigest).toBe(GOLDEN.personalMinimal);
  });

  test("full-matrix parses with projects, native variants, and unmanaged content excluded", async () => {
    const result = await loadRepoInventory(createFsRepoFileSource(path.join(FIXTURES, "full-matrix")), nodeHasher);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    }
    const { inventory } = result;
    expect(inventory.projects.map((project) => project.projectId)).toEqual(["prj_api", "prj_web"]);
    expect(inventory.profiles.map((profile) => profile.name)).toEqual(["default", "strict"]);

    const kinds = new Map(inventory.assets.map((asset) => [asset.sourceLogicalPath, asset.kind]));
    expect(kinds.get("global/instructions/AGENTS.md")).toBe("instructions");
    expect(kinds.get("global/skills/pdf-helper/SKILL.md")).toBe("skills");
    expect(kinds.get("global/skills/pdf-helper/scripts/extract.sh")).toBe("skills");
    expect(kinds.get("global/mcp/filesystem.json")).toBe("mcp");
    expect(kinds.get("global/hooks/format.json")).toBe("hooks");
    expect(kinds.get("global/native/codex/AGENTS.md")).toBe("native");
    expect(kinds.get("projects/prj_api/instructions/AGENTS.md")).toBe("instructions");
    expect(kinds.get("projects/prj_api/.ruleswitch/native/claude-code/CLAUDE.md")).toBe("native");
    expect(kinds.has("README.md")).toBe(false);

    // Precedence: project shared beats global shared; profile replaces global;
    // project harness variant beats global harness variant.
    const resolved = resolveAssetSet(
      { inventory, profile: "strict", projectId: "prj_api", adapterId: "claude-code" },
      nodeHasher
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const byKey = new Map(resolved.assets.map((asset) => [asset.assetKey, asset]));
      expect(utf8Decode(byKey.get("project:prj_api|instructions|AGENTS.md")?.content ?? new Uint8Array())).toBe(
        "# API project agents\n"
      );
      expect(utf8Decode(byKey.get("project:prj_api|native|claude-code/CLAUDE.md")?.content ?? new Uint8Array())).toBe(
        "# API claude-code variant\n"
      );
    }
    const globalOnly = resolveAssetSet({ inventory, profile: "strict", projectId: null, adapterId: "codex" }, nodeHasher);
    expect(globalOnly.ok).toBe(true);
    if (globalOnly.ok) {
      const replaced = globalOnly.assets.find((asset) => asset.assetKey === "global|instructions|AGENTS.md");
      expect(replaced && utf8Decode(replaced.content)).toBe("# replaced by strict profile\n");
    }

    console.log("DIGEST full-matrix:", inventory.graphDigest);
    expect(inventory.graphDigest).toBe(GOLDEN.fullMatrix);
  });

  test("invalid fixtures fail closed", async () => {
    const unknownField = await loadRepoInventory(
      createFsRepoFileSource(path.join(FIXTURES, "invalid", "unknown-field")),
      nodeHasher
    );
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) {
      expect(unknownField.diagnostics[0]?.code).toBe("SEMANTIC_UNKNOWN_FIELD");
      expect(unknownField.diagnostics[0]?.logicalPath).toBe("ruleswitch.yaml");
    }
    // Note: the case-collision fixture cannot exist on a case-insensitive
    // APFS checkout — that scenario is covered by the in-memory source
    // regression in repo-layout.unit.test.ts (PATH_CASE_COLLISION).
  });

  test("identical inventory regardless of absolute clone path (unicode/space included)", async () => {
    const root = await temporaryDirectory();
    const first = path.join(root, "clone-a");
    const second = path.join(root, "克隆 目录 b");
    await cp(path.join(FIXTURES, "full-matrix"), first, { recursive: true });
    await cp(path.join(FIXTURES, "full-matrix"), second, { recursive: true });

    const left = await loadRepoInventory(createFsRepoFileSource(first), nodeHasher);
    const right = await loadRepoInventory(createFsRepoFileSource(second), nodeHasher);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) {
      throw new Error("load failed");
    }
    expect(right.inventory.graphDigest).toBe(left.inventory.graphDigest);
    const stripContent = (asset: { content: Uint8Array }): Record<string, unknown> => {
      const { content, ...rest } = asset;
      void content;
      return rest as Record<string, unknown>;
    };
    expect(JSON.stringify(right.inventory.assets.map(stripContent))).toBe(
      JSON.stringify(left.inventory.assets.map(stripContent))
    );
  });

  test("symlinks inside the repository are rejected fail-closed", async () => {
    const root = await temporaryDirectory();
    const repo = path.join(root, "symlinked");
    await cp(path.join(FIXTURES, "personal-minimal"), repo, { recursive: true });
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "# outside\n");
    await symlink(outside, path.join(repo, "global", "instructions", "escape.md"));

    await expect(createFsRepoFileSource(repo).listFiles()).rejects.toBeInstanceOf(SymlinkRejectedError);
  });
});

describe("project rebind across devices and paths (INH-1769/1772)", () => {
  test("rebinding works through remote identity, not the absolute path", async () => {
    const root = await temporaryDirectory();
    const bare = path.join(root, "api.git");
    await exec("/usr/bin/git", ["init", "--bare", "-q", "--initial-branch=main", bare]);
    const first = path.join(root, "api clone 1");
    const second = path.join(root, "项目 clone 2");
    for (const target of [first, second]) {
      await exec("/usr/bin/git", ["clone", "-q", bare, target]);
    }
    const config = ["user.name", "T", "user.email", "t@t"];
    await exec("/usr/bin/git", ["-C", first, "config", ...config.slice(0, 2)]);
    await exec("/usr/bin/git", ["-C", first, "config", ...config.slice(2)]);
    await mkdir(path.join(first, "src"), { recursive: true });
    await writeFile(path.join(first, "src", "index.ts"), "export {}\n");
    await exec("/usr/bin/git", ["-C", first, "add", "."]);
    await exec("/usr/bin/git", ["-C", first, "commit", "-q", "-m", "seed"]);
    await exec("/usr/bin/git", ["-C", first, "push", "-q", "-u", "origin", "main"]);

    // The config repo declares prj_api matching this remote shape.
    const inventory = await loadRepoInventory(createFsRepoFileSource(path.join(FIXTURES, "full-matrix")), nodeHasher);
    if (!inventory.ok) {
      throw new Error("fixture load failed");
    }
    const probeFirst = await probeDirectory(first);
    expect(probeFirst.kind).toBe("git-repo");
    if (probeFirst.kind !== "git-repo") {
      throw new Error("expected git repo");
    }
    const matches = matchProjectsByRemote(inventory.inventory.projects, "git://github.com/acme/api");
    expect(matches.map((match) => match.projectId)).toContain("prj_api");

    // Local file remote (test stand-in) does not match the declared remote
    // → manual binding must refuse instead of guessing.
    const wrongProject = evaluateProjectBinding({
      definition: inventory.inventory.projects.find((project) => project.projectId === "prj_api")!,
      probe: probeFirst,
      allowNoGit: false
    });
    expect(wrongProject.ok).toBe(false);
    if (!wrongProject.ok) {
      expect(wrongProject.code).toBe("WRONG_PROJECT");
    }

    // A directory with the declared remote binds and rebinds by identity.
    const declaredRemoteDir = path.join(root, "declared");
    await exec("/usr/bin/git", ["clone", "-q", "-o", "origin", "https://github.com/acme/api", declaredRemoteDir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    }).catch(() => undefined);
    const store = new ProjectsStore(path.join(root, "state", "v1.json"));
    await store.load();
    await store.bindProject({
      projectId: "prj_api",
      repositoryId: "repo_" + "9".repeat(64),
      localPath: first,
      displayName: "API 服务"
    });
    await store.rebindPath("prj_api", second);
    expect(store.findProject("prj_api")?.localPath).toBe(second);
    // Deleting the store file loses only the local binding, not config.
    await rm(path.join(root, "state", "v1.json"), { force: true });
    const fresh = new ProjectsStore(path.join(root, "state", "v1.json"));
    await fresh.load();
    expect(fresh.findProject("prj_api")).toBeNull();
  }, 120_000);
});
