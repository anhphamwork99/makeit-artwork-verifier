import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import {
  admitCase,
  evidenceRootFor,
  expectedDistDirFor,
  releaseCase,
  scratchRootFor,
} from '../../src/allocation/lease';
import { resolveAdapterImplementation } from '../../src/adapters/registry';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import { cleanupRun } from '../../src/cleanup/cleanup';
import type { CaseIntent, CaseRequest } from '../../src/contracts/case-model';
import type { BindingFixture } from '../../src/contracts/fixtures';
import type { RunAllocation } from '../../src/contracts/runtime';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { collectAppRevision, lockfileDigest } from '../../src/runtime/environment-facts';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { executePlan, type ExecutePlanResult } from '../../src/runtime/execute-plan';
import { launchOwnedServer } from '../../src/runtime/launch';
import { generateRunId } from '../../src/runtime/run-id';
import { resolveWorkflowSteps } from '../../src/workflows/steps';

// ADR 0012 R6: "no native pointer primitive was invoked" is established by a
// test-only module spy on the existing primitives module. No production seam or
// runtime CLI switch is added for this assertion.
const pointerSpy = vi.hoisted(() => ({ drag: 0, click: 0, activate: 0, fileInput: 0 }));

vi.mock('../../src/browser/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/browser/primitives')>();
  return {
    ...actual,
    pointerDrag: async (input: Parameters<typeof actual.pointerDrag>[0]) => {
      pointerSpy.drag += 1;
      return actual.pointerDrag(input);
    },
    pointerClick: async (input: Parameters<typeof actual.pointerClick>[0]) => {
      pointerSpy.click += 1;
      return actual.pointerClick(input);
    },
    activateControl: async (input: Parameters<typeof actual.activateControl>[0]) => {
      pointerSpy.activate += 1;
      return actual.activateControl(input);
    },
    setFileInput: async (input: Parameters<typeof actual.setFileInput>[0]) => {
      pointerSpy.fileInput += 1;
      return actual.setFileInput(input);
    },
  };
});

/**
 * WP5 Slice 5-B circle-warped Text native-drag tracer (TS-4, Gate E bullet 2).
 *
 * One owned Next.js server and real Chromium prove the specialized warped Text
 * slice on the additive `artwork.two-layout-text.v2` constructor:
 *
 *   - `PASS`  — one active-layout circle-warped Text target, real native pointer
 *               drag, signal-first readiness with zero fallback polls,
 *               target-aware typed-geometry quiescence, one coherent
 *               observation with a renderer-local G0/G1 bracket, and both
 *               `geometry.delta` and `geometry.warp-envelope` checks passing;
 *   - `HARNESS_BLOCKED` — the governed diagnostic-only
 *               `drag-warped-nested-ambiguous` scenario, resolved through the
 *               normal planner and the exact checked-in all-circle fixture,
 *               blocks with two matches *before* any action or typed geometry;
 *   - `BUG`   — the same real drag with an impossible required delta.
 */

const RUN_ID = generateRunId();

let allocation: RunAllocation | null = null;
let bundle: ReturnType<typeof loadCatalogueBundle>;
let passResult: ExecutePlanResult | null = null;

function request(minimumDelta: { x: number; y: number }): CaseRequest {
  const intent: CaseIntent = {
    subjectId: 'layer/text',
    capability: 'move',
    variant: 'warp-circle',
    scenario: 'drag-warped-nested',
    preState: { x: 125, y: 125 },
    operations: [{ discriminant: 'move.by', parameters: { dx: 80, dy: 40 } }],
    expected: { minimumDelta },
    resources: [],
  };
  return {
    schemaVersion: 1,
    profile: 'diagnostic',
    provenance: 'diagnostic-request',
    evidenceDepth: 'deep',
    intent,
  };
}

interface Drive {
  result: ExecutePlanResult;
  caseId: string;
  fixture: BindingFixture;
}

/** The governed circle-warped ambiguity request that also produces the durable record. */
const AMBIGUOUS_REQUEST_PATH = path.join(
  process.cwd(),
  'tests/integration/fixtures/layer-text-move-warped-ambiguous.request.json',
);

function checkedInAmbiguousRequest(): CaseRequest {
  return JSON.parse(readFileSync(AMBIGUOUS_REQUEST_PATH, 'utf8')) as CaseRequest;
}

async function drive(options: { request: CaseRequest; scenarioId: string }): Promise<Drive> {
  if (!allocation) throw new Error('allocation is not ready');
  const plan = planCaseForExecution(options.request, { catalogues: bundle });
  if (plan.status !== 'PLANNED' || plan.envelope === null) {
    throw new Error(`expected delivered PLANNED, received ${plan.status}`);
  }
  const fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
    subjectId: 'layer/text',
    capability: 'move',
    scenarioId: options.scenarioId,
  });
  if (fixture === null) throw new Error(`warped fixture missing for "${options.scenarioId}"`);

  const adapterResolution = resolveAdapterImplementation({
    catalogue: bundle.adapterCatalogue,
    declaration: {
      adapterId: plan.plan.route.adapterId,
      compatibilityVersion: plan.plan.route.adapterCompatibilityVersion,
    },
  });
  if (!adapterResolution.ok) throw new Error('adapter missing');
  const stepEntry = resolveWorkflowSteps(bundle.workflowStepCatalogue, plan.plan.route.workflowId);
  if (stepEntry === null) throw new Error('workflow steps missing');

  const environment = resolveEnvironmentCell(
    loadEnvironmentCatalogue(),
    allocation.environmentCellId,
  );
  const result = await executePlan({
    allocation,
    caseId: plan.caseId,
    intent: plan.materializedCase.intent,
    plan: plan.plan,
    adapter: adapterResolution.adapter,
    fixture,
    workflowSteps: stepEntry.steps,
    environment,
    envelope: plan.envelope,
  });
  return { result, caseId: plan.caseId, fixture };
}

function dump(label: string, value: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[tracer-warped-text-move] ${label}: ${JSON.stringify(value, null, 2)}`);
}

beforeAll(async () => {
  bundle = loadCatalogueBundle();
  const allocationResult = await allocateRun({ runId: RUN_ID });
  if (!allocationResult.ok) throw new Error(`allocation failed: ${allocationResult.detail}`);
  allocation = allocationResult.allocation;
  const admission = admitCase(RUN_ID, 'diagnostic');
  if (!admission.ok) throw new Error(`admission failed: ${admission.detail}`);
  const launch = await launchOwnedServer({ allocation, readinessDeadlineMs: 300_000 });
  if (!launch.ok) throw new Error(`owned launch failed: ${launch.detail}`);
}, 360_000);

afterAll(async () => {
  try {
    if (allocation) {
      mkdirSync(allocation.evidenceRoot, { recursive: true });
      writeFileSync(
        path.join(allocation.evidenceRoot, 'tracer-warped-browser.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            runId: RUN_ID,
            outcome: passResult?.behavior.outcome ?? null,
            profile: passResult?.behavior.profile ?? null,
            wakeSource: passResult?.behavior.wakeSource ?? null,
            fallbackPollCount: passResult?.behavior.fallbackPollCount ?? null,
            observationId: passResult?.behavior.observation?.observationId ?? null,
            requiredChecks: passResult?.behavior.requiredChecks ?? [],
            timings: passResult?.behavior.timings ?? {},
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
  } finally {
    releaseCase(RUN_ID);
    if (allocation) {
      await cleanupRun(RUN_ID, { browserCleanup: { closed: true, detail: null } });
      rmSync(evidenceRootFor(RUN_ID), { recursive: true, force: true });
      rmSync(scratchRootFor(RUN_ID), { recursive: true, force: true });
      rmSync(expectedDistDirFor(RUN_ID), { recursive: true, force: true });
    }
  }
}, 300_000);

describe('[Gate E] circle-warped Text native drag tracer', () => {
  it('PASS: typed envelope, signal-first readiness, coherent delta and warp-envelope checks', async () => {
    const { result } = await drive({
      request: request({ x: 40, y: 20 }),
      scenarioId: 'drag-warped-nested',
    });
    passResult = result;
    if (result.behavior.outcome !== 'PASS') dump('PASS-drive', result.behavior);
    expect(result.behavior.outcome).toBe('PASS');
    expect(result.finalObservation).not.toBeNull();
    expect(result.finalObservation?.envelope).toBeDefined();
    expect(result.finalObservation?.payload.evaluatorKind).toBe('warped-text-envelope');
    expect(result.behavior.harnessInvalid).toBe(false);
    expect(['store-signal', 'already-advanced']).toContain(result.behavior.wakeSource);
    expect(result.behavior.fallbackPollCount).toBe(0);
    expect(result.behavior.targetIds).toEqual(['layout-a-text-1']);
    expect(result.behavior.observation?.observationId).toBeTruthy();
    expect(result.behavior.requiredChecks).toEqual([
      { checkId: 'geometry.delta', passed: true },
      { checkId: 'geometry.warp-envelope', passed: true },
    ]);
    expect(result.behavior.profile.readinessProfileId).toBe('warped-text-action-cycle-v1');
    expect(result.behavior.profile.oracleProfileId).toBe('warped-text-circle-move-v1');
    expect(result.behavior.action?.ok).toBe(true);
    expect(result.behavior.actionLogs[0]?.primitive).toBe('pointer.drag');
    expect(result.behavior.cycle?.gate?.status).toBe('transition');
    expect(result.behavior.cycle?.oracle?.warped?.profileId).toBe('warped-text-circle-move-v1');
  }, 300_000);

  it('HARNESS_BLOCKED: the governed circle-warped ambiguity scenario blocks before the action', async () => {
    const before = { ...pointerSpy };
    const { result, fixture } = await drive({
      request: checkedInAmbiguousRequest(),
      scenarioId: 'drag-warped-nested-ambiguous',
    });
    if (result.behavior.outcome !== 'HARNESS_BLOCKED') dump('blocked-drive', result.behavior);
    expect(fixture.fixtureId).toBe('layer-text-move-drag-warped-nested-ambiguous');
    expect(fixture.constructorId).toBe('artwork.two-layout-text.v2');
    expect(result.behavior.outcome).toBe('HARNESS_BLOCKED');
    expect(result.behavior.harnessInvalid).toBe(true);
    expect(result.behavior.resolutions).toHaveLength(1);
    const resolution = result.behavior.resolutions[0];
    expect(resolution?.status).toBe('ambiguous');
    expect(resolution?.matchCount).toBe(2);
    expect([...(resolution?.matchedElementIds ?? [])].sort()).toEqual([
      'layout-a-text-1',
      'layout-b-text-1',
    ]);
    expect(resolution?.target).toBeNull();
    // No native action, cycle, observation, or target claim was produced.
    expect(result.behavior.action).toBeNull();
    expect(result.behavior.actionLogs).toEqual([]);
    expect(result.behavior.cycle).toBeNull();
    expect(result.behavior.observation).toBeNull();
    expect(result.behavior.targetIds).toEqual([]);
    expect(result.behavior.diagnostics.map((entry) => entry.code)).toContain('TARGET_AMBIGUOUS');
    // No native pointer primitive was invoked.
    expect(pointerSpy.drag).toBe(before.drag);
    expect(pointerSpy.click).toBe(before.click);
    expect(pointerSpy.activate).toBe(before.activate);
    expect(pointerSpy.fileInput).toBe(before.fileInput);
  }, 300_000);

  it('BUG: an impossible required delta after the same real action is a product defect', async () => {
    const { result } = await drive({
      request: request({ x: 500, y: 500 }),
      scenarioId: 'drag-warped-nested',
    });
    if (result.behavior.outcome !== 'BUG') dump('bug-drive', result.behavior);
    expect(result.behavior.outcome).toBe('BUG');
    expect(result.behavior.harnessInvalid).toBe(false);
    expect(result.behavior.observation?.observationId).toBeTruthy();
    expect(result.behavior.requiredChecks[0]).toEqual({ checkId: 'geometry.delta', passed: false });
  }, 300_000);
});
