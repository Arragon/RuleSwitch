import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IdentityStoreError, RepositoryIdentityStore } from "../identity-store";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-identity-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RepositoryIdentityStore (INH-1764)", () => {
  it("generates a stable deviceId exactly once across restarts", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "v1.json");

    const first = new RepositoryIdentityStore(storePath);
    const deviceId = await first.ensureDeviceId();
    expect(deviceId).toMatch(/^dev_[0-9a-f]{64}$/);

    // Simulated restart: a fresh store instance over the same file.
    const second = new RepositoryIdentityStore(storePath);
    await expect(second.ensureDeviceId()).resolves.toBe(deviceId);

    const third = new RepositoryIdentityStore(storePath);
    await third.load();
    await expect(third.ensureDeviceId()).resolves.toBe(deviceId);
  });

  it("writes a versioned envelope atomically and rebinds a moved repository by identity", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "v1.json");
    const repositoryId = "repo_f80ba2ec8e9be38851196514b9bb92903b3d51001e7fbcb7cf7896e479a5f3d0";

    const first = new RepositoryIdentityStore(storePath);
    await first.bindRepository(repositoryId, "git://github.com/acme/config", path.join(root, "clone-a"));
    const raw = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;
    expect(raw.store).toBe("repositories");
    expect(raw.version).toBe(1);

    const second = new RepositoryIdentityStore(storePath);
    await second.load();
    expect(second.findRepository(repositoryId)?.localPath).toBe(path.join(root, "clone-a"));

    // Repo moved: rebind by identity updates the path, not the identity.
    await second.updateLocalPath(repositoryId, path.join(root, "clone-b"));
    const third = new RepositoryIdentityStore(storePath);
    await third.load();
    expect(third.findRepository(repositoryId)?.localPath).toBe(path.join(root, "clone-b"));
    expect(third.findByCanonicalRemote("git://github.com/acme/config")?.repositoryId).toBe(repositoryId);
  });

  it("persists pending publish across restarts and clears it after success", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "v1.json");
    const repositoryId = "repo_8008aa6d52a5d91567663ee7147e540c47cc44d82ffc564726a4a5221eb378f0";

    const first = new RepositoryIdentityStore(storePath);
    await first.bindRepository(repositoryId, "git://gitlab.example.com:2222/group/repo", path.join(root, "repo"));
    await first.setPendingPublish(repositoryId, true);

    const second = new RepositoryIdentityStore(storePath);
    await second.load();
    expect(second.findRepository(repositoryId)?.pendingPublish).toBe(true);

    await second.setPendingPublish(repositoryId, false);
    const third = new RepositoryIdentityStore(storePath);
    await third.load();
    expect(third.findRepository(repositoryId)?.pendingPublish).toBe(false);
  });

  it("quarantines a corrupt store instead of deleting or overwriting it", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "v1.json");
    await writeFile(storePath, "{ not json", "utf8");

    const store = new RepositoryIdentityStore(storePath);
    await expect(store.ensureDeviceId()).rejects.toBeInstanceOf(IdentityStoreError);
    // The corrupt bytes were renamed, not destroyed.
    const renamed = (await import("node:fs/promises")).readdir(root);
    expect((await renamed).some((name) => name.startsWith("v1.json.corrupt-"))).toBe(true);
  });

  it("blocks stores from a future version without touching them", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "v1.json");
    await writeFile(
      storePath,
      JSON.stringify({ store: "repositories", version: 99, writtenAt: "2026-10-07T00:00:00Z", data: {} }),
      "utf8"
    );

    const store = new RepositoryIdentityStore(storePath);
    await expect(store.load()).rejects.toThrow(/newer than supported/);
    const raw = await readFile(storePath, "utf8");
    expect(JSON.parse(raw).version).toBe(99);
  });

  it("recognizes legacy unversioned data and refuses mutations", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "v1.json");
    await writeFile(storePath, JSON.stringify({ manifestVersion: 2, workspaceId: "ws-random" }), "utf8");

    const store = new RepositoryIdentityStore(storePath);
    await expect(store.load()).rejects.toBeInstanceOf(IdentityStoreError);
  });
});
