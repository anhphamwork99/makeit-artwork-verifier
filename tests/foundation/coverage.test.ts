import { describe, expect, it } from 'vitest';

import { deriveCoverageModelFingerprint } from '../../src/catalogue/fingerprint';
import {
  buildModelCompleteness,
  deriveCoverageCompleteness,
  validateCoverageCompleteness,
} from '../../src/coverage/account';
import { CoverageCatalogueError, parseCoverageModelCatalogue } from '../../src/coverage/load';
import { resolveCaseCoverage } from '../../src/coverage/resolve';
import { selectCoverage } from '../../src/coverage/select';
import {
  CoverageUniverseUnboundedError,
  computeUniverseSize,
  enumerateUniverse,
  indexFactors,
  validateCoverageCatalogue,
  validateCoverageModel,
} from '../../src/coverage/validate';
import {
  COVERAGE_MAX_UNIVERSE_ASSIGNMENTS,
  type BindingCoverageModel,
  type CoverageConstraint,
  type CoverageFactor,
  type CoverageModelCatalogue,
  type CoverageSelection,
} from '../../src/contracts/coverage';
import type { Capability } from '../../src/contracts/discriminants';
import type { DiagnosticCode } from '../../src/contracts/diagnostics';
import { baseIntent, defaultBundle } from './helpers';

function catalogue(): CoverageModelCatalogue {
  return defaultBundle().coverageCatalogue;
}

function bindingModel(
  source: CoverageModelCatalogue,
  subjectId: string,
  capability: Capability,
): BindingCoverageModel {
  const model = source.models.find(
    (entry) => entry.subjectId === subjectId && entry.capability === capability,
  );
  if (!model) throw new Error(`Fixture model "${subjectId}×${capability}" is missing`);
  return model;
}

function codes(findings: readonly { code: DiagnosticCode }[]): DiagnosticCode[] {
  return findings.map((finding) => finding.code);
}

function rawCatalogue(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(catalogue())) as Record<string, unknown>;
}

function entryValue(assignment: Readonly<Record<string, string>>, factorId: string): string {
  const value = assignment[factorId];
  if (value === undefined) throw new Error(`Fixture assignment is missing factor "${factorId}"`);
  return value;
}

/**
 * A synthetic 12-factor × 6-value declaration: 6^12 attemptable assignments.
 * It exists only to prove the analytic bound fails closed before enumeration.
 */
function unboundedModel(): BindingCoverageModel {
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
    subjectId: 'layer/synthetic',
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
    residual: {
      policy: 'constrained',
      defaultStrength: 2,
      submodels: [],
      rationale: '',
    },
  };
}

describe('[Coverage] versioned binding models and strict loader (TS-1)', () => {
  it('loads the representative binding models required for the current phase', () => {
    const loaded = catalogue();

    expect(loaded.schemaVersion).toBe(1);
    const bindings = loaded.models.map((model) => `${model.subjectId}×${model.capability}`);
    expect(bindings).toEqual(
      expect.arrayContaining([
        'layer/text×move',
        'layer/image×changeProperties',
        'container/object×changeContainment',
        'container/object×move',
        'layer/crossword×create',
        'artwork/editor×history',
        'artwork/editor×frontendSerializeRestore',
      ]),
    );
  });

  it('validates every authored binding model without a blocking finding', () => {
    expect(validateCoverageCatalogue(catalogue())).toEqual([]);
  });

  it('rejects a duplicate identifier as a structured loader failure', () => {
    const raw = rawCatalogue();
    const models = raw.models as Record<string, unknown>[];
    const first = models[0];
    const factors = first.factors as Record<string, unknown>[];
    factors.push(structuredClone(factors[0]));

    let thrown: unknown;
    try {
      parseCoverageModelCatalogue(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoverageCatalogueError);
    expect((thrown as CoverageCatalogueError).diagnostic.code).toBe('COVERAGE_CATALOGUE_DUPLICATE');
  });

  it('fails closed on an invalid partition representative', () => {
    const mutable = structuredClone(catalogue());
    const model = bindingModel(mutable, 'layer/text', 'move');
    const partition = model.factors.find((factor) => factor.id === 'rendering-mode')?.partitions[0];
    if (!partition) throw new Error('rendering-mode partition is missing');
    partition.representative = 'not-a-declared-value';

    const findings = validateCoverageModel(model);
    expect(codes(findings)).toContain('COVERAGE_PARTITION_INVALID');
  });

  it('fails closed on an unknown reference', () => {
    const mutable = structuredClone(catalogue());
    const model = bindingModel(mutable, 'layer/text', 'move');
    const scenario = model.scenarios.find((entry) => entry.id === 'drag-ordinary');
    if (!scenario) throw new Error('drag-ordinary scenario is missing');
    (scenario.assignments as Record<string, string>)['ghost-factor'] = 'ghost-value';

    const findings = validateCoverageModel(model);
    expect(codes(findings)).toContain('COVERAGE_REFERENCE_UNKNOWN');
  });

  it('fails closed on a constraint that excludes the baseline assignment', () => {
    const mutable = structuredClone(catalogue());
    const model = bindingModel(mutable, 'layer/text', 'move');
    const baseline = model.scenarios.find((entry) => entry.id === 'drag-ordinary');
    if (!baseline) throw new Error('drag-ordinary scenario is missing');
    (model.constraints as CoverageConstraint[]).push({
      id: 'exclude-baseline',
      exclude: baseline.assignments,
      rationale: 'Test-only contradiction.',
    });

    const findings = validateCoverageModel(model);
    expect(codes(findings)).toContain('COVERAGE_CONSTRAINT_CONTRADICTORY');
  });

  it('fails closed when a constraint silently removes a mandatory obligation', () => {
    const mutable = structuredClone(catalogue());
    const model = bindingModel(mutable, 'layer/text', 'move');
    (model.constraints as CoverageConstraint[]).push({
      id: 'exclude-keyboard-nudge',
      exclude: { interaction: 'keyboard-nudge' },
      rationale: 'Test-only obligation removal.',
    });

    const findings = validateCoverageModel(model);
    expect(codes(findings)).toContain('COVERAGE_OBLIGATION_UNSATISFIABLE');
    expect(
      findings.find((finding) => finding.code === 'COVERAGE_OBLIGATION_UNSATISFIABLE')?.severity,
    ).toBe('blocking');
  });

  it('is stable under authoring-order changes for models, factors, scenarios and obligations', () => {
    const baseline = catalogue();
    const reorderedRaw = {
      schemaVersion: 1,
      models: [...baseline.models].reverse().map((model) => ({
        ...model,
        factors: [...model.factors].reverse(),
        scenarios: [...model.scenarios].reverse(),
        obligations: [...model.obligations].reverse(),
        constraints: [...model.constraints].reverse(),
        unsupported: [...model.unsupported].reverse(),
        residual: { ...model.residual, submodels: [...model.residual.submodels].reverse() },
      })),
    };
    const reordered = parseCoverageModelCatalogue(reorderedRaw);

    expect(reordered.models).toEqual(baseline.models);
    for (const model of baseline.models) {
      const left = deriveCoverageModelFingerprint(model);
      const right = deriveCoverageModelFingerprint(
        bindingModel(reordered, model.subjectId, model.capability),
      );
      expect(right).toBe(left);
    }
  });
});

describe('[Coverage] deterministic constrained selection (TS-1)', () => {
  it('selects the same cases, order, mappings and fingerprint for identical input', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const options = {
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release' as const,
    };

    const first = selectCoverage(options);
    const second = selectCoverage(options);

    expect(second).toEqual(first);
    expect(first.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.policyVersion).toBe('coverage-selection/v1');
  });

  it('covers every required residual tuple pairwise and maps every obligation', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });

    expect(selection.tupleCoverage.pairwise.strength).toBe(2);
    expect(selection.tupleCoverage.pairwise.required).toBeGreaterThan(0);
    expect(selection.tupleCoverage.pairwise.covered).toBe(
      selection.tupleCoverage.pairwise.required,
    );
    expect(selection.tupleCoverage.pairwise.uncovered).toEqual([]);
    expect(selection.uncoveredObligations).toEqual([]);
    expect(selection.obligationMappings.every((mapping) => mapping.satisfied)).toBe(true);
    expect(buildModelCompleteness(selection).complete).toBe(true);
  });

  it('excludes diagnostic-only negative scenarios from Release selection', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const fingerprint = deriveCoverageModelFingerprint(model);

    const release = selectCoverage({ model, modelFingerprint: fingerprint, profile: 'release' });
    const diagnostic = selectCoverage({
      model,
      modelFingerprint: fingerprint,
      profile: 'diagnostic',
      seed: 7,
    });

    expect(
      release.obligationMappings.some(
        (entry) => entry.obligationId === 'negative-zero-displacement',
      ),
    ).toBe(false);
    expect(release.cases.some((entry) => entry.assignments.displacement === 'zero')).toBe(false);

    const negativeMapping = diagnostic.obligationMappings.find(
      (entry) => entry.obligationId === 'negative-zero-displacement',
    );
    expect(negativeMapping?.satisfied).toBe(true);
    expect(diagnostic.cases.some((entry) => entry.assignments.displacement === 'zero')).toBe(true);
    expect(
      diagnostic.cases.find((entry) => entry.assignments.displacement === 'zero')?.releaseEligible,
    ).toBe(false);
    // The selector performs deterministic exhaustive selection and no sampling,
    // so no supplied seed is recorded or identity-affecting.
    expect(release.seed).toBeNull();
    expect(diagnostic.seed).toBeNull();
  });

  it('honours a declared bounded stronger submodel instead of pairwise only', () => {
    const model = bindingModel(catalogue(), 'container/object', 'changeContainment');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });
    const { valid } = enumerateUniverse(model, indexFactors(model));

    const tripleKeys = new Set(
      selection.cases.map((entry) =>
        ['ancestor-transform', 'depth', 'destination']
          .map((factorId) => `${factorId}=${entry.assignments[factorId]}`)
          .join('|'),
      ),
    );

    for (const assignment of valid) {
      const key = ['ancestor-transform', 'depth', 'destination']
        .map((factorId) => `${factorId}=${entryValue(assignment, factorId)}`)
        .join('|');
      expect(tripleKeys.has(key)).toBe(true);
    }
  });

  it('separates default pairwise coverage from each bounded stronger submodel', () => {
    const model = bindingModel(catalogue(), 'container/object', 'changeContainment');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });
    const { valid } = enumerateUniverse(model, indexFactors(model));

    // The default level is pairwise only and carries no 3-wise aggregation.
    expect(selection.tupleCoverage.pairwise.strength).toBe(2);
    expect(selection.tupleCoverage.pairwise.factors).toEqual([
      'ancestor-transform',
      'depth',
      'destination',
    ]);
    expect(selection.tupleCoverage.pairwise.uncovered).toEqual([]);

    const distinctPairs = new Set<string>();
    for (const assignment of valid) {
      for (const [left, right] of [
        ['ancestor-transform', 'depth'],
        ['ancestor-transform', 'destination'],
        ['depth', 'destination'],
      ]) {
        distinctPairs.add(
          [`${left}=${entryValue(assignment, left)}`, `${right}=${entryValue(assignment, right)}`]
            .sort()
            .join('|'),
        );
      }
    }
    expect(selection.tupleCoverage.pairwise.required).toBe(distinctPairs.size);

    // The declared 3-wise submodel is reported as its own level, never folded
    // into `strength: 2`.
    expect(selection.tupleCoverage.submodels).toHaveLength(1);
    const stronger = selection.tupleCoverage.submodels[0];
    expect(stronger.submodelId).toBe('containment-three-way');
    expect(stronger.strength).toBe(3);
    expect(stronger.factors).toEqual(['ancestor-transform', 'depth', 'destination']);
    expect(stronger.required).toBe(valid.length);
    expect(stronger.covered).toBe(stronger.required);
    expect(stronger.uncovered).toEqual([]);
    expect(buildModelCompleteness(selection).complete).toBe(true);
  });

  it('fails closed on a request that violates a declared constraint', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const resolution = resolveCaseCoverage({
      model,
      profile: 'diagnostic',
      provenance: 'diagnostic-request',
      intent: baseIntent({
        preState: { interaction: 'keyboard-nudge', displacement: 'large' },
      }),
    });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.finding.code).toBe('COVERAGE_CONSTRAINT_VIOLATED');
  });

  it('fails closed on a request that matches an unsupported combination', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const resolution = resolveCaseCoverage({
      model,
      profile: 'diagnostic',
      provenance: 'diagnostic-request',
      intent: baseIntent({
        preState: { interaction: 'keyboard-nudge', renderingMode: 'warp-distort' },
      }),
    });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.finding.code).toBe('COVERAGE_COMBINATION_UNSUPPORTED');
  });

  it('excludes a diagnostic-only negative scenario from a Release request', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const resolution = resolveCaseCoverage({
      model,
      profile: 'release',
      provenance: 'manifest',
      intent: baseIntent({ scenario: 'drag-negative-zero-displacement' }),
    });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.finding.code).toBe('COVERAGE_SCENARIO_INELIGIBLE');
  });
});

describe('[Coverage] qualified completeness accounting (TS-1)', () => {
  it('emits exactly the five qualified completeness dimensions, never an unqualified complete', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });
    const entries = deriveCoverageCompleteness({
      bindingModelPresent: true,
      bindingModelComplete: buildModelCompleteness(selection).complete,
      bindingModelQualification: buildModelCompleteness(selection).qualification,
      registryCoverageStatus: 'complete',
      registryQualification: 'registry reconciled',
      projectScopeComplete: false,
      projectScopeQualification: 'other bindings are not modeled and nothing is executed',
    });

    expect(entries.map((entry) => entry.dimension)).toEqual([
      'binding-execution',
      'binding-model',
      'project-scope',
      'registry-coverage',
      'selected-suite',
    ]);
    expect(entries.every((entry) => entry.qualification.trim().length > 0)).toBe(true);
    expect(validateCoverageCompleteness(entries)).toEqual([]);
  });

  it('fails closed on unqualified or incomplete completeness claims', () => {
    const findings = validateCoverageCompleteness([
      {
        dimension: 'binding-model',
        status: 'complete',
        qualification: '',
      },
    ] as never);

    expect(codes(findings)).toContain('COVERAGE_UNQUALIFIED_COMPLETENESS');
    expect(findings.every((finding) => finding.severity === 'blocking')).toBe(true);
    const missing = findings.find((finding) => finding.detail.includes('missing dimension'));
    expect(missing).toBeDefined();
  });

  it('reports a missing binding model as incomplete rather than complete', () => {
    const entries = deriveCoverageCompleteness({
      bindingModelPresent: false,
      bindingModelComplete: false,
      bindingModelQualification: 'no model',
      registryCoverageStatus: 'complete',
      registryQualification: 'registry reconciled',
      projectScopeComplete: false,
      projectScopeQualification: 'binding is not modeled',
    });

    expect(entries.find((entry) => entry.dimension === 'binding-model')?.status).toBe('incomplete');
  });
});

describe('[Coverage] analytic Cartesian boundedness (TS-1)', () => {
  it('bounds a 12-factor × 6-value declaration analytically before enumeration', () => {
    const model = unboundedModel();
    const index = indexFactors(model);

    const startedAt = Date.now();
    const size = computeUniverseSize(model, index);
    const elapsedMs = Date.now() - startedAt;

    expect(size).toBe(6 ** 12);
    expect(size).toBe(2176782336);
    expect(size).toBeGreaterThan(COVERAGE_MAX_UNIVERSE_ASSIGNMENTS);
    expect(elapsedMs).toBeLessThan(250);

    const findings = validateCoverageModel(model);
    const boundedness = findings.find((finding) => finding.code === 'COVERAGE_UNIVERSE_UNBOUNDED');
    expect(boundedness).toBeDefined();
    expect(boundedness?.severity).toBe('blocking');
    expect(boundedness?.context.universeSize).toBe('2176782336');

    const enumStartedAt = Date.now();
    let thrown: unknown;
    try {
      enumerateUniverse(model, index);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoverageUniverseUnboundedError);
    expect((thrown as CoverageUniverseUnboundedError).diagnostic.code).toBe(
      'COVERAGE_UNIVERSE_UNBOUNDED',
    );
    expect(Date.now() - enumStartedAt).toBeLessThan(250);

    expect(() =>
      selectCoverage({ model, modelFingerprint: 'unbounded-fixture', profile: 'release' }),
    ).toThrowError(CoverageUniverseUnboundedError);
  });

  it('keeps every authored binding model inside the declared bound', () => {
    const source = catalogue();
    for (const model of source.models) {
      expect(computeUniverseSize(model, indexFactors(model))).toBeLessThanOrEqual(
        COVERAGE_MAX_UNIVERSE_ASSIGNMENTS,
      );
      expect(validateCoverageModel(model)).toEqual([]);
    }
    expect(validateCoverageCatalogue(source)).toEqual([]);
  });
});

describe('[Coverage] honest scenario attribution and explicit Release basis (TS-1)', () => {
  it('never attributes a generated case to a declared scenario it does not exactly match', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });

    for (const entry of selection.cases) {
      if (entry.scenarioId === null) continue;
      const scenario = model.scenarios.find((candidate) => candidate.id === entry.scenarioId);
      expect(scenario).toBeDefined();
      if (!scenario) continue;
      for (const [factorId, valueId] of Object.entries(scenario.assignments)) {
        expect(entry.assignments[factorId]).toBe(valueId);
      }
    }

    // The large-displacement boundary case matches no declared scenario, so it
    // must be a non-scenario case rather than a false baseline attribution.
    const boundary = selection.cases.find((entry) => entry.assignments.displacement === 'large');
    expect(boundary).toBeDefined();
    expect(boundary?.scenarioId).toBeNull();
    expect(boundary?.releaseBasis).toBe('non-scenario-release-assignment');
    expect(boundary?.releaseEligible).toBe(true);
  });

  it('generates non-scenario cases that keep honest Release eligibility', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });

    const generated = selection.cases.filter((entry) => entry.scenarioId === null);
    expect(generated.length).toBeGreaterThan(0);
    expect(
      generated.every((entry) => entry.releaseBasis === 'non-scenario-release-assignment'),
    ).toBe(true);
    expect(generated.every((entry) => entry.releaseEligible)).toBe(true);
    expect(
      selection.cases.every((entry) => entry.scenarioId !== null || entry.origin !== 'baseline'),
    ).toBe(true);
  });

  it('labels a diagnostic-only scenario case with an explicit diagnostic basis', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'diagnostic',
      seed: 12,
    });

    const negative = selection.cases.find((entry) => entry.assignments.displacement === 'zero');
    expect(negative?.scenarioId).toBe('drag-negative-zero-displacement');
    expect(negative?.releaseBasis).toBe('declared-diagnostic-scenario');
    expect(negative?.releaseEligible).toBe(false);
  });
});

describe('[Coverage] canonical baseline and residual-policy integrity (TS-1)', () => {
  it('blocks a baseline scenario that is not release-required', () => {
    const model = structuredClone(bindingModel(catalogue(), 'layer/text', 'move'));
    const baseline = model.scenarios.find((scenario) => scenario.id === model.baselineScenarioId);
    if (!baseline) throw new Error('baseline scenario is missing');
    (baseline as { eligibility: string }).eligibility = 'diagnostic-only';

    const findings = validateCoverageModel(model);
    expect(codes(findings)).toContain('COVERAGE_BASELINE_INVALID');
    expect(findings.find((entry) => entry.code === 'COVERAGE_BASELINE_INVALID')?.severity).toBe(
      'blocking',
    );
  });

  it('blocks a scenario that does not name exactly every Factor once', () => {
    const model = structuredClone(bindingModel(catalogue(), 'layer/text', 'move'));
    const scenario = model.scenarios.find((entry) => entry.id === 'drag-ordinary');
    if (!scenario) throw new Error('drag-ordinary scenario is missing');
    delete (scenario.assignments as Record<string, string>)['rendering-mode'];

    const findings = validateCoverageModel(model);
    expect(codes(findings)).toContain('COVERAGE_SCENARIO_INCOMPLETE');
    expect(findings.find((entry) => entry.code === 'COVERAGE_SCENARIO_INCOMPLETE')?.severity).toBe(
      'blocking',
    );
  });

  it('blocks a multi-factor model that silently drops below two residual Factors', () => {
    const model = structuredClone(bindingModel(catalogue(), 'layer/image', 'changeProperties'));
    const fit = model.factors.find((factor) => factor.id === 'fit');
    if (!fit) throw new Error('fit factor is missing');
    (fit as { residual: boolean }).residual = false;

    const findings = validateCoverageModel(model);
    expect(codes(findings)).toContain('COVERAGE_RESIDUAL_POLICY_INVALID');
    expect(
      findings.find((entry) => entry.code === 'COVERAGE_RESIDUAL_POLICY_INVALID')?.severity,
    ).toBe('blocking');
  });

  it('accepts an explicit versioned not-applicable residual policy with a rationale', () => {
    const model = structuredClone(bindingModel(catalogue(), 'layer/image', 'changeProperties'));
    const fit = model.factors.find((factor) => factor.id === 'fit');
    if (!fit) throw new Error('fit factor is missing');
    (fit as { residual: boolean }).residual = false;
    const mutableResidual = model.residual as {
      policy: string;
      rationale: string;
      submodels: readonly unknown[];
    };
    mutableResidual.policy = 'not-applicable';
    mutableResidual.rationale =
      'Single residual Factor by design under a product decision; residual interaction coverage is not applicable to this binding.';

    expect(codes(validateCoverageModel(model))).not.toContain('COVERAGE_RESIDUAL_POLICY_INVALID');
  });

  it('rejects a not-applicable residual policy without a rationale at load time', () => {
    const raw = rawCatalogue();
    const models = raw.models as Record<string, unknown>[];
    models[0].residual = {
      policy: 'not-applicable',
      defaultStrength: 2,
      submodels: [],
      rationale: '',
    };

    let thrown: unknown;
    try {
      parseCoverageModelCatalogue(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoverageCatalogueError);
    expect((thrown as CoverageCatalogueError).diagnostic.code).toBe('COVERAGE_CATALOGUE_INVALID');
  });

  it('defaults an omitted residual policy to the constrained default', () => {
    const raw = rawCatalogue();
    const models = raw.models as Record<string, unknown>[];
    models[0].residual = { defaultStrength: 2, submodels: [] };
    const parsed = parseCoverageModelCatalogue(raw);
    expect(
      parsed.models.find((entry) => entry.subjectId === 'artwork/editor')?.residual.policy,
    ).toBe('constrained');
  });
});

describe('[Coverage] seedless deterministic selection identity (TS-1)', () => {
  it('records no seed and excludes supplied seeds from identity', () => {
    const model = bindingModel(catalogue(), 'layer/text', 'move');
    const modelFingerprint = deriveCoverageModelFingerprint(model);

    const first = selectCoverage({ model, modelFingerprint, profile: 'diagnostic', seed: 1 });
    const second = selectCoverage({ model, modelFingerprint, profile: 'diagnostic', seed: 4242 });

    expect(first.seed).toBeNull();
    expect(second.seed).toBeNull();
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(second).toEqual(first);
  });
});

describe('[Coverage] model completeness across every reported level (TS-1)', () => {
  it('requires every reported tuple level to be covered, including stronger submodels', () => {
    const model = bindingModel(catalogue(), 'container/object', 'changeContainment');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });
    expect(buildModelCompleteness(selection).complete).toBe(true);

    const tampered = structuredClone(selection) as unknown as CoverageSelection;
    const mutableSubmodels = tampered.tupleCoverage.submodels as unknown as {
      submodelId: string | null;
      uncovered: string[];
    }[];
    expect(mutableSubmodels.length).toBeGreaterThan(0);
    mutableSubmodels[0].uncovered = [
      'ancestor-transform=transform-scaled|depth=depth-one|destination=destination-object',
    ];

    expect(buildModelCompleteness(tampered).complete).toBe(false);
  });

  it('sums uncovered tuple counts across every reported level in the qualification', () => {
    const model = bindingModel(catalogue(), 'container/object', 'changeContainment');
    const selection = selectCoverage({
      model,
      modelFingerprint: deriveCoverageModelFingerprint(model),
      profile: 'release',
    });
    const qualification = buildModelCompleteness(selection).qualification;
    expect(qualification).toMatch(/default\(t=2\)/);
    expect(qualification).toMatch(/containment-three-way\(t=3\)/);
  });
});
