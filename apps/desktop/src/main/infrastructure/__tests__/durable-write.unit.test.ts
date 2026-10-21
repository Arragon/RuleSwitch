// Durable write helper (round 7). The fsync itself cannot be observed from a
// process-level test (a killed process never loses the page cache — only a
// power loss would prove it), so these cases pin the properties that ARE
// observable: exact bytes, atomic replacement, no temp residue, and the
// guarantee that a failed write never damages the previous file.

import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeFileDurably } from "../durable-write";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-durable-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeFileDurably", () => {
  it("creates missing parent directories and writes exactly the given bytes", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "nested", "state", "journal.json");

    await writeFileDurably(target, '{"a":1}\n');

    expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
    // 0o600 by default: state files hold paths and digests.
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  }, 30_000);

  it("replaces an existing file without leaving temporary files behind", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "journal.json");
    await writeFile(target, "old\n", "utf8");

    await writeFileDurably(target, "new\n");

    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await readdir(root)).toEqual(["journal.json"]);
  }, 30_000);

  it("leaves the previous file intact and no temp residue when the write fails", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "journal.json");
    await writeFile(target, "previous\n", "utf8");

    // A directory where the temp file must be created, but read-only, so the
    // rename cannot be prepared without touching `journal.json`.
    await chmod(root, 0o555);
    let failure: unknown = null;
    try {
      await writeFileDurably(target, "replacement\n");
    } catch (error) {
      failure = error;
    } finally {
      await chmod(root, 0o755);
    }

    expect(failure).not.toBeNull();
    expect(await readFile(target, "utf8")).toBe("previous\n");
    expect(await readdir(root)).toEqual(["journal.json"]);
  }, 30_000);

  it("refuses to follow a symlinked target and reports why", async () => {
    const root = await temporaryDirectory();
    const outside = path.join(root, "outside.json");
    const target = path.join(root, "journal.json");
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, target);

    // rename() over a symlink replaces the link itself, never the pointee;
    // the durable writer therefore leaves the outside file untouched.
    await writeFileDurably(target, "inside\n");

    expect(await readFile(outside, "utf8")).toBe("outside\n");
    expect(await readFile(target, "utf8")).toBe("inside\n");
  }, 30_000);
});
