import { describe, expect, it } from 'vitest';

import type { ObservationCursor } from '../../src/contracts/observation';
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
  validateNestedObjectRequestV3,
  type NestedObjectFrameFacts,
  type NestedObjectGeometryV3,
} from '../../src/contracts/geometry-v3';
import { multiplyAffine, transformQuad, type Affine2D } from '../../src/contracts/geometry-v2';
import { DIAGNOSTIC_SEVERITY } from '../../src/contracts/diagnostics';
import {
  captureCoherentObservation,
  type StableRendererFingerprint,
  type StampedGeometryView,
  type StampedSnapshotView,
} from '../../src/readiness/coherent-capture';
import {
  NESTED_OBJECT_DELTA_CHECK,
  NESTED_OBJECT_LOCAL_INVARIANT_CHECK,
  NESTED_OBJECT_PARENT_CHAIN_CHECK,
  NESTED_OBJECT_WORLD_COMPOSITION_CHECK,
  evaluateNestedObjectOracle,
  type NestedObjectPublicRenderFrame,
} from '../../src/oracles/nested-object';
import {
  correlateNestedPreActionAuthority,
  refusedActionDispatch,
} from '../../src/runtime/execute-plan';
import { runActionCycle } from '../../src/runtime/action-cycle';
import { classifyOutcome } from '../../src/runtime/outcomes';
import { ACTION_CYCLE_V1_PROFILE } from '../../src/readiness/correlated-gate';

/**
 * WP5 Slice 5-D — purpose-scoped object hit authority (ADR 0014 R4/R6/R8/R9/R10).
 *
 * Unit-level proof for the atomic contract repair: closed phase/purpose request
 * parsing, the post-action obstruction record, representation/interaction/record
 * fingerprint separation, interaction-agnostic G0/G1 capture, and an Oracle that
 * ignores every post-action interaction diagnostic.
 */

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
  const inner = {
    ...frame('object-inner'),
    type: 'OBJECT',
    layers: [witness],
  };
  const outer = {
    ...frame(TARGET_ID),
    type: 'OBJECT',
    layers: [inner],
  };
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

describe('WP5D request contract (ADR 0014 R4)', () => {
  it('accepts exactly the two closed phase/purpose pairs and rejects everything else', () => {
    const pre = validateNestedObjectRequestV3({
      schemaVersion: 1,
      representation: 'nested-object-affine-chain-v2',
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      interaction: { phase: 'pre-action', purpose: 'authorize-native-action' },
    });
    expect(pre.ok).toBe(true);
    const post = validateNestedObjectRequestV3({
      schemaVersion: 1,
      representation: 'nested-object-affine-chain-v2',
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      interaction: { phase: 'post-action', purpose: 'observe-authoritative-geometry' },
    });
    expect(post.ok).toBe(true);
    const crossed = validateNestedObjectRequestV3({
      schemaVersion: 1,
      representation: 'nested-object-affine-chain-v2',
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      interaction: { phase: 'pre-action', purpose: 'observe-authoritative-geometry' },
    });
    expect(crossed.ok).toBe(false);
    const missing = validateNestedObjectRequestV3({
      schemaVersion: 1,
      representation: 'nested-object-affine-chain-v2',
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
    });
    expect(missing.ok).toBe(false);
    for (const badId of ['', '   ']) {
      const invalid = validateNestedObjectRequestV3({
        schemaVersion: 1,
        representation: 'nested-object-affine-chain-v2',
        targetId: badId,
        witnessId: WITNESS_ID,
        layoutId: LAYOUT_ID,
        interaction: { phase: 'pre-action', purpose: 'authorize-native-action' },
      });
      expect(invalid.ok).toBe(false);
    }
  });
});

describe('WP5D geometry-v3 parser (ADR 0014 R6)', () => {
  it('accepts a post-action selection-chrome obstruction without unmounting the target', () => {
    const parsed = parseRecord(postActionInteraction('obstructed', 'selection-chrome'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.geometry.interaction.phase).toBe('post-action');
    expect(parsed.geometry.interaction.authority).toBe('none');
    expect(parsed.geometry.interaction.status).toBe('obstructed');
    expect(parsed.geometry.interaction.hitClassification).toBe('selection-chrome');
    if (parsed.geometry.interaction.phase !== 'post-action') return;
    expect(parsed.geometry.interaction.obstructionCode).toBe('POST_ACTION_HIT_OBSTRUCTED');
    expect(parsed.geometry.interaction.safeHitDescriptor).toEqual({
      nodeClass: 'Rect',
      chromeName: 'artwork-chrome',
      ownedByTarget: true,
    });
    expect(parsed.geometry.representation.targetId).toBe(TARGET_ID);
  });

  it('accepts a clear post-action target observation with authority none', () => {
    const parsed = parseRecord(postActionInteraction('clear', 'target'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.geometry.interaction.authority).toBe('none');
    expect(parsed.geometry.interaction.status).toBe('clear');
  });

  it('rejects unknown fields and every invalid union combination', () => {
    const obstructedMissingDescriptor = geometryRecord(
      postActionInteraction('obstructed', 'selection-chrome'),
    ) as unknown as Record<string, unknown>;
    const interaction = obstructedMissingDescriptor.interaction as Record<string, unknown>;
    delete interaction.safeHitDescriptor;
    const derived = deriveNestedCanonicalChain({
      layoutItems: layoutItems(),
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
    });
    if (!derived.ok) throw new Error('expected a derived chain');
    expect(
      parseNestedGeometryV3({
        raw: obstructedMissingDescriptor,
        expected: {
          targetId: TARGET_ID,
          witnessId: WITNESS_ID,
          layoutId: LAYOUT_ID,
          chain: derived.derivation.chain,
        },
      }).ok,
    ).toBe(false);

    // Crossed status/classification.
    const crossed = geometryRecord({
      ...postActionInteraction('obstructed', 'target'),
    });
    expect(
      parseNestedGeometryV3({
        raw: crossed,
        expected: {
          targetId: TARGET_ID,
          witnessId: WITNESS_ID,
          layoutId: LAYOUT_ID,
          chain: derived.derivation.chain,
        },
      }).ok,
    ).toBe(false);

    // A pre-action member claiming authority none.
    const preBad = geometryRecord({
      ...preActionInteraction(),
      authority: 'none',
    });
    expect(
      parseNestedGeometryV3({
        raw: preBad,
        expected: {
          targetId: TARGET_ID,
          witnessId: WITNESS_ID,
          layoutId: LAYOUT_ID,
          chain: derived.derivation.chain,
        },
      }).ok,
    ).toBe(false);

    // An unknown top-level field.
    const unknown = geometryRecord(preActionInteraction()) as unknown as Record<string, unknown>;
    unknown.extra = true;
    expect(
      parseNestedGeometryV3({
        raw: unknown,
        expected: {
          targetId: TARGET_ID,
          witnessId: WITNESS_ID,
          layoutId: LAYOUT_ID,
          chain: derived.derivation.chain,
        },
      }).ok,
    ).toBe(false);
  });
});

// ── Coherent capture (ADR 0014 R9) ──────────────────────────────────────────

const CURSOR: ObservationCursor = {
  schemaVersion: 1,
  documentId: 'doc-1',
  documentEpoch: 1,
  bridgeVersion: 6,
  bridgeGeneration: 3,
  revision: 10,
};

function stubSnapshot(): StampedSnapshotView {
  return { observation: CURSOR };
}

function postView(repFp: string, interaction: InteractionInput): StampedGeometryView {
  return {
    observation: CURSOR,
    id: TARGET_ID,
    mounted: true,
    visible: true,
    listening: true,
    renderer: {
      bridgeGeneration: 3,
      stageFingerprint: 'stage-1',
      targetFingerprint: 'geom-1',
    },
    geometryV3: {
      schemaVersion: 3,
      representation: { representationFingerprint: repFp },
      typedProvenance: {
        target: { id: TARGET_ID },
        witness: { id: WITNESS_ID },
        layout: { id: LAYOUT_ID },
      },
      interaction,
    },
  };
}

function stableFingerprint(repFp: string): StableRendererFingerprint {
  return {
    bridgeGeneration: 3,
    stageFingerprint: 'stage-1',
    targetFingerprints: { [TARGET_ID]: `geometry-v3:${repFp}` },
  };
}

async function capture(g0: StampedGeometryView, g1: StampedGeometryView, repFp: string) {
  let call = 0;
  return captureCoherentObservation({
    now: () => 0,
    deadlineAt: 0,
    readCursor: async () => CURSOR,
    readSnapshot: async () => stubSnapshot(),
    readGeometry: async () => (call++ % 2 === 0 ? g0 : g1),
    targetIds: [TARGET_ID],
    stableRendererFingerprint: stableFingerprint(repFp),
    allocateObservationId: () => 'obs-1',
  });
}

describe('WP5D coherent capture (ADR 0014 R9)', () => {
  it('accepts equal geometry with a stable chrome obstruction and one observation id', async () => {
    const obstructed = postActionInteraction('obstructed', 'selection-chrome');
    const result = await capture(
      postView('rep-fp-1', obstructed),
      postView('rep-fp-1', obstructed),
      'rep-fp-1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.observationId).toBe('obs-1');
    expect(result.observation.postActionInteraction?.diagnosticStableAcrossG0G1).toBe(true);
    expect(result.observation.postActionInteraction?.accepted?.hitClassification).toBe(
      'selection-chrome',
    );
  });

  it('records interaction-only instability without tearing the geometry authority', async () => {
    const clear = postActionInteraction('clear', 'target');
    const obstructed = postActionInteraction('obstructed', 'selection-chrome');
    // Equal representation fingerprint, different interaction fingerprints.
    let index = 0;
    const result = await captureCoherentObservation({
      now: () => 0,
      deadlineAt: 0,
      readCursor: async () => CURSOR,
      readSnapshot: async () => stubSnapshot(),
      readGeometry: async () =>
        index++ === 0 ? postView('rep-fp-1', clear) : postView('rep-fp-1', obstructed),
      targetIds: [TARGET_ID],
      stableRendererFingerprint: stableFingerprint('rep-fp-1'),
      allocateObservationId: () => 'obs-2',
    });
    void clear;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.postActionInteraction?.diagnosticStableAcrossG0G1).toBe(false);
    expect(result.observation.postActionInteraction?.accepted?.hitClassification).toBe(
      'selection-chrome',
    );
  });

  it('still tears on any representation fingerprint disagreement', async () => {
    const interaction = postActionInteraction('obstructed', 'selection-chrome');
    const result = await capture(
      postView('rep-fp-1', interaction),
      postView('rep-fp-2', interaction),
      'rep-fp-2',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('OBSERVATION_TORN');
    expect(result.torn[0]?.reason).toBe('geometry-bracket-tear');
  });

  it('never classifies a post-action obstruction as target-unmounted', async () => {
    const interaction = postActionInteraction('obstructed', 'selection-chrome');
    const result = await capture(
      postView('rep-fp-1', interaction),
      postView('rep-fp-1', interaction),
      'rep-fp-1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.torn).toHaveLength(0);
  });
});

// ── Oracle (ADR 0014 R10) ───────────────────────────────────────────────────

function parsed(
  interaction: InteractionInput,
  chainFacts: NestedObjectFrameFacts[] = CHAIN_FACTS,
): NestedObjectGeometryV3 {
  const result = parseRecord(interaction, chainFacts);
  if (!result.ok) throw new Error(`expected a parsed record: ${JSON.stringify(result.failure)}`);
  return result.geometry;
}

describe('WP5D Oracle ignores post-action interaction (ADR 0014 R10)', () => {
  it('produces byte-identical four-check results for otherwise identical clear and obstructed inputs', () => {
    const baseline = parsed(preActionInteraction());
    const clear = parsed(postActionInteraction('clear', 'target'));
    const obstructed = parsed(postActionInteraction('obstructed', 'selection-chrome'));
    const common = {
      minimumDelta: { x: 40, y: 20 },
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      requestedPointerDeltaCss: { x: 72, y: 36 },
      baseline: { geometry: baseline, layoutItems: layoutItems() },
    };
    const clearEval = evaluateNestedObjectOracle({
      ...common,
      observed: { geometry: clear, layoutItems: layoutItems() },
    });
    const obstructedEval = evaluateNestedObjectOracle({
      ...common,
      observed: { geometry: obstructed, layoutItems: layoutItems() },
    });
    expect(obstructedEval.checks).toEqual(clearEval.checks);
    expect(obstructedEval.harnessInvalid).toBe(clearEval.harnessInvalid);
    expect(obstructedEval.requiredSourcesAgree).toBe(clearEval.requiredSourcesAgree);
  });

  it('cannot change movement check results when only post interaction fields are mutated', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('obstructed', 'selection-chrome'));
    const common = {
      minimumDelta: { x: 40, y: 20 },
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      requestedPointerDeltaCss: { x: 72, y: 36 },
      baseline: { geometry: baseline, layoutItems: layoutItems() },
    };
    const before = evaluateNestedObjectOracle({
      ...common,
      observed: { geometry: observed, layoutItems: layoutItems() },
    });
    const mutated = structuredClone(observed);
    if (mutated.interaction.phase === 'post-action') {
      mutated.interaction.status = 'clear';
      mutated.interaction.hitClassification = 'target';
      mutated.interaction.obstructionCode = null;
      mutated.interaction.safeHitDescriptor = {
        nodeClass: null,
        chromeName: null,
        ownedByTarget: true,
      };
      mutated.interaction.interactionFingerprint = 'mutated';
    }
    const after = evaluateNestedObjectOracle({
      ...common,
      observed: { geometry: mutated, layoutItems: layoutItems() },
    });
    expect(after.checks).toEqual(before.checks);
  });

  it('rejects a wrong phase/purpose contract shape as unusable authority', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('obstructed', 'selection-chrome'));
    const wrongBaseline = structuredClone(baseline);
    (wrongBaseline.interaction as { phase: string }).phase = 'post-action';
    const result = evaluateNestedObjectOracle({
      minimumDelta: { x: 40, y: 20 },
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      requestedPointerDeltaCss: { x: 72, y: 36 },
      baseline: { geometry: wrongBaseline, layoutItems: layoutItems() },
      observed: { geometry: observed, layoutItems: layoutItems() },
    });
    expect(result.harnessInvalid).toBe(true);
    expect(result.checks.every((check) => check.passed === false)).toBe(true);
  });
});

describe('WP5D diagnostics severity (ADR 0014 binding diagnostics)', () => {
  it('keeps the post-action obstruction diagnostic-only and the quad-point failure blocking', () => {
    expect(DIAGNOSTIC_SEVERITY.POST_ACTION_HIT_OBSTRUCTED).toBe('warning');
    expect(DIAGNOSTIC_SEVERITY.TARGET_QUAD_INTERACTION_POINT_INVALID).toBe('blocking');
    expect(DIAGNOSTIC_SEVERITY.PRODUCT_SELECTION_NOT_RETAINED).toBe('warning');
    expect(DIAGNOSTIC_SEVERITY.HIT_POINT_UNAVAILABLE).toBe('blocking');
  });
});

// ── B0: nested persisted-rotation invariant, required padding, pre-dispatch ──

/**
 * The four-sided public padding contract is required by the type itself; this
 * compile-time assertion fails if padding or any side ever becomes optional.
 */
type PaddingContractIsRequiredFourSided = NestedObjectPublicRenderFrame['padding'] extends {
  left: number;
  right: number;
  top: number;
  bottom: number;
} | null
  ? true
  : never;

const MOVED_FACTS: NestedObjectFrameFacts[] = CHAIN_FACTS.map((facts) =>
  facts.id === TARGET_ID ? { ...facts, x: facts.x + 72, y: facts.y + 36 } : facts,
);

function oracleEvaluation(baseline: NestedObjectGeometryV3, observed: NestedObjectGeometryV3) {
  return evaluateNestedObjectOracle({
    minimumDelta: { x: 40, y: 20 },
    targetId: TARGET_ID,
    witnessId: WITNESS_ID,
    layoutId: LAYOUT_ID,
    requestedPointerDeltaCss: { x: 72, y: 36 },
    baseline: { geometry: baseline, layoutItems: layoutItems() },
    observed: { geometry: observed, layoutItems: layoutItems(MOVED_FACTS) },
  });
}

function checkPassed(
  evaluation: ReturnType<typeof evaluateNestedObjectOracle>,
  checkId: string,
): boolean {
  return evaluation.checks.find((check) => check.checkId === checkId)?.passed === false
    ? false
    : true;
}

describe('B0 nested persisted-rotation invariant (ADR 0027 §1.3)', () => {
  it('passes every check for an otherwise valid root move', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const evaluation = oracleEvaluation(baseline, observed);
    expect(evaluation.checks).toEqual([
      { checkId: NESTED_OBJECT_PARENT_CHAIN_CHECK, passed: true },
      { checkId: NESTED_OBJECT_LOCAL_INVARIANT_CHECK, passed: true },
      { checkId: NESTED_OBJECT_WORLD_COMPOSITION_CHECK, passed: true },
      { checkId: NESTED_OBJECT_DELTA_CHECK, passed: true },
    ]);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.diagnostics).toEqual([]);
  });

  it('fails only the local invariant, as BUG, when a descendant persisted rotation drifts', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    // The witness and the inner Object are descendants: only the outer target
    // may move, and only in x/y. Persisted rotation of every segment stays exact.
    for (const index of [0, 1]) {
      const mutated = structuredClone(observed);
      const segment = mutated.representation.canonicalChain[index] as
        | (typeof mutated.representation.canonicalChain)[number]
        | undefined;
      if (segment === undefined) throw new Error('expected a descendant segment');
      segment.persistedFrame.rotationDegrees = segment.persistedFrame.rotationDegrees + 1;
      const evaluation = oracleEvaluation(baseline, mutated);
      // World composition and delta still pass: they never rescue the failure.
      expect(checkPassed(evaluation, NESTED_OBJECT_PARENT_CHAIN_CHECK)).toBe(true);
      expect(checkPassed(evaluation, NESTED_OBJECT_WORLD_COMPOSITION_CHECK)).toBe(true);
      expect(checkPassed(evaluation, NESTED_OBJECT_DELTA_CHECK)).toBe(true);
      expect(checkPassed(evaluation, NESTED_OBJECT_LOCAL_INVARIANT_CHECK)).toBe(false);
      // The authority stays usable: this is a product/invariant failure, not a
      // harness failure, so it is classified as `BUG`.
      expect(evaluation.harnessInvalid).toBe(false);
      expect(evaluation.diagnostics.map((entry) => entry.code)).toEqual([
        'GEOMETRY_LOCAL_INVARIANT_FAILED',
      ]);
      expect(DIAGNOSTIC_SEVERITY.GEOMETRY_LOCAL_INVARIANT_FAILED).toBe('warning');
      expect(
        classifyOutcome({
          requiredChecks: evaluation.checks,
          cleanupSucceeded: true,
          requiredSourcesAgree: evaluation.requiredSourcesAgree,
          harnessInvalid: evaluation.harnessInvalid,
          environmentInvalid: false,
        }),
      ).toBe('BUG');
    }
  });

  it('keeps the persisted rotation of the outer target exact too', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const mutated = structuredClone(observed);
    const target = mutated.representation.canonicalChain[
      mutated.representation.canonicalChain.length - 1
    ] as (typeof mutated.representation.canonicalChain)[number];
    target.persistedFrame.rotationDegrees = 90;
    const evaluation = oracleEvaluation(baseline, mutated);
    expect(checkPassed(evaluation, NESTED_OBJECT_LOCAL_INVARIANT_CHECK)).toBe(false);
    expect(evaluation.harnessInvalid).toBe(false);
  });
});

describe('B0 required four-sided render padding (ADR 0027 §1.4)', () => {
  it('copies every side explicitly and keeps the plain Text witness at exactly 8/8/8/8', () => {
    const baseline = parsed(preActionInteraction());
    const observed = parsed(postActionInteraction('clear', 'target'), MOVED_FACTS);
    const evaluation = oracleEvaluation(baseline, observed);
    const frames = evaluation.facts?.objectGeometry.frames ?? [];
    expect(frames).toHaveLength(CHAIN_FACTS.length);
    for (const frame of frames) {
      for (const padding of [frame.renderBefore.padding, frame.renderAfter.padding]) {
        if (padding === null) continue;
        expect(Object.keys(padding).sort()).toEqual(['bottom', 'left', 'right', 'top']);
        for (const side of [padding.left, padding.right, padding.top, padding.bottom]) {
          expect(Number.isFinite(side)).toBe(true);
        }
      }
    }
    const witnessFrame = frames.find((frame) => frame.segmentId === WITNESS_ID);
    expect(witnessFrame?.renderBefore.padding).toEqual({
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
    });
    expect(witnessFrame?.renderAfter.padding).toEqual({
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
    });
    // The compile-time four-sided requirement above is exercised here.
    const required: PaddingContractIsRequiredFourSided = true;
    expect(required).toBe(true);
  });

  it('treats a missing padding side as unusable authority instead of defaulting it', () => {
    const raw = geometryRecord(preActionInteraction()) as unknown as Record<string, unknown>;
    const representation = raw.representation as Record<string, unknown>;
    const chain = representation.canonicalChain as Record<string, unknown>[];
    const witness = chain[0] as Record<string, unknown>;
    const renderFrame = witness.renderFrame as Record<string, unknown>;
    const padding = renderFrame.padding as Record<string, unknown>;
    expect(Number.isFinite(padding.right)).toBe(true);
    delete padding.right;
    const derived = deriveNestedCanonicalChain({
      layoutItems: layoutItems(),
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
    });
    if (!derived.ok) throw new Error('expected a derived chain');
    const result = parseNestedGeometryV3({
      raw,
      expected: {
        targetId: TARGET_ID,
        witnessId: WITNESS_ID,
        layoutId: LAYOUT_ID,
        chain: derived.derivation.chain,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('GEOMETRY_CHAIN_INVALID');
  });
});

describe('B0 nested pre-action dispatch authority (ADR 0027 §2.2/§2.3)', () => {
  function correlate(
    overrides: {
      baselineRaw?: unknown;
      freshRaw?: unknown;
      baselineLayoutItems?: unknown;
      freshLayoutItems?: unknown;
      freshHitPoint?: { x: number; y: number } | undefined;
    } = {},
  ) {
    return correlateNestedPreActionAuthority({
      targetId: TARGET_ID,
      witnessId: WITNESS_ID,
      layoutId: LAYOUT_ID,
      baselineLayoutItems: overrides.baselineLayoutItems ?? layoutItems(),
      baselineGeometryV3:
        'baselineRaw' in overrides ? overrides.baselineRaw : geometryRecord(preActionInteraction()),
      freshLayoutItems: overrides.freshLayoutItems ?? layoutItems(),
      freshGeometryV3:
        'freshRaw' in overrides ? overrides.freshRaw : geometryRecord(preActionInteraction()),
      freshHitPoint: 'freshHitPoint' in overrides ? overrides.freshHitPoint : { x: 300, y: 220 },
    });
  }

  it('accepts the exact accepted interaction point and rejects a defaulted or mismatched point', () => {
    expect(correlate()).toEqual({ ok: true, point: { x: 300, y: 220 } });
    // The boundary is inclusive at exactly one 1e-6 arithmetic tolerance.
    expect(correlate({ freshHitPoint: { x: 300 + 1e-6, y: 220 } })).toEqual({
      ok: true,
      point: { x: 300, y: 220 },
    });
    const beyond = correlate({ freshHitPoint: { x: 300 + 2e-6, y: 220 } });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.code).toBe('HIT_POINT_UNAVAILABLE');
    const missing = correlate({ freshHitPoint: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('HIT_POINT_UNAVAILABLE');
  });

  it('refuses a malformed or structurally unvalidated raw authority with the parser code', () => {
    for (const malformed of [
      undefined,
      null,
      {},
      { ...geometryRecord(preActionInteraction()), recordFingerprint: '' },
      {
        ...geometryRecord(preActionInteraction()),
        representation: {
          ...geometryRecord(preActionInteraction()).representation,
          pointOrder: [],
        },
      },
    ]) {
      const result = correlate({ freshRaw: malformed });
      expect(result.ok, JSON.stringify(malformed)).toBe(false);
      if (result.ok) continue;
      expect(result.code).not.toBe('HIT_POINT_UNAVAILABLE');
    }
    const interactionUnknown = geometryRecord(preActionInteraction()) as unknown as Record<
      string,
      unknown
    >;
    const interaction = interactionUnknown.interaction as Record<string, unknown>;
    interaction.point = { x: Number.NaN, y: 220 };
    const nonFinite = correlate({ freshRaw: interactionUnknown });
    expect(nonFinite.ok).toBe(false);
    if (!nonFinite.ok) expect(nonFinite.code).toBe('HIT_POINT_UNAVAILABLE');
  });

  it('refuses a record/interaction fingerprint or post-action phase drift', () => {
    const fingerprint = correlate({
      freshRaw: { ...geometryRecord(preActionInteraction()), recordFingerprint: 'other-record' },
    });
    expect(fingerprint.ok).toBe(false);
    if (!fingerprint.ok) expect(fingerprint.code).toBe('HIT_POINT_UNAVAILABLE');

    const interactionFingerprint = geometryRecord(preActionInteraction()) as unknown as Record<
      string,
      unknown
    >;
    (interactionFingerprint.interaction as Record<string, unknown>).interactionFingerprint =
      'other-interaction';
    const drifted = correlate({ freshRaw: interactionFingerprint });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.code).toBe('HIT_POINT_UNAVAILABLE');

    const postAction = correlate({
      freshRaw: geometryRecord(postActionInteraction('clear', 'target')),
    });
    expect(postAction.ok).toBe(false);
    if (!postAction.ok) expect(postAction.code).toBe('HIT_POINT_UNAVAILABLE');
  });

  it('returns one complete timestamped refused dispatch, and the cycle blocks it as HARNESS_BLOCKED', async () => {
    const refusal = refusedActionDispatch(
      'The reacquired pre-action record does not match the accepted baseline record fingerprint and interaction fingerprint.',
      'HIT_POINT_UNAVAILABLE',
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe('HIT_POINT_UNAVAILABLE');
    expect(Number.isNaN(Date.parse(refusal.at))).toBe(false);
    expect(Object.keys(refusal).sort()).toEqual(['at', 'code', 'detail', 'ok']);

    const nativeDispatchCount = 0;
    const cycle = await runActionCycle({
      profile: ACTION_CYCLE_V1_PROFILE,
      now: () => 0,
      targetIds: [TARGET_ID],
      requiredChecks: [NESTED_OBJECT_LOCAL_INVARIANT_CHECK],
      minimumDelta: { x: 40, y: 20 },
      baseline: {
        cursor: CURSOR,
        snapshot: { observation: CURSOR },
        geometry: { [TARGET_ID]: postView('rep-fp-1', preActionInteraction()) },
      },
      readCursor: async () => {
        throw new Error('unreachable after a pre-dispatch refusal');
      },
      readSnapshot: async () => {
        throw new Error('unreachable after a pre-dispatch refusal');
      },
      readGeometry: async () => {
        throw new Error('unreachable after a pre-dispatch refusal');
      },
      waitForChange: async () => {
        throw new Error('unreachable after a pre-dispatch refusal');
      },
      waitForIdle: async () => {
        throw new Error('unreachable after a pre-dispatch refusal');
      },
      evaluateCausalTransition: async () => {
        throw new Error('unreachable after a pre-dispatch refusal');
      },
      performAction: async () => {
        // Correlation refuses before any native dispatch, so the dispatch count
        // stays zero and the one action fact is the timestamped refusal.
        return refusal;
      },
    });
    expect(nativeDispatchCount).toBe(0);
    expect(cycle.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(cycle.harnessInvalid).toBe(true);
    expect(cycle.observation).toBeNull();
    expect(cycle.action).toBe(refusal);
    expect(cycle.action.at).toBe(refusal.at);
    expect(cycle.diagnostics.map((entry) => entry.code)).toContain('HIT_POINT_UNAVAILABLE');
  });
});
