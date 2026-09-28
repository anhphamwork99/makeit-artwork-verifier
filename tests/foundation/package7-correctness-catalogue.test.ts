import { describe, expect, it } from 'vitest';

import {
  CHECK_RESULT_STATUSES,
  CorrectnessCatalogueError,
  NORMALIZATION_COMBINATION,
  VISUAL_ALGORITHMS,
  VISUAL_BOUNDED_REGIONS,
  VISUAL_COMBINATIONS,
  VISUAL_EVIDENCE_SOURCES,
  WP5_COMPATIBILITY_ORACLE,
  assembleCorrectnessCatalogue,
  auditCorrectnessCompatibility,
  auditWp5Compatibility,
  buildBindingCorrectnessLedger,
  compileDeliveredRouteProfiles,
  compileResolvedCorrectnessProfile,
  deriveAbsentCorrectnessProfileFingerprint,
  deriveCaptureFingerprint,
  deriveCorrectnessCatalogueFingerprint,
  deriveNormalizationFingerprint,
  deriveOracleFingerprint,
  deriveReadinessFingerprint,
  deriveResolvedCorrectnessProfileFingerprint,
  deriveToleranceFingerprint,
  deriveVisualAuthorityFingerprint,
  deriveCapabilityBaselineFingerprint,
  deriveSubjectAdditionFingerprint,
  hasBlockingDiagnostic,
  isCheckResultStatus,
  loadCorrectnessCatalogue,
  loadDiagnosticSuite,
  planCase,
  REPRESENTATIVE_SUITE_ID,
  resolveRouteSelection,
  resolveSuiteRequests,
  runValidateAll,
  validateCorrectnessCatalogue,
} from '../../src/index';
import type { CaseRequest, PlanResult } from '../../src/index';
import { deriveLaunchability } from '../../src/planner/launchability';
import { compatibilityProjectionOfCompiledProfile } from '../../src/catalogue/correctness-compatibility';
import { defaultBundle, instance } from './helpers';

/**
 * Package 7 Slice A acceptance tests (ADR 0023 §11).
 *
 * These tests exercise the strict authoring catalogues, the closed composition
 * compiler, full canonical domain-separated fingerprints, exact reference
 * closure, non-weakening enforcement, the Image reference repair, and the
 * planner's fail-closed `HARNESS_BLOCKED` behavior — without any browser launch
 * or `FE-build/src` product-source change.
 */

type Documents = {
  readiness: { schemaVersion: number; readiness: unknown[] };
  capture: { schemaVersion: number; captures: unknown[] };
  oracles: { schemaVersion: number; oracles: unknown[] };
  composition: {
    schemaVersion: number;
    capabilityBaselines: unknown[];
    subjectAdditions: unknown[];
  };
  routeSelections: { schemaVersion: number; routeSelections: unknown[] };
  tolerances: { schemaVersion: number; tolerances: unknown[] };
  visuals: { schemaVersion: number; visuals: unknown[] };
  normalization: { schemaVersion: number; normalizations: unknown[] };
};

function baseDocuments(): Documents {
  const catalogue = loadCorrectnessCatalogue();
  return {
    readiness: { schemaVersion: 1, readiness: structuredClone([...catalogue.readiness]) },
    capture: { schemaVersion: 1, captures: structuredClone([...catalogue.captures]) },
    oracles: { schemaVersion: 1, oracles: structuredClone([...catalogue.oracles]) },
    composition: {
      schemaVersion: 1,
      capabilityBaselines: structuredClone([...catalogue.capabilityBaselines]),
      subjectAdditions: structuredClone([...catalogue.subjectAdditions]),
    },
    routeSelections: {
      schemaVersion: 1,
      routeSelections: structuredClone([...catalogue.routeSelections]),
    },
    tolerances: { schemaVersion: 1, tolerances: structuredClone([...catalogue.tolerances]) },
    visuals: { schemaVersion: 1, visuals: structuredClone([...catalogue.visuals]) },
    normalization: {
      schemaVersion: 1,
      normalizations: structuredClone([...catalogue.normalizations]),
    },
  };
}

function assemble(documents: Documents) {
  return assembleCorrectnessCatalogue(documents as never);
}

function mutated(mutate: (documents: Documents) => void) {
  const documents = baseDocuments();
  mutate(documents);
  return assemble(documents);
}

function planWithCatalogue(catalogue: ReturnType<typeof assemble>, request: unknown): PlanResult {
  return planCase(request, {
    catalogues: { ...defaultBundle(), correctnessCatalogue: catalogue },
  });
}

function representativeRequests(): CaseRequest[] {
  const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
  return resolveSuiteRequests(loaded).map((member) => member.request as CaseRequest);
}

function requestFor(subjectId: string, capability: string, variant: string | null): CaseRequest {
  const found = representativeRequests().find(
    (request) =>
      request.intent.subjectId === subjectId &&
      request.intent.capability === capability &&
      request.intent.variant === variant,
  );
  if (!found)
    throw new Error(`No representative request for ${subjectId} ${capability} ${variant}`);
  return found;
}

function expectBlocked(result: PlanResult, code?: string): void {
  expect(result.status).toBe('HARNESS_BLOCKED');
  expect(result.launchAttempted).toBe(false);
  if (code) {
    if (result.status !== 'HARNESS_BLOCKED') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe(code);
  }
}

const baseCatalogue = loadCorrectnessCatalogue();

describe('[P7-A] strict correctness catalogue schemas (ADR 0023 §2)', () => {
  it('accepts the accepted catalogue set with complete reference closure', () => {
    expect(validateCorrectnessCatalogue(baseCatalogue)).toEqual([]);
    expect(auditCorrectnessCompatibility(baseCatalogue)).toEqual([]);
  });

  it('rejects unknown keys in every correctness domain', () => {
    const mutations: ((documents: Documents) => void)[] = [
      (documents) => {
        (documents.readiness.readiness[0] as Record<string, unknown>).unexpected = true;
      },
      (documents) => {
        const captures = documents.capture.captures[0] as {
          requiredSources: Record<string, unknown>[];
        };
        captures.requiredSources[0]!.unexpected = true;
      },
      (documents) => {
        const oracles = documents.oracles.oracles[0] as { checks: Record<string, unknown>[] };
        oracles.checks[0]!.unexpected = true;
      },
      (documents) => {
        (documents.tolerances.tolerances[0] as Record<string, unknown>).unexpected = 1;
      },
      (documents) => {
        (documents.visuals.visuals[0] as Record<string, unknown>).unexpected = 1;
      },
      (documents) => {
        (documents.normalization.normalizations[0] as Record<string, unknown>).unexpected = 1;
      },
      (documents) => {
        (documents.composition.capabilityBaselines[0] as Record<string, unknown>).unexpected = [];
      },
      (documents) => {
        (documents.routeSelections.routeSelections[0] as Record<string, unknown>).unexpected = 1;
      },
    ];
    for (const mutate of mutations) {
      expect(() => mutated(mutate)).toThrow(CorrectnessCatalogueError);
    }
  });

  it('rejects an unknown catalogue schema version', () => {
    expect(() =>
      mutated((documents) => {
        documents.readiness.schemaVersion = 2;
      }),
    ).toThrow(/unsupported/i);
  });

  it('rejects unknown discriminants in every domain', () => {
    const mutations: ((documents: Documents) => void)[] = [
      (documents) => {
        (documents.readiness.readiness[0] as Record<string, unknown>).deadlineCategory = 'NOPE';
      },
      (documents) => {
        const captures = documents.capture.captures[0] as {
          requiredSources: Record<string, unknown>[];
        };
        captures.requiredSources[0]!.role = 'NOPE';
      },
      (documents) => {
        (documents.oracles.oracles[0] as Record<string, unknown>).evaluatorKind = 'NOPE';
      },
      (documents) => {
        const oracles = documents.oracles.oracles[0] as { checks: Record<string, unknown>[] };
        oracles.checks[0]!.evaluator = 'NOPE';
      },
      (documents) => {
        (documents.tolerances.tolerances[0] as Record<string, unknown>).algorithm = 'NOPE';
      },
      (documents) => {
        (documents.visuals.visuals[0] as Record<string, unknown>).mode = 'NOPE';
      },
      (documents) => {
        (documents.composition.capabilityBaselines[0] as Record<string, unknown>).capability =
          'NOPE';
      },
    ];
    for (const mutate of mutations) {
      expect(() => mutated(mutate)).toThrow(CorrectnessCatalogueError);
    }
  });

  it('rejects duplicate identities rather than deduplicating them', () => {
    expect(() =>
      mutated((documents) => {
        documents.readiness.readiness.push(structuredClone(documents.readiness.readiness[0]));
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      mutated((documents) => {
        const oracles = documents.oracles.oracles[0] as { checks: unknown[] };
        oracles.checks.push(structuredClone(oracles.checks[0]));
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      mutated((documents) => {
        documents.tolerances.tolerances.push(
          structuredClone(documents.tolerances.tolerances[0] as Record<string, unknown>),
        );
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      mutated((documents) => {
        documents.routeSelections.routeSelections.push(
          structuredClone(documents.routeSelections.routeSelections[0] as Record<string, unknown>),
        );
      }),
    ).toThrow(/duplicate/i);
  });

  it('rejects a tolerance algorithm/units pairing mismatch', () => {
    const catalogue = mutated((documents) => {
      (documents.tolerances.tolerances[0] as Record<string, unknown>).units = 'wrong-units';
    });
    expect(validateCorrectnessCatalogue(catalogue).map((finding) => finding.code)).toContain(
      'CORRECTNESS_TOLERANCE_UNITS_MISMATCH',
    );
  });

  it('defines exactly the closed PASS | FAIL | UNUSABLE result domain', () => {
    expect([...CHECK_RESULT_STATUSES]).toEqual(['FAIL', 'PASS', 'UNUSABLE']);
    expect(isCheckResultStatus('PASS')).toBe(true);
    expect(isCheckResultStatus('FAIL')).toBe(true);
    expect(isCheckResultStatus('UNUSABLE')).toBe(true);
    expect(isCheckResultStatus('passed')).toBe(false);
    expect(isCheckResultStatus(false)).toBe(false);
  });

  it('defines the three-state contract without partially migrating active runtime results', () => {
    // The durable runtime projection still carries the boolean compatibility
    // surface; P7-A must not claim the three states are already preserved.
    const runtimeCheck = instance().requiredChecks[0] as unknown as Record<string, unknown>;
    expect(runtimeCheck).toHaveProperty('passed');
    expect(runtimeCheck).not.toHaveProperty('status');
  });
});

describe('[P7-A] Image reference repair and regression (ADR 0023 §8)', () => {
  it('resolves the accepted Image readiness profile to image-upload-replace-v1 with no alias', () => {
    const image = baseCatalogue.readiness.find(
      (entry) => entry.profileId === 'image-raster-action-cycle-v1',
    );
    expect(image?.oracleProfileId).toBe('image-upload-replace-v1');

    const imageRequest = requestFor('layer/image', 'changeProperties', 'static');
    const result = planWithCatalogue(baseCatalogue, imageRequest);
    expect(result.status).toBe('PLANNED');
    if (result.status !== 'PLANNED') throw new Error('unreachable');
  });

  it('fails closed on the stale image-raster-v1 readiness reference', () => {
    const catalogue = mutated((documents) => {
      const image = documents.readiness.readiness.find(
        (entry) => (entry as Record<string, unknown>).profileId === 'image-raster-action-cycle-v1',
      ) as Record<string, unknown>;
      image.oracleProfileId = 'image-raster-v1';
    });
    const findings = validateCorrectnessCatalogue(catalogue);
    expect(findings.some((finding) => finding.severity === 'blocking')).toBe(true);
    // No alias or fallback conceals the unresolved reference.
    expect(findings.map((finding) => finding.code)).toContain('CORRECTNESS_REFERENCE_UNRESOLVED');
    expect(hasBlockingDiagnostic(auditCorrectnessCompatibility(catalogue))).toBe(true);
    expectBlocked(
      planWithCatalogue(catalogue, requestFor('layer/image', 'changeProperties', 'static')),
    );
  });
});

describe('[P7-A] canonical fingerprints (ADR 0023 §3/§4)', () => {
  it('is stable under authoring reorder of semantically unordered collections', () => {
    const baseFingerprint = deriveCorrectnessCatalogueFingerprint(baseCatalogue);
    const reordered = mutated((documents) => {
      documents.readiness.readiness.reverse();
      documents.capture.captures.reverse();
      documents.oracles.oracles.reverse();
      documents.composition.capabilityBaselines.reverse();
      documents.composition.subjectAdditions.reverse();
      documents.routeSelections.routeSelections.reverse();
      documents.tolerances.tolerances.reverse();
      documents.visuals.visuals.reverse();
      documents.normalization.normalizations.reverse();
      const oracles = documents.oracles.oracles[0] as { checks: { requiredEvidence: string[] }[] };
      oracles.checks.reverse();
      for (const check of oracles.checks) check.requiredEvidence.reverse();
    });
    expect(deriveCorrectnessCatalogueFingerprint(reordered)).toBe(baseFingerprint);
  });

  it('is sensitive to ordered fallback cadence and capture bracketing', () => {
    const baseReadiness = baseCatalogue.readiness[0]!;
    expect(
      deriveReadinessFingerprint({
        ...baseReadiness,
        fallbackCadenceMs: [...baseReadiness.fallbackCadenceMs].reverse(),
      }),
    ).not.toBe(deriveReadinessFingerprint(baseReadiness));

    const baseCapture = baseCatalogue.captures[0]!;
    expect(
      deriveCaptureFingerprint({
        ...baseCapture,
        bracketing: [...baseCapture.bracketing].reverse(),
      }),
    ).not.toBe(deriveCaptureFingerprint(baseCapture));
  });

  it('is sensitive to a semantic-field mutation in every catalogue domain', () => {
    const baseFingerprint = deriveCorrectnessCatalogueFingerprint(baseCatalogue);
    const mutations: ((documents: Documents) => void)[] = [
      (documents) => {
        (documents.readiness.readiness[0] as Record<string, unknown>).deadlineMs = 4999;
      },
      (documents) => {
        const captures = documents.capture.captures[0] as { acceptedObservationRule: string };
        captures.acceptedObservationRule = `${captures.acceptedObservationRule} (changed)`;
      },
      (documents) => {
        const oracles = documents.oracles.oracles[0] as { checks: { expectedSchema: string }[] };
        oracles.checks[0]!.expectedSchema = 'changed-expected-schema-v1';
      },
      (documents) => {
        (documents.composition.capabilityBaselines[0] as Record<string, unknown>).checks = [
          'geometry.delta',
          'extra.check',
        ];
      },
      (documents) => {
        (documents.composition.subjectAdditions[0] as Record<string, unknown>).checks = [
          'extra.check',
        ];
      },
      (documents) => {
        (
          documents.routeSelections.routeSelections[0] as Record<string, unknown>
        ).readinessProfileId = 'warped-text-action-cycle-v1';
      },
      (documents) => {
        (documents.tolerances.tolerances[0] as Record<string, unknown>).rationale =
          'changed rationale';
      },
      (documents) => {
        (documents.visuals.visuals[0] as Record<string, unknown>).visualId =
          'changed-visual-identity-v1';
      },
      (documents) => {
        (documents.normalization.normalizations[0] as Record<string, unknown>).normalizationId =
          'changed-normalization-identity-v1';
      },
    ];
    for (const mutate of mutations) {
      expect(deriveCorrectnessCatalogueFingerprint(mutated(mutate))).not.toBe(baseFingerprint);
    }
  });

  it('emits full 64-hex SHA-256 fingerprints for every component and resolved profile', () => {
    const fingerprints = [
      deriveReadinessFingerprint(baseCatalogue.readiness[0]!),
      deriveCaptureFingerprint(baseCatalogue.captures[0]!),
      deriveOracleFingerprint(baseCatalogue.oracles[0]!),
      deriveCapabilityBaselineFingerprint(baseCatalogue.capabilityBaselines[0]!),
      deriveSubjectAdditionFingerprint(baseCatalogue.subjectAdditions[0]!),
      deriveToleranceFingerprint(baseCatalogue.tolerances[0]!),
      deriveVisualAuthorityFingerprint(baseCatalogue.visuals[0]!),
      deriveNormalizationFingerprint(baseCatalogue.normalizations[0]!),
      deriveAbsentCorrectnessProfileFingerprint('layer/text', 'move', 'plain'),
      deriveCorrectnessCatalogueFingerprint(baseCatalogue),
    ];
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('domain-separates component types and resolved profiles', () => {
    const value = { v: 1 };
    const digests = [
      (deriveReadinessFingerprint as (input: unknown) => string)(value),
      (deriveCaptureFingerprint as (input: unknown) => string)(value),
      (deriveOracleFingerprint as (input: unknown) => string)(value),
      (deriveToleranceFingerprint as (input: unknown) => string)(value),
      (deriveVisualAuthorityFingerprint as (input: unknown) => string)(value),
      (deriveNormalizationFingerprint as (input: unknown) => string)(value),
    ];
    expect(new Set(digests).size).toBe(digests.length);

    const compiled = compileResolvedCorrectnessProfile({
      catalogue: baseCatalogue,
      selection: resolveRouteSelection(baseCatalogue, {
        subjectId: 'layer/text',
        capability: 'move',
        variant: 'plain',
      })!,
      declaredChecks: ['geometry.delta'],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('unreachable');
    const componentValues = Object.values(compiled.profile.componentFingerprints);
    expect(new Set(componentValues).size).toBe(componentValues.length);
    expect(componentValues).not.toContain(compiled.profile.resolvedFingerprint);
    const withoutFingerprint = { ...compiled.profile } as Record<string, unknown>;
    delete withoutFingerprint.resolvedFingerprint;
    expect(deriveResolvedCorrectnessProfileFingerprint(withoutFingerprint as never)).toBe(
      compiled.profile.resolvedFingerprint,
    );
  });
});

describe('[P7-A] composition and non-weakening (ADR 0023 §5)', () => {
  const cases: { label: string; request: CaseRequest; mutate: (documents: Documents) => void }[] = [
    {
      label: 'baseline-check removal',
      request: requestFor('layer/text', 'move', 'plain'),
      mutate: (documents) => {
        const baseline = documents.composition.capabilityBaselines.find(
          (entry) => (entry as Record<string, unknown>).capability === 'move',
        ) as Record<string, unknown>;
        baseline.checks = [];
      },
    },
    {
      label: 'Subject-addition removal',
      request: requestFor('artwork/editor', 'history', null),
      mutate: (documents) => {
        const addition = documents.composition.subjectAdditions.find(
          (entry) =>
            (entry as Record<string, unknown>).subjectId === 'artwork/editor' &&
            (entry as Record<string, unknown>).capability === 'history',
        ) as Record<string, unknown>;
        addition.checks = [];
      },
    },
    {
      label: 'required-to-diagnostic downgrade',
      request: requestFor('layer/image', 'changeProperties', 'static'),
      mutate: (documents) => {
        const addition = documents.composition.subjectAdditions.find(
          (entry) =>
            (entry as Record<string, unknown>).subjectId === 'layer/image' &&
            (entry as Record<string, unknown>).capability === 'changeProperties',
        ) as { checks: string[] };
        addition.checks = addition.checks.filter((check) => check !== 'image.structural-visual');
        const oracle = documents.oracles.oracles.find(
          (entry) =>
            (entry as Record<string, unknown>).oracleProfileId === 'image-upload-replace-v1',
        ) as { checks: { checkId: string }[]; diagnosticOnlyEvidence: string[] };
        oracle.checks = oracle.checks.filter(
          (check) => check.checkId !== 'image.structural-visual',
        );
        oracle.diagnosticOnlyEvidence.push('image.structural-visual');
      },
    },
    {
      label: 'diagnostic rescue attempt',
      request: requestFor('layer/text', 'move', 'plain'),
      mutate: (documents) => {
        const oracle = documents.oracles.oracles.find(
          (entry) => (entry as Record<string, unknown>).oracleProfileId === 'geometry-delta-v1',
        ) as { diagnosticOnlyEvidence: string[] };
        oracle.diagnosticOnlyEvidence.push('geometry.delta');
      },
    },
    {
      label: 'tolerance widening',
      request: requestFor('layer/text', 'move', 'plain'),
      mutate: (documents) => {
        const tolerance = documents.tolerances.tolerances.find(
          (entry) => (entry as Record<string, unknown>).toleranceId === 'renderer-transform-px-v1',
        ) as Record<string, unknown>;
        tolerance.value = 0.5;
      },
    },
    {
      label: 'tolerance substitution with an unknown reference',
      request: requestFor('layer/text', 'move', 'plain'),
      mutate: (documents) => {
        const oracle = documents.oracles.oracles[0] as {
          oracleProfileId: string;
          checks: { toleranceRefs: string[] }[];
        };
        oracle.checks[0]!.toleranceRefs = ['renderer-transform-px'];
      },
    },
    {
      label: 'deadline override',
      request: requestFor('layer/image', 'changeProperties', 'static'),
      mutate: (documents) => {
        const image = documents.readiness.readiness.find(
          (entry) =>
            (entry as Record<string, unknown>).profileId === 'image-raster-action-cycle-v1',
        ) as Record<string, unknown>;
        image.deadlineMs = 9000;
      },
    },
    {
      label: 'capture-source omission',
      request: requestFor('layer/text', 'move', 'plain'),
      mutate: (documents) => {
        const capture = documents.capture.captures.find(
          (entry) => (entry as Record<string, unknown>).captureProfileId === 'single-target-v1',
        ) as { evidenceItemIds: string[] };
        capture.evidenceItemIds = capture.evidenceItemIds.filter((id) => id !== 'observation');
      },
    },
    {
      label: 'currentness-invariant omission',
      request: requestFor('layer/text', 'move', 'plain'),
      mutate: (documents) => {
        const readiness = documents.readiness.readiness.find(
          (entry) => (entry as Record<string, unknown>).profileId === 'action-cycle-v1',
        ) as { currentnessIdentities: string[] };
        readiness.currentnessIdentities = readiness.currentnessIdentities.filter(
          (identity) => identity !== 'renderer-stage',
        );
      },
    },
    {
      label: 'unknown visual authority reference',
      request: requestFor('layer/image', 'changeProperties', 'static'),
      mutate: (documents) => {
        const oracle = documents.oracles.oracles.find(
          (entry) =>
            (entry as Record<string, unknown>).oracleProfileId === 'image-upload-replace-v1',
        ) as { checks: { checkId: string; visualRefs: string[] }[] };
        const check = oracle.checks.find((entry) => entry.checkId === 'image.structural-visual')!;
        check.visualRefs = ['unknown-visual-v1'];
      },
    },
    {
      label: 'unknown normalization reference',
      request: requestFor('artwork/editor', 'frontendSerializeRestore', null),
      mutate: (documents) => {
        const oracle = documents.oracles.oracles.find(
          (entry) => (entry as Record<string, unknown>).oracleProfileId === 'frontend-restore-v1',
        ) as { checks: { normalizationRef: string | null }[] };
        oracle.checks[0]!.normalizationRef = 'unknown-normalization-v1';
      },
    },
    {
      label: 'unapproved scenario/profile selection',
      request: requestFor('layer/image', 'changeProperties', 'static'),
      mutate: (documents) => {
        const selection = documents.routeSelections.routeSelections.find(
          (entry) =>
            (entry as Record<string, unknown>).subjectId === 'layer/image' &&
            (entry as Record<string, unknown>).capability === 'changeProperties',
        ) as Record<string, unknown>;
        selection.oracleProfileId = 'crossword-determinism-v1';
      },
    },
  ];

  it.each(cases)('fails closed as HARNESS_BLOCKED for $label', ({ request, mutate }) => {
    expectBlocked(planWithCatalogue(mutated(mutate), request));
  });

  it('rejects an unknown evaluator discriminant at authoring time', () => {
    expect(() =>
      mutated((documents) => {
        (documents.oracles.oracles[0] as { checks: Record<string, unknown>[] })
          .checks[0]!.evaluator = 'unknown-evaluator';
      }),
    ).toThrow(CorrectnessCatalogueError);
  });

  it('records the compiled composed required-check set and fingerprint on the plan', () => {
    const result = planWithCatalogue(
      baseCatalogue,
      requestFor('layer/text', 'move', 'warp-circle'),
    );
    expect(result.status).toBe('PLANNED');
    if (result.status !== 'PLANNED') throw new Error('unreachable');
    expect(result.plan.requiredChecks).toEqual(['geometry.delta', 'geometry.warp-envelope']);
    expect(result.plan.correctness.profileId).toBe('warped-text-action-cycle-v1');
    expect(result.plan.correctness.resolvedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.materializedCase.contracts.correctnessProfileFingerprint).toBe(
      result.plan.correctness.resolvedFingerprint,
    );
    expect(result.outputs.preflightReport.fingerprints.correctnessProfileFingerprint).toBe(
      result.plan.correctness.resolvedFingerprint,
    );
  });

  it('blocks a correctness-component divergence from the accepted WP5 projection before launch', () => {
    const request = requestFor('layer/text', 'move', 'plain');
    const base = planWithCatalogue(baseCatalogue, request);
    expect(base.status).toBe('PLANNED');
    if (base.status !== 'PLANNED') throw new Error('unreachable');
    // caseId is derived from the request, so it is stable for the same request.
    const repeat = planWithCatalogue(baseCatalogue, request);
    expect(repeat.status).toBe('PLANNED');
    if (repeat.status !== 'PLANNED') throw new Error('unreachable');
    expect(repeat.caseId).toBe(base.caseId);

    const changed = planWithCatalogue(
      mutated((documents) => {
        const oracle = documents.oracles.oracles.find(
          (entry) => (entry as Record<string, unknown>).oracleProfileId === 'geometry-delta-v1',
        ) as { checks: { expectedSchema: string }[] };
        oracle.checks[0]!.expectedSchema = 'changed-expected-schema-v1';
      }),
      request,
    );
    // The strengthened compatibility oracle fails closed: a component that no
    // longer matches the ADR 0022 accepted projection cannot be planned.
    expectBlocked(changed, 'CORRECTNESS_COMPATIBILITY_DIVERGENCE');
    expect(changed.launchAttempted).toBe(false);
  });

  it('moves the resolved correctness identity on a component change while keeping route identity', () => {
    const route = { subjectId: 'layer/text', capability: 'move' as const, variant: 'plain' };
    const base = compileResolvedCorrectnessProfile({
      catalogue: baseCatalogue,
      selection: resolveRouteSelection(baseCatalogue, route)!,
      declaredChecks: ['geometry.delta'],
    });
    const changedCatalogue = mutated((documents) => {
      const oracle = documents.oracles.oracles.find(
        (entry) => (entry as Record<string, unknown>).oracleProfileId === 'geometry-delta-v1',
      ) as { checks: { expectedSchema: string }[] };
      oracle.checks[0]!.expectedSchema = 'changed-expected-schema-v1';
    });
    const changed = compileResolvedCorrectnessProfile({
      catalogue: changedCatalogue,
      selection: resolveRouteSelection(changedCatalogue, route)!,
      declaredChecks: ['geometry.delta'],
    });
    if (!base.ok || !changed.ok) throw new Error('unreachable');
    expect(changed.profile.profileId).toBe(base.profile.profileId);
    expect(changed.profile.resolvedFingerprint).not.toBe(base.profile.resolvedFingerprint);
    expect(changed.profile.componentFingerprints.oracle).not.toBe(
      base.profile.componentFingerprints.oracle,
    );
  });
});

describe('[P7-A] delivered-route compatibility and counts (ADR 0023 §9/§11)', () => {
  const ACCEPTED_REQUIRED_CHECKS: Readonly<Record<string, readonly string[]>> = {
    'layer/text|plain': ['geometry.delta'],
    'layer/text|warp-circle': ['geometry.delta', 'geometry.warp-envelope'],
    'layer/image|static': [
      'image.content-distinct',
      'image.frame-stable',
      'image.raster-current',
      'image.semantic-transition',
      'image.structural-visual',
    ],
    'container/object|null': [
      'containment.parent-chain',
      'geometry.delta',
      'geometry.local-invariant',
      'geometry.world-composition',
    ],
    'layer/crossword|null': [
      'crossword.created',
      'crossword.different-seed-sensitive',
      'crossword.raster-current',
      'crossword.same-seed-repeatable',
      'crossword.seed-derived',
      'crossword.semantic-valid',
    ],
    'artwork/editor|null|history': ['history.depth', 'history.meaning'],
    'artwork/editor|null|frontendSerializeRestore': [
      'serialize.raw-semantic',
      'serialize.roundtrip',
    ],
  };

  it('plans all eight representative requests with one approved correctness projection', () => {
    const results = representativeRequests().map((request) => ({
      request,
      result: planWithCatalogue(baseCatalogue, request),
    }));
    expect(results).toHaveLength(8);
    const resolvedFingerprints: string[] = [];
    for (const { request, result } of results) {
      expect(result.status).toBe('PLANNED');
      expect(result.launchAttempted).toBe(false);
      if (result.status !== 'PLANNED') throw new Error('unreachable');
      expect(result.plan.correctness.profileId).not.toBeNull();
      expect(result.plan.correctness.resolvedFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.materializedCase.contracts.correctnessProfileFingerprint).toBe(
        result.plan.correctness.resolvedFingerprint,
      );
      const capabilityKey =
        request.intent.capability === 'history' ||
        request.intent.capability === 'frontendSerializeRestore'
          ? `${request.intent.subjectId}|${request.intent.variant ?? 'null'}|${request.intent.capability}`
          : `${request.intent.subjectId}|${request.intent.variant ?? 'null'}`;
      expect(result.plan.requiredChecks).toEqual(ACCEPTED_REQUIRED_CHECKS[capabilityKey]);
      resolvedFingerprints.push(result.plan.correctness.resolvedFingerprint);
    }
    // The two frontend-restore requests share exactly one resolved profile.
    const restoreFingerprints = results
      .filter(({ request }) => request.intent.capability === 'frontendSerializeRestore')
      .map(({ result }) =>
        result.status === 'PLANNED' ? result.plan.correctness.resolvedFingerprint : '',
      );
    expect(new Set(restoreFingerprints).size).toBe(1);
  });

  it('has exact reference closure over seven readiness and seven Oracle profiles', () => {
    const bundle = defaultBundle();
    const declaredChecksByBinding = new Map<string, readonly string[]>();
    for (const declaration of bundle.subjectCatalogue.declarations) {
      for (const binding of declaration.capabilityBindings) {
        declaredChecksByBinding.set(
          `${declaration.subjectId}\u0000${binding.capability}`,
          binding.checks,
        );
      }
    }
    const compiled = compileDeliveredRouteProfiles(baseCatalogue, declaredChecksByBinding);
    expect(compiled.findings).toEqual([]);
    expect(compiled.profiles).toHaveLength(7);
    expect(baseCatalogue.readiness).toHaveLength(7);
    expect(baseCatalogue.oracles).toHaveLength(7);
    for (const profile of compiled.profiles) {
      const readiness = baseCatalogue.readiness.find(
        (entry) => entry.profileId === profile.profileId,
      );
      expect(readiness).toBeDefined();
      expect(readiness?.captureProfileId).toBe(profile.capture.captureProfileId);
      expect(readiness?.oracleProfileId).toBe(profile.oracle.oracleProfileId);
      expect(profile.referenceClosure.length).toBeGreaterThan(0);
      expect(profile.nonWeakening.every((entry) => entry.satisfied)).toBe(true);
    }
  });

  it('derives the 65 / 7 / 58 / 55 / 8 accounting without execution claims', () => {
    const bundle = defaultBundle();
    const bindings = bundle.subjectCatalogue.declarations.flatMap((declaration) =>
      declaration.capabilityBindings.map((binding) => ({
        subjectId: declaration.subjectId,
        capability: binding.capability,
      })),
    );
    expect(bindings).toHaveLength(65);

    const coverageModelKeys = new Set(
      bundle.coverageCatalogue.models.map((model) => `${model.subjectId}\u0000${model.capability}`),
    );
    expect(coverageModelKeys.size).toBe(7);
    expect(
      bindings.filter(
        (binding) => !coverageModelKeys.has(`${binding.subjectId}\u0000${binding.capability}`),
      ),
    ).toHaveLength(58);

    const ledger = buildBindingCorrectnessLedger(baseCatalogue, bindings, coverageModelKeys);
    expect(ledger.filter((entry) => entry.state === 'compiled-profile')).toHaveLength(6);
    expect(ledger.filter((entry) => entry.state === 'coverage-model-only')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.state === 'profile-unavailable')).toHaveLength(58);
    // The unexecuted Object-containment model is reported as incomplete, never
    // as compiled or executed.
    const containment = ledger.find(
      (entry) => entry.subjectId === 'container/object' && entry.capability === 'changeContainment',
    );
    expect(containment?.state).toBe('coverage-model-only');

    expect(resolveSuiteRequests(loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID))).toHaveLength(8);
  });

  it('reports the structured Package-7 counts through validate --all', () => {
    const result = runValidateAll();
    expect(result.status).toBe('PASS');
    expect(result.exitCode).toBe(0);
    const details = result.details;
    if (details === null) throw new Error('unreachable');
    expect(details.correctness.counts).toMatchObject({
      declaredBindings: 65,
      coverageModels: 7,
      bindingsWithoutModels: 58,
      selectedReleaseAssignments: 55,
      representativeCases: 8,
      compiledProfiles: 7,
    });
    expect(details.correctness.deliveredRouteCoverage.missingProfiles).toEqual([]);
    expect(details.correctness.referenceClosure.resolved).toBe(true);
    expect(details.correctness.composition.satisfied).toBe(true);
    expect(details.correctness.compatibility.satisfied).toBe(true);
    // The 55 selected Release assignments are deliberately not described as the
    // 8 representative cases, and unavailable bindings stay explicit.
    expect(details.correctness.counts.selectedReleaseAssignments).not.toBe(
      details.correctness.counts.representativeCases,
    );
    expect(details.correctness.unavailableBindings.length).toBe(59);
  });

  it('introduces no new launchable route beyond the delivered set', () => {
    const undelivered = planCase({
      schemaVersion: 1,
      profile: 'diagnostic',
      provenance: 'diagnostic-request',
      evidenceDepth: 'deep',
      intent: {
        subjectId: 'container/object',
        capability: 'changeContainment',
        variant: null,
        scenario: 'containment-change',
        preState: {},
        operations: [],
        expected: {},
        resources: [],
      },
    });
    expect(
      undelivered.status === 'PLANNED'
        ? deriveLaunchability(undelivered.outputs.preflightReport).launchable
        : false,
    ).toBe(false);
  });
});

/**
 * P7-A remediation tests (ADR 0024).
 *
 * These tests prove the three rejected surfaces are closed: the route-level WP5
 * compatibility oracle — anchored to ADR 0022 semantics, not generated from the
 * new catalogues — is field-exact and mutation-complete; the visual and
 * normalization discriminants are closed with exact combination validation; and
 * the normalized typecheck comparison artifact is durable. They add no browser
 * launch, product-source change, or runtime semantic migration.
 */

type MutableCatalogue = {
  readiness: Record<string, unknown>[];
  captures: Record<string, unknown>[];
  oracles: Record<string, unknown>[];
  capabilityBaselines: Record<string, unknown>[];
  subjectAdditions: Record<string, unknown>[];
  routeSelections: Record<string, unknown>[];
  tolerances: Record<string, unknown>[];
  visuals: Record<string, unknown>[];
  normalizations: Record<string, unknown>[];
};

function mutableCatalogue(): MutableCatalogue {
  return structuredClone(baseCatalogue) as unknown as MutableCatalogue;
}

function findById<T extends Record<string, unknown>>(entries: T[], key: string, value: unknown): T {
  const found = entries.find((entry) => entry[key] === value);
  if (!found) throw new Error(`missing ${key}=${String(value)}`);
  return found;
}

/**
 * Projection paths that are not semantic fields: route/entity identity selectors
 * (they select which profile is compared, they do not carry compared meaning)
 * and `declaredChecks`, which the audit injects into the compiled side from the
 * oracle entry itself and is therefore tautological.
 */
const COMPATIBILITY_PROJECTION_IDENTITY_EXCLUSIONS: readonly string[] = [
  'route.subjectId',
  'route.capability',
  'route.variant',
  'profileId',
  'readiness.profileId',
  'capture.captureProfileId',
  'oracle.oracleProfileId',
  'capabilityBaseline.capability',
  'subjectAddition.subjectId',
  'subjectAddition.capability',
  'declaredChecks[]',
];

/**
 * Derives the semantic field inventory independently of the mutation table from
 * the real compared projection of all seven delivered routes. The meta test
 * below asserts this is exactly the 68 fields the mutation table names, so the
 * matrix can neither omit a field nor invent one.
 */
function comparedProjectionFieldPaths(): string[] {
  const fields = new Set<string>();
  for (const entry of WP5_COMPATIBILITY_ORACLE) {
    const selection = resolveRouteSelection(baseCatalogue, entry.projection.route);
    if (!selection) {
      throw new Error(`missing route selection for ${entry.projection.profileId}`);
    }
    const compiled = compileResolvedCorrectnessProfile({
      catalogue: baseCatalogue,
      selection,
      declaredChecks: entry.projection.declaredChecks,
    });
    if (!compiled.ok) {
      throw new Error(`unexpected compile failure for ${entry.projection.profileId}`);
    }
    const projection = compatibilityProjectionOfCompiledProfile(
      compiled.profile,
      selection,
      entry.projection.declaredChecks,
    );
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        fields.add(`${path}[]`);
        if (value.length > 0) walk(value[0], `${path}[]`);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          walk(child, path === '' ? key : `${path}.${key}`);
        }
        return;
      }
      fields.add(path);
    };
    walk(projection, '');
  }
  return [...fields]
    .filter((path) => !COMPATIBILITY_PROJECTION_IDENTITY_EXCLUSIONS.includes(path))
    .sort();
}

describe('[P7-A remediation] route-level WP5 compatibility oracle independence', () => {
  it('represents every delivered route with explicit ADR 0022 provenance', () => {
    expect(WP5_COMPATIBILITY_ORACLE).toHaveLength(7);
    for (const entry of WP5_COMPATIBILITY_ORACLE) {
      expect(entry.provenance).toContain('ADR 0022');
      expect(entry.projection.nonWeakeningSatisfied).toBe(true);
      expect(entry.projection.requiredChecks.length).toBeGreaterThan(0);
    }
    // The two frontend-restore requests share one route; there is no duplicate
    // route identity and no route is silently dropped.
    const keys = WP5_COMPATIBILITY_ORACLE.map(
      (entry) =>
        `${entry.projection.route.subjectId}\u0000${entry.projection.route.capability}\u0000${entry.projection.route.variant ?? '\u0000null'}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('passes for the accepted catalogue and reports zero divergence', () => {
    expect(auditWp5Compatibility(baseCatalogue)).toEqual([]);
    expect(auditCorrectnessCompatibility(baseCatalogue)).toEqual([]);
  });

  it('fails when a delivered route has no oracle entry and when an oracle route is absent', () => {
    const droppedRoute = mutableCatalogue();
    droppedRoute.routeSelections = droppedRoute.routeSelections.filter(
      (entry) => entry.subjectId !== 'layer/crossword',
    );
    expect(hasBlockingDiagnostic(auditWp5Compatibility(droppedRoute as never))).toBe(true);

    const missingCatalogueRoute = mutableCatalogue();
    missingCatalogueRoute.routeSelections = [];
    expect(hasBlockingDiagnostic(auditWp5Compatibility(missingCatalogueRoute as never))).toBe(true);
  });

  it('is insensitive to authoring reorder of semantically unordered collections', () => {
    const reordered = mutated((documents) => {
      for (const oracle of documents.oracles.oracles as {
        checks: { requiredEvidence: string[]; toleranceRefs: string[]; visualRefs: string[] }[];
        diagnosticOnlyEvidence: string[];
      }[]) {
        oracle.checks.reverse();
        oracle.diagnosticOnlyEvidence.reverse();
        for (const check of oracle.checks) {
          check.requiredEvidence.reverse();
          check.toleranceRefs.reverse();
          check.visualRefs.reverse();
        }
      }
      for (const capture of documents.capture.captures as {
        requiredSources: { currentness: string[] }[];
        evidenceItemIds: string[];
      }[]) {
        capture.requiredSources.reverse();
        capture.evidenceItemIds.reverse();
        for (const source of capture.requiredSources) source.currentness.reverse();
      }
      for (const readiness of documents.readiness.readiness as {
        currentnessIdentities: string[];
      }[]) {
        readiness.currentnessIdentities.reverse();
      }
    });
    expect(auditWp5Compatibility(reordered)).toEqual([]);
    expect(auditCorrectnessCompatibility(reordered)).toEqual([]);
  });

  it('fails on ordered fallback cadence and capture bracketing reorder', () => {
    const readiness = mutableCatalogue();
    findById(readiness.readiness, 'profileId', 'action-cycle-v1').fallbackCadenceMs = [
      250, 100, 200,
    ];
    expect(hasBlockingDiagnostic(auditWp5Compatibility(readiness as never))).toBe(true);

    const capture = mutableCatalogue();
    const singleTarget = findById(capture.captures, 'captureProfileId', 'single-target-v1');
    singleTarget.bracketing = [...(singleTarget.bracketing as string[])].reverse();
    expect(hasBlockingDiagnostic(auditWp5Compatibility(capture as never))).toBe(true);
  });

  /**
   * Table-driven compatibility-field mutation matrix (ADR 0024 §4).
   *
   * Exactly one entry per semantic field of the compared route-level projection;
   * `field` is the projection leaf path and `label` is unique. The
   * `[P7-A remediation]` meta test below derives the same field set from the
   * compiled projection (excluding route/entity identity selectors and the
   * oracle-injected `declaredChecks`, which is tautological) and proves it is
   * exactly these 68 fields, so no semantic field can be silently omitted.
   */
  const compatibilityMutations: {
    field: string;
    label: string;
    mutate: (catalogue: MutableCatalogue) => void;
  }[] = [
    {
      field: 'readiness.schemaVersion',
      label: 'readiness.schemaVersion',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').schemaVersion = 2;
      },
    },
    {
      field: 'readiness.version',
      label: 'readiness.version',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').version = 2;
      },
    },
    {
      field: 'readiness.deadlineCategory',
      label: 'readiness.deadlineCategory',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').deadlineCategory =
          'RESOURCE_RENDER_V1';
      },
    },
    {
      field: 'readiness.deadlineMs',
      label: 'readiness.deadlineMs',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').deadlineMs = 4999;
      },
    },
    {
      field: 'readiness.signalWatchdogMs',
      label: 'readiness.signalWatchdogMs',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').signalWatchdogMs = 99;
      },
    },
    {
      field: 'readiness.fallbackCadenceMs[]',
      label: 'readiness.fallbackCadenceMs (ordered)',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').fallbackCadenceMs = [200, 100, 250];
      },
    },
    {
      field: 'readiness.stableFrames',
      label: 'readiness.stableFrames',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').stableFrames = 2;
      },
    },
    {
      field: 'readiness.quiescenceRequired',
      label: 'readiness.quiescenceRequired',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').quiescenceRequired = false;
      },
    },
    {
      field: 'readiness.stableFrameRequired',
      label: 'readiness.stableFrameRequired',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').stableFrameRequired = false;
      },
    },
    {
      field: 'readiness.currentnessIdentities[]',
      label: 'readiness.currentnessIdentities',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').currentnessIdentities = ['document'];
      },
    },
    {
      field: 'readiness.captureProfileId',
      label: 'readiness.captureProfileId',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').captureProfileId =
          'typed-envelope-v1';
      },
    },
    {
      field: 'readiness.oracleProfileId',
      label: 'readiness.oracleProfileId',
      mutate: (c) => {
        findById(c.readiness, 'profileId', 'action-cycle-v1').oracleProfileId =
          'warped-text-circle-move-v1';
      },
    },
    {
      field: 'capture.schemaVersion',
      label: 'capture.schemaVersion',
      mutate: (c) => {
        findById(c.captures, 'captureProfileId', 'single-target-v1').schemaVersion = 2;
      },
    },
    {
      field: 'capture.version',
      label: 'capture.version',
      mutate: (c) => {
        findById(c.captures, 'captureProfileId', 'single-target-v1').version = 2;
      },
    },
    {
      field: 'capture.requiredSources[]',
      label: 'capture.requiredSources removal',
      mutate: (c) => {
        findById(c.captures, 'captureProfileId', 'single-target-v1').requiredSources = (
          findById(c.captures, 'captureProfileId', 'single-target-v1').requiredSources as unknown[]
        ).slice(0, 2);
      },
    },
    {
      field: 'capture.requiredSources[].sourceId',
      label: 'capture.requiredSources[].sourceId',
      mutate: (c) => {
        const sources = findById(c.captures, 'captureProfileId', 'single-target-v1')
          .requiredSources as Record<string, unknown>[];
        sources[0]!.sourceId = 'renamed-source';
      },
    },
    {
      field: 'capture.requiredSources[].role',
      label: 'capture.requiredSources[].role',
      mutate: (c) => {
        const sources = findById(c.captures, 'captureProfileId', 'single-target-v1')
          .requiredSources as Record<string, unknown>[];
        sources[0]!.role = 'semantic';
      },
    },
    {
      field: 'capture.requiredSources[].currentness[]',
      label: 'capture.requiredSources[].currentness',
      mutate: (c) => {
        const sources = findById(c.captures, 'captureProfileId', 'single-target-v1')
          .requiredSources as Record<string, unknown>[];
        sources[0]!.currentness = ['document'];
      },
    },
    {
      field: 'capture.requiredSources[].required',
      label: 'capture.requiredSources[].required',
      mutate: (c) => {
        const sources = findById(c.captures, 'captureProfileId', 'single-target-v1')
          .requiredSources as Record<string, unknown>[];
        sources[0]!.required = false;
      },
    },
    {
      field: 'capture.bracketing[]',
      label: 'capture.bracketing (ordered)',
      mutate: (c) => {
        findById(c.captures, 'captureProfileId', 'single-target-v1').bracketing = [
          ...(findById(c.captures, 'captureProfileId', 'single-target-v1').bracketing as string[]),
        ].reverse();
      },
    },
    {
      field: 'capture.acceptedObservationRule',
      label: 'capture.acceptedObservationRule',
      mutate: (c) => {
        findById(c.captures, 'captureProfileId', 'single-target-v1').acceptedObservationRule =
          `${findById(c.captures, 'captureProfileId', 'single-target-v1').acceptedObservationRule as string} changed`;
      },
    },
    {
      field: 'capture.tornCandidateHandling',
      label: 'capture.tornCandidateHandling',
      mutate: (c) => {
        findById(c.captures, 'captureProfileId', 'single-target-v1').tornCandidateHandling =
          `${findById(c.captures, 'captureProfileId', 'single-target-v1').tornCandidateHandling as string} changed`;
      },
    },
    {
      field: 'capture.evidenceItemIds[]',
      label: 'capture.evidenceItemIds',
      mutate: (c) => {
        findById(c.captures, 'captureProfileId', 'single-target-v1').evidenceItemIds = (
          findById(c.captures, 'captureProfileId', 'single-target-v1').evidenceItemIds as string[]
        ).filter((entry) => entry !== 'observation');
      },
    },
    {
      field: 'oracle.version',
      label: 'oracle.version',
      mutate: (c) => {
        findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').version = 2;
      },
    },
    {
      field: 'oracle.schemaVersion',
      label: 'oracle.schemaVersion',
      mutate: (c) => {
        findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').schemaVersion = 2;
      },
    },
    {
      field: 'oracle.evaluatorKind',
      label: 'oracle.evaluatorKind',
      mutate: (c) => {
        findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').evaluatorKind =
          'warped-text-envelope';
      },
    },
    {
      field: 'oracle.checks[]',
      label: 'oracle.checks removal',
      mutate: (c) => {
        findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks = [];
      },
    },
    {
      field: 'oracle.checks[].checkId',
      label: 'oracle.checks[].checkId',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks as Record<
          string,
          unknown
        >[];
        checks[0]!.checkId = 'renamed-check-id';
      },
    },
    {
      field: 'oracle.checks[].evaluator',
      label: 'oracle.checks[].evaluator',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks as Record<
          string,
          unknown
        >[];
        checks[0]!.evaluator = 'typed-envelope';
      },
    },
    {
      field: 'oracle.checks[].expectedSchema',
      label: 'oracle.checks[].expectedSchema',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks as Record<
          string,
          unknown
        >[];
        checks[0]!.expectedSchema = 'changed-expected-schema-v1';
      },
    },
    {
      field: 'oracle.checks[].actualSchema',
      label: 'oracle.checks[].actualSchema',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks as Record<
          string,
          unknown
        >[];
        checks[0]!.actualSchema = 'changed-actual-schema-v1';
      },
    },
    {
      field: 'oracle.checks[].requiredEvidence[]',
      label: 'oracle.checks[].requiredEvidence',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks as Record<
          string,
          unknown
        >[];
        checks[0]!.requiredEvidence = ['observation'];
      },
    },
    {
      field: 'oracle.checks[].toleranceRefs[]',
      label: 'oracle.checks[].toleranceRefs',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks as Record<
          string,
          unknown
        >[];
        checks[0]!.toleranceRefs = ['renderer-transform-px-v1'];
      },
    },
    {
      field: 'oracle.checks[].visualRefs[]',
      label: 'oracle.checks[].visualRefs',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'image-upload-replace-v1')
          .checks as Record<string, unknown>[];
        const visualCheck = checks.find((entry) => entry.checkId === 'image.structural-visual')!;
        visualCheck.visualRefs = [];
      },
    },
    {
      field: 'oracle.checks[].normalizationRef',
      label: 'oracle.checks[].normalizationRef',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'frontend-restore-v1')
          .checks as Record<string, unknown>[];
        checks[0]!.normalizationRef = null;
      },
    },
    {
      field: 'oracle.diagnosticOnlyEvidence[]',
      label: 'oracle.diagnosticOnlyEvidence (evidence-role inventory)',
      mutate: (c) => {
        findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').diagnosticOnlyEvidence = [
          'screenshot.diagnostic',
        ];
      },
    },
    {
      field: 'capabilityBaseline.checks[]',
      label: 'capability baseline checks (substitution)',
      mutate: (c) => {
        findById(c.capabilityBaselines, 'capability', 'move').checks = ['geometry.size'];
      },
    },
    {
      field: 'subjectAddition.checks[]',
      label: 'subject addition checks (removal)',
      mutate: (c) => {
        findById(c.subjectAdditions, 'subjectId', 'container/object').checks = [];
      },
    },
    {
      field: 'routeSelection.checks[]',
      label: 'route selection checks',
      mutate: (c) => {
        c.routeSelections.find(
          (entry) => entry.subjectId === 'layer/text' && entry.variant === 'warp-circle',
        )!.checks = [];
      },
    },
    {
      field: 'routeSelection.readinessProfileId',
      label: 'route selection readinessProfileId',
      mutate: (c) => {
        c.routeSelections.find(
          (entry) => entry.subjectId === 'layer/text' && entry.variant === 'plain',
        )!.readinessProfileId = 'warped-text-action-cycle-v1';
      },
    },
    {
      field: 'routeSelection.oracleProfileId',
      label: 'route selection oracleProfileId',
      mutate: (c) => {
        c.routeSelections.find(
          (entry) => entry.subjectId === 'layer/text' && entry.variant === 'plain',
        )!.oracleProfileId = 'warped-text-circle-move-v1';
      },
    },
    {
      field: 'requiredChecks[]',
      label: 'composed required-check addition',
      mutate: (c) => {
        const baseline = findById(c.capabilityBaselines, 'capability', 'move');
        baseline.checks = [...(baseline.checks as string[]), 'extra.check'];
      },
    },
    {
      field: 'nonWeakeningSatisfied',
      label: 'non-weakening result',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').toleranceRef =
          'renderer-transform-px-v1';
      },
    },
    {
      field: 'tolerances[]',
      label: 'tolerance removal',
      mutate: (c) => {
        c.tolerances = c.tolerances.filter(
          (entry) => entry.toleranceId !== 'renderer-transform-px-v1',
        );
      },
    },
    {
      field: 'tolerances[].algorithm',
      label: 'tolerance.algorithm',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').algorithm =
          'css-pixel-absolute';
      },
    },
    {
      field: 'tolerances[].compatibilityDomain',
      label: 'tolerance.compatibilityDomain',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').compatibilityDomain =
          'changed-domain';
      },
    },
    {
      field: 'tolerances[].parameters',
      label: 'tolerance.parameters',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').parameters = {
          minimumRegionPx: 6,
        };
      },
    },
    {
      field: 'tolerances[].rationale',
      label: 'tolerance.rationale',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').rationale =
          'changed rationale';
      },
    },
    {
      field: 'tolerances[].toleranceId',
      label: 'tolerance identity',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').toleranceId =
          'canonical-matrix-epsilon-v2';
      },
    },
    {
      field: 'tolerances[].units',
      label: 'tolerance.units',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').units = 'css-px';
      },
    },
    {
      field: 'tolerances[].value',
      label: 'tolerance.value',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').value = 1e-3;
      },
    },
    {
      field: 'tolerances[].version',
      label: 'tolerance.version',
      mutate: (c) => {
        findById(c.tolerances, 'toleranceId', 'canonical-matrix-epsilon-v1').version = 2;
      },
    },
    {
      field: 'visuals[]',
      label: 'visual removal',
      mutate: (c) => {
        c.visuals = c.visuals.filter((entry) => entry.visualId !== 'image-structural-visual-v1');
      },
    },
    {
      field: 'visuals[].algorithm',
      label: 'visual.algorithm',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').algorithm =
          'screenshot-capture-v1';
      },
    },
    {
      field: 'visuals[].authorityRole',
      label: 'visual.authorityRole',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').authorityRole =
          'diagnostic-only';
      },
    },
    {
      field: 'visuals[].boundedRegion',
      label: 'visual.boundedRegion',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').boundedRegion = 'viewport';
      },
    },
    {
      field: 'visuals[].currentness[]',
      label: 'visual.currentness',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').currentness = ['document'];
      },
    },
    {
      field: 'visuals[].evidenceSource',
      label: 'visual.evidenceSource',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').evidenceSource =
          'screenshot.diagnostic';
      },
    },
    {
      field: 'visuals[].mode',
      label: 'visual.mode',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').mode = 'bounded-capture';
      },
    },
    {
      field: 'visuals[].toleranceRef',
      label: 'visual.toleranceRef',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').toleranceRef = null;
      },
    },
    {
      field: 'visuals[].version',
      label: 'visual.version',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').version = 2;
      },
    },
    {
      field: 'visuals[].visualId',
      label: 'visual identity',
      mutate: (c) => {
        findById(c.visuals, 'visualId', 'image-structural-visual-v1').visualId =
          'renamed-visual-v1';
      },
    },
    {
      field: 'normalization.applicable',
      label: 'normalization applicability resolution',
      mutate: (c) => {
        const checks = findById(c.oracles, 'oracleProfileId', 'geometry-delta-v1').checks as Record<
          string,
          unknown
        >[];
        checks[0]!.normalizationRef = 'artwork-normalized-meaning-v1';
      },
    },
    {
      field: 'normalization.applicability',
      label: 'normalization.applicability',
      mutate: (c) => {
        findById(
          c.normalizations,
          'normalizationId',
          'artwork-normalized-meaning-v1',
        ).applicability = 'other-applicability';
      },
    },
    {
      field: 'normalization.evaluator',
      label: 'normalization.evaluator',
      mutate: (c) => {
        findById(c.normalizations, 'normalizationId', 'artwork-normalized-meaning-v1').evaluator =
          'other-evaluator';
      },
    },
    {
      field: 'normalization.meaningRef',
      label: 'normalization.meaningRef',
      mutate: (c) => {
        findById(c.normalizations, 'normalizationId', 'artwork-normalized-meaning-v1').meaningRef =
          'other-meaning';
      },
    },
    {
      field: 'normalization.normalizationId',
      label: 'normalization identity',
      mutate: (c) => {
        findById(
          c.normalizations,
          'normalizationId',
          'artwork-normalized-meaning-v1',
        ).normalizationId = 'artwork-normalized-meaning-v2';
      },
    },
    {
      field: 'normalization.version',
      label: 'normalization.version',
      mutate: (c) => {
        findById(c.normalizations, 'normalizationId', 'artwork-normalized-meaning-v1').version = 2;
      },
    },
  ];

  it.each(compatibilityMutations)('fails the route-level compatibility oracle on $label', ({
    mutate,
  }) => {
    const catalogue = mutableCatalogue();
    mutate(catalogue);
    expect(auditWp5Compatibility(catalogue as never).length).toBeGreaterThan(0);
    expect(hasBlockingDiagnostic(auditCorrectnessCompatibility(catalogue as never))).toBe(true);
  });

  it('meta-covers exactly the 68 semantic projection fields with unique mutation entries', () => {
    const inventory = comparedProjectionFieldPaths();
    expect(inventory).toHaveLength(68);

    expect(compatibilityMutations).toHaveLength(68);
    const fields = compatibilityMutations.map((entry) => entry.field);
    const labels = compatibilityMutations.map((entry) => entry.label);
    // One entry per semantic field: both the declared field paths and the labels
    // are unique, and the field set is exactly the derived inventory.
    expect(new Set(fields).size).toBe(68);
    expect(new Set(labels).size).toBe(68);
    expect([...fields].sort()).toEqual(inventory);
    for (const exclusion of COMPATIBILITY_PROJECTION_IDENTITY_EXCLUSIONS) {
      expect(fields).not.toContain(exclusion);
    }
  });

  it('fails on an additive required check and on a non-authoritative evidence-role change', () => {
    const added = mutableCatalogue();
    const oracle = findById(added.oracles, 'oracleProfileId', 'geometry-delta-v1');
    oracle.checks = [
      ...(oracle.checks as unknown[]),
      structuredClone((oracle.checks as unknown[])[0]),
    ];
    expect(hasBlockingDiagnostic(auditCorrectnessCompatibility(added as never))).toBe(true);

    const roleChange = mutableCatalogue();
    const rescuable = findById(roleChange.oracles, 'oracleProfileId', 'geometry-delta-v1');
    rescuable.diagnosticOnlyEvidence = [
      ...(rescuable.diagnosticOnlyEvidence as string[]),
      'geometry.delta',
    ];
    expect(hasBlockingDiagnostic(auditCorrectnessCompatibility(roleChange as never))).toBe(true);
  });

  it('resolves the explicit non-applicable normalization for routes that declare none', () => {
    const compiled = compileResolvedCorrectnessProfile({
      catalogue: baseCatalogue,
      selection: resolveRouteSelection(baseCatalogue, {
        subjectId: 'layer/text',
        capability: 'move',
        variant: 'plain',
      })!,
      declaredChecks: ['geometry.delta'],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('unreachable');
    expect(compiled.profile.normalization).toEqual({ applicable: false });
  });

  it('resolves the single approved normalization triple for the accepted restore checks', () => {
    const compiled = compileResolvedCorrectnessProfile({
      catalogue: baseCatalogue,
      selection: resolveRouteSelection(baseCatalogue, {
        subjectId: 'artwork/editor',
        capability: 'frontendSerializeRestore',
        variant: null,
      })!,
      declaredChecks: ['serialize.roundtrip'],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('unreachable');
    expect(compiled.profile.normalization.applicable).toBe(true);
    if (!compiled.profile.normalization.applicable) throw new Error('unreachable');
    expect(compiled.profile.normalization.applicability).toBe(
      NORMALIZATION_COMBINATION.applicability,
    );
    expect(compiled.profile.normalization.meaningRef).toBe(NORMALIZATION_COMBINATION.meaningRef);
    expect(compiled.profile.normalization.evaluator).toBe(NORMALIZATION_COMBINATION.evaluator);
  });

  it('rejects missing normalization on the accepted frontend-restore checks before launch', () => {
    const catalogue = mutated((documents) => {
      const oracle = documents.oracles.oracles.find(
        (entry) => (entry as Record<string, unknown>).oracleProfileId === 'frontend-restore-v1',
      ) as { checks: { normalizationRef: string | null }[] };
      for (const check of oracle.checks) check.normalizationRef = null;
    });
    expect(hasBlockingDiagnostic(auditWp5Compatibility(catalogue))).toBe(true);
    expectBlocked(
      planWithCatalogue(catalogue, requestFor('artwork/editor', 'frontendSerializeRestore', null)),
    );
  });

  it('rejects normalization applied to a route whose checks declare none', () => {
    const catalogue = mutated((documents) => {
      const oracle = documents.oracles.oracles.find(
        (entry) => (entry as Record<string, unknown>).oracleProfileId === 'geometry-delta-v1',
      ) as { checks: { normalizationRef: string | null }[] };
      oracle.checks[0]!.normalizationRef = 'artwork-normalized-meaning-v1';
    });
    expect(hasBlockingDiagnostic(auditWp5Compatibility(catalogue))).toBe(true);
    expectBlocked(planWithCatalogue(catalogue, requestFor('layer/text', 'move', 'plain')));
  });
});

describe('[P7-A remediation] closed visual discriminants and combinations (ADR 0024 §5)', () => {
  it('publishes closed individual domains and exactly two approved combinations', () => {
    expect([...VISUAL_ALGORITHMS]).toEqual(['screenshot-capture-v1', 'structural-probe-v1']);
    expect([...VISUAL_EVIDENCE_SOURCES]).toEqual(['raster.accepted', 'screenshot.diagnostic']);
    expect([...VISUAL_BOUNDED_REGIONS]).toEqual(['target-viewport-rect', 'viewport']);
    expect(VISUAL_COMBINATIONS).toHaveLength(2);
    expect(VISUAL_COMBINATIONS.map((entry) => entry.mode).sort()).toEqual([
      'bounded-capture',
      'structural',
    ]);
  });

  it('matches the required exact combination table', () => {
    expect(VISUAL_COMBINATIONS).toEqual([
      {
        mode: 'structural',
        algorithm: 'structural-probe-v1',
        evidenceSource: 'raster.accepted',
        authorityRole: 'required-authoritative',
        boundedRegion: 'target-viewport-rect',
        toleranceAlgorithm: 'backing-pixel-edge',
      },
      {
        mode: 'bounded-capture',
        algorithm: 'screenshot-capture-v1',
        evidenceSource: 'screenshot.diagnostic',
        authorityRole: 'diagnostic-only',
        boundedRegion: 'viewport',
        toleranceAlgorithm: null,
      },
    ]);
  });

  const visual = (documents: Documents, visualId: string): Record<string, unknown> => {
    const found = documents.visuals.visuals.find(
      (entry) => (entry as Record<string, unknown>).visualId === visualId,
    );
    if (!found) throw new Error(`missing visual ${visualId}`);
    return found as Record<string, unknown>;
  };

  const visualRejections: { label: string; mutate: (documents: Documents) => void }[] = [
    {
      label: 'unknown visual algorithm',
      mutate: (documents) => {
        visual(documents, 'image-structural-visual-v1').algorithm = 'unknown-algorithm';
      },
    },
    {
      label: 'unknown visual evidence source',
      mutate: (documents) => {
        visual(documents, 'image-structural-visual-v1').evidenceSource = 'unknown.evidence';
      },
    },
    {
      label: 'unknown visual bounded region',
      mutate: (documents) => {
        visual(documents, 'image-structural-visual-v1').boundedRegion = 'unknown-region';
      },
    },
    {
      label: 'screenshot marked required-authoritative',
      mutate: (documents) => {
        visual(documents, 'diagnostic-screenshot-v1').authorityRole = 'required-authoritative';
      },
    },
    {
      label: 'structural probe marked diagnostic-only',
      mutate: (documents) => {
        visual(documents, 'image-structural-visual-v1').authorityRole = 'diagnostic-only';
      },
    },
    {
      label: 'missing structural tolerance',
      mutate: (documents) => {
        visual(documents, 'image-structural-visual-v1').toleranceRef = null;
      },
    },
    {
      label: 'diagnostic screenshot with an authoritative tolerance',
      mutate: (documents) => {
        visual(documents, 'diagnostic-screenshot-v1').toleranceRef = 'backing-pixel-edge-v1';
      },
    },
    {
      label: 'cross-combination: structural mode with screenshot evidence',
      mutate: (documents) => {
        visual(documents, 'image-structural-visual-v1').evidenceSource = 'screenshot.diagnostic';
      },
    },
    {
      label: 'cross-combination: bounded capture with structural algorithm',
      mutate: (documents) => {
        visual(documents, 'diagnostic-screenshot-v1').algorithm = 'structural-probe-v1';
      },
    },
  ];

  it.each(visualRejections)('rejects $label before planning', ({ mutate }) => {
    expect(() => mutated(mutate)).toThrow(CorrectnessCatalogueError);
  });

  it('rejects an incompatible structural tolerance algorithm at validation', () => {
    const catalogue = mutated((documents) => {
      visual(documents, 'image-structural-visual-v1').toleranceRef = 'renderer-transform-px-v1';
    });
    const findings = validateCorrectnessCatalogue(catalogue);
    expect(findings.map((finding) => finding.code)).toContain(
      'CORRECTNESS_NON_WEAKENING_VIOLATION',
    );
    expect(hasBlockingDiagnostic(findings)).toBe(true);
  });
});

describe('[P7-A remediation] closed normalization discriminants (ADR 0024 §6)', () => {
  it('publishes exactly one approved applicable combination', () => {
    expect(NORMALIZATION_COMBINATION).toEqual({
      applicability: 'frontend-serialize-restore',
      meaningRef: 'artwork-product-meaning-v1',
      evaluator: 'restore-normalization-v1',
    });
  });

  const normalizationRejections: { label: string; mutate: (documents: Documents) => void }[] = [
    {
      label: 'unknown applicability',
      mutate: (documents) => {
        (documents.normalization.normalizations[0] as Record<string, unknown>).applicability =
          'unknown-applicability';
      },
    },
    {
      label: 'unknown meaning',
      mutate: (documents) => {
        (documents.normalization.normalizations[0] as Record<string, unknown>).meaningRef =
          'unknown-meaning';
      },
    },
    {
      label: 'unknown evaluator',
      mutate: (documents) => {
        (documents.normalization.normalizations[0] as Record<string, unknown>).evaluator =
          'unknown-evaluator';
      },
    },
    {
      label: 'cross-domain mismatched combination',
      mutate: (documents) => {
        (documents.normalization.normalizations[0] as Record<string, unknown>).applicability =
          'artwork-product-meaning-v1';
      },
    },
  ];

  it.each(normalizationRejections)('rejects $label before planning', ({ mutate }) => {
    expect(() => mutated(mutate)).toThrow(CorrectnessCatalogueError);
  });
});
