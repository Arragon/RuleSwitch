// Canonical semantics for the v1 config kinds (INH-1793 MCP, INH-1794
// Hooks, INH-1795 Commands/Prompts/Agents, INH-1796 Settings, INH-1797
// Native). Each kind declares its canonical shape, managed-region rules,
// and the risk/confirmation contract the engine enforces. Instructions and
// Skills semantics live in skill-asset.ts / repo-layout.ts (M2/M3).

import { z } from "zod";
import { conversionGradeSchema, type ConversionGrade } from "./reconcile";
import { isValidSecretRef } from "./ruleswitch-yaml";

// ---------------------------------------------------------------------------
// MCP (INH-1793): one server = one asset
// ---------------------------------------------------------------------------

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export const mcpTransportSchema = z.enum(MCP_TRANSPORTS);

export interface McpServerAsset {
  /** Stable server identity (the canonical key inside mcpServers). */
  readonly serverName: string;
  readonly transport: (typeof MCP_TRANSPORTS)[number];
  /** stdio: command+args; http/sse: url. */
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  /** env values must be secret REFERENCES, never literals. */
  readonly env: Readonly<Record<string, string>>;
  readonly disabled: boolean;
}

export function validateMcpServer(server: McpServerAsset): readonly string[] {
  const problems: string[] = [];
  if (server.transport === "stdio") {
    if (server.command === null || server.command.trim().length === 0) {
      problems.push("stdio transport requires a command");
    }
    if (server.url !== null) {
      problems.push("stdio transport must not carry a url");
    }
  } else if (server.url === null || !/^https?:\/\//.test(server.url)) {
    problems.push(`${server.transport} transport requires an http(s) url`);
  }
  for (const [key, value] of Object.entries(server.env)) {
    if (!isValidSecretRef(value)) {
      problems.push(`env '${key}' must be a secret reference (env:/keychain:), never a literal`);
    }
  }
  return problems;
}

/** Extracts one managed server from a parsed mcpServers document (Capture path). */
export function extractManagedServer(
  document: Record<string, unknown>,
  containerKey: string,
  serverName: string
): { server: McpServerAsset } | { error: string } {
  const container = document[containerKey];
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return { error: `document has no '${containerKey}' object` };
  }
  const raw = (container as Record<string, unknown>)[serverName];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: `server '${serverName}' not found` };
  }
  const entry = raw as Record<string, unknown>;
  const hasUrl = typeof entry.url === "string";
  const transport = hasUrl ? (entry.type === "sse" ? "sse" : "http") : "stdio";
  const env: Record<string, string> = {};
  const rawEnv = entry.env;
  if (typeof rawEnv === "object" && rawEnv !== null && !Array.isArray(rawEnv)) {
    for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
  }
  return {
    server: {
      serverName,
      transport,
      command: typeof entry.command === "string" ? entry.command : null,
      args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [],
      url: hasUrl ? (entry.url as string) : null,
      env,
      disabled: entry.disabled === true
    }
  };
}

/** Rendered entry for merge into a target document (unknown siblings preserved by structured-edit). */
export function renderMcpServerEntry(server: McpServerAsset): string {
  const body: string[] = [];
  if (server.transport === "stdio") {
    body.push(`"command": ${JSON.stringify(server.command ?? "")}`);
    if (server.args.length > 0) {
      body.push(`"args": [${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`);
    }
  } else {
    body.push(`"url": ${JSON.stringify(server.url ?? "")}`);
  }
  const envKeys = Object.keys(server.env).sort();
  if (envKeys.length > 0) {
    body.push(`"env": {${envKeys.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(server.env[key] ?? "")}`).join(", ")}}`);
  }
  if (server.disabled) {
    body.push(`"disabled": true`);
  }
  return `{${body.join(", ")}}`;
}

// ---------------------------------------------------------------------------
// Hooks (INH-1794): event/matcher/command + executable risk
// ---------------------------------------------------------------------------

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd"
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const hookEventSchema = z.enum(HOOK_EVENTS);

export interface HookAsset {
  readonly hookName: string;
  readonly event: HookEvent;
  readonly matcher: string | null;
  /** The executable content — NEVER run by any RuleSwitch path. */
  readonly command: string;
  readonly workingDirectory: string | null;
  /** env values must be secret references. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number | null;
}

/**
 * Executable-risk gate: adding or modifying a hook payload requires an
 * explicit confirmation flag in the plan; the preview path NEVER executes
 * the command (there is no execution surface on this type at all).
 */
export type HookRiskDecision =
  | { readonly requiresConfirmation: true; readonly reason: string }
  | { readonly requiresConfirmation: false };

export function hookRiskDecision(input: {
  readonly baselineCommand: string | null;
  readonly newCommand: string;
}): HookRiskDecision {
  if (input.baselineCommand === null) {
    return { requiresConfirmation: true, reason: "adding an executable hook requires explicit confirmation" };
  }
  if (input.baselineCommand !== input.newCommand) {
    return { requiresConfirmation: true, reason: "modifying an executable hook requires explicit confirmation" };
  }
  return { requiresConfirmation: false };
}

/**
 * Event mapping across harnesses: the source event maps only when the
 * target harness declares it; otherwise the hook degrades (loss listed) or
 * is unsupported — never silently dropped.
 */
export function mapHookEvent(
  event: HookEvent,
  targetSupportedEvents: ReadonlySet<string>
): { readonly grade: ConversionGrade; readonly loss: string | null } {
  if (targetSupportedEvents.has(event)) {
    return { grade: "lossless", loss: null };
  }
  return {
    grade: "unsupported",
    loss: `target harness does not support event '${event}'`
  };
}

// ---------------------------------------------------------------------------
// Settings (INH-1796): managed-field allowlist
// ---------------------------------------------------------------------------

export interface SettingsManagedField {
  readonly key: string;
  readonly valueType: "string" | "number" | "boolean" | "json";
}

/**
 * Allowlist gate: only declared fields may enter a settings plan; Capture
 * extracts ONLY allowlisted keys from a parsed document.
 */
export function extractManagedSettings(
  document: Record<string, unknown>,
  allowlist: readonly SettingsManagedField[]
): { readonly managed: Record<string, unknown>; readonly unknownKeys: readonly string[] } {
  const managed: Record<string, unknown> = {};
  for (const field of allowlist) {
    if (Object.prototype.hasOwnProperty.call(document, field.key)) {
      managed[field.key] = document[field.key];
    }
  }
  const allowlisted = new Set(allowlist.map((field) => field.key));
  const unknownKeys = Object.keys(document).filter((key) => !allowlisted.has(key)).sort();
  return { managed, unknownKeys };
}

// ---------------------------------------------------------------------------
// Native (INH-1797): adapter-declared paths only
// ---------------------------------------------------------------------------

export interface NativePathDeclaration {
  readonly adapterId: string;
  /** Harness-root-relative path (never absolute, never HOME/system-wide). */
  readonly relativePath: string;
  readonly kind: "file" | "directory";
}

export function validateNativeDeclaration(declaration: NativePathDeclaration): readonly string[] {
  const problems: string[] = [];
  if (
    declaration.relativePath.length === 0 ||
    declaration.relativePath.includes("\0") ||
    declaration.relativePath.includes("\\") ||
    declaration.relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(declaration.relativePath) ||
    declaration.relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    problems.push("native paths must be harness-root-relative and traversal-free");
  }
  if (declaration.relativePath.startsWith(".git") || declaration.relativePath === "ruleswitch.yaml") {
    problems.push("native paths must not overlap repository control files");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Commands / Prompts / Agents (INH-1795)
// ---------------------------------------------------------------------------

export const PROMPTISH_KINDS = ["commands", "prompts", "agents"] as const;
export type PromptishKind = (typeof PROMPTISH_KINDS)[number];

export interface PromptishAsset {
  readonly kind: PromptishKind;
  readonly logicalName: string;
  readonly content: Uint8Array;
  /** Scope conversion legality: prompts/agents are global-first; commands support both. */
  readonly allowedScopes: readonly ("global" | "project")[];
}

export function validatePromptishScope(asset: PromptishAsset, scope: "global" | "project"): string | null {
  if (!asset.allowedScopes.includes(scope)) {
    return `${asset.kind} asset '${asset.logicalName}' does not allow ${scope} scope`;
  }
  return null;
}

export { conversionGradeSchema };
