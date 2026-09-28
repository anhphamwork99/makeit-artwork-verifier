import { describe, expect, it } from 'vitest';

import {
  CLEANUP_ORDER,
  PRESERVED_OWNERSHIP_KINDS,
  buildOwnershipCleanupManifest,
} from '../../src/allocation/ownership';
import {
  createAllocationLedger,
  reserveAllocation,
  validateEphemeralResources,
} from '../../src/allocation/reserve';
import { derivePlanFingerprint } from '../../src/canonical/identity';
import { planAndReserve, planCase } from '../../src/planner/plan-case';
import { defaultBundle, planned, releaseRequest } from './helpers';

function plannedIdentity() {
  const result = planned(planCase(releaseRequest()));
  return {
    result,
    identity: {
      caseId: result.caseId,
      materializationFingerprint: result.materializationFingerprint,
      planFingerprint: result.planFingerprint,
    },
  };
}

const RESOURCES = {
  port: 41001,
  processGroupId: 1001,
  distDir: '.verify-runs/instance-a/.next',
  evidenceRoot: 'evidence/runs/run-a',
};

describe('[Gate B/D] enforceable pre-launch allocation (TS-1)', () => {
  it('reserves owned resources bound to the plan identity without launching', () => {
    const { identity } = plannedIdentity();
    const result = reserveAllocation(identity, 'instance-a', RESOURCES);

    expect(result.status).toBe('RESERVED');
    expect(result.launchAttempted).toBe(false);
    if (result.status === 'RESERVED') {
      expect(result.allocation.boundTo).toEqual(identity);
      expect(result.allocation.executionInstanceId).toBe('instance-a');
      expect(result.allocation.ephemeral).toEqual(RESOURCES);
      expect(result.allocation.allocationId).toBe('alloc:instance-a');
    }
  });

  it('classifies every invalid reservation as pre-launch ENVIRONMENT_FAILURE', () => {
    const { identity } = plannedIdentity();

    for (const [resources, reason] of [
      [{ ...RESOURCES, port: 0 }, 'PORT_INVALID'],
      [{ ...RESOURCES, port: 70_000 }, 'PORT_INVALID'],
      [{ ...RESOURCES, port: 41_001.5 }, 'PORT_INVALID'],
      [{ ...RESOURCES, processGroupId: 0 }, 'PROCESS_GROUP_INVALID'],
      [{ ...RESOURCES, distDir: '   ' }, 'DIST_DIR_INVALID'],
      [{ ...RESOURCES, evidenceRoot: '' }, 'EVIDENCE_ROOT_INVALID'],
    ] as const) {
      const result = reserveAllocation(identity, 'instance-a', resources);

      expect(result.status).toBe('ENVIRONMENT_FAILURE');
      expect(result.launchAttempted).toBe(false);
      if (result.status === 'ENVIRONMENT_FAILURE') {
        expect(result.reason).toBe(reason);
      }
    }
  });

  it('exposes the same decisions through pure resource validation', () => {
    expect(validateEphemeralResources(RESOURCES)).toEqual({ ok: true });
    expect(validateEphemeralResources({ ...RESOURCES, port: -1 })).toMatchObject({
      ok: false,
      reason: 'PORT_INVALID',
    });
  });

  it('refuses an enforceable lease collision without touching the current owner', () => {
    const { identity } = plannedIdentity();
    const ledger = createAllocationLedger();

    const first = ledger.reserve(identity, 'instance-a', RESOURCES);
    const collidingPort = ledger.reserve(identity, 'instance-b', {
      ...RESOURCES,
      distDir: '.verify-runs/instance-b/.next',
      evidenceRoot: 'evidence/runs/run-b',
    });
    const collidingDistDir = ledger.reserve(identity, 'instance-c', {
      ...RESOURCES,
      port: 41_002,
      evidenceRoot: 'evidence/runs/run-c',
    });

    expect(first.status).toBe('RESERVED');
    expect(collidingPort.status).toBe('ENVIRONMENT_FAILURE');
    expect(collidingDistDir.status).toBe('ENVIRONMENT_FAILURE');
    if (collidingPort.status === 'ENVIRONMENT_FAILURE') {
      expect(collidingPort.reason).toBe('RESOURCE_ALREADY_OWNED');
      expect(collidingPort.launchAttempted).toBe(false);
    }
    // The refused attempt never removed or mutated the existing owner.
    expect(ledger.owned()).toEqual([RESOURCES]);

    ledger.release('instance-a');
    expect(ledger.owned()).toEqual([]);
    expect(
      ledger.reserve(identity, 'instance-b', {
        ...RESOURCES,
        distDir: '.verify-runs/instance-b/.next',
        evidenceRoot: 'evidence/runs/run-b',
      }).status,
    ).toBe('RESERVED');
  });

  it('keeps a distinct concurrent lease admissible', () => {
    const { identity } = plannedIdentity();
    const ledger = createAllocationLedger();

    expect(ledger.reserve(identity, 'instance-a', RESOURCES).status).toBe('RESERVED');
    expect(
      ledger.reserve(identity, 'instance-b', {
        port: 41_002,
        processGroupId: 1002,
        distDir: '.verify-runs/instance-b/.next',
        evidenceRoot: 'evidence/runs/run-b',
      }).status,
    ).toBe('RESERVED');
  });

  it('does not let a reservation change the immutable plan fingerprint', () => {
    const { result, identity } = plannedIdentity();
    const reserved = reserveAllocation(identity, 'instance-a', RESOURCES);

    expect(reserved.status).toBe('RESERVED');
    expect(derivePlanFingerprint(result.plan)).toBe(result.planFingerprint);
    expect(result.planFingerprint).toBe(identity.planFingerprint);
  });
});

describe('[Gate D] ownership and cleanup manifest (TS-1)', () => {
  it('declares cleanable owners, cleanup order, and preserved evidence', () => {
    const { result, identity } = plannedIdentity();
    const manifest = buildOwnershipCleanupManifest({
      identity,
      executionInstanceId: null,
      allocation: null,
    });

    expect(CLEANUP_ORDER).toEqual([
      'browser-context',
      'browser',
      'route-handler',
      'app-server',
      'app-port',
      'app-process-group',
      'next-dist-dir',
      'run-scratch',
    ]);
    expect(PRESERVED_OWNERSHIP_KINDS).toEqual(['evidence-root']);
    expect(manifest.caseId).toBe(result.caseId);
    expect(manifest.executionInstanceId).toBeNull();
    expect(manifest.cleanupOrder).toEqual(CLEANUP_ORDER);
    expect(manifest.preserved).toEqual(PRESERVED_OWNERSHIP_KINDS);
    expect(manifest.expectedOwners.map((owner) => owner.ownerKind)).toEqual([
      ...CLEANUP_ORDER,
      ...PRESERVED_OWNERSHIP_KINDS,
    ]);
    expect(manifest.expectedOwners.every((owner) => owner.exclusive)).toBe(false);
    expect(manifest.ownershipProofs).toEqual([
      { proofKind: 'plan-binding', bindingId: result.planFingerprint, exclusive: false },
    ]);
  });

  it('binds the exact reserved resources and proves exclusivity after allocation', () => {
    const { identity } = plannedIdentity();
    const reserved = reserveAllocation(identity, 'instance-a', RESOURCES);
    if (reserved.status !== 'RESERVED') throw new Error('fixture reservation failed');

    const manifest = buildOwnershipCleanupManifest({
      identity,
      executionInstanceId: 'instance-a',
      allocation: reserved.allocation,
    });

    expect(manifest.executionInstanceId).toBe('instance-a');
    expect(manifest.expectedOwners).toEqual([
      { ownerKind: 'browser-context', bindingId: 'instance-a', exclusive: true },
      { ownerKind: 'browser', bindingId: 'instance-a', exclusive: true },
      { ownerKind: 'route-handler', bindingId: 'instance-a', exclusive: true },
      { ownerKind: 'app-server', bindingId: '41001', exclusive: true },
      { ownerKind: 'app-port', bindingId: '41001', exclusive: true },
      { ownerKind: 'app-process-group', bindingId: '1001', exclusive: true },
      { ownerKind: 'next-dist-dir', bindingId: RESOURCES.distDir, exclusive: true },
      { ownerKind: 'run-scratch', bindingId: RESOURCES.distDir, exclusive: true },
      { ownerKind: 'evidence-root', bindingId: RESOURCES.evidenceRoot, exclusive: true },
    ]);
    expect(manifest.ownershipProofs).toEqual([
      { proofKind: 'plan-binding', bindingId: identity.planFingerprint, exclusive: false },
      {
        proofKind: 'allocation-ledger-reservation',
        bindingId: 'alloc:instance-a',
        exclusive: true,
      },
    ]);
  });
});

describe('[Gate B] planAndReserve composition (TS-1)', () => {
  it('returns a planned case with its executed allocation', () => {
    const result = planAndReserve(releaseRequest(), {
      catalogues: defaultBundle(),
      allocation: { executionInstanceId: 'instance-a', ephemeral: RESOURCES },
    });

    expect(result.status).toBe('PLANNED');
    expect(result.launchAttempted).toBe(false);
    if (result.status === 'PLANNED') {
      expect(result.allocation.ephemeral.port).toBe(RESOURCES.port);
      expect(result.outputs.ownershipCleanup.executionInstanceId).toBe('instance-a');
      expect(result.outputs.preflightReport.stages.at(-1)?.outcome).toBe('resolved');
    }
  });

  it('classifies an unusable valid plan as ENVIRONMENT_FAILURE before launch', () => {
    const result = planAndReserve(releaseRequest(), {
      catalogues: defaultBundle(),
      allocation: {
        executionInstanceId: 'instance-a',
        ephemeral: { ...RESOURCES, port: 0 },
      },
    });

    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    expect(result.launchAttempted).toBe(false);
    if (result.status === 'ENVIRONMENT_FAILURE') {
      expect(result.reason).toBe('PORT_INVALID');
    }
    expect('plan' in result).toBe(false);
  });

  it('still fails closed on an invalid contract before any allocation is attempted', () => {
    const result = planAndReserve(
      releaseRequest({ ...releaseRequest().intent, subjectId: 'layer/ghost' }),
      {
        catalogues: defaultBundle(),
        allocation: { executionInstanceId: 'instance-a', ephemeral: RESOURCES },
      },
    );

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
  });
});
