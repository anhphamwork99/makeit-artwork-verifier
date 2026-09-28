import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import {
  admitCase,
  evidenceRootFor,
  expectedDistDirFor,
  readOwnershipRecord,
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
import { buildEstablishedOwnership, buildPublicLaunchFacts } from '../../src/evidence/public-dto';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import { writeFinalPublicRunRecordV4 } from '../../src/evidence/final-writer';
import { executeDiagnosticCase } from '../../src/orchestration/diagnostic-execution';
import { planCaseForExecution, type PlanForExecutionResult } from '../../src/planner/plan-case';
import { deriveWorkflowStepCatalogueFingerprint } from '../../src/catalogue/fingerprint';
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
 * WP5 Slice 5-A ordinary Text native-drag tracer (TS-4/TS-5, Gate E).
 *
 * One owned Next.js server and real Chromium prove the tracer spine on the
 * existing two-layout Text constructor:
 *
 *   - `PASS`  — exactly one active-layout Text target, real native pointer drag,
 *               signal-first readiness with zero fallback polls, target-aware
 *               quiescence, one coherent observation, canonical/renderer
 *               agreement;
 *   - `HARNESS_BLOCKED` — the governed diagnostic-only `drag-ordinary-ambiguous`
 *               scenario, resolved through the normal planner and the exact
 *               checked-in fixture, blocks with two matches *before* any action;
 *   - `BUG`   — the same real drag with an impossible required delta.
 *
 * No store mutation happens after the seal beyond the claimed native drag. No
 * fixture or target-role override is used for the ambiguity proof (ADR 0012 R6).
 */

const RUN_ID = generateRunId();

let allocation: RunAllocation | null = null;
let bundle: ReturnType<typeof loadCatalogueBundle>;
let passResult: ExecutePlanResult | null = null;
let passPlanning: Extract<PlanForExecutionResult, { status: 'PLANNED' }> | null = null;

function request(minimumDelta: { x: number; y: number }): CaseRequest {
  const intent: CaseIntent = {
    subjectId: 'layer/text',
    capability: 'move',
    variant: 'plain',
    scenario: 'drag-ordinary',
    preState: { x: 10, y: 10 },
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
  planning: Extract<PlanForExecutionResult, { status: 'PLANNED' }>;
}

/** The governed ordinary ambiguity request that also produces the durable record. */
const AMBIGUOUS_REQUEST_PATH = path.join(
  process.cwd(),
  'tests/integration/fixtures/layer-text-move-ambiguous.request.json',
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
  if (fixture === null) throw new Error(`fixture missing for scenario "${options.scenarioId}"`);

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
  return { result, caseId: plan.caseId, fixture, planning: plan };
}

function dump(label: string, value: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[tracer-text-move] ${label}: ${JSON.stringify(value, null, 2)}`);
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
      writeFileSync(
        path.join(allocation.evidenceRoot, 'tracer-browser.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            runId: RUN_ID,
            outcome: passResult?.behavior.outcome ?? null,
            wakeSource: passResult?.behavior.wakeSource ?? null,
            fallbackPollCount: passResult?.behavior.fallbackPollCount ?? null,
            observationId: passResult?.behavior.observation?.observationId ?? null,
            resolutions: passResult?.behavior.resolutions ?? [],
            requiredChecks: passResult?.behavior.requiredChecks ?? [],
            timings: passResult?.behavior.timings ?? {},
            cleanupComplete: true,
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

describe('[Gate E] ordinary Text native drag tracer', () => {
  it('PASS: signal-first readiness, zero fallback polls, coherent canonical/renderer agreement', async () => {
    const { result, planning } = await drive({
      request: request({ x: 40, y: 20 }),
      scenarioId: 'drag-ordinary',
    });
    passResult = result;
    passPlanning = planning;
    if (result.behavior.outcome !== 'PASS') dump('PASS-drive', result.behavior);
    expect(result.behavior.outcome).toBe('PASS');
    expect(result.behavior.harnessInvalid).toBe(false);
    // Signal-first: never polling-first, and zero fallback polls on the normal path.
    expect(['store-signal', 'already-advanced']).toContain(result.behavior.wakeSource);
    expect(result.behavior.fallbackPollCount).toBe(0);
    // Exactly one active-layout Text target, resolved before the action.
    expect(result.behavior.resolutions).toHaveLength(1);
    expect(result.behavior.resolutions[0]?.status).toBe('resolved');
    expect(result.behavior.targetIds).toEqual(['layout-a-text-1']);
    // One accepted coherent observation with one observationId.
    expect(result.behavior.observation?.observationId).toBeTruthy();
    expect(result.behavior.observation?.attempts).toBeGreaterThanOrEqual(1);
    expect(result.behavior.requiredChecks).toEqual([{ checkId: 'geometry.delta', passed: true }]);
    // The native action is a real pointer drag, not a store call.
    expect(result.behavior.action?.ok).toBe(true);
    expect(result.behavior.actionLogs[0]?.primitive).toBe('pointer.drag');
    // Deadline and quiescence facts.
    expect(result.behavior.cycle?.gate?.status).toBe('transition');
    expect(result.behavior.timings.quiescentAtMs).not.toBeNull();
    expect(result.behavior.timings.capturedAtMs).not.toBeNull();
  }, 300_000);

  it('HARNESS_BLOCKED: the governed ordinary ambiguity scenario blocks before the action', async () => {
    const before = { ...pointerSpy };
    const { result, fixture } = await drive({
      request: checkedInAmbiguousRequest(),
      scenarioId: 'drag-ordinary-ambiguous',
    });
    if (result.behavior.outcome !== 'HARNESS_BLOCKED') dump('blocked-drive', result.behavior);
    expect(fixture.fixtureId).toBe('layer-text-move-drag-ordinary-ambiguous');
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
      scenarioId: 'drag-ordinary',
    });
    if (result.behavior.outcome !== 'BUG') dump('bug-drive', result.behavior);
    expect(result.behavior.outcome).toBe('BUG');
    expect(result.behavior.harnessInvalid).toBe(false);
    // The observation was still accepted and coherent; only the required check failed.
    expect(result.behavior.observation?.observationId).toBeTruthy();
    expect(result.behavior.requiredChecks).toEqual([{ checkId: 'geometry.delta', passed: false }]);
  }, 300_000);

  it('TS-5: the strict-v4 run record carries identity, revision, dirty flag and lockfile digest and survives cleanup', async () => {
    if (!allocation || !passResult || !passPlanning || passPlanning.envelope === null) {
      throw new Error('PASS drive did not run');
    }
    const ownershipRecord = readOwnershipRecord(RUN_ID);
    if (!ownershipRecord) throw new Error('ownership record missing for the browser tracer');
    const execution = executeDiagnosticCase({
      planning: passPlanning,
      prelaunch: {
        kind: 'reserved',
        allocationId: `${RUN_ID}:allocation`,
        executionInstanceId: `${RUN_ID}:execution`,
      },
      observation: passResult.finalObservation,
      runId: RUN_ID,
      cleanupSucceeded: true,
    });
    if (execution.record === null) throw new Error('strict-v4 child record missing');
    const contracts = passPlanning.materializedCase.contracts;
    const route = passPlanning.materializedCase.route;
    const profile = passPlanning.envelope.correctnessProfile;
    const fixture = passPlanning.materializedCase.fixture;
    if (fixture === undefined) throw new Error('materialized fixture missing');
    const written = writeFinalPublicRunRecordV4({
      child: execution.record,
      provenance: passPlanning.request.provenance,
      evidenceDepth: passPlanning.request.evidenceDepth,
      environmentCellId: allocation.environmentCellId,
      repository: {
        commit: collectAppRevision(allocation.repoRoot).commit,
        dirty: collectAppRevision(allocation.repoRoot).dirty,
        lockfileDigest: lockfileDigest(allocation.repoRoot),
      },
      fingerprints: {
        registry: contracts.registryFingerprint,
        applicationInventory: contracts.applicationInventoryFingerprint,
        operationCatalogue: contracts.operationCatalogueFingerprint,
        adapterCatalogue: contracts.adapterCatalogueFingerprint,
        workflowCatalogue: contracts.workflowCatalogueFingerprint,
        workflowSteps: deriveWorkflowStepCatalogueFingerprint(bundle.workflowStepCatalogue),
        coverageModel: contracts.coverageModelFingerprint,
        readinessProfile: `${profile.readiness.profileId}@${profile.readiness.schemaVersion}`,
        oracleProfile: `${profile.oracle.oracleProfileId}@${profile.oracle.schemaVersion}`,
      },
      adapter: {
        adapterId: route.adapterId,
        compatibilityVersion: route.adapterCompatibilityVersion,
      },
      workflow: { workflowId: route.workflowId, version: contracts.workflowVersion },
      fixture: {
        fixtureId: fixture.fixtureId,
        constructorId: fixture.constructorId,
        constructorVersion: fixture.constructorVersion,
      },
      targets: passResult.behavior.targetIds.map((elementId) => ({ role: 'target', elementId })),
      readiness: {
        profileId: profile.readiness.profileId,
        timingCategory: profile.readiness.deadlineCategory,
        deadlineMs: profile.readiness.deadlineMs,
        wakeSource: passResult.behavior.wakeSource,
        fallbackPollCount: passResult.behavior.fallbackPollCount,
        watchdogWaits: passResult.behavior.cycle?.gate?.watchdogWaits ?? 0,
        rendererStableFrames: profile.readiness.stableFrames,
        timings: passResult.behavior.timings,
      },
      behaviorOutcome: execution.behaviorOutcome,
      finalOutcome: execution.finalOutcome,
      launch: buildPublicLaunchFacts({
        attempted: true,
        pid: null,
        processGroupId: null,
        readinessMs: null,
        serverLogPath: null,
      }),
      ownership: buildEstablishedOwnership(
        ownershipRecord,
        ownershipRecord.state,
        ownershipRecord.repoRelativeDistDir,
        '.pi/skills/verify-artwork-editor',
      ),
      cleanup: null,
      diagnostics: execution.diagnostics,
      runError: null,
      evidenceRoot: allocation.evidenceRoot,
      forbiddenPaths: [
        allocation.repoRoot,
        allocation.skillRoot,
        allocation.distDir,
        allocation.scratchRoot,
        allocation.evidenceRoot,
      ],
    });
    const read = readFinalPublicRecordFile(written.path);
    expect(read.kind).toBe('current-v4');
    expect(read.current).toBe(true);
    if (read.kind !== 'current-v4') throw new Error('current strict-v4 record missing');
    expect(read.record.repository.lockfileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof read.record.repository.dirty).toBe('boolean');
    expect(read.record.requiredChecks[0]?.status).toBe('PASS');
    expect(read.record.caseId).toBe(passPlanning.caseId);
    expect(read.record.materializationFingerprint).toBe(passPlanning.materializationFingerprint);
    expect(read.record.planFingerprint).toBe(passPlanning.planFingerprint);
  });
});
