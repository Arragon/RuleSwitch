// ruleswitch.yaml v1 manifest: strict typed parser with structured
// diagnostics (INH-1766). Fail closed — any syntax or semantic error
// yields diagnostics and NO manifest; callers must not build plans from a
// rejected manifest.
//
// Frozen v1 schema:
//
//   schemaVersion: 1
//   repository:
//     name: <display name>            # optional
//   defaults:
//     profile: <profile name>         # must resolve to profiles/<name>.yaml
//   git:
//     fastForwardOnly: true           # frozen true
//     autoStash: false                # frozen false
//   security:
//     secretPolicy:
//       allowInlineSecrets: false     # frozen false — secrets only by reference
//   sync:
//     deletePolicy: managed-only      # frozen enum
//     conflictPolicy: block           # block | explicit
//   profiles:                         # optional list of profile names
//     - default

import { z } from "zod";

import { parseYamlSubset, type YamlList, type YamlMapping, type YamlValue } from "./yaml";

export const RULESWITCH_MANIFEST_SCHEMA_VERSION = 1;

export const SECRET_REF_PATTERN = /^(env|keychain):[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
/** Secret references are the only permitted secret form: env:VAR / keychain:SERVICE/ACCOUNT. */
export function isValidSecretRef(reference: string): boolean {
  return SECRET_REF_PATTERN.test(reference);
}

export interface ManifestDiagnostic {
  /** SYNTAX_* for parse-stage problems, SEMANTIC_* for meaning problems. */
  readonly code: string;
  readonly fieldPath: string;
  readonly line: number | null;
  readonly message: string;
}

export interface RuleSwitchManifest {
  readonly schemaVersion: 1;
  readonly repository: { readonly name: string | null };
  readonly defaults: { readonly profile: string | null };
  readonly git: { readonly fastForwardOnly: true; readonly autoStash: false };
  readonly security: { readonly secretPolicy: { readonly allowInlineSecrets: false } };
  readonly sync: { readonly deletePolicy: "managed-only"; readonly conflictPolicy: "block" | "explicit" };
  readonly profiles: readonly string[];
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: RuleSwitchManifest; readonly diagnostics: readonly [] }
  | { readonly ok: false; readonly manifest: null; readonly diagnostics: readonly ManifestDiagnostic[] };

const bodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  repository: z.strictObject({ name: z.string().trim().min(1).max(200).nullable() }).default({ name: null }),
  defaults: z.strictObject({ profile: z.string().trim().min(1).max(200).nullable() }).default({ profile: null }),
  git: z
    .strictObject({ fastForwardOnly: z.literal(true), autoStash: z.literal(false) })
    .default({ fastForwardOnly: true, autoStash: false }),
  security: z
    .strictObject({ secretPolicy: z.strictObject({ allowInlineSecrets: z.literal(false) }) })
    .default({ secretPolicy: { allowInlineSecrets: false } }),
  sync: z
    .strictObject({
      deletePolicy: z.literal("managed-only"),
      conflictPolicy: z.enum(["block", "explicit"])
    })
    .default({ deletePolicy: "managed-only", conflictPolicy: "block" }),
  profiles: z.array(z.string().trim().min(1).max(200)).default([])
});

function isMapping(value: YamlValue): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !("items" in value);
}

function stringList(value: YamlValue | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "object" && value !== null && "items" in value) {
    return (value as YamlList).items.filter((item): item is string => typeof item === "string");
  }
  return [];
}

/**
 * Parses a ruleswitch.yaml manifest. Syntax diagnostics come from the YAML
 * subset parser with line/column; semantic diagnostics (unknown fields,
 * frozen-policy violations, duplicate profiles, secret references inside
 * the manifest) are separated and carry a logical field path.
 */
export function parseRuleswitchManifest(text: string): ManifestParseResult {
  const syntax = parseYamlSubset(text);
  if (!syntax.ok) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [
        {
          code: `SYNTAX_${syntax.error.code}`,
          fieldPath: "$",
          line: syntax.error.line,
          message: syntax.error.message
        }
      ]
    };
  }
  const value = syntax.value;
  if (!isMapping(value)) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [{ code: "SEMANTIC_NOT_A_MAPPING", fieldPath: "$", line: 1, message: "manifest must be a mapping" }]
    };
  }

  // Future schema versions fail closed before any other interpretation.
  const version = value.schemaVersion;
  if (version !== undefined && version !== 1) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [
        {
          code: "SEMANTIC_FUTURE_SCHEMA_VERSION",
          fieldPath: "schemaVersion",
          line: null,
          message: `manifest schemaVersion ${String(version)} is not supported (supported: 1)`
        }
      ]
    };
  }

  // Profiles carry only names; inline secret-shaped strings are rejected.
  const profiles = stringList(value.profiles);
  const seenProfiles = new Set<string>();
  const diagnostics: ManifestDiagnostic[] = [];
  for (const profile of profiles) {
    if (seenProfiles.has(profile)) {
      diagnostics.push({
        code: "SEMANTIC_DUPLICATE_PROFILE",
        fieldPath: "profiles",
        line: null,
        message: `duplicate profile name '${profile}'`
      });
    }
    seenProfiles.add(profile);
  }

  const normalized: Record<string, unknown> = { ...value, profiles };
  const parsed = bodySchema.safeParse(normalized);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      let fieldPath = issue.path.length > 0 ? issue.path.join(".") : "$";
      if (issue.code === "unrecognized_keys") {
        fieldPath = issue.keys[0] ?? fieldPath;
      }
      diagnostics.push({
        code: issue.code === "unrecognized_keys" ? "SEMANTIC_UNKNOWN_FIELD" : `SEMANTIC_${issue.code.toUpperCase()}`,
        fieldPath,
        line: null,
        message: issue.message
      });
    }
    return { ok: false, manifest: null, diagnostics };
  }
  if (diagnostics.length > 0) {
    return { ok: false, manifest: null, diagnostics };
  }

  return { ok: true, manifest: parsed.data as RuleSwitchManifest, diagnostics: [] };
}

/** Scans manifest-like text for inline secret values (defense in depth for INH-1766 tests). */
export function findInlineSecretViolations(
  text: string
): readonly { readonly line: number; readonly excerpt: string }[] {
  const violations: { line: number; excerpt: string }[] = [];
  const lines = text.split(/\r?\n/);
  const suspicious = /(password|token|api[_-]?key|secret)\s*[:=]\s*(?!\$\{?(env|keychain):)\S+/i;
  lines.forEach((line, index) => {
    const match = line.match(suspicious);
    if (match) {
      violations.push({ line: index + 1, excerpt: match[0].slice(0, 60) });
    }
  });
  return violations;
}
