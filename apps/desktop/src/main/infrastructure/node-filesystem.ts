import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";

import type {
  EntityId,
  FileResource,
  FileRevision,
  RevisionAggregate
} from "@ruleswitch/core";
import { logicalPathSchema } from "@ruleswitch/core";
import type {
  RegisterFileRequest,
  RegisterRootRequest,
  RulesyncProviderInfrastructure,
  SafeFileEntry,
  SymlinkPolicy
} from "@ruleswitch/rulesync-provider";
import writeFileAtomic from "write-file-atomic";

export type ResourceOperation = "read" | "open-external";

interface RootRecord {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly kind: "workspace" | "source" | "staging";
}

interface ResourceRecord {
  readonly id: EntityId;
  readonly request: RegisterFileRequest;
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly operations: ReadonlySet<ResourceOperation>;
  resource: FileResource;
}

export interface FilesystemFaultInjector {
  beforeAtomicWrite?(logicalPath: string): void | Promise<void>;
  beforeDelete?(logicalPath: string): void | Promise<void>;
}

export class InfrastructureSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfrastructureSecurityError";
  }
}

/**
 * Production Node filesystem/capability adapter. Paths are retained only in
 * this Main-process registry; callers outside Main receive opaque IDs.
 */
export class NodeFilesystemInfrastructure implements RulesyncProviderInfrastructure {
  private readonly roots = new Map<EntityId, RootRecord>();
  private readonly rootsByRegistration = new Map<string, EntityId>();
  private readonly resources = new Map<EntityId, ResourceRecord>();
  private readonly resourcesByRegistration = new Map<string, EntityId>();

  constructor(
    private readonly appDataRoot: string,
    private readonly faultInjector?: FilesystemFaultInjector
  ) {}

  async registerWorkspaceRoot(workspaceId: EntityId, selectedRoot: string): Promise<EntityId> {
    const canonicalPath = await realpath(path.resolve(selectedRoot));
    const details = await stat(canonicalPath);
    if (!details.isDirectory()) {
      throw new InfrastructureSecurityError("The selected workspace is not a directory.");
    }
    const id = createOpaqueId("root");
    this.roots.set(id, {
      id,
      workspaceId,
      absolutePath: canonicalPath,
      canonicalPath,
      kind: "workspace"
    });
    return id;
  }

  getResource(resourceId: EntityId): FileResource | undefined {
    return this.resources.get(resourceId)?.resource;
  }

  async getRootIdentity(workspaceId: EntityId, rootResourceId: EntityId): Promise<string> {
    const canonical = await this.resolveAuthorizedRootPath(workspaceId, rootResourceId);
    return hashBytes(new TextEncoder().encode(canonicalKey(canonical)));
  }

  getResourceWorkspaceId(resourceId: EntityId): EntityId | undefined {
    return this.resources.get(resourceId)?.request.workspaceId;
  }

  getResourceRootId(workspaceId: EntityId, resourceId: EntityId): EntityId {
    return this.requireResource(workspaceId, resourceId).request.rootResourceId;
  }

  async authorizeResource(
    resourceId: EntityId,
    operation: ResourceOperation
  ): Promise<{ readonly workspaceId: EntityId; readonly absolutePath: string; readonly resource: FileResource }> {
    const record = this.resources.get(resourceId);
    if (record === undefined || !record.operations.has(operation)) {
      throw new InfrastructureSecurityError("The resource capability is unavailable.");
    }
    const absolutePath = await this.resolveAuthorizedResourcePath(
      record.request.workspaceId,
      resourceId
    );
    return { workspaceId: record.request.workspaceId, absolutePath, resource: record.resource };
  }

  async readRegisteredResource(resourceId: EntityId): Promise<{ resource: FileResource; content: Uint8Array }> {
    const authorized = await this.authorizeResource(resourceId, "read");
    const resource = await this.refreshFileResource(authorized.workspaceId, resourceId);
    return {
      resource,
      content: await this.readResourceBytes(authorized.workspaceId, resourceId)
    };
  }

  async resolveAuthorizedRootPath(
    workspaceId: EntityId,
    rootResourceId: EntityId
  ): Promise<string> {
    const root = this.requireRoot(workspaceId, rootResourceId);
    const currentCanonical = await realpath(root.absolutePath);
    if (!sameCanonicalPath(currentCanonical, root.canonicalPath)) {
      throw new InfrastructureSecurityError("An authorized root changed identity.");
    }
    return currentCanonical;
  }

  async resolveAuthorizedResourcePath(
    workspaceId: EntityId,
    resourceId: EntityId
  ): Promise<string> {
    const record = this.requireResource(workspaceId, resourceId);
    const root = this.requireRoot(workspaceId, record.request.rootResourceId);
    const inspected = await inspectExistingFile(root, record.absolutePath, record.request.symlinkPolicy);
    if (!sameCanonicalPath(inspected.canonicalPath, record.canonicalPath)) {
      throw new InfrastructureSecurityError("A registered resource changed canonical identity.");
    }
    return inspected.canonicalPath;
  }

  async registerDirectoryRoot(request: RegisterRootRequest): Promise<EntityId | null> {
    const parent = this.requireRoot(request.workspaceId, request.parentRootResourceId);
    const resolved = await resolveLogicalCandidate(parent, request.logicalPath, "allow-contained", false);
    if (!resolved.exists) {
      return null;
    }
    const details = await stat(resolved.absolutePath);
    if (!details.isDirectory()) {
      return null;
    }

    const key = [request.workspaceId, request.parentRootResourceId, request.logicalPath].join("\0");
    const existingId = this.rootsByRegistration.get(key);
    if (existingId !== undefined) {
      const existing = this.requireRoot(request.workspaceId, existingId);
      if (!sameCanonicalPath(existing.canonicalPath, resolved.canonicalPath)) {
        throw new InfrastructureSecurityError("A registered root changed identity.");
      }
      return existingId;
    }

    const id = createOpaqueId("root");
    this.roots.set(id, {
      id,
      workspaceId: request.workspaceId,
      absolutePath: resolved.absolutePath,
      canonicalPath: resolved.canonicalPath,
      kind: "source"
    });
    this.rootsByRegistration.set(key, id);
    return id;
  }

  async createEmptyStagingRoot(workspaceId: EntityId): Promise<EntityId> {
    const stagingParent = path.join(this.appDataRoot, "staging");
    await mkdir(stagingParent, { recursive: true });
    const canonicalParent = await realpath(stagingParent);
    const absolutePath = await mkdtemp(path.join(canonicalParent, "stage-"));
    const canonicalPath = await realpath(absolutePath);
    assertContained(canonicalParent, canonicalPath);
    const id = createOpaqueId("root");
    this.roots.set(id, {
      id,
      workspaceId,
      absolutePath,
      canonicalPath,
      kind: "staging"
    });
    return id;
  }

  async enumerateSafeFiles(
    workspaceId: EntityId,
    rootResourceId: EntityId,
    symlinkPolicy: SymlinkPolicy
  ): Promise<readonly SafeFileEntry[]> {
    const root = this.requireRoot(workspaceId, rootResourceId);
    await this.resolveAuthorizedRootPath(workspaceId, rootResourceId);
    const files: SafeFileEntry[] = [];
    const visitedDirectories = new Set<string>([canonicalKey(root.canonicalPath)]);
    const portablePaths = new Map<string, string>();

    const walk = async (absoluteDirectory: string, logicalDirectory: string): Promise<void> => {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      entries.sort((left, right) => compareStrings(left.name, right.name));
      for (const entry of entries) {
        const absoluteEntry = path.join(absoluteDirectory, entry.name);
        const logicalPath = logicalDirectory ? `${logicalDirectory}/${entry.name}` : entry.name;
        assertLogicalPath(logicalPath);
        registerPortablePath(portablePaths, logicalPath);

        const linkDetails = await lstat(absoluteEntry);
        if (linkDetails.isSymbolicLink() && symlinkPolicy === "reject") {
          throw new InfrastructureSecurityError("Symbolic links are forbidden in this resource tree.");
        }
        const canonicalEntry = await realpath(absoluteEntry);
        assertContained(root.canonicalPath, canonicalEntry);
        const details = linkDetails.isSymbolicLink() ? await stat(absoluteEntry) : linkDetails;
        if (details.isDirectory()) {
          const key = canonicalKey(canonicalEntry);
          if (!visitedDirectories.has(key)) {
            visitedDirectories.add(key);
            await walk(absoluteEntry, logicalPath);
          }
        } else if (details.isFile()) {
          files.push({ logicalPath });
        } else {
          throw new InfrastructureSecurityError("Only regular files and directories are supported.");
        }
      }
    };

    await walk(root.absolutePath, "");
    files.sort((left, right) => compareStrings(left.logicalPath, right.logicalPath));
    return files;
  }

  async registerFileResource(request: RegisterFileRequest): Promise<FileResource> {
    const root = this.requireRoot(request.workspaceId, request.rootResourceId);
    const resolved = await resolveLogicalCandidate(root, request.logicalPath, request.symlinkPolicy, false);
    if (!resolved.exists) {
      throw new InfrastructureSecurityError("The requested file resource does not exist.");
    }
    const inspected = await inspectExistingFile(root, resolved.absolutePath, request.symlinkPolicy);
    const key = resourceRegistrationKey(request);
    const existingId = this.resourcesByRegistration.get(key);
    const id = existingId ?? createOpaqueId("resource");
    const resource = toFileResource(id, request, inspected.bytes);
    if (existingId === undefined) {
      this.resourcesByRegistration.set(key, id);
    }
    this.resources.set(id, {
      id,
      request,
      absolutePath: resolved.absolutePath,
      canonicalPath: inspected.canonicalPath,
      operations: new Set<ResourceOperation>(
        request.origin === "source" ? ["read", "open-external"] : ["read"]
      ),
      resource
    });
    return resource;
  }

  async registerFileResourceIfExists(request: RegisterFileRequest): Promise<FileResource | null> {
    const root = this.requireRoot(request.workspaceId, request.rootResourceId);
    const resolved = await resolveLogicalCandidate(root, request.logicalPath, request.symlinkPolicy, true);
    if (!resolved.exists) {
      return null;
    }
    return this.registerFileResource(request);
  }

  async refreshFileResource(workspaceId: EntityId, resourceId: EntityId): Promise<FileResource> {
    const record = this.requireResource(workspaceId, resourceId);
    return this.registerFileResource(record.request);
  }

  async readResourceBytes(workspaceId: EntityId, resourceId: EntityId): Promise<Uint8Array> {
    const record = this.requireResource(workspaceId, resourceId);
    const root = this.requireRoot(workspaceId, record.request.rootResourceId);
    return (await inspectExistingFile(root, record.absolutePath, record.request.symlinkPolicy)).bytes;
  }

  async aggregateRevision(resources: readonly FileResource[]): Promise<RevisionAggregate> {
    const byId = new Map<EntityId, FileResource>();
    for (const resource of resources) {
      if (byId.has(resource.id)) {
        throw new InfrastructureSecurityError("A revision cannot contain duplicate resources.");
      }
      byId.set(resource.id, resource);
    }
    const sorted = [...byId.values()].sort((left, right) => compareStrings(left.id, right.id));
    const files: FileRevision[] = sorted.map((resource) => ({
      resourceId: resource.id,
      hash: resource.hash,
      byteLength: resource.byteLength
    }));
    const tuples = files.map((file) => [file.resourceId, file.hash.digest, file.byteLength]);
    return {
      algorithm: "sha256",
      serialization: "ruleswitch:file-revision-set:v1",
      digest: hashBytes(new TextEncoder().encode(JSON.stringify(tuples))),
      files
    };
  }

  createOpaqueId(kind: "staged-output" | "change-set" | "change"): EntityId {
    return createOpaqueId(kind);
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  async readTargetFile(
    workspaceId: EntityId,
    rootResourceId: EntityId,
    logicalPath: string
  ): Promise<Uint8Array | null> {
    const root = this.requireRoot(workspaceId, rootResourceId);
    const resolved = await resolveLogicalCandidate(root, logicalPath, "reject", true);
    if (!resolved.exists) {
      return null;
    }
    return (await inspectExistingFile(root, resolved.absolutePath, "reject")).bytes;
  }

  async atomicWriteTarget(
    workspaceId: EntityId,
    rootResourceId: EntityId,
    logicalPath: string,
    content: Uint8Array
  ): Promise<FileRevision> {
    await this.faultInjector?.beforeAtomicWrite?.(logicalPath);
    const root = this.requireRoot(workspaceId, rootResourceId);
    const segments = assertLogicalPath(logicalPath);
    await ensureSafeParentDirectories(root, segments.slice(0, -1));
    const resolved = await resolveLogicalCandidate(root, logicalPath, "reject", true);
    await writeFileAtomic(resolved.absolutePath, Buffer.from(content), { fsync: true });
    const inspected = await inspectExistingFile(root, resolved.absolutePath, "reject");
    return {
      resourceId: createOpaqueId("verification"),
      hash: { algorithm: "sha256", digest: hashBytes(inspected.bytes) },
      byteLength: inspected.bytes.byteLength
    };
  }

  async deleteAuthorizedTarget(
    workspaceId: EntityId,
    rootResourceId: EntityId,
    logicalPath: string,
    expectedDigest: string,
    authorization: { readonly transactionId: EntityId; readonly ledgerRecorded: true }
  ): Promise<void> {
    if (authorization.transactionId.length === 0 || !authorization.ledgerRecorded) {
      throw new InfrastructureSecurityError("Delete requires explicit transaction authorization.");
    }
    await this.faultInjector?.beforeDelete?.(logicalPath);
    const root = this.requireRoot(workspaceId, rootResourceId);
    const resolved = await resolveLogicalCandidate(root, logicalPath, "reject", false);
    if (!resolved.exists) {
      throw new InfrastructureSecurityError("The authorized delete target no longer exists.");
    }
    const inspected = await inspectExistingFile(root, resolved.absolutePath, "reject");
    if (hashBytes(inspected.bytes) !== expectedDigest) {
      throw new InfrastructureSecurityError("The authorized delete target changed.");
    }
    await rm(resolved.absolutePath);
    const after = await resolveLogicalCandidate(root, logicalPath, "reject", true);
    if (after.exists) {
      throw new InfrastructureSecurityError("The authorized target could not be deleted.");
    }
  }

  hashBytes(content: Uint8Array): string {
    return hashBytes(content);
  }

  private requireRoot(workspaceId: EntityId, rootResourceId: EntityId): RootRecord {
    const root = this.roots.get(rootResourceId);
    if (root === undefined || root.workspaceId !== workspaceId) {
      throw new InfrastructureSecurityError("The root capability is unavailable for this workspace.");
    }
    return root;
  }

  private requireResource(workspaceId: EntityId, resourceId: EntityId): ResourceRecord {
    const resource = this.resources.get(resourceId);
    if (resource === undefined || resource.request.workspaceId !== workspaceId) {
      throw new InfrastructureSecurityError("The resource capability is unavailable for this workspace.");
    }
    return resource;
  }
}

interface ResolvedCandidate {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly exists: boolean;
}

async function resolveLogicalCandidate(
  root: RootRecord,
  logicalPath: string,
  symlinkPolicy: SymlinkPolicy,
  allowMissing: boolean
): Promise<ResolvedCandidate> {
  const segments = assertLogicalPath(logicalPath);
  const currentRoot = await realpath(root.absolutePath);
  if (!sameCanonicalPath(currentRoot, root.canonicalPath)) {
    throw new InfrastructureSecurityError("An authorized root changed identity.");
  }

  let currentAbsolute = root.absolutePath;
  let currentCanonical = root.canonicalPath;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      throw new InfrastructureSecurityError("The logical path is invalid.");
    }
    await assertPortableDirectoryEntry(currentAbsolute, segment);
    const candidate = path.join(currentAbsolute, segment);
    let linkDetails;
    try {
      linkDetails = await lstat(candidate);
    } catch (error) {
      if (isMissing(error) && allowMissing) {
        const tail = segments.slice(index);
        const absolutePath = path.join(currentAbsolute, ...tail);
        const canonicalPath = path.join(currentCanonical, ...tail);
        assertContained(root.canonicalPath, canonicalPath);
        return { absolutePath, canonicalPath, exists: false };
      }
      if (isMissing(error)) {
        return { absolutePath: candidate, canonicalPath: candidate, exists: false };
      }
      throw error;
    }
    if (linkDetails.isSymbolicLink() && symlinkPolicy === "reject") {
      throw new InfrastructureSecurityError("Symbolic links are forbidden for this operation.");
    }
    const canonical = await realpath(candidate);
    assertContained(root.canonicalPath, canonical);
    currentAbsolute = candidate;
    currentCanonical = canonical;
  }
  return { absolutePath: currentAbsolute, canonicalPath: currentCanonical, exists: true };
}

async function inspectExistingFile(
  root: RootRecord,
  absolutePath: string,
  symlinkPolicy: SymlinkPolicy
): Promise<{ readonly canonicalPath: string; readonly bytes: Uint8Array }> {
  const linkDetails = await lstat(absolutePath);
  if (linkDetails.isSymbolicLink() && symlinkPolicy === "reject") {
    throw new InfrastructureSecurityError("Symbolic links are forbidden for this resource.");
  }
  const canonicalBefore = await realpath(absolutePath);
  assertContained(root.canonicalPath, canonicalBefore);
  const details = linkDetails.isSymbolicLink() ? await stat(absolutePath) : linkDetails;
  if (!details.isFile()) {
    throw new InfrastructureSecurityError("The resource is not a regular file.");
  }
  const bytes = await readFile(absolutePath);
  const canonicalAfter = await realpath(absolutePath);
  assertContained(root.canonicalPath, canonicalAfter);
  if (!sameCanonicalPath(canonicalBefore, canonicalAfter)) {
    throw new InfrastructureSecurityError("The resource changed identity while being read.");
  }
  return { canonicalPath: canonicalAfter, bytes };
}

async function ensureSafeParentDirectories(root: RootRecord, segments: readonly string[]): Promise<void> {
  let current = root.absolutePath;
  for (const segment of segments) {
    await assertPortableDirectoryEntry(current, segment);
    const candidate = path.join(current, segment);
    try {
      const details = await lstat(candidate);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new InfrastructureSecurityError("A target parent is not a safe directory.");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      await mkdir(candidate);
    }
    const canonical = await realpath(candidate);
    assertContained(root.canonicalPath, canonical);
    current = candidate;
  }
}

async function assertPortableDirectoryEntry(parent: string, requested: string): Promise<void> {
  const entries = await readdir(parent);
  const folded = requested.toLocaleLowerCase("en-US");
  const matches = entries.filter((entry) => entry.toLocaleLowerCase("en-US") === folded);
  if (matches.length > 1 || (matches.length === 1 && matches[0] !== requested)) {
    throw new InfrastructureSecurityError("A case-insensitive filesystem identity is ambiguous.");
  }
}

function assertLogicalPath(logicalPath: string): readonly string[] {
  const parsed = logicalPathSchema.safeParse(logicalPath);
  if (!parsed.success || logicalPath.startsWith("//")) {
    throw new InfrastructureSecurityError("The provider-neutral logical path is invalid.");
  }
  return parsed.data.split("/");
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InfrastructureSecurityError("A filesystem entry escapes its authorized root.");
  }
}

function registerPortablePath(paths: Map<string, string>, logicalPath: string): void {
  const folded = logicalPath.toLocaleLowerCase("en-US");
  const existing = paths.get(folded);
  if (existing !== undefined && existing !== logicalPath) {
    throw new InfrastructureSecurityError("Logical paths collide case-insensitively.");
  }
  paths.set(folded, logicalPath);
}

function resourceRegistrationKey(request: RegisterFileRequest): string {
  return [request.workspaceId, request.rootResourceId, request.origin, request.logicalPath].join("\0");
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
    hash: { algorithm: "sha256", digest: hashBytes(bytes) },
    byteLength: bytes.byteLength
  };
}

function createOpaqueId(kind: string): EntityId {
  return `${kind}_${randomBytes(24).toString("base64url")}`;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalKey(left) === canonicalKey(right);
}

function canonicalKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
