import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NESTED_OBJECT_POINT_ORDER,
  NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX,
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
  compileResolvedCorrectnessProfile,
  deriveResolvedCorrectnessProfileFingerprint,
  evaluateNestedObjectChecks,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  nestedObjectCurrentnessForAuthority,
  nestedObjectKernelKindForEvaluator,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  NestedObjectAuthorityState,
  NestedObjectEvaluatorFact,
  NestedObjectEvidenceAvailability,
  NestedObjectEvidenceFact,
  NestedObjectKernelFacts,
  NestedObjectKernelIssueCode,
  NestedObjectKernelResult,
  ResolvedCorrectnessProfile,
} from '../../src/index';

/**
 * P7-B B1-C inactive compiled-profile nested-Object kernel tests (ADR 0028 §3
 * B1-C).
 *
 * The kernel is pure and inactive: it is never reached from an active executor,
 * Oracle, classifier, or writer. These tests drive it directly — including with
 * real `evaluateNestedObjectOracle` results over real typed geometry-v3 records
 * — and independently re-validate every produced check with the B1-A
 * compiled-profile/result agreement validator. They also re-assert the B0
 * persisted-rotation and four-sided-padding semantics (ADR 0027 §1.3/§1.4).
 */

const LAYOUT_ID = 'layout-object-active';
const TARGET_ID = 'object-outer';
const WITNESS_ID = 'text-witness';

const ROUTE = { subjectId: 'container/object', capability: 'move' as const, variant: null };

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

function parseRecord(
  interaction: InteractionInput,
  chainFacts: NestedObjectFrameFacts[] = CHAIN_FACTS,
) {
  const derived = deriveNestedCanonicalChain({
    layoutItems: layoutItems(chainFacts),
    targetId: TARGET_ID,
    witnessId: WITNESS_ID,
    layoutId: LAYOUT_ID,
  });
  if (!derived.ok) throw new Error('expected a derived chain');
  return parseNestedGeometryV3({
    raw: geometryRecord(interaction, chainFacts),
    expected: {
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      chain: derived.derivation.chain,
    },
  });
}

function parsed(
  interaction: InteractionInput,
  chainFacts: NestedObjectFrameFacts[] = CHAIN_FACTS,
): NestedObjectGeometryV3 {
  const result = parseRecord(interaction, chainFacts);
  if (!result.ok) throw new Error(`expected a parsed record: ${JSON.stringify(result.failure)}`);
  return result.geometry;
}

const MINIMUM_DELTA = { x: 40, y: 20 };
const REQUESTED_POINTER_DELTA = { x: 72, y: 36 };

function moveEvaluation(
  baseline: NestedObjectGeometryV3,
  observed: NestedObjectGeometryV3,
  observedLayout: unknown,
  overrides: Partial<Parameters<typeof evaluateNestedObjectOracle>[0]> = {},
): NestedObjectOracleEvaluation {
  return evaluateNestedObjectOracle({
    minimumDelta: MINIMUM_DELTA,
    targetId: TARGET_ID,
    witnessId: WITNESS_ID,
    layoutId: LAYOUT_ID,
    requestedPointerDeltaCss: REQUESTED_POINTER_DELTA,
    baseline: { geometry: baseline, layoutItems: layoutItems() },
    observed: { geometry: observed, layoutItems: observedLayout },
    ...overrides,
  });
}

function positiveEvaluation(): NestedObjectOracleEvaluation {
  return moveEvaluation(
    parsed(preActionInteraction()),
    parsed(postActionInteraction('clear', 'target'), MOVED_FACTS),
    layoutItems(MOVED_FACTS),
  );
}

// ── Kernel scaffolding ───────────────────────────────────────────────────────

const catalogue = loadCorrectnessCatalogue();

function compile(): ResolvedCorrectnessProfile {
  const selection = resolveRouteSelection(catalogue, ROUTE);
  if (selection === null) throw new Error('missing nested-Object route selection');
  const compiled = compileResolvedCorrectnessProfile({
    catalogue,
    selection,
    declaredChecks: [],
  });
  if (!compiled.ok) throw new Error('nested-Object route failed to compile');
  return compiled.profile;
}

const profile = compile();
const identity = projectCorrectnessProfileIdentity(profile);

function cycle(
  source: ResolvedCorrectnessProfile = profile,
  id = 'action-cycle-nested-1',
): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId: id,
    resolvedProfileFingerprint: source.resolvedFingerprint,
    readinessFingerprint: source.componentFingerprints.readiness,
  };
}

function evidenceAll(
  source: ResolvedCorrectnessProfile = profile,
  overrides: Readonly<Record<string, NestedObjectEvidenceAvailability>> = {},
): NestedObjectEvidenceFact[] {
  return source.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

/**
 * Projects the delivered Oracle's additive primitive facts into the explicit
 * structured kernel evaluator facts (ADR 0029 §4 B2-B). The kernel tests build
 * these directly so the kernel contract stays independent of the B2-B2 adapter.
 */
function structuredFacts(evaluation: NestedObjectOracleEvaluation): NestedObjectEvaluatorFact[] {
  const primitive = evaluation.primitiveFacts;
  const authority: NestedObjectAuthorityState =
    primitive.authority === 'malformed' ? 'malformed' : 'current';
  return primitive.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: nestedObjectCurrentnessForAuthority(authority),
    sourcesAgree: primitive.sourcesAgree === true,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

function kernelFacts(
  evaluation: NestedObjectOracleEvaluation,
  overrides: Partial<NestedObjectKernelFacts> = {},
): NestedObjectKernelFacts {
  return {
    evaluator: 'nested-object-affine',
    minimumDelta: MINIMUM_DELTA,
    checks: structuredFacts(evaluation),
    oracleFacts: evaluation.facts,
    evidence: evidenceAll(),
    ...overrides,
  };
}

function run(
  facts: NestedObjectKernelFacts,
  source: ResolvedCorrectnessProfile = profile,
): NestedObjectKernelResult {
  return evaluateNestedObjectChecks({
    profile: source,
    route: ROUTE,
    actionCycle: cycle(source),
    facts,
  });
}

function codes(result: NestedObjectKernelResult): NestedObjectKernelIssueCode[] {
  return result.issues.map((entry) => entry.code);
}

function statusFor(result: NestedObjectKernelResult, checkId: string): string | undefined {
  return result.checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(
  result: NestedObjectKernelResult,
  checkId: string,
): CorrectnessCheckResult | undefined {
  return result.checks.find((check) => check.checkId === checkId);
}

function agreement(
  view: CorrectnessProfileIdentityView,
  aCycle: ActionCycleCorrectnessIdentity,
  checks: readonly CorrectnessCheckResult[],
) {
  return validateResultIdentityAgreement(view, { actionCycles: [aCycle], requiredChecks: checks });
}

const CHECK_IDS = [
  'containment.parent-chain',
  'geometry.delta',
  'geometry.local-invariant',
  'geometry.world-composition',
];

describe('[P7-B B1-C] nested-Object kernel positive results', () => {
  it('produces a complete PASS result for every declared nested check from real Oracle facts', () => {
    const evaluation = positiveEvaluation();
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.map((check) => check.checkId).sort()).toEqual([...CHECK_IDS].sort());
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);

    const result = run(kernelFacts(evaluation));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('nested-object-affine');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECK_IDS);

    for (const check of result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
      expect(check.evidenceIds).toEqual(['geometry.typed-chain-v3', 'observation']);
      expect(check.visualRefs).toEqual([]);
      expect(check.normalizationRef).toBeNull();
      expect(check.actionCycleRef).toBe('action-cycle-nested-1');
      expect(check.consumedComponentFingerprints).toEqual({
        resolvedProfile: profile.resolvedFingerprint,
        requiredCheckSet: profile.componentFingerprints.requiredCheckSet,
        oracle: profile.componentFingerprints.oracle,
        capture: profile.componentFingerprints.capture,
        tolerances: profile.componentFingerprints.tolerances,
        visuals: profile.componentFingerprints.visuals,
        normalization: profile.componentFingerprints.normalization,
      });
      expect(check.actual.authority).toBe('current');
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('carries the exact compiled check schemas, tolerances, and references per check', () => {
    const result = run(kernelFacts(positiveEvaluation()));
    for (const contract of profile.requiredChecks) {
      const check = checkFor(result, contract.checkId) as CorrectnessCheckResult;
      expect(check.expected.schema).toBe(contract.expectedSchema);
      expect(check.actual.schema).toBe(contract.actualSchema);
      expect(check.toleranceRefs).toEqual([...contract.toleranceRefs].sort());
    }
    expect(checkFor(result, 'geometry.delta')?.toleranceRefs).toEqual([
      'canonical-matrix-epsilon-v1',
      'renderer-transform-px-v1',
    ]);
    expect(checkFor(result, 'geometry.world-composition')?.toleranceRefs).toEqual([
      'renderer-transform-px-v1',
    ]);
  });

  it('structurally accepts the delivered NestedObjectOracleEvaluation fact projection', () => {
    const evaluation: NestedObjectOracleEvaluation = positiveEvaluation();
    expect(run(kernelFacts(evaluation)).checks.every((check) => check.status === 'PASS')).toBe(
      true,
    );
  });

  it('never consumes post-action hit authority (purpose-scoped, ADR 0014 R10)', () => {
    const clear = moveEvaluation(
      parsed(preActionInteraction()),
      parsed(postActionInteraction('clear', 'target'), MOVED_FACTS),
      layoutItems(MOVED_FACTS),
    );
    const obstructed = moveEvaluation(
      parsed(preActionInteraction()),
      parsed(postActionInteraction('obstructed', 'selection-chrome'), MOVED_FACTS),
      layoutItems(MOVED_FACTS),
    );
    const clearResult = run(kernelFacts(clear));
    const obstructedResult = run(kernelFacts(obstructed));
    expect(obstructedResult.checks).toEqual(clearResult.checks);
    for (const check of clearResult.checks) {
      expect(Object.hasOwn(check.actual, 'hitClassification')).toBe(false);
      expect(Object.hasOwn(check.actual, 'obstructionCode')).toBe(false);
      expect(Object.hasOwn(check.actual, 'candidate')).toBe(false);
      expect(check.actual.baselinePurpose).toBe('authorize-native-action');
      expect(check.actual.observedPurpose).toBe('observe-authoritative-geometry');
    }
  });
});

describe('[P7-B B1-C] trustworthy mismatch maps to FAIL', () => {
  it('fails only the local invariant when a descendant persisted rotation drifts', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    for (const index of [0, 1]) {
      const mutated = structuredClone(observed);
      const segment = mutated.representation.canonicalChain[index];
      if (segment === undefined) throw new Error('expected a descendant segment');
      segment.persistedFrame.rotationDegrees = segment.persistedFrame.rotationDegrees + 1;
      const evaluation = moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS));
      expect(evaluation.harnessInvalid).toBe(false);
      const result = run(kernelFacts(evaluation));
      expect(result.ok).toBe(true);
      // World composition, delta, and containment still pass: they never rescue
      // the local invariant failure.
      expect(statusFor(result, 'containment.parent-chain')).toBe('PASS');
      expect(statusFor(result, 'geometry.world-composition')).toBe('PASS');
      expect(statusFor(result, 'geometry.delta')).toBe('PASS');
      expect(statusFor(result, 'geometry.local-invariant')).toBe('FAIL');
      expect(checkFor(result, 'geometry.local-invariant')?.actual.authority).toBe('current');
      expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
    }
  });

  it('keeps the outer target persisted rotation invariant exact too', () => {
    const baseline = parsed(preActionInteraction());
    const mutated = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const target = mutated.representation.canonicalChain[
      mutated.representation.canonicalChain.length - 1
    ] as (typeof mutated.representation.canonicalChain)[number];
    target.persistedFrame.rotationDegrees = 90;
    const result = run(kernelFacts(moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS))));
    expect(statusFor(result, 'geometry.local-invariant')).toBe('FAIL');
    expect(statusFor(result, 'geometry.delta')).toBe('PASS');
  });

  it('fails only the delta check when the observed browser movement is absent', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'));
    const evaluation = moveEvaluation(baseline, observed, layoutItems());
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(kernelFacts(evaluation));
    expect(statusFor(result, 'geometry.delta')).toBe('FAIL');
    expect(statusFor(result, 'geometry.local-invariant')).toBe('PASS');
    expect(statusFor(result, 'geometry.world-composition')).toBe('PASS');
    expect(statusFor(result, 'containment.parent-chain')).toBe('PASS');
    expect(checkFor(result, 'geometry.delta')?.actual.authority).toBe('current');
    expect(checkFor(result, 'geometry.delta')?.actual.minimumSatisfied).toBe(false);
    expect(checkFor(result, 'geometry.delta')?.actual.canonicalTargetDelta).toEqual({ x: 0, y: 0 });
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only the world-composition check when the live quad disagrees', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const mutated = structuredClone(observed);
    mutated.representation.renderedLayoutQuad[0].x += 5;
    const evaluation = moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS));
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.requiredSourcesAgree).toBe(false);
    const result = run(kernelFacts(evaluation));
    expect(statusFor(result, 'geometry.world-composition')).toBe('FAIL');
    expect(statusFor(result, 'geometry.local-invariant')).toBe('PASS');
    expect(statusFor(result, 'geometry.delta')).toBe('PASS');
    expect(checkFor(result, 'geometry.world-composition')?.actual.sourcesAgree).toBe(false);
    expect(checkFor(result, 'geometry.world-composition')?.actual.maxObservedResidualCss).toBe(5);
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails containment when the chain correlation breaks without rescuing other checks', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const mutated = structuredClone(observed);
    mutated.representation.canonicalChain[0].parentId = 'object-other';
    const evaluation = moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS));
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(kernelFacts(evaluation));
    expect(statusFor(result, 'containment.parent-chain')).toBe('FAIL');
    expect(statusFor(result, 'geometry.world-composition')).toBe('PASS');
  });
});

describe('[P7-B B1-C] missing/stale/torn/parser/authority maps to UNUSABLE', () => {
  it('is UNUSABLE for every check when the accepted Oracle produced no facts', () => {
    const evaluation = moveEvaluation(
      parsed(preActionInteraction()),
      parsed(postActionInteraction('clear', 'target'), MOVED_FACTS),
      layoutItems(MOVED_FACTS),
      { targetId: 'object-not-present' },
    );
    expect(evaluation.facts).toBeNull();
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(kernelFacts(evaluation));
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_ORACLE_FACTS_ABSENT');
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_AUTHORITY_MALFORMED');
    expect(result.checks[0]?.actual.authority).toBe('malformed');
  });

  it('is UNUSABLE for a wrong pre/post interaction contract shape', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('obstructed', 'selection-chrome'));
    const wrongBaseline = structuredClone(baseline);
    (wrongBaseline.interaction as { phase: string }).phase = 'post-action';
    const evaluation = moveEvaluation(wrongBaseline, observed, layoutItems());
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(kernelFacts(evaluation));
    expect(result.checks.map((check) => check.status)).toEqual([
      'UNUSABLE',
      'UNUSABLE',
      'UNUSABLE',
      'UNUSABLE',
    ]);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_AUTHORITY_MALFORMED');
  });

  it('is UNUSABLE for a camera/currentness disagreement even with present facts', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const mutated = structuredClone(observed);
    mutated.camera.stageMatrix.a += 1;
    const evaluation = moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS));
    expect(evaluation.facts).not.toBeNull();
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(kernelFacts(evaluation));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks[0]?.actual.authority).toBe('malformed');
  });

  it('is UNUSABLE and consumes no evidence when required typed-chain authority is torn', () => {
    const result = run(
      kernelFacts(positiveEvaluation(), {
        evidence: evidenceAll(profile, { 'geometry.typed-chain-v3': 'torn' }),
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('geometry.typed-chain-v3');
      expect(check.evidenceIds).toEqual(['observation']);
      expect(check.actual.authority).toBe('torn');
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('is UNUSABLE when required typed-chain authority is missing', () => {
    const result = run(
      kernelFacts(positiveEvaluation(), {
        evidence: evidenceAll(profile, { 'geometry.typed-chain-v3': 'missing' }),
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks[0]?.actual.authority).toBe('missing');
  });

  it('is UNUSABLE, not PASS, when the accepted Oracle facts are absent but checks claim a pass', () => {
    const evaluation = positiveEvaluation();
    const result = run(kernelFacts(evaluation, { oracleFacts: null }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_ORACLE_FACTS_ABSENT');
  });
});

describe('[P7-B B1-C] evidence roles and diagnostic isolation', () => {
  it('never lets a diagnostic-only item rescue a required check', () => {
    const result = run(
      kernelFacts(positiveEvaluation(), {
        evidence: [
          { evidenceId: 'geometry.typed-chain-v3', availability: 'missing' },
          { evidenceId: 'observation', availability: 'authoritative' },
          { evidenceId: 'screenshot.diagnostic', availability: 'diagnostic-only' },
          { evidenceId: 'obstruction.diagnostic', availability: 'diagnostic-only' },
        ],
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of result.checks) {
      expect(check.evidenceIds).toEqual(['observation']);
    }
  });

  it('reports a diagnostic-only item declared for required authority', () => {
    const result = run(
      kernelFacts(positiveEvaluation(), {
        evidence: evidenceAll(profile, { 'geometry.typed-chain-v3': 'diagnostic-only' }),
      }),
    );
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
  });

  it('reports undeclared evidence that claims authority without consuming it', () => {
    const result = run(
      kernelFacts(positiveEvaluation(), {
        evidence: [
          ...evidenceAll(),
          { evidenceId: 'geometry.screenshot-raw', availability: 'authoritative' },
        ],
      }),
    );
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_EVIDENCE_UNDECLARED');
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('geometry.screenshot-raw');
    }
  });
});

describe('[P7-B B1-C] compiled-profile identity agreement', () => {
  it('rejects a profile for a different route without fabricating checks', () => {
    const result = evaluateNestedObjectChecks({
      profile,
      route: { subjectId: 'layer/text', capability: 'move', variant: 'plain' },
      actionCycle: cycle(),
      facts: kernelFacts(positiveEvaluation()),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_ROUTE_MISMATCH');
  });

  it('rejects an Action Cycle that observed a different resolved profile', () => {
    const result = evaluateNestedObjectChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), resolvedProfileFingerprint: 'a'.repeat(64) },
      facts: kernelFacts(positiveEvaluation()),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_ACTION_CYCLE_MISMATCH');
  });

  it('rejects an Action Cycle readiness disagreement', () => {
    const result = evaluateNestedObjectChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), readinessFingerprint: 'b'.repeat(64) },
      facts: kernelFacts(positiveEvaluation()),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_READINESS_MISMATCH');
  });

  it('rejects a compiled profile whose content was mutated in place', () => {
    const tampered = structuredClone(profile) as unknown as Record<string, unknown>;
    (tampered.readiness as Record<string, unknown>).stableFrames = 99;
    const result = evaluateNestedObjectChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: kernelFacts(positiveEvaluation()),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_MISMATCH');
  });

  it('rejects a non-canonical resolved fingerprint', () => {
    const tampered = structuredClone(profile) as unknown as Record<string, unknown>;
    tampered.resolvedFingerprint = 'deadbeef';
    const result = evaluateNestedObjectChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: kernelFacts(positiveEvaluation()),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_INVALID');
  });

  it('rejects an invalid component fingerprint', () => {
    const tampered = structuredClone(profile) as unknown as Record<string, unknown>;
    (tampered.componentFingerprints as Record<string, unknown>).oracle = 'not-a-fingerprint';
    const result = evaluateNestedObjectChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: kernelFacts(positiveEvaluation()),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_COMPONENT_FINGERPRINT_INVALID');
  });

  it('emits consumed component fingerprints a disagreeing compiled identity cannot match', () => {
    const swapped = structuredClone(profile) as unknown as Record<string, unknown>;
    (swapped.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const { resolvedFingerprint: _drop, ...preimage } = swapped;
    swapped.resolvedFingerprint = deriveResolvedCorrectnessProfileFingerprint(
      preimage as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
    );
    void _drop;
    const swappedProfile = swapped as unknown as ResolvedCorrectnessProfile;
    const result = evaluateNestedObjectChecks({
      profile: swappedProfile,
      route: ROUTE,
      actionCycle: cycle(swappedProfile),
      facts: kernelFacts(positiveEvaluation()),
    });
    expect(result.ok).toBe(true);
    const validation = agreement(identity, cycle(swappedProfile), result.checks);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain(
      'RESULT_CONSUMED_COMPONENT_MISMATCH',
    );
  });

  it('leaves the compiled check-set/route identity stable across recompiles', () => {
    expect(compile().resolvedFingerprint).toBe(profile.resolvedFingerprint);
    expect(profile.requiredChecks.map((check) => check.checkId)).toEqual(CHECK_IDS);
    expect(profile.requiredAuthoritativeEvidence).toEqual([
      'geometry.typed-chain-v3',
      'observation',
    ]);
  });
});

describe('[P7-B B1-C] required-check set and evaluator discriminants', () => {
  function tamperedProfile(mutate: (profile: Record<string, unknown>) => void) {
    const clone = structuredClone(profile) as unknown as Record<string, unknown>;
    mutate(clone);
    return clone as unknown as ResolvedCorrectnessProfile;
  }

  function runTampered(source: ResolvedCorrectnessProfile): NestedObjectKernelResult {
    return evaluateNestedObjectChecks({
      profile: source,
      route: ROUTE,
      actionCycle: cycle(source),
      facts: {
        ...kernelFacts(positiveEvaluation()),
      },
    });
  }

  it('rejects an empty required-check set', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        entry.requiredChecks = [];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_EMPTY_REQUIRED_CHECKS');
  });

  it('rejects a duplicated declared check', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        const [check] = entry.requiredChecks as unknown[];
        entry.requiredChecks = [check, check];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_REQUIRED_CHECK_DUPLICATE');
  });

  it('rejects an unsupported per-check evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        const [check] = entry.requiredChecks as Record<string, unknown>[];
        check.evaluator = 'canonical-delta';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_CHECK_EVALUATOR_UNSUPPORTED');
  });

  it('rejects an unsupported Oracle evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        (entry.oracle as Record<string, unknown>).evaluatorKind = 'geometry-delta';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED');
  });

  it('rejects facts that declare a different evaluator', () => {
    const result = run(
      kernelFacts(positiveEvaluation(), {
        evaluator: 'typed-envelope' as unknown as NestedObjectKernelFacts['evaluator'],
      }),
    );
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_FACTS_EVALUATOR_MISMATCH');
  });

  it('rejects an accepted fact for an undeclared check without consuming it', () => {
    const evaluation = positiveEvaluation();
    const result = run(
      kernelFacts(evaluation, {
        checks: [
          ...structuredFacts(evaluation),
          {
            checkId: 'geometry.unknown',
            authority: 'current',
            currentness: 'current',
            sourcesAgree: true,
            mismatch: false,
          },
        ],
      }),
    );
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_FACT_CHECK_UNKNOWN');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECK_IDS);
    expect(result.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('rejects a duplicated check fact', () => {
    const evaluation = positiveEvaluation();
    const facts = structuredFacts(evaluation);
    const result = run(
      kernelFacts(evaluation, {
        checks: [...facts, facts[0] as NestedObjectEvaluatorFact],
      }),
    );
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_FACT_CHECK_DUPLICATE');
  });

  it('makes a declared check UNUSABLE when its accepted fact is absent', () => {
    const evaluation = positiveEvaluation();
    const result = run(
      kernelFacts(evaluation, {
        checks: structuredFacts(evaluation).filter(
          (check) => check.checkId !== 'geometry.local-invariant',
        ),
      }),
    );
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_FACT_CHECK_MISSING');
    expect(statusFor(result, 'geometry.local-invariant')).toBe('UNUSABLE');
    expect(statusFor(result, 'geometry.delta')).toBe('PASS');
  });

  it('makes a check UNUSABLE when its accepted fact has no structured status', () => {
    const evaluation = positiveEvaluation();
    const result = run(
      kernelFacts(evaluation, {
        checks: [
          { checkId: 'geometry.delta' } as unknown as NestedObjectEvaluatorFact,
          ...structuredFacts(evaluation).filter((check) => check.checkId !== 'geometry.delta'),
        ],
      }),
    );
    expect(codes(result)).toContain('NESTED_OBJECT_KERNEL_FACT_STATUS_UNKNOWN');
    expect(statusFor(result, 'geometry.delta')).toBe('UNUSABLE');
  });

  it('routes each delivered evaluator kind to exactly one nested kernel', () => {
    expect(nestedObjectKernelKindForEvaluator('nested-object-affine')).toBe('nested-object-affine');
    expect(nestedObjectKernelKindForEvaluator('geometry-delta')).toBeNull();
    expect(nestedObjectKernelKindForEvaluator('typed-envelope')).toBeNull();
    expect(nestedObjectKernelKindForEvaluator(undefined)).toBeNull();
  });
});

describe('[P7-B B1-C] B0 persisted-rotation and four-sided padding preservation', () => {
  it('exposes the exact persisted rotation and four-sided padding facts', () => {
    const result = run(kernelFacts(positiveEvaluation()));
    const local = checkFor(result, 'geometry.local-invariant') as CorrectnessCheckResult;
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
    expect(targetPersisted.flipX).toBe(false);
    expect(targetPersisted.flipY).toBe(false);

    const renderFrames = local.actual.renderFrames as Record<string, unknown>[];
    const witnessRender = renderFrames.find((frame) => frame.segmentId === WITNESS_ID) as Record<
      string,
      unknown
    >;
    const witnessRenderFrame = witnessRender.renderFrame as Record<string, unknown>;
    expect(witnessRenderFrame.padding).toEqual({ left: 8, right: 8, top: 8, bottom: 8 });
    expect(witnessRenderFrame.rotationDegrees).toBe(0);
    const witnessExpected = (local.expected.renderFrames as Record<string, unknown>[]).find(
      (frame) => frame.segmentId === WITNESS_ID,
    ) as Record<string, unknown>;
    expect((witnessExpected.renderFrame as Record<string, unknown>).padding).toEqual({
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
    });

    // The accepted render tolerance is the Oracle fact, not a local constant.
    expect(local.actual.toleranceCss).toBe(NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX);
  });

  it('shows the drifted persisted rotation in actual versus expected frames', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const mutated = structuredClone(observed);
    const witness = mutated.representation
      .canonicalChain[0] as (typeof mutated.representation.canonicalChain)[number];
    witness.persistedFrame.rotationDegrees = 1;
    const result = run(kernelFacts(moveEvaluation(baseline, mutated, layoutItems(MOVED_FACTS))));
    const local = checkFor(result, 'geometry.local-invariant') as CorrectnessCheckResult;
    const expectedFrames = local.expected.persistedFrames as Record<string, unknown>[];
    const actualFrames = local.actual.persistedFrames as Record<string, unknown>[];
    const expectedWitness = expectedFrames.find(
      (frame) => frame.segmentId === WITNESS_ID,
    ) as Record<string, unknown>;
    const actualWitness = actualFrames.find((frame) => frame.segmentId === WITNESS_ID) as Record<
      string,
      unknown
    >;
    expect((expectedWitness.persistedFrame as Record<string, unknown>).rotationDegrees).toBe(0);
    expect((actualWitness.persistedFrame as Record<string, unknown>).rotationDegrees).toBe(1);
    expect(statusFor(result, 'geometry.local-invariant')).toBe('FAIL');
  });

  it('keeps every produced nested fingerprint full canonical', () => {
    const result = run(kernelFacts(positiveEvaluation()));
    for (const check of result.checks) {
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.resolvedProfile)).toBe(
        true,
      );
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.oracle)).toBe(true);
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.tolerances)).toBe(true);
    }
  });
});

describe('[P7-B B1-C] relevant compiled-field mutation matrix', () => {
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

  it('covers the complete compiled nested profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(200);
  });

  it('rejects every single-leaf mutation of the compiled nested profile', () => {
    for (const leafPath of leafPaths) {
      const clone = structuredClone(profile) as unknown as Record<string, unknown>;
      mutateLeaf(clone, leafPath);
      const mutated = clone as unknown as ResolvedCorrectnessProfile;
      const result = evaluateNestedObjectChecks({
        profile: mutated,
        route: ROUTE,
        actionCycle: cycle(mutated),
        facts: kernelFacts(positiveEvaluation()),
      });
      expect(result.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });
});

describe('[P7-B B1-C] inactive kernel invariants', () => {
  const skillRoot = path.resolve(process.cwd());
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('does not import any active executor, Oracle, evidence writer, or classifier', () => {
    const kernel = source('src/kernels/nested-object-kernel.ts');
    expect(kernel).not.toMatch(/from '\.\.\/(runtime|oracles|evidence)\//);
    expect(kernel).not.toContain('execute-plan');
    expect(kernel).not.toContain('contracts/execution');
    expect(kernel).not.toContain('outcomes');
  });

  it('is not referenced by any active executor, Oracle, or writer module', () => {
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/oracles/evaluate.ts',
      'src/oracles/nested-object.ts',
      'src/evidence/writer.ts',
      'src/evidence/public-dto.ts',
      'src/runtime/outcomes.ts',
    ]) {
      expect(source(relative)).not.toContain('nested-object-kernel');
      expect(source(relative)).not.toContain('evaluateNestedObjectChecks');
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
});
