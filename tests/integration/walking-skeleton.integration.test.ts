import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  EntityId,
  HistoryEntry,
  PlatformService,
  WorkspaceSelection
} from "../../packages/core/src/index";
import { RulesyncProvider } from "../../packages/rulesync-provider/src/index";
import { afterEach, describe, expect, test } from "vitest";

import {
  ApplicationError,
  RuleSwitchApplication
} from "../../apps/desktop/src/main/application/rule-switch-application";
import {
  InfrastructureSecurityError,
  NodeFilesystemInfrastructure,
  type FilesystemFaultInjector
} from "../../apps/desktop/src/main/infrastructure/node-filesystem";
import { DesktopStores } from "../../apps/desktop/src/main/infrastructure/storage";

const temporaryRoots: string[] = [];
const ORIGINAL_AGENTS = new Uint8Array([
  0xef,
  0xbb,
  0xbf,
  ...new TextEncoder().encode("# Original\r\n\r\nPreserve CRLF and BOM.\r\n")
]);
const UNKNOWN_BYTES = new TextEncoder().encode("unknown-file-must-remain\r\n");

class FailingHistoryStores extends DesktopStores {
  private shouldFail = true;

  override async appendHistory(entry: HistoryEntry): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("injected history commit failure");
    }
    await super.appendHistory(entry);
  }
}

class TestPlatformService implements PlatformService {
  readonly openedResourceIds: EntityId[] = [];

  constructor(
    private readonly selections: WorkspaceSelection[],
    private readonly appDataRoot: string
  ) {}

  enqueueSelection(selection: WorkspaceSelection): void {
    this.selections.push(selection);
  }

  async selectWorkspace(): Promise<WorkspaceSelection | null> {
    return this.selections.shift() ?? null;
  }

  async openExternal(resourceId: EntityId): Promise<void> {
    this.openedResourceIds.push(resourceId);
  }

  async getAppDataRoot(): Promise<string> {
    return this.appDataRoot;
  }
}

interface TestApplication {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly appDataRoot: string;
  readonly platform: TestPlatformService;
  readonly filesystem: NodeFilesystemInfrastructure;
  readonly stores: DesktopStores;
  readonly application: RuleSwitchApplication;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("desktop production walking skeleton", () => {
  test("opens, reads, stages, applies, records history, and restores exact raw bytes", async () => {
    const context = await createApplication();
    const unknownPath = path.join(context.workspaceRoot, "unmanaged.bin");
    const agentsPath = path.join(context.workspaceRoot, "AGENTS.md");
    const session = await context.application.openWorkspace();
    const source = session.sourceResources.find((resource) => resource.logicalPath === "rules/base.md");
    expect(source).toBeDefined();
    if (source === undefined) {
      throw new Error("Expected a detected Markdown source.");
    }

    const sourceContent = await context.application.readResource(source.id);
    expect(new TextDecoder().decode(sourceContent.content)).toContain("RULESWITCH_WALKING_SKELETON");

    const changeSet = await context.application.stageTarget(
      session.workspace.id,
      session.profile.id,
      source.id,
      session.target.id
    );
    const agentsChange = changeSet.changes.find((change) => change.logicalPath === "AGENTS.md");
    expect(agentsChange?.kind).toBe("modify");
    expect(agentsChange?.after).not.toBeNull();
    if (agentsChange?.after === null || agentsChange?.after === undefined) {
      throw new Error("Expected a generated AGENTS.md revision.");
    }
    const generated = await context.application.readResource(agentsChange.after.resourceId);
    expect(generated.content).not.toEqual(ORIGINAL_AGENTS);
    expect(await readFile(agentsPath)).toEqual(Buffer.from(ORIGINAL_AGENTS));

    await context.application.openExternal(source.id);
    await expect(
      context.application.openExternal(agentsChange.after.resourceId)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_RESOURCE" });
    expect(context.platform.openedResourceIds).toEqual([source.id]);

    const applied = await context.application.applyChangeSet(changeSet.id);
    expect(applied.state).toBe("COMMITTED");
    expect(await readFile(agentsPath)).toEqual(Buffer.from(generated.content));
    expect(await readFile(unknownPath)).toEqual(Buffer.from(UNKNOWN_BYTES));

    const history = await context.application.listHistory(session.workspace.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe("apply");
    const restoreSource = history[0];
    if (restoreSource === undefined) {
      throw new Error("Expected apply history.");
    }

    const restored = await context.application.restoreHistory(restoreSource.id);
    expect(restored.state).toBe("COMMITTED");
    expect(await readFile(agentsPath)).toEqual(Buffer.from(ORIGINAL_AGENTS));
    expect(await readFile(unknownPath)).toEqual(Buffer.from(UNKNOWN_BYTES));

    const afterRestoreHistory = await context.application.listHistory(session.workspace.id);
    expect(afterRestoreHistory).toHaveLength(2);
    expect(afterRestoreHistory[1]).toMatchObject({
      kind: "restore",
      restoredFromHistoryEntryId: restoreSource.id
    });
  });

  test("restores captured ownership across reversible create and delete history", async () => {
    const context = await createApplication();
    const agentsPath = path.join(context.workspaceRoot, "AGENTS.md");
    await rm(agentsPath);
    const session = await context.application.openWorkspace();
    expect(await context.stores.listOwnership(session.workspace.id)).toEqual([]);
    await expect(readFile(agentsPath)).rejects.toMatchObject({ code: "ENOENT" });

    const source = session.sourceResources[0];
    if (source === undefined) {
      throw new Error("Expected source resource.");
    }
    const changeSet = await context.application.stageTarget(
      session.workspace.id,
      session.profile.id,
      source.id,
      session.target.id
    );
    const generatedChange = changeSet.changes.find(
      (change) => change.logicalPath === "AGENTS.md"
    );
    if (generatedChange?.after === null || generatedChange?.after === undefined) {
      throw new Error("Expected Rulesync to generate AGENTS.md.");
    }
    const generated = await context.application.readResource(generatedChange.after.resourceId);

    const applied = await context.application.applyChangeSet(changeSet.id);
    expect(applied.state).toBe("COMMITTED");
    expect(await readFile(agentsPath)).toEqual(Buffer.from(generated.content));
    expect(await context.stores.listOwnership(session.workspace.id)).toEqual([
      {
        logicalPath: "AGENTS.md",
        profileId: session.profile.id,
        provider: "rulesync",
        digest: generatedChange.after.hash.digest
      }
    ]);
    const afterApply = await context.application.listHistory(session.workspace.id);
    expect(afterApply).toHaveLength(1);
    expect(afterApply[0]?.kind).toBe("apply");
    const applyHistory = afterApply[0];
    if (applyHistory === undefined) {
      throw new Error("Expected apply history.");
    }

    const deleted = await context.application.restoreHistory(applyHistory.id);
    expect(deleted.state).toBe("COMMITTED");
    await expect(readFile(agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await context.stores.listOwnership(session.workspace.id)).toEqual([]);
    const afterDelete = await context.application.listHistory(session.workspace.id);
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete.map((entry) => entry.kind)).toEqual(["apply", "restore"]);
    const deleteHistory = afterDelete[1];
    if (deleteHistory === undefined) {
      throw new Error("Expected delete restore history.");
    }

    const recreated = await context.application.restoreHistory(deleteHistory.id);
    expect(recreated.state).toBe("COMMITTED");
    expect(await readFile(agentsPath)).toEqual(Buffer.from(generated.content));
    expect(await context.stores.listOwnership(session.workspace.id)).toEqual([
      {
        logicalPath: "AGENTS.md",
        profileId: session.profile.id,
        provider: "rulesync",
        digest: generatedChange.after.hash.digest
      }
    ]);
    const afterRecreate = await context.application.listHistory(session.workspace.id);
    expect(afterRecreate).toHaveLength(3);
    expect(afterRecreate.map((entry) => entry.kind)).toEqual(["apply", "restore", "restore"]);

    const deletedAgain = await context.application.restoreHistory(applyHistory.id);
    expect(deletedAgain.state).toBe("COMMITTED");
    await expect(readFile(agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await context.stores.listOwnership(session.workspace.id)).toEqual([]);
    const finalHistory = await context.application.listHistory(session.workspace.id);
    expect(finalHistory).toHaveLength(4);
    expect(finalHistory.map((entry) => entry.kind)).toEqual([
      "apply",
      "restore",
      "restore",
      "restore"
    ]);
  });

  test("restores original ownership when commit metadata fails", async () => {
    const context = await createApplication(
      undefined,
      (appDataRoot) => new FailingHistoryStores(appDataRoot)
    );
    const agentsPath = path.join(context.workspaceRoot, "AGENTS.md");
    await rm(agentsPath);
    const session = await context.application.openWorkspace();
    const source = session.sourceResources[0];
    if (source === undefined) {
      throw new Error("Expected source resource.");
    }
    const changeSet = await context.application.stageTarget(
      session.workspace.id,
      session.profile.id,
      source.id,
      session.target.id
    );

    await expect(context.application.applyChangeSet(changeSet.id)).rejects.toMatchObject({
      code: "TRANSACTION_ERROR"
    });
    await expect(readFile(agentsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await context.stores.listOwnership(session.workspace.id)).toEqual([]);
    expect(await context.application.listHistory(session.workspace.id)).toEqual([]);
  });

  test("rejects a traversal payload in a tampered snapshot manifest before loading it", async () => {
    const context = await createApplication();
    const session = await context.application.openWorkspace();
    const source = session.sourceResources[0];
    if (source === undefined) {
      throw new Error("Expected source resource.");
    }
    const changeSet = await context.application.stageTarget(
      session.workspace.id,
      session.profile.id,
      source.id,
      session.target.id
    );
    await context.application.applyChangeSet(changeSet.id);
    const history = await context.application.listHistory(session.workspace.id);
    const applyHistory = history[0];
    if (applyHistory === undefined) {
      throw new Error("Expected apply history.");
    }

    const snapshotRoot = path.join(
      context.appDataRoot,
      "snapshots",
      session.workspace.id,
      applyHistory.snapshotId
    );
    const manifestPath = path.join(snapshotRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: Array<{ payload: string | null }>;
    };
    const capturedFile = manifest.files[0];
    if (capturedFile === undefined) {
      throw new Error("Expected a captured snapshot file.");
    }
    const outsidePayload = path.resolve(snapshotRoot, "..", "..", "outside.bin");
    await writeFile(outsidePayload, ORIGINAL_AGENTS);
    capturedFile.payload = "../../outside.bin";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      context.stores.loadSnapshot(session.workspace.id, applyHistory.snapshotId)
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(await readFile(outsidePayload)).toEqual(Buffer.from(ORIGINAL_AGENTS));
    await expect(context.application.restoreHistory(applyHistory.id)).rejects.toMatchObject({
      code: "TRANSACTION_ERROR"
    });
  });

  test("rejects a stale target before writing and preserves the external edit", async () => {
    const context = await createApplication();
    const session = await context.application.openWorkspace();
    const source = session.sourceResources[0];
    if (source === undefined) {
      throw new Error("Expected source resource.");
    }
    const changeSet = await context.application.stageTarget(
      session.workspace.id,
      session.profile.id,
      source.id,
      session.target.id
    );
    const externalEdit = new TextEncoder().encode("# Edited after preview\r\n");
    const agentsPath = path.join(context.workspaceRoot, "AGENTS.md");
    await writeFile(agentsPath, externalEdit);

    await expect(context.application.applyChangeSet(changeSet.id)).rejects.toMatchObject({
      code: "STALE_CHANGE_SET"
    });
    expect(await readFile(agentsPath)).toEqual(Buffer.from(externalEdit));
    expect(await context.application.listHistory(session.workspace.id)).toEqual([]);
  });

  test("rolls back exact bytes when the atomic workspace write fails", async () => {
    let injected = false;
    const faultInjector: FilesystemFaultInjector = {
      beforeAtomicWrite: () => {
        if (!injected) {
          injected = true;
          throw new Error("injected atomic write failure");
        }
      }
    };
    const context = await createApplication(faultInjector);
    const session = await context.application.openWorkspace();
    const source = session.sourceResources[0];
    if (source === undefined) {
      throw new Error("Expected source resource.");
    }
    const changeSet = await context.application.stageTarget(
      session.workspace.id,
      session.profile.id,
      source.id,
      session.target.id
    );

    await expect(context.application.applyChangeSet(changeSet.id)).rejects.toMatchObject({
      code: "TRANSACTION_ERROR"
    });
    expect(await readFile(path.join(context.workspaceRoot, "AGENTS.md"))).toEqual(
      Buffer.from(ORIGINAL_AGENTS)
    );
    expect(await context.application.listHistory(session.workspace.id)).toEqual([]);
  });

  test("rejects forged and cross-workspace capabilities and invalid logical paths", async () => {
    const context = await createApplication();
    const secondWorkspace = await createWorkspace(context.root, "workspace-two");
    context.platform.enqueueSelection({
      selectedRoot: secondWorkspace,
      displayName: "workspace-two"
    });
    const first = await context.application.openWorkspace();
    const second = await context.application.openWorkspace();
    const firstSource = first.sourceResources[0];
    const secondSource = second.sourceResources[0];
    if (firstSource === undefined || secondSource === undefined) {
      throw new Error("Expected both source capabilities.");
    }

    await expect(context.application.openExternal("resource_forged")).rejects.toBeInstanceOf(
      ApplicationError
    );
    await expect(
      context.application.stageTarget(
        second.workspace.id,
        second.profile.id,
        firstSource.id,
        second.target.id
      )
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_RESOURCE" });
    await expect(
      context.filesystem.resolveAuthorizedResourcePath(second.workspace.id, firstSource.id)
    ).rejects.toBeInstanceOf(InfrastructureSecurityError);

    const secondRootId = context.filesystem.getResourceRootId(second.workspace.id, secondSource.id);
    await expect(
      context.filesystem.registerFileResource({
        workspaceId: second.workspace.id,
        rootResourceId: secondRootId,
        logicalPath: "../escape.md",
        origin: "source",
        format: "markdown",
        readonly: true,
        symlinkPolicy: "allow-contained"
      })
    ).rejects.toBeInstanceOf(InfrastructureSecurityError);

    await context.application.openExternal(firstSource.id);
    expect(context.platform.openedResourceIds).toEqual([firstSource.id]);
  });
});

async function createApplication(
  faultInjector?: FilesystemFaultInjector,
  storesFactory?: (appDataRoot: string) => DesktopStores
): Promise<TestApplication> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-walking-"));
  temporaryRoots.push(root);
  const workspaceRoot = await createWorkspace(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  const platform = new TestPlatformService(
    [{ selectedRoot: workspaceRoot, displayName: "Walking Skeleton" }],
    appDataRoot
  );
  const filesystem = new NodeFilesystemInfrastructure(appDataRoot, faultInjector);
  const stores = storesFactory?.(await platform.getAppDataRoot()) ?? new DesktopStores(appDataRoot);
  const provider = new RulesyncProvider(filesystem);
  const application = new RuleSwitchApplication(platform, filesystem, provider, stores);
  await application.initialize();
  return { root, workspaceRoot, appDataRoot, platform, filesystem, stores, application };
}

async function createWorkspace(root: string, name: string): Promise<string> {
  const workspaceRoot = path.join(root, name);
  await mkdir(path.join(workspaceRoot, ".rulesync", "rules"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".rulesync", "rules", "base.md"),
    [
      "---",
      "root: true",
      'targets: ["codexcli"]',
      'description: "Walking skeleton"',
      'globs: ["**/*"]',
      "---",
      "",
      "# Walking Skeleton",
      "",
      "Preserve RULESWITCH_WALKING_SKELETON in generated instructions.",
      ""
    ].join("\n")
  );
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), ORIGINAL_AGENTS);
  await writeFile(path.join(workspaceRoot, "unmanaged.bin"), UNKNOWN_BYTES);
  return workspaceRoot;
}
