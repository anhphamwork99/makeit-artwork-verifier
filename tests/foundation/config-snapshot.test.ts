import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { repoConfigSnapshotProblem } from '../../src/allocation/lease';
import {
  OWNED_CONFIG_FILES,
  digestOfFile,
  restoreRepoConfig,
  sha256OfBytes,
  snapshotRepoConfig,
} from '../../src/runtime/config-snapshot';

/**
 * Versioned shared-config snapshot and byte-exact restoration (specification 10;
 * Gate D).
 *
 * Next dev rewrites both `tsconfig.json` (run-specific types include) and
 * `next-env.d.ts` (run-specific routes reference). Both are shared repository
 * files, so cleanup must restore the exact pre-run bytes and must remove a file
 * the run created where none existed before.
 */

const TSCONFIG_BEFORE =
  '{\n  "compilerOptions": { "strict": true },\n  "include": ["**/*.ts"]\n}\n';
const TSCONFIG_AFTER_RUN =
  '{\n  "compilerOptions": { "strict": true },\n  "include": ["**/*.ts", ".next/verify-runs/<run-id>/types/**/*.ts"]\n}\n';
const NEXT_ENV_BEFORE =
  '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n/// <reference path="./.next/types/routes.d.ts" />\n\n// NOTE: This file should not be edited\n';
const NEXT_ENV_AFTER_RUN =
  '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n/// <reference path="./.next/verify-runs/<run-id>/types/routes.d.ts" />\n\n// NOTE: This file should not be edited\n';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRepoFile(repoRoot: string, relativePath: string, content: string): void {
  writeFileSync(path.join(repoRoot, relativePath), content, 'utf8');
}

describe('[Gate D] versioned shared config snapshot and restore', () => {
  it('declares both shared config files the owned dev server rewrites', () => {
    expect(OWNED_CONFIG_FILES).toEqual(['tsconfig.json', 'next-env.d.ts']);
  });

  it('restores every owned file byte-exactly after the dev server rewrites it', () => {
    const repoRoot = tempDir('vt-config-repo-');
    const scratchRoot = tempDir('vt-config-scratch-');
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_BEFORE);
    writeRepoFile(repoRoot, 'next-env.d.ts', NEXT_ENV_BEFORE);
    const tsconfigDigestBefore = sha256OfBytes(Buffer.from(TSCONFIG_BEFORE));
    const nextEnvDigestBefore = sha256OfBytes(Buffer.from(NEXT_ENV_BEFORE));

    const snapshot = snapshotRepoConfig(repoRoot, scratchRoot);
    expect(snapshot.schemaVersion).toBe(REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      'tsconfig.json',
      'next-env.d.ts',
    ]);
    expect(snapshot.files.every((file) => file.existedBefore)).toBe(true);
    expect(snapshot.files.map((file) => file.digestBefore)).toEqual([
      tsconfigDigestBefore,
      nextEnvDigestBefore,
    ]);

    // The owned run rewrites both files with run-specific content.
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_AFTER_RUN);
    writeRepoFile(repoRoot, 'next-env.d.ts', NEXT_ENV_AFTER_RUN);

    const restore = restoreRepoConfig(snapshot);
    expect(restore.restored).toBe(true);
    expect(restore.files.map((file) => file.action)).toEqual(['restored', 'restored']);
    expect(digestOfFile(path.join(repoRoot, 'tsconfig.json'))).toBe(tsconfigDigestBefore);
    expect(digestOfFile(path.join(repoRoot, 'next-env.d.ts'))).toBe(nextEnvDigestBefore);
    expect(readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')).toBe(TSCONFIG_BEFORE);
    expect(readFileSync(path.join(repoRoot, 'next-env.d.ts'), 'utf8')).toBe(NEXT_ENV_BEFORE);
  });

  it('removes an owned file the run created where none existed before', () => {
    const repoRoot = tempDir('vt-config-repo-');
    const scratchRoot = tempDir('vt-config-scratch-');
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_BEFORE);
    // `next-env.d.ts` is absent before the run (a fresh checkout state).
    const snapshot = snapshotRepoConfig(repoRoot, scratchRoot);
    const nextEnvSnapshot = snapshot.files.find((file) => file.relativePath === 'next-env.d.ts');
    expect(nextEnvSnapshot).toEqual(
      expect.objectContaining({ existedBefore: false, digestBefore: null, snapshotPath: null }),
    );

    writeRepoFile(repoRoot, 'next-env.d.ts', NEXT_ENV_AFTER_RUN);

    const restore = restoreRepoConfig(snapshot);
    expect(restore.restored).toBe(true);
    expect(restore.files.map((file) => file.action)).toEqual(['unchanged', 'removed']);
    expect(existsSync(path.join(repoRoot, 'next-env.d.ts'))).toBe(false);
    expect(readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')).toBe(TSCONFIG_BEFORE);
  });

  it('treats an absent-before file that the run never created as unchanged', () => {
    const repoRoot = tempDir('vt-config-repo-');
    const scratchRoot = tempDir('vt-config-scratch-');
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_BEFORE);

    const snapshot = snapshotRepoConfig(repoRoot, scratchRoot);
    const restore = restoreRepoConfig(snapshot);

    expect(restore.restored).toBe(true);
    expect(restore.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged']);
  });

  it('reports unchanged files without rewriting them', () => {
    const repoRoot = tempDir('vt-config-repo-');
    const scratchRoot = tempDir('vt-config-scratch-');
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_BEFORE);
    writeRepoFile(repoRoot, 'next-env.d.ts', NEXT_ENV_BEFORE);
    const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
    const inodeBefore = existsSync(tsconfigPath);

    const snapshot = snapshotRepoConfig(repoRoot, scratchRoot);
    const restore = restoreRepoConfig(snapshot);

    expect(restore.restored).toBe(true);
    expect(restore.files.every((file) => file.action === 'unchanged')).toBe(true);
    expect(inodeBefore).toBe(true);
    expect(readFileSync(tsconfigPath, 'utf8')).toBe(TSCONFIG_BEFORE);
  });

  it('fails closed with a structured diagnostic when a snapshot file is missing', () => {
    const repoRoot = tempDir('vt-config-repo-');
    const scratchRoot = tempDir('vt-config-scratch-');
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_BEFORE);
    writeRepoFile(repoRoot, 'next-env.d.ts', NEXT_ENV_BEFORE);

    const snapshot = snapshotRepoConfig(repoRoot, scratchRoot);
    const tsconfigSnapshot = snapshot.files.find((file) => file.relativePath === 'tsconfig.json');
    if (!tsconfigSnapshot?.snapshotPath) throw new Error('fixture snapshot missing');
    rmSync(tsconfigSnapshot.snapshotPath, { force: true });
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_AFTER_RUN);

    const restore = restoreRepoConfig(snapshot);
    expect(restore.restored).toBe(false);
    const failed = restore.files.find((file) => file.relativePath === 'tsconfig.json');
    expect(failed).toEqual(
      expect.objectContaining({ action: 'failed', path: path.join(repoRoot, 'tsconfig.json') }),
    );
    expect(failed?.detail).toContain('missing');
    // Nothing is invented: the rewritten file is left exactly as it was.
    expect(readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')).toBe(TSCONFIG_AFTER_RUN);
  });

  it('produces a snapshot the ownership verifier accepts, and refuses an unowned snapshot path', () => {
    const repoRoot = tempDir('vt-config-repo-');
    const scratchRoot = tempDir('vt-config-scratch-');
    writeRepoFile(repoRoot, 'tsconfig.json', TSCONFIG_BEFORE);
    const snapshot = snapshotRepoConfig(repoRoot, scratchRoot);

    expect(
      repoConfigSnapshotProblem({ repoRoot, scratchRoot, repoConfigSnapshot: snapshot }),
    ).toBeNull();

    const tampered = {
      schemaVersion: snapshot.schemaVersion,
      files: snapshot.files.map((file) =>
        file.existedBefore ? { ...file, snapshotPath: '/tmp/elsewhere.before' } : file,
      ),
    };
    expect(
      repoConfigSnapshotProblem({ repoRoot, scratchRoot, repoConfigSnapshot: tampered }),
    ).toContain('scratch root');
  });

  it('fails closed on an unsupported snapshot schema version', () => {
    const restore = restoreRepoConfig({ schemaVersion: 99, files: [] });
    expect(restore.restored).toBe(false);
    expect(restore.files).toEqual([]);
    expect(restore.detail).toContain('schema version');
  });

  it('reports a null snapshot as nothing to restore', () => {
    expect(restoreRepoConfig(null)).toEqual({
      restored: true,
      detail: 'No shared config was rewritten.',
      files: [],
    });
  });
});
