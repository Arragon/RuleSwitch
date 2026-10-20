// v1 config-repo layout loader and Asset Graph normalization
// (INH-1767/1768). Turns a repository file listing into a deterministic,
// provider-neutral inventory; the graph contains no absolute paths.
//
// Frozen layout:
//   ruleswitch.yaml                              manifest
//   profiles/<name>.yaml                         profile definitions
//   global/<kind>/...                            global-scope assets (8 kinds)
//   global/native/<adapterId>/...                global harness variants
//   projects/<projectId>/project.yaml            project definition
//   projects/<projectId>/<kind>/...              project-scope assets
//   projects/<projectId>/.ruleswitch/native/...  project harness variants
//   .ruleswitch/...                              tool metadata, never an asset
// Any other top-level path is ignored (unmanaged repo content).
//
// Deterministic ordering everywhere: files sorted bytewise, assets sorted
// by serialized asset key. Duplicate logical paths, NFC-equal duplicates,
// case-collision pairs, traversal-shaped paths, unknown kinds, and invalid
// project manifests are all fatal (fail closed).

import type { AssetKind, ProjectDefinition, ScopeRef, StableIdHasher } from "./identity";
import { ASSET_KINDS, normalizeAssetLogicalName, serializeAssetKey } from "./identity";
import {
  parseRuleswitchManifest,
  type ManifestDiagnostic,
  type RuleSwitchManifest
} from "./ruleswitch-yaml";
import { parseYamlSubset, type YamlMapping } from "./yaml";
import { utf8Decode } from "./utf8";

export interface RepoFileSource {
  /** Repository-relative, forward-slash, sorted file paths (no directories). */
  listFiles(): Promise<readonly string[]>;
  readFile(logicalPath: string): Promise<Uint8Array | null>;
}

export interface RepoDiagnostic {
  readonly code: string;
  readonly logicalPath: string | null;
  readonly message: string;
}

export interface ProfileDefinition {
  readonly name: string;
  readonly description: string | null;
  /** Replacement content keyed by "kind/logicalName" (replace-only in v1). */
  readonly replacements: Readonly<Record<string, string>>;
}

export interface InventoryAsset {
  readonly scope: ScopeRef;
  readonly kind: AssetKind;
  readonly logicalName: string;
  readonly content: Uint8Array;
  readonly contentDigest: string;
  /** Provenance: the repo-relative source path this asset came from. */
  readonly sourceLogicalPath: string;
}

export interface RepoInventory {
  readonly manifest: RuleSwitchManifest;
  readonly projects: readonly ProjectDefinition[];
  readonly profiles: readonly ProfileDefinition[];
  readonly assets: readonly InventoryAsset[];
  readonly graphDigest: string;
}

export type InventoryResult =
  | { readonly ok: true; readonly inventory: RepoInventory }
  | { readonly ok: false; readonly diagnostics: readonly RepoDiagnostic[] };

const NON_NATIVE_KINDS = ASSET_KINDS.filter((kind) => kind !== "native");
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isMappingValue(value: unknown): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !("items" in value);
}

function validateRepoPath(logicalPath: string): string | null {
  if (
    logicalPath.length === 0 ||
    logicalPath.includes("\0") ||
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return `unsafe repository path: ${JSON.stringify(logicalPath)}`;
  }
  return null;
}

export async function loadRepoInventory(source: RepoFileSource, hasher: StableIdHasher): Promise<InventoryResult> {
  const diagnostics: RepoDiagnostic[] = [];
  const files = [...await source.listFiles()].sort();
  const seenPaths = new Set<string>();
  const caseMap = new Map<string, string>();

  for (const file of files) {
    const unsafe = validateRepoPath(file);
    if (unsafe) {
      diagnostics.push({ code: "PATH_UNSAFE", logicalPath: file, message: unsafe });
      continue;
    }
    const normalized = file.normalize("NFC");
    if (normalized !== file) {
      diagnostics.push({
        code: "PATH_NOT_NFC",
        logicalPath: file,
        message: "repository paths must be NFC-normalized"
      });
      continue;
    }
    if (seenPaths.has(normalized)) {
      diagnostics.push({ code: "PATH_DUPLICATE", logicalPath: file, message: "duplicate logical path" });
      continue;
    }
    seenPaths.add(normalized);
    const folded = normalized.toLowerCase();
    const previous = caseMap.get(folded);
    if (previous !== undefined && previous !== normalized) {
      diagnostics.push({
        code: "PATH_CASE_COLLISION",
        logicalPath: file,
        message: `case collision with ${previous}`
      });
      continue;
    }
    caseMap.set(folded, normalized);
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // Manifest.
  const manifestBytes = await source.readFile("ruleswitch.yaml");
  if (manifestBytes === null) {
    return {
      ok: false,
      diagnostics: [{ code: "MANIFEST_MISSING", logicalPath: "ruleswitch.yaml", message: "ruleswitch.yaml is required" }]
    };
  }
  const manifestResult = parseRuleswitchManifest(utf8Decode(manifestBytes));
  if (!manifestResult.ok) {
    return {
      ok: false,
      diagnostics: (manifestResult.diagnostics as readonly ManifestDiagnostic[]).map((diagnostic) => ({
        code: diagnostic.code,
        logicalPath: "ruleswitch.yaml",
        message: `${diagnostic.fieldPath}: ${diagnostic.message}`
      }))
    };
  }

  // Profiles.
  const profiles: ProfileDefinition[] = [];
  const profileNames = new Set<string>();
  for (const file of files) {
    if (!file.startsWith("profiles/") || !file.endsWith(".yaml") || file.slice("profiles/".length).includes("/")) {
      continue;
    }
    const name = file.slice("profiles/".length, -".yaml".length);
    if (!PROFILE_NAME_PATTERN.test(name)) {
      diagnostics.push({
        code: "PROFILE_NAME_INVALID",
        logicalPath: file,
        message: `profile file name must match ${PROFILE_NAME_PATTERN.source}`
      });
      continue;
    }
    if (profileNames.has(name)) {
      diagnostics.push({ code: "PROFILE_DUPLICATE", logicalPath: file, message: `duplicate profile '${name}'` });
      continue;
    }
    const bytes = await source.readFile(file);
    const parsed = bytes === null ? null : parseYamlSubset(utf8Decode(bytes));
    if (parsed === null || !parsed.ok || !isMappingValue(parsed.value)) {
      diagnostics.push({ code: "PROFILE_INVALID", logicalPath: file, message: "profile must be a mapping" });
      continue;
    }
    const descriptionValue = parsed.value.description;
    const replacementsRaw = parsed.value.replacements;
    const replacements: Record<string, string> = {};
    if (isMappingValue(replacementsRaw)) {
      for (const [key, value] of Object.entries(replacementsRaw)) {
        if (typeof value !== "string") {
          diagnostics.push({
            code: "PROFILE_REPLACEMENT_INVALID",
            logicalPath: file,
            message: `replacement '${key}' must be a scalar string`
          });
          continue;
        }
        replacements[key] = value;
      }
    }
    profileNames.add(name);
    profiles.push({
      name,
      description: typeof descriptionValue === "string" ? descriptionValue : null,
      replacements
    });
  }

  // Projects + assets. Two passes: definitions first (file order must not
  // matter), then assets, so project assets never race their project.yaml.
  const projects: ProjectDefinition[] = [];
  const projectIds = new Set<string>();
  const assets: InventoryAsset[] = [];

  for (const file of files) {
    if (!file.startsWith("projects/") || !file.endsWith("/project.yaml")) {
      continue;
    }
    const projectId = file.split("/")[1] ?? "";
    const rest = file.slice("projects/".length + projectId.length + 1);
    if (projectId.length === 0 || rest !== "project.yaml") {
      continue;
    }
    if (projectIds.has(projectId)) {
      diagnostics.push({
        code: "PROJECT_DUPLICATE",
        logicalPath: file,
        message: `duplicate project directory '${projectId}'`
      });
      continue;
    }
    const bytes = await source.readFile(file);
    if (bytes === null) {
      diagnostics.push({ code: "FILE_UNREADABLE", logicalPath: file, message: "project.yaml could not be read" });
      continue;
    }
    const definition = parseProjectDefinition(bytes, file, diagnostics);
    if (definition === null) {
      continue;
    }
    if (definition.projectId !== projectId) {
      diagnostics.push({
        code: "PROJECT_ID_MISMATCH",
        logicalPath: file,
        message: `project.yaml declares '${definition.projectId}' but lives in 'projects/${projectId}'`
      });
      continue;
    }
    projectIds.add(projectId);
    projects.push(definition);
  }

  for (const file of files) {
    if (file === "ruleswitch.yaml" || file.startsWith("profiles/")) {
      continue;
    }
    if (file.startsWith(".ruleswitch/")) {
      continue; // tool metadata, never an asset
    }
    if (file.startsWith("projects/") && file.endsWith("/project.yaml")) {
      continue; // already consumed above
    }

    const asset = await classifyFile(file, source, hasher, diagnostics, projectIds);
    if (asset !== null) {
      assets.push(asset);
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const keyOf = (asset: InventoryAsset): string => serializeAssetKey(asset);
  assets.sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0));

  const graphDigest = hasher.sha256Hex(
    assets.map((asset) => `${serializeAssetKey(asset)}|${asset.contentDigest}`).join("\n")
  );

  return {
    ok: true,
    inventory: {
      manifest: manifestResult.manifest,
      projects: [...projects].sort((left, right) => (left.projectId < right.projectId ? -1 : 1)),
      profiles: [...profiles].sort((left, right) => (left.name < right.name ? -1 : 1)),
      assets,
      graphDigest
    }
  };
}

async function classifyFile(
  file: string,
  source: RepoFileSource,
  hasher: StableIdHasher,
  diagnostics: RepoDiagnostic[],
  projectIds: ReadonlySet<string>
): Promise<InventoryAsset | null> {
  const segments = file.split("/");
  const bytes = await source.readFile(file);
  if (bytes === null) {
    diagnostics.push({ code: "FILE_UNREADABLE", logicalPath: file, message: "listed file could not be read" });
    return null;
  }
  const contentDigest = hasher.sha256Hex(utf8Decode(bytes));

  const asset = (scope: ScopeRef, kind: AssetKind, logicalName: string): InventoryAsset | null => {
    try {
      return {
        scope,
        kind,
        logicalName: normalizeAssetLogicalName(logicalName),
        content: bytes,
        contentDigest,
        sourceLogicalPath: file
      };
    } catch (error) {
      diagnostics.push({
        code: "ASSET_NAME_INVALID",
        logicalPath: file,
        message: (error as Error).message
      });
      return null;
    }
  };

  if (segments[0] === "global") {
    const kind = segments[1];
    if (kind === undefined) {
      return null; // bare "global" file — ignored
    }
    if (kind === "native") {
      const adapterId = segments[2];
      const rest = segments.slice(3).join("/");
      if (adapterId === undefined || rest.length === 0) {
        diagnostics.push({
          code: "NATIVE_PATH_INVALID",
          logicalPath: file,
          message: "native variants must live under global/native/<adapterId>/..."
        });
        return null;
      }
      return asset({ kind: "global" }, "native", `${adapterId}/${rest}`);
    }
    if (!(NON_NATIVE_KINDS as readonly string[]).includes(kind)) {
      diagnostics.push({
        code: "KIND_UNKNOWN",
        logicalPath: file,
        message: `unknown config kind directory '${kind}' (expected one of ${ASSET_KINDS.join(", ")})`
      });
      return null;
    }
    const rest = segments.slice(2).join("/");
    if (rest.length === 0) {
      return null; // a file directly named like a kind directory — ignored
    }
    return asset({ kind: "global" }, kind as AssetKind, rest);
  }

  if (segments[0] === "projects") {
    const projectId = segments[1];
    if (projectId === undefined) {
      return null;
    }
    if (!projectIds.has(projectId)) {
      diagnostics.push({
        code: "PROJECT_MISSING_DEFINITION",
        logicalPath: file,
        message: `assets under projects/${projectId} require projects/${projectId}/project.yaml`
      });
      return null;
    }
    const rest = segments.slice(2).join("/");
    if (rest.startsWith(".ruleswitch/native/")) {
      const nativeRest = rest.slice(".ruleswitch/native/".length);
      if (nativeRest.length === 0) {
        return null;
      }
      return asset({ kind: "project", projectId }, "native", nativeRest);
    }
    if (rest === ".ruleswitch" || rest.startsWith(".ruleswitch/")) {
      return null; // project tool metadata other than native variants
    }
    const kind = segments[2];
    if (kind === undefined || !(NON_NATIVE_KINDS as readonly string[]).includes(kind)) {
      diagnostics.push({
        code: "KIND_UNKNOWN",
        logicalPath: file,
        message: `unknown config kind directory '${kind ?? ""}' under a project`
      });
      return null;
    }
    const kindRest = segments.slice(3).join("/");
    if (kindRest.length === 0) {
      return null;
    }
    return asset({ kind: "project", projectId }, kind as AssetKind, kindRest);
  }

  return null; // unmanaged top-level content
}

function parseProjectDefinition(
  bytes: Uint8Array,
  file: string,
  diagnostics: RepoDiagnostic[]
): ProjectDefinition | null {
  const parsed = parseYamlSubset(utf8Decode(bytes));
  if (!parsed.ok) {
    diagnostics.push({
      code: "PROJECT_YAML_SYNTAX",
      logicalPath: file,
      message: `line ${parsed.error.line}: ${parsed.error.message}`
    });
    return null;
  }
  if (!isMappingValue(parsed.value)) {
    diagnostics.push({ code: "PROJECT_YAML_INVALID", logicalPath: file, message: "project.yaml must be a mapping" });
    return null;
  }
  const projectId = parsed.value.projectId;
  const displayName = parsed.value.displayName;
  const gitRemotes = parsed.value.gitRemotes;
  if (typeof projectId !== "string" || typeof displayName !== "string") {
    diagnostics.push({
      code: "PROJECT_YAML_INVALID",
      logicalPath: file,
      message: "project.yaml requires string fields projectId and displayName"
    });
    return null;
  }
  const remoteMatch: string[] = [];
  if (typeof gitRemotes === "object" && gitRemotes !== null && "items" in gitRemotes) {
    for (const item of (gitRemotes as { items: readonly unknown[] }).items) {
      if (typeof item !== "string") {
        diagnostics.push({
          code: "PROJECT_YAML_INVALID",
          logicalPath: file,
          message: "gitRemotes entries must be strings"
        });
        return null;
      }
      remoteMatch.push(item);
    }
  }
  if (!/^prj_[a-z0-9][a-z0-9-]{2,62}$/.test(projectId)) {
    diagnostics.push({
      code: "PROJECT_ID_INVALID",
      logicalPath: file,
      message: "projectId must match ^prj_[a-z0-9][a-z0-9-]{2,62}$"
    });
    return null;
  }
  for (const pattern of remoteMatch) {
    if (!/^(git:\/\/|file:\/\/)[^\s]*$/.test(pattern) || pattern.includes("..")) {
      diagnostics.push({
        code: "PROJECT_MATCH_INVALID",
        logicalPath: file,
        message: `invalid remote match pattern: ${pattern}`
      });
      return null;
    }
  }
  return {
    projectId,
    displayName,
    remoteMatch,
    createdAt: "1970-01-01T00:00:00.000Z"
  };
}
