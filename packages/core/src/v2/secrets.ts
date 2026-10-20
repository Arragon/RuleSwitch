// Secret Reference Resolver (INH-1798): env:// and keychain:// references
// only — values never enter Git, Preview, History, logs, or diagnostics.
//
// The resolver itself has NO write path anywhere (type-level: no method
// returns a mutation, the interface only reads). Redaction is structural:
// `redactSecrets` replaces every known secret VALUE (and its common
// encodings: URL-encoded, base64, hex) in arbitrary text, and
// `assertNoSecrets` is the gate used by preview/log serializers in tests.

import { isValidSecretRef } from "./ruleswitch-yaml";

export type SecretSource =
  | { readonly kind: "environment"; readonly variable: string }
  | { readonly kind: "keychain"; readonly service: string; readonly account: string };

/** Parses a frozen-form reference ("env:VAR" / "keychain:SERVICE/ACCOUNT"). */
export function parseSecretRef(reference: string): SecretSource | null {
  if (!isValidSecretRef(reference)) {
    return null;
  }
  if (reference.startsWith("env:")) {
    return { kind: "environment", variable: reference.slice("env:".length) };
  }
  const rest = reference.slice("keychain:".length);
  const separator = rest.indexOf("/");
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }
  return {
    kind: "keychain",
    service: rest.slice(0, separator),
    account: rest.slice(separator + 1)
  };
}

export type SecretResolveOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "MISSING" | "DENIED" | "INVALID_REF"; readonly detail: string };

export interface SecretResolver {
  /** Reads one secret value into memory only; there is no write method. */
  resolve(reference: string): Promise<SecretResolveOutcome>;
}

/** Host-provided keychain reader (injected so tests never touch a real Keychain). */
export type KeychainReader = (
  service: string,
  account: string
) => Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: "MISSING" | "DENIED" }>;

export function createSecretResolver(environment: Readonly<Record<string, string>>, keychain: KeychainReader): SecretResolver {
  return {
    async resolve(reference) {
      const parsed = parseSecretRef(reference);
      if (parsed === null) {
        return { ok: false, reason: "INVALID_REF", detail: `secret reference is not in the frozen env:/keychain: form: ${JSON.stringify(reference)}` };
      }
      if (parsed.kind === "environment") {
        const value = environment[parsed.variable];
        if (value === undefined || value === "") {
          return { ok: false, reason: "MISSING", detail: `environment variable '${parsed.variable}' is not set` };
        }
        return { ok: true, value };
      }
      const result = await keychain(parsed.service, parsed.account);
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason,
          detail: result.reason === "DENIED" ? `keychain access denied for ${parsed.service}/${parsed.account}` : `no keychain item for ${parsed.service}/${parsed.account}`
        };
      }
      return { ok: true, value: result.value };
    }
  };
}

// ---------------------------------------------------------------------------
// Structural redaction
// ---------------------------------------------------------------------------

export interface RedactionContext {
  /** Known secret values from resolved references (never persisted anywhere). */
  readonly knownValues: readonly string[];
}

function encodingsOf(value: string): readonly string[] {
  const variants = new Set<string>([value]);
  try {
    variants.add(encodeURIComponent(value));
  } catch {
    // surrogate pairs may throw in some forms; base variants still apply
  }
  variants.add(base64Encode(value));
  variants.add(
    Array.from(new TextEncoderLike(value))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
  return [...variants].filter((variant) => variant.length >= 4);
}

function base64Encode(input: string): string {
  const bytes = new TextEncoderLike(input).bytes;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    output += alphabet[b0 >> 2];
    output += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    output += b1 === undefined ? "=" : alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    output += b2 === undefined ? "=" : alphabet[b2 & 0x3f];
  }
  return output;
}

class TextEncoderLike {
  readonly bytes: number[];
  constructor(input: string) {
    const octets: number[] = [];
    for (const char of input) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint < 0x80) {
        octets.push(codePoint);
      } else if (codePoint < 0x800) {
        octets.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint < 0x10000) {
        octets.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
      } else {
        octets.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
      }
    }
    this.bytes = octets;
  }
  [Symbol.iterator](): Iterator<number> {
    return this.bytes[Symbol.iterator]();
  }
}

/**
 * Replaces every known secret value AND its encoded variants (raw,
 * URL-encoded, base64, hex) with a stable placeholder. Structural, not
 * substring-only: each encoding is matched independently so encoded leaks
 * cannot slip through.
 */
export function redactSecrets(text: string, context: RedactionContext): string {
  let output = text;
  for (const value of context.knownValues) {
    if (value.length < 4) {
      continue; // trivially short values are not redactable reliably; refs never hold them
    }
    for (const variant of encodingsOf(value)) {
      while (output.includes(variant)) {
        output = output.replace(variant, "[REDACTED]");
      }
    }
  }
  return output;
}

/** The redaction gate: returns the offending excerpts instead of throwing. */
export function findSecretLeaks(text: string, context: RedactionContext): readonly string[] {
  const leaks: string[] = [];
  for (const value of context.knownValues) {
    if (value.length < 4) {
      continue;
    }
    for (const variant of encodingsOf(value)) {
      if (text.includes(variant)) {
        leaks.push(variant === value ? "raw" : "encoded");
      }
    }
  }
  return leaks;
}
