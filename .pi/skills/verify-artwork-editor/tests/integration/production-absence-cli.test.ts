import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileRequestedChunks } from '../../src/cli/production-absence';
import { captureCliResult } from './helpers';

/**
 * `production-absence` CLI wiring (TS-2, Gate C).
 *
 * The heavy end-to-end proof runs as the `pnpm verify:artwork production-absence`
 * command. This suite proves the stable command surface: usage rejection is a
 * usage error (never a silent launch), and requested hashed chunks are
 * reconciled against the emitted `distDir` so the browser "no seam chunk" claim
 * is not vacuous.
 */

interface CapturedRun {
  code: number;
  result: {
    command: string;
    status: string;
    exitCode: number;
    launchAttempted: boolean;
  };
}

async function captureCli(argv: string[]): Promise<CapturedRun> {
  const { code, result } = await captureCliResult<CapturedRun['result']>(argv);
  return { code, result };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-artwork-absence-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('[TS-2] production-absence command surface', () => {
  it('rejects a non-numeric build timeout as a usage error without launching', async () => {
    const { code, result } = await captureCli(['production-absence', '--build-timeout-ms=soon']);
    expect(code).toBe(64);
    expect(result.command).toBe('production-absence');
    expect(result.status).toBe('USAGE');
    expect(result.launchAttempted).toBe(false);
  });

  it('rejects a subcommand rather than treating it as a launch request', async () => {
    const { code, result } = await captureCli(['production-absence', 'reload']);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
  });

  it('is implemented, so it never reports NOT_IMPLEMENTED', async () => {
    const { result } = await captureCli(['production-absence', '--start-timeout-ms=soon']);
    expect(result.status).not.toBe('NOT_IMPLEMENTED');
  });
});

describe('[Gate C] requested production chunk reconciliation', () => {
  it('resolves requested static chunks against the emitted owned distDir', () => {
    const distDir = tempDir();
    mkdirSync(path.join(distDir, 'static', 'chunks'), { recursive: true });
    writeFileSync(path.join(distDir, 'static', 'chunks', 'a.js'), 'const x = 1;\n');

    const result = reconcileRequestedChunks(
      [
        'http://127.0.0.1:41234/_next/static/chunks/a.js',
        'http://127.0.0.1:41234/_next/static/chunks/missing.js',
      ],
      distDir,
    );

    expect(result.resolved).toBe(1);
    expect(result.unresolved).toEqual(['http://127.0.0.1:41234/_next/static/chunks/missing.js']);
  });
});
