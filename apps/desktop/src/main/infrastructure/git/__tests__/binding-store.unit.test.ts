import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BindingStoreError,
  HarnessRegistryStore,
  ProjectsStore,
  SettingsStore
} from "../binding-store";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-bindings-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("projects store (INH-1772)", () => {
  it("persists bindings across restarts and rebinds moved paths", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "projects", "v1.json");

    const first = new ProjectsStore(storePath);
    await first.load();
    await first.bindProject({
      projectId: "prj_demo",
      repositoryId: "repo_" + "a".repeat(64),
      localPath: path.join(root, "clone-a"),
      displayName: "Demo 项目"
    });

    const second = new ProjectsStore(storePath);
    await second.load();
    expect(second.findProject("prj_demo")?.localPath).toBe(path.join(root, "clone-a"));

    await second.rebindPath("prj_demo", path.join(root, "clone-b"));
    const third = new ProjectsStore(storePath);
    await third.load();
    expect(third.findProject("prj_demo")?.localPath).toBe(path.join(root, "clone-b"));

    await third.markAvailability("prj_demo", false);
    const fourth = new ProjectsStore(storePath);
    await fourth.load();
    expect(fourth.findProject("prj_demo")?.available).toBe(false);
    expect(fourth.findProject("prj_demo")?.projectId).toBe("prj_demo");
  });

  it("quarantines corrupt files instead of deleting or overwriting them", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "projects", "v1.json");
    await mkdir(path.join(root, "projects"), { recursive: true });
    await writeFile(storePath, "{ broken", "utf8");

    const store = new ProjectsStore(storePath);
    await expect(store.load()).rejects.toBeInstanceOf(BindingStoreError);
    const files = await readdir(path.join(root, "projects"));
    expect(files.some((name) => name.startsWith("v1.json.corrupt-"))).toBe(true);
    expect(files.includes("v1.json")).toBe(false);
  });

  it("blocks future store versions without touching them", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "projects", "v1.json");
    await mkdir(path.join(root, "projects"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({ store: "projects", version: 99, writtenAt: "2026-10-08T00:00:00Z", data: {} }),
      "utf8"
    );
    const store = new ProjectsStore(storePath);
    await expect(store.load()).rejects.toThrow(/newer than supported/);
    expect(JSON.parse(await readFile(storePath, "utf8")).version).toBe(99);
  });

  it("fails atomically: an injected write failure leaves the previous file intact", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "projects", "v1.json");
    let failNextWrite = false;
    const faults = { beforeRename: () => (failNextWrite ? new Error("disk full") : null) };

    const store = new ProjectsStore(storePath, faults);
    await store.load();
    await store.bindProject({
      projectId: "prj_keep",
      repositoryId: "repo_" + "b".repeat(64),
      localPath: "/stable",
      displayName: "Keep"
    });
    const before = await readFile(storePath, "utf8");

    failNextWrite = true;
    await expect(      store.bindProject({
        projectId: "prj_lost",
        repositoryId: "repo_" + "c".repeat(64),
        localPath: "/volatile",
        displayName: "Lost"
      })
    ).rejects.toThrow("disk full");

    const after = await readFile(storePath, "utf8");
    expect(after).toBe(before);
    // No temp litter is kept on failure.
    const files = await readdir(path.join(root, "projects"));
    expect(files.filter((name) => name.includes(".tmp-"))).toHaveLength(0);
  });
});

describe("harness registry store (INH-1772/1847)", () => {
  it("keeps registrations across restarts and updates installed state", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "harness-registry", "v1.json");

    const first = new HarnessRegistryStore(storePath);
    await first.load();
    await first.upsertRegistration({
      harnessInstanceId: "harn_" + "1".repeat(64),
      adapterId: "custom:0123456789abcdef",
      displayName: "自定义工具",
      presetMatched: false,
      customIcon: null,
      customFormatHints: ["markdown"],
      installed: false
    });

    const second = new HarnessRegistryStore(storePath);
    await second.load();
    expect(second.listRegistrations()).toHaveLength(1);
    expect(second.listRegistrations()[0]?.displayName).toBe("自定义工具");

    await second.setInstalled("harn_" + "1".repeat(64), true);
    const third = new HarnessRegistryStore(storePath);
    await third.load();
    expect(third.listRegistrations()[0]?.installed).toBe(true);
  });
});

describe("settings store (INH-1772/1757)", () => {
  it("persists selected profiles per repository and the explicit theme", async () => {
    const root = await temporaryDirectory();
    const storePath = path.join(root, "settings", "v1.json");

    const first = new SettingsStore(storePath);
    await first.load();
    await first.selectProfile("repo_" + "d".repeat(64), "work");
    await first.setTheme("dark");

    const second = new SettingsStore(storePath);
    await second.load();
    expect(second.selectedProfile("repo_" + "d".repeat(64))).toBe("work");
    expect(second.current().theme).toBe("dark");

    const fresh = new SettingsStore(path.join(root, "elsewhere", "v1.json"));
    await fresh.load();
    expect(fresh.current().theme).toBe("light"); // default light per IPC v2 contract
  });
});
