import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { evidenceRootFor } from '../../src/allocation/lease';
import {
  compilePreparedExecutionCandidate,
  prepareDiagnosticRun,
  runDiagnosticCommand,
} from '../../src/cli/diagnostic';
import { DEFERRED_CLI_COMMANDS } from '../../src/contracts/discriminants';
import type { CaseRequest } from '../../src/contracts/case-model';
import type { PublicSuiteLineageV1 } from '../../src/contracts/suite';
import { readFinalSuiteRecordFile } from '../../src/evidence/final-suite-reader';
import {
  runFinalSuiteActivePath,
  type FinalSuiteAggregateContext,
  type FinalSuiteMemberInput,
} from '../../src/orchestration/final-active-path';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import { captureCliResult, occupyPort, removeTestRunArtifacts, uniqueRunId } from './helpers';

/**
 * `diagnostic --case` pre-launch contracts (TS-2/TS-5; WP5 Slice 5-A).
 *
 * The heavy real-browser proof lives in `tests/browser/tracer-text-move.browser.test.ts`.
 * These tests prove the fast terminal paths: the deferred-command contract no
 * longer contains `diagnostic`, an allocation fault is `ENVIRONMENT_FAILURE`
 * with `launchAttempted: false` and no owned leftovers, and an undelivered
 * adapter fails closed before any allocation.
 */

interface CapturedRun<T = Record<string, unknown>> {
  code: number;
  result: {
    schemaVersion: number;
    command: string;
    status: string;
    exitCode: number;
    launchAttempted: boolean;
    outcome: string | null;
    details: T | null;
    diagnostics: { code: string; severity: string }[];
  };
}

async function capture<T>(argv: string[]): Promise<CapturedRun<T>> {
  const { code, result } = await captureCliResult<CapturedRun<T>['result']>(argv);
  return { code, result };
}

function fixtureCasePath(): string {
  return path.join(
    resolveToolkitRoot(),
    'tests',
    'integration',
    'fixtures',
    'layer-text-move.request.json',
  );
}

function historyCasePath(): string {
  return path.join(
    resolveToolkitRoot(),
    'cases',
    'diagnostic',
    'requests',
    'artwork-editor-history-undo-redo.json',
  );
}

function restoreCasePath(): string {
  return path.join(
    resolveToolkitRoot(),
    'cases',
    'diagnostic',
    'requests',
    'artwork-editor-serialize-restore-mixed-raw.json',
  );
}

const created: string[] = [];
const createdDirs: string[] = [];

afterEach(() => {
  for (const runId of created.splice(0)) removeTestRunArtifacts(runId);
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('[TS-2] diagnostic command surface', () => {
  it('is no longer a deferred TS-2 command', () => {
    expect(DEFERRED_CLI_COMMANDS).not.toContain('diagnostic');
  });

  it('requires --case', async () => {
    const { code, result } = await capture(['diagnostic']);
    expect(code).toBe(64);
    expect(result.status).toBe('USAGE');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('CLI_USAGE_INVALID');
  });
});

describe('[TS-2] diagnostic allocation fault (occupied requested port)', () => {
  it('yields ENVIRONMENT_FAILURE with launchAttempted false, no browser, and complete cleanup', async () => {
    const occupied = await occupyPort();
    const runId = uniqueRunId('vt-diag-port');
    created.push(runId);
    try {
      const { code, result } = await capture<{
        allocation: unknown;
        launch: unknown;
        behaviorOutcome: string | null;
        cleanup: { attempted: boolean; complete: boolean; refusedReason: string | null };
        issues: readonly string[];
      }>([
        'diagnostic',
        '--case',
        fixtureCasePath(),
        '--run-id',
        runId,
        '--port',
        String(occupied.port),
      ]);

      expect(code).toBe(2);
      expect(result.status).toBe('ENVIRONMENT_FAILURE');
      expect(result.exitCode).toBe(2);
      // No launch was attempted: the port fault is decided before any browser.
      expect(result.launchAttempted).toBe(false);
      expect(result.details?.allocation).toBeNull();
      expect(result.details?.launch).toBeNull();
      expect(result.details?.behaviorOutcome).toBeNull();
      // Nothing was owned, so cleanup had nothing to destroy and refused exactly.
      expect(result.details?.cleanup.attempted).toBe(false);
      expect(result.details?.cleanup.refusedReason).toBe('OWNERSHIP_UNKNOWN');
      // The current external pre-authority refusal reports its structured issue
      // code and the runtime launch failure it was classified from.
      expect(result.details?.issues).toContain('EXTERNAL_PREAUTHORITY_FAILURE');
      expect(result.diagnostics.map((entry) => entry.code)).toContain('RUNTIME_LAUNCH_FAILED');
    } finally {
      await occupied.close();
    }
  });

  it('yields the same ENVIRONMENT_FAILURE for the cross-subject history request', async () => {
    const occupied = await occupyPort();
    const runId = uniqueRunId('vt-diag-hist-port');
    created.push(runId);
    try {
      const { code, result } = await capture<{
        allocation: unknown;
        launch: unknown;
        behaviorOutcome: string | null;
        cleanup: { attempted: boolean; complete: boolean; refusedReason: string | null };
        issues: readonly string[];
      }>([
        'diagnostic',
        '--case',
        historyCasePath(),
        '--run-id',
        runId,
        '--port',
        String(occupied.port),
      ]);

      expect(code).toBe(2);
      expect(result.status).toBe('ENVIRONMENT_FAILURE');
      expect(result.launchAttempted).toBe(false);
      expect(result.details?.behaviorOutcome).toBeNull();
      expect(result.details?.issues).toContain('EXTERNAL_PREAUTHORITY_FAILURE');
      expect(result.diagnostics.map((entry) => entry.code)).toContain('RUNTIME_LAUNCH_FAILED');
    } finally {
      await occupied.close();
    }
  });

  it('yields the same ENVIRONMENT_FAILURE for the frontend serialize/restore request', async () => {
    const occupied = await occupyPort();
    const runId = uniqueRunId('vt-diag-restore-port');
    created.push(runId);
    try {
      const { code, result } = await capture<{
        allocation: unknown;
        launch: unknown;
        behaviorOutcome: string | null;
        cleanup: { attempted: boolean; complete: boolean; refusedReason: string | null };
        issues: readonly string[];
      }>([
        'diagnostic',
        '--case',
        restoreCasePath(),
        '--run-id',
        runId,
        '--port',
        String(occupied.port),
      ]);

      expect(code).toBe(2);
      expect(result.status).toBe('ENVIRONMENT_FAILURE');
      expect(result.launchAttempted).toBe(false);
      expect(result.details?.launch).toBeNull();
      expect(result.details?.behaviorOutcome).toBeNull();
      expect(result.details?.issues).toContain('EXTERNAL_PREAUTHORITY_FAILURE');
      expect(result.diagnostics.map((entry) => entry.code)).toContain('RUNTIME_LAUNCH_FAILED');
    } finally {
      await occupied.close();
    }
  });
});

describe('[TS-2] diagnostic fails closed before launch on an unbindable request', () => {
  it('preserves the ordinary fixture diagnostic and strictly refuses its unprepared candidate', async () => {
    const request: CaseRequest = {
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
    };
    const runId = uniqueRunId('vt-diag-adapter');
    created.push(runId);
    const result = await runDiagnosticCommand({ request, runId });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(result.launchAttempted).toBe(false);
    expect(result.details?.allocation).toBeNull();
    expect(
      result.diagnostics.map((entry) => entry.code),
      `actual diagnostics: ${JSON.stringify(result.diagnostics)}`,
    ).toContain('FIXTURE_UNAVAILABLE');

    const compiled = compilePreparedExecutionCandidate(request);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.candidate.planning.envelope).toBeNull();
    const preparedRunId = uniqueRunId('vt-diag-unbound-prepared');
    created.push(preparedRunId);
    const preparedResult = await runDiagnosticCommand({
      preparedCandidate: compiled.candidate,
      runId: preparedRunId,
    });
    expect(preparedResult.status).toBe('HARNESS_BLOCKED');
    expect(preparedResult.launchAttempted).toBe(false);
    expect(preparedResult.details?.allocation).toBeNull();
    expect(preparedResult.diagnostics.map((entry) => entry.code)).toContain(
      'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    );
  });
});

describe('[TS-2] diagnostic fails closed on a malformed case file', () => {
  it('returns USAGE for an unreadable case request', async () => {
    const runId = uniqueRunId('vt-diag-usage');
    created.push(runId);
    const result = await runDiagnosticCommand({ casePath: '/nonexistent/case.json', runId });
    expect(result.status).toBe('USAGE');
    expect(result.launchAttempted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('CLI_USAGE_INVALID');
  });
});

describe('[ADR 0019 R11] prelaunch allocation fault lineage', () => {
  it('fabricates no child record and carries the closed suite lineage on the suite-v2 aggregate', async () => {
    const occupied = await occupyPort();
    const runId = uniqueRunId('vt-diag-lineage-port');
    const suiteRunId = `${runId}-suite`;
    const suiteRoot = mkdtempSync(path.join(os.tmpdir(), 'vt-diag-lineage-suite-'));
    created.push(runId, suiteRunId);
    createdDirs.push(suiteRoot);
    const suiteLineage: PublicSuiteLineageV1 = {
      suiteId: 'representative',
      suiteVersion: 1,
      executionId: 'representative-v1-lineage-probe',
      order: 1,
    };
    try {
      // 1. A suite-child allocation fault is decided before any record exists:
      //    the current path fabricates no durable child record.
      const rejected = await runDiagnosticCommand({
        casePath: fixtureCasePath(),
        runId,
        port: occupied.port,
        suiteLineage,
      });
      expect(rejected.status).toBe('ENVIRONMENT_FAILURE');
      expect(rejected.exitCode).toBe(2);
      expect(rejected.launchAttempted).toBe(false);
      expect(rejected.details?.runRecordPath).toBeNull();
      expect(rejected.details?.durable.required).toBe(false);
      expect(existsSync(path.join(evidenceRootFor(runId), 'run-record.json'))).toBe(false);

      // 2. The same refused child stays attributable through the suite-v2
      //    aggregate: the closed lineage is carried by the aggregate entry.
      const prepared = await prepareDiagnosticRun({
        casePath: fixtureCasePath(),
        runId: suiteRunId,
        port: occupied.port,
        suiteLineage,
      });
      if (!prepared.ok) {
        throw new Error(`suite child was refused before execution: ${prepared.detail}`);
      }
      const member: FinalSuiteMemberInput = {
        planning: prepared.facts.planning,
        prelaunch: prepared.facts.prelaunch,
        observation: prepared.facts.observation,
        runId: prepared.facts.runId,
        cleanupSucceeded: prepared.facts.cleanupSucceeded,
        externalFailure: prepared.facts.externalFailure,
        operational: prepared.facts.operational,
        durable: prepared.facts.durable,
        order: suiteLineage.order,
        caseId: prepared.facts.planning.caseId,
        requestPath: 'tests/integration/fixtures/layer-text-move.request.json',
        expectedOutcome: 'PASS',
      };
      const aggregate: FinalSuiteAggregateContext = {
        suiteExecutionId: 'representative-v1-lineage-suite',
        suiteLineageId: 'representative@v1#representative-v1-lineage-suite',
        suiteFingerprint: 'a'.repeat(64),
        repository: { commit: null, dirty: null, lockfileDigest: 'vt-lineage-lockfile' },
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1_000,
        recordedAt: '2026-01-01T00:00:01.000Z',
      };
      const outcome = runFinalSuiteActivePath({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 1,
        members: [member],
        aggregate,
        suiteDurable: { evidenceRoot: suiteRoot, forbiddenPaths: [os.tmpdir()] },
      });
      const aggregatePath = outcome.suite.durable.path;
      if (aggregatePath === null) {
        throw new Error(
          `suite aggregate was not written: ${outcome.suite.durable.error ?? 'unknown'}`,
        );
      }
      const read = readFinalSuiteRecordFile(aggregatePath);
      expect(read.kind).toBe('suite-v2');
      expect(read.current).toBe(true);
      expect(read.legacy).toBe(false);
      if (read.kind !== 'suite-v2') {
        throw new Error(`suite aggregate did not read back as current suite-v2: ${read.kind}`);
      }
      const child = read.record.children[0];
      expect(child).toMatchObject({
        order: 1,
        runId: member.runId,
        executionId: `${aggregate.suiteExecutionId}#1`,
        parentSuiteExecutionId: aggregate.suiteExecutionId,
        suiteLineageId: aggregate.suiteLineageId,
        childRecordLabel: 'no-record-refusal',
        recordPresent: false,
        childRecordSchemaVersion: null,
        behaviorOutcome: null,
        finalOutcome: 'ENVIRONMENT_FAILURE',
        expectedOutcome: 'PASS',
      });
      // The child execution identity is independent from its own run id.
      expect(child?.executionId).not.toBe(child?.runId);
    } finally {
      await occupied.close();
    }
  });
});
