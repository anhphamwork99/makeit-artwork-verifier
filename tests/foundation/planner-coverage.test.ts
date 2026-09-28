import { describe, expect, it } from 'vitest';

import {
  deriveAbsentCoverageModelFingerprint,
  deriveCoverageModelFingerprint,
} from '../../src/catalogue/fingerprint';
import { planCase } from '../../src/planner/plan-case';
import type { CaseIntent, CaseRequest, PlanResult } from '../../src/contracts/case-model';
import type { DiagnosticCode } from '../../src/contracts/diagnostics';
import type { CoverageConstraint, CoverageFactor } from '../../src/contracts/coverage';
import type { BindingCoverageModel } from '../../src/contracts/coverage';
import type { Capability, ExecutionProfile } from '../../src/contracts/discriminants';
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

function expectBlocked(result: PlanResult, code: DiagnosticCode): void {
  expect(result.status).toBe('HARNESS_BLOCKED');
  if (result.status === 'HARNESS_BLOCKED') {
    expect(result.code).toBe(code);
    expect(result.diagnostic.severity).toBe('blocking');
    expect(
      result.report.stages.find((stage) => stage.outcome === 'rejected')?.stageId,
    ).toBeTruthy();
  }
  expect(result.launchAttempted).toBe(false);
  expect('plan' in result).toBe(false);
}

/** A self-consistent 12-factor × 6-value binding declaration: 6^12 assignments. */
function unboundedBindingModel(): BindingCoverageModel {
  const factors: CoverageFactor[] = Array.from({ length: 12 }, (_, factorIndex) => {
    const id = `factor-${String(factorIndex).padStart(2, '0')}`;
    const values = Array.from({ length: 6 }, (_, valueIndex) => ({
      id: `value-${valueIndex}`,
      value: valueIndex,
      partition: 'partition-all',
      boundary: false,
    }));
    return {
      id,
      label: id,
      path: `/${id}`,
      allowsConcreteValues: true,
      residual: true,
      values,
      partitions: [
        {
          id: 'partition-all',
          values: values.map((value) => value.id),
          representative: 'value-0',
          boundaries: [],
          validity: 'valid',
          rationale: 'Synthetic single valid partition.',
        },
      ],
    };
  });
  const baseline = Object.fromEntries(factors.map((factor) => [factor.id, 'value-0']));
  return {
    subjectId: 'layer/text',
    capability: 'move',
    baselineScenarioId: 'synthetic-baseline',
    factors,
    scenarios: [
      {
        id: 'synthetic-baseline',
        label: 'Synthetic baseline',
        description: 'Synthetic baseline assignment.',
        assignments: baseline,
        eligibility: 'release-required',
      },
    ],
    constraints: [],
    unsupported: [],
    obligations: [
      {
        id: 'synthetic-baseline-obligation',
        kind: 'baseline',
        description: 'Synthetic baseline obligation.',
        requiredFor: 'release',
        match: { kind: 'scenario', scenarioId: 'synthetic-baseline' },
      },
    ],
    residual: { policy: 'constrained', defaultStrength: 2, submodels: [], rationale: '' },
  };
}

function bindingRequest(
  subjectId: string,
  capability: Capability,
  discriminant: string,
  scenario: string,
  variant: string | null,
  profile: ExecutionProfile = 'release',
): CaseRequest {
  const intent: CaseIntent = {
    subjectId,
    capability,
    variant,
    scenario,
    preState: {},
    operations: [{ discriminant, parameters: {} }],
    expected: {},
    resources: [],
  };
  return profile === 'release'
    ? {
        schemaVersion: 1,
        profile: 'release',
        provenance: 'manifest',
        evidenceDepth: 'standard',
        intent,
      }
    : {
        schemaVersion: 1,
        profile: 'diagnostic',
        provenance: 'diagnostic-request',
        evidenceDepth: 'deep',
        intent,
      };
}

const REPRESENTATIVE_BINDINGS: ReadonlyArray<
  readonly [string, Capability, string, string, string | null]
> = [
  ['layer/text', 'move', 'move.by', 'drag-ordinary', 'plain'],
  ['layer/image', 'changeProperties', 'changeProperties.apply', 'replace-image', 'static'],
  ['container/object', 'changeContainment', 'changeContainment.to', 'contain-child', 'object'],
  ['container/object', 'move', 'move.by', 'move-child', 'object'],
  ['layer/crossword', 'create', 'create.generated', 'create-crossword', null],
  ['artwork/editor', 'history', 'history.undo', 'undo-redo-text', null],
  [
    'artwork/editor',
    'frontendSerializeRestore',
    'serialize.roundtrip',
    'serialize-roundtrip',
    null,
  ],
];

describe('[Coverage] coverage-aware planner integration (TS-1)', () => {
  it('resolves a real binding Coverage Model and records its fingerprint', () => {
    const result = planned(planCase(releaseRequest()));
    const model = defaultBundle().coverageCatalogue.models.find(
      (entry) => entry.subjectId === 'layer/text' && entry.capability === 'move',
    );
    if (!model) throw new Error('layer/text×move model is missing');

    expect(
      result.outputs.preflightReport.stages.find((stage) => stage.stageId === 'P4')?.outcome,
    ).toBe('resolved');
    expect(result.materializedCase.contracts.coverageModelFingerprint).toBe(
      deriveCoverageModelFingerprint(model),
    );
    expect(result.outputs.coverageAttribution.coverageModelFingerprint).toBe(
      deriveCoverageModelFingerprint(model),
    );
    expect(result.outputs.coverageAttribution.selectionPolicyVersion).toBe('coverage-selection/v1');
    expect(result.outputs.coverageAttribution.selectionInputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.outputs.coverageAttribution.selectedCaseKeys.length).toBeGreaterThan(0);
  });

  it('plans every representative binding model as binding-model complete', () => {
    const fingerprints = new Set<string>();
    for (const [
      subjectId,
      capability,
      discriminant,
      scenario,
      variant,
    ] of REPRESENTATIVE_BINDINGS) {
      const result = planned(
        planCase(bindingRequest(subjectId, capability, discriminant, scenario, variant)),
      );
      const attribution = result.outputs.coverageAttribution;
      const bindingModel = attribution.completeness.find(
        (entry) => entry.dimension === 'binding-model',
      );
      expect(bindingModel?.status).toBe('complete');
      expect(attribution.coverageModelFingerprint).toMatch(/^[0-9a-f]{64}$/);
      if (attribution.coverageModelFingerprint)
        fingerprints.add(attribution.coverageModelFingerprint);
    }
    // Each binding resolves its own coverage identity.
    expect(fingerprints.size).toBe(REPRESENTATIVE_BINDINGS.length);
  });

  it('warns and reports incomplete coverage for a binding with no Coverage Model', () => {
    const result = planned(
      planCase(bindingRequest('layer/starmap', 'move', 'move.by', 'drag-starmap', null)),
    );

    expect(result.findings.map((finding) => finding.code)).toContain('COVERAGE_MODEL_MISSING');
    expect(result.findings.every((finding) => finding.severity === 'warning')).toBe(true);
    expect(
      result.outputs.coverageAttribution.completeness.find(
        (entry) => entry.dimension === 'binding-model',
      )?.status,
    ).toBe('incomplete');
    expect(result.outputs.coverageAttribution.releaseCreditEligible).toBe(false);
    expect(result.materializedCase.contracts.coverageModelFingerprint).toBe(
      deriveAbsentCoverageModelFingerprint('layer/starmap', 'move'),
    );
  });

  it('blocks a declared but invalid Coverage Model before launch', () => {
    const catalogue = structuredClone(defaultBundle().coverageCatalogue);
    const model = catalogue.models.find(
      (entry) => entry.subjectId === 'layer/text' && entry.capability === 'move',
    );
    if (!model) throw new Error('layer/text×move model is missing');
    model.scenarios[0].assignments = { 'ghost-factor': 'ghost-value' };

    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), coverageCatalogue: catalogue },
    });
    expectBlocked(result, 'COVERAGE_REFERENCE_UNKNOWN');
  });

  it('rejects a binding that declares no required authoritative check', () => {
    const subjectCatalogue = cloneCatalogue(defaultBundle().subjectCatalogue);
    const declaration = requireDeclaration(subjectCatalogue, 'layer/text');
    const binding = declaration.capabilityBindings.find((entry) => entry.capability === 'move');
    if (!binding) throw new Error('layer/text move binding is missing');
    binding.checks = [];

    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), subjectCatalogue },
    });
    expectBlocked(result, 'CAPABILITY_BINDING_NO_CHECKS');
  });

  it('changes materializationFingerprint but not caseId when the Coverage Model changes', () => {
    const base = planned(planCase(releaseRequest()));
    const catalogue = structuredClone(defaultBundle().coverageCatalogue);
    const model = catalogue.models.find(
      (entry) => entry.subjectId === 'layer/text' && entry.capability === 'move',
    );
    if (!model) throw new Error('layer/text×move model is missing');
    (model.constraints as CoverageConstraint[]).push({
      id: 'extra-constraint',
      exclude: { displacement: 'small', interaction: 'keyboard-nudge' },
      rationale: 'Contract revision fixture.',
    });

    const revised = planned(
      planCase(releaseRequest(), {
        catalogues: { ...defaultBundle(), coverageCatalogue: catalogue },
      }),
    );

    expect(revised.caseId).toBe(base.caseId);
    expect(revised.materializationFingerprint).not.toBe(base.materializationFingerprint);
    expect(revised.outputs.coverageAttribution.coverageModelFingerprint).not.toBe(
      base.outputs.coverageAttribution.coverageModelFingerprint,
    );
  });

  it('keeps diagnostic concrete values and resources outside Release credit', () => {
    const baseline = planned(planCase(diagnosticRequest()));
    const override = planned(
      planCase(diagnosticRequest(baseIntent({ preState: { renderingMode: 'warp-wave' } }))),
    );

    // A declared non-representative concrete value changes caseId but earns no credit.
    expect(override.caseId).not.toBe(baseline.caseId);
    expect(override.outputs.coverageAttribution.releaseCreditEligible).toBe(false);

    const releaseBase = planned(planCase(releaseRequest()));
    const resourcesA = planned(
      planCase(
        releaseRequest(
          baseIntent({ resources: [{ resourceId: 'r', contentDigest: 'sha256:aaa' }] }),
        ),
      ),
    );
    const resourcesB = planned(
      planCase(
        releaseRequest(
          baseIntent({ resources: [{ resourceId: 'r', contentDigest: 'sha256:bbb' }] }),
        ),
      ),
    );

    expect(resourcesA.caseId).not.toBe(resourcesB.caseId);
    expect(resourcesA.outputs.coverageAttribution.releaseCreditEligible).toBe(true);
    expect(resourcesB.outputs.coverageAttribution.releaseCreditEligible).toBe(true);
    expect(releaseBase.outputs.coverageAttribution.releaseCreditEligible).toBe(true);
  });

  it('blocks an invalid diagnostic concrete value and a Release substitution', () => {
    expectBlocked(
      planCase(diagnosticRequest(baseIntent({ preState: { renderingMode: 'hologram' } }))),
      'COVERAGE_VALUE_INVALID',
    );
    expectBlocked(
      planCase(releaseRequest(baseIntent({ preState: { renderingMode: 'warp-wave' } }))),
      'COVERAGE_VALUE_INVALID',
    );
  });

  it('blocks a Release request that selects a diagnostic-only negative scenario', () => {
    expectBlocked(
      planCase(releaseRequest(baseIntent({ scenario: 'drag-negative-zero-displacement' }))),
      'COVERAGE_SCENARIO_INELIGIBLE',
    );

    const diagnostic = planned(
      planCase(diagnosticRequest(baseIntent({ scenario: 'drag-negative-zero-displacement' }))),
    );
    expect(diagnostic.outputs.coverageAttribution.releaseCreditEligible).toBe(false);
    expect(diagnostic.outputs.coverageAttribution.obligations).toContain(
      'negative-zero-displacement',
    );
  });

  it('blocks a request that violates a declared constraint or an unsupported combination', () => {
    expectBlocked(
      planCase(
        diagnosticRequest(
          baseIntent({ preState: { interaction: 'keyboard-nudge', displacement: 'large' } }),
        ),
      ),
      'COVERAGE_CONSTRAINT_VIOLATED',
    );
    expectBlocked(
      planCase(
        diagnosticRequest(
          baseIntent({
            preState: { interaction: 'keyboard-nudge', renderingMode: 'warp-distort' },
          }),
        ),
      ),
      'COVERAGE_COMBINATION_UNSUPPORTED',
    );
  });

  it('keeps Planned and Diagnostic correctness identical while coverage credit differs', () => {
    const release = planned(planCase(releaseRequest()));
    const diagnostic = planned(planCase(diagnosticRequest()));

    // The requested case is the same semantic case; Diagnostic additionally
    // expands diagnostic-only obligations, so only the case-level obligations
    // and correctness identity are compared here.
    expect(diagnostic.caseId).toBe(release.caseId);
    expect(diagnostic.outputs.coverageAttribution.obligations).toEqual(
      release.outputs.coverageAttribution.obligations,
    );
    expect(diagnostic.outputs.coverageAttribution.representatives).toEqual(
      release.outputs.coverageAttribution.representatives,
    );
    expect(release.outputs.coverageAttribution.releaseCreditEligible).toBe(true);
    expect(diagnostic.outputs.coverageAttribution.releaseCreditEligible).toBe(false);
  });

  it('blocks planning when an unrequested catalogue model is semantically invalid', () => {
    const catalogue = structuredClone(defaultBundle().coverageCatalogue);
    const other = catalogue.models.find(
      (entry) => entry.subjectId === 'artwork/editor' && entry.capability === 'history',
    );
    if (!other) throw new Error('artwork/editor×history model is missing');
    (other.constraints as CoverageConstraint[]).push({
      id: 'invalid-unrequested-constraint',
      exclude: { 'ghost-factor': 'ghost-value' },
      rationale: 'Test-only invalid reference on an unrequested binding.',
    });

    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), coverageCatalogue: catalogue },
    });
    expectBlocked(result, 'COVERAGE_REFERENCE_UNKNOWN');
    if (result.status === 'HARNESS_BLOCKED') {
      expect(result.report.stages.find((stage) => stage.outcome === 'rejected')?.stageId).toBe(
        'P1',
      );
    }
  });

  it('blocks a partial scenario before planning any binding', () => {
    const catalogue = structuredClone(defaultBundle().coverageCatalogue);
    const model = catalogue.models.find(
      (entry) => entry.subjectId === 'layer/text' && entry.capability === 'move',
    );
    if (!model) throw new Error('layer/text×move model is missing');
    const scenario = model.scenarios.find((entry) => entry.id === 'drag-ordinary');
    if (!scenario) throw new Error('drag-ordinary scenario is missing');
    delete (scenario.assignments as Record<string, string>)['rendering-mode'];

    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), coverageCatalogue: catalogue },
    });
    expectBlocked(result, 'COVERAGE_SCENARIO_INCOMPLETE');
  });

  it('blocks a baseline scenario that is not release-required', () => {
    const catalogue = structuredClone(defaultBundle().coverageCatalogue);
    const model = catalogue.models.find(
      (entry) => entry.subjectId === 'layer/text' && entry.capability === 'move',
    );
    if (!model) throw new Error('layer/text×move model is missing');
    const baseline = model.scenarios.find((entry) => entry.id === model.baselineScenarioId);
    if (!baseline) throw new Error('baseline scenario is missing');
    (baseline as { eligibility: string }).eligibility = 'diagnostic-only';

    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), coverageCatalogue: catalogue },
    });
    expectBlocked(result, 'COVERAGE_BASELINE_INVALID');
  });

  it('blocks a silent residual-policy opt-out on a multi-factor model', () => {
    const catalogue = structuredClone(defaultBundle().coverageCatalogue);
    const model = catalogue.models.find(
      (entry) => entry.subjectId === 'layer/image' && entry.capability === 'changeProperties',
    );
    if (!model) throw new Error('layer/image×changeProperties model is missing');
    const fit = model.factors.find((factor) => factor.id === 'fit');
    if (!fit) throw new Error('fit factor is missing');
    (fit as { residual: boolean }).residual = false;

    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), coverageCatalogue: catalogue },
    });
    expectBlocked(result, 'COVERAGE_RESIDUAL_POLICY_INVALID');
  });

  it('executes an undeclared variant-independent runtime variant without Release credit', () => {
    const result = planned(
      planCase(
        bindingRequest('layer/text', 'move', 'move.by', 'drag-ordinary', 'unseen-runtime-variant'),
      ),
    );
    const attribution = result.outputs.coverageAttribution;

    // The runtime variant may execute, but it earns no Release credit and never
    // implies variant coverage.
    expect(result.outputs.preflightReport.status).toBe('PLANNED');
    expect(attribution.releaseCreditEligible).toBe(false);
    expect(attribution.releaseCreditBlockers).toContain('variant-undeclared');
    expect(attribution.releaseCreditBasis).toContain('variant-undeclared');
    const registry = attribution.completeness.find(
      (entry) => entry.dimension === 'registry-coverage',
    );
    expect(registry?.status).toBe('incomplete');
    expect(registry?.qualification).toContain('unseen-runtime-variant');
    expect(registry?.qualification).toContain('establishes no coverage');
  });

  it('qualifies registry coverage by its actual state instead of one generic string', () => {
    const release = planned(planCase(releaseRequest()));
    const complete = release.outputs.coverageAttribution.completeness.find(
      (entry) => entry.dimension === 'registry-coverage',
    );
    expect(complete?.status).toBe('complete');
    expect(complete?.qualification).toMatch(/complete/i);

    const inventory = cloneInventory(defaultBundle().applicationInventory);
    inventory.kinds.push('shape');
    inventory.kinds.sort();
    const gap = planned(
      planCase(releaseRequest(), {
        catalogues: { ...defaultBundle(), applicationInventory: inventory },
      }),
    );
    const incomplete = gap.outputs.coverageAttribution.completeness.find(
      (entry) => entry.dimension === 'registry-coverage',
    );
    expect(incomplete?.status).toBe('incomplete');
    expect(incomplete?.qualification).toMatch(/incomplete/i);
    expect(incomplete?.qualification).toContain('1 application kind');
    expect(incomplete?.qualification).not.toBe(complete?.qualification);
  });

  it('records an explicit Release-credit basis with no blockers when eligible', () => {
    const eligible = planned(planCase(releaseRequest()));
    const attribution = eligible.outputs.coverageAttribution;

    expect(attribution.releaseCreditEligible).toBe(true);
    expect(attribution.releaseCreditBlockers).toEqual([]);
    expect(attribution.releaseCreditBasis.trim().length).toBeGreaterThan(0);
  });

  it('fails closed quickly on a 12×6 catalogue model without enumerating it', () => {
    const catalogue = structuredClone(defaultBundle().coverageCatalogue);
    const models = catalogue.models as BindingCoverageModel[];
    const modelIndex = models.findIndex(
      (entry) => entry.subjectId === 'layer/text' && entry.capability === 'move',
    );
    if (modelIndex < 0) throw new Error('layer/text×move model is missing');
    models[modelIndex] = unboundedBindingModel();

    const startedAt = Date.now();
    const result = planCase(releaseRequest(), {
      catalogues: { ...defaultBundle(), coverageCatalogue: catalogue },
    });
    const elapsedMs = Date.now() - startedAt;

    expectBlocked(result, 'COVERAGE_UNIVERSE_UNBOUNDED');
    if (result.status === 'HARNESS_BLOCKED') {
      expect(result.report.stages.find((stage) => stage.outcome === 'rejected')?.stageId).toBe(
        'P1',
      );
      expect(result.diagnostic.context.universeSize).toBe('2176782336');
    }
    expect(elapsedMs).toBeLessThan(1000);
  });
});

const ORDINARY_AMBIGUOUS_INTENT: CaseIntent = baseIntent({
  variant: 'plain',
  scenario: 'drag-ordinary-ambiguous',
});

const WARPED_AMBIGUOUS_INTENT: CaseIntent = baseIntent({
  variant: 'warp-circle',
  scenario: 'drag-warped-nested-ambiguous',
  preState: { x: 125, y: 125 },
});

describe('[Coverage] governed diagnostic-only Text ambiguity (ADR 0012 R1/R2/R4/R7)', () => {
  it.each([
    ['ordinary', ORDINARY_AMBIGUOUS_INTENT, 'plain'],
    ['circle-warped', WARPED_AMBIGUOUS_INTENT, 'warp-circle'],
  ] as const)('plans the %s ambiguity scenario through the normal shared.move pipeline', (_label, intent, expectedVariant) => {
    const result = planned(planCase(diagnosticRequest(intent)));

    expect(result.materializedCase.intent.scenario).toBe(intent.scenario);
    expect(result.materializedCase.intent.variant).toBe(expectedVariant);
    expect(result.plan.route.workflowId).toBe('shared.move');
    expect(result.plan.route.adapterId).toBe('text-specialized');
    expect(result.plan.route.adapterCompatibilityVersion).toBe(3);
    const stages = result.outputs.preflightReport.stages;
    expect(stages.find((stage) => stage.stageId === 'P5')?.outcome).toBe('resolved');
    expect(stages.find((stage) => stage.stageId === 'P7')?.outcome).toBe('resolved');

    const attribution = result.outputs.coverageAttribution;
    expect(attribution.releaseCreditEligible).toBe(false);
    expect(attribution.releaseCreditBlockers).toContain('profile-not-release');
    expect(attribution.releaseCreditBlockers).toContain('provenance-not-manifest');
    expect(attribution.releaseCreditBlockers).toContain('scenario-not-release-required');
    // A harness-resolution failure earns no behavioral obligation of its own.
    expect(attribution.obligations).not.toContain(intent.scenario);
  });

  it.each([
    ['ordinary', ORDINARY_AMBIGUOUS_INTENT],
    ['circle-warped', WARPED_AMBIGUOUS_INTENT],
  ] as const)('rejects a Release request for the %s ambiguity scenario before launch', (_label, intent) => {
    expectBlocked(planCase(releaseRequest(intent)), 'COVERAGE_SCENARIO_INELIGIBLE');
  });
});
