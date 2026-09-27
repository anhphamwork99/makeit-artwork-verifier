import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { RepoConfigFileSnapshot, RepoConfigSnapshot } from '../contracts/runtime';
import { REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Versioned shared repository config snapshot and byte-exact restoration
 * (specification 10; Gate D).
 *
 * The owned Next.js dev server rewrites shared repository files while it runs:
 * `tsconfig.json` gains its run-specific `.next/verify-runs/<run-id>/types`
 * include, and `next-env.d.ts` gains a run-specific `types/routes.d.ts`
 * reference. Both files are gitignored or shared, so a verification run must
 * leave them exactly as it found them.
 *
 * The snapshot therefore owns a versioned, multi-file contract with two restore
 * obligations per file: byte-exact restoration of a file that existed before the
 * run, and removal of a file the run created where none existed before. Restore
 * reports a structured per-file outcome and never throws.
 */

export const OWNED_CONFIG_FILES = ['tsconfig.json', 'next-env.d.ts'] as const;

export function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestOfFile(filePath: string): string | null {
  try {
    return sha256OfBytes(readFileSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Records the exact bytes of every owned config file before the owned server
 * starts. A file that does not exist is recorded as absent so cleanup removes it
 * if the run creates it.
 */
export function snapshotRepoConfig(repoRoot: string, scratchRoot: string): RepoConfigSnapshot {
  const files: RepoConfigFileSnapshot[] = OWNED_CONFIG_FILES.map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) {
      return {
        relativePath,
        path: absolutePath,
        existedBefore: false,
        digestBefore: null,
        snapshotPath: null,
      };
    }
    const bytes = readFileSync(absolutePath);
    const snapshotPath = path.join(scratchRoot, `${relativePath}.before`);
    writeFileSync(snapshotPath, bytes);
    return {
      relativePath,
      path: absolutePath,
      existedBefore: true,
      digestBefore: sha256OfBytes(bytes),
      snapshotPath,
    };
  });
  return { schemaVersion: REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION, files };
}

export type RepoConfigRestoreAction = 'unchanged' | 'restored' | 'removed' | 'failed';

/** Structured per-file restore outcome; `failed` is the only non-restored action. */
export interface RepoConfigFileRestore {
  relativePath: string;
  path: string;
  action: RepoConfigRestoreAction;
  detail: string;
}

export interface RestoreResult {
  /** True only when every owned file reached its pre-run state. */
  restored: boolean;
  detail: string;
  files: readonly RepoConfigFileRestore[];
}

function restoreFile(snapshot: RepoConfigFileSnapshot): RepoConfigFileRestore {
  const base = { relativePath: snapshot.relativePath, path: snapshot.path };

  if (!snapshot.existedBefore) {
    // The file did not exist before this run. The owned server may have created
    // it; the pre-run state is "absent", so a created file is removed.
    if (!existsSync(snapshot.path)) {
      return {
        ...base,
        action: 'unchanged',
        detail: `${snapshot.relativePath} did not exist before the run and is still absent.`,
      };
    }
    try {
      rmSync(snapshot.path, { force: true });
    } catch (error) {
      return {
        ...base,
        action: 'failed',
        detail: `${snapshot.relativePath} did not exist before the run but could not be removed: ${(error as Error).message}.`,
      };
    }
    if (existsSync(snapshot.path)) {
      return {
        ...base,
        action: 'failed',
        detail: `${snapshot.relativePath} did not exist before the run and still exists after removal.`,
      };
    }
    return {
      ...base,
      action: 'removed',
      detail: `Removed ${snapshot.relativePath}, which did not exist before the run.`,
    };
  }

  if (snapshot.snapshotPath === null || !existsSync(snapshot.snapshotPath)) {
    return {
      ...base,
      action: 'failed',
      detail: `Owned config snapshot is missing for ${snapshot.relativePath}: ${String(
        snapshot.snapshotPath,
      )}.`,
    };
  }

  if (digestOfFile(snapshot.path) === snapshot.digestBefore) {
    return {
      ...base,
      action: 'unchanged',
      detail: `${snapshot.relativePath} was unchanged.`,
    };
  }

  const original = readFileSync(snapshot.snapshotPath);
  try {
    writeFileSync(snapshot.path, original);
  } catch (error) {
    return {
      ...base,
      action: 'failed',
      detail: `${snapshot.relativePath} could not be restored: ${(error as Error).message}.`,
    };
  }
  if (digestOfFile(snapshot.path) !== snapshot.digestBefore) {
    return {
      ...base,
      action: 'failed',
      detail: `${snapshot.relativePath} could not be restored to its recorded digest.`,
    };
  }
  return {
    ...base,
    action: 'restored',
    detail: `Restored ${snapshot.relativePath} to its pre-run bytes.`,
  };
}

/**
 * Restores every owned config file to its pre-run state. An unknown snapshot
 * schema version fails closed instead of being coerced: cleanup can never claim
 * `configRestored` for a contract it does not understand. This function performs
 * no process check of its own — the caller must prove the owned process is dead
 * before calling it.
 */
export function restoreRepoConfig(snapshot: RepoConfigSnapshot | null): RestoreResult {
  if (snapshot === null) {
    return { restored: true, detail: 'No shared config was rewritten.', files: [] };
  }
  if (snapshot.schemaVersion !== REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION) {
    return {
      restored: false,
      detail: `Unsupported shared config snapshot schema version: ${String(snapshot.schemaVersion)}.`,
      files: [],
    };
  }
  const files = snapshot.files.map(restoreFile);
  const failed = files.filter((file) => file.action === 'failed');
  if (failed.length === 0) {
    return {
      restored: true,
      detail: `Restored shared config files: ${files.map((file) => file.relativePath).join(', ')}.`,
      files,
    };
  }
  return {
    restored: false,
    detail: failed.map((file) => file.detail).join(' '),
    files,
  };
}
