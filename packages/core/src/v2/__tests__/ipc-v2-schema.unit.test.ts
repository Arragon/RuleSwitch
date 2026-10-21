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

import { IPC_V2_REQUEST_SCHEMAS } from "../ipc-v2-channels";

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
