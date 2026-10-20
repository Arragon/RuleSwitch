// Harness Capability & Path Evidence Matrix (INH-1801), code-frozen.
//
// Every adapter capability declared here is backed by one of:
//  - "controlled-fixture": verified on this machine against the documented
//    layout in an isolated HOME (unit/integration evidence);
//  - "machine-evidence": the real harness directory exists on this machine
//    and the layout was probed (see evidenceDate);
//  - "official-docs": layout per official docs, marked experimental until
//    machine evidence lands.
// Anything not listed is UNSUPPORTED — adapters may only declare what this
// matrix contains.

import type { CapabilityLevel, Platform } from "./harness-adapter";
import type { AssetKind } from "./identity";
import type { ConversionGrade } from "./reconcile";

export type { CapabilityLevel };

export type EvidenceKind = "controlled-fixture" | "machine-evidence" | "official-docs";

export interface HarnessPathEvidence {
  readonly globalRoot: string; // ~-relative, e.g. ".codex"
  readonly projectRoot: string; // project-relative, e.g. ".codex"
  readonly evidenceKind: EvidenceKind;
  readonly evidenceDate: string;
  readonly installedProbe: "directory-exists" | "command-exists" | "not-installed";
}

export interface KindRow {
  readonly kind: AssetKind;
  readonly global: CapabilityLevel;
  readonly project: CapabilityLevel;
  readonly verify: boolean;
  readonly roundTripGrade: ConversionGrade;
  readonly format: string;
  readonly notes: readonly string[];
}

export interface HarnessMatrixRow {
  readonly adapterId: string;
  readonly displayName: string;
  readonly paths: HarnessPathEvidence;
  readonly kinds: readonly KindRow[];
  readonly runtimeRequirements: readonly string[];
  readonly platformConstraints: readonly Platform[];
}

// Verified layouts (2026-10-11, Apple Silicon macOS 27.0.1):
// - Codex: ~/.codex exists on this machine with real skills/ content.
// - Cursor: ~/.cursor exists on this machine; project rules under .cursor/rules.
// - OpenCode: opencode CLI resolvable on PATH (via user bin).
// - Claude Code: NOT installed on this machine; layout per official docs,
//   verified against the documented ~/.claude/skills layout in controlled
//   fixtures (M3) — machine evidence pending installation.
export const HARNESS_MATRIX: readonly HarnessMatrixRow[] = Object.freeze([
  {
    adapterId: "claude-code",
    displayName: "Claude Code",
    paths: {
      globalRoot: ".claude",
      projectRoot: ".claude",
      evidenceKind: "controlled-fixture",
      evidenceDate: "2026-10-11",
      installedProbe: "not-installed"
    },
    kinds: [
      { kind: "instructions", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (CLAUDE.md; AGENTS.md via generated)", notes: ["AGENTS.md → CLAUDE.md is a generated projection"] },
      { kind: "skills", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "directory (skills/<name>/SKILL.md + assets)", notes: [] },
      { kind: "mcp", global: "read-write", project: "read-write", verify: true, roundTripGrade: "equivalent", format: "json (.claude.json mcpServers / .mcp.json)", notes: ["merge per server; formatting not preserved"] },
      { kind: "hooks", global: "read-write", project: "read-write", verify: true, roundTripGrade: "equivalent", format: "json (settings.json hooks)", notes: ["event semantics map 1:1 for declared events"] },
      { kind: "commands", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (commands/*.md)", notes: [] },
      { kind: "prompts", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: ["no dedicated prompts directory; use commands"] },
      { kind: "agents", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (agents/*.md)", notes: [] },
      { kind: "settings", global: "read-write", project: "read-write", verify: true, roundTripGrade: "equivalent", format: "json (settings.json allowlist)", notes: ["only allowlisted keys managed"] },
      { kind: "native", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "raw mirror under native/<adapter>/", notes: [] }
    ],
    runtimeRequirements: [],
    platformConstraints: ["darwin"]
  },
  {
    adapterId: "codex",
    displayName: "Codex",
    paths: {
      globalRoot: ".codex",
      projectRoot: ".codex",
      evidenceKind: "machine-evidence",
      evidenceDate: "2026-10-11",
      installedProbe: "directory-exists"
    },
    kinds: [
      { kind: "instructions", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (AGENTS.md)", notes: [] },
      { kind: "skills", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "directory (skills/<name>/SKILL.md + assets)", notes: [] },
      { kind: "mcp", global: "read-write", project: "read-write", verify: true, roundTripGrade: "equivalent", format: "toml (~/.codex/config.toml mcp_servers)", notes: ["TOML round-trip: formatting not preserved → equivalent"] },
      { kind: "hooks", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: ["no hook system documented at this version"] },
      { kind: "commands", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (prompts/*.md)", notes: [] },
      { kind: "prompts", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (prompts/*.md)", notes: ["same directory as commands in this version"] },
      { kind: "agents", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: ["no sub-agent definitions at this version"] },
      { kind: "settings", global: "read-only", project: "read-only", verify: true, roundTripGrade: "equivalent", format: "toml (config.toml allowlist)", notes: ["allowlisted keys only; file also holds engine config"] },
      { kind: "native", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "raw mirror under native/<adapter>/", notes: [] }
    ],
    runtimeRequirements: [],
    platformConstraints: ["darwin"]
  },
  {
    adapterId: "cursor",
    displayName: "Cursor",
    paths: {
      globalRoot: ".cursor",
      projectRoot: ".cursor",
      evidenceKind: "machine-evidence",
      evidenceDate: "2026-10-11",
      installedProbe: "directory-exists"
    },
    kinds: [
      { kind: "instructions", global: "unsupported", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (.cursor/rules/*.mdc)", notes: ["project rules only; global rules live in editor DB, not files"] },
      { kind: "skills", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: ["no skills directory at this version"] },
      { kind: "mcp", global: "read-write", project: "read-write", verify: true, roundTripGrade: "equivalent", format: "json (.cursor/mcp.json)", notes: ["merge per server"] },
      { kind: "hooks", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: [] },
      { kind: "commands", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: [] },
      { kind: "prompts", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: [] },
      { kind: "agents", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: [] },
      { kind: "settings", global: "read-only", project: "unsupported", verify: true, roundTripGrade: "equivalent", format: "json (allowlist)", notes: ["editor settings mostly in DB; only file-backed keys"] },
      { kind: "native", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "raw mirror under native/<adapter>/", notes: [] }
    ],
    runtimeRequirements: [],
    platformConstraints: ["darwin"]
  },
  {
    adapterId: "opencode",
    displayName: "OpenCode",
    paths: {
      globalRoot: ".config/opencode",
      projectRoot: ".opencode",
      evidenceKind: "controlled-fixture",
      evidenceDate: "2026-10-11",
      installedProbe: "command-exists"
    },
    kinds: [
      { kind: "instructions", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (AGENTS.md)", notes: [] },
      { kind: "skills", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: ["no skills directory at this version"] },
      { kind: "mcp", global: "read-write", project: "read-write", verify: true, roundTripGrade: "equivalent", format: "json (opencode.json mcp)", notes: ["merge per server"] },
      { kind: "hooks", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: [] },
      { kind: "commands", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (command/*.md)", notes: [] },
      { kind: "prompts", global: "unsupported", project: "unsupported", verify: false, roundTripGrade: "unsupported", format: "—", notes: [] },
      { kind: "agents", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "markdown (agent/*.md)", notes: [] },
      { kind: "settings", global: "read-only", project: "read-only", verify: true, roundTripGrade: "equivalent", format: "json (opencode.json allowlist)", notes: ["allowlisted keys only"] },
      { kind: "native", global: "read-write", project: "read-write", verify: true, roundTripGrade: "lossless", format: "raw mirror under native/<adapter>/", notes: [] }
    ],
    runtimeRequirements: [],
    platformConstraints: ["darwin"]
  }
]);

/** Adapter implementers may ONLY declare kinds present in the matrix with the same level/grade. */
export function matrixKindsFor(adapterId: string): readonly KindRow[] {
  return HARNESS_MATRIX.find((row) => row.adapterId === adapterId)?.kinds ?? [];
}

export function matrixRowFor(adapterId: string): HarnessMatrixRow | null {
  return HARNESS_MATRIX.find((row) => row.adapterId === adapterId) ?? null;
}
