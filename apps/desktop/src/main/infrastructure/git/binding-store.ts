// Local binding stores (INH-1772): device-local bindings for projects and
// harness registrations, persisted as versioned envelopes with atomic
// writes. These stores are NEVER a second source of config content — only
// local paths, identities, and availability metadata; no asset bytes, no
// credentials, no secret values.
//
// Deleting the store files must always be recoverable by re-bootstrapping
// from Git (the INH-1772 DoD); corruption quarantines instead of deleting.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseStoreEnvelope,
  type CanonicalRemote,
  type RepositoryId,
  type StoreLoadResult,
  type StoreName
} from "@ruleswitch/core";

export class BindingStoreError extends Error {
  constructor(
    message: string,
    readonly gate: "blocked-corrupt" | "blocked-future-version"
  ) {
    super(message);
    this.name = "BindingStoreError";
  }
}

export interface WriteFaultInjector {
  /** Returns an error to inject before the atomic rename, for tests. */
  beforeRename(): Error | null;
}

export class VersionedStore<T extends object> {
  private data: T | null = null;

  constructor(
    private readonly storePath: string,
    private readonly storeName: StoreName,
    private readonly createEmpty: () => T,
    private readonly faults?: WriteFaultInjector
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = this.createEmpty();
        return;
      }
      throw error;
    }
    const result: StoreLoadResult<unknown> = parseStoreEnvelope(raw, this.storeName);
    if (result.kind !== "ok") {
      if (result.kind === "corrupt" || result.kind === "wrong-store") {
        await rename(this.storePath, `${this.storePath}.corrupt-${Date.now()}`);
      }
      throw new BindingStoreError(
        result.kind === "future-version"
          ? `${this.storeName} store version ${result.version} is newer than supported`
          : `${this.storeName} store is ${result.kind}`,
        result.kind === "future-version" ? "blocked-future-version" : "blocked-corrupt"
      );
    }
    this.data = result.envelope.data as T;
  }

  current(): T {
    if (this.data === null) {
      throw new Error(`${this.storeName} store used before load()`);
    }
    return this.data;
  }

  async mutate(mutate: (data: T) => void): Promise<void> {
    mutate(this.current());
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.data === null) {
      return;
    }
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const envelope = {
      store: this.storeName,
      version: 1,
      writtenAt: new Date().toISOString(),
      data: this.data
    };
    const temporaryPath = `${this.storePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const injected = this.faults?.beforeRename() ?? null;
    if (injected !== null) {
      await rm(temporaryPath, { force: true });
      throw injected;
    }
    try {
      await rename(temporaryPath, this.storePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Projects store
// ---------------------------------------------------------------------------

export interface ProjectBindingRecord {
  readonly projectId: string;
  readonly repositoryId: RepositoryId;
  localPath: string;
  readonly displayName: string;
  lastVerifiedAt: string;
  available: boolean;
}

export interface ProjectsStoreData {
  readonly bindings: Record<string, ProjectBindingRecord>;
}

export class ProjectsStore extends VersionedStore<ProjectsStoreData> {
  constructor(storePath: string, faults?: WriteFaultInjector) {
    super(storePath, "projects", () => ({ bindings: {} }), faults);
  }

  async bindProject(record: Omit<ProjectBindingRecord, "lastVerifiedAt" | "available">): Promise<void> {
    await this.mutate((data) => {
      data.bindings[record.projectId] = {
        ...record,
        lastVerifiedAt: new Date().toISOString(),
        available: true
      };
    });
  }

  findProject(projectId: string): ProjectBindingRecord | null {
    return this.current().bindings[projectId] ?? null;
  }

  /** Marks a moved/missing project unavailable; the config record is never deleted. */
  async markAvailability(projectId: string, available: boolean): Promise<void> {
    await this.mutate((data) => {
      const existing = data.bindings[projectId];
      if (existing) {
        existing.available = available;
        existing.lastVerifiedAt = new Date().toISOString();
      }
    });
  }

  async rebindPath(projectId: string, localPath: string): Promise<void> {
    await this.mutate((data) => {
      const existing = data.bindings[projectId];
      if (existing) {
        existing.localPath = localPath;
        existing.available = true;
        existing.lastVerifiedAt = new Date().toISOString();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Harness registry store
// ---------------------------------------------------------------------------

export interface HarnessRegistrationRecord {
  readonly harnessInstanceId: string;
  readonly adapterId: string;
  displayName: string;
  readonly presetMatched: boolean;
  readonly customIcon: string | null;
  readonly customFormatHints: readonly string[];
  installed: boolean;
  readonly registeredAt: string;
}

export interface HarnessRegistryStoreData {
  readonly registrations: Record<string, HarnessRegistrationRecord>;
}

export class HarnessRegistryStore extends VersionedStore<HarnessRegistryStoreData> {
  constructor(storePath: string, faults?: WriteFaultInjector) {
    super(storePath, "harness-registry", () => ({ registrations: {} }), faults);
  }

  async upsertRegistration(record: Omit<HarnessRegistrationRecord, "registeredAt">): Promise<void> {
    await this.mutate((data) => {
      const existing = data.registrations[record.harnessInstanceId];
      data.registrations[record.harnessInstanceId] = {
        ...record,
        registeredAt: existing?.registeredAt ?? new Date().toISOString()
      };
    });
  }

  listRegistrations(): readonly HarnessRegistrationRecord[] {
    return Object.values(this.current().registrations).sort((left, right) =>
      left.harnessInstanceId < right.harnessInstanceId ? -1 : 1
    );
  }

  async setInstalled(harnessInstanceId: string, installed: boolean): Promise<void> {
    await this.mutate((data) => {
      const existing = data.registrations[harnessInstanceId];
      if (existing) {
        existing.installed = installed;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Selected profiles / repository settings store
// ---------------------------------------------------------------------------

export interface SettingsStoreData {
  readonly selectedProfiles: Record<string, string>;
  theme: "light" | "dark" | "system";
}

export class SettingsStore extends VersionedStore<SettingsStoreData> {
  constructor(storePath: string, faults?: WriteFaultInjector) {
    super(storePath, "settings", () => ({ selectedProfiles: {}, theme: "light" }), faults);
  }

  async selectProfile(repositoryId: RepositoryId, profile: string): Promise<void> {
    await this.mutate((data) => {
      data.selectedProfiles[repositoryId] = profile;
    });
  }

  selectedProfile(repositoryId: RepositoryId): string | null {
    return this.current().selectedProfiles[repositoryId] ?? null;
  }

  async setTheme(theme: "light" | "dark" | "system"): Promise<void> {
    await this.mutate((data) => {
      data.theme = theme;
    });
  }
}

/** Directory probe used to verify project bindings against the real filesystem. */
export async function probeDirectory(localPath: string): Promise<
  { kind: "git-repo"; canonicalRemote: CanonicalRemote } | { kind: "not-a-repo" } | { kind: "unreadable" }
> {
  try {
    await stat(localPath);
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const { createGitRuntime } = await import("./git-runtime");
    const runtime = await createGitRuntime();
    const topLevel = await runtime.run(["rev-parse", "--show-toplevel"], { cwd: localPath });
    if (!topLevel.ok) {
      return { kind: "not-a-repo" };
    }
    const originUrl = await runtime.run(["remote", "get-url", "origin"], { cwd: topLevel.stdout.trim() });
    if (!originUrl.ok) {
      return { kind: "not-a-repo" };
    }
    const { normalizeGitRemoteUrl } = await import("@ruleswitch/core");
    return { kind: "git-repo", canonicalRemote: normalizeGitRemoteUrl(originUrl.stdout.trim()) as CanonicalRemote };
  } catch {
    return { kind: "not-a-repo" };
  }
}
