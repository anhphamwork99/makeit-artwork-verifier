import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import {
  RESTORE_OBSERVATION_SCHEMA_VERSION,
  RESTORE_REQUIRED_CHECKS,
  type RestoreMeaningFactView,
  type RestoreOracleFacts,
  type RestoreRawSemanticFactView,
  type RestoreTransitionFactView,
} from '../../src/contracts/restore-observation';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  RESTORE_LIVE_FACT_ISSUE_CODES,
  adaptRestoreLiveFacts,
  evaluateRestoreLiveChecks,
  projectRestoreLiveFacts,
  type RestoreLiveEvaluationObservation,
  type RestoreLiveFactFailure,
  type RestoreLiveFactRoute,
} from '../../src/adapters/restore-live-facts';
import {
  isFullCanonicalFingerprint,
  projectCorrectnessProfileIdentity,
  validateResultIdentityAgreement,
} from '../../src/index';
import { evaluateRestoreOracle, type RestoreOracleEvaluation } from '../../src/oracles/restore';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { executeWorkflowSteps, type WorkflowPrimitiveHandlers } from '../../src/workflows/execute';
import type { WorkflowStep } from '../../src/contracts/workflows';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  RestoreEvidenceAvailability,
  RestoreEvidenceFact,
  RestoreKernelFacts,
} from '../../src/index';

/**
 * P7-B2-B5 focused proof: inactive live-fact adapter for frontend
 * serialize/restore (ADR 0029 §4 B2-B, the restore half).
 *
 * The suites drive the adapter from the *real* exact envelope produced by
 * `planCaseForExecution` for the representative frontend serialize/restore
 * request and the *real* accepted `evaluateRestoreOracle` outputs over the
 * accepted Save → POST → redirect → GET → mount round trip. They cover PASS, a
 * trustworthy transition mismatch, a trustworthy raw-semantics mismatch,
 * missing/stale/torn/wrong-target/malformed/ambiguous chain authority, evidence
 * identity/agreement, fail-closed envelope rejection before the kernel, no
 * adapter policy, no active imports, no legacy boolean/harnessInvalid authority
 * in the produced structured facts (legacy flips have no effect; primitive
 * flips have effect), the preserved generic restore-marker-before-target-
 * resolution fail-closed rule, and a single-leaf mutation of every compiled
 * compatibility field.
 */

const skillRoot = resolveSkillRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();

function representativeRequest(fileName: string): unknown {
  const resolved = resolveSuiteRequests(loadDiagnosticSuite('representative'));
  const entry = resolved.find((candidate) => path.basename(candidate.relativePath) === fileName);
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

const RESTORE_REQUEST = 'artwork-editor-serialize-restore-normalized.json';

interface PreparedCase {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: RestoreLiveFactRoute;
}

function prepare(fileName: string): PreparedCase {
  const result = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (result.status !== 'PLANNED') throw new Error(`${fileName} did not plan: ${result.status}`);
  if (result.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = result.envelope;
  const intent = result.materializedCase.intent;
  expect(envelope.schemaVersion).toBe(MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION);
  return {
    envelope,
    route: {
      subjectId: intent.subjectId,
      capability: intent.capability,
      variant: intent.variant,
    },
  };
}

const restoreCase = prepare(RESTORE_REQUEST);
const profile = restoreCase.envelope.correctnessProfile;

const CHECK_IDS = ['serialize.raw-semantic', 'serialize.roundtrip'];

function cycle(actionCycleId: string): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint: profile.resolvedFingerprint,
    readinessFingerprint: profile.componentFingerprints.readiness,
  };
}

const RESTORE_CYCLE = cycle('b2b5-cycle-restore');

const MEANING_FINGERPRINT = 'a'.repeat(32);

function evidenceAll(
  overrides: Readonly<Record<string, RestoreEvidenceAvailability>> = {},
): RestoreEvidenceFact[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

// ── Real accepted frontend serialize/restore fixtures ────────────────────────

function sourceDocument(): Record<string, unknown> {
  return {
    documentId: 'doc-source',
    documentEpoch: 1,
    route: '/artwork/editor',
    observationId: 'doc-source:9',
    observationRevision: 9,
    bridgeGeneration: 1,
    normalizedFingerprint: MEANING_FINGERPRINT,
    canonicalDigest: 'b'.repeat(64),
    layoutCount: 2,
    layerCount: 5,
    historyPastDepth: 3,
    historyFutureDepth: 0,
    historyBaselineClean: false,
    activeLayoutId: 'layout-a',
    selectedLayerIds: ['layer-a-text-1'],
    viewport: { widthCss: 1440, heightCss: 1000, devicePixelRatio: 1 },
  };
}

function restoredDocument(): Record<string, unknown> {
  return {
    documentId: 'doc-restored',
    documentEpoch: 1,
    route: '/artwork/editor/424242',
    observationId: 'doc-restored:2',
    observationRevision: 2,
    bridgeGeneration: 1,
    normalizedFingerprint: MEANING_FINGERPRINT,
    canonicalDigest: 'b'.repeat(64),
    layoutCount: 2,
    layerCount: 5,
    historyPastDepth: 0,
    historyFutureDepth: 0,
    historyBaselineClean: true,
    activeLayoutId: 'layout-a',
    selectedLayerIds: [],
    viewport: { widthCss: 1440, heightCss: 1000, devicePixelRatio: 1 },
  };
}

function transitionFacts(
  overrides: Partial<RestoreTransitionFactView> = {},
): RestoreTransitionFactView {
  return {
    saveDispatchedOnce: true,
    createRequestCount: 1,
    createMethodMatches: true,
    createPathMatches: true,
    createContentTypeMatches: true,
    createAfterEpoch: true,
    getRequestCount: 1,
    getMethodMatches: true,
    getPathMatches: true,
    redirectObserved: true,
    navigateRouteMatches: true,
    documentIdentityDistinct: true,
    restoredHistoryClean: true,
    harnessHydrateCalls: 0,
    harnessStoreMutationCalls: 0,
    ...overrides,
  };
}

function meaningFacts(overrides: Partial<RestoreMeaningFactView> = {}): RestoreMeaningFactView {
  return {
    normalizedStructurallyEqual: true,
    normalizedFingerprintEqual: true,
    sourceFingerprint: MEANING_FINGERPRINT,
    restoredFingerprint: MEANING_FINGERPRINT,
    inventoryPreserved: true,
    persistenceLossDetected: false,
    ...overrides,
  };
}

function rawSemanticFacts(
  overrides: Partial<RestoreRawSemanticFactView> = {},
): RestoreRawSemanticFactView {
  return {
    crosswordPresent: true,
    generationSeed: 1789754331641,
    words: ['MAKEIT', 'CROSSWORD', 'HELLO'],
    layoutDigest: 'c'.repeat(64),
    restoredSeedMatches: true,
    restoredWordsMatch: true,
    restoredLayoutDigestMatches: true,
    rawConfigPresent: true,
    rawServerMetadataPresent: true,
    normalizedHasNoIdKey: true,
    normalizedHasNoConfigKey: true,
    normalizedHasNoServerMetadata: true,
    volatileIdsDiffer: true,
    ...overrides,
  };
}

function restoreOracleFacts(
  overrides: {
    transition?: Partial<RestoreTransitionFactView>;
    meaning?: Partial<RestoreMeaningFactView>;
    rawSemantics?: Partial<RestoreRawSemanticFactView>;
  } = {},
): RestoreOracleFacts {
  return {
    schemaVersion: 1,
    requiredChecks: RESTORE_REQUIRED_CHECKS,
    transition: transitionFacts(overrides.transition),
    meaning: meaningFacts(overrides.meaning),
    rawSemantics: rawSemanticFacts(overrides.rawSemantics),
  };
}

function setupFacts(): Record<string, unknown>[] {
  return [
    {
      role: 'setup-text',
      stepCount: 2,
      historyPastDepth: 1,
      historyFutureDepth: 0,
      historyBaselineClean: false,
      meaningFingerprint: 'd'.repeat(16),
    },
    {
      role: 'setup-image-placeholder',
      stepCount: 3,
      historyPastDepth: 2,
      historyFutureDepth: 0,
      historyBaselineClean: false,
      meaningFingerprint: 'e'.repeat(16),
    },
    {
      role: 'setup-crossword',
      stepCount: 3,
      historyPastDepth: 3,
      historyFutureDepth: 0,
      historyBaselineClean: false,
      meaningFingerprint: MEANING_FINGERPRINT,
    },
  ];
}

function readinessFacts(): Record<string, unknown> {
  return {
    policy: {
      profileId: profile.readiness.profileId,
      deadlineCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...profile.readiness.fallbackCadenceMs],
      stableFrames: profile.readiness.stableFrames,
      quiescenceRequired: profile.readiness.quiescenceRequired,
      stableFrameRequired: profile.readiness.stableFrameRequired,
    },
    observation: {
      outcome: 'signal',
      wakeSource: 'store-signal',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      observedStableFrames: profile.readiness.stableFrames,
      detail: null,
    },
  };
}

function observationOf(evaluation: RestoreOracleEvaluation): RestoreLiveEvaluationObservation {
  return {
    primitiveFacts: evaluation.primitiveFacts,
    diagnostics: evaluation.diagnostics,
  };
}

// ── Adapter invocation helpers ───────────────────────────────────────────────

type AdapterInput = Parameters<typeof adaptRestoreLiveFacts>[0];

function restoreInput(
  oracle: RestoreOracleFacts = restoreOracleFacts(),
  overrides: Partial<AdapterInput> = {},
): AdapterInput {
  const evaluation = evaluateRestoreOracle(oracle);
  return {
    envelope: restoreCase.envelope,
    route: restoreCase.route,
    actionCycle: RESTORE_CYCLE,
    schemaVersion: RESTORE_OBSERVATION_SCHEMA_VERSION,
    transition: oracle.transition,
    meaning: oracle.meaning,
    rawSemantics: oracle.rawSemantics,
    source: sourceDocument(),
    restored: restoredDocument(),
    setup: setupFacts(),
    readiness: readinessFacts(),
    oracle: observationOf(evaluation),
    evidence: evidenceAll(),
    ...overrides,
  };
}

function issueCodes(failure: RestoreLiveFactFailure): string[] {
  return failure.issues.map((issue) => issue.code);
}

function assertIdentityAgreement(
  checks: readonly CorrectnessCheckResult[],
  aCycle: ActionCycleCorrectnessIdentity,
): void {
  const identity = projectCorrectnessProfileIdentity(profile);
  const validation = validateResultIdentityAgreement(identity, {
    actionCycles: [aCycle],
    requiredChecks: checks,
  });
  expect(validation.ok).toBe(true);
  expect(validation.issues).toEqual([]);
  for (const check of checks) {
    expect(check.actionCycleRef).toBe(aCycle.actionCycleId);
    expect(check.consumedComponentFingerprints.resolvedProfile).toBe(profile.resolvedFingerprint);
    expect(check.consumedComponentFingerprints.oracle).toBe(profile.componentFingerprints.oracle);
    expect(check.consumedComponentFingerprints.capture).toBe(profile.componentFingerprints.capture);
  }
}

function statusFor(checks: readonly CorrectnessCheckResult[], checkId: string): string | undefined {
  return checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(
  checks: readonly CorrectnessCheckResult[],
  checkId: string,
): CorrectnessCheckResult | undefined {
  return checks.find((check) => check.checkId === checkId);
}

function oracleViewOf(check: CorrectnessCheckResult | undefined): Record<string, unknown> {
  const oracle = check?.actual.oracle;
  return oracle !== null && typeof oracle === 'object' ? (oracle as Record<string, unknown>) : {};
}

const EVIDENCE_BY_CHECK: Readonly<Record<string, string[]>> = Object.fromEntries(
  profile.requiredChecks.map((contract) => [
    contract.checkId,
    [...contract.requiredEvidence].sort(),
  ]),
);

// ── Envelope agreement and fail-closed adaptation ───────────────────────────

describe('[P7-B2-B5] exact-envelope agreement and fail-closed adaptation', () => {
  it('adapts the real representative restore envelope into complete structured facts', () => {
    const adaptation = adaptRestoreLiveFacts(restoreInput());
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    expect(adaptation.facts.evaluator).toBe('frontend-restore');
    expect(adaptation.facts.checks.map((entry) => entry.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    for (const entry of adaptation.facts.checks) {
      expect(entry.authority).toBe('current');
      expect(entry.currentness).toBe('current');
      expect(entry.mismatch).toBe(false);
      expect(entry.sourcesAgree).toBe(true);
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'unusable')).toBe(false);
    }
    const oracleFacts = adaptation.facts.oracleFacts;
    expect(oracleFacts).not.toBeNull();
    expect(oracleFacts?.authority).toBe('current');
    expect(oracleFacts?.sourceAgreement).toBe(true);
    expect(oracleFacts?.schemaVersion).toBe(RESTORE_OBSERVATION_SCHEMA_VERSION);
    expect(oracleFacts?.transition?.documentIdentityDistinct).toBe(true);
    expect(oracleFacts?.meaning?.normalizedFingerprintEqual).toBe(true);
    expect(oracleFacts?.rawSemantics?.crosswordPresent).toBe(true);
    expect(oracleFacts?.checks.map((check) => check.checkId).sort()).toEqual([...CHECK_IDS].sort());
    expect(adaptation.facts.schemaVersion).toBe(RESTORE_OBSERVATION_SCHEMA_VERSION);
    expect(Object.hasOwn(adaptation.facts, 'harnessInvalid')).toBe(false);
    expect(adaptation.facts.source).toEqual(sourceDocument());
    expect(adaptation.facts.restored).toEqual(restoredDocument());
    expect(adaptation.facts.setup).toEqual(setupFacts());
  });

  it('fails closed before the kernel on every envelope disagreement class', () => {
    const planFingerprint = adaptRestoreLiveFacts({
      ...restoreInput(),
      envelope: {
        ...restoreCase.envelope,
        planFingerprint: 'f'.repeat(64),
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(planFingerprint.ok).toBe(false);
    if (!planFingerprint.ok) {
      expect(planFingerprint.status).toBe('HARNESS_BLOCKED');
      expect(planFingerprint.launchAttempted).toBe(false);
      expect(issueCodes(planFingerprint)).toContain('ENVELOPE_PLAN_FINGERPRINT_MISMATCH');
    }

    const caseId = adaptRestoreLiveFacts({
      ...restoreInput(),
      envelope: {
        ...restoreCase.envelope,
        caseId: 'other-case',
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(caseId.ok).toBe(false);

    const routeMismatch = adaptRestoreLiveFacts({
      ...restoreInput(),
      route: { ...restoreCase.route, variant: 'foreign-variant' },
    });
    expect(routeMismatch.ok).toBe(false);
    if (!routeMismatch.ok) {
      expect(issueCodes(routeMismatch)).toContain('ENVELOPE_ROUTE_MISMATCH');
    }

    const evaluatorMismatch = adaptRestoreLiveFacts({
      ...restoreInput(),
      envelope: {
        ...restoreCase.envelope,
        correctnessProfile: {
          ...profile,
          oracle: { ...profile.oracle, evaluatorKind: 'history-cross-subject' },
        },
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(evaluatorMismatch.ok).toBe(false);
    if (!evaluatorMismatch.ok) {
      expect(issueCodes(evaluatorMismatch)).toContain('ENVELOPE_ORACLE_EVALUATOR_UNSUPPORTED');
    }

    const actionCycleMismatch = adaptRestoreLiveFacts({
      ...restoreInput(),
      actionCycle: { ...RESTORE_CYCLE, resolvedProfileFingerprint: 'a'.repeat(64) },
    });
    expect(actionCycleMismatch.ok).toBe(false);
    if (!actionCycleMismatch.ok) {
      expect(issueCodes(actionCycleMismatch)).toContain('ENVELOPE_ACTION_CYCLE_MISMATCH');
    }

    const readinessMismatch = adaptRestoreLiveFacts({
      ...restoreInput(),
      actionCycle: { ...RESTORE_CYCLE, readinessFingerprint: 'b'.repeat(64) },
    });
    expect(readinessMismatch.ok).toBe(false);
    if (!readinessMismatch.ok) {
      expect(issueCodes(readinessMismatch)).toContain('ENVELOPE_READINESS_MISMATCH');
    }

    const invalidEvidence = adaptRestoreLiveFacts({
      ...restoreInput(),
      evidence: [{ evidenceId: 'observation', availability: 'invented' } as never],
    });
    expect(invalidEvidence.ok).toBe(false);
    if (!invalidEvidence.ok) {
      expect(issueCodes(invalidEvidence)).toContain('RESTORE_LIVE_EVIDENCE_FACT_INVALID');
    }

    const malformedObservation = adaptRestoreLiveFacts({
      ...restoreInput(),
      oracle: {
        primitiveFacts: { authority: 'current' },
      } as unknown as RestoreLiveEvaluationObservation,
    });
    expect(malformedObservation.ok).toBe(false);
    if (!malformedObservation.ok) {
      expect(issueCodes(malformedObservation)).toContain('RESTORE_LIVE_OBSERVATION_MALFORMED');
    }

    const unknownIssueCodes = new Set<string>(RESTORE_LIVE_FACT_ISSUE_CODES);
    for (const failed of [
      planFingerprint,
      routeMismatch,
      actionCycleMismatch,
      invalidEvidence,
      malformedObservation,
    ]) {
      if (failed.ok) continue;
      for (const issue of failed.issues) {
        expect(unknownIssueCodes.has(issue.code)).toBe(true);
      }
    }
  });

  it('never invokes the kernel on a disagreeing envelope', () => {
    const failed = evaluateRestoreLiveChecks({
      ...restoreInput(),
      actionCycle: { ...RESTORE_CYCLE, resolvedProfileFingerprint: 'c'.repeat(64) },
    });
    expect(failed.ok).toBe(false);
    expect(Object.hasOwn(failed, 'result')).toBe(false);
    expect(Object.hasOwn(failed, 'facts')).toBe(false);
  });
});

// ── Restore live-fact behavior ──────────────────────────────────────────────

describe('[P7-B2-B5] Restore live facts', () => {
  it('produces complete PASS checks with identity/evidence agreement', () => {
    const outcome = evaluateRestoreLiveChecks(restoreInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    for (const check of outcome.result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.actual.authority).toBe('current');
      expect(check.actual.authorityScope).toBeNull();
      expect(check.evidenceIds).toEqual(EVIDENCE_BY_CHECK[check.checkId]);
    }
    assertIdentityAgreement(outcome.result.checks, RESTORE_CYCLE);
  });

  it('fails only the roundtrip check for a coherently false redirect/transition fact', () => {
    const oracle = restoreOracleFacts({ transition: { redirectObserved: false } });
    const evaluation = evaluateRestoreOracle(oracle);
    expect(evaluation.harnessInvalid).toBe(false);

    const outcome = evaluateRestoreLiveChecks(restoreInput(oracle));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'serialize.roundtrip')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'serialize.raw-semantic')).toBe('PASS');
    expect(checkFor(outcome.result.checks, 'serialize.roundtrip')?.actual.authority).toBe(
      'current',
    );
    expect(oracleViewOf(checkFor(outcome.result.checks, 'serialize.roundtrip'))).toEqual({
      authority: 'current',
      currentness: 'current',
      sourcesAgree: true,
      mismatch: true,
    });
    assertIdentityAgreement(outcome.result.checks, RESTORE_CYCLE);
  });

  it('fails only the raw-semantic check for a lost raw Crossword/config fact', () => {
    const oracle = restoreOracleFacts({ rawSemantics: { restoredSeedMatches: false } });
    const evaluation = evaluateRestoreOracle(oracle);
    expect(evaluation.harnessInvalid).toBe(false);

    const outcome = evaluateRestoreLiveChecks(restoreInput(oracle));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'serialize.raw-semantic')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'serialize.roundtrip')).toBe('PASS');
    const raw = checkFor(outcome.result.checks, 'serialize.raw-semantic')?.actual
      .rawSemantics as Record<string, unknown>;
    expect(raw.restoredSeedMatches).toBe(false);
    assertIdentityAgreement(outcome.result.checks, RESTORE_CYCLE);
  });

  it('fails only the roundtrip check for a structurally unequal restored meaning', () => {
    const oracle = restoreOracleFacts({ meaning: { normalizedStructurallyEqual: false } });
    const evaluation = evaluateRestoreOracle(oracle);
    expect(evaluation.harnessInvalid).toBe(false);
    const outcome = evaluateRestoreLiveChecks(restoreInput(oracle));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'serialize.roundtrip')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'serialize.raw-semantic')).toBe('PASS');
    const meaning = checkFor(outcome.result.checks, 'serialize.roundtrip')?.actual
      .meaning as Record<string, unknown>;
    expect(meaning.normalizedStructurallyEqual).toBe(false);
  });

  it('never lets one failing check rescue the other', () => {
    const oracle = restoreOracleFacts({
      transition: { redirectObserved: false },
      rawSemantics: { rawConfigPresent: false },
    });
    const outcome = evaluateRestoreLiveChecks(restoreInput(oracle));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'serialize.roundtrip')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'serialize.raw-semantic')).toBe('FAIL');
    expect(outcome.result.checks.every((check) => check.actual.authority === 'current')).toBe(true);
  });

  it('produces UNUSABLE for missing/malformed/stale/torn/wrong-target/ambiguous authority', () => {
    const base = restoreInput();

    const caseList: readonly [string, Partial<AdapterInput>, string][] = [
      ['absent source observation', { source: null }, 'missing'],
      ['non-object source observation', { source: 'not-an-observation' }, 'missing'],
      ['absent restored observation', { restored: null }, 'missing'],
      [
        'wrong-target restored identity',
        {
          restored: { ...restoredDocument(), documentId: 'doc-source' },
          transition: transitionFacts({ documentIdentityDistinct: false }),
        },
        'wrong-target',
      ],
      [
        'ambiguous reused restored observation identity',
        { restored: { ...restoredDocument(), observationId: 'doc-source:9' } },
        'ambiguous',
      ],
      [
        'malformed absent bridge generation',
        { source: { ...sourceDocument(), bridgeGeneration: undefined } },
        'malformed',
      ],
      [
        'malformed non-product-exact source baselineClean',
        { source: { ...sourceDocument(), historyBaselineClean: true } },
        'malformed',
      ],
      [
        'malformed absent observed route',
        { restored: { ...restoredDocument(), route: '' } },
        'missing',
      ],
    ];

    for (const [label, overrides, expectedAuthority] of caseList) {
      const outcome = evaluateRestoreLiveChecks({ ...base, ...overrides });
      expect(outcome.ok, label).toBe(true);
      if (!outcome.ok) continue;
      for (const check of outcome.result.checks) {
        expect(check.status, label).toBe('UNUSABLE');
        expect(check.actual.authority, label).toBe(expectedAuthority);
      }
    }
  });

  it('is UNUSABLE for readiness timeout/invalidated/unavailable/stale observations', () => {
    for (const outcome of ['timeout', 'invalidated', 'unavailable', 'stale'] as const) {
      const readiness = readinessFacts() as Record<string, unknown>;
      const result = evaluateRestoreLiveChecks(
        restoreInput(restoreOracleFacts(), {
          readiness: {
            ...readiness,
            observation: {
              ...(readiness.observation as Record<string, unknown>),
              outcome,
            },
          },
        }),
      );
      expect(result.ok, outcome).toBe(true);
      if (!result.ok) continue;
      expect(result.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(result.result.issues.map((entry) => entry.code)).toContain(
        'RESTORE_KERNEL_READINESS_AUTHORITY_UNUSABLE',
      );
    }
  });

  it('is UNUSABLE (malformed) for a readiness policy that diverges from the compiled authority', () => {
    const readiness = readinessFacts() as Record<string, unknown>;
    const result = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), {
        readiness: {
          ...readiness,
          policy: {
            ...(readiness.policy as Record<string, unknown>),
            deadlineMs: ((readiness.policy as Record<string, unknown>).deadlineMs as number) + 1000,
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.result.checks.every((check) => check.actual.authority === 'malformed')).toBe(
      true,
    );
    expect(result.result.issues.map((entry) => entry.code)).toContain(
      'RESTORE_KERNEL_READINESS_POLICY_MISMATCH',
    );
  });

  it('is UNUSABLE for an unsupported restore observation schema', () => {
    const result = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), { schemaVersion: 99 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.result.issues.map((entry) => entry.code)).toContain(
      'RESTORE_KERNEL_FACTS_SCHEMA_UNSUPPORTED',
    );
  });

  it('treats a malformed Oracle evaluation as malformed primitive authority', () => {
    const evaluation = evaluateRestoreOracle({
      ...restoreOracleFacts(),
      schemaVersion: 99 as unknown as 1,
    });
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.primitiveFacts.authority).toBe('malformed');
    expect(evaluation.primitiveFacts.transition).toBeNull();
    expect(evaluation.primitiveFacts.meaning).toBeNull();
    expect(evaluation.primitiveFacts.rawSemantics).toBeNull();
    expect(evaluation.primitiveFacts.checks.every((check) => check.predicateMet === false)).toBe(
      true,
    );

    const outcome = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), { oracle: observationOf(evaluation) }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(oracleViewOf(check).mismatch).toBe(false);
    }
  });

  it('produces UNUSABLE for a declared check with no accepted fact when the Oracle never ran', () => {
    const outcome = evaluateRestoreLiveChecks(restoreInput(restoreOracleFacts(), { oracle: null }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.checks).toEqual([]);
    expect(outcome.facts.oracleFacts).toBeNull();
    for (const checkId of CHECK_IDS) {
      expect(statusFor(outcome.result.checks, checkId)).toBe('UNUSABLE');
      expect(checkFor(outcome.result.checks, checkId)?.actual.authority).toBe('missing');
    }
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'RESTORE_KERNEL_FACT_CHECK_MISSING',
    );
  });

  it('passes the observed evidence roles through untouched and never invents a role', () => {
    const observed = evidenceAll();
    const outcome = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), { evidence: observed }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.evidence).toEqual(observed);
  });

  it('never lets a diagnostic evidence item rescue a required check', () => {
    const outcome = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), {
        evidence: evidenceAll({ 'restore.source-snapshot': 'diagnostic-only' }),
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'RESTORE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
    );
    for (const check of outcome.result.checks) {
      expect(check.evidenceIds).not.toContain('restore.source-snapshot');
    }
  });

  it('is UNUSABLE for the dependent checks when required authority is torn', () => {
    const outcome = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), {
        evidence: evidenceAll({ 'restore.route-request': 'torn' }),
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.evidenceIds).not.toContain('restore.route-request');
      expect(check.actual.authority).toBe('torn');
    }
  });

  it('reports undeclared evidence claiming authority without consuming it', () => {
    const outcome = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), {
        evidence: [
          ...evidenceAll(),
          { evidenceId: 'uncalibrated.extra', availability: 'authoritative' },
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'RESTORE_KERNEL_EVIDENCE_UNDECLARED',
    );
    for (const check of outcome.result.checks) {
      expect(check.evidenceIds).not.toContain('uncalibrated.extra');
    }
  });

  it('carries no legacy harnessInvalid or boolean check authority into the kernel facts', () => {
    const adaptation = adaptRestoreLiveFacts(restoreInput());
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const facts = adaptation.facts as RestoreKernelFacts;
    expect(Object.hasOwn(facts, 'harnessInvalid')).toBe(false);
    expect(Object.hasOwn(facts, 'checks')).toBe(true);
    for (const check of facts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'unusable')).toBe(false);
      expect(typeof check.authority).toBe('string');
      expect(typeof check.currentness).toBe('string');
      expect(typeof check.sourcesAgree).toBe('boolean');
      expect(typeof check.mismatch).toBe('boolean');
    }
  });
});

// ── Legacy authority elimination ────────────────────────────────────────────

describe('[P7-B2-B5] legacy authority elimination', () => {
  it('derives facts only from additive primitive observations, never from legacy booleans', () => {
    const baseline = evaluateRestoreLiveChecks(restoreInput());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.result.checks.every((check) => check.status === 'PASS')).toBe(true);

    // Flip every legacy composite check-result boolean and the aggregate
    // harness-validity flag while leaving the additive primitive facts
    // byte-identical. The adapter must not observe any difference.
    const evaluation = evaluateRestoreOracle(restoreOracleFacts());
    const flipped = {
      ...evaluation,
      checks: evaluation.checks.map((check) => ({ ...check, passed: !check.passed })),
      passed: !evaluation.passed,
      harnessInvalid: !evaluation.harnessInvalid,
    };
    const afterFlip = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), {
        oracle: {
          primitiveFacts: flipped.primitiveFacts,
          diagnostics: flipped.diagnostics,
        } as unknown as RestoreLiveEvaluationObservation,
      }),
    );
    expect(afterFlip.ok).toBe(true);
    if (!afterFlip.ok) return;
    expect(afterFlip.result.checks).toEqual(baseline.result.checks);
    expect(afterFlip.facts).toEqual(baseline.facts);

    // A genuine primitive predicate change must change the adapter output.
    const tamperedPrimitives = {
      ...evaluation.primitiveFacts,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        ...check,
        predicateMet: false,
      })),
    };
    const afterPrimitive = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), {
        oracle: {
          primitiveFacts: tamperedPrimitives,
          diagnostics: evaluation.diagnostics,
        } as unknown as RestoreLiveEvaluationObservation,
      }),
    );
    expect(afterPrimitive.ok).toBe(true);
    if (!afterPrimitive.ok) return;
    expect(afterPrimitive.result.checks.every((check) => check.status === 'FAIL')).toBe(true);
    for (const check of afterPrimitive.result.checks) {
      expect(check.actual.authority).toBe('current');
      expect(oracleViewOf(check).currentness).toBe('current');
      expect(oracleViewOf(check).mismatch).toBe(true);
    }
  });

  it('derives malformed authority from the primitive authority, not the aggregate harness flag', () => {
    const evaluation = evaluateRestoreOracle(restoreOracleFacts());
    expect(evaluation.harnessInvalid).toBe(false);
    const primitives = {
      ...evaluation.primitiveFacts,
      authority: 'malformed' as const,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        ...check,
        predicateMet: true,
      })),
    };
    const outcome = evaluateRestoreLiveChecks(
      restoreInput(restoreOracleFacts(), {
        oracle: {
          primitiveFacts: primitives,
          diagnostics: evaluation.diagnostics,
        } as unknown as RestoreLiveEvaluationObservation,
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(oracleViewOf(check).mismatch).toBe(false);
    }
  });

  it('projects the source/restored correlation primitive into the structured sourcesAgree fact', () => {
    const evaluation = evaluateRestoreOracle(restoreOracleFacts());
    expect(evaluation.primitiveFacts.sourceAgreement).toBe(true);
    const broken = { ...evaluation.primitiveFacts, sourceAgreement: false };
    const projected = projectRestoreLiveFacts({
      primitiveFacts: broken,
      diagnostics: evaluation.diagnostics,
    });
    expect(projected.length).toBeGreaterThan(0);
    for (const entry of projected) {
      expect(entry.sourcesAgree).toBe(false);
      expect(entry.authority).toBe('current');
    }
    const correlated = projectRestoreLiveFacts({
      primitiveFacts: evaluation.primitiveFacts,
      diagnostics: evaluation.diagnostics,
    });
    for (const entry of correlated) {
      expect(entry.sourcesAgree).toBe(true);
    }
  });

  it('emits no aggregate harnessInvalid and no boolean oracle authority in the result payload', () => {
    const outcome = evaluateRestoreLiveChecks(restoreInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const check of outcome.result.checks) {
      expect(Object.hasOwn(check.actual, 'harnessInvalid')).toBe(false);
      expect(Object.hasOwn(check.actual.oracle as object, 'passed')).toBe(false);
      expect(oracleViewOf(check)).toEqual({
        authority: 'current',
        currentness: 'current',
        sourcesAgree: true,
        mismatch: false,
      });
      const oracleFacts = check.actual.oracleFacts as Record<string, unknown>;
      expect(oracleFacts.authority).toBe('current');
      expect(oracleFacts.sourceAgreement).toBe(true);
      expect(oracleFacts.transition).not.toBeNull();
      expect(oracleFacts.meaning).not.toBeNull();
      expect(oracleFacts.rawSemantics).not.toBeNull();
    }
  });

  it('preserves the active Oracle consumers additively', () => {
    const evaluation = evaluateRestoreOracle(restoreOracleFacts());
    // Legacy fields the active runtime still consumes remain exactly as before.
    expect(evaluation.checks.map((check) => check.checkId).sort()).toEqual(
      [...RESTORE_REQUIRED_CHECKS].sort(),
    );
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.diagnostics).toEqual([]);
    // The additive primitive facts carry only named primitives, never a boolean
    // check result or aggregate harness flag.
    expect(evaluation.primitiveFacts.authority).toBe('current');
    expect(evaluation.primitiveFacts.sourceAgreement).toBe(true);
    expect(evaluation.primitiveFacts.transition?.documentIdentityDistinct).toBe(true);
    expect(evaluation.primitiveFacts.meaning?.normalizedFingerprintEqual).toBe(true);
    expect(evaluation.primitiveFacts.rawSemantics?.crosswordPresent).toBe(true);
    expect(evaluation.primitiveFacts.checks.map((check) => check.checkId).sort()).toEqual(
      [...RESTORE_REQUIRED_CHECKS].sort(),
    );
    expect(Object.hasOwn(evaluation.primitiveFacts, 'passed')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'status')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'harnessInvalid')).toBe(false);
    for (const check of evaluation.primitiveFacts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(typeof check.predicateMet).toBe('boolean');
    }
    // The adapter's structured projection never carries the raw legacy booleans.
    const projected = projectRestoreLiveFacts({
      primitiveFacts: evaluation.primitiveFacts,
      diagnostics: evaluation.diagnostics,
    });
    for (const entry of projected) {
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'unusable')).toBe(false);
      expect(typeof entry.authority).toBe('string');
      expect(typeof entry.mismatch).toBe('boolean');
    }
  });
});

// ── No adapter policy, no active imports, no legacy authority ───────────────

describe('[P7-B2-B5] inactive adapter invariants', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const adapterSource = source('src/adapters/restore-live-facts.ts');
  const kernelSource = source('src/kernels/restore-kernel.ts');

  it('does not import any active executor, Oracle, evidence writer, CLI, browser, or classifier', () => {
    expect(adapterSource).not.toMatch(
      /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
    );
    for (const token of [
      'execute-plan',
      'execute-restore-plan',
      'evaluateRestoreOracle',
      'writeRunRecord',
      'outcomes',
      'contracts/execution',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('owns no required-check array, fallback id, deadline, tolerance, visual, or normalization literal', () => {
    for (const token of [
      "'serialize.roundtrip'",
      "'serialize.raw-semantic'",
      "'frontend-restore-v1'",
      "'frontend-restore-transition-v1'",
      "'FRONTEND_RESTORE_V1'",
      "'artwork-normalized-meaning-v1'",
      'deadlineMs',
      'signalWatchdogMs',
      'fallbackCadenceMs',
      'quiescenceRequired',
      'stableFrameRequired',
      '15000',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
    // The raw readiness observation is a delivered primitive fact validated by
    // the kernel; the adapter never reads the compiled readiness policy and
    // never decides with it.
    const policyFreeCode = adapterSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(policyFreeCode).not.toMatch(/readiness\.(policy|observation)/);
    expect(policyFreeCode).not.toContain('profile.readiness');
  });

  it('performs no authoring-catalogue reload or route/Subject/scenario dispatch', () => {
    for (const token of [
      'loadCorrectnessCatalogue',
      'loadCatalogueBundle',
      'compileResolvedCorrectnessProfile',
      'resolveRouteSelection',
      'routeSelections',
      "subjectId === '",
      "variant === '",
      'switch (',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('never defaults an evidence role and never translates a boolean into a final status', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bpassed\b/);
    expect(code).not.toMatch(/\bunusable\b/);
    expect(code).not.toMatch(/\bharnessInvalid\b/);
    expect(code).not.toMatch(/\.status\b/);
    expect(code).not.toMatch(/'PASS'|'FAIL'/);
    // The only nested read surface is the additive primitive view.
    expect(code).toContain('primitiveFacts');
    // The reconciled kernel fact contract no longer exposes legacy authority.
    expect(kernelSource).not.toMatch(/readonly passed: boolean/);
    expect(kernelSource).not.toMatch(/readonly unusable: boolean/);
    expect(kernelSource).not.toMatch(/readonly harnessInvalid: boolean/);
    expect(kernelSource).not.toContain('RESTORE_KERNEL_HARNESS_INVALID');
  });

  it('is inactive: not exported from the public barrel and unreferenced by active modules', () => {
    const indexSource = source('src/index.ts');
    expect(indexSource).not.toContain('restore-live-facts');
    expect(indexSource).not.toContain('adaptRestoreLiveFacts');
    expect(indexSource).not.toContain('evaluateRestoreLiveChecks');
  });

  it('fails closed with a structured diagnostic on every reported issue', () => {
    const failure = adaptRestoreLiveFacts({
      ...restoreInput(),
      evidence: [{ evidenceId: 'x', availability: 'nope' } as never],
    });
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.status).toBe('HARNESS_BLOCKED');
    expect(failure.launchAttempted).toBe(false);
    expect(failure.diagnostic.code).toBe('UNUSABLE_EVIDENCE');
    expect(failure.diagnostic.detail).toContain('RESTORE_LIVE_EVIDENCE_FACT_INVALID');
  });
});

// ── Preserved B0 generic-executor restore-marker guard ──────────────────────

describe('[P7-B2-B5] preserved B0 restore-marker guard (no fabricated target/check)', () => {
  function markerStep(): WorkflowStep {
    return {
      stepId: 'serialize.restore.capture',
      primitive: 'frontend.restore.capture',
      targetRole: 'frontend:restore',
      parameters: [],
    };
  }

  function sealedHandlers(invoked: string[]): WorkflowPrimitiveHandlers {
    const record = (name: string) => {
      invoked.push(name);
      return { ok: true, detail: 'handler must not be reached' };
    };
    return {
      pointerDrag: async () => record('pointerDrag'),
      pointerClick: async () => record('pointerClick'),
      controlActivate: async () => record('controlActivate'),
      keyboardPress: async () => record('keyboardPress'),
      fileInputSet: async () => record('fileInputSet'),
    };
  }

  it('refuses the restore marker before any target resolution or handler', async () => {
    const invoked: string[] = [];
    const result = await executeWorkflowSteps({
      steps: [markerStep()],
      operation: undefined,
      resolutions: [
        {
          role: 'frontend:restore',
          status: 'resolved',
          matchCount: 1,
          matchedElementIds: ['fabricated'],
          target: {
            role: 'frontend:restore',
            elementId: 'fabricated',
            kind: 'text',
            parentId: null,
          },
          detail: 'fabricated target the restore marker must never resolve',
        },
      ],
      points: { fabricated: { x: 1, y: 1 } },
      handlers: sealedHandlers(invoked),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.finding.code).toBe('WORKFLOW_STEP_UNKNOWN');
    expect(result.logs).toEqual([]);
    expect(invoked).toEqual([]);
    expect(Object.hasOwn(result.finding.context ?? {}, 'targetElementId')).toBe(false);
    expect(Object.hasOwn(result.finding.context ?? {}, 'checkId')).toBe(false);
  });

  it('never adapts a fabricated restore marker observation into a target or check', () => {
    // The adapter consumes only the accepted restore live facts; an injected
    // fabricated target resolution is not part of any single input it reads and
    // cannot change the produced checks.
    const baseline = evaluateRestoreLiveChecks(restoreInput());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const injected = evaluateRestoreLiveChecks({
      ...restoreInput(),
      // Extra undeclared field: a fabricated per-check record must be ignored.
      fabricatedTargetResolution: { role: 'frontend:restore', elementId: 'fabricated' },
    } as unknown as AdapterInput);
    expect(injected.ok).toBe(true);
    if (!injected.ok) return;
    expect(injected.result.checks).toEqual(baseline.result.checks);
  });

  it('still accepts a non-restore step through the same executor', async () => {
    const invoked: string[] = [];
    const result = await executeWorkflowSteps({
      steps: [
        {
          stepId: 'activate-save',
          primitive: 'control.activate',
          targetRole: 'control:save',
          parameters: [],
        },
      ],
      operation: undefined,
      resolutions: [],
      points: {},
      handlers: sealedHandlers(invoked),
    });
    expect(result.ok).toBe(true);
    expect(invoked).toEqual(['controlActivate']);
  });
});

// ── Compiled compatibility mutation matrix ──────────────────────────────────

function collectLeafPaths(value: unknown, prefix: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectLeafPaths(entry, prefix === '' ? `[${index}]` : `${prefix}[${index}]`, out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectLeafPaths(child, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  out.push(prefix);
}

function mutateLeaf(root: Record<string, unknown>, leafPath: string): void {
  const parts = leafPath.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node: unknown = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    node = (node as Record<string, unknown>)[parts[index] as string];
  }
  const leaf = (node as Record<string, unknown>)[parts[parts.length - 1] as string];
  let replacement: unknown = 'mutated';
  if (typeof leaf === 'string') replacement = `${leaf}-mutated`;
  else if (typeof leaf === 'number') replacement = leaf + 1;
  else if (typeof leaf === 'boolean') replacement = !leaf;
  (node as Record<string, unknown>)[parts[parts.length - 1] as string] = replacement;
}

function mutatedEnvelope(
  envelope: MaterializedExecutionEnvelopeV1,
  leafPath: string,
): MaterializedExecutionEnvelopeV1 {
  const clone = structuredClone(envelope) as unknown as Record<string, unknown>;
  mutateLeaf(clone, `correctnessProfile.${leafPath}`);
  return clone as unknown as MaterializedExecutionEnvelopeV1;
}

describe('[P7-B2-B5] compiled compatibility mutation matrix', () => {
  const leafPaths: string[] = [];
  collectLeafPaths(profile, '', leafPaths);
  const baseInput = restoreInput();

  it('covers the complete compiled frontend serialize/restore profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(150);
  });

  it('detects every single-leaf mutation of the compiled restore profile', () => {
    for (const leafPath of leafPaths) {
      const adaptation = adaptRestoreLiveFacts({
        ...baseInput,
        envelope: mutatedEnvelope(restoreCase.envelope, leafPath),
      });
      expect(adaptation.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });

  it('detects a mutated component fingerprint retained against the stored resolved identity', () => {
    const clone = structuredClone(profile) as unknown as Record<string, unknown>;
    (clone.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const adaptation = adaptRestoreLiveFacts({
      ...baseInput,
      envelope: {
        ...restoreCase.envelope,
        correctnessProfile: clone,
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(adaptation.ok).toBe(false);
  });

  it('keeps an unrelated valid envelope accepted after the mutation matrix', () => {
    const adaptation = adaptRestoreLiveFacts(baseInput);
    expect(adaptation.ok).toBe(true);
    if (adaptation.ok) {
      expect(adaptation.facts.oracleFacts).not.toBeNull();
      expect(adaptation.facts.checks).toHaveLength(CHECK_IDS.length);
      expect(isFullCanonicalFingerprint(profile.resolvedFingerprint)).toBe(true);
    }
  });
});
