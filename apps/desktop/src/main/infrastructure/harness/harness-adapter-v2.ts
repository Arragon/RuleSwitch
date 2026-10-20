// Harness Adapter v2 factory (INH-1803..1806): one generic implementation
// per the frozen Adapter v2 contract, parameterized by the frozen capability
// matrix (harness-capabilities.ts in core). There are NO per-harness
// branches in Core — the factory lives in Main infrastructure and consumes
// the matrix.
//
// Kinds are implemented generically over the harness root layout:
//  - instructions/commands/prompts/agents: markdown files in declared dirs
//  - skills: whole directories (M3 semantics)
//  - native: raw mirror
// Kinds the matrix marks unsupported produce structured unsupported
// outcomes (never silent drops). Every filesystem join is root-contained.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  createHarnessInstanceRef,
  createHarnessInstanceId,
  digestSkillFiles,
  inferExecutable,
  matrixKindsFor,
  matrixRowFor,
  type AdapterId,
  type CapabilityMatrix,
  type ConversionOutcome,
  type DetectResult,
  type HarnessAdapter,
  type HarnessInstanceSnapshot,
  type ImportedAsset,
  type KindRow,
  type RenderedTarget,
  type ScanResult,
  type ScopeRef,
  type SkillAsset,
  type StableIdHasher,
  type VerifyReport,
  type VerifyResult
} from "@ruleswitch/core";

const nodeHasher: StableIdHasher = {
  sha256Hex(input) {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

export interface AdapterV2Options {
  readonly adapterId: AdapterId;
  readonly scope: ScopeRef;
  readonly scopeRoot: string; // absolute harness root for this scope
  readonly hasher?: StableIdHasher;
}

/** Root-contained join: rejects traversal and proves containment. */
function safeJoin(root: string, relative: string): string {
  if (
    relative.length === 0 ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    relative.startsWith("/") ||
    /^[A-Za-z]:/.test(relative) ||
    relative.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`refusing unsafe harness-relative path: ${JSON.stringify(relative)}`);
  }
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`harness path escapes root: ${JSON.stringify(relative)}`);
  }
  return target;
}

/** Kind → harness-root-relative directory mapping (per matrix formats). */
function kindDirectoryPrefix(kind: string): string {
  const directories: Record<string, string> = {
    instructions: "",
    skills: "skills",
    commands: "commands",
    prompts: "prompts",
    agents: "agents"
  };
  return directories[kind] ?? "";
}

function targetPathFor(kind: string, logicalName: string): string {
  const prefix = kindDirectoryPrefix(kind);
  return prefix.length === 0 ? logicalName : `${prefix}/${logicalName}`;
}

export class HarnessAdapterV2 implements HarnessAdapter {
  readonly descriptor: {
    adapterId: AdapterId;
    displayName: string;
    adapterVersion: string;
    platforms: readonly ("darwin" | "win32" | "linux")[];
    configKinds: readonly ("instructions" | "skills" | "mcp" | "hooks" | "commands" | "prompts" | "agents" | "settings" | "native")[];
  };

  private readonly kindRows: readonly KindRow[];
  private readonly platformConstraints: readonly ("darwin" | "win32" | "linux")[];
  private readonly runtimeRequirements: readonly string[];

  constructor(private readonly options: AdapterV2Options) {
    const row = matrixRowFor(options.adapterId);
    if (row === null) {
      throw new Error(`no capability matrix for adapter '${options.adapterId}'`);
    }
    this.kindRows = matrixKindsFor(options.adapterId);
    this.platformConstraints = [...row.platformConstraints];
    this.runtimeRequirements = [...row.runtimeRequirements];
    this.descriptor = {
      adapterId: options.adapterId,
      displayName: row.displayName,
      adapterVersion: "2.0.0-m6",
      platforms: [...row.platformConstraints],
      configKinds: this.kindRows
        .filter((kind) => kind.global !== "unsupported" || kind.project !== "unsupported")
        .map((kind) => kind.kind)
    };
  }

  describeCapabilities(): CapabilityMatrix {
    return {
      adapterId: this.options.adapterId,
      kinds: this.kindRows.map((kind) => ({
        kind: kind.kind,
        global: kind.global,
        project: kind.project,
        verify: kind.verify,
        roundTripGrade: kind.roundTripGrade,
        runtimeRequirements: [...this.runtimeRequirements],
        platformConstraints: [...this.platformConstraints]
      }))
    };
  }

  capabilityFor(kind: string, scope: ScopeRef): "read-write" | "read-only" | "unsupported" {
    const kindRow = this.kindRows.find((entry) => entry.kind === kind);
    if (kindRow === undefined) {
      return "unsupported";
    }
    return scope.kind === "global" ? kindRow.global : kindRow.project;
  }

  async detectInstances(): Promise<DetectResult> {
    let exists = false;
    try {
      exists = (await stat(this.options.scopeRoot)).isDirectory();
    } catch {
      exists = false;
    }
    return {
      grade: "lossless",
      diagnostics: [],
      output: exists
        ? [
            {
              harnessInstanceId: this.instanceId(),
              adapterId: this.options.adapterId,
              scope: this.options.scope,
              actualDigests: {}
            }
          ]
        : []
    };
  }

  async scan(): Promise<ScanResult> {
    const actualDigests: Record<string, string | null> = {};
    for (const kindRow of this.kindRows) {
      if (kindRow.global === "unsupported" && kindRow.project === "unsupported") {
        actualDigests[kindRow.kind] = null;
        continue;
      }
      try {
        actualDigests[kindRow.kind] = await this.kindDigest(kindRow.kind);
      } catch {
        actualDigests[kindRow.kind] = null;
      }
    }
    return {
      grade: "lossless",
      diagnostics: [],
      output: {
        harnessInstanceId: this.instanceId(),
        adapterId: this.options.adapterId,
        scope: this.options.scope,
        actualDigests
      }
    };
  }

  async import(scan: HarnessInstanceSnapshot): Promise<ConversionOutcome<readonly ImportedAsset[]>> {
    void scan;
    const assets: ImportedAsset[] = [];
    for (const kindRow of this.kindRows) {
      const level = this.options.scope.kind === "global" ? kindRow.global : kindRow.project;
      if (level !== "read-write") {
        continue;
      }
      if (kindRow.kind === "skills") {
        const skills = await this.listSkills();
        for (const skill of skills) {
          for (const file of skill.files) {
            assets.push({
              assetKey: `${this.serializeScope()}|skills|${skill.skillName}/${file.relativePath}`,
              kind: "skills",
              logicalName: `${skill.skillName}/${file.relativePath}`,
              content: file.content,
              grade: "lossless",
              diagnostics: []
            });
          }
        }
        continue;
      }
      if (kindRow.kind === "instructions" || kindRow.kind === "commands" || kindRow.kind === "prompts" || kindRow.kind === "agents") {
        const dir = path.join(this.options.scopeRoot, kindDirectoryPrefix(kindRow.kind));
        const files = await this.listFilesFlat(dir).catch(() => [] as string[]);
        for (const file of files) {
          assets.push({
            assetKey: `${this.serializeScope()}|${kindRow.kind}|${file}`,
            kind: kindRow.kind,
            logicalName: file,
            content: new Uint8Array(await readFile(safeJoin(dir, file))),
            grade: "lossless",
            diagnostics: []
          });
        }
      }
    }
    return { grade: "lossless", diagnostics: [], output: assets };
  }

  async render(
    _instanceId: string,
    assets: readonly { assetKey: string; kind: string; logicalName: string; content: Uint8Array }[]
  ): Promise<ConversionOutcome<readonly RenderedTarget[]>> {
    const targets: RenderedTarget[] = [];
    const diagnostics: { code: string; message: string; severity: "loss" | "warning" | "error"; subject: string | null }[] = [];
    for (const asset of assets) {
      const kindRow = this.kindRows.find((entry) => entry.kind === asset.kind);
      const level = kindRow ? (this.options.scope.kind === "global" ? kindRow.global : kindRow.project) : "unsupported";
      if (kindRow === undefined || level === "unsupported") {
        diagnostics.push({
          code: "kind-unsupported",
          message: `harness '${this.options.adapterId}' does not support kind '${asset.kind}'`,
          severity: "error",
          subject: asset.assetKey
        });
        continue;
      }
      targets.push({
        targetLogicalPath: targetPathFor(asset.kind, asset.logicalName),
        content: asset.content,
        outputDigest: nodeHasher.sha256Hex(Buffer.from(asset.content).toString("binary")),
        grade: kindRow.roundTripGrade === "unsupported" ? "degraded" : kindRow.roundTripGrade,
        diagnostics: []
      });
    }
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { grade: "unsupported", diagnostics, output: null };
    }
    return { grade: "lossless", diagnostics, output: targets };
  }

  async verify(
    _instanceId: string,
    expectations: readonly { targetLogicalPath: string; expectedDigest: string }[]
  ): Promise<VerifyResult> {
    const reports: VerifyReport[] = [];
    for (const expectation of expectations) {
      let actual: string | null = null;
      try {
        const bytes = new Uint8Array(await readFile(safeJoin(this.options.scopeRoot, expectation.targetLogicalPath)));
        actual = nodeHasher.sha256Hex(Buffer.from(bytes).toString("binary"));
      } catch {
        actual = null;
      }
      reports.push({
        targetLogicalPath: expectation.targetLogicalPath,
        verified: actual === expectation.expectedDigest,
        actualDigest: actual,
        expectedDigest: expectation.expectedDigest,
        problems:
          actual === expectation.expectedDigest
            ? []
            : [
                {
                  code: "digest-mismatch",
                  message: "harness file does not match the expected digest",
                  severity: "error" as const,
                  subject: expectation.targetLogicalPath
                }
              ]
      });
    }
    return { grade: "lossless", diagnostics: [], output: reports };
  }

  private instanceId(): string {
    return createHarnessInstanceId(
      createHarnessInstanceRef(this.options.adapterId, this.options.scope),
      this.options.hasher ?? nodeHasher
    );
  }

  private serializeScope(): string {
    return this.options.scope.kind === "global" ? "global" : `project:${this.options.scope.projectId}`;
  }

  private async kindDigest(kind: string): Promise<string | null> {
    if (kind === "skills") {
      const skills = await this.listSkills();
      return skills.length === 0 ? null : nodeHasher.sha256Hex(skills.map((skill) => skill.digest).join("\n"));
    }
    // Only directory-backed file kinds have scannable digests here; MCP /
    // settings / hooks are structured documents and native is mirrored via
    // dedicated paths — v2.0-m6 scan reports them as null (no fake digest).
    const prefix = kindDirectoryPrefix(kind);
    if (prefix.length === 0 && kind !== "instructions") {
      return null;
    }
    const dir = path.join(this.options.scopeRoot, prefix);
    const files = await this.listFilesFlat(dir).catch(() => [] as string[]);
    if (files.length === 0) {
      return null;
    }
    return nodeHasher.sha256Hex(files.join("\n"));
  }

  private async listSkills(): Promise<readonly SkillAsset[]> {
    const skillsRoot = path.join(this.options.scopeRoot, "skills");
    const names: string[] = [];
    try {
      const entries = await readdir(skillsRoot, { withFileTypes: true });
      for (const entry of entries) {
        const info = await lstat(safeJoin(skillsRoot, entry.name));
        if (info.isSymbolicLink()) {
          throw new Error(`symlink rejected: ${entry.name}`);
        }
        if (info.isDirectory()) {
          names.push(entry.name);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const skills: SkillAsset[] = [];
    for (const name of names.sort()) {
      const files: { relativePath: string; content: Uint8Array; executable: boolean }[] = [];
      await collectFiles(safeJoin(skillsRoot, name), name, files);
      if (files.length === 0) {
        continue;
      }
      skills.push({
        skillName: name,
        files: files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1)),
        digest: digestSkillFiles(files, this.options.hasher ?? nodeHasher)
      });
    }
    return skills;
  }

  private async listFilesFlat(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const info = await lstat(safeJoin(dir, entry.name));
      if (info.isSymbolicLink()) {
        throw new Error(`symlink rejected: ${entry.name}`);
      }
      if (info.isFile()) {
        files.push(entry.name);
      }
    }
    return files.sort();
  }
}

async function collectFiles(
  root: string,
  relative: string,
  files: { relativePath: string; content: Uint8Array; executable: boolean }[]
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = safeJoin(root, entry.name);
    const rel = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`symlink rejected: ${rel}`);
    }
    if (info.isDirectory()) {
      await collectFiles(absolute, rel, files);
      continue;
    }
    if (info.isFile()) {
      const bytes = new Uint8Array(await readFile(absolute));
      files.push({
        relativePath: rel,
        content: bytes,
        executable: inferExecutable(rel, bytes) || info.mode % 2 === 1
      });
    }
  }
}

export function createHarnessAdapterV2(options: AdapterV2Options): HarnessAdapterV2 {
  return new HarnessAdapterV2(options);
}
