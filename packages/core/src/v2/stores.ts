// Frozen M0 contract (INH-1757, local store half): versioned store envelope,
// migration pipeline, and corruption/partial-migration semantics.
//
// Rules (frozen):
// - Every persisted store file is a JSON envelope { store, version,
//   writtenAt, data }. Unversioned JSON is "legacy".
// - Migration runs on a copy; on any failure the original file stays intact
//   and destructive mutations are blocked (state "migration-failed").
// - Corrupt stores are quarantined by the host (rename), never deleted,
//   and block destructive mutations until resolved.
// - The Phase A session-random workspace history is legacy: entries remain
//   readable but are marked legacy-unbound and cannot be re-bound to a
//   stable repository identity retroactively.

import { z } from "zod";

export const STORE_NAMES = [
  "repositories",
  "projects",
  "harness-registry",
  "profiles",
  "sync-baselines",
  "provenance",
  "operations-history",
  "settings"
] as const;
export type StoreName = (typeof STORE_NAMES)[number];
export const storeNameSchema = z.enum(STORE_NAMES);

export const STORE_ENVELOPE_VERSION = 1;

export interface StoreEnvelope<T = unknown> {
  readonly store: StoreName;
  readonly version: number;
  readonly writtenAt: string;
  readonly data: T;
}

export const storeEnvelopeShapeSchema = z.strictObject({
  store: storeNameSchema,
  version: z.number().int().positive(),
  writtenAt: z.string().datetime({ offset: true }),
  data: z.unknown()
});

export type StoreLoadResult<T = unknown> =
  | { readonly kind: "ok"; readonly envelope: StoreEnvelope<T> }
  | { readonly kind: "legacy"; readonly reason: "unversioned-phase-a" }
  | { readonly kind: "future-version"; readonly version: number; readonly supported: number }
  | { readonly kind: "corrupt"; readonly detail: string }
  | { readonly kind: "wrong-store"; readonly expected: StoreName; readonly actual: StoreName };

/** Parses raw store bytes without ever throwing; corrupt input is a value. */
export function parseStoreEnvelope(raw: string, expected: StoreName): StoreLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: "corrupt", detail: `invalid JSON: ${(error as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "corrupt", detail: "store envelope must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (!("version" in record) || !("store" in record)) {
    // Phase A stores (snapshot manifests, history ledgers) are unversioned
    // single-purpose JSON; treat any object without an envelope as legacy.
    return { kind: "legacy", reason: "unversioned-phase-a" };
  }
  const shape = storeEnvelopeShapeSchema.safeParse(record);
  if (!shape.success) {
    return { kind: "corrupt", detail: `envelope schema violation: ${shape.error.issues[0]?.message ?? "unknown"}` };
  }
  const envelope = shape.data as StoreEnvelope;
  if (envelope.store !== expected) {
    return { kind: "wrong-store", expected, actual: envelope.store };
  }
  if (envelope.version > STORE_ENVELOPE_VERSION) {
    return { kind: "future-version", version: envelope.version, supported: STORE_ENVELOPE_VERSION };
  }
  return { kind: "ok", envelope };
}

// ---------------------------------------------------------------------------
// Migration pipeline
// ---------------------------------------------------------------------------

export interface StoreMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(data: unknown): unknown;
}

export type MigrationOutcome<T = unknown> =
  | { readonly kind: "migrated"; readonly envelope: StoreEnvelope<T>; readonly stepsApplied: readonly number[] }
  | { readonly kind: "up-to-date"; readonly envelope: StoreEnvelope<T> }
  | { readonly kind: "migration-failed"; readonly originalPreserved: true; readonly detail: string };

/**
 * Pure migration over an already-loaded envelope. The host persists the
 * result only on success; on failure the original file is untouched and the
 * store must be marked migration-failed, blocking destructive mutations.
 */
export function migrateStore<T = unknown>(
  envelope: StoreEnvelope<T>,
  migrations: readonly StoreMigrationStep[]
): MigrationOutcome<T> {
  const targetVersion = migrations.reduce(
    (version, step) => Math.max(version, step.toVersion),
    envelope.version
  );
  if (targetVersion <= envelope.version) {
    return { kind: "up-to-date", envelope };
  }

  let currentVersion = envelope.version;
  let currentData: unknown = envelope.data;
  const stepsApplied: number[] = [];

  while (currentVersion < targetVersion) {
    const step = migrations.find((candidate) => candidate.fromVersion === currentVersion);
    if (!step) {
      return {
        kind: "migration-failed",
        originalPreserved: true,
        detail: `no migration step from version ${currentVersion} to ${currentVersion + 1}`
      };
    }
    try {
      currentData = step.migrate(currentData);
      currentVersion = step.toVersion;
      stepsApplied.push(step.toVersion);
    } catch (error) {
      return {
        kind: "migration-failed",
        originalPreserved: true,
        detail: `migration step to ${step.toVersion} failed: ${(error as Error).message}`
      };
    }
  }

  return {
    kind: "migrated",
    stepsApplied,
    envelope: {
      store: envelope.store,
      version: currentVersion,
      writtenAt: new Date().toISOString(),
      data: currentData as T
    }
  };
}

// ---------------------------------------------------------------------------
// Mutation gate state (drives the application-level write gate)
// ---------------------------------------------------------------------------

export type StoreGateState =
  | "open"
  | "blocked-corrupt"
  | "blocked-future-version"
  | "blocked-migration-failed"
  | "read-only-legacy";

export function gateForLoadResult(result: StoreLoadResult): StoreGateState {
  switch (result.kind) {
    case "ok":
      return "open";
    case "legacy":
      return "read-only-legacy";
    case "future-version":
      return "blocked-future-version";
    case "corrupt":
      return "blocked-corrupt";
    case "wrong-store":
      return "blocked-corrupt";
  }
}
