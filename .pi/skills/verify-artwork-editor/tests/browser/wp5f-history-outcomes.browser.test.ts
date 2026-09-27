import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EnvironmentCell, RunAllocation } from '../../src/contracts/runtime';
import type { BindingFixture } from '../../src/contracts/fixtures';
import {
  HISTORY_ACTION_STEPS,
  type HistoryActionStep,
} from '../../src/contracts/history-observation';
import { allocateRun } from '../../src/allocation/allocate';
import { admitCase, releaseCase } from '../../src/allocation/lease';
import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import { cleanupRun } from '../../src/cleanup/cleanup';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { launchOwnedServer } from '../../src/runtime/launch';
import { generateRunId } from '../../src/runtime/run-id';
import { executeHistoryPlan } from '../../src/runtime/execute-history-plan';
import type { FinalExecutionObservation } from '../../src/runtime/execute-plan';
import { resolveSkillRoot } from '../../src/runtime/paths';
import type { MaterializedExecutionEnvelopeV1 } from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { historyEvidenceViolations } from '../../src/evidence/public-dto';

/**
 * WP5 Slice 5-F — real-browser history outcome classification (ADR 0019 C9).
 *
 * One owned server/browser allocation drives the cross-subject history runtime
 * three times with fresh documents: the accepted PASS, a safely dispatched
 * wrong-expectation BUG, and a pre-dispatch disabled-control HARNESS_BLOCKED.
 * The runtime is driven directly so the two non-PASS outcomes can inject the
 * test-only expectation/control seam without changing product behaviour. The
 * PASS public v3 evidence is produced by the diagnostic CLI (not here).
 */

const RUN_ID = generateRunId();
const CASE_ID = 'wp5f-history-outcomes';
const HISTORY_REQUEST_RELATIVE = path.join(
  'cases',
  'diagnostic',
  'requests',
  'artwork-editor-history-undo-redo.json',
);

let allocation: RunAllocation | null = null;
let environment: EnvironmentCell | null = null;
let fixture: BindingFixture | null = null;
/** The exact compile-once planning envelope shared by every executor input. */
let envelope: MaterializedExecutionEnvelopeV1 | null = null;

const evidence: Record<string, unknown> = {};

/**
 * Compiles the exact `MaterializedExecutionEnvelopeV1` for the canonical
 * history request exactly once (ADR 0033 §1/§3). Every `executeHistoryPlan`
 * input below carries this same object by reference; the executor never
 * recompiles, looks up, or reconstructs a profile.
 */
function compileHistoryEnvelope(bundle: CatalogueBundle): MaterializedExecutionEnvelopeV1 {
  const request = JSON.parse(
    readFileSync(path.join(resolveSkillRoot(), HISTORY_REQUEST_RELATIVE), 'utf8'),
  ) as unknown;
  const planning = planCaseForExecution(request, { catalogues: bundle });
  if (planning.status !== 'PLANNED') {
    throw new Error(`the canonical history request did not plan: ${planning.status}`);
  }
  if (planning.envelope === null) {
    throw new Error('the canonical history request produced no materialized envelope');
  }
  if (planning.envelope.correctnessProfile.oracle.evaluatorKind !== 'history-cross-subject') {
    throw new Error(
      `the canonical history request compiled the wrong evaluator "${planning.envelope.correctnessProfile.oracle.evaluatorKind}"`,
    );
  }
  return planning.envelope;
}

function activeEnvelope(): MaterializedExecutionEnvelopeV1 {
  if (!envelope) throw new Error('the compile-once history envelope is not ready');
  return envelope;
}

/**
 * Asserts the exact-envelope executor handoff: the executor returned a non-null
 * observation carrying this exact envelope by reference and an Action Cycle
 * identity whose profile/readiness fingerprints were derived only from it.
 */
function expectEnvelopeBoundObservation(
  observation: FinalExecutionObservation | null,
): FinalExecutionObservation {
  expect(observation).not.toBeNull();
  if (observation === null) throw new Error('the history executor produced no final observation');
  expect(observation.envelope).toBe(activeEnvelope());
  expect(observation.actionCycle.resolvedProfileFingerprint).toBe(
    activeEnvelope().correctnessProfile.resolvedFingerprint,
  );
  expect(observation.actionCycle.readinessFingerprint).toBe(
    activeEnvelope().correctnessProfile.componentFingerprints.readiness,
  );
  return observation;
}

/** Narrows the atomic handoff to the current `history-cross-subject` payload. */
function historyPayload(observation: FinalExecutionObservation) {
  const payload = observation.payload;
  expect(payload.evaluatorKind).toBe('history-cross-subject');
  if (payload.evaluatorKind !== 'history-cross-subject') {
    throw new Error('the history executor produced a non-history final payload');
  }
  return payload;
}

function baseInput(overrides: { stepsOverride?: readonly HistoryActionStep[] }) {
  if (!allocation || !environment || !fixture || !envelope) {
    throw new Error('owned run is not ready');
  }
  return {
    allocation,
    caseId: CASE_ID,
    intent: {} as never,
    plan: { requiredChecks: ['history.depth', 'history.meaning'] } as never,
    adapter: {} as never,
    fixture,
    workflowSteps: [],
    environment,
    envelope,
    ...overrides,
  };
}

beforeAll(async () => {
  const allocationResult = await allocateRun({ runId: RUN_ID });
  if (!allocationResult.ok) throw new Error(`allocation failed: ${allocationResult.detail}`);
  allocation = allocationResult.allocation;
  mkdirSync(allocation.evidenceRoot, { recursive: true });
  evidence.runId = RUN_ID;

  const admission = admitCase(RUN_ID, CASE_ID);
  if (!admission.ok) throw new Error(`admission failed: ${admission.detail}`);

  // Static planning is launch-independent: compile the exact envelope before the
  // owned server starts so a planning refusal never leaves a launched run.
  const bundle = loadCatalogueBundle();
  fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
    subjectId: 'artwork/editor',
    capability: 'history',
    scenarioId: 'undo-redo-text',
  });
  if (fixture === null) throw new Error('the history fixture is not delivered');
  envelope = compileHistoryEnvelope(bundle);

  const launch = await launchOwnedServer({ allocation, readinessDeadlineMs: 300_000 });
  if (!launch.ok) throw new Error(`owned launch failed: ${launch.detail}`);

  environment = resolveEnvironmentCell(loadEnvironmentCatalogue(), allocation.environmentCellId);
}, 360_000);

afterAll(async () => {
  try {
    if (allocation) {
      writeFileSync(
        path.join(allocation.evidenceRoot, 'wp5f-history-outcomes.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      );
    }
  } finally {
    releaseCase(RUN_ID);
    await cleanupRun(RUN_ID);
  }
}, 300_000);

describe('[WP5 Slice 5-F] real history outcome classification', () => {
  it('classifies a real six-transition run as PASS with a valid closed projection', async () => {
    const result = await executeHistoryPlan(baseInput({}));
    const observation = expectEnvelopeBoundObservation(result.finalObservation);
    const payload = historyPayload(observation);
    evidence.pass = {
      outcome: result.history.outcome,
      harnessInvalid: result.history.harnessInvalid,
      requiredChecks: result.history.requiredChecks,
      detail: result.history.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
      actionCycleId: observation.actionCycle.actionCycleId,
      observationId: observation.observationId,
    };
    expect(result.history.outcome).toBe('PASS');
    expect(result.history.harnessInvalid).toBe(false);
    expect(result.history.projection).not.toBeNull();
    expect(
      historyEvidenceViolations(result.history.projection as unknown as Record<string, unknown>),
    ).toEqual([]);
    expect(result.history.requiredChecks).toEqual([
      { checkId: 'history.depth', passed: true },
      { checkId: 'history.meaning', passed: true },
    ]);
    expect(payload.projection).not.toBeNull();
    expect(payload.projection?.family).toBe('history');
    expect(payload.projection?.actionCycleRef).toBe(observation.actionCycle.actionCycleId);
    expect(payload.oracle?.primitiveFacts.authority).toBe('current');
    expect(observation.observationId).not.toBeNull();
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);

  it('classifies a safely dispatched wrong-expectation transition as BUG', async () => {
    const wrong = HISTORY_ACTION_STEPS.map((step) => ({
      ...step,
      expectedHistory: { pastDepth: 0, futureDepth: 0, baselineClean: true },
    })) as unknown as HistoryActionStep[];
    const result = await executeHistoryPlan(baseInput({ stepsOverride: wrong }));
    const observation = expectEnvelopeBoundObservation(result.finalObservation);
    const payload = historyPayload(observation);
    evidence.bug = {
      outcome: result.history.outcome,
      harnessInvalid: result.history.harnessInvalid,
      requiredChecks: result.history.requiredChecks,
      diagnostics: result.history.diagnostics.map((entry) => entry.code),
      detail: result.history.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
      actionCycleId: observation.actionCycle.actionCycleId,
    };
    expect(result.history.outcome).toBe('BUG');
    expect(result.history.harnessInvalid).toBe(false);
    expect(
      result.history.requiredChecks.find((check) => check.checkId === 'history.depth')?.passed,
    ).toBe(false);
    // The v4 family payload keeps the completed six-transition chain even though
    // the legacy public report drops its projection on a BUG.
    expect(payload.projection).not.toBeNull();
    expect(payload.projection?.family).toBe('history');
    expect(payload.projection?.actionCycleRef).toBe(observation.actionCycle.actionCycleId);
    expect(payload.oracle?.primitiveFacts.authority).toBe('current');
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);

  it('classifies a disabled required control before dispatch as HARNESS_BLOCKED', async () => {
    // A Redo first: at the exact H3 tuple the native Redo control is disabled,
    // so the drive must block before any click.
    const redoFirst = [HISTORY_ACTION_STEPS[3] as HistoryActionStep];
    const result = await executeHistoryPlan(baseInput({ stepsOverride: redoFirst }));
    const observation = expectEnvelopeBoundObservation(result.finalObservation);
    const payload = historyPayload(observation);
    evidence.harnessBlocked = {
      outcome: result.history.outcome,
      harnessInvalid: result.history.harnessInvalid,
      diagnostics: result.history.diagnostics.map((entry) => entry.code),
      detail: result.history.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
    };
    expect(result.history.outcome).toBe('HARNESS_BLOCKED');
    expect(result.history.harnessInvalid).toBe(true);
    expect(result.history.diagnostics.map((entry) => entry.code)).toContain(
      'HISTORY_CONTROL_DISABLED',
    );
    // The blocked drive never ran the Oracle, so the family handoff is an
    // explicit malformed/absent primitive view rather than a product claim.
    expect(payload.projection).toBeNull();
    expect(payload.oracle).toBeNull();
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);
});
