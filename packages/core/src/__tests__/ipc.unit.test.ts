import { describe, expect, it } from "vitest";

import { HASH_ALGORITHM } from "../contracts";
import {
  applyChangeSetRequestSchema,
  listHistoryRequestSchema,
  openExternalRequestSchema,
  openWorkspaceRequestSchema,
  openWorkspaceResponseSchema,
  readResourceRequestSchema,
  restoreHistoryRequestSchema,
  stageTargetRequestSchema
} from "../ipc";

describe("IPC request schemas", () => {
  it("accepts only an empty request for workspace selection", () => {
    expect(openWorkspaceRequestSchema.safeParse({}).success).toBe(true);
    expect(openWorkspaceRequestSchema.safeParse({ path: "C:\\outside" }).success).toBe(false);
    expect(openWorkspaceRequestSchema.safeParse({ command: "open" }).success).toBe(false);
  });

  it("accepts resource identifiers and rejects paths or extra fields", () => {
    expect(readResourceRequestSchema.safeParse({ resourceId: "resource-1" }).success).toBe(true);
    expect(openExternalRequestSchema.safeParse({ resourceId: "resource-1" }).success).toBe(true);
    expect(readResourceRequestSchema.safeParse({ path: "/tmp/file" }).success).toBe(false);
    expect(
      openExternalRequestSchema.safeParse({
        resourceId: "resource-1",
        path: "/tmp/file"
      }).success
    ).toBe(false);
  });

  it("rejects path and command capabilities on every mutation request", () => {
    const stageRequest = {
      workspaceId: "workspace-1",
      profileId: "profile-1",
      sourceResourceId: "source-1",
      targetId: "target-1"
    };

    expect(stageTargetRequestSchema.safeParse(stageRequest).success).toBe(true);
    expect(stageTargetRequestSchema.safeParse({ ...stageRequest, path: "../escape" }).success).toBe(
      false
    );
    expect(
      applyChangeSetRequestSchema.safeParse({ changeSetId: "change-set-1", command: "rm" }).success
    ).toBe(false);
    expect(listHistoryRequestSchema.safeParse({ workspaceId: "workspace-1", path: "." }).success).toBe(
      false
    );
    expect(
      restoreHistoryRequestSchema.safeParse({ historyEntryId: "history-1", command: "restore" })
        .success
    ).toBe(false);
  });
});

describe("openWorkspace response schema", () => {
  const session = {
    workspace: {
      id: "workspace-1",
      name: "Project",
      rootResourceId: "workspace-root",
      profileIds: ["profile-1"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    },
    profile: {
      id: "profile-1",
      workspaceId: "workspace-1",
      name: "Default",
      kind: "universal",
      provider: "rulesync",
      sourceRootResourceId: "source-root",
      targetIds: ["target-1"]
    },
    target: {
      id: "target-1",
      workspaceId: "workspace-1",
      name: "Codex",
      provider: "rulesync",
      providerTarget: "codexcli",
      features: ["rules"]
    },
    sourceResources: [
      {
        id: "source-1",
        workspaceId: "workspace-1",
        logicalPath: "rules/base.md",
        origin: "source",
        format: "markdown",
        readonly: true,
        hash: { algorithm: HASH_ALGORITHM, digest: "0".repeat(64) },
        byteLength: 12
      }
    ]
  };

  it("returns the complete path-free v0.1 Renderer session", () => {
    expect(openWorkspaceResponseSchema.safeParse({ ok: true, data: session }).success).toBe(true);
  });

  it("rejects Main-only paths and inconsistent session identities", () => {
    expect(
      openWorkspaceResponseSchema.safeParse({
        ok: true,
        data: { ...session, selectedRoot: "C:/project" }
      }).success
    ).toBe(false);
    expect(
      openWorkspaceResponseSchema.safeParse({
        ok: true,
        data: {
          ...session,
          workspace: { ...session.workspace, profileIds: ["profile-1", "profile-2"] }
        }
      }).success
    ).toBe(false);
    expect(
      openWorkspaceResponseSchema.safeParse({
        ok: true,
        data: {
          ...session,
          sourceResources: [
            { ...session.sourceResources[0], workspaceId: "another-workspace" }
          ]
        }
      }).success
    ).toBe(false);
  });
});
