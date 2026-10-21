// Batch snapshot store (INH-1820 / INH-1821): persists the pre-apply bytes of
// every target so a failed or partial batch can actually be rolled back.
//
// Why this exists: `applyRenderedTargets` captures the previous bytes in
// memory, but a process exit loses them, which made "rollback" impossible and
// forced the recovery surface to report `rollbackAvailable: false`.
//
// Invariants:
// - Blob paths are always `files/<n>.bin`; anything else is rejected, so a
//   tampered manifest cannot point outside the batch directory.
// - Each file records the digest that apply WROTE plus the pre-apply digest.
//   Rollback proceeds when the current bytes match either: the written digest
//   means "restore the snapshot"; the pre-apply digest means the write never
//   landed (mid-batch failure/crash) so nothing needs restoring. A diverged
//   file is reported instead of clobbered.
// - Target roots are stored absolute and never leave Main (no DTO exposes them).

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SnapshotFileRecord {
  /** Path relative to the target root. */
  readonly relativePath: string;
  readonly existedBefore: boolean;
  /** Blob file name inside the batch directory, always `files/<n>.bin`. */
  readonly blobFile: string;
  /** Digest of the bytes apply wrote (used to detect post-apply divergence). */
  readonly appliedDigest: string;
  readonly previousDigest: string | null;
}

export interface SnapshotTargetRecord {
  readonly targetKey: string;
  /** Absolute harness root. Main-only; never serialized to the Renderer. */
  readonly targetRoot: string;
  readonly files: readonly SnapshotFileRecord[];
}

export interface BatchSnapshotManifest {
  readonly batchId: string;
  readonly createdAt: string;
  readonly targets: readonly SnapshotTargetRecord[];
}

const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const BLOB_PATTERN = /^files\/\d{1,6}\.bin$/;

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export class BatchSnapshotStore {
  constructor(private readonly root: string) {}

  private batchDirectory(batchId: string): string {
    if (!BATCH_ID_PATTERN.test(batchId)) {
      throw new Error(`unsafe batch id: ${JSON.stringify(batchId)}`);
    }
    return path.join(this.root, batchId);
  }

  /** Persists the pre-apply bytes captured by `applyRenderedTargets`. */
  async save(input: {
    readonly batchId: string;
    readonly targetKey: string;
    readonly targetRoot: string;
    readonly files: readonly {
      readonly relativePath: string;
      readonly existedBefore: boolean;
      readonly previousContent: Uint8Array | null;
      readonly appliedContent: Uint8Array;
    }[];
  }): Promise<void> {
    const directory = this.batchDirectory(input.batchId);
    await mkdir(path.join(directory, "files"), { recursive: true });

    const manifestPath = path.join(directory, "manifest.json");
    const existing = await this.readManifestFile(manifestPath);
    const files: SnapshotFileRecord[] = [];
    let index = existing?.targets.flatMap((target) => target.files).length ?? 0;

    for (const file of input.files) {
      const blobFile = `files/${index}.bin`;
      index += 1;
      await writeFile(path.join(directory, blobFile), file.previousContent ?? new Uint8Array());
      files.push({
        relativePath: file.relativePath,
        existedBefore: file.existedBefore,
        blobFile,
        appliedDigest: digest(file.appliedContent),
        previousDigest:
          file.previousContent === null ? null : digest(file.previousContent)
      });
    }

    const manifest: BatchSnapshotManifest = {
      batchId: input.batchId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      targets: [
        ...(existing?.targets.filter((target) => target.targetKey !== input.targetKey) ?? []),
        { targetKey: input.targetKey, targetRoot: input.targetRoot, files }
      ]
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  async load(batchId: string): Promise<BatchSnapshotManifest | null> {
    let directory: string;
    try {
      directory = this.batchDirectory(batchId);
    } catch {
      return null;
    }
    return this.readManifestFile(path.join(directory, "manifest.json"));
  }

  async readBlob(batchId: string, blobFile: string): Promise<Uint8Array | null> {
    if (!BLOB_PATTERN.test(blobFile)) {
      return null;
    }
    try {
      const directory = this.batchDirectory(batchId);
      return new Uint8Array(await readFile(path.join(directory, blobFile)));
    } catch {
      return null;
    }
  }

  async remove(batchId: string): Promise<void> {
    try {
      await rm(this.batchDirectory(batchId), { recursive: true, force: true });
    } catch {
      // Removing an already-absent snapshot is not an error.
    }
  }

  /** Lists batch ids that still have a snapshot on disk (diagnostics). */
  async list(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async readManifestFile(manifestPath: string): Promise<BatchSnapshotManifest | null> {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as BatchSnapshotManifest;
      if (typeof parsed.batchId !== "string" || !Array.isArray(parsed.targets)) {
        return null;
      }
      // Reject any manifest whose blob references are not containment-safe.
      for (const target of parsed.targets) {
        for (const file of target.files) {
          if (!BLOB_PATTERN.test(file.blobFile)) {
            return null;
          }
        }
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
