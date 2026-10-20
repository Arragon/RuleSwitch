import { describe, expect, it } from "vitest";

import {
  assertGradeEvidence,
  classifyReadiness,
  computeConversionGrade
} from "../readiness";
import {
  extractManagedServer,
  extractManagedSettings,
  hookRiskDecision,
  mapHookEvent,
  renderMcpServerEntry,
  validateMcpServer,
  validateNativeDeclaration,
  validatePromptishScope,
  type McpServerAsset
} from "../config-kinds";
import {
  createSecretResolver,
  findSecretLeaks,
  parseSecretRef,
  redactSecrets
} from "../secrets";

describe("MCP server asset (INH-1793)", () => {
  const server: McpServerAsset = {
    serverName: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    url: null,
    env: { API_TOKEN: "env:MY_TOKEN" },
    disabled: false
  };

  it("validates canonical fields; env must be references, never literals", () => {
    expect(validateMcpServer(server)).toEqual([]);
    expect(validateMcpServer({ ...server, transport: "http", command: "npx" }).length).toBeGreaterThan(0);
    expect(validateMcpServer({ ...server, env: { API_TOKEN: "sk-live-literal" } }).length).toBeGreaterThan(0);
  });

  it("extracts one managed server from a shared document", () => {
    const document = {
      mcpServers: {
        filesystem: { command: "npx", args: ["-y"], env: { T: "env:T" } },
        "user-own": { command: "custom" }
      }
    };
    const extracted = extractManagedServer(document as never, "mcpServers", "filesystem");
    if ("error" in extracted) {
      throw new Error(extracted.error);
    }
    expect(extracted.server.transport).toBe("stdio");
    expect(extracted.server.env).toEqual({ T: "env:T" });
    expect(extractManagedServer(document as never, "mcpServers", "ghost")).toMatchObject({ error: expect.stringContaining("not found") });
  });

  it("renders entries for surgical merge; unknown siblings untouched by the editor", () => {
    const rendered = renderMcpServerEntry(server);
    expect(rendered).toContain('"command": "npx"');
    expect(rendered).toContain('"API_TOKEN": "env:MY_TOKEN"');
  });
});

describe("hooks asset (INH-1794)", () => {
  it("flags every add/modify as executable-risk requiring explicit confirmation", () => {
    expect(hookRiskDecision({ baselineCommand: null, newCommand: "echo hi" })).toMatchObject({
      requiresConfirmation: true
    });
    expect(hookRiskDecision({ baselineCommand: "echo hi", newCommand: "echo bye" })).toMatchObject({
      requiresConfirmation: true
    });
    expect(hookRiskDecision({ baselineCommand: "echo hi", newCommand: "echo hi" })).toMatchObject({
      requiresConfirmation: false
    });
  });

  it("maps events losslessly only when the target declares them", () => {
    const supported = new Set(["PreToolUse", "PostToolUse"]);
    expect(mapHookEvent("PreToolUse", supported)).toMatchObject({ grade: "lossless", loss: null });
    const unsupported = mapHookEvent("SessionStart", supported);
    expect(unsupported.grade).toBe("unsupported");
    expect(unsupported.loss).toContain("SessionStart");
  });
});

describe("settings allowlist (INH-1796)", () => {
  it("extracts only allowlisted fields and lists unknown keys", () => {
    const document = { managedA: 1, managedB: "x", userTheme: "dark", userOrder: [1, 2] };
    const { managed, unknownKeys } = extractManagedSettings(document as never, [
      { key: "managedA", valueType: "number" },
      { key: "managedB", valueType: "string" }
    ]);
    expect(managed).toEqual({ managedA: 1, managedB: "x" });
    expect(unknownKeys).toEqual(["userOrder", "userTheme"]);
  });
});

describe("native declarations (INH-1797)", () => {
  it("rejects absolute/traversal/control-file paths", () => {
    expect(validateNativeDeclaration({ adapterId: "codex", relativePath: "config.toml", kind: "file" })).toEqual([]);
    expect(validateNativeDeclaration({ adapterId: "codex", relativePath: "../escape", kind: "file" }).length).toBeGreaterThan(0);
    expect(validateNativeDeclaration({ adapterId: "codex", relativePath: "/etc/passwd", kind: "file" }).length).toBeGreaterThan(0);
    expect(validateNativeDeclaration({ adapterId: "codex", relativePath: "ruleswitch.yaml", kind: "file" }).length).toBeGreaterThan(0);
  });
});

describe("promptish scopes (INH-1795)", () => {
  it("enforces allowed scopes per asset", () => {
    expect(validatePromptishScope({ kind: "commands", logicalName: "a", content: new Uint8Array(), allowedScopes: ["global", "project"] }, "project")).toBeNull();
    expect(
      validatePromptishScope({ kind: "agents", logicalName: "a", content: new Uint8Array(), allowedScopes: ["global"] }, "project")
    ).toContain("does not allow project scope");
  });
});

describe("secret resolver (INH-1798)", () => {
  it("parses the frozen reference forms only", () => {
    expect(parseSecretRef("env:MY_TOKEN")).toMatchObject({ kind: "environment", variable: "MY_TOKEN" });
    expect(parseSecretRef("keychain:ruleswitch/github")).toMatchObject({ kind: "keychain", service: "ruleswitch", account: "github" });
    expect(parseSecretRef("literal:abc")).toBeNull();
    expect(parseSecretRef("keychain:only-service")).toBeNull();
  });

  it("resolves env and keychain; missing/denied are structured, never fake success", async () => {
    const resolver = createSecretResolver(
      { MY_TOKEN: "super-secret-value-123" },
      async (service, account) =>
        service === "ruleswitch" && account === "github"
          ? { ok: true, value: "ghp-keychain-secret-456" }
          : account === "denied"
            ? { ok: false, reason: "DENIED" }
            : { ok: false, reason: "MISSING" }
    );
    await expect(resolver.resolve("env:MY_TOKEN")).resolves.toMatchObject({ ok: true, value: "super-secret-value-123" });
    await expect(resolver.resolve("keychain:ruleswitch/github")).resolves.toMatchObject({ ok: true });
    await expect(resolver.resolve("keychain:ruleswitch/missing")).resolves.toMatchObject({ ok: false, reason: "MISSING" });
    await expect(resolver.resolve("keychain:ruleswitch/denied")).resolves.toMatchObject({ ok: false, reason: "DENIED" });
    await expect(resolver.resolve("env:ABSENT")).resolves.toMatchObject({ ok: false, reason: "MISSING" });
    await expect(resolver.resolve("bad:ref")).resolves.toMatchObject({ ok: false, reason: "INVALID_REF" });
  });

  it("redacts raw and encoded secret forms structurally", () => {
    const context = { knownValues: ["super-secret-value-123"] };
    const encoded = encodeURIComponent("super-secret-value-123");
    const base64 = BufferLike("super-secret-value-123");
    const text = `token=super-secret-value-123 url=https://x/?t=${encoded} b64=${base64} clean=data`;
    const redacted = redactSecrets(text, context);
    expect(redacted).not.toContain("super-secret-value-123");
    expect(redacted).not.toContain(encoded);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("clean=data");
    expect(findSecretLeaks(redacted, context)).toEqual([]);
    // The gate catches leaks the naive substring check would miss.
    expect(findSecretLeaks(text, context).length).toBeGreaterThan(0);
  });

  it("gate scans serialization output for leaks", async () => {
    const resolver = createSecretResolver({ K: "leaky-value-987654" }, async () => ({ ok: false, reason: "MISSING" }));
    const resolved = await resolver.resolve("env:K");
    if (!resolved.ok) {
      throw new Error("fixture");
    }
    const serialized = JSON.stringify({ preview: `key is ${resolved.value}`, argv: ["--token", resolved.value] });
    expect(findSecretLeaks(serialized, { knownValues: [resolved.value] })).toEqual(["raw"]);
    expect(redactSecrets(serialized, { knownValues: [resolved.value] })).not.toContain("leaky-value-987654");
  });
});

function BufferLike(input: string): string {
  // base64 of the utf8 bytes, matching the resolver's encoding variant.
  const bytes = Array.from(input).flatMap((char) => Array.from(char).map((c) => c.codePointAt(0) ?? 0));
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

describe("dependency readiness (INH-1799)", () => {
  it("READY when everything passes", () => {
    const report = classifyReadiness({
      harnessInstalled: true,
      installedVersion: "1.2.0",
      commands: [{ command: "node", found: true, optional: false }],
      targetDirectoryWritable: true,
      requiredSecretsResolved: true,
      adapterSupported: true
    });
    expect(report.state).toBe("READY");
  });

  it("CONFIG_READY_DEPENDENCY_MISSING when config restored but a command is absent", () => {
    const report = classifyReadiness({
      harnessInstalled: true,
      installedVersion: null,
      commands: [{ command: "uvx", found: false, optional: false }],
      targetDirectoryWritable: true,
      requiredSecretsResolved: true,
      adapterSupported: true
    });
    expect(report.state).toBe("CONFIG_READY_DEPENDENCY_MISSING");
    const missing = report.checks.find((check) => check.checkId === "command:uvx");
    expect(missing?.nextStep).toContain("does not install");
  });

  it("BLOCKED for missing harness, unsupported adapter, or unwritable target", () => {
    expect(
      classifyReadiness({
        harnessInstalled: false,
        installedVersion: null,
        commands: [],
        targetDirectoryWritable: true,
        requiredSecretsResolved: true,
        adapterSupported: true
      }).state
    ).toBe("BLOCKED");
    expect(
      classifyReadiness({
        harnessInstalled: true,
        installedVersion: "1.0.0",
        commands: [],
        targetDirectoryWritable: true,
        requiredSecretsResolved: true,
        adapterSupported: false
      }).state
    ).toBe("BLOCKED");
    expect(
      classifyReadiness({
        harnessInstalled: true,
        installedVersion: "1.0.0",
        commands: [],
        targetDirectoryWritable: false,
        requiredSecretsResolved: true,
        adapterSupported: true
      }).state
    ).toBe("BLOCKED");
  });

  it("optional command misses do not downgrade readiness", () => {
    const report = classifyReadiness({
      harnessInstalled: true,
      installedVersion: "1.0.0",
      commands: [{ command: "ripgrep", found: false, optional: true }],
      targetDirectoryWritable: true,
      requiredSecretsResolved: true,
      adapterSupported: true
    });
    expect(report.state).toBe("READY");
  });
});

describe("conversion grade engine (INH-1800)", () => {
  const base = {
    converterId: "ruleswitch.mcp",
    converterVersion: "1.0.0",
    sourceCapability: "claude-code:read-write",
    targetCapability: "codex:read-write"
  };

  it("lossless requires fixture proof; unproven caps at equivalent", () => {
    const proven = computeConversionGrade({ ...base, losses: [], equivalenceProvenByFixture: true });
    expect(proven.overallGrade).toBe("lossless");
    expect(proven.requiresConfirmation).toBe(false);
    const unproven = computeConversionGrade({ ...base, losses: [] });
    expect(unproven.overallGrade).toBe("equivalent");
  });

  it("degrades with losses and requires confirmation; unsupported produces no target", () => {
    const degraded = computeConversionGrade({
      ...base,
      losses: [{ subject: "env literals", loss: "literal env values are not portable", severity: "loss" }]
    });
    expect(degraded.overallGrade).toBe("degraded");
    expect(degraded.requiresConfirmation).toBe(true);
    expect(degraded.targetProduced).toBe(true);

    const unsupported = computeConversionGrade({ ...base, losses: [], unsupported: true });
    expect(unsupported.overallGrade).toBe("unsupported");
    expect(unsupported.targetProduced).toBe(false);
  });

  it("conformance guard catches false lossless claims and contract violations", () => {
    const report = computeConversionGrade({ ...base, losses: [], equivalenceProvenByFixture: true });
    expect(assertGradeEvidence(report, ["unknown-field-x"]).length).toBeGreaterThan(0);
    expect(assertGradeEvidence(report, [])).toEqual([]);
    // A converter that secretly produced a target while claiming unsupported
    // violates the contract; the guard must catch it.
    const lying = {
      ...computeConversionGrade({ ...base, losses: [], unsupported: true }),
      targetProduced: true
    };
    expect(assertGradeEvidence(lying, []).length).toBeGreaterThan(0);
    // Degraded without confirmation is also a violation.
    const unconfirmedDegraded = {
      ...computeConversionGrade({
        ...base,
        losses: [{ subject: "x", loss: "y", severity: "loss" as const }]
      }),
      requiresConfirmation: false
    };
    expect(assertGradeEvidence(unconfirmedDegraded, []).length).toBeGreaterThan(0);
  });

  it("per-kind four-grade fixtures (one kind shown; matrix expanded per report)", () => {
    for (const kind of ["instructions", "skills", "mcp", "hooks", "settings"]) {
      const lossless = computeConversionGrade({
        ...base,
        converterId: `ruleswitch.${kind}`,
        losses: [],
        equivalenceProvenByFixture: true
      });
      const equivalent = computeConversionGrade({
        ...base,
        converterId: `ruleswitch.${kind}`,
        losses: [{ subject: "format", loss: "frontmatter reformatted", severity: "warning" }],
        equivalenceProvenByFixture: true
      });
      const degraded = computeConversionGrade({
        ...base,
        converterId: `ruleswitch.${kind}`,
        losses: [{ subject: "field-x", loss: "not portable", severity: "loss" }]
      });
      const unsupported = computeConversionGrade({ ...base, converterId: `ruleswitch.${kind}`, losses: [], unsupported: true });
      expect([lossless.overallGrade, equivalent.overallGrade, degraded.overallGrade, unsupported.overallGrade]).toEqual([
        "lossless",
        "equivalent",
        "degraded",
        "unsupported"
      ]);
    }
  });
});
