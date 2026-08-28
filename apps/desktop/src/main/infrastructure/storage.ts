import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  applyTransactionSchema,
  historyEntrySchema,
  logicalPathSchema,
  snapshotSchema,
  type ApplyTransaction,
  type ChangeKind,
  type EntityId,
  type HistoryEntry,
  type Snapshot
} from "@ruleswitch/core";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

const VERSION = 1 as const;
const SNAPSHOT_VERSION = 2 as const;
const safeIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotPayloadSchema = z.string().regex(/^files\/[0-9]{6}\.bin$/);

export interface TransactionLedgerEntry {
  readonly logicalPath: string;
  readonly kind: ChangeKind;
  readonly expectedAfterDigest: string | null;
  readonly mutationStarted: boolean;
  readonly mutationCompleted: boolean;
}

export interface TransactionManifest {
  readonly version: typeof VERSION;
  readonly transaction: ApplyTransaction;
  readonly profileId: EntityId;
  readonly targetId: EntityId;
  readonly rootResourceId: EntityId;
  readonly workspaceRootIdentity: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly ledger: readonly TransactionLedgerEntry[];
  readonly failureCode: string | null;
}

const transactionLedgerSchema = z.strictObject({
  logicalPath: z.string().min(1),
  kind: z.enum(["create", "modify", "delete", "unchanged"]),
  expectedAfterDigest: digestSchema.nullable(),
  mutationStarted: z.boolean(),
  mutationCompleted: z.boolean()
});
const transactionManifestSchema: z.ZodType<TransactionManifest> = z.strictObject({
  version: z.literal(VERSION),
  transaction: applyTransactionSchema,
  profileId: z.string().min(1),
  targetId: z.string().min(1),
  rootResourceId: z.string().min(1),
  workspaceRootIdentity: digestSchema,
  provider: z.string().min(1),
  providerVersion: z.string().min(1),
  ledger: z.array(transactionLedgerSchema),
  failureCode: z.string().min(1).nullable()
});

const ownershipEntrySchema = z.strictObject({
  logicalPath: logicalPathSchema,
  profileId: safeIdSchema,
  provider: z.string().min(1),
  digest: digestSchema
});
const ownershipEntriesSchema = z.array(ownershipEntrySchema).superRefine((entries, context) => {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.logicalPath)) {
      context.addIssue({ code: "custom", message: "Ownership paths must be unique." });
    }
    paths.add(entry.logicalPath);
  }
});
const snapshotFileManifestSchema = z.strictObject({
  logicalPath: logicalPathSchema,
  existed: z.boolean(),
  hash: z.strictObject({ algorithm: z.literal("sha256"), digest: digestSchema }).nullable(),
  payload: snapshotPayloadSchema.nullable()
});
const snapshotManifestSchema = z
  .strictObject({
    version: z.literal(SNAPSHOT_VERSION),
    id: safeIdSchema,
    workspaceId: safeIdSchema,
    transactionId: safeIdSchema,
    profileId: safeIdSchema,
    targetIds: z.array(safeIdSchema).min(1),
    provider: z.string().min(1),
    providerVersion: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    files: z.array(snapshotFileManifestSchema).min(1),
    ownership: ownershipEntriesSchema
  })
  .superRefine((manifest, context) => {
    const filesByPath = new Map<string, (typeof manifest.files)[number]>();
    const payloads = new Set<string>();
    for (const file of manifest.files) {
      if (filesByPath.has(file.logicalPath)) {
        context.addIssue({ code: "custom", message: "Snapshot paths must be unique." });
      }
      filesByPath.set(file.logicalPath, file);
      if (file.existed !== (file.hash !== null && file.payload !== null)) {
        context.addIssue({
          code: "custom",
          message: "Snapshot existence, digest, and payload metadata are inconsistent."
        });
      }
      if (file.payload !== null) {
        if (payloads.has(file.payload)) {
          context.addIssue({ code: "custom", message: "Snapshot payload paths must be unique." });
        }
        payloads.add(file.payload);
      }
    }
    for (const ownership of manifest.ownership) {
      const file = filesByPath.get(ownership.logicalPath);
      if (file === undefined || !file.existed || file.hash?.digest !== ownership.digest) {
        context.addIssue({
          code: "custom",
          message: "Snapshot ownership must match an existing captured file and digest."
        });
      }
      if (ownership.profileId !== manifest.profileId || ownership.provider !== manifest.provider) {
        context.addIssue({
          code: "custom",
          message: "Snapshot ownership must match the captured profile and provider."
        });
      }
    }
  });

const historyFileSchema = z.strictObject({
  version: z.literal(VERSION),
  entries: z.array(historyEntrySchema)
});
const ownershipFileSchema = z.strictObject({
  version: z.literal(VERSION),
  workspaceId: safeIdSchema,
  entries: ownershipEntriesSchema
});

export interface OwnershipEntry {
  readonly logicalPath: string;
  readonly profileId: EntityId;
  readonly provider: string;
  readonly digest: string;
}

export interface StoredSnapshotRecord {
  readonly snapshot: Snapshot;
  readonly ownership: readonly OwnershipEntry[];
}

/** Filesystem-first, versioned stores rooted beneath PlatformService app data. */
export class DesktopStores {
  constructor(private readonly appDataRoot: string) {}

  async saveSnapshot(record: StoredSnapshotRecord): Promise<void> {
    const snapshot = snapshotSchema.parse(record.snapshot);
    const ownership = ownershipEntriesSchema.parse(record.ownership);
    requireSafeId(snapshot.workspaceId);
    requireSafeId(snapshot.id);
    const snapshotRoot = path.join(
      this.appDataRoot,
      "snapshots",
      snapshot.workspaceId,
      snapshot.id
    );
    const files = snapshot.files.map((file, index) => ({
      logicalPath: file.logicalPath,
      existed: file.existed,
      hash: file.hash,
      payload: file.existed ? `files/${index.toString().padStart(6, "0")}.bin` : null
    }));
    const manifest = snapshotManifestSchema.parse({
      version: SNAPSHOT_VERSION,
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      transactionId: snapshot.transactionId,
      profileId: snapshot.profileId,
      targetIds: snapshot.targetIds,
      provider: snapshot.provider,
      providerVersion: snapshot.providerVersion,
      createdAt: snapshot.createdAt,
      files,
      ownership
    });

    await mkdir(path.join(snapshotRoot, "files"), { recursive: true });
    for (let index = 0; index < snapshot.files.length; index += 1) {
      const file = snapshot.files[index];
      const storedFile = manifest.files[index];
      if (file === undefined || storedFile === undefined) {
        throw new Error("Snapshot file indexing failed.");
      }
      if (file.existed) {
        if (
          file.content === null ||
          file.hash === null ||
          storedFile.payload === null ||
          hashBytes(file.content) !== file.hash.digest
        ) {
          throw new Error("Existing snapshot entries require matching raw bytes and a digest.");
        }
        await atomicWrite(resolveContainedSnapshotPayload(snapshotRoot, storedFile.payload), file.content);
      }
    }
    await atomicJson(path.join(snapshotRoot, "manifest.json"), manifest);
  }

  async loadSnapshot(workspaceId: EntityId, snapshotId: EntityId): Promise<StoredSnapshotRecord> {
    requireSafeId(workspaceId);
    requireSafeId(snapshotId);
    const snapshotRoot = path.join(this.appDataRoot, "snapshots", workspaceId, snapshotId);
    const manifest = snapshotManifestSchema.parse(
      JSON.parse(await readFile(path.join(snapshotRoot, "manifest.json"), "utf8"))
    );
    if (manifest.workspaceId !== workspaceId || manifest.id !== snapshotId) {
      throw new Error("Snapshot metadata ownership does not match its storage location.");
    }
    const files = await Promise.all(
      manifest.files.map(async (file) => {
        const content =
          file.payload === null
            ? null
            : new Uint8Array(
                await readFile(resolveContainedSnapshotPayload(snapshotRoot, file.payload))
              );
        if (file.existed) {
          if (content === null || file.hash === null || hashBytes(content) !== file.hash.digest) {
            throw new Error("Snapshot payload validation failed.");
          }
        } else if (content !== null || file.hash !== null) {
          throw new Error("An absent snapshot entry cannot contain payload data.");
        }
        return {
          logicalPath: file.logicalPath,
          existed: file.existed,
          hash: file.hash,
          content
        };
      })
    );
    const snapshot = snapshotSchema.parse({
      id: manifest.id,
      workspaceId: manifest.workspaceId,
      transactionId: manifest.transactionId,
      profileId: manifest.profileId,
      targetIds: manifest.targetIds,
      provider: manifest.provider,
      providerVersion: manifest.providerVersion,
      createdAt: manifest.createdAt,
      files
    });
    return { snapshot, ownership: manifest.ownership };
  }

  async saveTransaction(manifest: TransactionManifest): Promise<void> {
    const parsed = transactionManifestSchema.parse(manifest);
    requireSafeId(parsed.transaction.id);
    const directory = path.join(this.appDataRoot, "transactions", parsed.transaction.id);
    await mkdir(directory, { recursive: true });
    await atomicJson(path.join(directory, "manifest.json"), parsed);
  }

  async scanIncompleteTransactions(): Promise<readonly TransactionManifest[]> {
    const transactionsRoot = path.join(this.appDataRoot, "transactions");
    let entries;
    try {
      entries = await readdir(transactionsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    const incomplete: TransactionManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeIdSchema.safeParse(entry.name).success) {
        continue;
      }
      try {
        const parsed = transactionManifestSchema.parse(
          JSON.parse(await readFile(path.join(transactionsRoot, entry.name, "manifest.json"), "utf8"))
        );
        if (!["COMMITTED", "ROLLED_BACK", "RECOVERY_REQUIRED"].includes(parsed.transaction.state)) {
          incomplete.push(parsed);
        }
      } catch {
        console.error(JSON.stringify({ event: "transaction_manifest_invalid", transactionId: entry.name }));
      }
    }
    return incomplete;
  }

  async listHistory(workspaceId: EntityId): Promise<readonly HistoryEntry[]> {
    requireSafeId(workspaceId);
    const file = path.join(this.appDataRoot, "history", workspaceId, "entries.json");
    try {
      const parsed = historyFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.entries.some((entry) => entry.workspaceId !== workspaceId)) {
        throw new Error("History workspace ownership validation failed.");
      }
      return parsed.entries;
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
  }

  async appendHistory(entry: HistoryEntry): Promise<void> {
    historyEntrySchema.parse(entry);
    const entries = [...(await this.listHistory(entry.workspaceId)), entry];
    await this.writeHistory(entry.workspaceId, entries);
  }

  async removeHistory(workspaceId: EntityId, historyEntryId: EntityId): Promise<void> {
    const entries = (await this.listHistory(workspaceId)).filter((entry) => entry.id !== historyEntryId);
    await this.writeHistory(workspaceId, entries);
  }

  async findHistoryEntry(historyEntryId: EntityId): Promise<HistoryEntry | null> {
    requireSafeId(historyEntryId);
    const historyRoot = path.join(this.appDataRoot, "history");
    let workspaces;
    try {
      workspaces = await readdir(historyRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory() || !safeIdSchema.safeParse(workspace.name).success) {
        continue;
      }
      const found = (await this.listHistory(workspace.name)).find((entry) => entry.id === historyEntryId);
      if (found !== undefined) {
        return found;
      }
    }
    return null;
  }

  async listOwnership(workspaceId: EntityId): Promise<readonly OwnershipEntry[]> {
    requireSafeId(workspaceId);
    const file = path.join(this.appDataRoot, "ownership", workspaceId, "manifest.json");
    try {
      const parsed = ownershipFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.workspaceId !== workspaceId) {
        throw new Error("Ownership metadata does not belong to this workspace.");
      }
      return parsed.entries;
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
  }

  async replaceOwnership(
    workspaceId: EntityId,
    entries: readonly OwnershipEntry[]
  ): Promise<void> {
    requireSafeId(workspaceId);
    const parsed = ownershipFileSchema.parse({ version: VERSION, workspaceId, entries });
    const file = path.join(this.appDataRoot, "ownership", workspaceId, "manifest.json");
    await atomicJson(file, parsed);
  }

  private async writeHistory(workspaceId: EntityId, entries: readonly HistoryEntry[]): Promise<void> {
    requireSafeId(workspaceId);
    const parsed = historyFileSchema.parse({ version: VERSION, entries });
    const file = path.join(this.appDataRoot, "history", workspaceId, "entries.json");
    await atomicJson(file, parsed);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
}

async function atomicWrite(filePath: string, content: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, Buffer.from(content), { fsync: true });
}

function resolveContainedSnapshotPayload(snapshotRoot: string, payload: string): string {
  snapshotPayloadSchema.parse(payload);
  const resolvedRoot = path.resolve(snapshotRoot);
  const resolvedPayload = path.resolve(resolvedRoot, payload);
  const relative = path.relative(resolvedRoot, resolvedPayload);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Snapshot payload escapes its storage root.");
  }
  return resolvedPayload;
}

function requireSafeId(id: string): void {
  safeIdSchema.parse(id);
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
