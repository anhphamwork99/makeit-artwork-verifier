import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type { MaterializedCase } from '../../src/contracts/case-model';
import type { ResolvedCorrectnessProfile } from '../../src/contracts/correctness';
import {
  NESTED_OBJECT_POINT_ORDER,
  canonicalFrameMatrix,
  canonicalWitnessLocalQuad,
  composeAffineList,
  deriveNestedCanonicalChain,
  parseNestedGeometryV3,
  renderFrameMatrix,
  segmentPersistedFrame,
  segmentRenderFrame,
  type NestedObjectFrameFacts,
  type NestedObjectGeometryV3,
} from '../../src/contracts/geometry-v3';
import { multiplyAffine, transformQuad, type Affine2D } from '../../src/contracts/geometry-v2';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  evaluateNestedObjectOracle,
  type NestedObjectOracleEvaluation,
} from '../../src/oracles/nested-object';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { resolveSkillRoot } from '../../src/runtime/paths';
import {
  NESTED_OBJECT_LIVE_FACT_ISSUE_CODES,
  adaptNestedObjectLiveFacts,
  evaluateNestedObjectLiveChecks,
  projectNestedObjectLiveFacts,
  type NestedObjectLiveEvaluationObservation,
  type NestedObjectLiveFactFailure,
  type NestedObjectLiveFactRoute,
} from '../../src/adapters/object-live-facts';
import {
  isFullCanonicalFingerprint,
  projectCorrectnessProfileIdentity,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  NestedObjectEvidenceAvailability,
  NestedObjectEvidenceFact,
  NestedObjectKernelFacts,
} from '../../src/index';

/**
 * P7-B2-B2 focused proof: inactive live-fact adapter for nested Object
 * (ADR 0029 §4 B2-B).
 *
 * The suites drive the adapter from the *real* exact envelope produced by
 * `planCaseForExecution` for the representative nested-Object request and the
 * *real* accepted `evaluateNestedObjectOracle` outputs over real typed
 * geometry-v3 records. They cover PASS, a trustworthy descendant persisted
 * rotation mismatch that is not rescued by world composition, a trustworthy
 * world-composition mismatch, a missing delta, missing/stale/torn/ambiguous
 * authority, a wrong-target Oracle, camera degeneracy, identity/evidence
 * agreement, fail-closed envelope rejection before the kernel, no adapter
 * policy, no active imports, no legacy boolean/harnessInvalid authority in the
 * produced structured facts, and a single-leaf mutation of every compiled
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

const NESTED_REQUEST = 'container-object-move-nested-rotated.json';

interface PreparedCase {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: NestedObjectLiveFactRoute;
  readonly minimumDelta: { readonly x: number; readonly y: number };
  readonly case: MaterializedCase;
}

function prepare(fileName: string): PreparedCase {
  const result = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (result.status !== 'PLANNED') throw new Error(`${fileName} did not plan: ${result.status}`);
  if (result.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = result.envelope;
  const intent = result.materializedCase.intent;
  const expected = intent.expected as { minimumDelta?: { x: number; y: number } };
  if (expected.minimumDelta === undefined) throw new Error('missing minimumDelta');
  expect(envelope.schemaVersion).toBe(MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION);
  return {
    envelope,
    profile: envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: {
      subjectId: intent.subjectId,
      capability: intent.capability,
      variant: intent.variant,
    },
    minimumDelta: expected.minimumDelta,
    case: result.materializedCase,
  };
}

const nestedCase = prepare(NESTED_REQUEST);

function cycle(prepared: PreparedCase, actionCycleId: string): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint: prepared.profile.resolvedFingerprint,
    readinessFingerprint: prepared.profile.componentFingerprints.readiness,
  };
}

const NESTED_CYCLE = cycle(nestedCase, 'b2b2-cycle-nested-object');

function evidenceAll(
  profile: ResolvedCorrectnessProfile,
  overrides: Readonly<Record<string, NestedObjectEvidenceAvailability>> = {},
): NestedObjectEvidenceFact[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

// ── Real nested-Object geometry-v3 records (ADR 0013/0015/0027) ──────────────

const LAYOUT_ID = 'layout-object-active';
const TARGET_ID = 'object-outer';
const WITNESS_ID = 'text-witness';

const CHAIN_FACTS: NestedObjectFrameFacts[] = [
  {
    id: WITNESS_ID,
    kind: 'text',
    parentId: 'object-inner',
    x: 10,
    y: 6,
    width: 80,
    height: 40,
    rotationDegrees: 0,
    flipX: false,
    flipY: false,
  },
  {
    id: 'object-inner',
    kind: 'object',
    parentId: TARGET_ID,
    x: 12,
    y: 8,
    width: 90,
    height: 50,
    rotationDegrees: 0,
    flipX: false,
    flipY: false,
  },
  {
    id: TARGET_ID,
    kind: 'object',
    parentId: LAYOUT_ID,
    x: 20,
    y: 15,
    width: 120,
    height: 70,
    rotationDegrees: 15,
    flipX: false,
    flipY: false,
  },
];

const MOVED_FACTS: NestedObjectFrameFacts[] = CHAIN_FACTS.map((facts) =>
  facts.id === TARGET_ID ? { ...facts, x: facts.x + 72, y: facts.y + 36 } : facts,
);

function layoutItems(facts: NestedObjectFrameFacts[] = CHAIN_FACTS): unknown {
  const byId = new Map(facts.map((entry) => [entry.id, entry]));
  const frame = (id: string) => {
    const found = byId.get(id) as NestedObjectFrameFacts;
    return {
      id: found.id,
      xCoordinate: found.x,
      yCoordinate: found.y,
      width: found.width,
      height: found.height,
      rotation: found.rotationDegrees,
      transform: { flipX: found.flipX, flipY: found.flipY },
    };
  };
  const witness = { ...frame(WITNESS_ID), type: 'TEXT' };
  const inner = { ...frame('object-inner'), type: 'OBJECT', layers: [witness] };
  const outer = { ...frame(TARGET_ID), type: 'OBJECT', layers: [inner] };
  return [{ id: LAYOUT_ID, layers: [outer] }];
}

type InteractionInput = Record<string, unknown>;

function preActionInteraction(): InteractionInput {
  return {
    phase: 'pre-action',
    purpose: 'authorize-native-action',
    authority: 'action',
    status: 'authorized',
    targetId: TARGET_ID,
    space: 'browser-client-css',
    candidate: 'center',
    point: { x: 300, y: 220 },
    safetyInsetCssPx: 4,
    source: 'live-konva-hit-v1',
    hitClassification: 'target',
    interactionFingerprint: 'ifp-pre',
  };
}

function postActionInteraction(
  status: 'clear' | 'obstructed',
  hitClassification: string,
): InteractionInput {
  const obstructed = status === 'obstructed';
  return {
    phase: 'post-action',
    purpose: 'observe-authoritative-geometry',
    authority: 'none',
    status,
    targetId: TARGET_ID,
    space: 'browser-client-css',
    candidate: 'center',
    point: { x: 300, y: 220 },
    safetyInsetCssPx: 4,
    source: 'live-konva-hit-v1',
    hitClassification,
    obstructionCode: obstructed ? 'POST_ACTION_HIT_OBSTRUCTED' : null,
    safeHitDescriptor:
      hitClassification === 'selection-chrome'
        ? { nodeClass: 'Rect', chromeName: 'artwork-chrome', ownedByTarget: true }
        : { nodeClass: 'Rect', chromeName: null, ownedByTarget: false },
    interactionFingerprint: obstructed ? 'ifp-post-obstructed' : 'ifp-post-clear',
  };
}

/** Builds one closed geometry-v3 record whose published facts are self-consistent. */
function geometryRecord(
  interaction: InteractionInput,
  chainFacts: NestedObjectFrameFacts[] = CHAIN_FACTS,
): NestedObjectGeometryV3 {
  const identity: Affine2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const segments = chainFacts.map((facts) => {
    const renderFrame = segmentRenderFrame(facts);
    return {
      id: facts.id,
      kind: facts.kind,
      parentId: facts.parentId,
      persistedFrame: segmentPersistedFrame(facts),
      renderFrame,
      canonicalRenderMatrix: renderFrameMatrix(renderFrame, facts.flipX, facts.flipY) as Affine2D,
    };
  });
  const composed = composeAffineList(
    segments.map((segment) => segment.canonicalRenderMatrix),
  ) as Affine2D;
  const localQuad = canonicalWitnessLocalQuad(chainFacts[0] as NestedObjectFrameFacts);
  const canonicalLayoutQuad = transformQuad(composed, localQuad);
  const renderedLayoutQuad = transformQuad(composed, localQuad);
  const targetFacts = chainFacts[chainFacts.length - 1] as NestedObjectFrameFacts;
  const centerWrapper = canonicalFrameMatrix({ ...targetFacts, x: 0, y: 0 }) as Affine2D;
  const translationWrapper: Affine2D = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: targetFacts.x,
    f: targetFacts.y,
  };
  const completeWrapper = multiplyAffine(translationWrapper, centerWrapper) as Affine2D;
  const witnessFacts = chainFacts[0] as NestedObjectFrameFacts;
  return {
    schemaVersion: 3,
    discriminant: 'makeit.artwork-verification.geometry.v3',
    representation: {
      kind: 'nested-object-affine-chain-v2',
      representationVersion: 2,
      pointOrder: NESTED_OBJECT_POINT_ORDER,
      units: {
        subjectLocal: 'artwork-unit',
        parentLocal: 'artwork-unit',
        layoutLocal: 'artwork-unit',
        worldScene: 'scene-unit',
        stageViewportCss: 'css-px',
        browserClientCss: 'css-px',
      },
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      canonicalChain: segments,
      targetCanonicalFrame: segments[2] as (typeof segments)[number],
      witnessCanonicalFrame: segments[0] as (typeof segments)[number],
      canonicalWitnessLocalQuad: localQuad,
      persistedWitnessContentQuad: [
        { x: 8, y: 8 },
        { x: 8 + witnessFacts.width, y: 8 },
        { x: 8 + witnessFacts.width, y: 8 + witnessFacts.height },
        { x: 8, y: 8 + witnessFacts.height },
      ],
      targetWrappers: {
        translationWrapperToLayout: translationWrapper,
        centerRotationSubtreeToTranslationWrapper: centerWrapper,
        completeObjectToLayout: completeWrapper,
        flipShellIdentity: true,
        wrapperStructureValidated: true,
      },
      canonicalLayoutQuad,
      renderedLayoutQuad,
      renderedWorldSceneQuad: renderedLayoutQuad,
      renderedStageViewportCssQuad: renderedLayoutQuad,
      renderedBrowserClientCssQuad: renderedLayoutQuad,
      matrices: {
        canonicalWitnessToLayout: composed,
        renderedWitnessToLayout: composed,
        layoutToWorldScene: identity,
        worldSceneToStageViewportCss: identity,
        stageViewportToBrowserClientCss: identity,
      },
      representationFingerprint: 'rep-fp-1',
    },
    camera: {
      canonical: { x: 0, y: 0, zoom: 1.36 },
      stageMatrix: { a: 1.36, b: 0, c: 0, d: 1.36, e: 0, f: 0 },
      cssRatios: { x: 1, y: 1 },
    },
    typedProvenance: {
      bridgeGeneration: 3,
      target: { id: TARGET_ID, konvaId: TARGET_ID, fingerprint: 'tf' },
      witness: { id: WITNESS_ID, konvaId: WITNESS_ID, fingerprint: 'wf' },
      layout: { id: LAYOUT_ID, konvaId: `layout-${LAYOUT_ID}`, fingerprint: 'lf' },
      chainFingerprint: 'chain-fp',
      representationFingerprint: 'rep-fp-1',
      stageFingerprint: 'stage-fp',
    },
    interaction: interaction as unknown as NestedObjectGeometryV3['interaction'],
    normalization: {
      certificateVersion: 'makeit.nested-object-normalization-certificate.v1',
      fixedPoint: true,
      referentiallyUnchanged: true,
      subtreeFingerprint: 'subtree-fp-1',
    },
    chainFingerprint: 'chain-fp',
    recordFingerprint: 'record-fp',
  };
}

function parsed(
  interaction: InteractionInput,
  chainFacts: NestedObjectFrameFacts[] = CHAIN_FACTS,
): NestedObjectGeometryV3 {
  const derived = deriveNestedCanonicalChain({
    layoutItems: layoutItems(chainFacts),
    targetId: TARGET_ID,
    witnessId: WITNESS_ID,
    layoutId: LAYOUT_ID,
  });
  if (!derived.ok) throw new Error('expected a derived chain');
  const result = parseNestedGeometryV3({
    raw: geometryRecord(interaction, chainFacts),
    expected: {
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      chain: derived.derivation.chain,
    },
  });
  if (!result.ok) throw new Error(`expected a parsed record: ${JSON.stringify(result.failure)}`);
  return result.geometry;
}

function moveEvaluation(
  baseline: NestedObjectGeometryV3,
  observed: NestedObjectGeometryV3,
  observedLayout: unknown,
  overrides: Partial<Parameters<typeof evaluateNestedObjectOracle>[0]> = {},
): NestedObjectOracleEvaluation {
  return evaluateNestedObjectOracle({
    minimumDelta: nestedCase.minimumDelta,
    targetId: TARGET_ID,
    witnessId: WITNESS_ID,
    layoutId: LAYOUT_ID,
    requestedPointerDeltaCss: { x: 72, y: 36 },
    baseline: { geometry: baseline, layoutItems: layoutItems() },
    observed: { geometry: observed, layoutItems: observedLayout },
    ...overrides,
  });
}

function nestedPassing(): NestedObjectOracleEvaluation {
  return moveEvaluation(
    parsed(preActionInteraction()),
    parsed(postActionInteraction('clear', 'target'), MOVED_FACTS),
    layoutItems(MOVED_FACTS),
  );
}

function nestedLocalRotationMismatch(): NestedObjectOracleEvaluation {
  const baseline = parsed(preActionInteraction());
  const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
  const mutated = structuredClone(observed);
  const witness = mutated.representation
    .canonicalChain[0] as (typeof mutated.representation.canonicalChain)[number];
  witness.persistedFrame.rotationDegrees = 1;
  return moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS));
}

function nestedWorldMismatch(): NestedObjectOracleEvaluation {
  const baseline = parsed(preActionInteraction());
  const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
  const mutated = structuredClone(observed);
  mutated.representation.renderedLayoutQuad[0].x += 5;
  return moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS));
}

function nestedDeltaMismatch(): NestedObjectOracleEvaluation {
  return moveEvaluation(
    parsed(preActionInteraction()),
    parsed(postActionInteraction('clear', 'target')),
    layoutItems(),
  );
}

function nestedWrongTarget(): NestedObjectOracleEvaluation {
  return moveEvaluation(
    parsed(preActionInteraction()),
    parsed(postActionInteraction('clear', 'target'), MOVED_FACTS),
    layoutItems(MOVED_FACTS),
    { targetId: 'object-not-present' },
  );
}

function nestedCameraMismatch(): NestedObjectOracleEvaluation {
  const baseline = parsed(preActionInteraction());
  const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
  const mutated = structuredClone(observed);
  mutated.camera.stageMatrix.a += 1;
  return moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS));
}

function nestedWrongShape(): NestedObjectOracleEvaluation {
  const baseline = parsed(preActionInteraction());
  const observed = parsed(postActionInteraction('obstructed', 'selection-chrome'));
  const wrongBaseline = structuredClone(baseline);
  (wrongBaseline.interaction as { phase: string }).phase = 'post-action';
  return moveEvaluation(wrongBaseline, observed, layoutItems());
}

// ── Adapter invocation helpers ───────────────────────────────────────────────

function nestedInput(
  overrides: Partial<Parameters<typeof adaptNestedObjectLiveFacts>[0]> = {},
): Parameters<typeof adaptNestedObjectLiveFacts>[0] {
  return {
    envelope: nestedCase.envelope,
    route: nestedCase.route,
    actionCycle: NESTED_CYCLE,
    minimumDelta: nestedCase.minimumDelta,
    oracle: nestedPassing(),
    evidence: evidenceAll(nestedCase.profile),
    ...overrides,
  };
}

function issueCodes(failure: NestedObjectLiveFactFailure): string[] {
  return failure.issues.map((issue) => issue.code);
}

function assertIdentityAgreement(
  checks: readonly CorrectnessCheckResult[],
  profile: ResolvedCorrectnessProfile,
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

const CHECK_IDS = [
  'containment.parent-chain',
  'geometry.delta',
  'geometry.local-invariant',
  'geometry.world-composition',
];

// ── Envelope agreement and fail-closed adaptation ───────────────────────────

describe('[P7-B2-B2] exact-envelope agreement and fail-closed adaptation', () => {
  it('adapts the real representative nested-Object envelope into complete structured facts', () => {
    const adaptation = adaptNestedObjectLiveFacts(nestedInput());
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    expect(adaptation.facts.evaluator).toBe('nested-object-affine');
    expect(adaptation.facts.checks.map((entry) => entry.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    for (const entry of adaptation.facts.checks) {
      expect(entry.authority).toBe('current');
      expect(entry.currentness).toBe('current');
      expect(entry.mismatch).toBe(false);
      expect(entry.sourcesAgree).toBe(true);
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'status')).toBe(false);
    }
    expect(adaptation.facts.oracleFacts).not.toBeNull();
    expect(adaptation.facts.checks).toHaveLength(CHECK_IDS.length);
    expect(Object.hasOwn(adaptation.facts, 'harnessInvalid')).toBe(false);
    expect(Object.hasOwn(adaptation.facts, 'requiredSourcesAgree')).toBe(false);
  });

  it('fails closed before the kernel on every envelope disagreement class', () => {
    const planFingerprint = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      envelope: {
        ...nestedCase.envelope,
        planFingerprint: 'f'.repeat(64),
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(planFingerprint.ok).toBe(false);
    if (!planFingerprint.ok) {
      expect(planFingerprint.status).toBe('HARNESS_BLOCKED');
      expect(planFingerprint.launchAttempted).toBe(false);
      expect(issueCodes(planFingerprint)).toContain('ENVELOPE_PLAN_FINGERPRINT_MISMATCH');
    }

    const caseId = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      envelope: {
        ...nestedCase.envelope,
        caseId: 'other-case',
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(caseId.ok).toBe(false);

    const routeMismatch = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      route: { ...nestedCase.route, variant: 'foreign-variant' },
    });
    expect(routeMismatch.ok).toBe(false);
    if (!routeMismatch.ok) {
      expect(issueCodes(routeMismatch)).toContain('ENVELOPE_ROUTE_MISMATCH');
    }

    const evaluatorMismatch = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      envelope: {
        ...nestedCase.envelope,
        correctnessProfile: {
          ...nestedCase.profile,
          oracle: { ...nestedCase.profile.oracle, evaluatorKind: 'geometry-delta' },
        },
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(evaluatorMismatch.ok).toBe(false);
    if (!evaluatorMismatch.ok) {
      expect(issueCodes(evaluatorMismatch)).toContain('ENVELOPE_ORACLE_EVALUATOR_UNSUPPORTED');
    }

    const actionCycleMismatch = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      actionCycle: { ...NESTED_CYCLE, resolvedProfileFingerprint: 'a'.repeat(64) },
    });
    expect(actionCycleMismatch.ok).toBe(false);
    if (!actionCycleMismatch.ok) {
      expect(issueCodes(actionCycleMismatch)).toContain('ENVELOPE_ACTION_CYCLE_MISMATCH');
    }

    const readinessMismatch = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      actionCycle: { ...NESTED_CYCLE, readinessFingerprint: 'b'.repeat(64) },
    });
    expect(readinessMismatch.ok).toBe(false);
    if (!readinessMismatch.ok) {
      expect(issueCodes(readinessMismatch)).toContain('ENVELOPE_READINESS_MISMATCH');
    }

    const invalidEvidence = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      evidence: [{ evidenceId: 'geometry.typed-chain-v3', availability: 'invented' } as never],
    });
    expect(invalidEvidence.ok).toBe(false);
    if (!invalidEvidence.ok) {
      expect(issueCodes(invalidEvidence)).toContain('NESTED_OBJECT_LIVE_EVIDENCE_FACT_INVALID');
    }

    const malformedObservation = adaptNestedObjectLiveFacts({
      ...nestedInput(),
      oracle: {
        primitiveFacts: { authority: 'current' },
      } as unknown as NestedObjectLiveEvaluationObservation,
    });
    expect(malformedObservation.ok).toBe(false);
    if (!malformedObservation.ok) {
      expect(issueCodes(malformedObservation)).toContain(
        'NESTED_OBJECT_LIVE_OBSERVATION_MALFORMED',
      );
    }

    const unknownIssueCodes = new Set<string>(NESTED_OBJECT_LIVE_FACT_ISSUE_CODES);
    for (const failure of [planFingerprint, routeMismatch, actionCycleMismatch, invalidEvidence]) {
      if (failure.ok) continue;
      for (const issue of failure.issues) {
        expect(unknownIssueCodes.has(issue.code)).toBe(true);
      }
    }
  });

  it('never invokes the kernel on a disagreeing envelope', () => {
    const failed = evaluateNestedObjectLiveChecks({
      ...nestedInput(),
      actionCycle: { ...NESTED_CYCLE, resolvedProfileFingerprint: 'c'.repeat(64) },
    });
    expect(failed.ok).toBe(false);
    expect(Object.hasOwn(failed, 'result')).toBe(false);
    expect(Object.hasOwn(failed, 'facts')).toBe(false);
  });
});

// ── Nested Object live-fact behavior ────────────────────────────────────────

describe('[P7-B2-B2] nested Object live facts', () => {
  it('produces complete PASS checks with identity/evidence agreement', () => {
    const outcome = evaluateNestedObjectLiveChecks(nestedInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.checkId)).toEqual(CHECK_IDS);
    for (const check of outcome.result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.actual.authority).toBe('current');
      expect(check.actual.currentness).toBe('current');
      expect(check.actual.mismatch).toBe(false);
      expect(check.evidenceIds).toEqual(
        [...(nestedCase.profile.requiredChecks[0]?.requiredEvidence ?? [])].sort(),
      );
    }
    assertIdentityAgreement(outcome.result.checks, nestedCase.profile, NESTED_CYCLE);
  });

  it('fails only the local invariant on a trustworthy descendant persisted rotation drift', () => {
    const outcome = evaluateNestedObjectLiveChecks(
      nestedInput({ oracle: nestedLocalRotationMismatch() }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'geometry.local-invariant')).toBe('FAIL');
    // World composition, delta, and containment never rescue the local failure.
    expect(statusFor(outcome.result.checks, 'geometry.world-composition')).toBe('PASS');
    expect(statusFor(outcome.result.checks, 'geometry.delta')).toBe('PASS');
    expect(statusFor(outcome.result.checks, 'containment.parent-chain')).toBe('PASS');
    expect(checkFor(outcome.result.checks, 'geometry.local-invariant')?.actual.authority).toBe(
      'current',
    );
    assertIdentityAgreement(outcome.result.checks, nestedCase.profile, NESTED_CYCLE);
  });

  it('fails only the world-composition check on a trustworthy live-quad mismatch', () => {
    const outcome = evaluateNestedObjectLiveChecks(nestedInput({ oracle: nestedWorldMismatch() }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'geometry.world-composition')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'geometry.local-invariant')).toBe('PASS');
    expect(statusFor(outcome.result.checks, 'geometry.delta')).toBe('PASS');
    const world = checkFor(outcome.result.checks, 'geometry.world-composition');
    expect(world?.actual.sourcesAgree).toBe(false);
    expect(world?.actual.maxObservedResidualCss).toBe(5);
    assertIdentityAgreement(outcome.result.checks, nestedCase.profile, NESTED_CYCLE);
  });

  it('fails only the delta check when the observed browser movement is absent', () => {
    const outcome = evaluateNestedObjectLiveChecks(nestedInput({ oracle: nestedDeltaMismatch() }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'geometry.delta')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'geometry.local-invariant')).toBe('PASS');
    expect(statusFor(outcome.result.checks, 'geometry.world-composition')).toBe('PASS');
    expect(checkFor(outcome.result.checks, 'geometry.delta')?.actual.minimumSatisfied).toBe(false);
    assertIdentityAgreement(outcome.result.checks, nestedCase.profile, NESTED_CYCLE);
  });

  it('produces UNUSABLE for missing, stale, torn, and ambiguous authority', () => {
    const cases: readonly [
      string,
      Parameters<typeof adaptNestedObjectLiveFacts>[0],
      string,
      string | null,
    ][] = [
      ['missing-oracle', nestedInput({ oracle: null }), 'missing', null],
      [
        'stale',
        nestedInput({
          evidence: evidenceAll(nestedCase.profile, { 'geometry.typed-chain-v3': 'stale' }),
        }),
        'stale',
        'geometry.typed-chain-v3',
      ],
      [
        'torn',
        nestedInput({
          evidence: evidenceAll(nestedCase.profile, { 'geometry.typed-chain-v3': 'torn' }),
        }),
        'torn',
        'geometry.typed-chain-v3',
      ],
      [
        'ambiguous',
        nestedInput({
          evidence: evidenceAll(nestedCase.profile, { observation: 'ambiguous' }),
        }),
        'ambiguous',
        'observation',
      ],
    ];
    for (const [label, input, expectedAuthority, unconsumedEvidenceId] of cases) {
      const outcome = evaluateNestedObjectLiveChecks(input);
      expect(outcome.ok, label).toBe(true);
      if (!outcome.ok) continue;
      expect(
        outcome.result.checks.map((check) => check.status),
        label,
      ).toEqual(['UNUSABLE', 'UNUSABLE', 'UNUSABLE', 'UNUSABLE']);
      for (const check of outcome.result.checks) {
        expect(check.actual.authority, label).toBe(expectedAuthority);
        expect(check.actual.mismatch, label).toBe(false);
      }
      if (unconsumedEvidenceId !== null) {
        expect(outcome.result.checks[0]?.evidenceIds, label).not.toContain(unconsumedEvidenceId);
      }
    }
  });

  it('maps the real wrong-target Oracle to UNUSABLE malformed authority and never to FAIL', () => {
    const oracle = nestedWrongTarget();
    expect(oracle.facts).toBeNull();
    expect(oracle.harnessInvalid).toBe(true);
    expect(oracle.primitiveFacts.authority).toBe('malformed');
    const outcome = evaluateNestedObjectLiveChecks(nestedInput({ oracle }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.status)).toEqual([
      'UNUSABLE',
      'UNUSABLE',
      'UNUSABLE',
      'UNUSABLE',
    ]);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(check.actual.mismatch).toBe(false);
    }
  });

  it('maps a wrong pre/post interaction contract shape to UNUSABLE malformed authority', () => {
    const oracle = nestedWrongShape();
    expect(oracle.facts).toBeNull();
    expect(oracle.primitiveFacts.authority).toBe('malformed');
    const outcome = evaluateNestedObjectLiveChecks(nestedInput({ oracle }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
  });

  it('maps a camera degeneracy to UNUSABLE malformed authority with present facts', () => {
    const oracle = nestedCameraMismatch();
    expect(oracle.facts).not.toBeNull();
    expect(oracle.harnessInvalid).toBe(true);
    expect(oracle.primitiveFacts.authority).toBe('malformed');
    const outcome = evaluateNestedObjectLiveChecks(nestedInput({ oracle }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(check.actual.mismatch).toBe(false);
    }
  });

  it('passes the observed evidence roles through untouched, never inventing a role', () => {
    const observed = evidenceAll(nestedCase.profile);
    const outcome = evaluateNestedObjectLiveChecks(
      nestedInput({ oracle: null, evidence: observed }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.evidence).toEqual(observed);
    expect(outcome.result.checks[0]?.evidenceIds).toEqual(
      [...(nestedCase.profile.requiredChecks[0]?.requiredEvidence ?? [])].sort(),
    );
  });

  it('carries no legacy harnessInvalid or boolean passed authority into the kernel facts', () => {
    const adaptation = adaptNestedObjectLiveFacts(nestedInput());
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const facts = adaptation.facts as NestedObjectKernelFacts;
    expect(Object.hasOwn(facts, 'harnessInvalid')).toBe(false);
    expect(Object.hasOwn(facts, 'requiredSourcesAgree')).toBe(false);
    expect(Object.hasOwn(facts, 'checks')).toBe(true);
    for (const check of facts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'status')).toBe(false);
      expect(typeof check.authority).toBe('string');
      expect(typeof check.currentness).toBe('string');
      expect(typeof check.sourcesAgree).toBe('boolean');
      expect(typeof check.mismatch).toBe('boolean');
    }
  });
});

// ── Legacy authority elimination ────────────────────────────────────────────

describe('[P7-B2-B2] legacy authority elimination', () => {
  it('derives facts only from additive primitive observations, never from legacy booleans', () => {
    const baseline = evaluateNestedObjectLiveChecks(nestedInput());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.result.checks.every((check) => check.status === 'PASS')).toBe(true);

    // Runtime spy: flip every legacy composite check-result boolean and the
    // aggregate source-agreement/harness-validity fields while leaving the
    // additive primitive facts byte-identical. The adapter must not observe any
    // difference: it no longer reads any of those fields.
    const oracle = nestedPassing();
    const flipped = {
      ...oracle,
      checks: oracle.checks.map((check) => ({ ...check, passed: !check.passed })),
      requiredSourcesAgree: !oracle.requiredSourcesAgree,
      harnessInvalid: !oracle.harnessInvalid,
    };
    const afterFlip = evaluateNestedObjectLiveChecks(nestedInput({ oracle: flipped }));
    expect(afterFlip.ok).toBe(true);
    if (!afterFlip.ok) return;
    expect(afterFlip.result.checks).toEqual(baseline.result.checks);
    expect(afterFlip.facts).toEqual(baseline.facts);

    // A genuine per-check primitive change must change the adapter output.
    const tamperedPrimitives = {
      ...oracle,
      primitiveFacts: {
        ...oracle.primitiveFacts,
        sourcesAgree: false,
        checks: oracle.primitiveFacts.checks.map((check) => ({ ...check, predicateMet: false })),
      },
    };
    const afterPrimitive = evaluateNestedObjectLiveChecks(
      nestedInput({ oracle: tamperedPrimitives }),
    );
    expect(afterPrimitive.ok).toBe(true);
    if (!afterPrimitive.ok) return;
    expect(afterPrimitive.result.checks.every((check) => check.status === 'FAIL')).toBe(true);
    for (const check of afterPrimitive.result.checks) {
      expect(check.actual.sourcesAgree).toBe(false);
      expect(check.actual.authority).toBe('current');
    }
  });

  it('derives malformed authority from the primitive authority, not the aggregate harness flag', () => {
    const malformed = nestedWrongTarget();
    expect(malformed.primitiveFacts.authority).toBe('malformed');
    // Flip the legacy aggregate flag and every legacy boolean to their clean
    // values; the primitive authority remains malformed, so the outcome stays
    // UNUSABLE rather than becoming a fabricated PASS/FAIL.
    const flipped = {
      ...malformed,
      harnessInvalid: false,
      requiredSourcesAgree: true,
      checks: malformed.checks.map((check) => ({ ...check, passed: true })),
    };
    const outcome = evaluateNestedObjectLiveChecks(nestedInput({ oracle: flipped }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(check.actual.mismatch).toBe(false);
    }
  });

  it('exposes the exact persisted rotation and four-sided padding from the raw projection', () => {
    const outcome = evaluateNestedObjectLiveChecks(nestedInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const local = checkFor(
      outcome.result.checks,
      'geometry.local-invariant',
    ) as CorrectnessCheckResult;
    const expectedFrames = local.expected.persistedFrames as Record<string, unknown>[];
    const actualFrames = local.actual.persistedFrames as Record<string, unknown>[];
    expect(expectedFrames).toHaveLength(CHAIN_FACTS.length);
    expect(actualFrames).toHaveLength(CHAIN_FACTS.length);

    const targetFrame = actualFrames.find((frame) => frame.segmentId === TARGET_ID) as Record<
      string,
      unknown
    >;
    const targetPersisted = targetFrame.persistedFrame as Record<string, unknown>;
    expect(targetPersisted.rotationDegrees).toBe(15);
    expect(targetPersisted.width).toBe(120);
    expect(targetPersisted.height).toBe(70);

    const renderFrames = local.actual.renderFrames as Record<string, unknown>[];
    const witnessRender = renderFrames.find((frame) => frame.segmentId === WITNESS_ID) as Record<
      string,
      unknown
    >;
    const witnessRenderFrame = witnessRender.renderFrame as Record<string, unknown>;
    expect(witnessRenderFrame.padding).toEqual({ left: 8, right: 8, top: 8, bottom: 8 });
    expect(witnessRenderFrame.rotationDegrees).toBe(0);
  });

  it('preserves the active Oracle consumers additively', () => {
    const oracle = nestedPassing();
    // Legacy fields the active runtime still consumes remain exactly as before.
    expect(oracle.checks.map((check) => check.checkId).sort()).toEqual([...CHECK_IDS].sort());
    expect(oracle.checks.every((check) => check.passed)).toBe(true);
    expect(oracle.requiredSourcesAgree).toBe(true);
    expect(oracle.harnessInvalid).toBe(false);
    expect(oracle.facts).not.toBeNull();
    // The additive primitive facts carry only named primitives, never a boolean
    // check result or aggregate harness flag.
    expect(oracle.primitiveFacts.authority).toBe('current');
    expect(oracle.primitiveFacts.sourcesAgree).toBe(true);
    expect(oracle.primitiveFacts.checks.map((check) => check.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    expect(Object.hasOwn(oracle.primitiveFacts, 'passed')).toBe(false);
    expect(Object.hasOwn(oracle.primitiveFacts, 'status')).toBe(false);
    expect(Object.hasOwn(oracle.primitiveFacts, 'harnessInvalid')).toBe(false);
    for (const check of oracle.primitiveFacts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(typeof check.predicateMet).toBe('boolean');
    }
    // The adapter's structured projection never carries the raw legacy booleans.
    const projected = projectNestedObjectLiveFacts(oracle);
    for (const entry of projected) {
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'status')).toBe(false);
    }
  });
});

// ── No adapter policy, no active imports, no legacy authority ───────────────

describe('[P7-B2-B2] inactive adapter invariants', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const adapterSource = source('src/adapters/object-live-facts.ts');
  const kernelSource = source('src/kernels/nested-object-kernel.ts');

  it('does not import any active executor, Oracle, evidence writer, CLI, browser, or classifier', () => {
    expect(adapterSource).not.toMatch(
      /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
    );
    for (const token of [
      'execute-plan',
      'action-cycle',
      'evaluateNestedObjectOracle',
      'writeRunRecord',
      'outcomes',
      'contracts/execution',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('owns no required-check array, fallback id, deadline, tolerance, visual, or normalization literal', () => {
    for (const token of [
      "'containment.parent-chain'",
      "'geometry.local-invariant'",
      "'geometry.world-composition'",
      "'geometry.delta'",
      "'container/object'",
      "'nested-object-move-v1'",
      'deadlineMs',
      'stableFrames',
      'quiescenceRequired',
      '0.25',
      '1e-6',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
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
    expect(adapterSource).not.toContain('evidenceId:');
    expect(adapterSource).not.toMatch(/'PASS'|'FAIL'/);
    // The reconciled kernel fact contract no longer exposes legacy authority.
    expect(kernelSource).not.toMatch(/readonly passed: boolean/);
    expect(kernelSource).not.toMatch(/readonly harnessInvalid: boolean/);
    expect(kernelSource).not.toMatch(/readonly requiredSourcesAgree: boolean/);
  });

  it('reads no legacy composite boolean or aggregate authority field from the observation', () => {
    // Scan only executed source, not explanatory comments.
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bpassed\b/);
    expect(code).not.toMatch(/\bharnessInvalid\b/);
    expect(code).not.toMatch(/\brequiredSourcesAgree\b/);
    expect(code).not.toMatch(/\.status\b/);
    // The only nested read surface is the additive primitive view plus the raw
    // typed-geometry projection the kernel records.
    expect(code).toContain('primitiveFacts');
    expect(code).not.toMatch(/evaluation\.checks/);
  });

  it('is inactive: not exported from the public barrel and unreferenced by active modules', () => {
    const indexSource = source('src/index.ts');
    expect(indexSource).not.toContain('object-live-facts');
    expect(indexSource).not.toContain('adaptNestedObjectLiveFacts');
    expect(indexSource).not.toContain('evaluateNestedObjectLiveChecks');
  });

  it('fails closed with a structured diagnostic on every reported issue', () => {
    const failure = adaptNestedObjectLiveFacts(
      nestedInput({ evidence: [{ evidenceId: 'x', availability: 'nope' } as never] }),
    );
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.status).toBe('HARNESS_BLOCKED');
    expect(failure.launchAttempted).toBe(false);
    expect(failure.diagnostic.code).toBe('UNUSABLE_EVIDENCE');
    expect(failure.diagnostic.detail).toContain('NESTED_OBJECT_LIVE_EVIDENCE_FACT_INVALID');
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

describe('[P7-B2-B2] compiled compatibility mutation matrix', () => {
  const leafPaths: string[] = [];
  collectLeafPaths(nestedCase.profile, '', leafPaths);

  it('covers the complete compiled nested profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(200);
  });

  it('detects every single-leaf mutation of the compiled nested profile', () => {
    for (const leafPath of leafPaths) {
      const adaptation = adaptNestedObjectLiveFacts({
        envelope: mutatedEnvelope(nestedCase.envelope, leafPath),
        route: nestedCase.route,
        actionCycle: NESTED_CYCLE,
        minimumDelta: nestedCase.minimumDelta,
        oracle: nestedPassing(),
        evidence: evidenceAll(nestedCase.profile),
      });
      expect(adaptation.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });

  it('detects a mutated component fingerprint retained against the stored resolved identity', () => {
    const clone = structuredClone(nestedCase.profile) as unknown as Record<string, unknown>;
    (clone.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const adaptation = adaptNestedObjectLiveFacts({
      envelope: {
        ...nestedCase.envelope,
        correctnessProfile: clone,
      } as unknown as MaterializedExecutionEnvelopeV1,
      route: nestedCase.route,
      actionCycle: NESTED_CYCLE,
      minimumDelta: nestedCase.minimumDelta,
      oracle: nestedPassing(),
      evidence: evidenceAll(nestedCase.profile),
    });
    expect(adaptation.ok).toBe(false);
  });

  it('keeps an unrelated valid envelope accepted after the mutation matrix', () => {
    const adaptation = adaptNestedObjectLiveFacts(nestedInput());
    expect(adaptation.ok).toBe(true);
    if (adaptation.ok) {
      expect(adaptation.facts.oracleFacts).not.toBeNull();
      expect(adaptation.facts.checks).toHaveLength(CHECK_IDS.length);
      expect(isFullCanonicalFingerprint(nestedCase.profile.resolvedFingerprint)).toBe(true);
    }
  });
});
