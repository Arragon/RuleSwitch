// Cross-repository ownership isolation (INH-1781). Ownership is a fact about
// (repository, harness instance, target path) — never about a path alone. Two
// repositories that project onto the SAME local file must not inherit each
// other's ownership: otherwise repository B could silently overwrite what
// repository A wrote, or skip the adoption prompt on a file it has never
// managed.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CapabilityServiceV2 } from "../capabilities-v2";
import { GitPortAdapter } from "../../infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../infrastructure/git/git-runtime";
import { ProjectsStore, SettingsStore } from "../../infrastructure/git/binding-store";
import { BatchSnapshotStore } from "../../infrastructure/git/batch-snapshot-store";
import { SyncBaselineStore } from "../../infrastructure/git/baseline-store";
import { OperationsStore } from "../../infrastructure/git/sync-state";
import { RepositoryIdentityStore } from "../../infrastructure/git/identity-store";

const temporaryRoots: string[] = [];
const hasher = {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Two repositories with different content for the SAME logical asset, sharing
 * one HOME (one harness root) and one state directory (one baseline store).
 */
async function createTwoRepositories() {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-ownership-"));
  temporaryRoots.push(root);

  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  const create = async (name: string, agentsContent: string): Promise<string> => {
    const bare = path.join(root, `${name}.git`);
    const repo = path.join(root, name);
    await runtime.run(["init", "--bare", "-q", "--initial-branch=main", bare], { cwd: root });
    await runtime.run(["clone", "-q", bare, repo], { cwd: root });
    await runtime.run(["config", "user.name", "T"], { cwd: repo });
    await runtime.run(["config", "user.email", "t@t"], { cwd: repo });
    await mkdir(path.join(repo, "global", "instructions"), { recursive: true });
    await writeFile(path.join(repo, "ruleswitch.yaml"), "schemaVersion: 1\n", "utf8");
    await writeFile(path.join(repo, "global", "instructions", "AGENTS.md"), agentsContent, "utf8");
    await runtime.run(["add", "."], { cwd: repo });
    await runtime.run(["commit", "-q", "-m", "seed"], { cwd: repo });
    await runtime.run(["push", "-q", "-u", "origin", "main"], { cwd: repo });
    return repo;
  };

  const repoA = await create("repo-a", "# from repository A\n");
  const repoB = await create("repo-b", "# from repository B\n");

  const state = path.join(root, "state");
  await mkdir(state, { recursive: true });
  const identityStore = new RepositoryIdentityStore(path.join(state, "identity.json"));
  await identityStore.load();
  const projectsStore = new ProjectsStore(path.join(state, "projects.json"));
  await projectsStore.load();
  const settingsStore = new SettingsStore(path.join(state, "settings.json"));
  await settingsStore.load();
  const operationsStore = new OperationsStore(path.join(state, "operations.json"));
  await operationsStore.load();
  const baselineStore = new SyncBaselineStore(path.join(state, "baselines.json"));
  await baselineStore.load();
  const snapshotStore = new BatchSnapshotStore(path.join(state, "batch-snapshots"));

  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;

  const service = new CapabilityServiceV2({
    gitPort: new GitPortAdapter({ gitRuntime: runtime, identityStore }),
    projectsStore,
    settingsStore,
    operationsStore,
    baselineStore,
    snapshotStore,
    harnessRegistry: {
      listRegistrations: () => [
        { harnessInstanceId: "harn_codex", adapterId: "codex", displayName: "Codex", installed: true }
      ]
    },
    hasher
  });

  return { repoA, repoB, home, service, baselineStore };
}

const agentsAsset = {
  assetKey: "asset_agents",
  kind: "instructions" as const,
  logicalName: "AGENTS.md",
  content: new Uint8Array()
};

const codexTarget = [{ harnessInstanceId: "harn_codex" }];

describe("cross-repository ownership isolation (INH-1781)", () => {
  it("ownership earned in one repository does not let another repository overwrite the same file", async () => {
    const { repoA, repoB, home, service, baselineStore } = await createTwoRepositories();

    await service.openRepositoryFromDirectory(repoA);
    const fromA = await service.applyToHarnesses({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: codexTarget
    });
    expect(fromA.appliedCount).toBe(1);

    // Switch repositories: the same local file is now foreign to repo B.
    await service.openRepositoryFromDirectory(repoB);
    const preview = await service.previewApply({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: codexTarget
    });
    expect(preview.entries[0]?.action).toBe("needs-adoption");
    expect(preview.needsAdoptionCount).toBe(1);

    const withoutConsent = await service.applyToHarnesses({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: codexTarget
    });
    expect(withoutConsent.appliedCount).toBe(0);
    expect(withoutConsent.blockedCount).toBe(1);
    // Repository A's bytes survive: no silent cross-repo overwrite.
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# from repository A\n");

    const repositoryA = (await (async () => {
      await service.openRepositoryFromDirectory(repoA);
      return (await service.repositoryStatus())?.repositoryId ?? "";
    })()) as string;
    await service.openRepositoryFromDirectory(repoB);
    const repositoryB = (await service.repositoryStatus())?.repositoryId ?? "";
    expect(repositoryA).not.toBe(repositoryB);
    // The baseline belongs to A only; B has none.
    expect(Object.keys(baselineStore.digestsFor(repositoryA, "harn_codex"))).toContain("AGENTS.md");
    expect(baselineStore.digestsFor(repositoryB, "harn_codex")["AGENTS.md"]).toBeUndefined();
  }, 90_000);

  it("repository reads follow the most recently opened repository, not the first one registered", async () => {
    const { repoA, repoB, service } = await createTwoRepositories();

    await service.openRepositoryFromDirectory(repoA);
    await service.openRepositoryFromDirectory(repoB);

    // Regression: GitPortAdapter.currentRoot() used to return the FIRST
    // registered repository, so every root-based read (library, asset bytes,
    // set-compare) served repository A while repository B was open.
    const read = await service.readRepoFile("global/instructions/AGENTS.md");
    expect(read).not.toBeNull();
    const content = Buffer.from(read?.contentBase64 ?? "", "base64").toString("utf8");
    expect(content).toBe("# from repository B\n");

    // Switching back must follow too.
    await service.openRepositoryFromDirectory(repoA);
    const backToA = await service.readRepoFile("global/instructions/AGENTS.md");
    expect(Buffer.from(backToA?.contentBase64 ?? "", "base64").toString("utf8")).toBe(
      "# from repository A\n"
    );

    const library = await service.browseLibrary();
    expect(library?.entries.some((entry) => entry.logicalName.endsWith("AGENTS.md"))).toBe(true);
  }, 90_000);

  it("adopting in the second repository keeps each repository's drift detection independent", async () => {
    const { repoA, repoB, home, service } = await createTwoRepositories();

    await service.openRepositoryFromDirectory(repoA);
    await service.applyToHarnesses({ assets: [agentsAsset], mode: "overwrite", targets: codexTarget });

    await service.openRepositoryFromDirectory(repoB);
    const adopted = await service.applyToHarnesses({
      assets: [agentsAsset],
      mode: "overwrite",
      confirmAdoption: true,
      targets: codexTarget
    });
    expect(adopted.appliedCount).toBe(1);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# from repository B\n");

    // A repeat apply in B is a no-op (B now owns the bytes it wrote)...
    const repeatB = await service.applyToHarnesses({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: codexTarget
    });
    expect(repeatB.unchangedCount).toBe(1);
    expect(repeatB.appliedCount).toBe(0);

    // ...but a local edit is drift for B, not a silent overwrite.
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "# user edit\n", "utf8");
    const driftB = await service.applyToHarnesses({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: codexTarget
    });
    expect(driftB.failedCount).toBe(1);
    expect(driftB.entries[0]?.detail).toMatch(/changed since the recorded baseline/);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# user edit\n");

    // And A's stale baseline must not authorise A to overwrite it either.
    await service.openRepositoryFromDirectory(repoA);
    const fromA = await service.applyToHarnesses({
      assets: [agentsAsset],
      mode: "overwrite",
      targets: codexTarget
    });
    expect(fromA.appliedCount).toBe(0);
    expect(fromA.failedCount).toBe(1);
    expect(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# user edit\n");
  }, 90_000);
});
