import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFERRED_CLI_COMMANDS } from '../../src/contracts/discriminants';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { captureCliResult, removeTestRunArtifacts, uniqueRunId } from './helpers';

interface CapturedRun {
  code: number;
  result: {
    schemaVersion: number;
    command: string;
    status: string;
    exitCode: number;
    launchAttempted: boolean;
    details: Record<string, unknown> | null;
    diagnostics: { code: string; severity: string }[];
  };
}

async function captureCli(argv: string[]): Promise<CapturedRun> {
  const { code, result } = await captureCliResult<CapturedRun['result']>(argv);
  return { code, result };
}

const created: string[] = [];

afterEach(() => {
  for (const runId of created.splice(0)) removeTestRunArtifacts(runId);
});

describe('[TS-2] stable verify:artwork CLI surface', () => {
  // `validate --all` loads and audits every authoritative catalogue through the
  // dynamically imported CLI. 30 000 ms is a test budget for that in-process
  // work under parallel workers, not a production deadline; assertions are
  // unchanged and no retry is used.
  it('validates every authoritative catalogue and the branch audit through `validate --all`', async () => {
    const { code, result } = await captureCli(['validate', '--all']);

    expect(code).toBe(0);
    expect(result.command).toBe('validate');
    expect(result.status).toBe('PASS');
    expect(result.launchAttempted).toBe(false);
    const details = result.details as {
      branchAudit: { passed: boolean; engineFiles: number };
      coverage: { models: unknown[] };
      counts: { coverageModels: number };
      environments: { cells: unknown[] };
      blockingDiagnostics: unknown[];
    };
    expect(details.branchAudit.passed).toBe(true);
    expect(details.branchAudit.engineFiles).toBeGreaterThanOrEqual(18);
    expect(details.counts.coverageModels).toBeGreaterThan(0);
    expect(details.coverage.models).toHaveLength(details.counts.coverageModels);
    expect(details.environments.cells.length).toBeGreaterThan(0);
    expect(details.blockingDiagnostics).toEqual([]);
  }, 30_000);

  it('plans a case, emits static artifacts, and never launches', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'verify-plan-'));
    try {
      const casePath = path.join(
        resolveSkillRoot(),
        'tests',
        'integration',
        'fixtures',
        'layer-text-move.request.json',
      );
      const { code, result } = await captureCli(['plan', '--case', casePath, '--out', outDir]);

      expect(code).toBe(0);
      expect(result.status).toBe('PASS');
      expect(result.launchAttempted).toBe(false);
      const details = result.details as {
        artifacts: string[];
        launchability: { launchable: boolean; blockers: string[]; deferredStages: string[] };
      };
      expect(details.launchability.launchable).toBe(true);
      expect(details.launchability.deferredStages).toEqual([]);
      expect(details.artifacts).toEqual(
        expect.arrayContaining([
          'plan.json',
          'execution-plan.json',
          'preflight-report.json',
          'launchability.json',
        ]),
      );
      const plan = JSON.parse(readFileSync(path.join(outDir, 'plan.json'), 'utf8')) as {
        launchable: boolean;
        launchAttempted: boolean;
        requiredChecks: string[];
      };
      // The delivered `layer/text × move × drag-ordinary` binding resolves P5/P7,
      // so it is statically launchable even though `plan` itself never launches.
      expect(plan.launchable).toBe(true);
      expect(plan.launchAttempted).toBe(false);
      expect(plan.requiredChecks.length).toBeGreaterThan(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('fails closed with structured NOT_IMPLEMENTED for every deferred TS-2 command', async () => {
    for (const command of DEFERRED_CLI_COMMANDS) {
      const { code, result } = await captureCli([command]);
      expect(code, command).toBe(3);
      expect(result.status, command).toBe('NOT_IMPLEMENTED');
      expect(result.exitCode, command).toBe(3);
      expect(result.launchAttempted, command).toBe(false);
      expect(
        result.diagnostics.map((entry) => entry.code),
        command,
      ).toContain('CLI_NOT_IMPLEMENTED');
    }
  });

  it('rejects an unknown command with a usage error', async () => {
    const { code, result } = await captureCli(['not-a-command']);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('CLI_USAGE_INVALID');
  });

  it('refuses cleanup of an unknown run without destructive action', async () => {
    const runId = uniqueRunId('vt-cli-cleanup');
    const { code, result } = await captureCli(['cleanup', '--run-id', runId]);
    expect(code).toBe(2);
    expect(result.status).toBe('HARNESS_BLOCKED');
    const details = result.details as { cleanup: { attempted: boolean; refusedReason: string } };
    expect(details.cleanup.attempted).toBe(false);
    expect(details.cleanup.refusedReason).toBe('OWNERSHIP_UNKNOWN');
  });

  it('exposes the stable wrapper command through the launcher binary', () => {
    const skillRoot = resolveSkillRoot();
    const repoRoot = path.resolve(skillRoot, '..', '..', '..');
    const output = execFileSync(
      process.execPath,
      [path.join(skillRoot, 'bin', 'verify-artwork.mjs'), 'validate', '--all'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const result = JSON.parse(output) as { status: string; command: string };
    expect(result.command).toBe('validate');
    expect(result.status).toBe('PASS');
  }, 120_000);
});
