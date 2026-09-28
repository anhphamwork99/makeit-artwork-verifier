import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { crosswordRecordFacts } from '../../src/cli/diagnostic';
import type { DiagnosticCode } from '../../src/contracts/diagnostics';
import { DIAGNOSTIC_SEVERITY } from '../../src/contracts/diagnostics';
import {
  CASE_PROVENANCES,
  isCaseProvenance,
  type CaseProvenance,
} from '../../src/contracts/discriminants';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  type HistoryActionStep,
} from '../../src/contracts/history-observation';
import type { HistoryActionStep as BarrelHistoryActionStep } from '../../src/index';
import type { ExecutePlanBehavior } from '../../src/runtime/execute-plan';

/**
 * P7-B B0 static-baseline regressions (ADR 0027 §1.5, §3.2 B-R1).
 *
 * Focused proof for the two B0 corrections that are otherwise only reachable
 * through a full owned-runtime drive: the single captured Crossword drive report
 * (a null report fabricates no record facts) and the authoritative ownership of
 * the contract types the reconciliation record binds.
 */

type CrosswordDrive = NonNullable<ExecutePlanBehavior['crossword']>;

function driveReport(overrides: Partial<CrosswordDrive> = {}): CrosswordDrive {
  return {
    schemaVersion: 1,
    outcome: 'HARNESS_BLOCKED',
    requiredChecks: [],
    harnessInvalid: true,
    diagnostics: [],
    evaluation: null,
    children: [],
    readiness: {
      profileId: 'crossword-generation-action-cycle-v1',
      timingCategory: 'RESOURCE_RENDER_V1',
      deadlineMs: 8_000,
      wakeSource: 'none',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      stableFrames: 3,
      observedStableFrames: 0,
      idle: null,
      timings: {},
    },
    detail: 'no Crossword drive ran',
    ...overrides,
  };
}

function childReport(observationId: string | null): CrosswordDrive['children'][number] {
  return {
    executionRole: 'A1',
    outcome: 'HARNESS_BLOCKED',
    evidence: null,
    observationId,
    tornRecaptureCount: 0,
    contextClosed: false,
    idle: null,
    detail: 'no child drive ran',
    diagnostics: [],
  };
}

describe('B0 nullable Crossword drive report (ADR 0027 §3.2 B-R1)', () => {
  it('fabricates nothing for a null or absent report', () => {
    for (const report of [null, undefined]) {
      const facts = crosswordRecordFacts(report);
      expect(facts).toEqual({
        bound: false,
        observedStableFrames: null,
        idle: null,
        firstChildObservationId: null,
      });
    }
  });

  it('reads the bound report once: generation, idle credit, and the first child id', () => {
    const unbound = crosswordRecordFacts(driveReport());
    expect(unbound.bound).toBe(true);
    // A bound drive with no accepted evaluation still fabricates no projection.
    expect(unbound.observedStableFrames).toBe(0);
    // No idle was reached, so no idle credit exists and none is invented.
    expect(unbound.idle).toBeNull();
    expect(unbound.firstChildObservationId).toBeNull();

    const bound = crosswordRecordFacts(
      driveReport({
        children: [childReport('obs-a1'), childReport('obs-a2')],
        readiness: {
          ...driveReport().readiness,
          observedStableFrames: 3,
          idle: { targetCount: 1, stableFrames: 3, waitedMs: 120, observationRevision: 9 },
        },
      }),
    );
    expect(bound.firstChildObservationId).toBe('obs-a1');
    expect(bound.observedStableFrames).toBe(3);
    expect(bound.idle).toEqual({
      targetCount: 1,
      stableFrames: 3,
      waitedMs: 120,
      observationRevision: 9,
    });
  });

  it('does not throw while reading a partially populated report', () => {
    const partial = driveReport({ children: [childReport(null)] });
    expect(() => crosswordRecordFacts(partial)).not.toThrow();
    expect(crosswordRecordFacts(partial).firstChildObservationId).toBeNull();
  });
});

describe('B0 contract type ownership (ADR 0027 §1.5)', () => {
  const skillRoot = path.resolve(process.cwd());

  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  it('imports DiagnosticCode from its authoritative diagnostics module', () => {
    const caseModel = source('src/contracts/case-model.ts');
    expect(caseModel).toContain("from './diagnostics'");
    const discriminantsImport = /import type \{([^}]*)\} from '\.\/discriminants';/.exec(caseModel);
    expect(discriminantsImport).not.toBeNull();
    expect(discriminantsImport?.[1]).not.toContain('DiagnosticCode');
    const code: DiagnosticCode = 'RUN_OWNERSHIP_RECORD_INVALID';
    expect(DIAGNOSTIC_SEVERITY[code]).toBe('blocking');
  });

  it('imports CaseProvenance from the discriminants module, not through case-model', () => {
    const resolveSource = source('src/coverage/resolve.ts');
    expect(resolveSource).toContain('CaseProvenance');
    expect(resolveSource).toContain("from '../contracts/discriminants'");
    const caseModelImport = /import type \{([^}]*)\} from '\.\.\/contracts\/case-model';/.exec(
      resolveSource,
    );
    expect(caseModelImport).not.toBeNull();
    expect(caseModelImport?.[1]).not.toContain('CaseProvenance');
    const provenance: CaseProvenance = CASE_PROVENANCES[0];
    expect(isCaseProvenance(provenance)).toBe(true);
  });

  it('defines and exports HistoryActionStep from the history-observation contract', () => {
    const observation = source('src/contracts/history-observation.ts');
    const definitionIndex = observation.indexOf('export interface HistoryActionStep {');
    const stepsIndex = observation.indexOf('export const HISTORY_ACTION_STEPS');
    expect(definitionIndex).toBeGreaterThan(-1);
    expect(stepsIndex).toBeGreaterThan(definitionIndex);
    expect(observation).toContain('] as const satisfies readonly HistoryActionStep[]');
    // The barrel re-export is the type the public surface publishes.
    const fromContract: HistoryActionStep = HISTORY_ACTION_STEPS[0];
    const fromBarrel: BarrelHistoryActionStep = fromContract;
    expect(fromBarrel.control).toBe('undo');
  });

  it('publishes the exact six-step history contract through the defined type', () => {
    const steps: readonly HistoryActionStep[] = HISTORY_ACTION_STEPS;
    expect(steps).toHaveLength(6);
    steps.forEach((step, index) => {
      expect(step.stepIndex).toBe(index);
      expect(Object.keys(HISTORY_CONTROLS)).toContain(step.control);
      expect(typeof step.stepId).toBe('string');
      expect(Number.isInteger(step.expectedHistory.pastDepth)).toBe(true);
      expect(Number.isInteger(step.expectedHistory.futureDepth)).toBe(true);
      expect(typeof step.expectedHistory.baselineClean).toBe('boolean');
      expect(step.expectedMeaning).toMatch(/^M[0-3]$/);
    });
  });
});
