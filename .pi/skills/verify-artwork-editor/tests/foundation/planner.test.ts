import { describe, expect, it } from 'vitest';

import type { DiagnosticCode } from '../../src/contracts/diagnostics';
import type { CaseRequest, PlanResult } from '../../src/contracts/case-model';
import { correctnessProjection, planCase } from '../../src/planner/plan-case';
import {
  baseIntent,
  cloneCatalogue,
  cloneInventory,
  defaultBundle,
  diagnosticRequest,
  planned,
  releaseRequest,
  requireDeclaration,
} from './helpers';

function request(overrides: Partial<CaseRequest['intent']>): CaseRequest {
  return releaseRequest({ ...baseIntent(), ...overrides });
}

function expectBlocked(result: PlanResult, code: DiagnosticCode): void {
  expect(result.status).toBe('HARNESS_BLOCKED');
  if (result.status !== 'HARNESS_BLOCKED') throw new Error('expected a blocked plan result');
  expect(result.code).toBe(code);
  // The primary error is preserved as a structured record, not only as a
  // code plus a formatted string.
  expect(result.diagnostic).toMatchObject({ code, severity: 'blocking' });
  expect(result.diagnostic.detail.length).toBeGreaterThan(0);
  expect(result.report.rejectionDiagnostics).toContainEqual(result.diagnostic);
  expect(result.launchAttempted).toBe(false);
  expect('plan' in result).toBe(false);
  expect('materializedCase' in result).toBe(false);
  expect(result.report.stages.length).toBeGreaterThan(0);
  expect(result.report.rejectionReasons.length).toBeGreaterThan(0);
  expect(result.report.rejectionDiagnostics.length).toBeGreaterThan(0);
}

describe('[Gate B] closed planner happy path (TS-1)', () => {
  it('plans the default catalogue case with complete planner outputs', () => {
    const result = planned(planCase(releaseRequest()));

    expect(result.launchAttempted).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.coverageStatus).toBe('complete');
    expect(result.caseId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan.phases.map((phase) => phase.phase)).toEqual([
      'setup',
      'precondition',
      'action',
      'evidence',
      'cleanup',
    ]);
    expect(result.plan.phases.find((phase) => phase.phase === 'action')?.operations).toEqual([
      'move.by',
    ]);
    expect(result.plan.cleanup).toEqual(['cleanup.release']);
    expect(result.plan.requiredChecks).toEqual(['geometry.delta']);
    expect(result.outputs.preflightReport.status).toBe('PLANNED');
    expect(result.outputs.preflightReport.launchAttempted).toBe(false);
    expect(result.outputs.preflightReport.route).toEqual(result.materializedCase.route);
    expect(result.outputs.coverageAttribution.caseId).toBe(result.caseId);
    expect(result.outputs.evidenceRequirements.checkIds).toEqual(result.plan.requiredChecks);
    expect(result.outputs.evidenceRequirements.requiredAuthoritative).toEqual([
      'geometry.canonical',
      'geometry.renderer',
      'observation',
    ]);
    expect(result.outputs.evidenceRequirements.profileId).toBe('action-cycle-v1');
    expect(result.outputs.ownershipCleanup.caseId).toBe(result.caseId);
  });

  it('records every planner stage with an explicit outcome', () => {
    const report = planned(planCase(releaseRequest())).outputs.preflightReport;

    expect(report.stages.map((stage) => stage.stageId)).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
      'P4',
      'P5',
      'P6',
      'P7',
      'P8',
      'P9',
      'P10',
    ]);
    expect(report.stages.filter((stage) => stage.outcome === 'rejected')).toEqual([]);
    // Every correctness-affecting stage resolves for this delivered binding
    // (fixture, adapter implementation, and workflow steps all exist), so P5/P7
    // are resolved rather than deferred. Only P10 (enforceable allocation) is
    // owned by the launch path.
    expect(
      report.stages.filter((stage) => stage.outcome === 'deferred').map((stage) => stage.stageId),
    ).toEqual(['P10']);
    expect(
      report.stages
        .filter((stage) => stage.stageId === 'P5' || stage.stageId === 'P7')
        .map((stage) => stage.outcome),
    ).toEqual(['resolved', 'resolved']);
    expect(report.nonWeakeningAudit.every((entry) => entry.satisfied)).toBe(true);
  });

  it('separates required-authoritative evidence items from diagnostic-only evidence', () => {
    const requirements = planned(planCase(releaseRequest())).outputs.evidenceRequirements;

    // Evidence item ids are distinct from required-check ids (ADR 0023 P7-07).
    expect(requirements.checkIds).toEqual(['geometry.delta']);
    expect(requirements.requiredAuthoritative).toEqual([
      'geometry.canonical',
      'geometry.renderer',
      'observation',
    ]);
    expect(requirements.diagnosticOnly).toEqual([
      'obstruction.diagnostic',
      'screenshot.diagnostic',
    ]);
    expect(requirements.requiredAuthoritative.some((id) => id === 'geometry.delta')).toBe(false);
    // No diagnostic-only item can satisfy or rescue a required check.
    for (const evidenceId of requirements.diagnosticOnly) {
      expect(requirements.requiredAuthoritative).not.toContain(evidenceId);
    }
    expect(
      requirements.requirements.filter((entry) => entry.role === 'required-authoritative').length,
    ).toBe(3);
    expect(
      requirements.requirements.filter((entry) => entry.role === 'diagnostic-only').length,
    ).toBe(2);
  });

  it('qualifies coverage completeness instead of claiming unqualified completeness', () => {
    const attribution = planned(planCase(releaseRequest())).outputs.coverageAttribution;

    expect(attribution.completeness.map((entry) => entry.dimension)).toEqual([
      'binding-execution',
      'binding-model',
      'project-scope',
      'registry-coverage',
      'selected-suite',
    ]);
    const byDimension = Object.fromEntries(
      attribution.completeness.map((entry) => [entry.dimension, entry]),
    );
    expect(byDimension['binding-model']).toMatchObject({
      dimension: 'binding-model',
      status: 'complete',
    });
    expect(byDimension['binding-model']?.qualification).not.toMatch(/^complete$/i);
    expect(byDimension['binding-execution']).toMatchObject({
      dimension: 'binding-execution',
      status: 'incomplete',
    });
    expect(byDimension['registry-coverage']).toMatchObject({
      dimension: 'registry-coverage',
      status: 'complete',
    });
    expect(byDimension['project-scope']).toMatchObject({ status: 'incomplete' });
    expect(byDimension['selected-suite']).toMatchObject({ status: 'deferred' });
    expect(attribution.completeness.every((entry) => entry.qualification.trim().length > 0)).toBe(
      true,
    );
    expect(attribution.releaseCreditEligible).toBe(true);
    expect(attribution.coverageModelFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(attribution.obligations.length).toBeGreaterThan(0);
    expect(attribution.representatives.length).toBeGreaterThan(0);
    expect(attribution.obligationMappings.length).toBeGreaterThan(0);
  });

  it('keeps a diagnostic request Release-credit-ineligible but otherwise identical', () => {
    const release = planned(planCase(releaseRequest()));
    const diagnostic = planned(planCase(diagnosticRequest()));

    expect(diagnostic.outputs.coverageAttribution.releaseCreditEligible).toBe(false);
    expect(release.outputs.coverageAttribution.releaseCreditEligible).toBe(true);
    expect(correctnessProjection(diagnostic)).toEqual(correctnessProjection(release));
  });
});

describe('[Gate B] fail closed before launch (TS-1)', () => {
  it('blocks an unknown executable discriminant', () => {
    const result = planCase(
      request({
        operations: [{ discriminant: 'explode.everything', parameters: { force: true } }],
      }),
    );

    expectBlocked(result, 'UNKNOWN_OPERATION_DISCRIMINANT');
  });

  it('blocks an operation whose declared capability contradicts the request', () => {
    const result = planCase(
      request({
        capability: 'move',
        operations: [{ discriminant: 'history.undo', parameters: {} }],
      }),
    );

    expectBlocked(result, 'OPERATION_CAPABILITY_MISMATCH');
  });

  it('blocks a malformed request shape and unknown behavior/policy fields', () => {
    expectBlocked(
      planCase({ ...releaseRequest(), profile: 'sneaky' } as unknown as CaseRequest),
      'MALFORMED_CASE_REQUEST',
    );
    expectBlocked(
      planCase({ ...releaseRequest(), adapter: 'text-specialized' }),
      'MALFORMED_CASE_REQUEST',
    );
  });

  it('blocks a malformed intent value that has no deterministic canonical form', () => {
    const result = planCase(
      releaseRequest({
        ...baseIntent(),
        preState: { x: Number.NaN, y: 10 },
      }),
    );

    expectBlocked(result, 'MALFORMED_CASE_INTENT');
  });

  it('blocks a malformed Subject identity and an empty scenario', () => {
    expectBlocked(planCase(request({ subjectId: 'Layer/Text' })), 'MALFORMED_CASE_INTENT');
    expectBlocked(planCase(request({ scenario: '   ' })), 'MALFORMED_CASE_INTENT');
  });

  it('blocks when registry reconciliation fails', () => {
    const catalogue = cloneCatalogue(defaultBundle().subjectCatalogue);
    requireDeclaration(catalogue, 'layer/text').applicationKind = 'ghost';
    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), subjectCatalogue: catalogue },
    });

    expectBlocked(result, 'REGISTRY_HARNESS_BLOCKED');
    if (result.status === 'HARNESS_BLOCKED') {
      expect(result.findings.map((finding) => finding.code)).toContain('SUBJECT_SOURCE_STALE');
    }
  });

  it('blocks an unresolved Subject', () => {
    expectBlocked(planCase(request({ subjectId: 'layer/ghost' })), 'SUBJECT_UNRESOLVED');
  });

  it('blocks an unknown adapter or workflow declaration before launch', () => {
    const unknownAdapter = cloneCatalogue(defaultBundle().subjectCatalogue);
    requireDeclaration(unknownAdapter, 'layer/vector').adapter = {
      adapterId: 'ghost-specialized',
      compatibilityVersion: 1,
    };
    const adapterResult = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), subjectCatalogue: unknownAdapter },
    });
    expectBlocked(adapterResult, 'REGISTRY_HARNESS_BLOCKED');
    if (adapterResult.status === 'HARNESS_BLOCKED') {
      expect(adapterResult.findings.map((finding) => finding.code)).toContain(
        'SUBJECT_ADAPTER_UNKNOWN',
      );
    }

    const unknownWorkflow = cloneCatalogue(defaultBundle().subjectCatalogue);
    const textDeclaration = requireDeclaration(unknownWorkflow, 'layer/text');
    const moveBinding = textDeclaration.capabilityBindings.find(
      (binding) => binding.capability === 'move',
    );
    if (!moveBinding) throw new Error('layer/text move binding is missing');
    moveBinding.workflowId = 'shared.ghost';
    const workflowResult = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), subjectCatalogue: unknownWorkflow },
    });
    expectBlocked(workflowResult, 'REGISTRY_HARNESS_BLOCKED');
    if (workflowResult.status === 'HARNESS_BLOCKED') {
      expect(workflowResult.findings.map((finding) => finding.code)).toContain(
        'SUBJECT_WORKFLOW_UNKNOWN',
      );
    }
  });

  it('blocks an unsupported Capability', () => {
    expectBlocked(
      planCase(
        request({
          subjectId: 'selection/current',
          capability: 'rotate',
          operations: [{ discriminant: 'rotate.by', parameters: { degrees: 15 } }],
        }),
      ),
      'CAPABILITY_UNSUPPORTED',
    );
  });

  it('blocks an unknown variant when the binding is not variant-independent', () => {
    expectBlocked(
      planCase(
        request({
          subjectId: 'layer/text',
          capability: 'editContent',
          variant: 'warp-does-not-exist',
          operations: [{ discriminant: 'editContent.set', parameters: { text: 'Hi' } }],
        }),
      ),
      'SUBJECT_VARIANT_UNSUPPORTED',
    );
  });

  it('warns without blocking when an application kind has no Subject registration', () => {
    const baseline = planned(planCase(releaseRequest()));
    const inventory = cloneInventory(defaultBundle().applicationInventory);
    inventory.kinds.push('shape');
    inventory.kinds.sort();

    const result = planned(
      planCase(releaseRequest(), {
        catalogues: { ...defaultBundle(), applicationInventory: inventory },
      }),
    );

    expect(result.coverageStatus).toBe('incomplete');
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'SUBJECT_REGISTRATION_MISSING',
        severity: 'warning',
        applicationKind: 'shape',
      }),
    ]);
    expect(
      result.outputs.coverageAttribution.completeness.find(
        (entry) => entry.dimension === 'registry-coverage',
      ),
    ).toMatchObject({
      dimension: 'registry-coverage',
      status: 'incomplete',
    });
    // Coverage metadata only: the case identity and the closed plan are
    // unchanged, so the existing case stays runnable.
    expect(result.caseId).toBe(baseline.caseId);
    expect(result.planFingerprint).toBe(baseline.planFingerprint);
  });

  it('warns without blocking an unknown variant on a variant-independent binding', () => {
    const result = planned(
      planCase(
        request({
          subjectId: 'layer/text',
          capability: 'move',
          variant: 'unseen-runtime-variant',
        }),
      ),
    );

    expect(result.coverageStatus).toBe('incomplete');
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'SUBJECT_VARIANT_UNKNOWN', severity: 'warning' }),
    ]);
    expect(
      result.outputs.coverageAttribution.completeness.find(
        (entry) => entry.dimension === 'registry-coverage',
      ),
    ).toMatchObject({
      dimension: 'registry-coverage',
      status: 'incomplete',
    });
    expect(result.launchAttempted).toBe(false);
  });

  it('returns no correctness projection for a rejected attempt', () => {
    expect(correctnessProjection(planCase({ profile: 'sneaky' }))).toBeNull();
  });
});
