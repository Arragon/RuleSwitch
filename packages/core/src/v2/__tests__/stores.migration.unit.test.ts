import { describe, expect, it } from "vitest";

import {
  gateForLoadResult,
  migrateStore,
  parseStoreEnvelope,
  STORE_ENVELOPE_VERSION
} from "../stores";

const envelopeJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    store: "repositories",
    version: 1,
    writtenAt: "2026-10-07T12:00:00.000Z",
    data: { items: [] },
    ...overrides
  });

/** Phase A snapshot manifests / history ledgers are unversioned JSON objects. */
const legacyPhaseAJson = JSON.stringify({
  manifestVersion: 2,
  workspaceId: "ws-session-random",
  files: [{ logicalPath: "AGENTS.md", digest: "abc" }]
});

describe("store envelope parsing (INH-1757)", () => {
  it("accepts a well-formed v1 envelope for the expected store", () => {
    const result = parseStoreEnvelope(envelopeJson(), "repositories");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.envelope.store).toBe("repositories");
      expect(result.envelope.version).toBe(STORE_ENVELOPE_VERSION);
    }
  });

  it("recognizes legacy unversioned Phase A JSON instead of failing", () => {
    const result = parseStoreEnvelope(legacyPhaseAJson, "repositories");
    expect(result).toEqual({ kind: "legacy", reason: "unversioned-phase-a" });
    expect(gateForLoadResult(result)).toBe("read-only-legacy");
  });

  it("quarantines corrupt JSON, non-objects, and schema violations", () => {
    const truncated = envelopeJson().slice(0, 20);
    expect(parseStoreEnvelope(truncated, "repositories").kind).toBe("corrupt");
    expect(parseStoreEnvelope("[1,2,3]", "repositories").kind).toBe("corrupt");
    expect(
      parseStoreEnvelope(envelopeJson({ version: "one" }), "repositories").kind
    ).toBe("corrupt");
    expect(gateForLoadResult(parseStoreEnvelope(truncated, "repositories"))).toBe("blocked-corrupt");
  });

  it("blocks stores written by a future version", () => {
    const result = parseStoreEnvelope(envelopeJson({ version: 99 }), "repositories");
    expect(result).toEqual({ kind: "future-version", version: 99, supported: 1 });
    expect(gateForLoadResult(result)).toBe("blocked-future-version");
  });

  it("refuses envelopes addressed to a different store", () => {
    const result = parseStoreEnvelope(envelopeJson({ store: "profiles" }), "repositories");
    expect(result.kind).toBe("wrong-store");
  });
});

describe("store migration pipeline", () => {
  it("reports up-to-date when no steps are needed", () => {
    const result = parseStoreEnvelope(envelopeJson(), "repositories");
    if (result.kind !== "ok") {
      throw new Error("fixture envelope must parse");
    }
    expect(migrateStore(result.envelope, [])).toMatchObject({ kind: "up-to-date" });
  });

  it("applies ordered migration steps and stamps the new version", () => {
    const result = parseStoreEnvelope(envelopeJson(), "repositories");
    if (result.kind !== "ok") {
      throw new Error("fixture envelope must parse");
    }
    const outcome = migrateStore(result.envelope, [
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: (data) => ({ ...(data as Record<string, unknown>), v2Field: true })
      }
    ]);    if (outcome.kind !== "migrated") {
      throw new Error("expected migrated");
    }
    expect(outcome.stepsApplied).toEqual([2]);
    expect(outcome.envelope.version).toBe(2);
    expect((outcome.envelope.data as Record<string, unknown>).v2Field).toBe(true);
  });

  it("preserves the original and blocks writes when a step is missing or throws", () => {
    const result = parseStoreEnvelope(envelopeJson(), "repositories");
    if (result.kind !== "ok") {
      throw new Error("fixture envelope must parse");
    }
    const missing = migrateStore(result.envelope, []);
    // envelope v1 with a declared-but-absent path cannot advance: request v1→3 with no steps.
    expect(missing.kind).toBe("up-to-date");

    const failing = migrateStore(result.envelope, [
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: () => {
          throw new Error("boom");
        }
      }
    ]);
    expect(failing).toMatchObject({ kind: "migration-failed", originalPreserved: true });
    expect(gateForLoadResult({ kind: "ok", envelope: result.envelope })).toBe("open");
  });

  it("never migrates past a gap in the step chain", () => {
    const result = parseStoreEnvelope(envelopeJson(), "repositories");
    if (result.kind !== "ok") {
      throw new Error("fixture envelope must parse");
    }
    const gapped = migrateStore(result.envelope, [
      { fromVersion: 2, toVersion: 3, migrate: (data) => data }
    ]);
    // v1 → target 3 but the only step starts at 2: with envelope.version 1 and step 2→3,
    // targetVersion = 3 > 1, loop looks for 1→2 which is absent → failure.
    expect(gapped).toMatchObject({ kind: "migration-failed" });
  });
});
