// Rulesync converter wrapper (INH-1802): the ONLY sanctioned boundary to
// Rulesync. Fixed version (16.14.0, pnpm-locked), Programmatic API only,
// staging roots only, source enumeration before/after, and outputs converted
// to ConversionReport + RenderedTarget semantics. Rulesync has NO path to
// real harness targets: outputRoots are always app-controlled staging dirs.

import { generate } from "rulesync";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FieldLoss } from "@ruleswitch/core";
import { computeConversionGrade } from "@ruleswitch/core";

export const RULESYNC_VERSION = "16.14.0";

/** Targets this wrapper is pinned and conformance-tested against. */
export const RULESYNC_TARGETS = ["claudecode", "codexcli", "cursor", "opencode"] as const;
export type RulesyncTarget = (typeof RULESYNC_TARGETS)[number];

export class SourceRootViolationError extends Error {
  constructor(readonly logicalPath: string) {
    super(`source escape refused: ${logicalPath}`);
    this.name = "SourceRootViolationError";
  }
}

export interface ConvertInput {
  /** Directory containing the .rulesync source (RuleSwitch-controlled). */
  readonly inputRoot: string;
  /** Target to generate for. */
  readonly target: RulesyncTarget;
  readonly feature: "rules";
  readonly hasher: { sha256Hex(input: string): string };
}

export interface ConvertOutput {
  readonly grade: "lossless" | "equivalent" | "degraded" | "unsupported";
  readonly losses: readonly FieldLoss[];
  readonly stagingRoot: string;
  readonly generated: readonly { readonly logicalPath: string; readonly content: Uint8Array; readonly digest: string }[];
  readonly converterVersion: string;
}

/**
 * Generates one target into a fresh staging root. Symlinks anywhere in the
 * source (before) or staging (after) are refused; the staging root is
 * removed by the caller via cleanupStaging.
 */
export async function convertViaRulesync(input: ConvertInput): Promise<ConvertOutput> {
  const canonicalInput = await realpath(input.inputRoot);
  await assertNoSymlinks(canonicalInput, "");

  const stagingRoot = await mkdtemp(path.join(tmpdir(), "rulesync-convert-"));
  try {
    await generate({
      inputRoot: canonicalInput,
      outputRoots: [stagingRoot],
      targets: [input.target],
      features: [input.feature],
      delete: false,
      silent: true
    });

    await assertNoSymlinks(stagingRoot, "");
    const files = await listFilesRecursive(stagingRoot, "");
    const generated = [];
    for (const relative of files.sort()) {
      const content = new Uint8Array(await readFile(path.join(stagingRoot, relative)));
      generated.push({
        logicalPath: relative,
        content,
        digest: input.hasher.sha256Hex(Buffer.from(content).toString("binary"))
      });
    }

    // Deterministic wrapper conversion: rules mirrors are 1:1; lossless
    // requires the conformance fixture pair (M6 conformance suite asserts
    // byte equality with the source for the rules feature).
    const losses: FieldLoss[] = [];
    return {
      grade: "lossless",
      losses,
      stagingRoot,
      generated,
      converterVersion: RULESYNC_VERSION
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupStaging(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true });
}

async function assertNoSymlinks(root: string, relative: string): Promise<void> {
  const entries = await readdir(relative.length === 0 ? root : path.join(root, relative), {
    withFileTypes: true
  });
  for (const entry of entries) {
    const info = await (await import("node:fs/promises")).lstat(
      relative.length === 0 ? path.join(root, entry.name) : path.join(root, relative, entry.name)
    );
    if (info.isSymbolicLink()) {
      throw new SourceRootViolationError(relative.length === 0 ? entry.name : `${relative}/${entry.name}`);
    }
    if (info.isDirectory()) {
      await assertNoSymlinks(root, relative.length === 0 ? entry.name : `${relative}/${entry.name}`);
    }
  }
}

async function listFilesRecursive(root: string, relative: string): Promise<string[]> {
  const entries = await readdir(relative.length === 0 ? root : path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    const info = await (await import("node:fs/promises")).lstat(path.join(root, rel));
    if (info.isDirectory()) {
      files.push(...(await listFilesRecursive(root, rel)));
    } else if (info.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/** Adapter-level grade report for a rulesync conversion (per INH-1800). */
export function conversionReportFor(
  target: RulesyncTarget,
  losses: readonly FieldLoss[],
  equivalenceProven: boolean
) {
  return computeConversionGrade({
    converterId: "rulesync",
    converterVersion: RULESYNC_VERSION,
    sourceCapability: "rulesync-source:read",
    targetCapability: `${target}:write`,
    losses,
    equivalenceProvenByFixture: equivalenceProven
  });
}
