// Dependency Readiness (INH-1799) + Conversion Grade Engine (INH-1800).
//
// Readiness distinguishes "config restored" from "harness usable" without
// turning RuleSwitch into a package manager: it only DETECTS and reports;
// there is no install path on these types.
//
// Grade Engine gives every cross-harness conversion a machine-readable
// verdict: overall grade + per-field loss list + converter versions +
// required-confirmation flag. unsupported produces no target; degraded
// requires confirmation; a "success" return without a grade is a
// conformance failure.

import { conversionGradeSchema, type ConversionGrade } from "./reconcile";

// ---------------------------------------------------------------------------
// INH-1799: readiness
// ---------------------------------------------------------------------------

export const READINESS_STATES = ["READY", "CONFIG_READY_DEPENDENCY_MISSING", "BLOCKED"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export interface ReadinessCheck {
  readonly checkId: string;
  readonly passed: boolean;
  readonly optional: boolean;
  readonly detail: string;
  /** What the user can do next — never an auto-install. */
  readonly nextStep: string | null;
}

export interface ReadinessReport {
  readonly state: ReadinessState;
  readonly checks: readonly ReadinessCheck[];
}

export interface ReadinessProbeInput {
  readonly harnessInstalled: boolean;
  readonly installedVersion: string | null;
  readonly commands: readonly { readonly command: string; readonly found: boolean; readonly optional: boolean }[];
  readonly targetDirectoryWritable: boolean | null;
  readonly requiredSecretsResolved: boolean;
  readonly adapterSupported: boolean;
}

export type ReadinessProbe = {
  commandFound(command: string): Promise<boolean>;
  pathWritable(path: string): Promise<boolean>;
} | null;

/**
 * Pure readiness classifier over probe facts. All facts come from the
 * caller's real probes (which/version/writable checks); this function only
 * aggregates and never installs anything.
 */
export function classifyReadiness(input: ReadinessProbeInput): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  checks.push({
    checkId: "harness-installed",
    passed: input.harnessInstalled,
    optional: false,
    detail: input.harnessInstalled ? `installed${input.installedVersion ? ` (${input.installedVersion})` : " (version unknown)"}` : "harness not installed on this machine",
    nextStep: input.harnessInstalled ? null : "install the harness, then re-run detection"
  });
  for (const command of input.commands) {
    checks.push({
      checkId: `command:${command.command}`,
      passed: command.found,
      optional: command.optional,
      detail: command.found ? `${command.command} available` : `${command.command} not found on PATH`,
      nextStep: command.found || command.optional ? null : `install '${command.command}' or adjust PATH (RuleSwitch does not install packages)`
    });
  }
  checks.push({
    checkId: "target-writable",
    passed: input.targetDirectoryWritable !== false,
    optional: false,
    detail: input.targetDirectoryWritable === false ? "harness target directory is not writable" : "target directory writable",
    nextStep: input.targetDirectoryWritable === false ? "check directory permissions for the harness config root" : null
  });
  checks.push({
    checkId: "secrets-resolved",
    passed: input.requiredSecretsResolved,
    optional: false,
    detail: input.requiredSecretsResolved ? "all required secret references resolved" : "one or more required secret references unresolved",
    nextStep: input.requiredSecretsResolved ? null : "provide the referenced secret (env or keychain) — configuration alone is not readiness"
  });
  checks.push({
    checkId: "adapter-capability",
    passed: input.adapterSupported,
    optional: false,
    detail: input.adapterSupported ? "adapter declares this capability" : "adapter does not support this operation",
    nextStep: input.adapterSupported ? null : "register a mapping or use a supported harness"
  });

  const required = checks.filter((check) => !check.optional);
  const allPass = required.every((check) => check.passed);
  const configSideOk = input.harnessInstalled && input.adapterSupported;
  if (allPass) {
    return { state: "READY", checks };
  }
  // BLOCKED: harness itself unusable (not installed / unsupported) or hard
  // blockers (unwritable, adapter missing). Dependency missing on an
  // otherwise-installed harness is CONFIG_READY_DEPENDENCY_MISSING.
  const hardBlock = !input.harnessInstalled || !input.adapterSupported || input.targetDirectoryWritable === false;
  if (hardBlock) {
    return { state: "BLOCKED", checks };
  }
  if (configSideOk) {
    return { state: "CONFIG_READY_DEPENDENCY_MISSING", checks };
  }
  return { state: "BLOCKED", checks };
}

// ---------------------------------------------------------------------------
// INH-1800: conversion grade engine
// ---------------------------------------------------------------------------

export interface FieldLoss {
  readonly subject: string; // field path / event / server name
  readonly loss: string;
  readonly severity: "loss" | "warning";
}

export interface ConversionReport {
  readonly overallGrade: ConversionGrade;
  readonly losses: readonly FieldLoss[];
  readonly converterId: string;
  readonly converterVersion: string;
  readonly sourceCapability: string;
  readonly targetCapability: string;
  readonly requiresConfirmation: boolean;
  /** unsupported conversions never carry a target payload. */
  readonly targetProduced: boolean;
}

export interface ConversionGradeInput {
  readonly converterId: string;
  readonly converterVersion: string;
  readonly sourceCapability: string;
  readonly targetCapability: string;
  readonly losses: readonly FieldLoss[];
  /** Explicit unsupported verdict from the converter (no target generated). */
  readonly unsupported?: boolean;
  /** Semantic equivalence was proven by a conformance fixture, not assumed. */
  readonly equivalenceProvenByFixture?: boolean;
}

/**
 * Computes the machine-readable grade. Rules (frozen):
 * - unsupported → no target produced.
 * - any "loss" severity → degraded + requiresConfirmation.
 * - warnings only → equivalent IF equivalence was proven by fixture,
 *   otherwise degraded (unproven equivalence is not lossless).
 * - no losses + fixture-proven → lossless; without fixture proof the grade
 *   caps at equivalent (a converter claiming lossless without conformance
 *   evidence is a conformance failure — see assertGradeEvidence).
 */
export function computeConversionGrade(input: ConversionGradeInput): ConversionReport {
  const losses = [...input.losses].sort((left, right) => (left.subject < right.subject ? -1 : 1));
  if (input.unsupported) {
    return {
      overallGrade: "unsupported",
      losses,
      converterId: input.converterId,
      converterVersion: input.converterVersion,
      sourceCapability: input.sourceCapability,
      targetCapability: input.targetCapability,
      requiresConfirmation: false,
      targetProduced: false
    };
  }
  const hasLoss = losses.some((loss) => loss.severity === "loss");
  if (hasLoss) {
    return {
      overallGrade: "degraded",
      losses,
      converterId: input.converterId,
      converterVersion: input.converterVersion,
      sourceCapability: input.sourceCapability,
      targetCapability: input.targetCapability,
      requiresConfirmation: true,
      targetProduced: true
    };
  }
  if (losses.length > 0) {
    return {
      overallGrade: input.equivalenceProvenByFixture ? "equivalent" : "degraded",
      losses,
      converterId: input.converterId,
      converterVersion: input.converterVersion,
      sourceCapability: input.sourceCapability,
      targetCapability: input.targetCapability,
      requiresConfirmation: !input.equivalenceProvenByFixture,
      targetProduced: true
    };
  }
  const grade: ConversionGrade = input.equivalenceProvenByFixture ? "lossless" : "equivalent";
  return {
    overallGrade: grade,
    losses,
    converterId: input.converterId,
    converterVersion: input.converterVersion,
    sourceCapability: input.sourceCapability,
    targetCapability: input.targetCapability,
    requiresConfirmation: false,
    targetProduced: true
  };
}

/**
 * Conformance guard: a report claiming lossless MUST have fixture-proven
 * equivalence. Adapters that omit known-unsupported fields (losses list
 * empty despite unsupported truth) fail conformance — the caller passes
 * the converter's declared unsupported fields to cross-check.
 */
export function assertGradeEvidence(
  report: ConversionReport,
  declaredUnsupportedFields: readonly string[]
): readonly string[] {
  const problems: string[] = [];
  if (report.overallGrade === "lossless" && declaredUnsupportedFields.length > 0) {
    problems.push("lossless grade contradicts declared unsupported fields");
  }
  if (report.overallGrade === "unsupported" && report.targetProduced) {
    problems.push("unsupported grade must not produce a target");
  }
  if (report.overallGrade === "degraded" && !report.requiresConfirmation) {
    problems.push("degraded grade must require confirmation");
  }
  return problems;
}

export { conversionGradeSchema };
