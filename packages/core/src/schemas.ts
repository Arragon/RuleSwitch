import { z } from "zod";

import {
  CHANGE_KINDS,
  CHANGE_SET_STATUSES,
  FILE_RESOURCE_FORMATS,
  FILE_RESOURCE_ORIGINS,
  HASH_ALGORITHM,
  HISTORY_KINDS,
  PROFILE_KINDS,
  REVISION_SERIALIZATION,
  TRANSACTION_STATES
} from "./contracts";
import type {
  ApplyTransaction,
  Change,
  ChangeSet,
  FileResource,
  FileRevision,
  HashDescriptor,
  HistoryEntry,
  PreviewRevision,
  Profile,
  RevisionAggregate,
  Snapshot,
  SnapshotFile,
  Target,
  TransactionFailure,
  Workspace
} from "./contracts";

const idSchema = z.string().trim().min(1);
const nonEmptyStringSchema = z.string().trim().min(1);

function isProviderNeutralLogicalPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export const logicalPathSchema = z.string().refine(isProviderNeutralLogicalPath, {
  message: "Expected a normalized forward-slash relative logical path"
});
const isoDateTimeSchema = z.string().datetime({ offset: true });
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const byteLengthSchema = z.number().int().nonnegative().safe();

function addUniqueIssues(
  values: readonly string[],
  field: string,
  context: z.RefinementCtx
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: `${field} must contain unique values`
    });
  }
}

export const hashDescriptorSchema: z.ZodType<HashDescriptor> = z.strictObject({
  algorithm: z.literal(HASH_ALGORITHM),
  digest: sha256DigestSchema
});

export const workspaceSchema: z.ZodType<Workspace> = z
  .strictObject({
    id: idSchema,
    name: nonEmptyStringSchema,
    rootResourceId: idSchema,
    profileIds: z.array(idSchema),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .superRefine((workspace, context) => {
    addUniqueIssues(workspace.profileIds, "profileIds", context);
  });

export const profileSchema: z.ZodType<Profile> = z
  .strictObject({
    id: idSchema,
    workspaceId: idSchema,
    name: nonEmptyStringSchema,
    kind: z.enum(PROFILE_KINDS),
    provider: nonEmptyStringSchema,
    sourceRootResourceId: idSchema,
    targetIds: z.array(idSchema)
  })
  .superRefine((profile, context) => {
    addUniqueIssues(profile.targetIds, "targetIds", context);
  });

export const targetSchema: z.ZodType<Target> = z
  .strictObject({
    id: idSchema,
    workspaceId: idSchema,
    name: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    providerTarget: nonEmptyStringSchema,
    features: z.array(nonEmptyStringSchema).min(1)
  })
  .superRefine((target, context) => {
    addUniqueIssues(target.features, "features", context);
  });

export const fileResourceSchema: z.ZodType<FileResource> = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  logicalPath: logicalPathSchema,
  origin: z.enum(FILE_RESOURCE_ORIGINS),
  format: z.enum(FILE_RESOURCE_FORMATS),
  readonly: z.boolean(),
  hash: hashDescriptorSchema,
  byteLength: byteLengthSchema
});

export const fileRevisionSchema: z.ZodType<FileRevision> = z.strictObject({
  resourceId: idSchema,
  hash: hashDescriptorSchema,
  byteLength: byteLengthSchema
});

export const revisionAggregateSchema: z.ZodType<RevisionAggregate> = z
  .strictObject({
    algorithm: z.literal(HASH_ALGORITHM),
    serialization: z.literal(REVISION_SERIALIZATION),
    digest: sha256DigestSchema,
    files: z.array(fileRevisionSchema)
  })
  .superRefine((aggregate, context) => {
    const resourceIds = aggregate.files.map((file) => file.resourceId);
    addUniqueIssues(resourceIds, "files.resourceId", context);

    for (let index = 1; index < resourceIds.length; index += 1) {
      const previous = resourceIds[index - 1];
      const current = resourceIds[index];
      if (previous !== undefined && current !== undefined && previous > current) {
        context.addIssue({
          code: "custom",
          message: "files must be sorted by resourceId for deterministic SHA-256 aggregation"
        });
        break;
      }
    }
  });

export const previewRevisionSchema: z.ZodType<PreviewRevision> = z.strictObject({
  sourceState: revisionAggregateSchema,
  targetState: revisionAggregateSchema,
  generatedState: revisionAggregateSchema
});

export const changeSchema: z.ZodType<Change> = z
  .strictObject({
    id: idSchema,
    targetId: idSchema,
    logicalPath: logicalPathSchema,
    kind: z.enum(CHANGE_KINDS),
    before: fileRevisionSchema.nullable(),
    after: fileRevisionSchema.nullable()
  })
  .superRefine((change, context) => {
    const beforeDigest = change.before?.hash.digest;
    const afterDigest = change.after?.hash.digest;

    if (change.kind === "create" && (change.before !== null || change.after === null)) {
      context.addIssue({ code: "custom", message: "create requires only an after revision" });
    }
    if (change.kind === "delete" && (change.before === null || change.after !== null)) {
      context.addIssue({ code: "custom", message: "delete requires only a before revision" });
    }
    if (change.kind === "modify") {
      if (change.before === null || change.after === null) {
        context.addIssue({ code: "custom", message: "modify requires before and after revisions" });
      } else if (beforeDigest === afterDigest) {
        context.addIssue({ code: "custom", message: "modify revisions must have different hashes" });
      }
    }
    if (change.kind === "unchanged") {
      if (change.before === null || change.after === null) {
        context.addIssue({ code: "custom", message: "unchanged requires before and after revisions" });
      } else if (
        beforeDigest !== afterDigest ||
        change.before.byteLength !== change.after.byteLength
      ) {
        context.addIssue({ code: "custom", message: "unchanged revisions must be identical" });
      }
    }
  });

export const changeSetSchema: z.ZodType<ChangeSet> = z
  .strictObject({
    id: idSchema,
    workspaceId: idSchema,
    profileId: idSchema,
    targetId: idSchema,
    status: z.enum(CHANGE_SET_STATUSES),
    previewRevision: previewRevisionSchema,
    changes: z.array(changeSchema).min(1),
    createdAt: isoDateTimeSchema
  })
  .superRefine((changeSet, context) => {
    addUniqueIssues(
      changeSet.changes.map((change) => change.id),
      "changes.id",
      context
    );
    addUniqueIssues(
      changeSet.changes.map((change) => change.logicalPath),
      "changes.logicalPath",
      context
    );

    if (changeSet.changes.some((change) => change.targetId !== changeSet.targetId)) {
      context.addIssue({
        code: "custom",
        message: "Every change must belong to the ChangeSet target"
      });
    }
  });

export const snapshotFileSchema: z.ZodType<SnapshotFile> = z
  .strictObject({
    logicalPath: logicalPathSchema,
    existed: z.boolean(),
    hash: hashDescriptorSchema.nullable(),
    content: z.instanceof(Uint8Array).nullable()
  })
  .superRefine((file, context) => {
    const hasOriginal = file.hash !== null && file.content !== null;
    if (file.existed !== hasOriginal) {
      context.addIssue({
        code: "custom",
        message: "Existing snapshot files require their original hash and bytes"
      });
    }
  });

export const snapshotSchema: z.ZodType<Snapshot> = z
  .strictObject({
    id: idSchema,
    workspaceId: idSchema,
    transactionId: idSchema,
    profileId: idSchema,
    targetIds: z.array(idSchema).min(1),
    provider: nonEmptyStringSchema,
    providerVersion: nonEmptyStringSchema,
    createdAt: isoDateTimeSchema,
    files: z.array(snapshotFileSchema).min(1)
  })
  .superRefine((snapshot, context) => {
    addUniqueIssues(snapshot.targetIds, "targetIds", context);
    addUniqueIssues(
      snapshot.files.map((file) => file.logicalPath),
      "files.logicalPath",
      context
    );
  });

export const transactionFailureSchema: z.ZodType<TransactionFailure> = z.strictObject({
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  affectedResourceIds: z.array(idSchema)
});

export const applyTransactionSchema: z.ZodType<ApplyTransaction> = z
  .strictObject({
    id: idSchema,
    operation: z.enum(HISTORY_KINDS),
    workspaceId: idSchema,
    changeSetId: idSchema.nullable(),
    restoreHistoryEntryId: idSchema.nullable(),
    snapshotId: idSchema.nullable(),
    state: z.enum(TRANSACTION_STATES),
    failure: transactionFailureSchema.nullable(),
    startedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable()
  })
  .superRefine((transaction, context) => {
    if (
      transaction.operation === "apply" &&
      (transaction.changeSetId === null || transaction.restoreHistoryEntryId !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Apply transactions require only a changeSetId"
      });
    }
    if (
      transaction.operation === "restore" &&
      (transaction.restoreHistoryEntryId === null || transaction.changeSetId !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Restore transactions require only a restoreHistoryEntryId"
      });
    }
  });

export const historyEntrySchema: z.ZodType<HistoryEntry> = z
  .strictObject({
    id: idSchema,
    workspaceId: idSchema,
    kind: z.enum(HISTORY_KINDS),
    transactionId: idSchema,
    snapshotId: idSchema,
    changeSetId: idSchema.nullable(),
    restoredFromHistoryEntryId: idSchema.nullable(),
    createdAt: isoDateTimeSchema,
    summary: nonEmptyStringSchema
  })
  .superRefine((entry, context) => {
    if (entry.kind === "apply" && entry.changeSetId === null) {
      context.addIssue({ code: "custom", message: "Apply history requires a changeSetId" });
    }
    if (entry.kind === "restore" && entry.restoredFromHistoryEntryId === null) {
      context.addIssue({
        code: "custom",
        message: "Restore history requires a source history entry"
      });
    }
  });
