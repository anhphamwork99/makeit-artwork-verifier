import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pre-warm the suite command's dynamically imported module graph during
// collection, so the per-test budget below measures the command's decision cost
// rather than Vite's on-demand transform cost under parallel workers.
import '../../src/cli/suite';
import { runDiagnosticSuiteCommand } from '../../src/cli/suite';
import { captureCliResult } from './helpers';

/**
 * `diagnostic --suite` CLI surface (ADR 0019 R12/R13; design §7).
 *
 * These tests prove argument parsing and the fail-closed pre-launch envelope for
 * an unknown suite. The eight-child execution itself is proved by the real
 * all-PASS suite run and the injected-child coordinator contract tests; no test
 * here launches the application.
 *
 * The two pre-launch fail-closed cases resolve the real suite declaration and
 * catalogue in-process (a dynamically imported, large module graph). They take
 * an explicit budget below because the 5 000 ms default is a Vitest harness
 * budget, not a production deadline: under parallel workers the same resolution
 * routinely exceeds it. No assertion is weakened and no retry is used.
 */
const HEAVY_IN_PROCESS_RESOLUTION_BUDGET_MS = 60_000;

interface CapturedRun<T = Record<string, unknown>> {
  code: number;
  result: {
    schemaVersion: number;
    command: string;
    subcommand: string | null;
    status: string;
    exitCode: number;
    launchAttempted: boolean;
    outcome: string | null;
    detail: string;
    details: T | null;
    diagnostics: { code: string; severity: string }[];
  };
}

async function capture<T>(argv: string[]): Promise<CapturedRun<T>> {
  const { code, result } = await captureCliResult<CapturedRun<T>['result']>(argv);
  return { code, result };
}

describe('[ADR 0019 R12] diagnostic suite CLI parsing', () => {
  it('requires one of --case or --suite', async () => {
    const { code, result } = await capture(['diagnostic']);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('CLI_USAGE_INVALID');
  });

  it('rejects `--case` combined with `--suite`', async () => {
    const { code, result } = await capture([
      'diagnostic',
      '--case',
      'cases/diagnostic/requests/layer-text-move-drag-ordinary.json',
      '--suite',
      'representative',
    ]);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
    expect(result.detail).toContain('exactly one of');
  });

  it('rejects `--port` with `--suite` because every child allocates independently', async () => {
    const { code, result } = await capture([
      'diagnostic',
      '--suite',
      'representative',
      '--port',
      '3400',
    ]);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
    expect(result.detail).toContain('independent resources per child');
  });

  it('rejects `--keep-dist-dir` with `--suite`', async () => {
    const { code, result } = await capture([
      'diagnostic',
      '--suite',
      'representative',
      '--keep-dist-dir',
    ]);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
  });

  it('rejects an empty suite id', async () => {
    const { code, result } = await capture(['diagnostic', '--suite', '--run-id', 'x']);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
  });
});

describe('[ADR 0019 R12] diagnostic suite pre-launch fail closed', () => {
  it(
    'rejects an unknown suite without launching any child',
    async () => {
      const { code, result } = await capture<{ executedCount: number; children: unknown[] }>([
        'diagnostic',
        '--suite',
        'not-a-suite',
      ]);
      expect(code).toBe(2);
      expect(result.status).toBe('HARNESS_BLOCKED');
      expect(result.subcommand).toBe('not-a-suite');
      expect(result.launchAttempted).toBe(false);
      expect(result.outcome).toBeNull();
      expect(result.details?.executedCount).toBe(0);
      expect(result.details?.children).toEqual([]);
      expect(result.diagnostics.map((entry) => entry.code)).toContain('DIAGNOSTIC_SUITE_UNKNOWN');
    },
    HEAVY_IN_PROCESS_RESOLUTION_BUDGET_MS,
  );

  it(
    'rejects an unsafe suite execution id before any child',
    async () => {
      const { code, result } = await capture<{ executedCount: number }>([
        'diagnostic',
        '--suite',
        'representative',
        '--run-id',
        '../escape',
      ]);
      expect(code).toBe(2);
      expect(result.status).toBe('HARNESS_BLOCKED');
      expect(result.launchAttempted).toBe(false);
      expect(result.details?.executedCount).toBe(0);
      expect(result.diagnostics.map((entry) => entry.code)).toContain('DIAGNOSTIC_SUITE_INVALID');
    },
    HEAVY_IN_PROCESS_RESOLUTION_BUDGET_MS,
  );
});

describe('[WP1] Diagnostic suite monotonic duration', () => {
  it('uses monotonic elapsed time while retaining wall-clock chronology', async () => {
    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'suite-monotonic-timing-')));
    const evidenceRoot = path.join(parent, 'aggregate');
    const monotonicValues = [100, 200, 500];
    const wallValues = [
      '2026-09-26T10:00:00.000Z',
      '2026-09-26T10:01:00.000Z',
      '2026-09-26T09:59:00.000Z',
    ];
    let wallCalls = 0;
    const appRoot = process.env.MAKEIT_ARTWORK_APP_ROOT;
    if (!appRoot) throw new Error('suite-cli timing test requires MAKEIT_ARTWORK_APP_ROOT.');
    try {
      const result = await runDiagnosticSuiteCommand({
        suiteId: 'representative',
        runId: `suite-timing-${Date.now()}`,
        appRoot,
        evidenceRoot,
        monotonicNow: () => monotonicValues.shift() ?? 500,
        wallNow: () => {
          wallCalls += 1;
          return wallValues.shift() ?? '2026-09-26T09:59:00.000Z';
        },
        runChild: async () => {
          throw new Error('timing-only interrupted child');
        },
      });
      expect(result.details?.durationMs).toBe(400);
      expect(wallCalls).toBe(3);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('[TS-2] help surface', () => {
  it('documents the suite command in the usage envelope', async () => {
    const { code, result } = await capture(['help']);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
    expect(result.detail).toContain('diagnostic --suite <suite-id>');
    expect(result.detail).toContain('validate --all');
  });

  it('answers `--help` without an unknown-command error', async () => {
    const { result } = await capture(['--help']);
    expect(result.status).toBe('USAGE');
    expect(result.detail).toContain('diagnostic --case <request.json>');
  });
});
