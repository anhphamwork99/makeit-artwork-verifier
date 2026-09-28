import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { deriveResolvedCorrectnessProfileFingerprint } from '../../src/catalogue/correctness';
import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import { canonicalize } from '../../src/canonical/canonicalize';
import {
  deriveCaseId,
  deriveMaterializationFingerprint,
  derivePlanFingerprint,
} from '../../src/canonical/identity';
import type { MaterializedCase, PlannedPlan } from '../../src/contracts/case-model';
import type { ResolvedCorrectnessProfile } from '../../src/contracts/correctness';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  validateMaterializedExecutionEnvelope,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import { planCase, planCaseForExecution } from '../../src/planner/plan-case';
import { resolveToolkitRoot } from '../../src/runtime/paths';

/**
 * P7-B2-A focused proof: internal compile-once exact-profile execution
 * materialization (ADR 0029 §2/§3).
 *
 * The envelope is the active internal compile-once execution handoff: it is
 * created only by the internal planning projection, is never exported from
 * `src/index.ts`, and is consumed only by the exact authorized internal
 * consumers (the planner projection, the live-fact adapters, the strict-v4
 * assembler, the diagnostic/suite orchestration, and the six ADR 0033 runtime
 * executors) — never by a CLI entry, browser producer, legacy writer/reader, or
 * the public barrel. These tests prove compile-once behavior, deep
 * isolation/immutability, every required pre-allocation agreement failure, no
 * runtime catalogue lookup, the exact consumer set, and unchanged external plan
 * identities for all eight representative requests.
 */

const instrumentation = vi.hoisted(() => ({
  compile: 0,
  loadBundle: 0,
  loadCorrectness: 0,
}));

vi.mock('../../src/catalogue/correctness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/catalogue/correctness')>();
  return {
    ...actual,
    compileResolvedCorrectnessProfile: (
      input: Parameters<typeof actual.compileResolvedCorrectnessProfile>[0],
    ) => {
      instrumentation.compile += 1;
      return actual.compileResolvedCorrectnessProfile(input);
    },
    loadCorrectnessCatalogue: (...args: Parameters<typeof actual.loadCorrectnessCatalogue>) => {
      instrumentation.loadCorrectness += 1;
      return actual.loadCorrectnessCatalogue(...args);
    },
  };
});

vi.mock('../../src/catalogue/load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/catalogue/load')>();
  return {
    ...actual,
    loadCatalogueBundle: (...args: Parameters<typeof actual.loadCatalogueBundle>) => {
      instrumentation.loadBundle += 1;
      return actual.loadCatalogueBundle(...args);
    },
  };
});

interface AcceptedPlanIdentity {
  requestFile: string;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  profileId: string;
  correctnessProfileFingerprint: string;
  requiredChecks: readonly string[];
}

/**
 * Accepted B1 representative baseline (canonical, pre-B2-A). These are the
 * exact identities the eight `cases/diagnostic/requests/*.json` produce under
 * the accepted B1 planner; B2-A must not move any of them.
 */
const ACCEPTED_B1_PLANS: readonly AcceptedPlanIdentity[] = [
  {
    requestFile: 'layer-text-move-drag-ordinary.json',
    caseId: '506afaa6864d5230947582e74bf7d38ef65fa1bada1a2b888edbb28680714096',
    materializationFingerprint: 'dcea52524dbc361321f748ffe8b5d27d6ef2b8d8fc6308e4b539231b83b0b868',
    planFingerprint: '0c1d35d8248c9e1c2766f7c6e4836af2f853b30887e38a43f4a233641a570f55',
    profileId: 'action-cycle-v1',
    correctnessProfileFingerprint:
      '1badcb82499bedbb3e912b415dfd84f0f37654d1903d8fdd7a77e174faaec3ad',
    requiredChecks: ['geometry.delta'],
  },
  {
    requestFile: 'layer-text-move-drag-warped-nested.json',
    caseId: 'bb3c9f9349a70a968dec453e18c9602faef15fcee4c4ba1bca035dc1dff54274',
    materializationFingerprint: '78372bc710e51e9506ed0967e5972f10ec653d3f84dece3ec88bc7fbaa0b24ba',
    planFingerprint: '31bf3e4a725d1b4218076223fc8cd9814ed10b09dd93b92a89b40b634fa05154',
    profileId: 'warped-text-action-cycle-v1',
    correctnessProfileFingerprint:
      'd8257582ee954466b761eee789b18939fffdc64223c28765d8b859b8619d5506',
    requiredChecks: ['geometry.delta', 'geometry.warp-envelope'],
  },
  {
    requestFile: 'layer-image-upload-replace.json',
    caseId: '7f8aee1166fc1e111f9178e7ed38a2d83669e15653f4616e0c284899e59f55c9',
    materializationFingerprint: 'f650c5def85b31ccc4d470d3580ed50cc2fc1958dcac93dd28fdb213ed6e5845',
    planFingerprint: '0e6a22756698898b069858ae918bb8c38efbbaad4af8d029dac860527d4d34f9',
    profileId: 'image-raster-action-cycle-v1',
    correctnessProfileFingerprint:
      '144fa9c0e3f5207da2fb38d911d2a318339f8b2331904b7ab1cb941618c6c0a3',
    requiredChecks: [
      'image.content-distinct',
      'image.frame-stable',
      'image.raster-current',
      'image.semantic-transition',
      'image.structural-visual',
    ],
  },
  {
    requestFile: 'container-object-move-nested-rotated.json',
    caseId: '69d91a528e7ceab705be5a92093b89d477c43b2e4fb785502996ceb5cb9f730a',
    materializationFingerprint: 'e677cfed5c36b3bc5d9af3da4502b7b1e214a7b5d333da9b23b43476a81dddef',
    planFingerprint: '3241c27ae71e3671b0d6cdcaf305123b387380880f876383fca7d3ddcbd9205c',
    profileId: 'nested-object-action-cycle-v1',
    correctnessProfileFingerprint:
      '5ba5eed193d951adf1c3f1376976ab44f4266a0d8c5705fd2633bb51e0bd23c6',
    requiredChecks: [
      'containment.parent-chain',
      'geometry.delta',
      'geometry.local-invariant',
      'geometry.world-composition',
    ],
  },
  {
    requestFile: 'layer-crossword-create.json',
    caseId: '243cb9c1d7edc26e64d5afcfda221d28bd59dfdc68a20d123d6fc781fe512f84',
    materializationFingerprint: 'a68acaac8fa46578f89202cae78126ce4bd1bb911cdde92379501e39ba2b576c',
    planFingerprint: '804c874be43c18b8c2666522495718ec2a58ff0c4f90483ea70453a277711162',
    profileId: 'crossword-generation-action-cycle-v1',
    correctnessProfileFingerprint:
      '29767ef2f70dc30a85431e1dc36c8551424aa5ed4fff45f6eb81b9219a7bb410',
    requiredChecks: [
      'crossword.created',
      'crossword.different-seed-sensitive',
      'crossword.raster-current',
      'crossword.same-seed-repeatable',
      'crossword.seed-derived',
      'crossword.semantic-valid',
    ],
  },
  {
    requestFile: 'artwork-editor-history-undo-redo.json',
    caseId: '76eadd5ad7b6c06eee55db07e455e45f0b1567fb7af6443319d7aacb5c6d9262',
    materializationFingerprint: '46d651a40357d8978fa7b85dca3429092feb763f892d21f108cdcafe273c320a',
    planFingerprint: 'd8a6b317900730171188fdceaf7b825cf17e793cde1b3de86d6ca6b2e95cc7dc',
    profileId: 'history-transition-v1',
    correctnessProfileFingerprint:
      '63ace6473ff0a606e06a5e992c5265d30f9574be5108327a7fb3e063b940b2ab',
    requiredChecks: ['history.depth', 'history.meaning'],
  },
  {
    requestFile: 'artwork-editor-serialize-restore-normalized.json',
    caseId: 'b0f3d39b062182ec96e4ab97b1202dbc89b16a892acc34ee39d22a39cb23af67',
    materializationFingerprint: '98ad2995199692565a4bc33dc3880e76d6bf5b0fa5a5388e2c63fa8c0ec342cd',
    planFingerprint: '798801eba87d9d24e9ccb88503801d3753915efb5b6ecb0a73777c95ca4bf6f9',
    profileId: 'frontend-restore-transition-v1',
    correctnessProfileFingerprint:
      '4cd3d3164eff0ecacbdd7db1740a3bc523730c92de51d02bc2dc06518a6306fe',
    requiredChecks: ['serialize.raw-semantic', 'serialize.roundtrip'],
  },
  {
    requestFile: 'artwork-editor-serialize-restore-mixed-raw.json',
    caseId: 'c19b842f8b1018cca03db845673acba86e750be755e5d76e2a7ef3f25701ad86',
    materializationFingerprint: 'b5317feacc8a09b5d232a78c6250a1df4e5de032f370de132e306f52fd8bb4f1',
    planFingerprint: '269ccf9aff67c044416fb5ec2ed82f507e14bbe8e3ba3b03bbe6b8184d1ad6f1',
    profileId: 'frontend-restore-transition-v1',
    correctnessProfileFingerprint:
      '4cd3d3164eff0ecacbdd7db1740a3bc523730c92de51d02bc2dc06518a6306fe',
    requiredChecks: ['serialize.raw-semantic', 'serialize.roundtrip'],
  },
];

const skillRoot = resolveToolkitRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();

interface RepresentativeRequest {
  baseline: AcceptedPlanIdentity;
  request: unknown;
}

const representativeRequests: readonly RepresentativeRequest[] = (() => {
  const loaded = loadDiagnosticSuite('representative');
  const resolved = resolveSuiteRequests(loaded);
  return resolved.map((entry) => {
    const requestFile = path.basename(entry.relativePath);
    const baseline = ACCEPTED_B1_PLANS.find((plan) => plan.requestFile === requestFile);
    if (!baseline) throw new Error(`No accepted baseline for ${requestFile}`);
    return { baseline, request: entry.request };
  });
})();

const primaryRequest = representativeRequests[0] as RepresentativeRequest;

function plannedForExecution(request: unknown): PlannedPlan & {
  envelope: MaterializedExecutionEnvelopeV1 | null;
} {
  const result = planCaseForExecution(request, { catalogues: bundle });
  if (result.status !== 'PLANNED') {
    throw new Error(`Expected a planned result, received ${result.status}`);
  }
  return result;
}

function plannedCase(request: unknown): PlannedPlan {
  const result = planCase(request, { catalogues: bundle });
  if (result.status !== 'PLANNED') {
    throw new Error(`Expected a planned result, received ${result.status}`);
  }
  return result;
}

function issueCodes(
  validation: ReturnType<typeof validateMaterializedExecutionEnvelope>,
): string[] {
  if (validation.ok) return [];
  return validation.issues.map((issue) => issue.code);
}

function expectDeeplyFrozen(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const entry of value) expectDeeplyFrozen(entry, seen);
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    expectDeeplyFrozen(entry, seen);
  }
}

/** Recomputes only the resolved-profile fingerprint from a mutated content copy. */
function refreshProfileFingerprints(
  profile: ResolvedCorrectnessProfile,
): ResolvedCorrectnessProfile {
  const clone = profile as unknown as Record<string, unknown>;
  const { resolvedFingerprint: _ignored, ...content } =
    clone as unknown as ResolvedCorrectnessProfile;
  clone.resolvedFingerprint = deriveResolvedCorrectnessProfileFingerprint(content);
  return clone as unknown as ResolvedCorrectnessProfile;
}

describe('[P7-B2-A] exact-profile execution materialization (ADR 0029 §2/§3)', () => {
  it('exposes all eight representative requests in canonical suite order', () => {
    expect(representativeRequests).toHaveLength(8);
    expect(representativeRequests.map((entry) => entry.baseline.requestFile)).toEqual(
      ACCEPTED_B1_PLANS.map((entry) => entry.requestFile),
    );
  });

  it('compiles the selected route profile exactly once per planned execution', () => {
    // The P1 compatibility audit compiles one profile per delivered route
    // selection; the planner must add exactly one more (the selected route).
    const auditCompiles = bundle.correctnessCatalogue.routeSelections.length;
    for (const { baseline, request } of representativeRequests) {
      instrumentation.compile = 0;
      const executionResult = plannedForExecution(request);
      const executionCompiles = instrumentation.compile;

      instrumentation.compile = 0;
      plannedCase(request);
      const publicCompiles = instrumentation.compile;

      expect(publicCompiles, baseline.requestFile).toBe(auditCompiles + 1);
      expect(executionCompiles, baseline.requestFile).toBe(auditCompiles + 1);
      expect(executionResult.envelope, baseline.requestFile).not.toBeNull();
    }
  });

  it('never reloads a catalogue during planning with an explicit bundle, or during envelope validation', () => {
    for (const { request } of representativeRequests) {
      const bundleBefore = instrumentation.loadBundle;
      const correctnessBefore = instrumentation.loadCorrectness;
      const result = plannedForExecution(request);
      expect(instrumentation.loadBundle).toBe(bundleBefore);
      expect(instrumentation.loadCorrectness).toBe(correctnessBefore);

      if (result.envelope === null) throw new Error('expected an envelope');
      validateMaterializedExecutionEnvelope({
        envelope: result.envelope,
        materializedCase: result.materializedCase,
      });
      expect(instrumentation.loadBundle).toBe(bundleBefore);
      expect(instrumentation.loadCorrectness).toBe(correctnessBefore);
    }

    // Without an explicit bundle the planner loads once, and validation still
    // performs no lookup.
    instrumentation.loadBundle = 0;
    instrumentation.loadCorrectness = 0;
    const result = planCaseForExecution(primaryRequest.request);
    if (result.status !== 'PLANNED') throw new Error('expected a planned result');
    expect(instrumentation.loadBundle).toBe(1);
    if (result.envelope === null) throw new Error('expected an envelope');
    const bundleLoads = instrumentation.loadBundle;
    const correctnessLoads = instrumentation.loadCorrectness;
    validateMaterializedExecutionEnvelope({
      envelope: result.envelope,
      materializedCase: result.materializedCase,
    });
    expect(instrumentation.loadBundle).toBe(bundleLoads);
    expect(instrumentation.loadCorrectness).toBe(correctnessLoads);
  });

  it('validates the exact envelope and materialized case for every representative request', () => {
    for (const { baseline, request } of representativeRequests) {
      const result = plannedForExecution(request);
      if (result.envelope === null) throw new Error(`${baseline.requestFile}: no envelope`);
      const validation = validateMaterializedExecutionEnvelope({
        envelope: result.envelope,
        materializedCase: result.materializedCase,
      });
      expect(validation, baseline.requestFile).toEqual({ ok: true });
      expect(result.envelope.schemaVersion).toBe(MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION);
      expect(result.envelope.caseId).toBe(baseline.caseId);
      expect(result.envelope.materializationFingerprint).toBe(baseline.materializationFingerprint);
      expect(result.envelope.planFingerprint).toBe(baseline.planFingerprint);
      expect(result.envelope.correctnessProfile.profileId).toBe(baseline.profileId);
      expect(result.envelope.correctnessProfile.resolvedFingerprint).toBe(
        baseline.correctnessProfileFingerprint,
      );
    }
  });

  it('returns the exact public plan result and adds no public field to it', () => {
    for (const { request } of representativeRequests) {
      const publicResult = plannedCase(request);
      const executionResult = plannedForExecution(request);
      expect('envelope' in publicResult).toBe(false);
      const { envelope, ...projection } = executionResult;
      expect(projection).toEqual(publicResult);
      expect(envelope).not.toBeNull();
      expect(executionResult.caseId).toBe(publicResult.caseId);
      expect(executionResult.materializationFingerprint).toBe(
        publicResult.materializationFingerprint,
      );
      expect(executionResult.planFingerprint).toBe(publicResult.planFingerprint);
      // The envelope's plan is a compiled clone, and it re-derives the exact
      // accepted plan fingerprint.
      expect(envelope?.plan).not.toBe(publicResult.plan);
      expect(derivePlanFingerprint(envelope?.plan as never)).toBe(publicResult.planFingerprint);
    }
  });

  it('preserves every accepted B1 plan, materialization, case and correctness fingerprint', () => {
    for (const { baseline, request } of representativeRequests) {
      const result = plannedCase(request);
      expect(result.caseId, baseline.requestFile).toBe(baseline.caseId);
      expect(result.materializationFingerprint, baseline.requestFile).toBe(
        baseline.materializationFingerprint,
      );
      expect(result.planFingerprint, baseline.requestFile).toBe(baseline.planFingerprint);
      expect(result.plan.correctness.profileId, baseline.requestFile).toBe(baseline.profileId);
      expect(result.plan.correctness.resolvedFingerprint, baseline.requestFile).toBe(
        baseline.correctnessProfileFingerprint,
      );
      expect(result.plan.requiredChecks, baseline.requestFile).toEqual(baseline.requiredChecks);
      expect(result.outputs.evidenceRequirements.checkIds, baseline.requestFile).toEqual(
        baseline.requiredChecks,
      );
      // Canonical equality to the accepted baseline identities from content.
      expect(deriveCaseId(result.materializedCase.intent, result.materializedCase.fixture)).toBe(
        baseline.caseId,
      );
      expect(deriveMaterializationFingerprint(result.materializedCase)).toBe(
        baseline.materializationFingerprint,
      );
      expect(derivePlanFingerprint(result.plan)).toBe(baseline.planFingerprint);
      expect(canonicalize(result.plan).length).toBeGreaterThan(0);
    }
  });

  it('isolates and deeply freezes the envelope so no planning mutation can reach it', () => {
    const result = plannedForExecution(primaryRequest.request);
    if (result.envelope === null) throw new Error('expected an envelope');
    expectDeeplyFrozen(result.envelope);

    const envelopePlan = result.envelope.plan;
    expect(() => {
      (envelopePlan as unknown as { caseId: string }).caseId = 'mutated';
    }).toThrow();
    expect(() => {
      (envelopePlan.phases as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (
        result.envelope?.correctnessProfile.readiness as unknown as { deadlineMs: number }
      ).deadlineMs = 1;
    }).toThrow();

    // The frozen envelope is isolated from the mutable planning result.
    const before = result.envelope.plan.requiredChecks.join(',');
    (result.plan.requiredChecks as unknown as string[]).push('ghost.check');
    expect(result.envelope.plan.requiredChecks.join(',')).toBe(before);
    expect(derivePlanFingerprint(result.plan)).not.toBe(result.envelope.planFingerprint);
  });

  it('fails closed with launchAttempted:false on every pre-allocation disagreement class', () => {
    const result = plannedForExecution(primaryRequest.request);
    if (result.envelope === null) throw new Error('expected an envelope');
    const envelope = result.envelope;
    const materializedCase = result.materializedCase as MaterializedCase;

    const baseProfile = structuredClone(envelope.correctnessProfile);
    const basePlan = structuredClone(envelope.plan) as PlannedPlan['plan'];
    const baseCase = structuredClone(materializedCase) as MaterializedCase;

    const cases: readonly {
      name: string;
      envelope: MaterializedExecutionEnvelopeV1;
      materializedCase: MaterializedCase;
      expected: string;
    }[] = [
      {
        name: 'unsupported envelope schema',
        envelope: {
          ...envelope,
          schemaVersion: 2,
        } as unknown as MaterializedExecutionEnvelopeV1,
        materializedCase,
        expected: 'ENVELOPE_SCHEMA_UNSUPPORTED',
      },
      {
        name: 'tampered plan fingerprint',
        envelope: { ...envelope, planFingerprint: 'f'.repeat(64) },
        materializedCase,
        expected: 'ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
      },
      {
        name: 'tampered case id',
        envelope: { ...envelope, caseId: 'a'.repeat(64) },
        materializedCase,
        expected: 'ENVELOPE_CASE_ID_MISMATCH',
      },
      {
        name: 'tampered materialization fingerprint',
        envelope: { ...envelope, materializationFingerprint: 'b'.repeat(64) },
        materializedCase,
        expected: 'ENVELOPE_MATERIALIZATION_IDENTITY_MISMATCH',
      },
      {
        name: 'missing resolved profile',
        envelope: {
          ...envelope,
          correctnessProfile: undefined,
        } as unknown as MaterializedExecutionEnvelopeV1,
        materializedCase,
        expected: 'ENVELOPE_PROFILE_MISSING',
      },
      {
        name: 'unsupported profile schema',
        envelope: {
          ...envelope,
          correctnessProfile: { ...baseProfile, schemaVersion: 2 },
        },
        materializedCase,
        expected: 'ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
      },
      {
        name: 'profile content mutation without a fingerprint update',
        envelope: {
          ...envelope,
          correctnessProfile: (() => {
            const clone = structuredClone(baseProfile) as unknown as Record<string, unknown>;
            (clone.readiness as { deadlineMs: number }).deadlineMs += 1;
            return clone as unknown as ResolvedCorrectnessProfile;
          })(),
        },
        materializedCase,
        expected: 'ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
      },
      {
        name: 'materialized contract fingerprint drift',
        envelope: {
          ...envelope,
          materializationFingerprint: deriveMaterializationFingerprint(
            (() => {
              const clone = structuredClone(baseCase);
              clone.contracts.correctnessProfileFingerprint = 'c'.repeat(64);
              return clone as unknown as MaterializedCase;
            })(),
          ),
        },
        materializedCase: (() => {
          const clone = structuredClone(baseCase);
          clone.contracts.correctnessProfileFingerprint = 'c'.repeat(64);
          return clone as unknown as MaterializedCase;
        })(),
        expected: 'ENVELOPE_MATERIALIZED_PROFILE_MISMATCH',
      },
      {
        name: 'route variant disagreement',
        envelope: {
          ...envelope,
          materializationFingerprint: deriveMaterializationFingerprint(
            (() => {
              const clone = structuredClone(baseCase);
              (clone.intent as unknown as { variant: string | null }).variant = 'ghost-variant';
              return clone as unknown as MaterializedCase;
            })(),
          ),
        },
        materializedCase: (() => {
          const clone = structuredClone(baseCase);
          (clone.intent as unknown as { variant: string | null }).variant = 'ghost-variant';
          return clone as unknown as MaterializedCase;
        })(),
        expected: 'ENVELOPE_ROUTE_MISMATCH',
      },
      {
        name: 'plan required-check drift',
        envelope: {
          ...envelope,
          plan: (() => {
            const clone = structuredClone(basePlan);
            (clone as unknown as { requiredChecks: string[] }).requiredChecks = [
              ...clone.requiredChecks,
              'ghost.check',
            ];
            return clone;
          })(),
          planFingerprint: derivePlanFingerprint(
            (() => {
              const clone = structuredClone(basePlan);
              (clone as unknown as { requiredChecks: string[] }).requiredChecks = [
                ...clone.requiredChecks,
                'ghost.check',
              ];
              return clone;
            })(),
          ),
        },
        materializedCase,
        expected: 'ENVELOPE_REQUIRED_CHECK_DRIFT',
      },
      {
        name: 'invalid component fingerprint',
        envelope: {
          ...envelope,
          correctnessProfile: (() => {
            const clone = structuredClone(baseProfile);
            (clone.componentFingerprints as unknown as { readiness: string }).readiness = 'zz';
            return clone;
          })(),
        },
        materializedCase,
        expected: 'ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
      },
      {
        name: 'incomplete reference closure',
        envelope: {
          ...envelope,
          correctnessProfile: (() => {
            const clone = structuredClone(baseProfile);
            (clone as unknown as { referenceClosure: unknown[] }).referenceClosure =
              clone.referenceClosure.slice(0, -1);
            return clone;
          })(),
        },
        materializedCase,
        expected: 'ENVELOPE_REFERENCE_CLOSURE_INCOMPLETE',
      },
      {
        name: 'unsatisfied non-weakening assertion',
        envelope: {
          ...envelope,
          correctnessProfile: (() => {
            const clone = structuredClone(baseProfile);
            (clone.nonWeakening[0] as unknown as { satisfied: boolean }).satisfied = false;
            return clone;
          })(),
        },
        materializedCase,
        expected: 'ENVELOPE_NON_WEAKENING_VIOLATION',
      },
      {
        name: 'unsupported Oracle evaluator discriminant',
        envelope: {
          ...envelope,
          correctnessProfile: (() => {
            const clone = structuredClone(baseProfile);
            (clone.oracle as unknown as { evaluatorKind: string }).evaluatorKind = 'ghost-family';
            return clone;
          })(),
        },
        materializedCase,
        expected: 'ENVELOPE_EVALUATOR_UNSUPPORTED',
      },
      {
        name: 'unsupported check evaluator discriminant',
        envelope: {
          ...envelope,
          correctnessProfile: (() => {
            const clone = structuredClone(baseProfile);
            (clone.requiredChecks[0] as unknown as { evaluator: string }).evaluator = 'ghost-check';
            return clone;
          })(),
        },
        materializedCase,
        expected: 'ENVELOPE_EVALUATOR_UNSUPPORTED',
      },
    ];

    for (const entry of cases) {
      const validation = validateMaterializedExecutionEnvelope({
        envelope: entry.envelope,
        materializedCase: entry.materializedCase,
      });
      expect(validation.ok, entry.name).toBe(false);
      if (validation.ok) continue;
      expect(validation.status, entry.name).toBe('HARNESS_BLOCKED');
      expect(validation.launchAttempted, entry.name).toBe(false);
      expect(validation.code, entry.name).toBe(validation.diagnostic.code);
      expect(issueCodes(validation), entry.name).toContain(entry.expected);
    }
  });

  it('fails a profile mutation that disagrees with the plan and materialized contracts', () => {
    const result = plannedForExecution(primaryRequest.request);
    if (result.envelope === null) throw new Error('expected an envelope');
    const mutated = structuredClone(result.envelope.correctnessProfile) as unknown as Record<
      string,
      unknown
    >;
    (mutated.readiness as unknown as { deadlineMs: number }).deadlineMs += 1;
    const refreshed = refreshProfileFingerprints(mutated as unknown as ResolvedCorrectnessProfile);
    // The refreshed profile recomputes its own fingerprint from its mutated
    // content, so profile-fingerprint recomputation passes; it no longer agrees
    // with the plan or the materialized contract.
    const validation = validateMaterializedExecutionEnvelope({
      envelope: { ...result.envelope, correctnessProfile: refreshed },
      materializedCase: result.materializedCase,
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(issueCodes(validation).includes('ENVELOPE_PROFILE_FINGERPRINT_MISMATCH')).toBe(false);
    const codes = issueCodes(validation);
    expect(codes).toContain('ENVELOPE_PROFILE_AGREEMENT_MISMATCH');
    expect(codes).toContain('ENVELOPE_MATERIALIZED_PROFILE_MISMATCH');
  });

  it('does not export the envelope or the execution projection from the public TS-1 surface', () => {
    const indexSource = readFileSync(path.join(skillRoot, 'src', 'index.ts'), 'utf8');
    expect(indexSource).not.toContain('MaterializedExecutionEnvelope');
    expect(indexSource).not.toContain('planCaseForExecution');
    expect(indexSource).not.toContain('execution-materialization');
    const caseModelSource = readFileSync(
      path.join(skillRoot, 'src', 'contracts', 'case-model.ts'),
      'utf8',
    );
    expect(caseModelSource.toLowerCase()).not.toContain('envelope');
  });

  it('is imported only by exact compile-once consumers including the prepared Diagnostic seam', () => {
    const references: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(target);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(target, 'utf8');
        if (
          source.includes('execution-materialization') ||
          source.includes('MaterializedExecutionEnvelope')
        ) {
          references.push(path.relative(skillRoot, target));
        }
      }
    };
    walk(path.join(skillRoot, 'src'));
    // The exact envelope is now the *active* internal compile-once execution
    // handoff (ADR 0033). The P7-B2-B1/B2-B2 live-fact adapters consume it as a
    // type/fact boundary only; B2-B4 (Crossword) and B2-B5 (History and Restore)
    // extend the same adapter family. The B2-C strict-v4 assembly consumes it as
    // its validated writer-side input. The B2-D1 diagnostic/suite orchestration
    // consumes it as its execution input and resolves the family dispatch from
    // the compiled profile. ADR 0033 additionally authorizes exactly six runtime
    // executors to consume the same exact envelope so the executor-bound handoff
    // reaches final evaluation without recomputation or reconstruction. The E3
    // switch manifest names the materialization module only as frozen
    // activation/rollback inventory; it is not a runtime edge.
    expect([...references].sort()).toEqual([
      'src/adapters/crossword-live-facts.ts',
      'src/adapters/history-live-facts.ts',
      'src/adapters/image-live-facts.ts',
      'src/adapters/object-live-facts.ts',
      'src/adapters/restore-live-facts.ts',
      'src/adapters/text-live-facts.ts',
      'src/cli/diagnostic.ts',
      'src/contracts/final-record-v4.ts',
      'src/evidence/provenance-component-policy.ts',
      'src/orchestration/diagnostic-execution.ts',
      'src/orchestration/final-switch-manifest.ts',
      'src/orchestration/suite-execution.ts',
      'src/planner/execution-materialization.ts',
      'src/planner/plan-case.ts',
      'src/runtime/action-cycle.ts',
      'src/runtime/execute-crossword-plan.ts',
      'src/runtime/execute-history-plan.ts',
      'src/runtime/execute-image-plan.ts',
      'src/runtime/execute-plan.ts',
      'src/runtime/execute-restore-plan.ts',
    ]);
    expect(readFileSync(path.join(skillRoot, 'src', 'index.ts'), 'utf8')).not.toContain(
      'planCaseForExecution',
    );
    // ADR 0103 admits only the prepared Diagnostic compile seam. Other CLI
    // entries, browser producers, legacy writers/readers, and the public barrel
    // may import the materialization module or its envelope type.
    for (const relative of [
      'src/cli/suite.ts',
      'src/cli/doctor.ts',
      'src/cli/production-absence.ts',
      'src/cli/main.ts',
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
      'src/evidence/writer.ts',
      'src/evidence/reader.ts',
      'src/evidence/public-dto.ts',
      'src/index.ts',
    ]) {
      const boundary = readFileSync(path.join(skillRoot, relative), 'utf8');
      expect(boundary, relative).not.toContain('execution-materialization');
      expect(boundary, relative).not.toContain('MaterializedExecutionEnvelope');
    }
  });
});
