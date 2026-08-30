import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { RulesyncProvider } from "../../packages/rulesync-provider/src/index";
import { NodeProviderInfrastructure } from "../fixtures/rulesync-provider/node-provider-infrastructure";

const FIXTURE_WORKSPACE = fileURLToPath(
  new URL("../fixtures/rulesync-provider/workspace", import.meta.url)
);
const WORKSPACE_ID = "workspace:integration";
const PROFILE_ID = "profile:integration";
const TARGET_ID = "target:codexcli";

interface TestContext {
  readonly tempRoot: string;
  readonly workspaceRoot: string;
  readonly infrastructure: NodeProviderInfrastructure;
  readonly provider: RulesyncProvider;
  readonly rootResourceId: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true })
    )
  );
});

describe("RulesyncProvider with Rulesync 16.14.0", () => {
  test("exposes the single pinned Codex rules target", () => {
    const infrastructure = new NodeProviderInfrastructure("unused");
    const provider = new RulesyncProvider(infrastructure);

    expect(provider.descriptor).toEqual({
      id: "rulesync",
      version: "16.14.0",
      targets: [
        {
          providerTarget: "codexcli",
          name: "Codex CLI",
          features: ["rules"]
        }
      ]
    });
  });

  test("detects, validates, stages, and previews a real AGENTS.md modification", async () => {
    const context = await createTestContext();
    const agentsPath = path.join(context.workspaceRoot, "AGENTS.md");
    const unknownPath = path.join(context.workspaceRoot, "unmanaged.txt");
    const agentsBefore = await readFile(agentsPath);
    const unknownBefore = await readFile(unknownPath);

    const detection = await context.provider.detect({
      workspaceId: WORKSPACE_ID,
      rootResourceId: context.rootResourceId
    });
    expect(detection.detected).toBe(true);
    if (!detection.detected) {
      throw new Error("Expected the fixture .rulesync source to be detected.");
    }
    expect(detection.sourceResources.map((resource) => resource.logicalPath)).toEqual([
      "rules/base.md"
    ]);
    const source = detection.sourceResources[0];
    if (source === undefined) {
      throw new Error("Expected a detected Markdown source.");
    }

    const validation = await context.provider.validate({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceResourceId: source.id
    });
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.sourceRevision.files).toHaveLength(1);

    const staged = await context.provider.stage({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceResourceId: source.id,
      targetId: TARGET_ID
    });
    const generatedAgents = staged.generatedResources.find(
      (resource) => resource.logicalPath === "AGENTS.md"
    );
    expect(generatedAgents).toBeDefined();
    if (generatedAgents === undefined) {
      throw new Error("Rulesync did not generate AGENTS.md in staging.");
    }

    const generatedBytes = await context.infrastructure.readResourceBytes(
      WORKSPACE_ID,
      generatedAgents.id
    );
    expect(new TextDecoder().decode(generatedBytes)).toContain("RULESWITCH_REAL_RULE");
    expect(await readFile(agentsPath)).toEqual(agentsBefore);
    expect(await readFile(unknownPath)).toEqual(unknownBefore);

    const generatedAbsolutePath = await context.infrastructure.resolveAuthorizedResourcePath(
      WORKSPACE_ID,
      generatedAgents.id
    );
    expect(isContained(context.workspaceRoot, generatedAbsolutePath)).toBe(false);

    const changeSet = await context.provider.preview({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      targetId: TARGET_ID,
      stagedOutputId: staged.id
    });
    const agentsChange = changeSet.changes.find((change) => change.logicalPath === "AGENTS.md");
    expect(agentsChange?.kind).toBe("modify");
    expect(agentsChange?.before?.hash.digest).toBe(hashBytes(agentsBefore));
    expect(agentsChange?.after?.hash.digest).toBe(generatedAgents.hash.digest);
    expect(changeSet.changes.every((change) => change.kind !== "delete")).toBe(true);
    expect(changeSet.changes.some((change) => change.logicalPath === "unmanaged.txt")).toBe(false);
    expect(context.provider.getChangeSet(changeSet.id)).toBe(changeSet);

    const cachedPreview = await context.provider.preview({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      targetId: TARGET_ID,
      stagedOutputId: staged.id
    });
    expect(cachedPreview).toBe(changeSet);

    const stagedAgain = await context.provider.stage({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceResourceId: source.id,
      targetId: TARGET_ID
    });
    const generatedAgain = stagedAgain.generatedResources.find(
      (resource) => resource.logicalPath === "AGENTS.md"
    );
    if (generatedAgain === undefined) {
      throw new Error("Rulesync did not generate AGENTS.md on the second stage.");
    }
    const generatedAgainPath = await context.infrastructure.resolveAuthorizedResourcePath(
      WORKSPACE_ID,
      generatedAgain.id
    );
    expect(path.dirname(generatedAgainPath)).not.toBe(path.dirname(generatedAbsolutePath));
    expect(await readFile(agentsPath)).toEqual(agentsBefore);
  });

  test("discovers every current Rulesync source format for the shared file browser", async () => {
    const context = await createTestContext();
    await mkdir(path.join(context.workspaceRoot, ".rulesync", "skills", "review"), { recursive: true });
    await mkdir(path.join(context.workspaceRoot, ".rulesync", "commands"), { recursive: true });
    await mkdir(path.join(context.workspaceRoot, ".rulesync", "mcp"), { recursive: true });
    await mkdir(path.join(context.workspaceRoot, ".rulesync", "settings"), { recursive: true });
    await writeFile(path.join(context.workspaceRoot, ".rulesync", "skills", "review", "SKILL.md"), "# Review\n");
    await writeFile(path.join(context.workspaceRoot, ".rulesync", "commands", "check.yaml"), "name: check\n");
    await writeFile(path.join(context.workspaceRoot, ".rulesync", "mcp", "servers.jsonc"), "{ // safe\n}\n");
    await writeFile(path.join(context.workspaceRoot, ".rulesync", "settings", "project.toml"), "enabled = true\n");
    await writeFile(path.join(context.workspaceRoot, ".rulesync", "notes.txt"), "notes\n");
    await writeFile(path.join(context.workspaceRoot, ".rulesync", "opaque.conf"), "opaque\n");

    const detection = await context.provider.detect({
      workspaceId: WORKSPACE_ID,
      rootResourceId: context.rootResourceId
    });
    if (!detection.detected) throw new Error("Expected the expanded Rulesync tree to be detected.");

    expect(detection.sourceResources.map(({ logicalPath, format }) => [logicalPath, format])).toEqual([
      ["commands/check.yaml", "yaml"],
      ["mcp/servers.jsonc", "jsonc"],
      ["notes.txt", "text"],
      ["opaque.conf", "unknown"],
      ["rules/base.md", "markdown"],
      ["settings/project.toml", "toml"],
      ["skills/review/SKILL.md", "markdown"]
    ]);
  });

  test("previews a create when AGENTS.md does not exist", async () => {
    const context = await createTestContext();
    await rm(path.join(context.workspaceRoot, "AGENTS.md"));
    const { sourceResourceId } = await detectSource(context);

    const staged = await context.provider.stage({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceResourceId,
      targetId: TARGET_ID
    });
    const changeSet = await context.provider.preview({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      targetId: TARGET_ID,
      stagedOutputId: staged.id
    });
    const agentsChange = changeSet.changes.find((change) => change.logicalPath === "AGENTS.md");

    expect(agentsChange?.kind).toBe("create");
    expect(agentsChange?.before).toBeNull();
    expect(agentsChange?.after).not.toBeNull();
    await expect(readFile(path.join(context.workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("returns not detected when .rulesync is missing", async () => {
    const context = await createTestContext();
    await rm(path.join(context.workspaceRoot, ".rulesync"), { recursive: true });

    await expect(
      context.provider.detect({
        workspaceId: WORKSPACE_ID,
        rootResourceId: context.rootResourceId
      })
    ).resolves.toEqual({
      detected: false,
      sourceRootResourceId: null,
      sourceResources: []
    });
  });

  test("rejects a source symlink that escapes the canonical .rulesync root", async (testContext) => {
    const context = await createTestContext();
    const outsideSource = path.join(context.tempRoot, "outside.md");
    const escapingLink = path.join(
      context.workspaceRoot,
      ".rulesync",
      "rules",
      "escape.md"
    );
    await writeFile(outsideSource, "# Outside\n\nThis file is not authorized.\n");

    try {
      await symlink(outsideSource, escapingLink, "file");
    } catch (error) {
      if (hasErrorCode(error, ["EPERM", "EACCES", "UNKNOWN"])) {
        testContext.skip("This Windows environment does not permit creating test symlinks.");
        return;
      }
      throw error;
    }

    await expect(
      context.provider.detect({
        workspaceId: WORKSPACE_ID,
        rootResourceId: context.rootResourceId
      })
    ).rejects.toThrow(/escapes its authorized root/i);
  });

  test("validation rejects a source capability outside the detected context", async () => {
    const context = await createTestContext();
    await detectSource(context);

    const validation = await context.provider.validate({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceResourceId: "resource:forged"
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual({
      code: "INVALID_SOURCE_RESOURCE",
      message: expect.any(String),
      resourceId: "resource:forged"
    });
  });
});

async function createTestContext(): Promise<TestContext> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ruleswitch-provider-"));
  temporaryRoots.push(tempRoot);
  const workspaceRoot = path.join(tempRoot, "workspace");
  await cp(FIXTURE_WORKSPACE, workspaceRoot, { recursive: true });
  const infrastructure = new NodeProviderInfrastructure(path.join(tempRoot, "staging"));
  const rootResourceId = await infrastructure.registerWorkspaceRoot(
    WORKSPACE_ID,
    workspaceRoot
  );
  return {
    tempRoot,
    workspaceRoot,
    infrastructure,
    provider: new RulesyncProvider(infrastructure),
    rootResourceId
  };
}

async function detectSource(context: TestContext): Promise<{ sourceResourceId: string }> {
  const detection = await context.provider.detect({
    workspaceId: WORKSPACE_ID,
    rootResourceId: context.rootResourceId
  });
  if (!detection.detected || detection.sourceResources[0] === undefined) {
    throw new Error("Expected a Rulesync source in the integration fixture.");
  }
  return { sourceResourceId: detection.sourceResources[0].id };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hasErrorCode(error: unknown, acceptedCodes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    acceptedCodes.includes(error.code)
  );
}
