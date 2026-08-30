# ADR-0005: Phase B Capability Extension Proposal

- Status: Proposed — requires L4 review
- Scope: post-v1 IPC/storage migration

## Context

The frozen v1 boundary exposes only `openWorkspace`, `readResource`, `openExternal`, `stageTarget`, `applyChangeSet`, `listHistory`, and `restoreHistory`. `openWorkspace` accepts an empty request and `WorkspaceSessionDto` requires exactly one profile and target. This safely supports the Phase A walking skeleton, but cannot express persisted recent workspaces, profile lifecycle, source writes, watcher invalidation, authorized Markdown links, reveal, or snapshot browsing.

Phase B must not implement these features through Renderer filesystem access, hidden path channels, duplicated Renderer persistence, polling presented as a watcher, or direct cross-layer calls.

## Implemented Without Contract Changes

The v1-compatible slice may provide full `.rulesync` source discovery, grouped file browsing, a shared read-only viewer, syntax selection from `FileResource.format`, frontmatter presentation, inert sanitized Markdown links, source-only external open, generated/current selection, and more precise `WORKSPACE_UNAVAILABLE` messages. These behaviors retain the existing capability and transaction semantics.

## Required Capabilities

L4 should define a versioned contract and migration for the following narrow capabilities:

1. Recent workspaces
   - list persisted records using opaque recent-workspace IDs, display metadata, `lastOpenedAt`, and availability state;
   - reopen by opaque recent-workspace ID after Main revalidates the stored path and root identity;
   - retain unavailable/moved records until an explicit user removal;
   - do not expose an absolute path merely to enable reopening.
2. Profiles
   - list/create/duplicate/rename/remove/switch Universal Rulesync profiles;
   - define profile-store ownership, stable IDs, source-root binding, validation, destructive confirmation, and migration from the single session profile;
   - replace the v1 exactly-one-profile session invariant with a versioned multi-profile DTO only after approval.
3. Source editing
   - write by opaque source resource ID with expected revision and bytes;
   - define atomic write, stale rejection, encoding/newline behavior, symlink/root revalidation, failure recovery, and whether source edits require a dedicated snapshot/history policy;
   - never accept an arbitrary path.
4. Watch invalidation
   - subscribe/unsubscribe through a narrowly scoped preload API;
   - emit only workspace/resource IDs and invalidation reasons, never paths or trusted content;
   - Main owns watcher lifecycle and debounce; every event triggers safe re-enumeration plus stat/read/hash before state changes;
   - define delete/recreate, atomic-save, duplicate/out-of-order event, and session teardown semantics.
5. Markdown links
   - resolve a link relative to an authorized source resource in Main;
   - allow a contained file only after canonical root validation and resource registration;
   - allow only `http`/`https` through a dedicated restricted external-URL policy;
   - reject `javascript`, `data`, `file`, unknown protocols, traversal, and escaping symlinks;
   - do not turn `openExternal(resourceId)` into a generic URL/path launcher.
6. Reveal and snapshots
   - reveal only an authorized resource ID if L4 accepts the additional shell capability;
   - list/read snapshot resources through opaque IDs and existing snapshot containment checks if snapshot browsing is in scope.

## Storage Migration Required

Recent-workspace and profile persistence are new versioned stores under Electron `userData`. Their schemas must define stable workspace identity, path confidentiality, canonical revalidation, corruption behavior, atomic writes, migration, and interaction with existing history/ownership directories. They must not reuse random session IDs as stable identity without an explicit migration design.

## Affected Modules

- `packages/core`: versioned domain/DTO schemas and DesktopApi contract;
- `apps/desktop/src/preload`: narrow methods and event lifecycle;
- `apps/desktop/src/main/ipc.ts`: sender validation and new request/response/event validation;
- `RuleSwitchApplication`: relationship checks, profile/recent operations, edit preconditions, invalidation state;
- `NodeFilesystemInfrastructure`: authorized source writes, link resolution, watcher re-enumeration support;
- `ElectronPlatformService`: optional restricted URL open and reveal capability;
- `DesktopStores`: versioned recent/profile stores and migration;
- `packages/ui`: enabled edit/profile/recent/link/watcher states after the contract exists.

## Decision Needed From L4

L4 must approve capability names and schemas, stable workspace identity, profile storage semantics, source-edit safety/history semantics, watcher event transport, URL policy, and migration/version strategy before implementation. Until then, the corresponding controls remain absent rather than simulated.
