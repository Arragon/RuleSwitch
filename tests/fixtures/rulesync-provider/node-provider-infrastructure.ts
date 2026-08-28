import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import path from "node:path";

import type {
  EntityId,
  FileResource,
  FileRevision,
  RevisionAggregate
} from "../../../packages/core/src/index";
import {
  type RegisterFileRequest,
  type RegisterRootRequest,
  type RulesyncProviderInfrastructure,
  type SafeFileEntry,
  type SymlinkPolicy
} from "../../../packages/rulesync-provider/src/index";

interface RootRecord {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly absolutePath: string;
  readonly canonicalPath: string;
}

interface ResourceRecord {
  readonly request: RegisterFileRequest;
  readonly absolutePath: string;
  resource: FileResource;
}

interface InspectedFile {
  readonly canonicalPath: string;
  readonly bytes: Uint8Array;
}

export class UnsafeFilesystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFilesystemError";
  }
}

/** Real Node filesystem implementation used only by provider integration tests. */
export class NodeProviderInfrastructure implements RulesyncProviderInfrastructure {
  private readonly roots = new Map<EntityId, RootRecord>();
  private readonly rootsByRegistration = new Map<string, EntityId>();
  private readonly resources = new Map<EntityId, ResourceRecord>();
  private readonly resourcesByRegistration = new Map<string, EntityId>();

  constructor(private readonly stagingParent: string) {}

  async registerWorkspaceRoot(workspaceId: EntityId, absolutePath: string): Promise<EntityId> {
    const canonicalPath = await realpath(path.resolve(absolutePath));
    const details = await stat(canonicalPath);
    if (!details.isDirectory()) {
      throw new UnsafeFilesystemError("The workspace root is not a directory.");
    }

    const id = `root:${randomUUID()}`;
    this.roots.set(id, {
      id,
      workspaceId,
      absolutePath: canonicalPath,
      canonicalPath
    });
    return id;
  }

  async resolveAuthorizedRootPath(
    workspaceId: EntityId,
    rootResourceId: EntityId
  ): Promise<string> {
    const root = this.requireRoot(workspaceId, rootResourceId);
    const currentCanonical = await realpath(root.absolutePath);
    if (!sameCanonicalPath(currentCanonical, root.canonicalPath)) {
      throw new UnsafeFilesystemError("An authorized root changed identity.");
    }
    return currentCanonical;
  }

  async resolveAuthorizedResourcePath(
    workspaceId: EntityId,
    resourceId: EntityId
  ): Promise<string> {
    const record = this.requireResource(workspaceId, resourceId);
    const root = this.requireRoot(workspaceId, record.request.rootResourceId);
    const inspected = await inspectFile(root, record.absolutePath, record.request.symlinkPolicy);
    return inspected.canonicalPath;
  }

  async registerDirectoryRoot(request: RegisterRootRequest): Promise<EntityId | null> {
    const parent = this.requireRoot(request.workspaceId, request.parentRootResourceId);
    const absolutePath = resolveLogicalPath(parent.canonicalPath, request.logicalPath);
    let entryDetails;
    try {
      entryDetails = await lstat(absolutePath);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }

    const canonicalPath = await realpath(absolutePath);
    assertContained(parent.canonicalPath, canonicalPath);
    const targetDetails = entryDetails.isSymbolicLink() ? await stat(absolutePath) : entryDetails;
    if (!targetDetails.isDirectory()) {
      return null;
    }

    const registrationKey = [
      request.workspaceId,
      request.parentRootResourceId,
      request.logicalPath
    ].join("\0");
    const existingId = this.rootsByRegistration.get(registrationKey);
    if (existingId !== undefined) {
      const existing = this.requireRoot(request.workspaceId, existingId);
      if (!sameCanonicalPath(existing.canonicalPath, canonicalPath)) {
        throw new UnsafeFilesystemError("A registered source root changed identity.");
      }
      return existing.id;
    }

    const id = `root:${randomUUID()}`;
    this.roots.set(id, {
      id,
      workspaceId: request.workspaceId,
      absolutePath,
      canonicalPath
    });
    this.rootsByRegistration.set(registrationKey, id);
    return id;
  }

  async createEmptyStagingRoot(workspaceId: EntityId): Promise<EntityId> {
    await mkdir(this.stagingParent, { recursive: true });
    const canonicalParent = await realpath(this.stagingParent);
    const absolutePath = await mkdtemp(path.join(canonicalParent, "ruleswitch-stage-"));
    const canonicalPath = await realpath(absolutePath);
    assertContained(canonicalParent, canonicalPath);

    const id = `root:${randomUUID()}`;
    this.roots.set(id, { id, workspaceId, absolutePath, canonicalPath });
    return id;
  }

  async enumerateSafeFiles(
    workspaceId: EntityId,
    rootResourceId: EntityId,
    symlinkPolicy: SymlinkPolicy
  ): Promise<readonly SafeFileEntry[]> {
    const root = this.requireRoot(workspaceId, rootResourceId);
    const currentRoot = await realpath(root.absolutePath);
    if (!sameCanonicalPath(currentRoot, root.canonicalPath)) {
      throw new UnsafeFilesystemError("The enumerated root changed identity.");
    }

    const files: SafeFileEntry[] = [];
    const visitedDirectories = new Set<string>([canonicalKey(root.canonicalPath)]);
    const portablePaths = new Map<string, string>();

    const walk = async (absoluteDirectory: string, logicalDirectory: string): Promise<void> => {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      entries.sort((left, right) => compareStrings(left.name, right.name));

      for (const entry of entries) {
        const absoluteEntry = path.join(absoluteDirectory, entry.name);
        const logicalPath = logicalDirectory
          ? `${logicalDirectory}/${entry.name}`
          : entry.name;
        assertLogicalPath(logicalPath);

        const entryLstat = await lstat(absoluteEntry);
        if (entryLstat.isSymbolicLink() && symlinkPolicy === "reject") {
          throw new UnsafeFilesystemError("Symbolic links are not allowed in this file tree.");
        }

        const canonicalEntry = await realpath(absoluteEntry);
        assertContained(root.canonicalPath, canonicalEntry);
        const targetDetails = entryLstat.isSymbolicLink()
          ? await stat(absoluteEntry)
          : entryLstat;
        registerPortablePath(portablePaths, logicalPath);

        if (targetDetails.isDirectory()) {
          const directoryKey = canonicalKey(canonicalEntry);
          if (!visitedDirectories.has(directoryKey)) {
            visitedDirectories.add(directoryKey);
            await walk(absoluteEntry, logicalPath);
          }
        } else if (targetDetails.isFile()) {
          files.push({ logicalPath });
        } else {
          throw new UnsafeFilesystemError("Only regular files and directories are supported.");
        }
      }
    };

    await walk(root.absolutePath, "");
    files.sort((left, right) => compareStrings(left.logicalPath, right.logicalPath));
    return files;
  }

  async registerFileResource(request: RegisterFileRequest): Promise<FileResource> {
    const root = this.requireRoot(request.workspaceId, request.rootResourceId);
    const absolutePath = resolveLogicalPath(root.canonicalPath, request.logicalPath);
    const inspected = await inspectFile(root, absolutePath, request.symlinkPolicy);
    const registrationKey = resourceRegistrationKey(request);
    const existingId = this.resourcesByRegistration.get(registrationKey);
    const id = existingId ?? `resource:${randomUUID()}`;
    const resource = toFileResource(id, request, inspected.bytes);

    if (existingId === undefined) {
      this.resourcesByRegistration.set(registrationKey, id);
    }
    this.resources.set(id, { request, absolutePath, resource });
    return resource;
  }

  async registerFileResourceIfExists(
    request: RegisterFileRequest
  ): Promise<FileResource | null> {
    const root = this.requireRoot(request.workspaceId, request.rootResourceId);
    const absolutePath = resolveLogicalPath(root.canonicalPath, request.logicalPath);
    try {
      await lstat(absolutePath);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    return this.registerFileResource(request);
  }

  async refreshFileResource(
    workspaceId: EntityId,
    resourceId: EntityId
  ): Promise<FileResource> {
    const record = this.requireResource(workspaceId, resourceId);
    return this.registerFileResource(record.request);
  }

  async readResourceBytes(workspaceId: EntityId, resourceId: EntityId): Promise<Uint8Array> {
    const record = this.requireResource(workspaceId, resourceId);
    const root = this.requireRoot(workspaceId, record.request.rootResourceId);
    return (await inspectFile(root, record.absolutePath, record.request.symlinkPolicy)).bytes;
  }

  async aggregateRevision(resources: readonly FileResource[]): Promise<RevisionAggregate> {
    const byId = new Map<EntityId, FileResource>();
    for (const resource of resources) {
      if (byId.has(resource.id)) {
        throw new UnsafeFilesystemError("A revision aggregate cannot contain duplicate resources.");
      }
      byId.set(resource.id, resource);
    }

    const sorted = [...byId.values()].sort((left, right) => compareStrings(left.id, right.id));
    const files: FileRevision[] = sorted.map((resource) => ({
      resourceId: resource.id,
      hash: resource.hash,
      byteLength: resource.byteLength
    }));
    const tuples = files.map((file) => [
      file.resourceId,
      file.hash.digest,
      file.byteLength
    ]);

    return {
      algorithm: "sha256",
      serialization: "ruleswitch:file-revision-set:v1",
      digest: hashBytes(new TextEncoder().encode(JSON.stringify(tuples))),
      files
    };
  }

  createOpaqueId(kind: "staged-output" | "change-set" | "change"): EntityId {
    return `${kind}:${randomUUID()}`;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  private requireRoot(workspaceId: EntityId, rootResourceId: EntityId): RootRecord {
    const root = this.roots.get(rootResourceId);
    if (root === undefined || root.workspaceId !== workspaceId) {
      throw new UnsafeFilesystemError("The root capability is unavailable for this workspace.");
    }
    return root;
  }

  private requireResource(workspaceId: EntityId, resourceId: EntityId): ResourceRecord {
    const record = this.resources.get(resourceId);
    if (record === undefined || record.request.workspaceId !== workspaceId) {
      throw new UnsafeFilesystemError("The file capability is unavailable for this workspace.");
    }
    return record;
  }
}

async function inspectFile(
  root: RootRecord,
  absolutePath: string,
  symlinkPolicy: SymlinkPolicy
): Promise<InspectedFile> {
  const entryLstat = await lstat(absolutePath);
  if (entryLstat.isSymbolicLink() && symlinkPolicy === "reject") {
    throw new UnsafeFilesystemError("Symbolic links are not allowed for this resource.");
  }

  const canonicalBefore = await realpath(absolutePath);
  assertContained(root.canonicalPath, canonicalBefore);
  const targetDetails = entryLstat.isSymbolicLink() ? await stat(absolutePath) : entryLstat;
  if (!targetDetails.isFile()) {
    throw new UnsafeFilesystemError("The resource is not a regular file.");
  }

  const bytes = await readFile(absolutePath);
  const canonicalAfter = await realpath(absolutePath);
  assertContained(root.canonicalPath, canonicalAfter);
  if (!sameCanonicalPath(canonicalBefore, canonicalAfter)) {
    throw new UnsafeFilesystemError("The resource changed identity while it was read.");
  }
  return { canonicalPath: canonicalAfter, bytes };
}

function toFileResource(
  id: EntityId,
  request: RegisterFileRequest,
  bytes: Uint8Array
): FileResource {
  return {
    id,
    workspaceId: request.workspaceId,
    logicalPath: request.logicalPath,
    origin: request.origin,
    format: request.format,
    readonly: request.readonly,
    hash: {
      algorithm: "sha256",
      digest: hashBytes(bytes)
    },
    byteLength: bytes.byteLength
  };
}

function resourceRegistrationKey(request: RegisterFileRequest): string {
  return [
    request.workspaceId,
    request.rootResourceId,
    request.origin,
    request.logicalPath
  ].join("\0");
}

function resolveLogicalPath(root: string, logicalPath: string): string {
  assertLogicalPath(logicalPath);
  return path.join(root, ...logicalPath.split("/"));
}

function assertLogicalPath(logicalPath: string): void {
  const segments = logicalPath.split("/");
  if (
    logicalPath.length === 0 ||
    logicalPath.startsWith("/") ||
    logicalPath.includes("\\") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new UnsafeFilesystemError("The logical path is invalid.");
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new UnsafeFilesystemError("A filesystem entry escapes its authorized root.");
  }
}

function registerPortablePath(paths: Map<string, string>, logicalPath: string): void {
  const folded = logicalPath.toLowerCase();
  const existing = paths.get(folded);
  if (existing !== undefined && existing !== logicalPath) {
    throw new UnsafeFilesystemError("Logical paths collide when compared case-insensitively.");
  }
  paths.set(folded, logicalPath);
}

function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalKey(left) === canonicalKey(right);
}

function canonicalKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
