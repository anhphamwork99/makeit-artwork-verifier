import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { resolveRepoRoot } from '../../src/runtime/paths';

/**
 * The `next.config.mjs` namespaced distDir guard (specification 10; Gate D).
 *
 * The guard is exercised through a real Next config load in a child Node
 * process, so an invalid value genuinely fails before Next can start, and an
 * absent value leaves the default build output untouched.
 */

const repoRoot = resolveRepoRoot();
const configScript = `
import cfg from './next.config.mjs';
const config = cfg('phase-production-build');
process.stdout.write(JSON.stringify({ distDir: config.distDir ?? null }));
`;

interface ConfigLoad {
  status: number;
  stdout: string;
  stderr: string;
}

function loadConfig(artworkDistDir: string | null): ConfigLoad {
  const env = { ...process.env };
  if (artworkDistDir === null) {
    delete env.ARTWORK_VERIFY_DIST_DIR;
  } else {
    env.ARTWORK_VERIFY_DIST_DIR = artworkDistDir;
  }
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', configScript], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('[Gate D] namespaced ARTWORK_VERIFY_DIST_DIR guard', () => {
  it('accepts a normalized relative path strictly under the verification namespace', () => {
    const value = '.next/verify-runs/vt-guard-run-1';
    const result = loadConfig(value);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ distDir: value });
  });

  it('leaves default build output unchanged when the variable is absent or empty', () => {
    expect(JSON.parse(loadConfig(null).stdout)).toEqual({ distDir: null });
    expect(JSON.parse(loadConfig('').stdout)).toEqual({ distDir: null });
    expect(JSON.parse(loadConfig('   ').stdout)).toEqual({ distDir: null });
  });

  it('rejects a non-canonical spelling instead of silently normalizing the namespace', () => {
    // Each of these would normalize into the owned namespace but does not
    // identify the same run the caller asked for. Accepting them would let a
    // run silently retarget another run's build output.
    const nonCanonicalValues = [
      '.next/verify-runs/a/../b',
      '.next/verify-runs/./run-1',
      './.next/verify-runs/run-1',
      '.next/verify-runs/run-1/',
      '.next//verify-runs/run-1',
      '.next/verify-runs/run-1/.',
    ];

    for (const value of nonCanonicalValues) {
      const result = loadConfig(value);
      expect(result.status, value).not.toBe(0);
      expect(result.stderr, value).toContain('Refusing to start Next');
      expect(result.stderr, value).toContain('already-normalized');
      expect(result.stdout, value).toBe('');
    }
  });

  it('fails before Next starts for every value outside the namespace contract', () => {
    const invalidValues = [
      '/absolute/path',
      '.next/other/run',
      '.next/verify-runs/../shared',
      '.next/verify-runs/a/b',
      '.next/verify-runs/.',
      '.next/verify-runs/..',
      '.next/verify-runs/',
      'C:\\verify\\run',
      '.next/verify-runs/bad id',
    ];

    for (const value of invalidValues) {
      const result = loadConfig(value);
      expect(result.status, value).not.toBe(0);
      expect(result.stderr, value).toContain('Refusing to start Next');
      expect(result.stdout, value).toBe('');
    }
  });
});
