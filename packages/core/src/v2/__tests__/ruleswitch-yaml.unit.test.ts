import { describe, expect, it } from "vitest";

import {
  findInlineSecretViolations,
  isValidSecretRef,
  parseRuleswitchManifest
} from "../ruleswitch-yaml";

const FULL_MANIFEST = [
  "schemaVersion: 1",
  "repository:",
  "  name: Personal Config",
  "defaults:",
  "  profile: default",
  "profiles:",
  "  - default",
  "  - work"
].join("\n");

const MINIMAL_MANIFEST = "schemaVersion: 1\n";

describe("ruleswitch.yaml v1 manifest (INH-1766)", () => {
  it("accepts a full manifest with repository/defaults/profiles", () => {
    const result = parseRuleswitchManifest(FULL_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.schemaVersion).toBe(1);
      expect(result.manifest.repository.name).toBe("Personal Config");
      expect(result.manifest.defaults.profile).toBe("default");
      expect(result.manifest.profiles).toEqual(["default", "work"]);
      // Frozen safety defaults are pinned.
      expect(result.manifest.git.fastForwardOnly).toBe(true);
      expect(result.manifest.git.autoStash).toBe(false);
      expect(result.manifest.security.secretPolicy.allowInlineSecrets).toBe(false);
      expect(result.manifest.sync.deletePolicy).toBe("managed-only");
      expect(result.manifest.sync.conflictPolicy).toBe("block");
    }
  });

  it("accepts a minimal manifest and applies frozen defaults", () => {
    const result = parseRuleswitchManifest(MINIMAL_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.repository.name).toBeNull();
      expect(result.manifest.profiles).toEqual([]);
      expect(result.manifest.sync.conflictPolicy).toBe("block");
    }
  });

  it("fail-closes on unknown fields with a logical path", () => {
    const result = parseRuleswitchManifest("schemaVersion: 1\nmystery: 7\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe("SEMANTIC_UNKNOWN_FIELD");
      expect(result.diagnostics[0]?.fieldPath).toContain("mystery");
    }
  });

  it("fail-closes on future schema versions before anything else", () => {
    const result = parseRuleswitchManifest("schemaVersion: 2\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe("SEMANTIC_FUTURE_SCHEMA_VERSION");
      expect(result.manifest).toBeNull();
    }
  });

  it("fail-closes on attempts to weaken frozen safety policies", () => {
    const stash = parseRuleswitchManifest("schemaVersion: 1\ngit:\n  autoStash: true\n");
    expect(stash.ok).toBe(false);
    if (!stash.ok) {
      expect(stash.diagnostics.some((diagnostic) => diagnostic.fieldPath.startsWith("git"))).toBe(true);
    }

    const ff = parseRuleswitchManifest("schemaVersion: 1\ngit:\n  fastForwardOnly: false\n");
    expect(ff.ok).toBe(false);

    const secrets = parseRuleswitchManifest("schemaVersion: 1\nsecurity:\n  secretPolicy:\n    allowInlineSecrets: true\n");
    expect(secrets.ok).toBe(false);

    const deletePolicy = parseRuleswitchManifest("schemaVersion: 1\nsync:\n  deletePolicy: anything-goes\n");
    expect(deletePolicy.ok).toBe(false);
  });

  it("separates syntax diagnostics (with location) from semantic ones", () => {
    const syntax = parseRuleswitchManifest("schemaVersion: 1\nbroken [\n");
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) {
      expect(syntax.diagnostics[0]?.code.startsWith("SYNTAX_")).toBe(true);
      expect(syntax.diagnostics[0]?.line).not.toBeNull();
    }

    const duplicate = parseRuleswitchManifest("schemaVersion: 1\nprofiles:\n  - a\n  - a\n");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics[0]?.code).toBe("SEMANTIC_DUPLICATE_PROFILE");
      expect(duplicate.diagnostics[0]?.line).toBeNull();
    }
  });

  it("validates secret references as the only permitted secret form", () => {
    expect(isValidSecretRef("env:MY_TOKEN")).toBe(true);
    expect(isValidSecretRef("keychain:ruleswitch/github")).toBe(true);
    expect(isValidSecretRef("password:hunter2")).toBe(false);
    expect(isValidSecretRef("")).toBe(false);
    expect(isValidSecretRef("env:")).toBe(false);
  });

  it("detects inline secret literals with their line numbers", () => {
    const text = "name: ok\napi_key: abc123def\ntoken = nope\n";
    const violations = findInlineSecretViolations(text);
    expect(violations.map((violation) => violation.line)).toEqual([2, 3]);
  });
});
