import type { RulesyncProviderInfrastructure } from "./infrastructure";
import { RulesyncProvider } from "./rulesync-provider";
import { describe, expect, test } from "vitest";

const unused = async (): Promise<never> => {
  throw new Error("Unexpected infrastructure call.");
};

describe("Rulesync source portable path policy", () => {
  test("rejects exact paths that collide under case-insensitive comparison on every host OS", async () => {
    const infrastructure: RulesyncProviderInfrastructure = {
      resolveAuthorizedRootPath: unused,
      resolveAuthorizedResourcePath: unused,
      registerDirectoryRoot: async () => "source-root",
      createEmptyStagingRoot: unused,
      enumerateSafeFiles: async () => [
        { logicalPath: "Rules/Base.md" },
        { logicalPath: "rules/base.md" }
      ],
      registerFileResource: unused,
      registerFileResourceIfExists: unused,
      refreshFileResource: unused,
      readResourceBytes: unused,
      aggregateRevision: unused,
      createOpaqueId: () => "unused-id",
      nowIso: () => "2026-08-29T00:00:00.000Z"
    };

    await expect(
      new RulesyncProvider(infrastructure).detect({
        workspaceId: "workspace-1",
        rootResourceId: "workspace-root"
      })
    ).rejects.toThrow(/case-insensitively colliding logical paths/i);
  });
});
