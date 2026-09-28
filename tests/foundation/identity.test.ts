import { describe, expect, it } from 'vitest';

import { reserveAllocation } from '../../src/allocation/reserve';
import { parseAdapterCatalogue, parseWorkflowCatalogue } from '../../src/catalogue/load';
import {
  deriveCaseId,
  deriveMaterializationFingerprint,
  derivePlanFingerprint,
  semanticProjection,
} from '../../src/canonical/identity';
import { planCase } from '../../src/planner/plan-case';
import {
  cloneCatalogue,
  defaultBundle,
  diagnosticRequest,
  planned,
  releaseRequest,
} from './helpers';

const TEXT_MOVE_INTENT = releaseRequest().intent;

function contractVersionsOverride() {
  return { workflowVersions: { 'shared.move': 2 } };
}

describe('[Gate B] four-level identity model (TS-1)', () => {
  it('shares caseId and the correctness projection across Diagnostic and Release profiles', () => {
    const release = planned(planCase(releaseRequest(TEXT_MOVE_INTENT)));
    const diagnostic = planned(planCase(diagnosticRequest(TEXT_MOVE_INTENT)));

    expect(diagnostic.caseId).toBe(release.caseId);
    expect(diagnostic.materializationFingerprint).toBe(release.materializationFingerprint);
    expect(diagnostic.planFingerprint).toBe(release.planFingerprint);
  });

  it('keeps profile, provenance and evidence depth outside the semantic projection', () => {
    const projection = semanticProjection(TEXT_MOVE_INTENT) as Record<string, unknown>;

    expect(Object.keys(projection).sort()).toEqual([
      'capability',
      'expected',
      'operations',
      'preState',
      'resources',
      'scenario',
      'subjectId',
      'variant',
    ]);
    expect(deriveCaseId(TEXT_MOVE_INTENT)).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveCaseId(TEXT_MOVE_INTENT)).toBe(deriveCaseId(structuredClone(TEXT_MOVE_INTENT)));
  });

  it('changes caseId when a concrete diagnostic pre-state value changes', () => {
    const base = planned(
      planCase(diagnosticRequest({ ...TEXT_MOVE_INTENT, preState: { x: 10, y: 10 } })),
    );
    const changed = planned(
      planCase(diagnosticRequest({ ...TEXT_MOVE_INTENT, preState: { x: 11, y: 10 } })),
    );

    expect(changed.caseId).not.toBe(base.caseId);
    expect(changed.materializationFingerprint).not.toBe(base.materializationFingerprint);
    expect(changed.planFingerprint).not.toBe(base.planFingerprint);
  });

  it('changes caseId when a semantic resource digest changes', () => {
    const base = planned(
      planCase(
        diagnosticRequest({
          ...TEXT_MOVE_INTENT,
          resources: [{ resourceId: 'uploaded-image', contentDigest: 'sha256:aaa' }],
        }),
      ),
    );
    const changed = planned(
      planCase(
        diagnosticRequest({
          ...TEXT_MOVE_INTENT,
          resources: [{ resourceId: 'uploaded-image', contentDigest: 'sha256:bbb' }],
        }),
      ),
    );

    expect(changed.caseId).not.toBe(base.caseId);
  });

  it('changes caseId when an operation parameter changes', () => {
    const base = planned(planCase(releaseRequest(TEXT_MOVE_INTENT)));
    const changed = planned(
      planCase(
        releaseRequest({
          ...TEXT_MOVE_INTENT,
          operations: [{ discriminant: 'move.by', parameters: { dx: 81, dy: 40 } }],
        }),
      ),
    );

    expect(changed.caseId).not.toBe(base.caseId);
  });

  it('changes materializationFingerprint but not caseId for a contract-only revision', () => {
    const base = planned(planCase(releaseRequest(TEXT_MOVE_INTENT)));
    const revised = planned(planCase(releaseRequest(TEXT_MOVE_INTENT), contractVersionsOverride()));

    expect(revised.caseId).toBe(base.caseId);
    expect(revised.materializationFingerprint).not.toBe(base.materializationFingerprint);
  });

  it('changes materializationFingerprint when a family-default version changes', () => {
    const catalogue = cloneCatalogue(defaultBundle().subjectCatalogue);
    const layerDefaults = catalogue.familyDefaults.layer;
    if (!layerDefaults) throw new Error('layer family defaults are missing');
    layerDefaults.version = 7;

    const base = planned(planCase(releaseRequest(TEXT_MOVE_INTENT)));
    const revised = planned(
      planCase(releaseRequest(TEXT_MOVE_INTENT), {
        catalogues: { ...defaultBundle(), subjectCatalogue: catalogue },
      }),
    );

    expect(revised.caseId).toBe(base.caseId);
    expect(revised.materializationFingerprint).not.toBe(base.materializationFingerprint);
  });

  it('changes materializationFingerprint when the executable catalogue identity changes', () => {
    const bundle = defaultBundle();
    const adapterCatalogue = parseAdapterCatalogue({
      ...bundle.adapterCatalogue,
      adapters: [
        ...bundle.adapterCatalogue.adapters,
        { adapterId: 'future-specialized', compatibilityVersion: 1 },
      ],
    });
    const workflowCatalogue = parseWorkflowCatalogue({
      ...bundle.workflowCatalogue,
      workflows: [
        ...bundle.workflowCatalogue.workflows,
        { workflowId: 'shared.future', version: 1, capability: 'move' },
      ],
    });

    const base = planned(planCase(releaseRequest(TEXT_MOVE_INTENT)));
    const revised = planned(
      planCase(releaseRequest(TEXT_MOVE_INTENT), {
        catalogues: { ...bundle, adapterCatalogue, workflowCatalogue },
      }),
    );

    expect(revised.caseId).toBe(base.caseId);
    expect(revised.materializationFingerprint).not.toBe(base.materializationFingerprint);
  });

  it('resolves the workflow version from the authoritative workflow catalogue', () => {
    const bundle = defaultBundle();
    const workflowCatalogue = parseWorkflowCatalogue({
      ...bundle.workflowCatalogue,
      workflows: bundle.workflowCatalogue.workflows.map((entry) =>
        entry.workflowId === 'shared.move' ? { ...entry, version: 4 } : entry,
      ),
    });

    const result = planned(
      planCase(releaseRequest(TEXT_MOVE_INTENT), {
        catalogues: { ...bundle, workflowCatalogue },
      }),
    );

    expect(result.materializedCase.contracts.workflowVersion).toBe(4);
  });

  it('recomputes the documented identities from their own artifact kinds', () => {
    const result = planned(planCase(releaseRequest(TEXT_MOVE_INTENT)));

    expect(deriveCaseId(result.materializedCase.intent, result.materializedCase.fixture)).toBe(
      result.caseId,
    );
    expect(deriveMaterializationFingerprint(result.materializedCase)).toBe(
      result.materializationFingerprint,
    );
    expect(derivePlanFingerprint(result.plan)).toBe(result.planFingerprint);
  });

  it('keeps ephemeral allocation outside planFingerprint', () => {
    const plan = planned(planCase(releaseRequest(TEXT_MOVE_INTENT)));
    const identity = {
      caseId: plan.caseId,
      materializationFingerprint: plan.materializationFingerprint,
      planFingerprint: plan.planFingerprint,
    };

    const first = reserveAllocation(identity, 'instance-a', {
      port: 41001,
      processGroupId: 1001,
      distDir: '.verify-runs/a/.next',
      evidenceRoot: 'evidence/runs/a',
    });
    const second = reserveAllocation(identity, 'instance-b', {
      port: 41002,
      processGroupId: 1002,
      distDir: '.verify-runs/b/.next',
      evidenceRoot: 'evidence/runs/b',
    });

    expect(first.status).toBe('RESERVED');
    expect(second.status).toBe('RESERVED');
    expect(derivePlanFingerprint(plan.plan)).toBe(identity.planFingerprint);
    if (first.status === 'RESERVED' && second.status === 'RESERVED') {
      expect(first.allocation.boundTo.planFingerprint).toBe(identity.planFingerprint);
      expect(second.allocation.boundTo.planFingerprint).toBe(identity.planFingerprint);
      expect(second.allocation.ephemeral.port).not.toBe(first.allocation.ephemeral.port);
      expect(JSON.stringify(second.allocation)).not.toBe(JSON.stringify(first.allocation));
    }
  });
});
