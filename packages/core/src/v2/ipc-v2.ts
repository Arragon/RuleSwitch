// Frozen M0 contract (INH-1757, IPC half): the v2 channel namespace rules.
//
// The frozen Phase A 7-method IPC (ruleswitch:v1:*) stays untouched during
// the compatibility window. v2 adds only purposeful, per-capability channels
// under ruleswitch:v2:<group>:<action>, each admitted through ADR/schema
// review with its own strict request/response schemas. There is no generic
// fs/shell/command/path channel and no Renderer-side source of truth: read
// models are always Main-produced DTOs.
//
// Watcher events carry identity + invalidation reason only — never paths
// or content, and they never authorize a write by themselves.

import { z } from "zod";

export const IPC_V2_NAMESPACE = "ruleswitch:v2" as const;

export const IPC_V2_GROUPS = [
  "repository",
  "projects",
  "harnesses",
  "assets",
  "changes",
  "history",
  "operations",
  "settings"
] as const;
export type IpcV2Group = (typeof IPC_V2_GROUPS)[number];

export const ipcV2ChannelSchema = z
  .string()
  .regex(/^ruleswitch:v2:[a-z-]+:[a-z-]+$/)
  .refine(
    (channel) => {
      const group = channel.split(":")[2] ?? "";
      return (IPC_V2_GROUPS as readonly string[]).includes(group);
    },
    { message: "v2 channel group must be one of the frozen capability groups" }
  );

export function isAllowedV2Channel(channel: string): boolean {
  return ipcV2ChannelSchema.safeParse(channel).success;
}

// ---------------------------------------------------------------------------
// Watcher invalidation events
// ---------------------------------------------------------------------------

export const WATCH_INVALIDATION_REASONS = [
  "repository-working-tree",
  "repository-head",
  "harness-global-config",
  "harness-project-config",
  "project-binding",
  "unknown"
] as const;
export type WatchInvalidationReason = (typeof WATCH_INVALIDATION_REASONS)[number];

/**
 * Watch events invalidate caches/read models only. Re-scan, stat/read/hash,
 * and containment checks happen on demand; a watch event alone never
 * produces a plan or a write.
 */
export interface WatchInvalidationEvent {
  readonly reason: WatchInvalidationReason;
  /** Stable identity (repository/project/harness id) — opaque, path-free. */
  readonly subjectId: string;
  readonly occurredAt: string;
}

export const watchInvalidationEventSchema: z.ZodType<WatchInvalidationEvent> = z.strictObject({
  reason: z.enum(WATCH_INVALIDATION_REASONS),
  subjectId: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true })
});

// ---------------------------------------------------------------------------
// Settings contract surface (theme persistence is local-only)
// ---------------------------------------------------------------------------

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const themePreferenceSchema = z.enum(THEME_PREFERENCES);

/** Light is the default; a user's explicit choice persists in the local settings store only. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "light";
