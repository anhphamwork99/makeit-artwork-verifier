import { existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evidenceRootFor } from '../../src/allocation/lease';
import { runCli } from '../../src/cli/main';

function captureCliResult(argv: readonly string[]) {
  const chunks: string[] = [];
  return runCli(argv, { stdout: (chunk) => chunks.push(chunk) }).then((exitCode) => {
    expect(chunks).toHaveLength(1);
    return { exitCode, result: JSON.parse(chunks[0] as string) as Record<string, unknown> };
  });
}

describe('[Correctness profile] public command and result foundation', () => {
  it('makes Diagnostic, Qualification, and deferred Release profiles discoverable', async () => {
    const { result } = await captureCliResult(['--help']);
    expect(String(result.detail)).toContain('diagnostic — required current-source correctness');
    expect(String(result.detail)).toContain('qualify — optional reproducibility, non-creditable');
    expect(String(result.detail)).toContain('release — deferred Release Credit');
  });

  it.each([
    ['--profile', 'release'],
    ['--release-credit'],
  ] as const)('refuses Release-only flags before planning or side effects (%s)', async (...releaseFlag) => {
    const casePath = path.join(os.tmpdir(), `makeit-profile-case-${Date.now()}.json`);
    const outputDir = path.join(os.tmpdir(), `makeit-profile-flag-${Date.now()}`);
    writeFileSync(casePath, '{}\n', 'utf8');
    try {
      const { exitCode, result } = await captureCliResult([
        'plan',
        '--case',
        casePath,
        '--out',
        outputDir,
        ...releaseFlag,
      ]);

      expect(exitCode).toBe(64);
      expect(result).toMatchObject({
        command: 'plan',
        status: 'USAGE',
        launchAttempted: false,
      });
      expect(String(result.detail)).toMatch(/unsupported|Release/i);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(casePath, { force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('refuses a deferred Release profile on Diagnostic before reading or allocating', async () => {
    const runId = `correctness-release-refusal-${Date.now()}`;
    const missingCasePath = path.join(os.tmpdir(), 'missing-release-case.json');
    const { exitCode, result } = await captureCliResult([
      'diagnostic',
      '--case',
      missingCasePath,
      '--run-id',
      runId,
      '--profile',
      'release',
    ]);

    expect(exitCode).toBe(64);
    expect(result).toMatchObject({
      command: 'diagnostic',
      status: 'USAGE',
      launchAttempted: false,
      outcome: null,
    });
    expect(existsSync(evidenceRootFor(runId))).toBe(false);
  });

  it('returns a scope-qualified Diagnostic envelope without private path leakage on refusal', async () => {
    const casePath = path.join(os.tmpdir(), 'private-correctness-case.json');
    rmSync(casePath, { force: true });
    const { result } = await captureCliResult(['diagnostic', '--case', casePath]);
    const details = result.details as Record<string, unknown>;

    expect(result).toMatchObject({
      command: 'diagnostic',
      status: 'USAGE',
      launchAttempted: false,
      outcome: null,
    });
    expect(details).toMatchObject({
      profile: 'diagnostic',
      coverageStatus: null,
      candidate: null,
      source: null,
      environmentCellId: null,
      scope: {
        subjectId: null,
        capability: null,
        scenario: null,
        variant: null,
      },
      evidence: {
        references: [],
        runRecord: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain(casePath);
  });

  it('keeps the planned candidate and subject scope on a deterministic harness refusal', async () => {
    const casePath = path.join(os.tmpdir(), 'unbound-correctness-case.json');
    writeFileSync(
      casePath,
      `${JSON.stringify({
        schemaVersion: 1,
        profile: 'diagnostic',
        provenance: 'diagnostic-request',
        evidenceDepth: 'deep',
        intent: {
          subjectId: 'container/layout',
          capability: 'move',
          variant: null,
          scenario: 'drag-ordinary',
          preState: {},
          operations: [{ discriminant: 'move.by', parameters: { dx: 10, dy: 10 } }],
          expected: { minimumDelta: { x: 5, y: 5 } },
          resources: [],
        },
      })}\n`,
      'utf8',
    );
    try {
      const { result } = await captureCliResult(['diagnostic', '--case', casePath]);
      const details = result.details as Record<string, unknown>;
      expect(result).toMatchObject({
        status: 'HARNESS_BLOCKED',
        launchAttempted: false,
        outcome: null,
      });
      expect(details).toMatchObject({
        profile: 'diagnostic',
        coverageStatus: expect.any(String),
        candidate: {
          caseId: expect.any(String),
          materializationFingerprint: expect.any(String),
          planFingerprint: expect.any(String),
        },
        source: {
          fingerprint: expect.any(String),
          applicationInventoryFingerprint: expect.any(String),
        },
        scope: {
          subjectId: 'container/layout',
          capability: 'move',
          scenario: 'drag-ordinary',
          variant: null,
        },
        evidence: { references: [], runRecord: null },
      });
    } finally {
      rmSync(casePath, { force: true });
    }
  }, 30_000);
});
