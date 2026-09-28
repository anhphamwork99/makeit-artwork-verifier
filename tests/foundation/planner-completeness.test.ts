import { describe, expect, it, vi } from 'vitest';

/**
 * Proves the planner wires `validateCoverageCompleteness` into P4 before it
 * emits any output. The account module is mocked so the planner derives a
 * malformed record; a malformed or unqualified completeness record must block
 * the attempt instead of being emitted.
 */
vi.mock('../../src/coverage/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/coverage/account')>();
  return {
    ...actual,
    deriveCoverageCompleteness: () => [
      { dimension: 'binding-model', status: 'complete', qualification: '   ' },
    ],
  } as unknown as typeof actual;
});

import { planCase } from '../../src/planner/plan-case';
import type { PlanResult } from '../../src/contracts/case-model';
import { releaseRequest } from './helpers';

function expectBlocked(result: PlanResult, code: string): void {
  expect(result.status).toBe('HARNESS_BLOCKED');
  if (result.status === 'HARNESS_BLOCKED') {
    expect(result.code).toBe(code);
    expect(result.diagnostic.severity).toBe('blocking');
    expect(result.report.stages.find((stage) => stage.outcome === 'rejected')?.stageId).toBe('P4');
  }
  expect(result.launchAttempted).toBe(false);
  expect('plan' in result).toBe(false);
  expect('outputs' in result).toBe(false);
}

describe('[Coverage] P4 completeness enforcement (TS-1)', () => {
  it('blocks a malformed/unqualified completeness record before emitting outputs', () => {
    expectBlocked(planCase(releaseRequest()), 'COVERAGE_UNQUALIFIED_COMPLETENESS');
  });
});
