import { describe, expect, it } from "vitest";

import {
  createRegistration,
  HARNESS_PRESETS,
  registrationStatus,
  suggestPreset,
  validateRegistrationDraft,
  type RegistrationDraft
} from "../harness-registry";
import { canAutoCaptureOrApply } from "../harness-adapter";

function draft(overrides: Partial<RegistrationDraft> = {}): RegistrationDraft {
  return {
    displayName: "My Local Tool",
    iconKey: null,
    formatHints: ["markdown"],
    scope: { kind: "global" },
    bindingKey: "default",
    presetAdapterId: null,
    ...overrides
  };
}

describe("harness registration service (INH-1847)", () => {
  it("suggests presets by stable adapter id with fuzzy name matching", () => {
    expect(suggestPreset("Claude Code").preset?.adapterId).toBe("claude-code");
    expect(suggestPreset("  claude ").preset?.adapterId).toBe("claude-code");
    expect(suggestPreset("codex cli").preset?.adapterId).toBe("codex");
    expect(suggestPreset("totally unknown").preset).toBeNull();
    expect(HARNESS_PRESETS.map((preset) => preset.adapterId)).toEqual(["claude-code", "codex", "cursor", "opencode"]);
  });

  it("validates drafts with structured errors and fails closed", () => {
    expect(validateRegistrationDraft(draft()).ok).toBe(true);
    expect(validateRegistrationDraft(draft({ displayName: "  " })).ok).toBe(false);
    expect(validateRegistrationDraft(draft({ iconKey: "https://evil.example/x.svg" })).ok).toBe(false);
    expect(validateRegistrationDraft(draft({ iconKey: "<script>" })).ok).toBe(false);
    expect(validateRegistrationDraft(draft({ bindingKey: "a|b" })).ok).toBe(false);
    expect(validateRegistrationDraft(draft({ presetAdapterId: "nope" as never })).ok).toBe(false);
    expect(validateRegistrationDraft(draft({ formatHints: [""] })).ok).toBe(false);
  });

  it("creates registrations, persists identity shape, and rejects duplicates", () => {
    const input = {
      ...draft({ presetAdapterId: "codex", displayName: "Codex (work)" }),
      adapterIdentity: { adapterId: "codex" as const },
      installed: true,
      randomHex16: () => "0123456789abcdef",
      harnessInstanceId: "harn_" + "1".repeat(64)
    };
    const created = createRegistration(input, []);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.registration.presetMatched).toBe(true);
      expect(created.registration.adapterId).toBe("codex");
    }

    const duplicate = createRegistration(input, [{ harnessInstanceId: input.harnessInstanceId }]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.errors[0]?.code).toBe("DUPLICATE_IDENTITY");
    }

    const mismatch = createRegistration(
      { ...input, presetAdapterId: "cursor", harnessInstanceId: "harn_" + "2".repeat(64) },
      []
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.errors[0]?.code).toBe("PRESET_MISMATCH");
    }
  });

  it("separates registration from installation/support/readiness", () => {
    const registration = {
      harnessInstanceId: "harn_x",
      adapterId: "codex",
      displayName: "Codex",
      presetMatched: true,
      customIcon: null,
      customFormatHints: [],
      installed: false
    };
    expect(registrationStatus(registration, { installed: true, mappingConfigured: true, adapterSupported: true, writable: true })).toBe("not-installed");
    expect(
      registrationStatus(
        { ...registration, installed: true },
        { installed: true, mappingConfigured: true, adapterSupported: true, writable: true }
      )
    ).toBe("ready");
    expect(
      registrationStatus(
        { ...registration, installed: true },
        { installed: true, mappingConfigured: false, adapterSupported: true, writable: true }
      )
    ).toBe("mapping-pending");
    expect(
      registrationStatus(
        { ...registration, installed: true },
        { installed: true, mappingConfigured: true, adapterSupported: false, writable: true }
      )
    ).toBe("unsupported");
    expect(
      registrationStatus(
        { ...registration, installed: true },
        { installed: true, mappingConfigured: true, adapterSupported: true, writable: false }
      )
    ).toBe("read-only");
  });

  it("keeps registrations from ever granting automatic writes", () => {
    const custom = {
      adapterId: "custom:0123456789abcdef" as const,
      presetMatched: true,
      installed: true
    };
    expect(canAutoCaptureOrApply(custom, true).allowed).toBe(false);
    const unmapped = { adapterId: "codex" as const, presetMatched: false, installed: true };
    expect(canAutoCaptureOrApply(unmapped, true).allowed).toBe(false);
  });
});
