// Watch invalidation service (INH-1782, core policy half): the macOS
// watcher (host side, Main-owned) emits raw fs events; this module defines
// the pure policy that turns them into WatchInvalidationEvents — debounce,
// coalescing, dedup — and re-asserts the security contract: events carry
// identity + reason only, never content, and they only INVALIDATE.

import type { WatchInvalidationEvent, WatchInvalidationReason } from "./ipc-v2";

export interface RawWatchEvent {
  readonly watchRoot: string; // logical root label (repo/scope/harness), never absolute
  readonly kind: "create" | "modify" | "delete" | "rename";
  readonly relativePath: string | null;
  readonly occurredAtMs: number;
}

export type EmittedInvalidation = Pick<WatchInvalidationEvent, "reason" | "subjectId"> & {
  /** Monotonic coalescing counter — consumers re-scan when it advances. */
  readonly generation: number;
};

export interface WatchPolicyOptions {
  readonly debounceMs: number;
  readonly subjectId: string;
  readonly reason: WatchInvalidationReason;
  /** Timer factory (host-provided; keeps core free of DOM/Node timers). */
  readonly schedule: (callback: () => void, ms: number) => () => void;
}

/**
 * Debounced coalescer for one watched root. Rapid writes, atomic editor
 * saves (delete+create), renames, and duplicate/out-of-order events all
 * collapse into a single invalidation per debounce window. The watcher
 * never decides sync state — consumers react by re-scanning (fresh
 * stat/read/hash), and an explicit refresh is always equally correct if an
 * event was missed.
 */
export class WatchInvalidationCoalescer {
  private generation = 0;
  private pendingCount = 0;
  private cancelTimer: (() => void) | null = null;

  readonly onInvalidation: (emitted: EmittedInvalidation) => void;

  constructor(
    private readonly options: WatchPolicyOptions,
    onInvalidation: (emitted: EmittedInvalidation) => void
  ) {
    this.onInvalidation = onInvalidation;
  }

  /** Feed a raw event; the invalidation fires via onInvalidation after the debounce window. */
  push(event: RawWatchEvent): void {
    void event;
    this.pendingCount += 1;
    if (this.cancelTimer !== null) {
      this.cancelTimer();
    }
    this.cancelTimer = this.options.schedule(() => {
      this.cancelTimer = null;
      this.emit();
    }, this.options.debounceMs);
  }

  /** Synchronous flush (app close/rebind): emits immediately if events are pending. */
  flush(): EmittedInvalidation | null {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    if (this.pendingCount === 0) {
      return null;
    }
    this.pendingCount = 0;
    return this.emit();
  }

  /** Releases the subscription (session close/rebind) without emitting. */
  dispose(): void {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.pendingCount = 0;
  }

  currentGeneration(): number {
    return this.generation;
  }

  private emit(): EmittedInvalidation {
    this.pendingCount = 0;
    this.generation += 1;
    const emitted: EmittedInvalidation = {
      reason: this.options.reason,
      subjectId: this.options.subjectId,
      generation: this.generation
    };
    this.onInvalidation(emitted);
    return emitted;
  }
}

/** Security re-assertion: an invalidation carries identity + reason only. */
export function assertNoContentInInvalidation(event: WatchInvalidationEvent): boolean {
  const serialized = JSON.stringify(event);
  return !serialized.includes("content") && !serialized.includes("path");
}
