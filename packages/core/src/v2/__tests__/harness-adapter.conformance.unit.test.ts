import { describe, expect, it } from "vitest";

import {
  canAutoCaptureOrApply,
  createMockHarnessAdapter,
  runAdapterConformance,
  validateConversionOutcome,
  type CapabilityMatrix,
  type HarnessAdapterDescriptor,
  type HarnessInstanceSnapshot,
  REGISTRATION_GRANTS_WRITE
} from "../harness-adapter";

const descriptor: HarnessAdapterDescriptor = {
  adapterId: "codex",
  displayName: "Codex",
  adapterVersion: "0.1.0-mock",
  platforms: ["darwin"],
  configKinds: ["instructions", "skills"]
};

const capabilities: CapabilityMatrix = {
  adapterId: "codex",
  kinds: [
    {
      kind: "skills",
      global: "read-write",
      project: "read-write",
      verify: true,
      roundTripGrade: "lossless",
      runtimeRequirements: [],
      platformConstraints: ["darwin"]
    }
  ]
};

const instance: HarnessInstanceSnapshot = {
  harnessInstanceId: "harn_e31b7482d38f264dbe0fd9aa9459af42ae6a6b95c2ef8c9260e8c068ea211782",
  adapterId: "codex",
  scope: { kind: "project", projectId: "prj_demo" },
  actualDigests: { skills: "abc" }
};

describe("conversion outcome validation (no silent ignore)", () => {
  it("rejects unsupported outcomes that produce output or stay silent", () => {
    expect(
      validateConversionOutcome({ grade: "unsupported", diagnostics: [], output: {} })
    ).toContainEqual(expect.stringContaining("must not produce output"));
    expect(
      validateConversionOutcome({ grade: "unsupported", diagnostics: [], output: null })
    ).toContainEqual(expect.stringContaining("diagnostics"));
    expect(
      validateConversionOutcome({
        grade: "unsupported",
        diagnostics: [{ code: "no", message: "no support", severity: "error", subject: null }],
        output: null
      })
    ).toEqual([]);
  });

  it("requires degraded outcomes to enumerate their losses", () => {
    expect(
      validateConversionOutcome({
        grade: "degraded",
        diagnostics: [{ code: "note", message: "note", severity: "warning", subject: null }],
        output: {}
      })
    ).toContainEqual(expect.stringContaining("'loss'"));
  });
});

describe("mock adapter conformance (INH-1755)", () => {
  const adapter = createMockHarnessAdapter({
    descriptor,
    capabilities,
    detectedInstances: [instance]
  });

  it("passes the contract conformance harness", async () => {
    const report = await runAdapterConformance(adapter, {
      probeScope: { kind: "global" },
      probeAssetKind: "mcp" // not in the capability matrix → unsupported path
    });
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.name)).toContain("unsupported-is-structured");
  });

  it("returns structured unsupported diagnostics for kinds outside its matrix", async () => {
    const render = await adapter.render(instance.harnessInstanceId, [
      { assetKey: "global|mcp|primary", kind: "mcp", logicalName: "primary", content: new Uint8Array() }
    ]);
    expect(render.grade).toBe("unsupported");
    expect(render.output).toBeNull();
    expect(render.diagnostics.length).toBeGreaterThan(0);
    expect(validateConversionOutcome(render)).toEqual([]);
  });

  it("scans an unknown instance with an error diagnostic instead of silence", async () => {
    const scan = await adapter.scan("harn_0000000000000000000000000000000000000000000000000000000000000000");
    expect(scan.grade).toBe("unsupported");
    expect(scan.diagnostics[0]?.code).toBe("instance-not-found");
  });
});

describe("registration vs capability boundary (2026-10-07 supplement)", () => {
  it("never grants write access by registration alone", () => {
    expect(REGISTRATION_GRANTS_WRITE).toBe(false);
  });

  it("rejects automatic writes for custom, uninstalled, unmatched, or undetected harnesses", () => {
    expect(
      canAutoCaptureOrApply({ adapterId: "custom:0123456789abcdef", presetMatched: true, installed: true }, true)
        .allowed
    ).toBe(false);
    expect(
      canAutoCaptureOrApply({ adapterId: "codex", presetMatched: true, installed: false }, true).allowed
    ).toBe(false);
    expect(
      canAutoCaptureOrApply({ adapterId: "codex", presetMatched: false, installed: true }, true).allowed
    ).toBe(false);
    expect(
      canAutoCaptureOrApply({ adapterId: "codex", presetMatched: true, installed: true }, false).allowed
    ).toBe(false);
    expect(
      canAutoCaptureOrApply({ adapterId: "codex", presetMatched: true, installed: true }, true)
    ).toEqual({ allowed: true });
  });
});
