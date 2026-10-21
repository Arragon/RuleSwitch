// IPC v2 request contracts (round 8).
//
// The Renderer/Preload boundary is validated in BOTH directions, so a schema
// that is stricter than the Main implementation is a product outage: the UI
// builds a legal request, the boundary rejects it, and the feature is dead in
// the real app while unit tests (which call the service directly) stay green.
// That is exactly what happened to the library apply path: `contentBase64`
// required min(1), while Main deliberately resolves empty content from the
// open repository. These cases pin the contract to the implementation.

import { describe, expect, it } from "vitest";

import { IPC_V2_CHANNELS, IPC_V2_REQUEST_SCHEMAS, type IpcV2Method } from "../ipc-v2-channels";

const previewSchema = IPC_V2_REQUEST_SCHEMAS["apply.preview"];

interface ApplyAsset {
  readonly assetKey: string;
  readonly kind: string;
  readonly logicalName: string;
  readonly contentBase64: string;
}

/**
 * The library never ships file bytes over IPC: Main resolves them from the
 * repository it already has open, so `contentBase64` is empty by design.
 */
function asset(overrides: Partial<ApplyAsset> = {}): ApplyAsset {
  return {
    assetKey: "global/instructions/AGENTS.md",
    kind: "instructions",
    logicalName: "AGENTS.md",
    contentBase64: "",
    ...overrides
  };
}

function libraryApplyRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assets: [asset()],
    mode: "overwrite",
    targets: [{ harnessInstanceId: "harn_codex" }],
    ...overrides
  };
}

describe("apply request schema (INH-1857 library apply)", () => {
  it("accepts the library apply shape with empty content (Main resolves repo bytes)", () => {
    expect(previewSchema.safeParse(libraryApplyRequest()).success).toBe(true);
  });

  it("still accepts an explicit payload override", () => {
    const request = libraryApplyRequest({ assets: [asset({ contentBase64: "IyBkcmFmdAo=" })] });
    expect(previewSchema.safeParse(request).success).toBe(true);
  });

  it("rejects an asset whose identity is missing even when the payload is empty", () => {
    expect(previewSchema.safeParse(libraryApplyRequest({ assets: [asset({ logicalName: "" })] })).success).toBe(
      false
    );
    expect(previewSchema.safeParse(libraryApplyRequest({ assets: [asset({ assetKey: "" })] })).success).toBe(
      false
    );
  });

  it("rejects an empty asset list, an empty target list and unknown keys", () => {
    expect(previewSchema.safeParse(libraryApplyRequest({ assets: [] })).success).toBe(false);
    expect(previewSchema.safeParse(libraryApplyRequest({ targets: [] })).success).toBe(false);
    expect(previewSchema.safeParse(libraryApplyRequest({ extra: true })).success).toBe(false);
  });

  it("rejects an unknown apply mode instead of falling back", () => {
    expect(previewSchema.safeParse(libraryApplyRequest({ mode: "replace" })).success).toBe(false);
  });

  it("requires a target key for the diff request", () => {
    const diffSchema = IPC_V2_REQUEST_SCHEMAS["apply.diff"];
    expect(diffSchema.safeParse(libraryApplyRequest()).success).toBe(false);
    expect(
      diffSchema.safeParse(
        libraryApplyRequest({
          targetKey: "harn_codex|global|instructions",
          planRevision: "abc"
        })
      ).success
    ).toBe(true);
  });
});

/**
 * Boundary audit: every channel must accept the payload the Renderer actually
 * sends. A schema stricter than the implementation is invisible to service
 * tests (they bypass the boundary) and shows up as a dead feature in the app,
 * which is exactly how the library apply path and the empty-file save broke.
 *
 * The table is keyed by channel name and asserted to cover EVERY channel, so
 * adding a channel without auditing its boundary fails this test.
 */
const UI_PAYLOADS: Record<IpcV2Method, unknown> = {
  "repository.openFromDirectory": { directory: "/tmp/config-repo" },
  "repository.clone": { remoteUrl: "git@example.com:you/config.git", targetDirectory: "/tmp/clone-target" },
  "repository.status": {},
  "repository.validate": {},
  "library.browse": {},
  "library.readFile": { logicalPath: "global/instructions/AGENTS.md" },
  // Clearing a file: the Renderer base64-encodes "" as "".
  "library.editFile": { logicalPath: "global/instructions/AGENTS.md", contentBase64: "" },
  "library.deleteAsset": { logicalPaths: ["global/instructions/AGENTS.md"], confirmed: true },
  "changes.gitArea": {},
  "changes.setCompare": {},
  "changes.stage": { logicalPaths: ["global/instructions/AGENTS.md"] },
  "changes.unstage": { logicalPaths: ["global/instructions/AGENTS.md"] },
  "changes.commit": { message: "chore: sync" },
  "changes.push": {},
  "changes.fetch": {},
  "changes.fastForward": {},
  // First page has no cursor.
  "changes.log": { cursor: null, pageSize: 50 },
  "projects.list": {},
  "projects.bind": {
    projectId: "prj_0123456789abcdef0123456789abcdef",
    displayName: "示例项目",
    localPath: "/tmp/example-project"
  },
  "projects.unbind": { projectId: "prj_0123456789abcdef0123456789abcdef" },
  "harnesses.list": {},
  "harnesses.scan": { harnessInstanceId: "harn_codex" },
  "history.operations": {},
  "history.recovery": {},
  "operations.rollback": { batchId: "batch-1750000000000" },
  "settings.get": {},
  "settings.setTheme": { theme: "dark" },
  "apply.preview": libraryApplyRequest(),
  "apply.diff": libraryApplyRequest({ targetKey: "harn_codex|global|instructions", planRevision: "rev" }),
  "apply.toHarnesses": libraryApplyRequest({ planRevision: "rev" })
};

describe("IPC v2 boundary audit (all channels)", () => {
  it("covers every channel exactly once", () => {
    const channels = Object.keys(IPC_V2_CHANNELS) as IpcV2Method[];
    expect(Object.keys(UI_PAYLOADS).sort()).toEqual([...channels].sort());
    expect(Object.keys(IPC_V2_REQUEST_SCHEMAS).sort()).toEqual([...channels].sort());
  });

  it.each(Object.keys(IPC_V2_CHANNELS) as IpcV2Method[])(
    "accepts the Renderer payload for %s",
    (method) => {
      const schema = IPC_V2_REQUEST_SCHEMAS[method];
      const parsed = schema.safeParse(UI_PAYLOADS[method]);
      if (!parsed.success) {
        // Surface the Zod path so a failure names the offending field.
        throw new Error(`${method}: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}`);
      }
      expect(parsed.success).toBe(true);
    }
  );
});
