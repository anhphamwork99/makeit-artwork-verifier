import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import path from 'node:path';

import type { EnvironmentCell, EnvironmentFacts } from '../contracts/runtime';
import { canonicalize } from '../canonical/canonicalize';
import { resolveRepoRoot } from './paths';

/**
 * Environment and provenance facts recorded with every Doctor result
 * (specification 9.3, 12).
 *
 * These are read-only observations of the machine and installed toolchain. The
 * environment cell declares the required values; any drift between installed
 * versions and the declared cell is reported explicitly rather than silently
 * treated as equivalent.
 */

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPackageVersion(repoRoot: string, packageName: string): string {
  const manifest = readJsonFile(path.join(repoRoot, 'node_modules', packageName, 'package.json'));
  const version = manifest?.version;
  return typeof version === 'string' ? version : 'unknown';
}

function chromiumRevisionFromExecutable(executablePath: string): string | null {
  const match = /chromium(?:_headless_shell)?[-_](\d+)/.exec(executablePath);
  return match ? match[1] : null;
}

export function lockfileDigest(repoRoot: string): string {
  try {
    return createHash('sha256')
      .update(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml')))
      .digest('hex');
  } catch {
    return 'unknown';
  }
}

/**
 * Read-only application revision facts (specification 10, 12).
 *
 * Recorded from the repository the run owns. A dirty working tree is reported
 * explicitly instead of being treated as equivalent to the recorded commit.
 */
export function collectAppRevision(repoRoot: string = resolveRepoRoot()): {
  commit: string | null;
  dirty: boolean | null;
} {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { commit: commit.length > 0 ? commit : null, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

export function runtimeEngineDigest(repoRoot: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(process.execPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('runtime executable is not a regular file');
    const hash = createHash('sha256');
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('runtime executable mutated during hashing');
    }
    const nodeExecutableDigest = hash.digest('hex');
    const packageVersion = (name: string): string => {
      try {
        const packageJson = JSON.parse(
          readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'),
        ) as { version?: unknown };
        return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
      } catch {
        return 'unknown';
      }
    };
    return createHash('sha256')
      .update(
        canonicalize({
          domain: 'makeit:runtime-engine:v1',
          nodeVersion: process.version,
          nodeExecutableDigest,
          next: { name: 'next', version: packageVersion('next') },
          playwright: { name: '@playwright/test', version: packageVersion('@playwright/test') },
          browser: { kind: 'chromium', version: 'runtime-resolved', revision: null },
          platform: process.platform,
          architecture: process.arch,
        }),
      )
      .digest('hex');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
export interface CollectEnvironmentFactsInput {
  cell: EnvironmentCell;
  baseUrl: string;
  chromiumExecutablePath: string;
  repoRoot?: string;
}

export function collectEnvironmentFacts(input: CollectEnvironmentFactsInput): EnvironmentFacts {
  const repoRoot = input.repoRoot ?? resolveRepoRoot();
  return {
    cellId: input.cell.cellId,
    classification: input.cell.classification,
    browserKind: input.cell.browserKind,
    browserChannel: input.cell.browserChannel,
    playwrightVersion: input.cell.playwrightVersion,
    installedPlaywrightVersion: readPackageVersion(repoRoot, '@playwright/test'),
    chromiumRevision: chromiumRevisionFromExecutable(input.chromiumExecutablePath),
    viewport: { ...input.cell.viewport },
    deviceScaleFactor: input.cell.deviceScaleFactor,
    locale: input.cell.locale,
    timezoneId: input.cell.timezoneId,
    colorScheme: input.cell.colorScheme,
    reducedMotion: input.cell.reducedMotion,
    permissions: [...input.cell.permissions],
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    appOrigin: input.baseUrl,
    lockfileDigest: lockfileDigest(repoRoot),
  };
}
