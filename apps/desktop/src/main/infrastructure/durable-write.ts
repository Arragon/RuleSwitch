// Durable file writes (INH-1820 / round 7).
//
// Why this exists: every state file (journal, baselines, settings, batch
// snapshots) is written as "temp + rename", which guarantees a reader never
// sees a half-written file, but says nothing about durability. Without fsync,
// a power loss can leave the rename visible in the directory while the data
// blocks are still in the page cache — the recovery surface would then read a
// journal it cannot trust, or find a snapshot whose blob is zero-filled.
//
// Contract:
// - the bytes are flushed (`fsync`) before the rename, so a renamed file is
//   never backed by unwritten blocks;
// - the parent directory is flushed afterwards so the rename itself survives;
// - a failed rename never leaves the previous file replaced by garbage.
//
// Directory fsync is best-effort: some filesystems (and Windows) refuse to
// open a directory as a file descriptor. The file-level flush still happened,
// so the data is not lost — only the directory entry ordering is best-effort.

import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface DurableWriteOptions {
  /** File mode for the newly created file. Defaults to 0o600. */
  readonly mode?: number;
}

/**
 * Writes `data` to `targetPath` atomically and durably.
 * Any error leaves the previous contents of `targetPath` untouched.
 */
export async function writeFileDurably(
  targetPath: string,
  data: string | Uint8Array,
  options: DurableWriteOptions = {}
): Promise<void> {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "w", options.mode ?? 0o600);
    await handle.writeFile(data);
    // Flush data blocks before the rename becomes visible.
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporaryPath, targetPath);
  await syncDirectory(directory);
}

/** Best-effort directory flush so the rename survives a power loss. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Unsupported on some platforms; the file contents were already flushed.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
