// Local harness registration service (INH-1847, core validation half).
//
// Registration is presentation + local binding metadata only: it never
// grants write capability (REGISTRATION_GRANTS_WRITE stays false) and the
// service never branches on display names — preset suggestions are
// advisory, real capability comes from Adapter v2 contracts.
//
// Icons are restricted to the local preset icon keys (safe text/local
// controlled resources); remote SVG/HTML is structurally rejected.

import type { AdapterId } from "./identity";
import { canAutoCaptureOrApply, type HarnessRegistration } from "./harness-adapter";

export interface HarnessPreset {
  readonly adapterId: AdapterId;
  readonly displayName: string;
  /** Local, controlled icon key — never a remote URL or markup. */
  readonly iconKey: string;
  readonly aliases: readonly string[];
}

export const HARNESS_PRESETS: readonly HarnessPreset[] = Object.freeze([
  {
    adapterId: "claude-code",
    displayName: "Claude Code",
    iconKey: "claude-code",
    aliases: ["claude", "claudecode", "anthropic claude"]
  },
  {
    adapterId: "codex",
    displayName: "Codex",
    iconKey: "codex",
    aliases: ["openai codex", "codex cli"]
  },
  {
    adapterId: "cursor",
    displayName: "Cursor",
    iconKey: "cursor",
    aliases: ["cursor editor"]
  },
  {
    adapterId: "opencode",
    displayName: "OpenCode",
    iconKey: "opencode",
    aliases: ["open-code"]
  }
]);

const ICON_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DISPLAY_NAME_PATTERN = /^[^\n\r\t]{1,100}$/;

export type RegistrationSuggestion = { readonly preset: HarnessPreset } | { readonly preset: null };

/** Advisory name matching (case/whitespace-insensitive); never auto-writes. */
export function suggestPreset(name: string): RegistrationSuggestion {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return { preset: null };
  }
  const preset = HARNESS_PRESETS.find(
    (candidate) =>
      candidate.displayName.toLowerCase() === normalized ||
      candidate.aliases.some((alias) => alias.toLowerCase() === normalized) ||
      candidate.adapterId === normalized
  );
  return { preset: preset ?? null };
}

export interface RegistrationDraft {
  readonly displayName: string;
  readonly iconKey: string | null;
  readonly formatHints: readonly string[];
  readonly scope: { readonly kind: "global" } | { readonly kind: "project"; readonly projectId: string };
  readonly bindingKey: string;
  readonly presetAdapterId: AdapterId | null;
}

export type RegistrationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly { readonly code: string; readonly message: string }[] };

export function validateRegistrationDraft(draft: RegistrationDraft): RegistrationValidation {
  const errors: { code: string; message: string }[] = [];
  if (!DISPLAY_NAME_PATTERN.test(draft.displayName.trim())) {
    errors.push({ code: "INVALID_DISPLAY_NAME", message: "display name must be 1-100 visible characters" });
  }
  if (draft.iconKey !== null && !ICON_KEY_PATTERN.test(draft.iconKey)) {
    errors.push({
      code: "INVALID_ICON",
      message: "icon must be a local preset icon key (letters, digits, dashes); remote URLs and markup are rejected"
    });
  }
  for (const hint of draft.formatHints) {
    if (hint.includes("\0") || hint.trim().length === 0 || hint.length > 200) {
      errors.push({ code: "INVALID_FORMAT_HINT", message: "format hints must be non-empty printable strings" });
      break;
    }
  }
  if (draft.presetAdapterId !== null && !HARNESS_PRESETS.some((preset) => preset.adapterId === draft.presetAdapterId)) {
    errors.push({ code: "UNKNOWN_PRESET", message: "preset adapter id is not one of the known presets" });
  }
  const bindingKeyValue = draft.bindingKey.trim();
  if (bindingKeyValue.length === 0 || bindingKeyValue.includes("|") || bindingKeyValue.includes("\0")) {
    errors.push({ code: "INVALID_BINDING_KEY", message: "binding key must be non-empty and free of '|' / NUL" });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export interface CreateRegistrationInput extends RegistrationDraft {
  readonly adapterIdentity: { readonly adapterId: AdapterId };
  readonly installed: boolean;
  readonly randomHex16: () => string;
  readonly harnessInstanceId: string;
}

export type CreateRegistrationResult =
  | { readonly ok: true; readonly registration: HarnessRegistration }
  | { readonly ok: false; readonly errors: readonly { readonly code: string; readonly message: string }[] };

export function createRegistration(
  input: CreateRegistrationInput,
  existing: readonly { readonly harnessInstanceId: string }[]
): CreateRegistrationResult {
  const validation = validateRegistrationDraft(input);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  if (existing.some((registration) => registration.harnessInstanceId === input.harnessInstanceId)) {
    return {
      ok: false,
      errors: [{ code: "DUPLICATE_IDENTITY", message: "this harness instance identity is already registered" }]
    };
  }
  const presetMatched =
    input.presetAdapterId !== null &&
    input.presetAdapterId === input.adapterIdentity.adapterId &&
    HARNESS_PRESETS.some((preset) => preset.adapterId === input.presetAdapterId);
  const isCustom = input.adapterIdentity.adapterId.startsWith("custom:");
  if (!isCustom && input.presetAdapterId !== null && input.presetAdapterId !== input.adapterIdentity.adapterId) {
    return {
      ok: false,
      errors: [
        {
          code: "PRESET_MISMATCH",
          message: "preset adapter id must match the registration adapter identity"
        }
      ]
    };
  }
  return {
    ok: true,
    registration: {
      harnessInstanceId: input.harnessInstanceId,
      adapterId: input.adapterIdentity.adapterId,
      displayName: input.displayName.trim(),
      presetMatched,
      customIcon: input.iconKey,
      customFormatHints: [...input.formatHints],
      installed: input.installed
    }
  };
}

export type RegistrationStatus =
  | "ready"
  | "not-installed"
  | "read-only"
  | "mapping-pending"
  | "unsupported";

export function registrationStatus(
  registration: HarnessRegistration,
  facts: { readonly installed: boolean; readonly mappingConfigured: boolean; readonly adapterSupported: boolean; readonly writable: boolean }
): RegistrationStatus {
  if (!facts.adapterSupported) {
    return "unsupported";
  }
  if (!facts.installed || !registration.installed) {
    return "not-installed";
  }
  if (!facts.mappingConfigured) {
    return "mapping-pending";
  }
  if (!facts.writable) {
    return "read-only";
  }
  return "ready";
}

export { canAutoCaptureOrApply };
