import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSkillRoot, resolveToolkitRoot } from '../../src/runtime/paths';
import { captureCliResult, removeTestRunArtifacts } from './helpers';

const skillRoot = resolveSkillRoot();
const repoRoot = resolveToolkitRoot();
const ordinaryCase = path.join(
  repoRoot,
  'cases',
  'diagnostic',
  'requests',
  'layer-text-move-drag-ordinary.json',
);

describe('[TS-5] cold-agent current-source and evidence contract', () => {
  it('documents one discoverable CLI, prerequisites, ownership, outcomes, and readback', () => {
    const skill = readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const coldAgent = readFileSync(path.join(skillRoot, 'references', 'cold-agent.md'), 'utf8');

    expect(skill).toContain('pnpm verify:artwork --help');
    expect(skill).toContain('pnpm verify:artwork diagnostic --case');
    expect(skill).toContain('pnpm verify:artwork evidence verify --run');
    expect(skill).toContain('run-record.json');
    expect(skill).not.toContain('verify_artwork.py run');
    expect(skill).toContain('PASS`, `BUG`, `HARNESS_BLOCKED`, or `ENVIRONMENT_FAILURE`');
    expect(coldAgent).toContain('Node.js `>=20.11 <25`');
    expect(coldAgent).toContain('registry fingerprint');
    expect(coldAgent).toContain('historical or legacy record');
    expect(coldAgent).toContain('exact-id and fail-closed');
  });

  it('exposes the documented help envelope through the production pnpm wrapper', () => {
    const child = spawnSync('pnpm', ['--silent', 'verify:artwork', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(child.status).toBe(64);
    const jsonStart = child.stdout.indexOf('{');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const result = JSON.parse(child.stdout.slice(jsonStart)) as {
      schemaVersion: number;
      command: string;
      status: string;
      launchAttempted: boolean;
      detail: string;
    };

    expect(result.schemaVersion).toBe(2);
    expect(result.command).toBe('(help)');
    expect(result.status).toBe('USAGE');
    expect(result.launchAttempted).toBe(false);
    expect(result.detail).toContain('diagnostic');
  });

  it('keeps planning scope-qualified and launch-free for a cold-agent preflight', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'cold-agent-plan-'));
    try {
      const { code, result } = await captureCliResult<{
        status: string;
        launchAttempted: boolean;
        details: { launchAttempted: boolean; artifacts: string[] } | null;
      }>(['plan', '--case', ordinaryCase, '--out', outDir]);

      // The CLI itself owns the output directory; this assertion only proves no
      // browser/server launch is hidden inside the cold-agent preflight.
      expect(code).toBe(0);
      expect(result.status).toBe('PASS');
      expect(result.launchAttempted).toBe(false);
      expect(result.details?.launchAttempted).toBe(false);
      expect(result.details?.artifacts).toEqual(
        expect.arrayContaining(['plan.json', 'execution-plan.json', 'preflight-report.json']),
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('runs Diagnostic and independently verifies its durable record through pnpm', () => {
    const child = spawnSync(
      'pnpm',
      ['--silent', 'verify:artwork', 'diagnostic', '--case', ordinaryCase],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
    );
    expect(child.status).toBe(0);
    const jsonStart = child.stdout.indexOf('{');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const result = JSON.parse(child.stdout.slice(jsonStart)) as {
      status: string;
      outcome: string;
      details: {
        runId: string;
        source: { fingerprint: string; registryFingerprint: string };
        coverageStatus: string;
        cleanup: { complete: boolean };
        runRecordPath: string;
      };
    };

    expect(result.status).toBe('PASS');
    expect(result.outcome).toBe('PASS');
    expect(result.details.source.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details.source.registryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details.coverageStatus).toBeDefined();
    expect(result.details.cleanup.complete).toBe(true);
    expect(result.details.runRecordPath).toBe('run-record.json');

    try {
      const verification = spawnSync(
        'pnpm',
        ['--silent', 'verify:artwork', 'evidence', 'verify', '--run', result.details.runId],
        { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
      );
      expect(verification.status).toBe(0);
      const verifyStart = verification.stdout.indexOf('{');
      expect(verifyStart).toBeGreaterThanOrEqual(0);
      const report = JSON.parse(verification.stdout.slice(verifyStart)) as {
        status: string;
        details: { transaction: { immutable: boolean; strictRecordPresent: boolean } };
      };
      expect(report.status).toBe('PASS');
      expect(report.details.transaction.immutable).toBe(true);
      expect(report.details.transaction.strictRecordPresent).toBe(true);
    } finally {
      removeTestRunArtifacts(result.details.runId);
    }
  }, 90_000);
});
