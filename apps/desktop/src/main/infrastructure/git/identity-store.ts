// Stable repository/device identity store (INH-1764): versioned envelope,
// atomic writes, restart-stable repositoryId/deviceId, pending-publish flag
// persistence, and rebind-by-identity when a repo moves or is re-cloned.
//
// Corruption/migration semantics come from @ruleswitch/core v2 stores
// contract: legacy Phase A data stays read-only; corrupt or future-version
// files block destructive mutations instead of being overwritten.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseStoreEnvelope,
  type StoreLoadResult,
  type DeviceId,
  type RepositoryId,
  type CanonicalRemote
} from "@ruleswitch/core";

export interface RepositoryBinding {
  readonly repositoryId: RepositoryId;
  readonly canonicalRemote: CanonicalRemote;
  /** Local working-copy path; updated on move/re-clone, never part of identity. */
  localPath: string;
  lastOpenedAt: string;
  pendingPublish: boolean;
}

interface IdentityStoreData {
  device: { readonly deviceId: DeviceId } | null;
  repositories: Record<string, RepositoryBinding>;
}

export class IdentityStoreError extends Error {
  constructor(
    message: string,
    readonly gate:
      | "blocked-corrupt"
      | "blocked-future-version"
      | "blocked-migration-failed"
  ) {
    super(message);
    this.name = "IdentityStoreError";
  }
}

export class RepositoryIdentityStore {
  private data: IdentityStoreData | null = null;

  constructor(private readonly storePath: string) {}

  /** Loads (or lazily initializes) the store; blocked gates throw. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { device: null, repositories: {} };
        return;
      }
      throw error;
    }
    const result: StoreLoadResult = parseStoreEnvelope(raw, "repositories");
    if (result.kind !== "ok") {
      // Quarantine by renaming (never delete), then block mutations.
      if (result.kind === "corrupt" || result.kind === "wrong-store") {
        await rename(this.storePath, `${this.storePath}.corrupt-${Date.now()}`);
      }
      const gate =
        result.kind === "future-version" ? "blocked-future-version" : "blocked-corrupt";
      throw new IdentityStoreError(
        result.kind === "future-version"
          ? `identity store version ${result.version} is newer than supported`
          : `identity store is ${result.kind}`,
        gate
      );
    }
    const data = result.envelope.data as Partial<IdentityStoreData>;
    this.data = {
      device: data.device ?? null,
      repositories: data.repositories ?? {}
    };
  }

  /** Device ID is generated exactly once per store. */
  async ensureDeviceId(): Promise<DeviceId> {
    await this.ensureLoaded();
    if (this.data && this.data.device) {
      return this.data.device.deviceId;
    }
    const deviceId = `dev_${randomBytes(32).toString("hex")}`;
    if (this.data) {
      this.data.device = { deviceId };
    }
    await this.persist();
    return deviceId;
  }

  /** Binds or re-binds a repository identity to a local path (move/re-clone safe). */
  async bindRepository(
    repositoryId: RepositoryId,
    canonicalRemote: CanonicalRemote,
    localPath: string
  ): Promise<RepositoryBinding> {
    await this.ensureLoaded();
    const existing = this.data?.repositories[repositoryId];
    const binding: RepositoryBinding = {
      repositoryId,
      canonicalRemote,
      localPath,
      lastOpenedAt: new Date().toISOString(),
      pendingPublish: existing?.pendingPublish ?? false
    };
    if (this.data) {
      this.data.repositories[repositoryId] = binding;
    }
    await this.persist();
    return binding;
  }

  findRepository(repositoryId: RepositoryId): RepositoryBinding | null {
    return this.data?.repositories[repositoryId] ?? null;
  }

  /** Finds a previously bound repository whose local path matches (local-only rebind). */
  findByLocalPath(localPath: string): RepositoryBinding | null {
    const match = Object.values(this.data?.repositories ?? {}).find(
      (binding) => binding.canonicalRemote.startsWith("local://") && binding.localPath === localPath
    );
    return match ?? null;
  }

  /** Finds a previously bound repository whose canonical remote matches. */
  findByCanonicalRemote(canonicalRemote: CanonicalRemote): RepositoryBinding | null {
    const match = Object.values(this.data?.repositories ?? {}).find(
      (binding) => binding.canonicalRemote === canonicalRemote
    );
    return match ?? null;
  }

  async setPendingPublish(repositoryId: RepositoryId, pendingPublish: boolean): Promise<void> {
    await this.ensureLoaded();
    const existing = this.data?.repositories[repositoryId];
    if (existing && this.data) {
      this.data.repositories[repositoryId] = { ...existing, pendingPublish };
      await this.persist();
    }
  }

  async updateLocalPath(repositoryId: RepositoryId, localPath: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.data?.repositories[repositoryId];
    if (existing && this.data) {
      this.data.repositories[repositoryId] = { ...existing, localPath };
      await this.persist();
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data === null) {
      await this.load();
    }
  }

  private async persist(): Promise<void> {
    if (!this.data) {
      return;
    }
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const envelope = {
      store: "repositories",
      version: 1,
      writtenAt: new Date().toISOString(),
      data: this.data
    };
    // Atomic replace: temp file in the same directory, then rename.
    const temporaryPath = `${this.storePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.storePath);
  }
}
