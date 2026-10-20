// Frozen M0 contract (INH-1753): Repository / Asset / Scope / Project stable identity.
//
// Namespace note: Phase A already ships CONTRACT_VERSION "v1"; the rebaselined
// v1.0 product contracts therefore live in this package's "v2" namespace,
// matching the "Adapter v2" / "IPC v2" terminology. Nothing here replaces or
// mutates the frozen Phase A contracts in ../contracts.ts.
//
// Identity rule: stable IDs are pure functions of logical inputs plus a hash
// function. Absolute local paths never participate in cross-device identity;
// they exist only in local binding stores. Digests are SHA-256 hex.

import { z } from "zod";

export const IDENTITY_HASH_SERIALIZATION =
  "ruleswitch:stable-identity:v1" as const;

const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Synchronous SHA-256 over UTF-8 input, returned as lowercase hex. */
export interface StableIdHasher {
  sha256Hex(utf8Input: string): string;
}

export interface StableIdHasherPort {
  createStableIdHasher(): StableIdHasher;
}

const stableHex = (hasher: StableIdHasher, domain: string, payload: string): string =>
  hasher.sha256Hex(`${IDENTITY_HASH_SERIALIZATION}\0${domain}\0${payload}`);

// ---------------------------------------------------------------------------
// Canonical remote identity
// ---------------------------------------------------------------------------

/**
 * Normalizes a Git remote URL to a protocol-agnostic canonical form so that
 * SSH and HTTPS remotes of the same repository produce the same identity:
 *
 *   git://<host>[:<port>]/<path>
 *
 * Rules (frozen):
 * - Host is lowercased; default ports (https 443, ssh 22, git 9418) dropped,
 *   non-default ports preserved.
 * - Userinfo is dropped (git@host:... and https://user@host/... are equal).
 * - A trailing ".git" and trailing slashes are stripped from the path.
 * - Path keeps its case and is Unicode NFC normalized; segments must be
 *   non-empty and must not be "." or "..".
 * - scp-like syntax (git@host:owner/repo) is treated as ssh.
 * - file:// and absolute local paths are test/local-only remotes:
 *   file://<realpath>. They get a stable identity on one machine but no
 *   cross-device guarantee.
 */
export function normalizeGitRemoteUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Cannot normalize an empty Git remote URL");
  }

  let scheme: string | null = null;
  let rest = trimmed;

  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/);
  if (schemeMatch?.[1] !== undefined && schemeMatch[2] !== undefined) {
    scheme = schemeMatch[1].toLowerCase();
    rest = schemeMatch[2];
  } else {
    // scp-like: git@host:path (colon before any slash)
    const colonIndex = trimmed.indexOf(":");
    const slashIndex = trimmed.indexOf("/");
    if (colonIndex > 0 && (slashIndex === -1 || colonIndex < slashIndex)) {
      scheme = "ssh";
      rest = `${trimmed.slice(0, colonIndex)}/${trimmed.slice(colonIndex + 1)}`;
    }
  }

  if (scheme === null) {
    // Absolute local path (POSIX or Windows drive) → local file remote.
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      const normalizedPath = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
      return `file://${normalizedPath}`;
    }
    throw new Error(`Unrecognized Git remote URL format: ${input}`);
  }

  if (scheme === "file") {
    const normalizedPath = rest.replace(/\\/g, "/").replace(/\/+$/, "");
    return `file://${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
  }

  if (scheme !== "https" && scheme !== "ssh" && scheme !== "git") {
    throw new Error(`Unsupported Git remote scheme "${scheme}": ${input}`);
  }

  // Strip userinfo.
  const atIndex = rest.lastIndexOf("@");
  if (atIndex >= 0) {
    rest = rest.slice(atIndex + 1);
  }

  let host: string;
  let port: string | null = null;
  let path: string;
  const slashIndex = rest.indexOf("/");
  if (slashIndex === -1) {
    host = rest;
    path = "";
  } else {
    host = rest.slice(0, slashIndex);
    path = rest.slice(slashIndex + 1);
  }

  if (host.startsWith("[")) {
    // IPv6 literal [::1]:port
    const close = host.indexOf("]");
    if (close === -1) {
      throw new Error(`Malformed IPv6 host in Git remote URL: ${input}`);
    }
    const hostPart = host.slice(0, close + 1);
    const portPart = host.slice(close + 1);
    host = hostPart.toLowerCase();
    if (portPart.startsWith(":")) {
      port = portPart.slice(1);
    }
  } else if (host.includes(":")) {
    const colonIndex = host.indexOf(":");
    port = host.slice(colonIndex + 1);
    host = host.slice(0, colonIndex);
    host = host.toLowerCase();
  } else {
    host = host.toLowerCase();
  }

  if (host.length === 0) {
    throw new Error(`Missing host in Git remote URL: ${input}`);
  }
  if (port !== null && !/^[0-9]+$/.test(port)) {
    throw new Error(`Malformed port in Git remote URL: ${input}`);
  }

  const defaultPorts: Record<string, string> = { https: "443", ssh: "22", git: "9418" };
  const effectivePort = port !== null && port !== defaultPorts[scheme] ? port : null;

  path = path.replace(/\/+$/, "");
  if (path.endsWith(".git")) {
    path = path.slice(0, -".git".length);
  }
  if (path.length > 0) {
    path = path.normalize("NFC");
  }

  const pathSegments = path.length === 0 ? [] : path.split("/");
  if (pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Malformed path in Git remote URL: ${input}`);
  }

  return `git://${host}${effectivePort !== null ? `:${effectivePort}` : ""}${pathSegments.length > 0 ? `/${pathSegments.join("/")}` : ""}`;
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

export const repositoryIdSchema = z.string().regex(/^repo_[0-9a-f]{64}$/);
export type RepositoryId = z.infer<typeof repositoryIdSchema>;

export const canonicalRemoteSchema = z.string().regex(/^(git:\/\/|file:\/\/)/);
export type CanonicalRemote = z.infer<typeof canonicalRemoteSchema>;

export interface RepositoryIdentity {
  readonly repositoryId: RepositoryId;
  /** Protocol-agnostic canonical remote; never contains credentials. */
  readonly canonicalRemote: CanonicalRemote;
  /**
   * "remote" identities are stable across devices. "local-only" repositories
   * have no configured remote; their identity is a locally generated ID with
   * no cross-device guarantee and must be flagged in UI and stores.
   */
  readonly portability: "remote" | "local-only";
}

export function createRemoteRepositoryIdentity(
  remoteUrl: string,
  hasher: StableIdHasher
): RepositoryIdentity {
  const canonicalRemote = normalizeGitRemoteUrl(remoteUrl);
  return Object.freeze({
    repositoryId: `repo_${stableHex(hasher, "repository", canonicalRemote)}`,
    canonicalRemote,
    portability: canonicalRemote.startsWith("file://") ? "local-only" : "remote"
  });
}

export function createLocalOnlyRepositoryIdentity(
  localOnlyKey: string,
  hasher: StableIdHasher
): RepositoryIdentity {
  const trimmed = localOnlyKey.trim();
  if (trimmed.length === 0) {
    throw new Error("A local-only repository identity requires a non-empty key");
  }
  return Object.freeze({
    repositoryId: `repo_${stableHex(hasher, "repository-local-only", trimmed)}`,
    canonicalRemote: `local://${trimmed}` as CanonicalRemote,
    portability: "local-only"
  });
}

// ---------------------------------------------------------------------------
// Device identity (local runtime identity only; never enters Git)
// ---------------------------------------------------------------------------

export const deviceIdSchema = z.string().regex(/^dev_[0-9a-f]{64}$/);
export type DeviceId = z.infer<typeof deviceIdSchema>;

/** Device IDs are generated once per machine by the platform layer and stored locally. */
export function createDeviceId(randomHex32: () => string): DeviceId {
  return `dev_${randomHex32()}`;
}

// ---------------------------------------------------------------------------
// Scope: Global / Project
// ---------------------------------------------------------------------------

export const projectIdSchema = z.string().regex(/^prj_[a-z0-9][a-z0-9-]{2,62}$/);
export type ProjectId = z.infer<typeof projectIdSchema>;

export const scopeRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: projectIdSchema })
]);
export type ScopeRef = z.infer<typeof scopeRefSchema>;

export function serializeScopeRef(scope: ScopeRef): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

// ---------------------------------------------------------------------------
// Project definition (stored in Git; local absolute paths never enter Git)
// ---------------------------------------------------------------------------

/**
 * Glob matched against the canonical remote URL of a project working
 * repository's origin. `*` matches any characters including `/`.
 * Host is compared case-insensitively (it is already lowercase in the
 * canonical form); path case is significant.
 */
export const remoteMatchPatternSchema = z
  .string()
  .regex(/^(git:\/\/|file:\/\/)[^\s]*$/)
  .refine((pattern) => !pattern.includes(".."), {
    message: "Remote match patterns must not contain '..' segments"
  });
export type RemoteMatchPattern = z.infer<typeof remoteMatchPatternSchema>;

export interface ProjectDefinition {
  readonly projectId: ProjectId;
  readonly displayName: string;
  readonly remoteMatch: readonly RemoteMatchPattern[];
  readonly createdAt: string;
}

export const projectDefinitionSchema: z.ZodType<ProjectDefinition> = z.strictObject({
  projectId: projectIdSchema,
  displayName: z.string().trim().min(1).max(200),
  remoteMatch: z.array(remoteMatchPatternSchema).max(32),
  createdAt: isoDateTimeSchema
});

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesRemote(pattern: RemoteMatchPattern, canonicalRemote: CanonicalRemote): boolean {
  return globToRegExp(pattern).test(canonicalRemote);
}

// ---------------------------------------------------------------------------
// Asset key: scope + kind + logicalName
// ---------------------------------------------------------------------------

export const ASSET_KINDS = [
  "instructions",
  "skills",
  "mcp",
  "hooks",
  "commands",
  "prompts",
  "agents",
  "settings",
  "native"
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const assetKindSchema = z.enum(ASSET_KINDS);

/**
 * Asset logical names are normalized forward-slash relative paths (NFC).
 * Identity is case-sensitive at the domain boundary; filesystem
 * case-collision policy is a separate platform concern (Phase A adapter
 * policy is reused). Rename = delete of the old key + create of the new key;
 * v1.0 tracks no rename operations. Delete removes the key and its
 * provenance; runtime target files are then governed by ownership rules,
 * never by key absence alone.
 */
export function normalizeAssetLogicalName(logicalName: string): string {
  const normalized = logicalName.normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`Invalid asset logical name: ${logicalName}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid asset logical name: ${logicalName}`);
  }
  return segments.join("/");
}

export const assetLogicalNameSchema = z.string().refine(
  (value) => {
    try {
      return normalizeAssetLogicalName(value) === value;
    } catch {
      return false;
    }
  },
  { message: "Expected a normalized NFC forward-slash relative asset logical name" }
);

export interface AssetKey {
  readonly scope: ScopeRef;
  readonly kind: AssetKind;
  readonly logicalName: string;
}

export function serializeAssetKey(key: AssetKey): string {
  return `${serializeScopeRef(key.scope)}|${key.kind}|${normalizeAssetLogicalName(key.logicalName)}`;
}

export const assetKeyIdSchema = z.string().regex(/^asset_[0-9a-f]{64}$/);
export type AssetKeyId = z.infer<typeof assetKeyIdSchema>;

export function createAssetKeyId(key: AssetKey, hasher: StableIdHasher): AssetKeyId {
  return `asset_${stableHex(hasher, "asset-key", serializeAssetKey(key))}`;
}

// ---------------------------------------------------------------------------
// Harness instance identity: adapter + scope + binding key
// ---------------------------------------------------------------------------

/**
 * Built-in adapters use stable registry IDs ("claude-code", "codex",
 * "cursor", "opencode"). User-registered custom harnesses use
 * "custom:<hex>" IDs: a registration never grants adapter write capability
 * by itself (INH-1755 registration-vs-capability boundary).
 */
export const adapterIdSchema = z
  .string()
  .regex(/^(claude-code|codex|cursor|opencode|custom:[0-9a-f]{16})$/);
export type AdapterId = z.infer<typeof adapterIdSchema>;

export interface HarnessInstanceRef {
  readonly adapterId: AdapterId;
  readonly scope: ScopeRef;
  /**
   * Distinguishes duplicate registrations of the same adapter in one scope.
   * The default instance of an adapter in a scope uses "default".
   */
  readonly bindingKey: string;
}

export function createHarnessInstanceRef(
  adapterId: AdapterId,
  scope: ScopeRef,
  bindingKey = "default"
): HarnessInstanceRef {
  const trimmed = bindingKey.trim();
  if (trimmed.length === 0 || trimmed.includes("\0") || trimmed.includes("|")) {
    throw new Error(`Invalid harness binding key: ${bindingKey}`);
  }
  return { adapterId, scope, bindingKey: trimmed };
}

export function serializeHarnessInstanceRef(ref: HarnessInstanceRef): string {
  return `${ref.adapterId}|${serializeScopeRef(ref.scope)}|${ref.bindingKey}`;
}

export const harnessInstanceIdSchema = z.string().regex(/^harn_[0-9a-f]{64}$/);
export type HarnessInstanceId = z.infer<typeof harnessInstanceIdSchema>;

export function createHarnessInstanceId(
  ref: HarnessInstanceRef,
  hasher: StableIdHasher
): HarnessInstanceId {
  return `harn_${stableHex(hasher, "harness-instance", serializeHarnessInstanceRef(ref))}`;
}

// ---------------------------------------------------------------------------
// Config source identity (Library HEAD vs working draft vs harness actual)
// ---------------------------------------------------------------------------

export const CONFIG_SOURCE_KINDS = [
  "repo-head",
  "repo-working-draft",
  "harness-actual"
] as const;
export type ConfigSourceKind = (typeof CONFIG_SOURCE_KINDS)[number];

export interface ConfigSourceRefHead {
  readonly kind: "repo-head";
  readonly repositoryId: RepositoryId;
  readonly revision: string;
  readonly harnessInstanceId: null;
}

export interface ConfigSourceRefDraft {
  readonly kind: "repo-working-draft";
  readonly repositoryId: RepositoryId;
  readonly revision: null;
  readonly harnessInstanceId: null;
}

export interface ConfigSourceRefHarness {
  readonly kind: "harness-actual";
  readonly repositoryId: null;
  readonly revision: null;
  readonly harnessInstanceId: HarnessInstanceId;
}

export type ConfigSourceRef =
  | ConfigSourceRefHead
  | ConfigSourceRefDraft
  | ConfigSourceRefHarness;

export const configSourceRefSchema: z.ZodType<ConfigSourceRef> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("repo-head"),
    repositoryId: repositoryIdSchema,
    revision: z.string().min(1),
    harnessInstanceId: z.null()
  }),
  z.strictObject({
    kind: z.literal("repo-working-draft"),
    repositoryId: repositoryIdSchema,
    revision: z.null(),
    harnessInstanceId: z.null()
  }),
  z.strictObject({
    kind: z.literal("harness-actual"),
    repositoryId: z.null(),
    revision: z.null(),
    harnessInstanceId: harnessInstanceIdSchema
  })
]);
