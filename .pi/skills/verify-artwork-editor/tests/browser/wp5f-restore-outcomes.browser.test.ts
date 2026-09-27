import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EnvironmentCell, RunAllocation } from '../../src/contracts/runtime';
import type { BindingFixture } from '../../src/contracts/fixtures';
import { allocateRun } from '../../src/allocation/allocate';
import { admitCase, releaseCase } from '../../src/allocation/lease';
import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import { cleanupRun } from '../../src/cleanup/cleanup';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { launchOwnedServer } from '../../src/runtime/launch';
import { generateRunId } from '../../src/runtime/run-id';
import {
  executeRestorePlan,
  type ExecuteRestorePlanInput,
} from '../../src/runtime/execute-restore-plan';
import type { FinalExecutionObservation } from '../../src/runtime/execute-plan';
import { resolveSkillRoot } from '../../src/runtime/paths';
import type { MaterializedExecutionEnvelopeV1 } from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { restoreEvidenceViolations } from '../../src/evidence/public-dto';

/**
 * WP5 Slice 5-F — real-browser frontend serialize/restore outcome classification
 * (ADR 0019 C5–C9; ADR 0021 N7).
 *
 * One owned server/allocation drives the real seller Save → exact POST →
 * redirect → explicit navigate → exact GET → real restore chain. The accepted
 * PASS is proven for both declared scenarios (single-Text and mixed
 * Text/Image/Crossword); a deterministic response mutation is a BUG, a
 * malformed response is a HARNESS_BLOCKED authority failure, and a disabled
 * required Save control blocks before dispatch. `ENVIRONMENT_FAILURE` is proven
 * by the occupied-port allocation integration proof.
 */

const RUN_ID = generateRunId();
const CASE_ID = 'wp5f-restore-outcomes';
const NORMALIZED_REQUEST_RELATIVE = path.join(
  'cases',
  'diagnostic',
  'requests',
  'artwork-editor-serialize-restore-normalized.json',
);
const MIXED_REQUEST_RELATIVE = path.join(
  'cases',
  'diagnostic',
  'requests',
  'artwork-editor-serialize-restore-mixed-raw.json',
);

let allocation: RunAllocation | null = null;
let environment: EnvironmentCell | null = null;
let normalizedFixture: BindingFixture | null = null;
let mixedFixture: BindingFixture | null = null;
/** The exact compile-once planning envelopes, one per declared scenario. */
let normalizedEnvelope: MaterializedExecutionEnvelopeV1 | null = null;
let mixedEnvelope: MaterializedExecutionEnvelopeV1 | null = null;

const evidence: Record<string, unknown> = {};

/**
 * Compiles the exact `MaterializedExecutionEnvelopeV1` for one canonical
 * restore request exactly once (ADR 0033 §1/§3). Every `executeRestorePlan`
 * input below carries the matching envelope object by reference; the executor
 * never recompiles, looks up, or reconstructs a profile.
 */
function compileRestoreEnvelope(
  bundle: CatalogueBundle,
  relativePath: string,
): MaterializedExecutionEnvelopeV1 {
  const request = JSON.parse(
    readFileSync(path.join(resolveSkillRoot(), relativePath), 'utf8'),
  ) as unknown;
  const planning = planCaseForExecution(request, { catalogues: bundle });
  if (planning.status !== 'PLANNED') {
    throw new Error(`the canonical restore request did not plan: ${planning.status}`);
  }
  if (planning.envelope === null) {
    throw new Error('the canonical restore request produced no materialized envelope');
  }
  if (planning.envelope.correctnessProfile.oracle.evaluatorKind !== 'frontend-restore') {
    throw new Error(
      `the canonical restore request compiled the wrong evaluator "${planning.envelope.correctnessProfile.oracle.evaluatorKind}"`,
    );
  }
  return planning.envelope;
}

/** The exact compile-once envelope for the fixture's declared scenario. */
function envelopeForFixture(fixture: BindingFixture): MaterializedExecutionEnvelopeV1 {
  const target =
    fixture.scenarioId === 'serialize-raw-semantic' ? mixedEnvelope : normalizedEnvelope;
  if (!target) throw new Error('the compile-once restore envelope is not ready');
  return target;
}

/**
 * Asserts the exact-envelope executor handoff: the executor returned a non-null
 * observation carrying the matching envelope by reference and an Action Cycle
 * identity whose profile/readiness fingerprints were derived only from it.
 */
function expectEnvelopeBoundObservation(
  observation: FinalExecutionObservation | null,
  expected: MaterializedExecutionEnvelopeV1,
): FinalExecutionObservation {
  expect(observation).not.toBeNull();
  if (observation === null) throw new Error('the restore executor produced no final observation');
  expect(observation.envelope).toBe(expected);
  expect(observation.actionCycle.resolvedProfileFingerprint).toBe(
    expected.correctnessProfile.resolvedFingerprint,
  );
  expect(observation.actionCycle.readinessFingerprint).toBe(
    expected.correctnessProfile.componentFingerprints.readiness,
  );
  return observation;
}

/** Narrows the atomic handoff to the current `frontend-restore` payload. */
function restorePayload(observation: FinalExecutionObservation) {
  const payload = observation.payload;
  expect(payload.evaluatorKind).toBe('frontend-restore');
  if (payload.evaluatorKind !== 'frontend-restore') {
    throw new Error('the restore executor produced a non-restore final payload');
  }
  return payload;
}

function baseInput(fixture: BindingFixture, failureMode?: ExecuteRestorePlanInput['failureMode']) {
  if (!allocation || !environment) throw new Error('owned run is not ready');
  return {
    allocation,
    caseId: CASE_ID,
    intent: {} as never,
    plan: { requiredChecks: ['serialize.roundtrip', 'serialize.raw-semantic'] } as never,
    adapter: {} as never,
    fixture,
    workflowSteps: [],
    environment,
    envelope: envelopeForFixture(fixture),
    ...(failureMode === undefined ? {} : { failureMode }),
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

  // Static planning is launch-independent: compile both exact envelopes before
  // the owned server starts so a planning refusal never leaves a launched run.
  const bundle = loadCatalogueBundle();
  normalizedFixture = resolveBindingFixture(bundle.fixtureCatalogue, {
    subjectId: 'artwork/editor',
    capability: 'frontendSerializeRestore',
    scenarioId: 'serialize-roundtrip',
  });
  mixedFixture = resolveBindingFixture(bundle.fixtureCatalogue, {
    subjectId: 'artwork/editor',
    capability: 'frontendSerializeRestore',
    scenarioId: 'serialize-raw-semantic',
  });
  if (normalizedFixture === null || mixedFixture === null) {
    throw new Error('a restore fixture is not delivered');
  }
  normalizedEnvelope = compileRestoreEnvelope(bundle, NORMALIZED_REQUEST_RELATIVE);
  mixedEnvelope = compileRestoreEnvelope(bundle, MIXED_REQUEST_RELATIVE);

  const launch = await launchOwnedServer({ allocation, readinessDeadlineMs: 300_000 });
  if (!launch.ok) throw new Error(`owned launch failed: ${launch.detail}`);

  environment = resolveEnvironmentCell(loadEnvironmentCatalogue(), allocation.environmentCellId);
}, 360_000);

afterAll(async () => {
  try {
    if (allocation) {
      writeFileSync(
        path.join(allocation.evidenceRoot, 'wp5f-restore-outcomes.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      );
    }
  } finally {
    releaseCase(RUN_ID);
    await cleanupRun(RUN_ID);
  }
}, 300_000);

describe('[WP5 Slice 5-F] real frontend serialize/restore outcomes', () => {
  it('classifies the single-Text normalized round trip as PASS with a valid closed projection', async () => {
    const result = await executeRestorePlan(baseInput(normalizedFixture as BindingFixture));
    const fixture = normalizedFixture as BindingFixture;
    const observation = expectEnvelopeBoundObservation(
      result.finalObservation,
      envelopeForFixture(fixture),
    );
    const payload = restorePayload(observation);
    evidence.normalizedPass = {
      outcome: result.restore.outcome,
      harnessInvalid: result.restore.harnessInvalid,
      requiredChecks: result.restore.requiredChecks,
      diagnostics: result.restore.diagnostics.map((entry) => entry.code),
      detail: result.restore.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
      scenarioId: payload.projection?.scenarioId ?? null,
      actionCycleId: observation.actionCycle.actionCycleId,
      observationId: observation.observationId,
    };
    expect(result.restore.outcome).toBe('PASS');
    expect(result.restore.harnessInvalid).toBe(false);
    expect(result.restore.projection).not.toBeNull();
    expect(
      restoreEvidenceViolations(result.restore.projection as unknown as Record<string, unknown>),
    ).toEqual([]);
    expect(result.restore.requiredChecks).toEqual([
      { checkId: 'serialize.raw-semantic', passed: true },
      { checkId: 'serialize.roundtrip', passed: true },
    ]);
    expect(payload.projection).not.toBeNull();
    expect(payload.projection?.family).toBe('restore');
    expect(payload.projection?.scenarioId).toBe('serialize-roundtrip');
    expect(payload.projection?.actionCycleRef).toBe(observation.actionCycle.actionCycleId);
    expect(payload.oracle?.primitiveFacts.authority).toBe('current');
    expect(observation.observationId).not.toBeNull();
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);

  it('classifies the mixed Text/Image/Crossword raw-semantic round trip as PASS', async () => {
    const result = await executeRestorePlan(baseInput(mixedFixture as BindingFixture));
    const fixture = mixedFixture as BindingFixture;
    const observation = expectEnvelopeBoundObservation(
      result.finalObservation,
      envelopeForFixture(fixture),
    );
    const payload = restorePayload(observation);
    evidence.mixedPass = {
      outcome: result.restore.outcome,
      harnessInvalid: result.restore.harnessInvalid,
      requiredChecks: result.restore.requiredChecks,
      diagnostics: result.restore.diagnostics.map((entry) => entry.code),
      rawSemantics: result.restore.projection?.rawSemantics ?? null,
      setup: result.restore.projection?.setup ?? null,
      detail: result.restore.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
      scenarioId: payload.projection?.scenarioId ?? null,
      actionCycleId: observation.actionCycle.actionCycleId,
    };
    expect(result.restore.outcome).toBe('PASS');
    expect(result.restore.harnessInvalid).toBe(false);
    expect(result.restore.projection).not.toBeNull();
    const projection = result.restore.projection;
    expect(restoreEvidenceViolations(projection as unknown as Record<string, unknown>)).toEqual([]);
    expect(projection?.rawSemantics.crosswordPresent).toBe(true);
    expect(projection?.rawSemantics.generationSeed).not.toBeNull();
    expect(projection?.rawSemantics.words.length).toBeGreaterThan(0);
    expect(projection?.rawSemantics.layoutDigest).not.toBeNull();
    expect(projection?.exclusions.volatileIdsDiffer).toBe(true);
    expect(projection?.exclusions.rawConfigPresent).toBe(true);
    expect(projection?.documentIdentityDistinct).toBe(true);
    expect(payload.projection).not.toBeNull();
    expect(payload.projection?.family).toBe('restore');
    expect(payload.projection?.scenarioId).toBe('serialize-raw-semantic');
    expect(payload.projection?.actionCycleRef).toBe(observation.actionCycle.actionCycleId);
    expect(payload.oracle?.primitiveFacts.authority).toBe('current');
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);

  it('classifies a semantically mutated deterministic response as BUG after a valid transition', async () => {
    const fixture = mixedFixture as BindingFixture;
    const result = await executeRestorePlan(
      baseInput(fixture, {
        kind: 'mutate-response',
        mutate: (response) => {
          const data = response.data as Record<string, unknown>;
          const layouts = Array.isArray(data.layouts)
            ? (data.layouts as Record<string, unknown>[])
            : [];
          for (const layout of layouts) {
            const layers = Array.isArray(layout.layers)
              ? (layout.layers as Record<string, unknown>[])
              : [];
            const text = layers.find((layer) => layer.type === 'TEXT');
            if (text !== undefined) {
              const config = text.config as Record<string, unknown>;
              const content = config.content as Record<string, unknown>;
              content.text = `${String(content.text)} (mutated)`;
              return;
            }
          }
          throw new Error('no TEXT layer in the deterministic response');
        },
      }),
    );
    const observation = expectEnvelopeBoundObservation(
      result.finalObservation,
      envelopeForFixture(fixture),
    );
    const payload = restorePayload(observation);
    evidence.bug = {
      outcome: result.restore.outcome,
      harnessInvalid: result.restore.harnessInvalid,
      requiredChecks: result.restore.requiredChecks,
      diagnostics: result.restore.diagnostics.map((entry) => entry.code),
      detail: result.restore.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
      scenarioId: payload.projection?.scenarioId ?? null,
    };
    expect(result.restore.outcome).toBe('BUG');
    expect(result.restore.harnessInvalid).toBe(false);
    expect(result.restore.projection).toBeNull();
    expect(
      result.restore.requiredChecks.find((check) => check.checkId === 'serialize.roundtrip')
        ?.passed,
    ).toBe(false);
    // The v4 family payload preserves the completed round trip even though the
    // legacy public report drops its projection on a BUG.
    expect(payload.projection).not.toBeNull();
    expect(payload.projection?.family).toBe('restore');
    expect(payload.projection?.scenarioId).toBe('serialize-raw-semantic');
    expect(payload.projection?.actionCycleRef).toBe(observation.actionCycle.actionCycleId);
    expect(payload.oracle?.primitiveFacts.authority).toBe('current');
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);

  it('classifies a malformed deterministic response as HARNESS_BLOCKED without a product claim', async () => {
    const fixture = mixedFixture as BindingFixture;
    const result = await executeRestorePlan(baseInput(fixture, { kind: 'malformed-response' }));
    const observation = expectEnvelopeBoundObservation(
      result.finalObservation,
      envelopeForFixture(fixture),
    );
    const payload = restorePayload(observation);
    evidence.harnessBlockedResponse = {
      outcome: result.restore.outcome,
      harnessInvalid: result.restore.harnessInvalid,
      diagnostics: result.restore.diagnostics.map((entry) => entry.code),
      detail: result.restore.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
    };
    expect(result.restore.outcome).toBe('HARNESS_BLOCKED');
    expect(result.restore.harnessInvalid).toBe(true);
    expect(result.restore.projection).toBeNull();
    expect(result.restore.diagnostics.map((entry) => entry.code)).toContain(
      'RESTORE_RESPONSE_INVALID',
    );
    // The malformed response never reached the Oracle, so the family handoff is
    // an explicit malformed/absent primitive view, not a product claim.
    expect(payload.projection).toBeNull();
    expect(payload.oracle).toBeNull();
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);

  it('classifies a disabled required Save control before dispatch as HARNESS_BLOCKED', async () => {
    const fixture = normalizedFixture as BindingFixture;
    const result = await executeRestorePlan(baseInput(fixture, { kind: 'disable-save' }));
    const observation = expectEnvelopeBoundObservation(
      result.finalObservation,
      envelopeForFixture(fixture),
    );
    const payload = restorePayload(observation);
    evidence.harnessBlockedControl = {
      outcome: result.restore.outcome,
      harnessInvalid: result.restore.harnessInvalid,
      diagnostics: result.restore.diagnostics.map((entry) => entry.code),
      detail: result.restore.detail,
      evaluatorKind: payload.evaluatorKind,
      projectionFamily: payload.projection?.family ?? null,
    };
    expect(result.restore.outcome).toBe('HARNESS_BLOCKED');
    expect(result.restore.harnessInvalid).toBe(true);
    expect(result.restore.projection).toBeNull();
    expect(payload.projection).toBeNull();
    expect(payload.oracle).toBeNull();
    expect(result.browserClose.closed).toBe(true);
  }, 300_000);
});
