import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const allocationRun = vi.hoisted(() => vi.fn());
const cleanupRunMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/allocation/allocate', () => ({
  allocateRun: allocationRun,
  allocationFailureCliStatus: () => 'HARNESS_BLOCKED',
}));
vi.mock('../../src/cleanup/cleanup', () => ({ cleanupRun: cleanupRunMock }));

import {
  compilePreparedExecutionCandidate,
  prepareDiagnosticRun,
  type PreparedExecutionCandidate,
} from '../../src/cli/diagnostic';
import * as finalActivePath from '../../src/orchestration/final-active-path';
import * as catalogueLoader from '../../src/catalogue/load';
import { resolveSkillRoot } from '../../src/runtime/paths';
import * as environment from '../../src/runtime/environment';
import * as adapterRegistry from '../../src/adapters/registry';
import * as fixtures from '../../src/catalogue/fixtures';
import * as workflowSteps from '../../src/workflows/steps';
import * as executionSupport from '../../src/planner/execution-support';
import { createDiagnostic } from '../../src/contracts/diagnostics';

function request(filename = 'layer-text-move-drag-ordinary.json'): unknown {
  return JSON.parse(
    readFileSync(path.join(resolveSkillRoot(), 'cases/diagnostic/requests', filename), 'utf8'),
  ) as unknown;
}

function validCandidate(): PreparedExecutionCandidate {
  const result = compilePreparedExecutionCandidate(request());
  if (!result.ok) throw new Error('Expected the representative request to plan.');
  return result.candidate;
}

beforeEach(() => {
  allocationRun.mockReset();
  cleanupRunMock.mockReset();
  allocationRun.mockResolvedValue({
    ok: false,
    reason: 'RUN_ID_INVALID',
    detail: 'test allocation boundary',
  });
  cleanupRunMock.mockResolvedValue({
    schemaVersion: 1,
    runId: 'prepared-seam-test',
    attempted: false,
    complete: true,
    alreadyClean: true,
    refusedReason: null,
    detail: 'test cleanup boundary',
    verification: {},
    diagnostics: [],
  });
});

afterEach(() => vi.restoreAllMocks());

describe('prepared Diagnostic execution seam', () => {
  it('ordinary Diagnostic preparation loads and plans exactly once', async () => {
    const plan = vi.spyOn(finalActivePath, 'planFinalActivePathCase');
    const loadBundle = vi.spyOn(catalogueLoader, 'loadCatalogueBundle');

    const result = await prepareDiagnosticRun({ runId: 'prepared-seam-test', request: request() });

    expect(result.ok).toBe(true);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(loadBundle).toHaveBeenCalledTimes(1);
    expect(allocationRun).toHaveBeenCalledTimes(1);
  });

  it('reuses the exact candidate without replanning or reloading catalogues', async () => {
    const candidate = validCandidate();
    const plan = vi.spyOn(finalActivePath, 'planFinalActivePathCase');
    const loadBundle = vi.spyOn(catalogueLoader, 'loadCatalogueBundle');
    const loadEnvironment = vi.spyOn(environment, 'loadEnvironmentCatalogue');

    const result = await prepareDiagnosticRun({
      runId: 'prepared-seam-test',
      preparedCandidate: candidate,
      expectedIdentity: candidate.identity,
    });

    expect(plan).not.toHaveBeenCalled();
    expect(loadBundle).not.toHaveBeenCalled();
    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(allocationRun).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.facts.planning).toBe(candidate.planning);
  });

  it('rejects any frozen tuple mismatch before allocation', async () => {
    const candidate = validCandidate();
    const mismatches = [
      { caseId: 'other-case' },
      { materializationFingerprint: '0'.repeat(64) },
      { planFingerprint: '0'.repeat(64) },
      { cellId: 'other-cell' },
    ];
    for (const expectedIdentity of mismatches) {
      const result = await prepareDiagnosticRun({
        runId: 'prepared-seam-test',
        preparedCandidate: candidate,
        expectedIdentity,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe('HARNESS_BLOCKED');
      expect(allocationRun).not.toHaveBeenCalled();
    }
  });

  it('rejects stale request and environment identities before allocation', async () => {
    const candidate = validCandidate();
    const other = compilePreparedExecutionCandidate(
      request('layer-text-move-drag-warped-nested.json'),
    );
    if (!other.ok) throw new Error('Expected the second representative request to plan.');
    const staleRequest = { ...candidate, requestDigest: '0'.repeat(64) };
    const unrelatedPlan = {
      ...candidate,
      planning: { ...candidate.planning, request: other.candidate.planning.request },
      requestDigest: other.candidate.requestDigest,
    };
    const staleEnvironment = {
      ...candidate,
      environmentCell: { ...candidate.environmentCell, locale: 'fr-FR' },
    };
    const staleEnvelope = {
      ...candidate,
      planning: {
        ...candidate.planning,
        envelope: { ...candidate.planning.envelope!, planFingerprint: '0'.repeat(64) },
      },
    };
    const missingEnvelope = {
      ...candidate,
      planning: { ...candidate.planning, envelope: null },
    };

    for (const preparedCandidate of [
      staleRequest,
      unrelatedPlan,
      staleEnvironment,
      staleEnvelope,
      missingEnvelope,
    ]) {
      const result = await prepareDiagnosticRun({
        runId: 'prepared-seam-test',
        preparedCandidate,
      });
      expect(result.ok).toBe(false);
      expect(allocationRun).not.toHaveBeenCalled();
    }
  });

  it('rejects a non-PLANNED candidate before allocation', async () => {
    const candidate = validCandidate();
    const nonPlanned = {
      ...candidate,
      planning: { ...candidate.planning, status: 'BLOCKED' },
    } as unknown as PreparedExecutionCandidate;

    const result = await prepareDiagnosticRun({
      runId: 'prepared-seam-test',
      preparedCandidate: nonPlanned,
    });

    expect(result.ok).toBe(false);
    expect(allocationRun).not.toHaveBeenCalled();
  });

  it('rejects post-compile catalogue mutation before preflight or allocation', async () => {
    const candidate = validCandidate();
    const entry = candidate.bundle.adapterCatalogue.adapters[0];
    if (entry === undefined) throw new Error('Expected at least one adapter declaration.');
    entry.compatibilityVersion += 1;

    const result = await prepareDiagnosticRun({
      runId: 'prepared-seam-test',
      preparedCandidate: candidate,
    });

    expect(result.ok).toBe(false);
    expect(allocationRun).not.toHaveBeenCalled();
  });

  it('keeps adapter, fixture, workflow, and runtime-support refusals pre-allocation', async () => {
    const refusals = [
      () =>
        vi.spyOn(adapterRegistry, 'resolveAdapterImplementation').mockReturnValue({
          ok: false,
          finding: createDiagnostic('ADAPTER_IMPLEMENTATION_UNAVAILABLE', 'test refusal'),
        }),
      () => vi.spyOn(fixtures, 'resolveBindingFixture').mockReturnValue(null),
      () => vi.spyOn(workflowSteps, 'resolveWorkflowSteps').mockReturnValue(null),
      () =>
        vi.spyOn(executionSupport, 'resolveExecutionSupport').mockReturnValue({
          adapterId: 'text-specialized',
          workflowId: 'text.move',
          supported: false,
          detail: 'test refusal',
        }),
    ];

    for (const refuse of refusals) {
      const candidate = validCandidate();
      refuse();
      const result = await prepareDiagnosticRun({
        runId: 'prepared-seam-test',
        preparedCandidate: candidate,
      });
      expect(result.ok).toBe(false);
      expect(allocationRun).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it('does not allow a candidate to be paired with a separate request', async () => {
    const candidate = validCandidate();
    const result = await prepareDiagnosticRun({
      runId: 'prepared-seam-test',
      preparedCandidate: candidate,
      request: request(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe('USAGE');
    expect(allocationRun).not.toHaveBeenCalled();
  });
});
