import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  RESTORE_OBSERVATION_SCHEMA_VERSION,
  RESTORE_REQUIRED_CHECKS,
  RESTORE_SAVE_CONTROL,
  type RestoreMeaningFactView,
  type RestoreOracleFacts,
  type RestoreRawSemanticFactView,
  type RestoreTransitionFactView,
} from '../../src/contracts/restore-observation';
import { evaluateRestoreOracle, type RestoreOracleEvaluation } from '../../src/oracles/restore';
import { executeWorkflowSteps, type WorkflowPrimitiveHandlers } from '../../src/workflows/execute';
import type { WorkflowStep } from '../../src/contracts/workflows';
import {
  compileResolvedCorrectnessProfile,
  deriveResolvedCorrectnessProfileFingerprint,
  evaluateRestoreChecks,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  restoreKernelKindForEvaluator,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  ResolvedCorrectnessProfile,
  RestoreDocumentObservationFact,
  RestoreEvaluatorFact,
  RestoreEvidenceAvailability,
  RestoreEvidenceFact,
  RestoreKernelFacts,
  RestoreKernelIssueCode,
  RestoreKernelResult,
  RestoreOracleFactsView,
  RestoreReadinessFact,
  RestoreReadinessObservationFact,
  RestoreSetupCheckpointFact,
} from '../../src/index';

/**
 * P7-B B1-F2 inactive compiled-profile frontend serialize/restore kernel tests
 * (ADR 0028 §3 B1-F, the restore half; B1-F1 owns the History half).
 *
 * The kernel is pure and inactive: it is never reached from an active executor,
 * Oracle, classifier, or writer. These tests drive it directly — including with
 * real `evaluateRestoreOracle` facts over the accepted Save→POST→redirect→GET→
 * mount contract — and independently re-validate every produced check with the
 * B1-A compiled-profile/result agreement validator. They also preserve the
 * accepted B0 generic-executor rule: the `frontend.restore.capture` marker is
 * refused before any target resolution and never fabricates a target or check.
 * B1-F is complete only when F1 and F2 are jointly green.
 */

const ROUTE = {
  subjectId: 'artwork/editor',
  capability: 'frontendSerializeRestore' as const,
  variant: null,
};

const CHECKS = ['serialize.raw-semantic', 'serialize.roundtrip'];

/** The accepted normalized-meaning fingerprint carried on both round-trip sides. */
const MEANING_FINGERPRINT = 'a'.repeat(32);

// ── Real accepted restore execution facts ────────────────────────────────────

function sourceDocument(): RestoreDocumentObservationFact {
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

function restoredDocument(): RestoreDocumentObservationFact {
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

function oracleFacts(
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

function setupFacts(): RestoreSetupCheckpointFact[] {
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

// ── Kernel scaffolding ───────────────────────────────────────────────────────

const catalogue = loadCorrectnessCatalogue();

function compile(): ResolvedCorrectnessProfile {
  const selection = resolveRouteSelection(catalogue, ROUTE);
  if (selection === null) throw new Error('missing frontend serialize/restore route selection');
  // The planner compiles this route with the Subject binding's declared
  // `serialize.roundtrip` check; this is the exact runtime compiled profile.
  const compiled = compileResolvedCorrectnessProfile({
    catalogue,
    selection,
    declaredChecks: ['serialize.roundtrip'],
  });
  if (!compiled.ok) throw new Error('frontend serialize/restore route failed to compile');
  return compiled.profile;
}

const profile = compile();
const identity = projectCorrectnessProfileIdentity(profile);

function cycle(
  source: ResolvedCorrectnessProfile = profile,
  id = 'action-cycle-restore-1',
): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId: id,
    resolvedProfileFingerprint: source.resolvedFingerprint,
    readinessFingerprint: source.componentFingerprints.readiness,
  };
}

function readinessFact(
  source: ResolvedCorrectnessProfile = profile,
  observation: Partial<RestoreReadinessObservationFact> = {},
): RestoreReadinessFact {
  return {
    policy: {
      profileId: source.readiness.profileId,
      deadlineCategory: source.readiness.deadlineCategory,
      deadlineMs: source.readiness.deadlineMs,
      signalWatchdogMs: source.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...source.readiness.fallbackCadenceMs],
      stableFrames: source.readiness.stableFrames,
      quiescenceRequired: source.readiness.quiescenceRequired,
      stableFrameRequired: source.readiness.stableFrameRequired,
    },
    observation: {
      outcome: 'signal',
      wakeSource: 'store-signal',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      observedStableFrames: source.readiness.stableFrames,
      detail: null,
      ...observation,
    },
  };
}

function evidenceAll(
  source: ResolvedCorrectnessProfile = profile,
  overrides: Readonly<Record<string, RestoreEvidenceAvailability>> = {},
): RestoreEvidenceFact[] {
  return source.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

/** Projects the delivered Oracle's additive primitive checks into structured facts. */
function structuredChecks(evaluation: RestoreOracleEvaluation): RestoreEvaluatorFact[] {
  const authority = evaluation.primitiveFacts.authority === 'malformed' ? 'malformed' : 'current';
  const sourcesAgree = evaluation.primitiveFacts.sourceAgreement === true;
  return evaluation.primitiveFacts.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: authority === 'current' ? 'current' : 'unavailable',
    sourcesAgree,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

/** Projects the delivered Oracle's additive primitive facts into the raw view. */
function oracleFactsOf(evaluation: RestoreOracleEvaluation): RestoreOracleFactsView {
  const primitive = evaluation.primitiveFacts;
  return {
    authority: primitive.authority,
    schemaVersion: primitive.schemaVersion,
    sourceAgreement: primitive.sourceAgreement === true,
    transition: primitive.transition === null ? null : { ...primitive.transition },
    meaning: primitive.meaning === null ? null : { ...primitive.meaning },
    rawSemantics:
      primitive.rawSemantics === null
        ? null
        : { ...primitive.rawSemantics, words: [...primitive.rawSemantics.words] },
    checks: primitive.checks.map((check) => ({
      checkId: check.checkId,
      predicateMet: check.predicateMet === true,
    })),
  };
}

function factsFor(
  oracle: RestoreOracleFacts = oracleFacts(),
  overrides: Partial<RestoreKernelFacts> = {},
  source: unknown = sourceDocument(),
  restored: unknown = restoredDocument(),
): RestoreKernelFacts {
  const evaluation = evaluateRestoreOracle(oracle);
  return {
    evaluator: 'frontend-restore',
    schemaVersion: RESTORE_OBSERVATION_SCHEMA_VERSION,
    transition: oracle.transition,
    meaning: oracle.meaning,
    rawSemantics: oracle.rawSemantics,
    source,
    restored,
    setup: setupFacts(),
    readiness: readinessFact(),
    checks: structuredChecks(evaluation),
    oracleFacts: oracleFactsOf(evaluation),
    diagnostics: evaluation.diagnostics.map((entry) => ({
      code: entry.code,
      detail: entry.detail,
    })),
    evidence: evidenceAll(),
    ...overrides,
  };
}

function run(
  facts: RestoreKernelFacts,
  source: ResolvedCorrectnessProfile = profile,
): RestoreKernelResult {
  return evaluateRestoreChecks({
    profile: source,
    route: ROUTE,
    actionCycle: cycle(source),
    facts,
  });
}

function codes(result: RestoreKernelResult): RestoreKernelIssueCode[] {
  return result.issues.map((entry) => entry.code);
}

function statusFor(result: RestoreKernelResult, checkId: string): string | undefined {
  return result.checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(result: RestoreKernelResult, checkId: string): CorrectnessCheckResult {
  const check = result.checks.find((candidate) => candidate.checkId === checkId);
  if (check === undefined) throw new Error(`missing check ${checkId}`);
  return check;
}

function oracleViewOf(check: CorrectnessCheckResult): Record<string, unknown> {
  const oracle = check.actual.oracle;
  return oracle !== null && typeof oracle === 'object' ? (oracle as Record<string, unknown>) : {};
}

function agreement(
  view: CorrectnessProfileIdentityView,
  aCycle: ActionCycleCorrectnessIdentity,
  checks: readonly CorrectnessCheckResult[],
) {
  return validateResultIdentityAgreement(view, { actionCycles: [aCycle], requiredChecks: checks });
}

function tamperedProfile(mutate: (profile: Record<string, unknown>) => void) {
  const clone = structuredClone(profile) as unknown as Record<string, unknown>;
  mutate(clone);
  return clone as unknown as ResolvedCorrectnessProfile;
}

// ── Positive results ─────────────────────────────────────────────────────────

describe('[P7-B B1-F2] frontend serialize/restore kernel positive results', () => {
  it('produces a complete PASS result for every declared check from real Oracle facts', () => {
    const oracle = oracleFacts();
    const evaluation = evaluateRestoreOracle(oracle);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);

    const result = run(factsFor(oracle));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('frontend-restore');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);
    expect(result.checks).toHaveLength(profile.requiredChecks.length);

    for (const check of result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
      expect(check.evidenceIds).toEqual(
        [
          ...(profile.requiredChecks.find((entry) => entry.checkId === check.checkId)
            ?.requiredEvidence ?? []),
        ].sort(),
      );
      expect(check.visualRefs).toEqual([]);
      expect(check.toleranceRefs).toEqual([]);
      expect(check.normalizationRef).toBe('artwork-normalized-meaning-v1');
      expect(check.actionCycleRef).toBe('action-cycle-restore-1');
      expect(check.actual.authority).toBe('current');
      expect(check.actual.authorityScope).toBeNull();
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(oracleViewOf(check)).toEqual({
        authority: 'current',
        currentness: 'current',
        sourcesAgree: true,
        mismatch: false,
      });
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('carries the exact compiled check schemas and consumed component fingerprints', () => {
    const result = run(factsFor());
    for (const contract of profile.requiredChecks) {
      const check = checkFor(result, contract.checkId);
      expect(check.expected.schema).toBe(contract.expectedSchema);
      expect(check.actual.schema).toBe(contract.actualSchema);
      expect(check.consumedComponentFingerprints).toEqual({
        resolvedProfile: profile.resolvedFingerprint,
        requiredCheckSet: profile.componentFingerprints.requiredCheckSet,
        oracle: profile.componentFingerprints.oracle,
        capture: profile.componentFingerprints.capture,
        tolerances: profile.componentFingerprints.tolerances,
        visuals: profile.componentFingerprints.visuals,
        normalization: profile.componentFingerprints.normalization,
      });
      expect(Object.hasOwn(check.consumedComponentFingerprints, 'readiness')).toBe(false);
    }
    expect(profile.requiredChecks.map((entry) => entry.checkId)).toEqual(CHECKS);
    expect(profile.oracle.evaluatorKind).toBe('frontend-restore');
    expect(profile.normalization.applicable).toBe(true);
  });

  it('publishes the exact serialized source and restored target object structure', () => {
    const result = run(factsFor());
    const roundtrip = checkFor(result, 'serialize.roundtrip');

    const expected = roundtrip.expected;
    expect(expected.saveControlAccessibleName).toBe(RESTORE_SAVE_CONTROL.accessibleName);
    expect(expected.captureProfileId).toBe(profile.capture.captureProfileId);
    expect(expected.currentnessIdentities).toEqual(
      [...profile.readiness.currentnessIdentities].sort(),
    );
    expect(expected.requiredTransitionFacts).toContain('saveDispatchedOnce');
    expect(expected.requiredTransitionFacts).toContain('documentIdentityDistinct');
    expect(expected.requiredMeaningFacts).toContain('normalizedFingerprintEqual');
    expect(expected.requiredRawSemanticFacts).toContain('restoredLayoutDigestMatches');
    expect(expected.normalizationRef).toBe('artwork-normalized-meaning-v1');

    const source = roundtrip.actual.source as Record<string, unknown>;
    const restored = roundtrip.actual.restored as Record<string, unknown>;
    expect(source.documentId).toBe('doc-source');
    expect(source.observationId).toBe('doc-source:9');
    expect(source.canonicalDigest).toBe('b'.repeat(64));
    expect(source.history).toEqual({ pastDepth: 3, futureDepth: 0, baselineClean: false });
    expect(restored.documentId).toBe('doc-restored');
    expect(restored.observationId).toBe('doc-restored:2');
    expect(restored.history).toEqual({ pastDepth: 0, futureDepth: 0, baselineClean: true });
    expect(restored.normalizedFingerprint).toBe(MEANING_FINGERPRINT);

    // Editor-only selection/viewport state is carried truthfully and is never a
    // required-check authority.
    expect(roundtrip.actual.selection).toEqual({
      sourceActiveLayoutId: 'layout-a',
      sourceSelectedLayerIds: ['layer-a-text-1'],
      restoredActiveLayoutId: 'layout-a',
      restoredSelectedLayerIds: [],
    });
    expect(source.viewport).toEqual({
      widthCss: 1440,
      heightCss: 1000,
      devicePixelRatio: 1,
    });

    // Currentness corpus.
    expect(roundtrip.actual.currentness).toEqual({
      document: ['doc-source', 'doc-restored'],
      epoch: [1, 1],
      bridgeGeneration: [1, 1],
      revision: [9, 2],
      distinctDocuments: true,
    });

    // Normalization interpretation.
    expect(roundtrip.actual.normalization).toEqual({
      applicable: true,
      sourceFingerprint: MEANING_FINGERPRINT,
      restoredFingerprint: MEANING_FINGERPRINT,
      reference: 'artwork-normalized-meaning-v1',
    });

    // Delivered transition/meaning/raw-semantics views.
    const transition = roundtrip.actual.transition as Record<string, unknown>;
    expect(transition.saveDispatchedOnce).toBe(true);
    expect(transition.createRequestCount).toBe(1);
    expect(transition.getRequestCount).toBe(1);
    expect(transition.redirectObserved).toBe(true);
    expect(transition.documentIdentityDistinct).toBe(true);
    expect(transition.restoredHistoryClean).toBe(true);
    const raw = roundtrip.actual.rawSemantics as Record<string, unknown>;
    expect(raw.crosswordPresent).toBe(true);
    expect(raw.generationSeed).toBe(1789754331641);
    expect(raw.words).toEqual(['MAKEIT', 'CROSSWORD', 'HELLO']);
    expect(raw.restoredLayoutDigestMatches).toBe(true);

    const setup = roundtrip.actual.setup as readonly Record<string, unknown>[];
    expect(setup.map((entry) => entry.role)).toEqual([
      'setup-text',
      'setup-image-placeholder',
      'setup-crossword',
    ]);
    expect(setup.every((entry) => entry.baselineCleanProductExact === true)).toBe(true);
    expect(setup.every((entry) => entry.declaredRecipe === true)).toBe(true);
  });

  it('carries the compiled readiness policy and the accepted signal-first observation', () => {
    const result = run(factsFor());
    const actual = checkFor(result, 'serialize.roundtrip').actual.readiness as Record<
      string,
      unknown
    >;
    expect(actual.profileId).toBe(profile.readiness.profileId);
    expect(actual.deadlineCategory).toBe('FRONTEND_RESTORE_V1');
    expect(actual.deadlineMs).toBe(profile.readiness.deadlineMs);
    expect(actual.outcome).toBe('signal');
    expect(actual.observedStableFrames).toBe(profile.readiness.stableFrames);
    const expected = checkFor(result, 'serialize.roundtrip').expected;
    expect(expected.timingCategory).toBe('FRONTEND_RESTORE_V1');
    expect(expected.deadlineMs).toBe(15000);
  });

  it('structurally accepts the delivered RestoreOracleEvaluation fact projection', () => {
    const evaluation = evaluateRestoreOracle(oracleFacts());
    const facts: RestoreKernelFacts = {
      evaluator: 'frontend-restore',
      schemaVersion: RESTORE_OBSERVATION_SCHEMA_VERSION,
      transition: transitionFacts(),
      meaning: meaningFacts(),
      rawSemantics: rawSemanticFacts(),
      source: sourceDocument(),
      restored: restoredDocument(),
      setup: setupFacts(),
      readiness: readinessFact(),
      checks: structuredChecks(evaluation),
      oracleFacts: oracleFactsOf(evaluation),
      diagnostics: evaluation.diagnostics.map((entry) => ({
        code: entry.code,
        detail: entry.detail,
      })),
      evidence: evidenceAll(),
    };
    expect(run(facts).checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('consumes exactly the compiled required evidence for every passing check', () => {
    const result = run(factsFor());
    const roundtrip = checkFor(result, 'serialize.roundtrip');
    const raw = checkFor(result, 'serialize.raw-semantic');
    expect(roundtrip.evidenceIds).toEqual([
      'observation',
      'restore.restored-snapshot',
      'restore.route-request',
      'restore.source-snapshot',
    ]);
    expect(raw.evidenceIds).toEqual([
      'restore.restored-snapshot',
      'restore.route-request',
      'restore.source-snapshot',
    ]);
    expect(roundtrip.actual.consumedEvidence).toEqual(roundtrip.evidenceIds);
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('is usable for both checks when the source document has no setup checkpoints', () => {
    // The setup checkpoints are source-construction provenance; a resolved
    // route without declared setup roles still has authoritative Save facts.
    const result = run(factsFor(oracleFacts(), { setup: [] }));
    expect(result.checks.every((check) => check.status === 'PASS')).toBe(true);
  });
});

// ── Trustworthy product mismatch → FAIL ──────────────────────────────────────

describe('[P7-B B1-F2] trustworthy mismatch maps to FAIL', () => {
  it('fails only the roundtrip check for a coherently false redirect/transition fact', () => {
    const oracle = oracleFacts({ transition: { redirectObserved: false } });
    const evaluation = evaluateRestoreOracle(oracle);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'serialize.roundtrip')?.passed).toBe(
      false,
    );

    const result = run(factsFor(oracle));
    expect(result.ok).toBe(true);
    expect(statusFor(result, 'serialize.roundtrip')).toBe('FAIL');
    expect(statusFor(result, 'serialize.raw-semantic')).toBe('PASS');
    expect(checkFor(result, 'serialize.roundtrip').actual.authority).toBe('current');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only the roundtrip check for a structurally unequal restored meaning', () => {
    const oracle = oracleFacts({ meaning: { normalizedStructurallyEqual: false } });
    const evaluation = evaluateRestoreOracle(oracle);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(factsFor(oracle));
    expect(statusFor(result, 'serialize.roundtrip')).toBe('FAIL');
    expect(statusFor(result, 'serialize.raw-semantic')).toBe('PASS');
    const meaning = checkFor(result, 'serialize.roundtrip').actual.meaning as Record<
      string,
      unknown
    >;
    expect(meaning.normalizedStructurallyEqual).toBe(false);
  });

  it('fails only the roundtrip check for a coherently lost persisted meaning', () => {
    const oracle = oracleFacts({ meaning: { persistenceLossDetected: true } });
    const result = run(factsFor(oracle));
    expect(statusFor(result, 'serialize.roundtrip')).toBe('FAIL');
    expect(statusFor(result, 'serialize.raw-semantic')).toBe('PASS');
  });

  it('fails only the raw-semantic check for a lost raw Crossword/config fact', () => {
    const oracle = oracleFacts({ rawSemantics: { restoredSeedMatches: false } });
    const evaluation = evaluateRestoreOracle(oracle);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(factsFor(oracle));
    expect(statusFor(result, 'serialize.raw-semantic')).toBe('FAIL');
    expect(statusFor(result, 'serialize.roundtrip')).toBe('PASS');
    const raw = checkFor(result, 'serialize.raw-semantic').actual.rawSemantics as Record<
      string,
      unknown
    >;
    expect(raw.restoredSeedMatches).toBe(false);
  });

  it('never lets one failing check rescue the other', () => {
    const oracle = oracleFacts({
      transition: { redirectObserved: false },
      rawSemantics: { rawConfigPresent: false },
    });
    const result = run(factsFor(oracle));
    expect(statusFor(result, 'serialize.roundtrip')).toBe('FAIL');
    expect(statusFor(result, 'serialize.raw-semantic')).toBe('FAIL');
    expect(result.checks.every((check) => check.actual.authority === 'current')).toBe(true);
  });
});

// ── Missing/stale/torn/ambiguous/wrong-target authority → UNUSABLE ───────────

describe('[P7-B B1-F2] unusable authority maps to UNUSABLE', () => {
  it('is UNUSABLE for every check when the source observation is absent', () => {
    const result = run(factsFor(oracleFacts(), {}, null));
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE');
    expect(codes(result)).toContain('RESTORE_KERNEL_SOURCE_OBSERVATION_UNINTERPRETABLE');
  });

  it('is UNUSABLE for every check when the restored observation is absent', () => {
    const result = run(factsFor(oracleFacts(), {}, sourceDocument(), null));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_TARGET_AUTHORITY_UNUSABLE');
    expect(codes(result)).toContain('RESTORE_KERNEL_RESTORED_OBSERVATION_UNINTERPRETABLE');
  });

  it('is UNUSABLE (malformed) for a non-object source observation', () => {
    const result = run(factsFor(oracleFacts(), {}, 'not-an-observation'));
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_SOURCE_OBSERVATION_UNINTERPRETABLE');
  });

  it('is UNUSABLE (wrong-target) when the restored document identity equals the source', () => {
    const shared = sourceDocument();
    const result = run(
      factsFor(oracleFacts({ transition: { documentIdentityDistinct: false } }), {}, shared, {
        ...restoredDocument(),
        documentId: shared.documentId,
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'wrong-target')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_TARGET_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE (ambiguous) when the restored observation identity is reused', () => {
    const source = sourceDocument();
    const result = run(
      factsFor(oracleFacts(), {}, source, {
        ...restoredDocument(),
        observationId: source.observationId,
      }),
    );
    expect(result.checks.every((check) => check.actual.authority === 'ambiguous')).toBe(true);
  });

  it('is UNUSABLE (malformed) for an absent bridge generation', () => {
    const result = run(
      factsFor(oracleFacts(), {}, { ...sourceDocument(), bridgeGeneration: undefined }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE (stale) for a non-product-exact history baselineClean', () => {
    const result = run(
      factsFor(
        oracleFacts(),
        {},
        {
          ...sourceDocument(),
          historyPastDepth: 3,
          historyFutureDepth: 0,
          historyBaselineClean: true,
        },
      ),
    );
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE (stale) for an unknown readiness outcome and for a timeout', () => {
    for (const observation of [
      { outcome: 'timeout' as const },
      { outcome: 'stale' as const },
      { outcome: 'invalidated' as const },
      { outcome: 'unavailable' as const },
    ]) {
      const result = run(
        factsFor(oracleFacts(), { readiness: readinessFact(profile, observation) }),
      );
      expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(codes(result)).toContain('RESTORE_KERNEL_READINESS_AUTHORITY_UNUSABLE');
    }
  });

  it('is UNUSABLE (malformed) for a readiness policy that diverges from the compiled authority', () => {
    const weakened = readinessFact();
    const result = run(
      factsFor(oracleFacts(), {
        readiness: { ...weakened, policy: { ...weakened.policy, deadlineMs: 16000 } },
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_READINESS_POLICY_MISMATCH');
  });

  it('is UNUSABLE (malformed) for an idle observation below the compiled stable frames', () => {
    const result = run(
      factsFor(oracleFacts(), {
        readiness: readinessFact(profile, { observedStableFrames: 1 }),
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
  });

  it('is UNUSABLE (malformed) when the accepted evaluator authority is malformed', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      checks: facts.checks.map((check) => ({
        ...check,
        authority: 'malformed' as const,
        currentness: 'unavailable' as const,
        mismatch: false,
      })),
      oracleFacts:
        facts.oracleFacts === null
          ? null
          : {
              ...facts.oracleFacts,
              authority: 'malformed' as const,
              sourceAgreement: false,
              transition: null,
              meaning: null,
              rawSemantics: null,
            },
    });
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE when the chain reports harness hydrate/store-mutation calls', () => {
    const oracle = oracleFacts({
      transition: {
        harnessHydrateCalls: 1,
        harnessStoreMutationCalls: 1,
      } as unknown as Partial<RestoreTransitionFactView>,
    });
    const result = run(factsFor(oracle));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_EXECUTION_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE for an unsupported restore observation schema', () => {
    const result = run(factsFor(oracleFacts(), { schemaVersion: 99 }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_FACTS_SCHEMA_UNSUPPORTED');
  });

  it('is UNUSABLE (malformed) for a delivered meaning fingerprint that contradicts the source observation', () => {
    const oracle = oracleFacts({ meaning: { sourceFingerprint: 'f'.repeat(32) } });
    const result = run(factsFor(oracle));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'ambiguous')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE (malformed) for an unknown setup recipe role', () => {
    const setup = setupFacts();
    setup[1] = { ...setup[1], role: 'setup-unknown' } as RestoreSetupCheckpointFact;
    const result = run(factsFor(oracleFacts(), { setup }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE (missing) for a declared check with no accepted fact', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      checks: facts.checks.filter((check) => check.checkId !== 'serialize.raw-semantic'),
    });
    expect(statusFor(result, 'serialize.raw-semantic')).toBe('UNUSABLE');
    expect(statusFor(result, 'serialize.roundtrip')).toBe('PASS');
    expect(checkFor(result, 'serialize.raw-semantic').actual.authority).toBe('missing');
    expect(codes(result)).toContain('RESTORE_KERNEL_FACT_CHECK_MISSING');
  });

  it('never lets a delivered passing fact rescue unusable authority', () => {
    const facts = factsFor(oracleFacts(), {}, null);
    expect(facts.checks.every((check) => check.mismatch === false)).toBe(true);
    const result = run(facts);
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
  });
});

// ── Required evidence and diagnostic isolation ───────────────────────────────

describe('[P7-B B1-F2] required evidence and diagnostic isolation', () => {
  it('is UNUSABLE for the dependent checks when required authority is torn', () => {
    const result = run(
      factsFor(oracleFacts(), {
        evidence: evidenceAll(profile, { 'restore.route-request': 'torn' }),
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('restore.route-request');
      expect(check.actual.authority).toBe('torn');
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('is UNUSABLE only for the checks that require a missing evidence item', () => {
    const result = run(
      factsFor(oracleFacts(), {
        evidence: evidenceAll(profile, { observation: 'missing' }),
      }),
    );
    expect(statusFor(result, 'serialize.roundtrip')).toBe('UNUSABLE');
    expect(statusFor(result, 'serialize.raw-semantic')).toBe('PASS');
    expect(checkFor(result, 'serialize.roundtrip').actual.authority).toBe('missing');
    expect(checkFor(result, 'serialize.roundtrip').evidenceIds).toEqual([
      'restore.restored-snapshot',
      'restore.route-request',
      'restore.source-snapshot',
    ]);
  });

  it('never consumes a diagnostic-only item declared for required authority', () => {
    const result = run(
      factsFor(oracleFacts(), {
        evidence: evidenceAll(profile, { 'restore.source-snapshot': 'diagnostic-only' }),
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('restore.source-snapshot');
    }
  });

  it('reports undeclared evidence claiming authority without consuming it', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      evidence: [
        ...facts.evidence,
        { evidenceId: 'uncalibrated.extra', availability: 'authoritative' },
      ],
    });
    expect(codes(result)).toContain('RESTORE_KERNEL_EVIDENCE_UNDECLARED');
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('uncalibrated.extra');
    }
  });

  it('ignores a diagnostic-only unrequired item entirely', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      evidence: [
        ...facts.evidence,
        { evidenceId: 'restore.raw-payload.diagnostic', availability: 'diagnostic-only' },
        { evidenceId: 'screenshot.diagnostic', availability: 'diagnostic-only' },
      ],
    });
    expect(result.checks.every((check) => check.status === 'PASS')).toBe(true);
    expect(codes(result)).not.toContain('RESTORE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
  });
});

// ── Identity, route, Action Cycle, and check-evaluator agreement ─────────────

describe('[P7-B B1-F2] compiled-profile identity agreement', () => {
  it('rejects a profile for a different route without fabricating checks', () => {
    const result = evaluateRestoreChecks({
      profile,
      route: { subjectId: 'artwork/editor', capability: 'history', variant: null },
      actionCycle: cycle(),
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('RESTORE_KERNEL_ROUTE_MISMATCH');
  });

  it('rejects an Action Cycle that observed a different resolved profile', () => {
    const result = evaluateRestoreChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), resolvedProfileFingerprint: 'f'.repeat(64) },
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_ACTION_CYCLE_MISMATCH');
  });

  it('rejects an Action Cycle readiness disagreement', () => {
    const result = evaluateRestoreChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), readinessFingerprint: 'e'.repeat(64) },
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_READINESS_MISMATCH');
  });

  it('rejects a compiled profile whose content was mutated in place', () => {
    const mutated = tamperedProfile((clone) => {
      (clone.readiness as Record<string, unknown>).deadlineMs = 16000;
    });
    const result = run(factsFor(), mutated);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_PROFILE_FINGERPRINT_MISMATCH');
  });

  it('rejects a missing resolved fingerprint', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        delete clone.resolvedFingerprint;
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_PROFILE_FINGERPRINT_MISSING');
  });

  it('rejects a non-canonical resolved fingerprint', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.resolvedFingerprint = 'not-a-fingerprint';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_PROFILE_FINGERPRINT_INVALID');
  });

  it('rejects an invalid component fingerprint', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        (clone.componentFingerprints as Record<string, unknown>).normalization = 'short';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_COMPONENT_FINGERPRINT_INVALID');
  });

  it('rejects an unsupported resolved-profile schema', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.schemaVersion = 99;
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_PROFILE_SCHEMA_UNSUPPORTED');
  });

  it('rejects a non-object compiled profile', () => {
    const result = evaluateRestoreChecks({
      profile: 'not-a-profile' as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('RESTORE_KERNEL_PROFILE_NOT_OBJECT');
  });

  it('leaves the compiled check-set/route identity stable across recompiles', () => {
    const recompiled = compile();
    expect(recompiled.resolvedFingerprint).toBe(profile.resolvedFingerprint);
    expect(recompiled.componentFingerprints).toEqual(profile.componentFingerprints);
    expect(recompiled.requiredChecks.map((entry) => entry.checkId)).toEqual(CHECKS);
  });
});

describe('[P7-B B1-F2] required-check set and evaluator discriminants', () => {
  it('rejects an empty required-check set', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = [];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_EMPTY_REQUIRED_CHECKS');
  });

  it('rejects a declared check with no check id', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = [{ evaluator: 'frontend-restore' }];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_REQUIRED_CHECK_MISSING');
  });

  it('rejects a duplicated declared check', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = [profile.requiredChecks[0], profile.requiredChecks[0]];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_REQUIRED_CHECK_DUPLICATE');
  });

  it('rejects an unsupported per-check evaluator discriminant', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = profile.requiredChecks.map((contract) => ({
          ...contract,
          evaluator: 'canonical-delta',
        }));
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_CHECK_EVALUATOR_UNSUPPORTED');
  });

  it('rejects an unsupported Oracle evaluator discriminant', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        (clone.oracle as Record<string, unknown>).evaluatorKind = 'history-cross-subject';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('RESTORE_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED');
  });

  it('rejects facts that declare a different evaluator', () => {
    const result = run({ ...factsFor(), evaluator: 'history-cross-subject' as never });
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_FACTS_EVALUATOR_MISMATCH');
  });

  it('rejects an accepted fact for an undeclared check without consuming it', () => {
    const result = run({
      ...factsFor(),
      checks: [
        ...factsFor().checks,
        {
          checkId: 'serialize.unknown',
          authority: 'current' as const,
          currentness: 'current' as const,
          sourcesAgree: true,
          mismatch: false,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('RESTORE_KERNEL_FACT_CHECK_UNKNOWN');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);
  });

  it('rejects a duplicated check fact', () => {
    const facts = factsFor();
    const result = run({ ...facts, checks: [...facts.checks, facts.checks[0]] });
    expect(codes(result)).toContain('RESTORE_KERNEL_FACT_CHECK_DUPLICATE');
  });

  it('rejects a check fact with no structured authority and makes it UNUSABLE', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      checks: facts.checks.map((check) => ({
        checkId: check.checkId,
        authority: 'invented',
        currentness: 'current',
        sourcesAgree: true,
        mismatch: false,
      })) as unknown as readonly RestoreEvaluatorFact[],
    });
    expect(codes(result)).toContain('RESTORE_KERNEL_FACT_AUTHORITY_UNKNOWN');
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
  });

  it('routes exactly the delivered evaluator kind to the kernel', () => {
    expect(restoreKernelKindForEvaluator('frontend-restore')).toBe('frontend-restore');
    for (const other of [
      'history-cross-subject',
      'crossword-determinism',
      'geometry-delta',
      null,
    ]) {
      expect(restoreKernelKindForEvaluator(other)).toBeNull();
    }
  });
});

// ── B0 generic-executor restore-marker guard ─────────────────────────────────

describe('[P7-B B1-F2] B0 restore-marker guard (no fabricated target/check)', () => {
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
    // No fabricated target or check is attached to the refusal.
    expect(Object.hasOwn(result.finding.context ?? {}, 'targetElementId')).toBe(false);
    expect(Object.hasOwn(result.finding.context ?? {}, 'checkId')).toBe(false);
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

// ── Compiled single-leaf mutation matrix ─────────────────────────────────────

describe('[P7-B B1-F2] relevant compiled-field mutation matrix', () => {
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

  const leafPaths: string[] = [];
  collectLeafPaths(profile, '', leafPaths);

  it('covers the complete compiled frontend serialize/restore profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(150);
  });

  it('compiles to the exact runtime resolved fingerprint', () => {
    // The planner compiles the same route with the same declared check, so the
    // kernel consumes the exact runtime profile identity.
    expect(profile.resolvedFingerprint).toBe(
      '4cd3d3164eff0ecacbdd7db1740a3bc523730c92de51d02bc2dc06518a6306fe',
    );
  });

  it('rejects every single-leaf mutation of the compiled restore profile', () => {
    const baseFacts = factsFor();
    for (const leafPath of leafPaths) {
      const clone = structuredClone(profile) as unknown as Record<string, unknown>;
      mutateLeaf(clone, leafPath);
      const mutated = clone as unknown as ResolvedCorrectnessProfile;
      const result = evaluateRestoreChecks({
        profile: mutated,
        route: ROUTE,
        actionCycle: cycle(mutated),
        facts: baseFacts,
      });
      expect(result.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });

  it('detects an in-place compiled identity mutation through the fingerprint derivation', () => {
    const clone = structuredClone(profile) as unknown as Record<string, unknown>;
    (clone.readiness as Record<string, unknown>).deadlineMs = 14999;
    const derived = deriveResolvedCorrectnessProfileFingerprint(
      clone as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
    );
    expect(derived).not.toBe(profile.resolvedFingerprint);
  });
});

// ── Inactive kernel invariants ───────────────────────────────────────────────

describe('[P7-B B1-F2] inactive kernel invariants', () => {
  const skillRoot = path.resolve(process.cwd(), '.pi/skills/verify-artwork-editor');
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('does not import any active executor, Oracle, readiness loop, evidence writer, or classifier', () => {
    const kernel = source('src/kernels/restore-kernel.ts');
    expect(kernel).not.toMatch(/from '\.\.\/(runtime|oracles|readiness|evidence)\//);
    expect(kernel).not.toContain('execute-plan');
    expect(kernel).not.toContain('execute-restore-plan');
    expect(kernel).not.toContain('contracts/execution');
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/outcomes'/);
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/result-outcome'/);
    expect(kernel).not.toContain("from '../oracles/restore'");
    expect(kernel).not.toContain('public-dto');
  });

  it('owns no required-check list, check id, Subject branch, or catalogue reload', () => {
    const kernel = source('src/kernels/restore-kernel.ts');
    for (const literal of [
      "'serialize.roundtrip'",
      "'serialize.raw-semantic'",
      "'artwork/editor'",
      "'frontend-restore-v1'",
      "'artwork-normalized-meaning-v1'",
    ]) {
      expect(kernel).not.toContain(literal);
    }
    expect(kernel).not.toContain('loadCorrectnessCatalogue');
    expect(kernel).not.toContain('fallbackId');
  });

  it('is not referenced by any active executor, Oracle, or writer module', () => {
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/execute-restore-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/oracles/evaluate.ts',
      'src/oracles/restore.ts',
      'src/evidence/writer.ts',
      'src/evidence/public-dto.ts',
      'src/runtime/outcomes.ts',
    ]) {
      expect(source(relative)).not.toContain('restore-kernel');
      expect(source(relative)).not.toContain('evaluateRestoreChecks');
    }
  });

  it('leaves the active boolean CheckResult and v3 record schema unchanged', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
  });

  it('keeps every produced component fingerprint full canonical', () => {
    const result = run(factsFor());
    for (const check of result.checks) {
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.resolvedProfile)).toBe(
        true,
      );
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.oracle)).toBe(true);
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.capture)).toBe(true);
      expect(Object.hasOwn(check.consumedComponentFingerprints, 'readiness')).toBe(false);
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.requiredCheckSet)).toBe(
        true,
      );
    }
    expect(isFullCanonicalFingerprint(profile.componentFingerprints.readiness)).toBe(true);
  });
});
