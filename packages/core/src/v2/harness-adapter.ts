// Frozen M0 contract (INH-1755): Harness Adapter v2 port, capability
// matrix, structured diagnostics, and the conformance harness used by M3/M6.
//
// Hard boundaries (compile-time where possible):
// - Adapters never commit Git, manage history, bypass transaction/backup, or
//   decide delete/conflict policy: those concerns simply do not appear on
//   this interface.
// - Absolute paths may appear in main-side port types (scan inputs, render
//   roots) but must never cross into Renderer contracts (IPC DTOs).
// - Unsupported or degraded outcomes are structured values; silent ignore
//   is a conformance failure.

import { z } from "zod";

import {
  adapterIdSchema,
  assetKindSchema,
  type AdapterId,
  type AssetKind,
  type ScopeRef,
  type HarnessInstanceId
} from "./identity";
import { conversionGradeSchema, type ConversionGrade } from "./reconcile";

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

export const PLATFORMS = ["darwin", "win32", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const platformSchema = z.enum(PLATFORMS);

export interface HarnessAdapterDescriptor {
  readonly adapterId: AdapterId;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly platforms: readonly Platform[];
  readonly configKinds: readonly AssetKind[];
}

export const harnessAdapterDescriptorSchema: z.ZodType<HarnessAdapterDescriptor> = z.strictObject({
  adapterId: adapterIdSchema,
  displayName: z.string().trim().min(1).max(200),
  adapterVersion: z.string().trim().min(1),
  platforms: z.array(platformSchema).min(1),
  configKinds: z.array(assetKindSchema).min(1)
});

// ---------------------------------------------------------------------------
// Capability matrix
// ---------------------------------------------------------------------------

export const CAPABILITY_LEVELS = ["read-write", "read-only", "unsupported"] as const;
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];
export const capabilityLevelSchema = z.enum(CAPABILITY_LEVELS);

export interface KindCapability {
  readonly kind: AssetKind;
  readonly global: CapabilityLevel;
  readonly project: CapabilityLevel;
  readonly verify: boolean;
  /** Round-trip grade of import→render within this harness. */
  readonly roundTripGrade: ConversionGrade;
  /** Runtime requirements, e.g. "claude-cli", "node>=22". */
  readonly runtimeRequirements: readonly string[];
  readonly platformConstraints: readonly Platform[];
}

export const kindCapabilitySchema: z.ZodType<KindCapability> = z.strictObject({
  kind: assetKindSchema,
  global: capabilityLevelSchema,
  project: capabilityLevelSchema,
  verify: z.boolean(),
  roundTripGrade: conversionGradeSchema,
  runtimeRequirements: z.array(z.string().min(1)),
  platformConstraints: z.array(platformSchema)
});

export interface CapabilityMatrix {
  readonly adapterId: AdapterId;
  readonly kinds: readonly KindCapability[];
}

export const capabilityMatrixSchema: z.ZodType<CapabilityMatrix> = z.strictObject({
  adapterId: adapterIdSchema,
  kinds: z.array(kindCapabilitySchema)
});

// ---------------------------------------------------------------------------
// Structured diagnostics (no silent ignore)
// ---------------------------------------------------------------------------

export const DIAGNOSTIC_SEVERITIES = ["loss", "warning", "error"] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export interface ConversionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  /** Logical path or structured key the diagnostic refers to. */
  readonly subject: string | null;
}

export const conversionDiagnosticSchema: z.ZodType<ConversionDiagnostic> = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  subject: z.string().min(1).nullable()
});

export interface ConversionOutcome<T> {
  readonly grade: ConversionGrade;
  readonly diagnostics: readonly ConversionDiagnostic[];
  readonly output: T | null;
}

/** degraded requires at least one "loss" diagnostic; unsupported requires output = null. */
export function validateConversionOutcome<T>(outcome: ConversionOutcome<T>): readonly string[] {
  const problems: string[] = [];
  if (outcome.grade === "unsupported") {
    if (outcome.output !== null) {
      problems.push("unsupported conversions must not produce output");
    }
    if (outcome.diagnostics.length === 0) {
      problems.push("unsupported conversions must explain why via diagnostics");
    }
  }
  if (
    outcome.grade === "degraded" &&
    !outcome.diagnostics.some((diagnostic) => diagnostic.severity === "loss")
  ) {
    problems.push("degraded conversions must list at least one 'loss' diagnostic");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scan / import / render / verify port types (main-side; may hold paths)
// ---------------------------------------------------------------------------

export interface HarnessInstanceSnapshot {
  readonly harnessInstanceId: HarnessInstanceId;
  readonly adapterId: AdapterId;
  readonly scope: ScopeRef;
  /** Per config kind: digest of the actual local state, null when absent. */
  readonly actualDigests: Readonly<Record<string, string | null>>;
}

export interface ImportedAsset {
  readonly assetKey: string;
  readonly kind: AssetKind;
  readonly logicalName: string;
  readonly content: Uint8Array;
  readonly grade: ConversionGrade;
  readonly diagnostics: readonly ConversionDiagnostic[];
}

export interface RenderedTarget {
  readonly targetLogicalPath: string;
  readonly content: Uint8Array;
  readonly outputDigest: string;
  readonly grade: ConversionGrade;
  readonly diagnostics: readonly ConversionDiagnostic[];
}

export interface VerifyReport {
  readonly targetLogicalPath: string;
  readonly verified: boolean;
  readonly actualDigest: string | null;
  readonly expectedDigest: string;
  readonly problems: readonly ConversionDiagnostic[];
}

export type DetectResult = ConversionOutcome<readonly HarnessInstanceSnapshot[]>;
export type ScanResult = ConversionOutcome<HarnessInstanceSnapshot>;
export type ImportResult = ConversionOutcome<readonly ImportedAsset[]>;
export type RenderResult = ConversionOutcome<readonly RenderedTarget[]>;
export type VerifyResult = ConversionOutcome<readonly VerifyReport[]>;

export interface HarnessAdapter {
  readonly descriptor: HarnessAdapterDescriptor;
  detectInstances(scope: ScopeRef): Promise<DetectResult>;
  scan(instanceId: HarnessInstanceId): Promise<ScanResult>;
  describeCapabilities(): CapabilityMatrix;
  import(scan: HarnessInstanceSnapshot): Promise<ImportResult>;
  render(
    instanceId: HarnessInstanceId,
    assets: readonly { assetKey: string; kind: AssetKind; logicalName: string; content: Uint8Array }[]
  ): Promise<RenderResult>;
  verify(
    instanceId: HarnessInstanceId,
    expectations: readonly { targetLogicalPath: string; expectedDigest: string }[]
  ): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Registration vs capability (2026-10-07 prototype alignment)
// ---------------------------------------------------------------------------

/**
 * A user registration is presentation metadata plus a local binding. It
 * never grants write access: automatic Capture/Apply requires a matching
 * built-in adapter whose detector actually recognizes the instance. Custom
 * or unknown tools are explicitly rejected for automatic writes — name
 * similarity is never evidence of support.
 */
export const REGISTRATION_GRANTS_WRITE = false as const;

export interface HarnessRegistration {
  readonly harnessInstanceId: HarnessInstanceId;
  readonly adapterId: AdapterId;
  readonly displayName: string;
  readonly presetMatched: boolean;
  /** Custom display metadata chosen by the user; cosmetic only. */
  readonly customIcon: string | null;
  readonly customFormatHints: readonly string[];
  readonly installed: boolean;
}

export const harnessRegistrationSchema: z.ZodType<HarnessRegistration> = z.strictObject({
  harnessInstanceId: z.string().regex(/^harn_[0-9a-f]{64}$/),
  adapterId: adapterIdSchema,
  displayName: z.string().trim().min(1).max(200),
  presetMatched: z.boolean(),
  customIcon: z.string().min(1).nullable(),
  customFormatHints: z.array(z.string().min(1)),
  installed: z.boolean()
});

export type AutoWriteDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function canAutoCaptureOrApply(
  registration: Pick<HarnessRegistration, "adapterId" | "presetMatched" | "installed">,
  detectedByAdapter: boolean
): AutoWriteDecision {
  if (registration.adapterId.startsWith("custom:")) {
    return { allowed: false, reason: "custom registrations never receive automatic write access" };
  }
  if (!registration.installed) {
    return { allowed: false, reason: "harness is not installed on this machine" };
  }
  if (!registration.presetMatched) {
    return { allowed: false, reason: "registration did not match a known adapter preset" };
  }
  if (!detectedByAdapter) {
    return { allowed: false, reason: "adapter detector did not recognize this instance" };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Mock adapter + conformance harness (M3/M6 parallel development basis)
// ---------------------------------------------------------------------------

export interface MockHarnessAdapterConfig {
  readonly descriptor: HarnessAdapterDescriptor;
  readonly capabilities: CapabilityMatrix;
  readonly detectedInstances: readonly HarnessInstanceSnapshot[];
  /** When true, import/render return unsupported for kinds not in the matrix. */
  readonly strictUnknownKinds?: boolean;
}

export function createMockHarnessAdapter(config: MockHarnessAdapterConfig): HarnessAdapter {
  const supportedKinds = new Set(config.capabilities.kinds.map((entry) => entry.kind));
  return {
    descriptor: config.descriptor,
    async detectInstances() {
      return { grade: "lossless", diagnostics: [], output: config.detectedInstances };
    },
    async scan(instanceId) {
      const snapshot = config.detectedInstances.find(
        (instance) => instance.harnessInstanceId === instanceId
      );
      if (!snapshot) {
        return {
          grade: "unsupported",
          diagnostics: [
            { code: "instance-not-found", message: `unknown instance ${instanceId}`, severity: "error", subject: null }
          ],
          output: null
        };
      }
      return { grade: "lossless", diagnostics: [], output: snapshot };
    },
    describeCapabilities() {
      return config.capabilities;
    },
    async import(scan) {
      if (config.strictUnknownKinds !== false) {
        const unknown = Object.keys(scan.actualDigests).filter((kind) => !supportedKinds.has(kind as AssetKind));
        if (unknown.length > 0) {
          return {
            grade: "unsupported",
            diagnostics: unknown.map((kind) => ({
              code: "kind-unsupported",
              message: `adapter does not support kind ${kind}`,
              severity: "error" as const,
              subject: kind
            })),
            output: null
          };
        }
      }
      return { grade: "lossless", diagnostics: [], output: [] };
    },
    async render(_instanceId, assets) {
      const unsupported = assets.filter((asset) => !supportedKinds.has(asset.kind));
      if (unsupported.length > 0) {
        return {
          grade: "unsupported",
          diagnostics: unsupported.map((asset) => ({
            code: "kind-unsupported",
            message: `cannot render ${asset.kind} asset ${asset.assetKey}`,
            severity: "error" as const,
            subject: asset.assetKey
          })),
          output: null
        };
      }
      return { grade: "lossless", diagnostics: [], output: [] };
    },
    async verify(_instanceId, expectations) {
      return {
        grade: "lossless",
        diagnostics: [],
        output: expectations.map((expectation) => ({
          targetLogicalPath: expectation.targetLogicalPath,
          verified: true,
          actualDigest: expectation.expectedDigest,
          expectedDigest: expectation.expectedDigest,
          problems: []
        }))
      };
    }
  };
}

export interface ConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string | null;
}

export interface ConformanceReport {
  readonly adapterId: AdapterId;
  readonly checks: readonly ConformanceCheck[];
  readonly passed: boolean;
}

/**
 * Contract-level conformance harness. M6 extends this with real per-harness
 * fixtures; the checks here verify the contract invariants any adapter
 * implementation must uphold (structured diagnostics, no silent ignore,
 * descriptor completeness).
 */
export async function runAdapterConformance(
  adapter: HarnessAdapter,
  options: { readonly probeScope: ScopeRef; readonly probeAssetKind: AssetKind }
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];

  const descriptorProblems: string[] = [];
  if (adapter.descriptor.adapterId !== adapter.describeCapabilities().adapterId) {
    descriptorProblems.push("descriptor and capability matrix adapter IDs differ");
  }
  checks.push({
    name: "descriptor-consistency",
    passed: descriptorProblems.length === 0,
    detail: descriptorProblems.length === 0 ? null : descriptorProblems.join("; ")
  });

  const capabilities = adapter.describeCapabilities();
  const supportedKind = capabilities.kinds.find((kind) => kind.kind === options.probeAssetKind);
  const unsupportedKind: AssetKind | undefined =
    capabilities.kinds.length > 0 && supportedKind ? undefined : options.probeAssetKind;

  if (unsupportedKind) {
    const render = await adapter.render("harn_0000000000000000000000000000000000000000000000000000000000000000", [
      {
        assetKey: `probe|${unsupportedKind}|probe.md`,
        kind: unsupportedKind,
        logicalName: "probe.md",
        content: new Uint8Array([112, 114, 111, 98, 101]) // "probe"
      }
    ]);
    const problems = validateConversionOutcome(render);
    checks.push({
      name: "unsupported-is-structured",
      passed: problems.length === 0 && render.grade === "unsupported",
      detail:
        problems.length === 0
          ? null
          : `unsupported render violated the contract: ${problems.join("; ")}`
    });
  }

  const detect = await adapter.detectInstances(options.probeScope);
  const detectProblems = validateConversionOutcome(detect);
  checks.push({
    name: "detect-outcome-valid",
    passed: detectProblems.length === 0,
    detail: detectProblems.length === 0 ? null : detectProblems.join("; ")
  });

  return {
    adapterId: adapter.descriptor.adapterId,
    checks,
    passed: checks.every((check) => check.passed)
  };
}
