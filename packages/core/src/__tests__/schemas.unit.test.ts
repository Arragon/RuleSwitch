import { describe, expect, it } from "vitest";

import { HASH_ALGORITHM, REVISION_SERIALIZATION } from "../contracts";
import {
  changeSetSchema,
  fileResourceSchema,
  logicalPathSchema,
  profileSchema,
  targetSchema
} from "../schemas";

const zeroDigest = "0".repeat(64);
const oneDigest = "1".repeat(64);

const emptyAggregate = {
  algorithm: HASH_ALGORITHM,
  serialization: REVISION_SERIALIZATION,
  digest: zeroDigest,
  files: []
};

const beforeRevision = {
  resourceId: "current-resource",
  hash: { algorithm: HASH_ALGORITHM, digest: zeroDigest },
  byteLength: 10
};

const afterRevision = {
  resourceId: "generated-resource",
  hash: { algorithm: HASH_ALGORITHM, digest: oneDigest },
  byteLength: 12
};

const validChangeSet = {
  id: "change-set-1",
  workspaceId: "workspace-1",
  profileId: "profile-1",
  targetId: "target-1",
  status: "ready" as const,
  previewRevision: {
    sourceState: emptyAggregate,
    targetState: emptyAggregate,
    generatedState: emptyAggregate
  },
  changes: [
    {
      id: "change-1",
      targetId: "target-1",
      logicalPath: "AGENTS.md",
      kind: "modify" as const,
      before: beforeRevision,
      after: afterRevision
    }
  ],
  createdAt: "2026-08-01T00:00:00.000Z"
};

describe("Profile schema", () => {
  it("supports universal and native providers", () => {
    const baseProfile = {
      id: "profile-1",
      workspaceId: "workspace-1",
      name: "Default",
      provider: "rulesync",
      sourceRootResourceId: "source-root",
      targetIds: ["target-1"]
    };

    expect(profileSchema.safeParse({ ...baseProfile, kind: "universal" }).success).toBe(true);
    expect(
      profileSchema.safeParse({ ...baseProfile, kind: "native", provider: "cursor" }).success
    ).toBe(true);
  });

  it("rejects an empty provider, unknown kind, and duplicate targets", () => {
    const profile = {
      id: "profile-1",
      workspaceId: "workspace-1",
      name: "Default",
      kind: "universal",
      provider: "rulesync",
      sourceRootResourceId: "source-root",
      targetIds: ["target-1"]
    };

    expect(profileSchema.safeParse({ ...profile, provider: "" }).success).toBe(false);
    expect(profileSchema.safeParse({ ...profile, kind: "other" }).success).toBe(false);
    const legacyProfile = {
      id: profile.id,
      workspaceId: profile.workspaceId,
      name: profile.name,
      kind: profile.kind,
      provider: profile.provider,
      sourceResourceId: "selected-source",
      targetIds: profile.targetIds
    };
    expect(profileSchema.safeParse(legacyProfile).success).toBe(false);
    expect(profileSchema.safeParse({ ...profile, targetIds: ["target-1", "target-1"] }).success).toBe(
      false
    );
  });
});

describe("Target schema", () => {
  const target = {
    id: "target-1",
    workspaceId: "workspace-1",
    name: "Codex",
    provider: "rulesync",
    providerTarget: "codexcli",
    features: ["rules", "commands"]
  };

  it("accepts provider target metadata", () => {
    expect(targetSchema.safeParse(target).success).toBe(true);
  });

  it("requires at least one unique feature", () => {
    expect(targetSchema.safeParse({ ...target, features: [] }).success).toBe(false);
    expect(targetSchema.safeParse({ ...target, features: ["rules", "rules"] }).success).toBe(false);
  });
});

describe("logical path schema", () => {
  it.each(["rules/base.md", ".rulesync/rules/project.md", "AGENTS.md"])(
    "accepts normalized relative path %s",
    (logicalPath) => {
      expect(logicalPathSchema.safeParse(logicalPath).success).toBe(true);
    }
  );

  it.each([
    "",
    "/absolute/file.md",
    "C:/absolute/file.md",
    "rules\\file.md",
    ".",
    "..",
    "rules/./file.md",
    "rules/../file.md",
    "rules//file.md",
    "rules/file.md\0"
  ])("rejects unsafe or non-normalized path %j", (logicalPath) => {
    expect(logicalPathSchema.safeParse(logicalPath).success).toBe(false);
  });

  it("applies the same invariant to FileResource", () => {
    expect(
      fileResourceSchema.safeParse({
        id: "source-1",
        workspaceId: "workspace-1",
        logicalPath: "../escape.md",
        origin: "source",
        format: "markdown",
        readonly: true,
        hash: { algorithm: HASH_ALGORITHM, digest: zeroDigest },
        byteLength: 10
      }).success
    ).toBe(false);
  });
});

describe("ChangeSet schema", () => {
  it("accepts a target-consistent change with a bound preview revision", () => {
    expect(changeSetSchema.safeParse(validChangeSet).success).toBe(true);
  });

  it("enforces revision semantics for each change kind", () => {
    const invalidCreate = {
      ...validChangeSet,
      changes: [
        {
          ...validChangeSet.changes[0],
          kind: "create",
          before: beforeRevision
        }
      ]
    };
    const unchangedModify = {
      ...validChangeSet,
      changes: [
        {
          ...validChangeSet.changes[0],
          after: beforeRevision
        }
      ]
    };

    expect(changeSetSchema.safeParse(invalidCreate).success).toBe(false);
    expect(changeSetSchema.safeParse(unchangedModify).success).toBe(false);
  });

  it("rejects duplicate logical paths and changes for another target", () => {
    const duplicatePath = {
      ...validChangeSet,
      changes: [
        validChangeSet.changes[0],
        { ...validChangeSet.changes[0], id: "change-2" }
      ]
    };
    const wrongTarget = {
      ...validChangeSet,
      changes: [{ ...validChangeSet.changes[0], targetId: "target-2" }]
    };

    expect(changeSetSchema.safeParse(duplicatePath).success).toBe(false);
    expect(changeSetSchema.safeParse(wrongTarget).success).toBe(false);
  });
});
