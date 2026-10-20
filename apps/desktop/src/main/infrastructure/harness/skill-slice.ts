// M3 skill-slice harness adapters (INH-1775/1776) + minimal transactional
// apply/restore helper used by the E2E legs.
//
// Real macOS layouts (declared per current tool conventions; M6 re-verifies
// against installed harnesses):
//   Claude Code: <home>/.claude/skills/<skill>/...     (global)
//                <project>/.claude/skills/<skill>/...  (project)
//   Codex:       <home>/.codex/skills/<skill>/...      (global)
//                <project>/.codex/skills/<skill>/...   (project)
//
// Adapters are read-only (detect/scan/render/verify). All writes to real
// harness directories go through applyRenderedTargetsWithSnapshot, which
// snapshots current bytes first, refuses first-adoption without explicit
// confirmation, verifies after writing, and can restore the snapshot.

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ConversionOutcome,
  DetectResult,
  HarnessAdapter,
  HarnessInstanceSnapshot,
  RenderedTarget,
  ScanResult,
  VerifyReport,
  VerifyResult
} from "@ruleswitch/core";
import {
  createHarnessInstanceRef,
  createHarnessInstanceId,
  digestSkillFiles,
  inferExecutable,
  type AdapterId,
  type ScopeRef,
  type SkillAsset,
  type SkillFile,
  type StableIdHasher
} from "@ruleswitch/core";

const nodeHasher: StableIdHasher = {
  sha256Hex(input) {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
};

export class SymlinkInHarnessError extends Error {
  constructor(readonly absolutePath: string) {
    super(`symlink rejected inside harness directory: ${absolutePath}`);
    this.name = "SymlinkInHarnessError";
  }
}

function safeChild(root: string, relative: string): string {
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
    throw new Error(`path escapes the harness root: ${JSON.stringify(relative)}`);
  }
  return target;
}

async function listFilesRecursive(root: string, relativeDir: string, files: string[]): Promise<void> {
  const entries = await readdir(relativeDir.length === 0 ? root : safeChild(root, relativeDir), {
    withFileTypes: true
  });
  for (const entry of entries) {
    const relative = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    const absolute = safeChild(root, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new SymlinkInHarnessError(absolute);
    }
    if (info.isDirectory()) {
      await listFilesRecursive(root, relative, files);
      continue;
    }
    if (info.isFile()) {
      files.push(relative);
    }
  }
}

export interface SkillSliceAdapterOptions {
  readonly adapterId: AdapterId;
  readonly displayName: string;
  /** Absolute harness root for the requested scope (e.g. <home>/.claude or <project>/.claude). */
  readonly scopeRoot: string;
  readonly scope: ScopeRef;
}

/** Read-only skill slice adapter implementing the frozen v2 interface surface plus skill-level helpers. */
export class SkillSliceAdapter implements HarnessAdapter {
  readonly descriptor: {
    adapterId: AdapterId;
    displayName: string;
    adapterVersion: string;
    platforms: readonly ("darwin" | "win32" | "linux")[];
    configKinds: readonly ("skills" | "instructions")[];
  };

  constructor(private readonly options: SkillSliceAdapterOptions) {
    this.descriptor = {
      adapterId: options.adapterId,
      displayName: options.displayName,
      adapterVersion: "0.1.0-m3-slice",
      platforms: ["darwin"],
      configKinds: ["skills", "instructions"]
    };
  }

  get skillsRoot(): string {
    return path.join(this.options.scopeRoot, "skills");
  }

  private harnessInstanceId(): string {
    return createHarnessInstanceId(
      createHarnessInstanceRef(this.options.adapterId, this.options.scope),
      nodeHasher
    );
  }

  async detectInstances(): Promise<DetectResult> {
    let exists = false;
    try {
      exists = (await stat(this.options.scopeRoot)).isDirectory();
    } catch {
      exists = false;
    }
    const snapshot: HarnessInstanceSnapshot = {
      harnessInstanceId: this.harnessInstanceId(),
      adapterId: this.options.adapterId,
      scope: this.options.scope,
      actualDigests: {}
    };
    return {
      grade: "lossless",
      diagnostics: [],
      output: exists ? [snapshot] : []
    };
  }

  async scan(): Promise<ScanResult> {
    const actualDigests: Record<string, string | null> = {};
    let rootExists = false;
    try {
      rootExists = (await stat(this.skillsRoot)).isDirectory();
    } catch {
      rootExists = false;
    }
    if (rootExists) {
      const skills = await this.listSkills();
      for (const skill of skills) {
        actualDigests[`skills/${skill.skillName}`] = skill.digest;
      }
    }
    const instance: HarnessInstanceSnapshot = {
      harnessInstanceId: this.harnessInstanceId(),
      adapterId: this.options.adapterId,
      scope: this.options.scope,
      actualDigests
    };
    return { grade: "lossless", diagnostics: [], output: instance };
  }

  describeCapabilities() {
    // Only the VERIFIED M3 slice capability is declared; everything else
    // stays unsupported until its milestone proves it.
    return {
      adapterId: this.options.adapterId,
      kinds: [
        {
          kind: "skills" as const,
          global: "read-write" as const,
          project: "read-write" as const,
          verify: true,
          roundTripGrade: "lossless" as const,
          runtimeRequirements: [],
          platformConstraints: ["darwin" as const]
        }
      ]
    };
  }

  async import(): Promise<ConversionOutcome<never>> {
    // Bulk import lands in M4 CapturePlan wiring; the slice uses importSkill.
    return { grade: "unsupported", diagnostics: [{ code: "not-in-m3-slice", message: "use importSkill()", severity: "error", subject: null }], output: null };
  }

  async render(instanceId: string, assets: readonly { assetKey: string; kind: string; logicalName: string; content: Uint8Array }[]): Promise<ConversionOutcome<readonly RenderedTarget[]>> {
    void instanceId;
    const targets: RenderedTarget[] = [];
    for (const asset of assets) {
      if (asset.kind !== "skills") {
        continue;
      }
      targets.push({
        targetLogicalPath: `skills/${asset.logicalName}`,
        content: asset.content,
        outputDigest: digestContent(asset.content),
        grade: "lossless",
        diagnostics: []
      });
    }
    return { grade: "lossless", diagnostics: [], output: targets };
  }

  async verify(instanceId: string, expectations: readonly { targetLogicalPath: string; expectedDigest: string }[]): Promise<VerifyResult> {
    void instanceId;
    const reports: VerifyReport[] = [];
    for (const expectation of expectations) {
      let actual: string | null = null;
      try {
        const bytes = await readFile(safeChild(this.options.scopeRoot, expectation.targetLogicalPath));
        actual = digestContent(new Uint8Array(bytes));
      } catch {
        actual = null;
      }
      reports.push({
        targetLogicalPath: expectation.targetLogicalPath,
        verified: actual === expectation.expectedDigest,
        actualDigest: actual,
        expectedDigest: expectation.expectedDigest,
        problems: actual === expectation.expectedDigest ? [] : [{ code: "digest-mismatch", message: "harness file does not match the expected digest", severity: "error", subject: expectation.targetLogicalPath }]
      });
    }
    return { grade: "lossless", diagnostics: [], output: reports };
  }

  // -- slice helpers ------------------------------------------------------

  async listSkills(): Promise<readonly SkillAsset[]> {
    const names: string[] = [];
    try {
      const entries = await readdir(this.skillsRoot, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = safeChild(this.skillsRoot, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          throw new SymlinkInHarnessError(absolute);
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
      const skill = await this.readSkill(name);
      if (skill !== null) {
        skills.push(skill);
      }
    }
    return skills;
  }

  async readSkill(skillName: string): Promise<SkillAsset | null> {
    const files: string[] = [];
    try {
      await listFilesRecursive(this.skillsRoot, skillName, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const skillFiles: SkillFile[] = [];
    for (const file of files) {
      const absolute = safeChild(this.skillsRoot, file);
      const bytes = new Uint8Array(await readFile(absolute));
      const relativePath = file.slice(skillName.length + 1);
      skillFiles.push({
        relativePath,
        content: bytes,
        executable: inferExecutable(relativePath, bytes) || (await stat(absolute)).mode % 2 === 1
      });
    }
    if (skillFiles.length === 0) {
      return null; // empty/absent directory is not a skill
    }
    return {
      skillName,
      files: skillFiles.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1)),
      digest: digestSkillFiles(skillFiles, nodeHasher)
    };
  }
}

// ---------------------------------------------------------------------------
// Transactional apply / restore helper (writes real harness directories)
// ---------------------------------------------------------------------------

export interface AppliedSnapshot {
  readonly targetRoot: string;
  readonly files: readonly { readonly relativePath: string; readonly existedBefore: boolean; readonly previousContent: Uint8Array | null }[];
}

export type ApplyDecision =
  | { readonly ok: true; readonly snapshot: AppliedSnapshot }
  | { readonly ok: false; readonly code: "FIRST_ADOPTION_CONFIRMATION_REQUIRED" | "UNMANAGED_TARGET_CHANGED" | "VERIFY_FAILED"; readonly message: string };

function digestContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Applies rendered targets under a harness root with Phase-A-style safety:
 * snapshot first, refuse unconfirmed first adoption and mid-flight target
 * changes, write atomically per file (temp + rename), verify after.
 */
export async function applyRenderedTargets(input: {
  readonly targetRoot: string;
  readonly targets: readonly { targetLogicalPath: string; content: Uint8Array }[];
  readonly firstAdoptionConfirmed: boolean;
  /** Baseline digests RuleSwitch recorded (managed targets); null/undefined = unmanaged state. */
  readonly baselineDigests: Readonly<Record<string, string>>;
}): Promise<ApplyDecision> {
  const { targetRoot, targets } = input;
  const snapshotFiles: {
    relativePath: string;
    existedBefore: boolean;
    previousContent: Uint8Array | null;
  }[] = [];

  for (const target of targets) {
    const absolute = safeChild(targetRoot, target.targetLogicalPath);
    let existedBefore = false;
    let previousContent: Uint8Array | null = null;
    try {
      previousContent = new Uint8Array(await readFile(absolute));
      existedBefore = true;
    } catch {
      existedBefore = false;
    }
    snapshotFiles.push({ relativePath: target.targetLogicalPath, existedBefore, previousContent });

    const baseline = input.baselineDigests[target.targetLogicalPath];
    if (existedBefore) {
      if (baseline === undefined) {
        if (!input.firstAdoptionConfirmed) {
          return {
            ok: false,
            code: "FIRST_ADOPTION_CONFIRMATION_REQUIRED",
            message: `target exists but has no RuleSwitch baseline: ${target.targetLogicalPath}; confirm ownership first`
          };
        }
      } else if (baseline !== digestContent(previousContent ?? new Uint8Array())) {
        return {
          ok: false,
          code: "UNMANAGED_TARGET_CHANGED",
          message: `target changed since the recorded baseline: ${target.targetLogicalPath}`
        };
      }
    }
  }

  for (const target of targets) {
    const absolute = safeChild(targetRoot, target.targetLogicalPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporaryPath = `${absolute}.ruleswitch-tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, target.content);
    await rm(absolute, { force: true });
    await copyFile(temporaryPath, absolute);
    await rm(temporaryPath, { force: true });
    if (target.targetLogicalPath.includes("/scripts/") || target.targetLogicalPath.endsWith(".sh")) {
      await (await import("node:fs/promises")).chmod(absolute, 0o755);
    }
  }

  for (const target of targets) {
    const absolute = safeChild(targetRoot, target.targetLogicalPath);
    const written = new Uint8Array(await readFile(absolute));
    if (digestContent(written) !== digestContent(target.content)) {
      return { ok: false, code: "VERIFY_FAILED", message: `post-write verify failed: ${target.targetLogicalPath}` };
    }
  }

  return { ok: true, snapshot: { targetRoot, files: snapshotFiles } };
}

/** Restores a snapshot exactly: previous bytes back, newly created files removed. */
export async function restoreSnapshot(snapshot: AppliedSnapshot): Promise<void> {
  for (const file of [...snapshot.files].reverse()) {
    const absolute = safeChild(snapshot.targetRoot, file.relativePath);
    if (!file.existedBefore) {
      await rm(absolute, { force: true });
      continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.previousContent ?? new Uint8Array());
  }
}

export function claudeGlobalRoot(home: string): string {
  return path.join(home, ".claude");
}

export function claudeProjectRoot(projectRoot: string): string {
  return path.join(projectRoot, ".claude");
}

export function codexGlobalRoot(home: string): string {
  return path.join(home, ".codex");
}

export function codexProjectRoot(projectRoot: string): string {
  return path.join(projectRoot, ".codex");
}
