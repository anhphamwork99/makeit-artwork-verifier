import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateCrosswordLayout } from '@/lib/artwork/crosswordEngine/layout';

import { loadResourceManifest } from '../../src/catalogue/resources';
import {
  CROSSWORD_DEFAULT_WORDS,
  CROSSWORD_GENERATOR_SOURCE_PATH,
  CROSSWORD_STORE_SOURCE_PATH,
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  crosswordWordsFingerprint,
  validateCrosswordSourceContract,
} from '../../src/contracts/crossword';
import {
  CROSSWORD_CLOCK_PROFILE_ID,
  CROSSWORD_COMPARISON_PROFILE_ID,
  CROSSWORD_OBSERVATION_SCHEMA_VERSION,
} from '../../src/contracts/crossword-observation';
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
import {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_CONTROL_BUTTON_TYPE,
  HISTORY_CONTROL_NATIVE_TAG,
  HISTORY_SETUP_CHECKPOINTS,
  productBaselineClean,
} from '../../src/contracts/history-observation';
import { rasterProbeBackingCoordinate } from '../../src/contracts/raster';
import type { ResourceManifestEntry } from '../../src/contracts/resources';
import {
  RESTORE_OBSERVATION_SCHEMA_VERSION,
  RESTORE_REQUIRED_CHECKS,
  type RestoreMeaningFactView,
  type RestoreOracleFacts,
  type RestoreRawSemanticFactView,
  type RestoreTransitionFactView,
} from '../../src/contracts/restore-observation';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { WALL_CLOCK_NAMESPACE, WALL_CLOCK_PROVIDER_ID } from '../../src/contracts/wall-clock';
import { evaluateCrosswordOracle, type CrosswordOracleInput } from '../../src/oracles/crossword';
import { evaluateHistoryOracle, type HistoryEvidenceFacts } from '../../src/oracles/history';
import { evaluateImageOracle, type ImageOracleInput } from '../../src/oracles/image';
import {
  evaluateNestedObjectOracle,
  type NestedObjectOracleEvaluation,
} from '../../src/oracles/nested-object';
import { evaluateRestoreOracle } from '../../src/oracles/restore';
import {
  DOCTOR_COMMAND_AUTHORITY,
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  compileResolvedCorrectnessProfile,
  deriveResolvedCorrectnessProfileFingerprint,
  evaluateCrosswordChecks,
  evaluateDoctorCommandChecks,
  evaluateHistoryChecks,
  evaluateImageChecks,
  evaluateNestedObjectChecks,
  evaluateOrdinaryTextChecks,
  evaluateProductionAbsenceCommandChecks,
  evaluateRestoreChecks,
  evaluateWarpedTextChecks,
  evaluateGeometryDeltaOracle,
  imageCurrentnessForAuthority,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  projectCommandStatusAuthority,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  validateCheckContextSeparation,
  validateCommandCheck,
  validateResultIdentityAgreement,
} from '../../src/index';
import {
  projectOrdinaryTextLiveFact,
  projectWarpedTextLiveFacts,
} from '../../src/adapters/text-live-facts';
import { projectNestedObjectLiveFacts } from '../../src/adapters/object-live-facts';
import { projectCrosswordLiveFacts } from '../../src/adapters/crossword-live-facts';
import { projectHistoryLiveFacts } from '../../src/adapters/history-live-facts';
import type {
  ActionCycleCorrectnessIdentity,
  CommandContextResult,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  CrosswordEvidenceAvailability,
  CrosswordKernelFacts,
  HistoryEvidenceAvailability,
  HistoryKernelFacts,
  ImageEvidenceAvailability,
  ImageKernelFacts,
  NestedObjectEvidenceAvailability,
  NestedObjectKernelFacts,
  ResolvedCorrectnessProfile,
  RestoreEvidenceAvailability,
  RestoreKernelFacts,
  TextEvidenceAvailability,
} from '../../src/index';

/**
 * P7-B joint pre-cutover inactive all-family proof (ADR 0028 §4, "Before B2
 * cutover begins, a joint pre-cutover test must prove all seven final evaluator
 * families produce complete field-rich results from compiled profiles without
 * invoking the active writer").
 *
 * This suite drives every inactive route kernel (ordinary Text, warped Text,
 * nested Object, Image, Crossword, History, restore) plus both command-context
 * modules (Doctor, production-absence) inside one process, using each route's
 * exact accepted compiled profile, Action Cycle identity, and accepted fact
 * projection. It proves complete field-rich PASS checks, identity/evidence/ref
 * agreement, full required-check coverage, no compiled-profile context in the
 * command modules, fail-closed representative identity disagreement, and that
 * no active writer or active boolean/v3 runtime surface changed.
 */

const SKILL_ROOT = path.resolve(process.cwd());
const catalogue = loadCorrectnessCatalogue();

function skillSource(relative: string): string {
  return readFileSync(path.join(SKILL_ROOT, relative), 'utf8');
}

function compileRoute(
  route: Parameters<typeof resolveRouteSelection>[1],
  declaredChecks: readonly string[],
): ResolvedCorrectnessProfile {
  const selection = resolveRouteSelection(catalogue, route);
  if (selection === null) throw new Error(`missing route selection for ${route.subjectId}`);
  const compiled = compileResolvedCorrectnessProfile({
    catalogue,
    selection,
    declaredChecks: [...declaredChecks],
  });
  if (!compiled.ok) throw new Error(`route ${route.subjectId} failed to compile`);
  return compiled.profile;
}

function cycle(
  profile: ResolvedCorrectnessProfile,
  actionCycleId: string,
): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint: profile.resolvedFingerprint,
    readinessFingerprint: profile.componentFingerprints.readiness,
  };
}

function evidenceAll<A extends string>(
  profile: ResolvedCorrectnessProfile,
  availability: A,
): { readonly evidenceId: string; readonly availability: A }[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({ evidenceId, availability }));
}

function expectedConsumedFingerprints(profile: ResolvedCorrectnessProfile): Record<string, string> {
  return {
    resolvedProfile: profile.resolvedFingerprint,
    requiredCheckSet: profile.componentFingerprints.requiredCheckSet,
    oracle: profile.componentFingerprints.oracle,
    capture: profile.componentFingerprints.capture,
    tolerances: profile.componentFingerprints.tolerances,
    visuals: profile.componentFingerprints.visuals,
    normalization: profile.componentFingerprints.normalization,
  };
}

interface KernelResultView {
  readonly ok: boolean;
  readonly kind: string;
  readonly checks: readonly CorrectnessCheckResult[];
  readonly issues: readonly { readonly code: string }[];
}

interface FamilyProof {
  readonly family: string;
  readonly route: {
    readonly subjectId: string;
    readonly capability: string;
    readonly variant: string | null;
  };
  readonly profile: ResolvedCorrectnessProfile;
  readonly identity: CorrectnessProfileIdentityView;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly result: KernelResultView;
}

// ── Ordinary / warped Text ───────────────────────────────────────────────────

const TEXT_ORDINARY_ROUTE = {
  subjectId: 'layer/text',
  capability: 'move' as const,
  variant: 'plain',
};
const TEXT_WARPED_ROUTE = {
  subjectId: 'layer/text',
  capability: 'move' as const,
  variant: 'warp-circle',
};

function buildTextProofs(): FamilyProof[] {
  const ordinary = compileRoute(TEXT_ORDINARY_ROUTE, ['geometry.delta']);
  const warped = compileRoute(TEXT_WARPED_ROUTE, ['geometry.delta']);
  const ordinaryCycle = cycle(ordinary, 'joint-cycle-text-ordinary');
  const warpedCycle = cycle(warped, 'joint-cycle-text-warped');

  const ordinaryResult = evaluateOrdinaryTextChecks({
    profile: ordinary,
    route: TEXT_ORDINARY_ROUTE,
    actionCycle: ordinaryCycle,
    facts: {
      evaluator: 'canonical-delta',
      minimumDelta: { x: 40, y: 20 },
      check: projectOrdinaryTextLiveFact(
        evaluateGeometryDeltaOracle({
          minimumDelta: { x: 40, y: 20 },
          canonicalBefore: { x: 100, y: 100 },
          canonicalAfter: { x: 150, y: 130 },
          renderedBefore: { x: 100, y: 100 },
          renderedAfter: { x: 150, y: 130 },
        }),
      ),
      evidence: evidenceAll<TextEvidenceAvailability>(ordinary, 'authoritative'),
    },
  });

  const warpedDelta = {
    canonicalDelta: { x: 80, y: 40 },
    canonicalMet: true,
    expectedRendererDelta: { x: 80, y: 40 },
    maxPointAxisDeviation: 0,
    rendererDeltaPerPoint: [
      { x: 80, y: 40 },
      { x: 80, y: 40 },
      { x: 80, y: 40 },
      { x: 80, y: 40 },
    ],
  };
  const warpedEnvelope = {
    baselineFingerprint: 'baseline-envelope',
    observedFingerprint: 'observed-envelope',
    maxCanonicalDeviation: 0,
    maxRenderedDeviation: 0,
  };
  const warpedResult = evaluateWarpedTextChecks({
    profile: warped,
    route: TEXT_WARPED_ROUTE,
    actionCycle: warpedCycle,
    facts: {
      evaluator: 'typed-envelope',
      minimumDelta: { x: 40, y: 20 },
      checks: projectWarpedTextLiveFacts({
        profileId: warped.oracle.oracleProfileId,
        primitiveFacts: {
          authority: 'current',
          canonicalSourcesAgree: true,
          rendererSourcesAgree: true,
          checks: warped.requiredChecks.map((entry) => ({
            checkId: entry.checkId,
            predicateMet: true,
          })),
        },
        delta: warpedDelta,
        envelope: warpedEnvelope,
      }),
      delta: warpedDelta,
      envelope: warpedEnvelope,
      evidence: evidenceAll<TextEvidenceAvailability>(warped, 'authoritative'),
    },
  });

  return [
    {
      family: 'text-ordinary',
      route: TEXT_ORDINARY_ROUTE,
      profile: ordinary,
      identity: projectCorrectnessProfileIdentity(ordinary),
      actionCycle: ordinaryCycle,
      result: ordinaryResult,
    },
    {
      family: 'text-warped',
      route: TEXT_WARPED_ROUTE,
      profile: warped,
      identity: projectCorrectnessProfileIdentity(warped),
      actionCycle: warpedCycle,
      result: warpedResult,
    },
  ];
}

// ── Nested Object ────────────────────────────────────────────────────────────

const NESTED_ROUTE = { subjectId: 'container/object', capability: 'move' as const, variant: null };
const NESTED_LAYOUT_ID = 'layout-object-active';
const NESTED_TARGET_ID = 'object-outer';
const NESTED_WITNESS_ID = 'text-witness';
const NESTED_MINIMUM_DELTA = { x: 40, y: 20 };
const NESTED_REQUESTED_POINTER_DELTA = { x: 72, y: 36 };
const NESTED_CHAIN_FACTS: NestedObjectFrameFacts[] = [
  {
    id: NESTED_WITNESS_ID,
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
    parentId: NESTED_TARGET_ID,
    x: 12,
    y: 8,
    width: 90,
    height: 50,
    rotationDegrees: 0,
    flipX: false,
    flipY: false,
  },
  {
    id: NESTED_TARGET_ID,
    kind: 'object',
    parentId: NESTED_LAYOUT_ID,
    x: 20,
    y: 15,
    width: 120,
    height: 70,
    rotationDegrees: 15,
    flipX: false,
    flipY: false,
  },
];
const NESTED_MOVED_FACTS: NestedObjectFrameFacts[] = NESTED_CHAIN_FACTS.map((facts) =>
  facts.id === NESTED_TARGET_ID ? { ...facts, x: facts.x + 72, y: facts.y + 36 } : facts,
);

function nestedLayoutItems(facts: NestedObjectFrameFacts[] = NESTED_CHAIN_FACTS): unknown {
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
  const witness = { ...frame(NESTED_WITNESS_ID), type: 'TEXT' };
  const inner = { ...frame('object-inner'), type: 'OBJECT', layers: [witness] };
  const outer = { ...frame(NESTED_TARGET_ID), type: 'OBJECT', layers: [inner] };
  return [{ id: NESTED_LAYOUT_ID, layers: [outer] }];
}

type NestedInteractionInput = Record<string, unknown>;

function nestedPreActionInteraction(): NestedInteractionInput {
  return {
    phase: 'pre-action',
    purpose: 'authorize-native-action',
    authority: 'action',
    status: 'authorized',
    targetId: NESTED_TARGET_ID,
    space: 'browser-client-css',
    candidate: 'center',
    point: { x: 300, y: 220 },
    safetyInsetCssPx: 4,
    source: 'live-konva-hit-v1',
    hitClassification: 'target',
    interactionFingerprint: 'ifp-pre',
  };
}

function nestedPostActionInteraction(
  status: 'clear' | 'obstructed',
  hitClassification: string,
): NestedInteractionInput {
  const obstructed = status === 'obstructed';
  return {
    phase: 'post-action',
    purpose: 'observe-authoritative-geometry',
    authority: 'none',
    status,
    targetId: NESTED_TARGET_ID,
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

function nestedGeometryRecord(
  interaction: NestedInteractionInput,
  chainFacts: NestedObjectFrameFacts[] = NESTED_CHAIN_FACTS,
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
      targetId: NESTED_TARGET_ID,
      witnessId: NESTED_WITNESS_ID,
      layoutId: NESTED_LAYOUT_ID,
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
      target: { id: NESTED_TARGET_ID, konvaId: NESTED_TARGET_ID, fingerprint: 'tf' },
      witness: { id: NESTED_WITNESS_ID, konvaId: NESTED_WITNESS_ID, fingerprint: 'wf' },
      layout: {
        id: NESTED_LAYOUT_ID,
        konvaId: `layout-${NESTED_LAYOUT_ID}`,
        fingerprint: 'lf',
      },
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

function nestedParsed(
  interaction: NestedInteractionInput,
  chainFacts: NestedObjectFrameFacts[] = NESTED_CHAIN_FACTS,
): NestedObjectGeometryV3 {
  const derived = deriveNestedCanonicalChain({
    layoutItems: nestedLayoutItems(chainFacts),
    targetId: NESTED_TARGET_ID,
    witnessId: NESTED_WITNESS_ID,
    layoutId: NESTED_LAYOUT_ID,
  });
  if (!derived.ok) throw new Error('expected a derived nested chain');
  const result = parseNestedGeometryV3({
    raw: nestedGeometryRecord(interaction, chainFacts),
    expected: {
      targetId: NESTED_TARGET_ID,
      witnessId: NESTED_WITNESS_ID,
      layoutId: NESTED_LAYOUT_ID,
      chain: derived.derivation.chain,
    },
  });
  if (!result.ok) throw new Error('expected a parsed nested geometry record');
  return result.geometry;
}

function nestedPositiveEvaluation(): NestedObjectOracleEvaluation {
  return evaluateNestedObjectOracle({
    minimumDelta: NESTED_MINIMUM_DELTA,
    targetId: NESTED_TARGET_ID,
    witnessId: NESTED_WITNESS_ID,
    layoutId: NESTED_LAYOUT_ID,
    requestedPointerDeltaCss: NESTED_REQUESTED_POINTER_DELTA,
    baseline: {
      geometry: nestedParsed(nestedPreActionInteraction()),
      layoutItems: nestedLayoutItems(),
    },
    observed: {
      geometry: nestedParsed(nestedPostActionInteraction('clear', 'target'), NESTED_MOVED_FACTS),
      layoutItems: nestedLayoutItems(NESTED_MOVED_FACTS),
    },
  });
}

function buildNestedProof(): FamilyProof {
  const profile = compileRoute(NESTED_ROUTE, []);
  const actionCycle = cycle(profile, 'joint-cycle-nested-object');
  const evaluation = nestedPositiveEvaluation();
  const facts: NestedObjectKernelFacts = {
    evaluator: 'nested-object-affine',
    minimumDelta: NESTED_MINIMUM_DELTA,
    checks: projectNestedObjectLiveFacts(evaluation),
    oracleFacts: evaluation.facts,
    evidence: evidenceAll<NestedObjectEvidenceAvailability>(profile, 'authoritative'),
  };
  return {
    family: 'nested-object',
    route: NESTED_ROUTE,
    profile,
    identity: projectCorrectnessProfileIdentity(profile),
    actionCycle,
    result: evaluateNestedObjectChecks({ profile, route: NESTED_ROUTE, actionCycle, facts }),
  };
}

// ── Image upload/replacement ─────────────────────────────────────────────────

const IMAGE_ROUTE = {
  subjectId: 'layer/image',
  capability: 'changeProperties' as const,
  variant: 'static',
};
const IMAGE_MANIFEST = loadResourceManifest();
const IMAGE_A = IMAGE_MANIFEST.resources.find(
  (entry) => entry.logicalId === 'image.upload-a',
) as ResourceManifestEntry;
const IMAGE_B = IMAGE_MANIFEST.resources.find(
  (entry) => entry.logicalId === 'image.upload-b',
) as ResourceManifestEntry;
const IMAGE_TARGET_ID = 'layout-image-a-image-1';
const IMAGE_LAYOUT_ID = 'layout-image-a';
const IMAGE_EXPECTED_FRAME = { x: 90, y: 110, width: 320, height: 240, rotation: 0 };

function imageLayer(src: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: IMAGE_TARGET_ID,
    xCoordinate: 90,
    yCoordinate: 110,
    width: 320,
    height: 240,
    rotation: 0,
    transform: { flipX: false, flipY: false },
    config: { placeholder: true, ...(src === null ? {} : { testedWithImage: true }) },
    ...(src === null ? {} : { src }),
    zCoordinate: 1,
    ...overrides,
  };
}

function imageSnapshotWith(sourceLayer: Record<string, unknown>) {
  return [
    { id: IMAGE_LAYOUT_ID, xCoordinate: 80, yCoordinate: 60, layers: [sourceLayer] },
    { id: 'layout-image-control', xCoordinate: 660, yCoordinate: 60, layers: [] },
  ];
}

function imageRasterRecord(entry: ResourceManifestEntry) {
  const backingWidth = 320;
  const backingHeight = 240;
  const probes = entry.structuralVisual.probes.map((probe) => {
    const backingX = rasterProbeBackingCoordinate(
      backingWidth,
      probe.x.numerator,
      probe.x.denominator,
    );
    const backingY = rasterProbeBackingCoordinate(
      backingHeight,
      probe.y.numerator,
      probe.y.denominator,
    );
    return {
      probeSetId: 'rgba-probes-v1',
      probeId: probe.id,
      x: probe.x,
      y: probe.y,
      backingX,
      backingY,
      rgba: [...probe.expectedRgba],
    };
  });
  return {
    rasterSchemaVersion: 3,
    authorityKind: 'image-source-v2',
    observation: {
      schemaVersion: 1,
      documentId: 'doc',
      documentEpoch: 1,
      bridgeVersion: 7,
      bridgeGeneration: 1,
      revision: 5,
    },
    id: IMAGE_TARGET_ID,
    kind: 'image',
    mounted: true,
    status: 'ready',
    source: {
      scheme: 'blob',
      mimeType: 'image/png',
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      decodedWidth: entry.dimensions.width,
      decodedHeight: entry.dimensions.height,
      sourceFingerprint: `sf-${entry.logicalId}`,
    },
    rendered: {
      nodeClass: 'Image',
      drawnWidth: backingWidth,
      drawnHeight: backingHeight,
      backingWidth,
      backingHeight,
      rgbaByteLength: backingWidth * backingHeight * 4,
      rgbaSha256: `rgba-${entry.logicalId}`,
      nonTransparentPixelCount: backingWidth * backingHeight,
      probes,
    },
    renderer: {
      bridgeGeneration: 1,
      stageFingerprint: 'stage',
      targetFingerprint: 'target',
      target: { id: IMAGE_TARGET_ID, nodeClass: 'Image', x: 90, y: 110 },
    },
    capture: {
      started: {
        schemaVersion: 1,
        documentId: 'doc',
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: 5,
      },
      completed: {
        schemaVersion: 1,
        documentId: 'doc',
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: 5,
      },
      sourceStable: true,
      rendererStable: true,
    },
    rasterFingerprint: `rf-${entry.logicalId}`,
  };
}

function imageExpectedResource(entry: ResourceManifestEntry) {
  return {
    logicalId: entry.logicalId,
    version: entry.version,
    sha256: entry.sha256,
    byteLength: entry.byteLength,
    mimeType: entry.mimeType,
    dimensions: entry.dimensions,
    probes: entry.structuralVisual.probes.map((probe) => ({
      id: probe.id,
      x: probe.x,
      y: probe.y,
      expectedRgba: probe.expectedRgba,
      channelTolerance: probe.channelTolerance,
    })),
  };
}

function imageReplacementInput(): ImageOracleInput {
  const accepted = {
    sourceSha256: IMAGE_A.sha256,
    rgbaSha256: `rgba-${IMAGE_A.logicalId}`,
    probes: IMAGE_A.structuralVisual.probes.map((probe) => ({
      probeId: probe.id,
      rgba: probe.expectedRgba,
    })),
  };
  return {
    mode: 'replacement',
    targetId: IMAGE_TARGET_ID,
    expectedLayoutId: IMAGE_LAYOUT_ID,
    expectedFrame: IMAGE_EXPECTED_FRAME,
    expectedResource: imageExpectedResource(IMAGE_B),
    acceptedUpload: accepted,
    baselineSnapshot: imageSnapshotWith(imageLayer('blob:http://127.0.0.1/a')),
    observedSnapshot: imageSnapshotWith(imageLayer('blob:http://127.0.0.1/b')),
    raster: imageRasterRecord(IMAGE_B),
  };
}

function buildImageProof(): FamilyProof {
  const profile = compileRoute(IMAGE_ROUTE, []);
  const actionCycle = cycle(profile, 'joint-cycle-image');
  const input = imageReplacementInput();
  const evaluation = evaluateImageOracle(input);
  const imageAuthority =
    evaluation.primitiveFacts.authority === 'malformed' ? 'malformed' : 'current';
  const imageSourcesAgree = evaluation.primitiveFacts.sourceAgreement === true;
  const facts: ImageKernelFacts = {
    evaluator: 'image-upload-replace',
    mode: input.mode,
    targetId: input.targetId,
    expectedLayoutId: input.expectedLayoutId,
    expectedFrame: input.expectedFrame,
    expectedResource: input.expectedResource,
    acceptedUpload: input.acceptedUpload,
    checks: evaluation.primitiveFacts.checks.map((check) => ({
      checkId: check.checkId,
      authority: imageAuthority as ImageKernelFacts['checks'][number]['authority'],
      currentness: imageCurrentnessForAuthority(
        imageAuthority as ImageKernelFacts['checks'][number]['authority'],
      ),
      sourcesAgree: imageSourcesAgree,
      mismatch: imageAuthority === 'malformed' ? false : check.predicateMet !== true,
    })),
    oracleFacts: {
      authority: evaluation.primitiveFacts.authority,
      sourceAgreement: imageSourcesAgree,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        checkId: check.checkId,
        predicateMet: check.predicateMet === true,
      })),
    },
    diagnostics: evaluation.diagnostics,
    raster: input.raster,
    readiness: {
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
        outcome: 'converged',
        authority: 'current',
        wakeSource: 'store-signal',
        fallbackPollCount: 0,
        watchdogWaits: 0,
        attempts: 1,
        tornCount: 0,
        mismatches: [],
        detail: 'Live raster matches the expected resource.',
      },
    },
    evidence: evidenceAll<ImageEvidenceAvailability>(profile, 'authoritative'),
  };
  return {
    family: 'image',
    route: IMAGE_ROUTE,
    profile,
    identity: projectCorrectnessProfileIdentity(profile),
    actionCycle,
    result: evaluateImageChecks({ profile, route: IMAGE_ROUTE, actionCycle, facts }),
  };
}

// ── Crossword generation ─────────────────────────────────────────────────────

const CROSSWORD_ROUTE = {
  subjectId: 'layer/crossword',
  capability: 'create' as const,
  variant: null,
};
const CROSSWORD_WORDS = [...CROSSWORD_DEFAULT_WORDS];
const CROSSWORD_SEED_A = Date.parse('2026-01-02T03:04:05.000Z');
const CROSSWORD_SEED_B = Date.parse('1970-01-02T10:17:36.789Z');
const CROSSWORD_SOURCE_FINGERPRINT = validateCrosswordSourceContract({
  storeSource: readFileSync(CROSSWORD_STORE_SOURCE_PATH, 'utf8'),
  generatorSource: readFileSync(CROSSWORD_GENERATOR_SOURCE_PATH, 'utf8'),
}).fingerprint;

function crosswordClock(baselines: readonly [string, string, string]) {
  return {
    schemaVersion: 1,
    profileId: CROSSWORD_CLOCK_PROFILE_ID,
    providerId: WALL_CLOCK_PROVIDER_ID,
    comparisonProfileId: CROSSWORD_COMPARISON_PROFILE_ID,
    baselines: [...baselines],
  };
}

function crosswordGeneratedVectorRaster(input: {
  id: string;
  rendererFingerprint: string;
  rasterFingerprint: string;
}) {
  const backingWidth = 40;
  const backingHeight = 40;
  return {
    rasterSchemaVersion: 3,
    authorityKind: 'generated-vector-projection-v1',
    id: input.id,
    kind: 'crossword',
    mounted: true,
    status: 'ready',
    observation: {
      schemaVersion: 1,
      documentId: `doc-${input.id}`,
      documentEpoch: 1,
      bridgeVersion: 7,
      bridgeGeneration: 1,
      revision: 4,
    },
    renderer: {
      bridgeGeneration: 1,
      stageFingerprint: 'stage-fingerprint',
      targetFingerprint: input.rendererFingerprint,
    },
    rasterFingerprint: input.rasterFingerprint,
    capture: {
      method: 'konva-mounted-node-to-canvas-v1',
      started: {
        schemaVersion: 1,
        documentId: `doc-${input.id}`,
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: 3,
      },
      completed: {
        schemaVersion: 1,
        documentId: `doc-${input.id}`,
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: 4,
      },
      rendererStable: true,
      boundsStable: true,
    },
    region: {
      coordinateSpace: 'stage-viewport-css',
      x: 10,
      y: 20,
      width: 40,
      height: 40,
      backingScaleX: 1,
      backingScaleY: 1,
    },
    rendered: {
      backingWidth,
      backingHeight,
      rgbaByteLength: backingWidth * backingHeight * 4,
      rgbaSha256: 'c'.repeat(64),
      nonTransparentPixelCount: 12,
    },
  };
}

function crosswordExecutionChild(executionRole: 'A1' | 'A2' | 'B', seed: number) {
  const declaredWords = [...CROSSWORD_WORDS];
  const layout = generateCrosswordLayout(declaredWords, seed);
  const structural = crosswordSemanticPayloadFromLayerShape(
    { words: declaredWords, layout },
    declaredWords,
  );
  if (!structural.ok || structural.payload === null) throw new Error('fixture layout invalid');
  const semanticDigest = crosswordSemanticDigest(structural.payload);
  const createdTargetId = `cw-${executionRole}`;
  const documentId = `doc-${executionRole}`;
  const rendererFingerprint = `renderer-${executionRole}`;
  const rasterFingerprint = `raster-${executionRole}`;
  return {
    schemaVersion: CROSSWORD_OBSERVATION_SCHEMA_VERSION,
    executionRole,
    clock: {
      providerId: WALL_CLOCK_PROVIDER_ID,
      namespace: WALL_CLOCK_NAMESPACE,
      baselineUtc: new Date(seed).toISOString(),
      expectedSeed: seed,
    },
    sourceContractFingerprint: CROSSWORD_SOURCE_FINGERPRINT,
    transition: {
      preActionHostCrosswordCount: 0,
      postActionHostCrosswordCount: 1,
      newTargetCount: 1,
      historyPastDepthBefore: 0,
      historyPastDepthAfter: 1,
    },
    currentness: {
      schemaVersion: 1,
      documentId,
      documentEpoch: 1,
      bridgeGeneration: 1,
      observationRevision: 4,
      actionEpochId: `epoch-${executionRole}`,
      hostLayoutId: 'layout-a',
      createdTargetId,
      generationSeed: seed,
      wordsFingerprint: crosswordWordsFingerprint(structural.payload.words),
      semanticLayoutDigest: semanticDigest,
      rendererFingerprint,
      rasterFingerprint,
    },
    actualSeed: seed,
    words: declaredWords,
    layout,
    semanticDigest,
    targetGeometry: { id: createdTargetId, x: 10, y: 20, width: 40, height: 40 },
    raster: crosswordGeneratedVectorRaster({
      id: createdTargetId,
      rendererFingerprint,
      rasterFingerprint,
    }),
    observationId: `obs-${executionRole}`,
    tornRecaptureCount: 0,
    contextClosed: true,
  };
}

function crosswordExecutionSet(seeds: readonly [number, number, number]): CrosswordOracleInput {
  return {
    clock: crosswordClock([
      new Date(seeds[0]).toISOString(),
      new Date(seeds[1]).toISOString(),
      new Date(seeds[2]).toISOString(),
    ]),
    sourceFingerprintExpected: CROSSWORD_SOURCE_FINGERPRINT,
    executions: [
      crosswordExecutionChild('A1', seeds[0]),
      crosswordExecutionChild('A2', seeds[1]),
      crosswordExecutionChild('B', seeds[2]),
    ],
  };
}

function buildCrosswordProof(): FamilyProof {
  const profile = compileRoute(CROSSWORD_ROUTE, []);
  const actionCycle = cycle(profile, 'joint-cycle-crossword');
  const input = crosswordExecutionSet([CROSSWORD_SEED_A, CROSSWORD_SEED_A, CROSSWORD_SEED_B]);
  const evaluation = evaluateCrosswordOracle(input);
  const facts: CrosswordKernelFacts = {
    evaluator: 'crossword-determinism',
    clock: input.clock,
    sourceFingerprintExpected: input.sourceFingerprintExpected,
    executions: input.executions,
    checks: projectCrosswordLiveFacts({ primitiveFacts: evaluation.primitiveFacts }),
    comparison: evaluation.comparison,
    oracleFacts: {
      authority: evaluation.primitiveFacts.authority,
      sourceAgreement: evaluation.primitiveFacts.sourceAgreement === true,
      comparison:
        evaluation.primitiveFacts.comparison === null
          ? null
          : {
              sameSeedPair: evaluation.primitiveFacts.comparison.sameSeedPair === true,
              differentSeedPair: evaluation.primitiveFacts.comparison.differentSeedPair === true,
              repeatIdentical: evaluation.primitiveFacts.comparison.repeatIdentical === true,
              seedSensitivity: evaluation.primitiveFacts.comparison.seedSensitivity === true,
              collision: evaluation.primitiveFacts.comparison.collision === true,
              wordsEqualAcrossChildren:
                evaluation.primitiveFacts.comparison.wordsEqualAcrossChildren === true,
              distinctDocuments: evaluation.primitiveFacts.comparison.distinctDocuments === true,
            },
      clockEpochs: Array.isArray(evaluation.primitiveFacts.clockEpochs)
        ? [...evaluation.primitiveFacts.clockEpochs]
        : null,
      currentnessDistinct: evaluation.primitiveFacts.currentnessDistinct === true,
      rasterCurrent: evaluation.primitiveFacts.rasterCurrent === true,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        checkId: check.checkId,
        predicateMet: check.predicateMet === true,
      })),
    },
    diagnostics: evaluation.diagnostics.map((entry) => ({
      code: entry.code,
      detail: entry.detail,
    })),
    evidence: evidenceAll<CrosswordEvidenceAvailability>(profile, 'authoritative'),
  };
  return {
    family: 'crossword',
    route: CROSSWORD_ROUTE,
    profile,
    identity: projectCorrectnessProfileIdentity(profile),
    actionCycle,
    result: evaluateCrosswordChecks({ profile, route: CROSSWORD_ROUTE, actionCycle, facts }),
  };
}

// ── Cross-subject History ────────────────────────────────────────────────────

const HISTORY_ROUTE = {
  subjectId: 'artwork/editor',
  capability: 'history' as const,
  variant: null,
};

function historyTuple(pastDepth: number, futureDepth: number) {
  return { pastDepth, futureDepth, baselineClean: productBaselineClean(pastDepth, futureDepth) };
}

function historyEvidence(): HistoryEvidenceFacts {
  const setup = HISTORY_SETUP_CHECKPOINTS.map((entry) => ({
    checkpointId: entry.checkpointId,
    role: entry.role,
    pastDepth: entry.pastDepth,
    futureDepth: entry.futureDepth,
    baselineClean: productBaselineClean(entry.pastDepth, entry.futureDepth),
    meaning: entry.meaning,
    meaningFingerprint: 'a'.repeat(64),
  }));
  const actions = HISTORY_ACTION_STEPS.map((step) => {
    const preActionRevision = 10 + step.stepIndex * 2;
    const postActionRevision = preActionRevision + 1;
    const prior =
      step.stepIndex === 0
        ? historyTuple(3, 0)
        : HISTORY_ACTION_STEPS[step.stepIndex - 1]?.expectedHistory;
    const historyBefore =
      prior === undefined
        ? historyTuple(3, 0)
        : {
            pastDepth: prior.pastDepth,
            futureDepth: prior.futureDepth,
            baselineClean: prior.baselineClean,
          };
    return {
      stepIndex: step.stepIndex,
      stepId: step.stepId,
      control: step.control,
      controlAccessibleName: HISTORY_CONTROLS[step.control].accessibleName,
      controlTitle: HISTORY_CONTROLS[step.control].title,
      controlNativeTag: HISTORY_CONTROL_NATIVE_TAG,
      controlButtonType: HISTORY_CONTROL_BUTTON_TYPE,
      controlVisible: true,
      controlEnabledBeforeDispatch: true,
      dispatchCount: 1,
      preActionRevision,
      postActionRevision,
      historyBefore,
      historyAfter: { ...step.expectedHistory },
      expectedHistory: { ...step.expectedHistory },
      historyTupleExact: true,
      expectedMeaning: step.expectedMeaning,
      meaningFingerprint: 'b'.repeat(64),
      expectedMeaningFingerprint: 'b'.repeat(64),
      meaningStructurallyEqual: true,
      observationId: `history:${step.stepId}:${postActionRevision}`,
      idle: { stableFrames: 3, waitedMs: 40, observationRevision: postActionRevision },
      tornRecaptureCount: 0,
      transitionObserved: true,
    };
  });
  return {
    retainedLayoutId: 'layout-a',
    setup,
    actions,
    finalHistory: historyTuple(3, 0),
  };
}

function buildHistoryProof(): FamilyProof {
  const profile = compileRoute(HISTORY_ROUTE, []);
  const actionCycle = cycle(profile, 'joint-cycle-history');
  const evidence = historyEvidence();
  const evaluation = evaluateHistoryOracle(evidence);
  const facts: HistoryKernelFacts = {
    evaluator: 'history-cross-subject',
    retainedLayoutId: evidence.retainedLayoutId,
    setup: evidence.setup,
    actions: evidence.actions,
    finalHistory: evidence.finalHistory,
    readiness: {
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
    },
    checks: projectHistoryLiveFacts({ primitiveFacts: evaluation.primitiveFacts }),
    oracleFacts: {
      authority: evaluation.primitiveFacts.authority,
      chainAgreement: evaluation.primitiveFacts.preActionChainCorrelates === true,
      retainedLayoutId: evaluation.primitiveFacts.retainedLayoutId,
      setup:
        evaluation.primitiveFacts.setup === null
          ? null
          : evaluation.primitiveFacts.setup.map((entry) => ({ ...entry })),
      transitions:
        evaluation.primitiveFacts.transitions === null
          ? null
          : evaluation.primitiveFacts.transitions.map((entry) => ({ ...entry })),
      finalHistory:
        evaluation.primitiveFacts.finalHistory === null
          ? null
          : { ...evaluation.primitiveFacts.finalHistory },
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        checkId: check.checkId,
        predicateMet: check.predicateMet === true,
      })),
    },
    diagnostics: evaluation.diagnostics.map((entry) => ({
      code: entry.code,
      detail: entry.detail,
    })),
    evidence: evidenceAll<HistoryEvidenceAvailability>(profile, 'authoritative'),
  };
  return {
    family: 'history',
    route: HISTORY_ROUTE,
    profile,
    identity: projectCorrectnessProfileIdentity(profile),
    actionCycle,
    result: evaluateHistoryChecks({ profile, route: HISTORY_ROUTE, actionCycle, facts }),
  };
}

// ── Frontend serialize/restore ───────────────────────────────────────────────

const RESTORE_ROUTE = {
  subjectId: 'artwork/editor',
  capability: 'frontendSerializeRestore' as const,
  variant: null,
};
const RESTORE_MEANING_FINGERPRINT = 'a'.repeat(32);

function restoreSourceDocument() {
  return {
    documentId: 'doc-source',
    documentEpoch: 1,
    route: '/artwork/editor',
    observationId: 'doc-source:9',
    observationRevision: 9,
    bridgeGeneration: 1,
    normalizedFingerprint: RESTORE_MEANING_FINGERPRINT,
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

function restoreRestoredDocument() {
  return {
    documentId: 'doc-restored',
    documentEpoch: 1,
    route: '/artwork/editor/424242',
    observationId: 'doc-restored:2',
    observationRevision: 2,
    bridgeGeneration: 1,
    normalizedFingerprint: RESTORE_MEANING_FINGERPRINT,
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

function restoreOracle(): RestoreOracleFacts {
  const transition: RestoreTransitionFactView = {
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
  };
  const meaning: RestoreMeaningFactView = {
    normalizedStructurallyEqual: true,
    normalizedFingerprintEqual: true,
    sourceFingerprint: RESTORE_MEANING_FINGERPRINT,
    restoredFingerprint: RESTORE_MEANING_FINGERPRINT,
    inventoryPreserved: true,
    persistenceLossDetected: false,
  };
  const rawSemantics: RestoreRawSemanticFactView = {
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
  };
  return {
    schemaVersion: 1,
    requiredChecks: RESTORE_REQUIRED_CHECKS,
    transition,
    meaning,
    rawSemantics,
  };
}

function buildRestoreProof(): FamilyProof {
  const profile = compileRoute(RESTORE_ROUTE, ['serialize.roundtrip']);
  const actionCycle = cycle(profile, 'joint-cycle-restore');
  const oracle = restoreOracle();
  const evaluation = evaluateRestoreOracle(oracle);
  const facts: RestoreKernelFacts = {
    evaluator: 'frontend-restore',
    schemaVersion: RESTORE_OBSERVATION_SCHEMA_VERSION,
    transition: oracle.transition,
    meaning: oracle.meaning,
    rawSemantics: oracle.rawSemantics,
    source: restoreSourceDocument(),
    restored: restoreRestoredDocument(),
    setup: [
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
        meaningFingerprint: RESTORE_MEANING_FINGERPRINT,
      },
    ],
    readiness: {
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
    },
    checks: evaluation.primitiveFacts.checks.map((check) => ({
      checkId: check.checkId,
      authority: 'current' as const,
      currentness: 'current' as const,
      sourcesAgree: evaluation.primitiveFacts.sourceAgreement === true,
      mismatch: check.predicateMet !== true,
    })),
    oracleFacts: {
      authority: evaluation.primitiveFacts.authority,
      schemaVersion: evaluation.primitiveFacts.schemaVersion,
      sourceAgreement: evaluation.primitiveFacts.sourceAgreement === true,
      transition:
        evaluation.primitiveFacts.transition === null
          ? null
          : { ...evaluation.primitiveFacts.transition },
      meaning:
        evaluation.primitiveFacts.meaning === null
          ? null
          : { ...evaluation.primitiveFacts.meaning },
      rawSemantics:
        evaluation.primitiveFacts.rawSemantics === null
          ? null
          : {
              ...evaluation.primitiveFacts.rawSemantics,
              words: [...evaluation.primitiveFacts.rawSemantics.words],
            },
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        checkId: check.checkId,
        predicateMet: check.predicateMet === true,
      })),
    },
    diagnostics: evaluation.diagnostics.map((entry) => ({
      code: entry.code,
      detail: entry.detail,
    })),
    evidence: evidenceAll<RestoreEvidenceAvailability>(profile, 'authoritative'),
  };
  return {
    family: 'restore',
    route: RESTORE_ROUTE,
    profile,
    identity: projectCorrectnessProfileIdentity(profile),
    actionCycle,
    result: evaluateRestoreChecks({ profile, route: RESTORE_ROUTE, actionCycle, facts }),
  };
}

// ── Command contexts (Doctor, production-absence) ────────────────────────────

function buildDoctorResult(): CommandContextResult {
  return evaluateDoctorCommandChecks({
    commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
    checks: DOCTOR_COMMAND_CHECKS.map((declaration) => ({
      checkId: declaration.checkId,
      authorityState: 'current' as const,
      matched: true,
      actual: { observed: declaration.checkId },
    })),
    evidence: DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
      evidenceId,
      availability: 'authoritative' as const,
    })),
    cleanupSucceeded: true,
  });
}

function buildProductionAbsenceResult(): CommandContextResult {
  return evaluateProductionAbsenceCommandChecks({
    commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    checks: PRODUCTION_ABSENCE_COMMAND_CHECKS.map((declaration) => ({
      checkId: declaration.checkId,
      authorityState: 'current' as const,
      matched: true,
      actual: { observed: declaration.checkId },
    })),
    evidence: PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
      evidenceId,
      availability: 'authoritative' as const,
    })),
    cleanupSucceeded: true,
  });
}

function assertCompleteProfileFamily(proof: FamilyProof): void {
  const { result, profile, identity, actionCycle } = proof;
  expect(result.issues, `${proof.family} kernel issues`).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.checks.map((check) => check.checkId)).toEqual(
    profile.requiredChecks.map((contract) => contract.checkId),
  );
  expect(result.checks).toHaveLength(profile.requiredChecks.length);
  expect(actionCycle.resolvedProfileFingerprint).toBe(profile.resolvedFingerprint);
  expect(actionCycle.readinessFingerprint).toBe(profile.componentFingerprints.readiness);

  for (const check of result.checks) {
    const contract = profile.requiredChecks.find((entry) => entry.checkId === check.checkId);
    expect(contract).toBeDefined();
    expect(check.status).toBe('PASS');
    expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
    expect(check.actionCycleRef).toBe(actionCycle.actionCycleId);
    expect(check.evidenceIds).toEqual([...(contract?.requiredEvidence ?? [])].sort());
    expect(check.toleranceRefs).toEqual([...(contract?.toleranceRefs ?? [])].sort());
    expect(check.visualRefs).toEqual([...(contract?.visualRefs ?? [])].sort());
    expect(check.normalizationRef).toBe(contract?.normalizationRef ?? null);
    expect(check.consumedComponentFingerprints).toEqual(expectedConsumedFingerprints(profile));
    expect(Object.hasOwn(check, 'passed')).toBe(false);
    expect(Object.hasOwn(check, 'harnessInvalid')).toBe(false);
    expect(check.actual.harnessInvalid ?? false).toBe(false);
    expect(Object.hasOwn(check, 'commandAuthority')).toBe(false);
    expect(validateCheckContextSeparation(check).ok).toBe(true);
    for (const value of Object.values(check.consumedComponentFingerprints)) {
      expect(isFullCanonicalFingerprint(value)).toBe(true);
    }
  }

  const agreement = validateResultIdentityAgreement(identity, {
    actionCycles: [actionCycle],
    requiredChecks: result.checks,
  });
  expect(agreement.ok).toBe(true);
  expect(agreement.issues).toEqual([]);
}

function listTsFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

const EXPECTED_FAMILIES = [
  'text-ordinary',
  'text-warped',
  'nested-object',
  'image',
  'crossword',
  'history',
  'restore',
] as const;

function buildAllFamilyProofs(): FamilyProof[] {
  return [
    ...buildTextProofs(),
    buildNestedProof(),
    buildImageProof(),
    buildCrosswordProof(),
    buildHistoryProof(),
    buildRestoreProof(),
  ];
}

describe('[P7-B pre-cutover joint] all seven inactive route families', () => {
  it('produces complete field-rich PASS results from the exact accepted compiled profiles', () => {
    const proofs = buildAllFamilyProofs();
    expect(proofs.map((proof) => proof.family)).toEqual([...EXPECTED_FAMILIES]);
    for (const proof of proofs) {
      assertCompleteProfileFamily(proof);
    }
  });

  it('consumes exactly the compiled required checks and full canonical component identities', () => {
    for (const proof of buildAllFamilyProofs()) {
      for (const contract of proof.profile.requiredChecks) {
        const check = proof.result.checks.find((entry) => entry.checkId === contract.checkId);
        expect(check?.expected.schema).toBe(contract.expectedSchema);
        expect(check?.actual.schema).toBe(contract.actualSchema);
        expect(check?.visualRefs).toEqual([...contract.visualRefs].sort());
        expect(check?.toleranceRefs).toEqual([...contract.toleranceRefs].sort());
      }
      expect(isFullCanonicalFingerprint(proof.profile.resolvedFingerprint)).toBe(true);
      expect(isFullCanonicalFingerprint(proof.profile.componentFingerprints.readiness)).toBe(true);
    }
  });
});

describe('[P7-B pre-cutover joint] inactive command contexts', () => {
  it('produces complete PASS Doctor and production-absence checks under separate authority', () => {
    for (const [result, declaration, authority] of [
      [buildDoctorResult(), DOCTOR_COMMAND_CHECKS, DOCTOR_COMMAND_STATUS_AUTHORITY],
      [
        buildProductionAbsenceResult(),
        PRODUCTION_ABSENCE_COMMAND_CHECKS,
        PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
      ],
    ] as const) {
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.checks.map((check) => check.checkId)).toEqual(
        declaration.map((entry) => entry.checkId),
      );
      for (const check of result.checks) {
        expect(check.status).toBe('PASS');
        expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
        const contract = declaration.find((entry) => entry.checkId === check.checkId);
        expect(contract).toBeDefined();
        expect(check.evidenceIds).toEqual([...(contract?.requiredEvidence ?? [])].sort());
        expect(validateCommandCheck(check).ok).toBe(true);
        expect(validateCheckContextSeparation(check).ok).toBe(true);
        // A command check never fabricates a compiled-profile context.
        expect(Object.hasOwn(check, 'actionCycleRef')).toBe(false);
        expect(Object.hasOwn(check, 'consumedComponentFingerprints')).toBe(false);
        expect(Object.hasOwn(check, 'resolvedProfile')).toBe(false);
        expect(check.commandAuthority.commandAuthorityFingerprint).toBe(
          authority.commandAuthorityFingerprint,
        );
        expect(isFullCanonicalFingerprint(check.commandAuthority.commandAuthorityFingerprint)).toBe(
          true,
        );
      }
    }
  });

  it('keeps Doctor and production-absence authority domains separate and fail-closed', () => {
    expect(DOCTOR_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint).not.toBe(
      PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint,
    );
    expect(projectCommandStatusAuthority(DOCTOR_COMMAND_AUTHORITY)).toEqual(
      DOCTOR_COMMAND_STATUS_AUTHORITY,
    );
    expect(projectCommandStatusAuthority(PRODUCTION_ABSENCE_COMMAND_AUTHORITY)).toEqual(
      PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    );

    const mismatchedDoctor = evaluateDoctorCommandChecks({
      commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
      checks: [],
      evidence: [],
      cleanupSucceeded: true,
    });
    expect(mismatchedDoctor.ok).toBe(false);
    expect(mismatchedDoctor.checks).toEqual([]);

    const mismatchedProduction = evaluateProductionAbsenceCommandChecks({
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: [],
      evidence: [],
      cleanupSucceeded: true,
    });
    expect(mismatchedProduction.ok).toBe(false);
    expect(mismatchedProduction.checks).toEqual([]);
  });
});

describe('[P7-B pre-cutover joint] fail-closed identity and context boundaries', () => {
  it('fails closed on a representative identity disagreement', () => {
    const ordinary = compileRoute(TEXT_ORDINARY_ROUTE, ['geometry.delta']);
    const realIdentity = projectCorrectnessProfileIdentity(ordinary);
    const swapped = structuredClone(ordinary) as unknown as Record<string, unknown>;
    (swapped.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const { resolvedFingerprint: _drop, ...preimage } = swapped;
    void _drop;
    swapped.resolvedFingerprint = deriveResolvedCorrectnessProfileFingerprint(
      preimage as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
    );
    const tampered = swapped as unknown as ResolvedCorrectnessProfile;

    const result = evaluateOrdinaryTextChecks({
      profile: tampered,
      route: TEXT_ORDINARY_ROUTE,
      actionCycle: cycle(tampered, 'joint-cycle-tampered'),
      facts: {
        evaluator: 'canonical-delta',
        minimumDelta: { x: 40, y: 20 },
        check: projectOrdinaryTextLiveFact(
          evaluateGeometryDeltaOracle({
            minimumDelta: { x: 40, y: 20 },
            canonicalBefore: { x: 100, y: 100 },
            canonicalAfter: { x: 150, y: 130 },
            renderedBefore: { x: 100, y: 100 },
            renderedAfter: { x: 150, y: 130 },
          }),
        ),
        evidence: evidenceAll<TextEvidenceAvailability>(tampered, 'authoritative'),
      },
    });
    expect(result.ok).toBe(true);

    const validation = validateResultIdentityAgreement(realIdentity, {
      actionCycles: [cycle(tampered, 'joint-cycle-tampered')],
      requiredChecks: result.checks,
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain(
      'RESULT_CONSUMED_COMPONENT_MISMATCH',
    );
  });

  it('rejects a mixed command/profile check and a contextless check', () => {
    const profileCheck = buildAllFamilyProofs()[0]?.result.checks[0] as CorrectnessCheckResult;
    const commandCheck = buildDoctorResult().checks[0];

    expect(validateCheckContextSeparation(profileCheck).ok).toBe(true);
    expect(validateCheckContextSeparation(commandCheck).ok).toBe(true);
    expect(validateCheckContextSeparation(commandCheck).issues).toEqual([]);

    const mixed = {
      ...profileCheck,
      commandAuthority: commandCheck?.commandAuthority,
    };
    const mixedValidation = validateCheckContextSeparation(mixed);
    expect(mixedValidation.ok).toBe(false);
    expect(mixedValidation.issues.map((entry) => entry.code)).toContain(
      'RESULT_COMMAND_CONTEXT_FORBIDDEN',
    );

    const contextless = validateCheckContextSeparation({
      schemaVersion: 4,
      checkId: 'orphan',
      status: 'PASS',
      expected: {},
      actual: {},
      evidenceIds: [],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    });
    expect(contextless.ok).toBe(false);
    expect(contextless.issues.map((entry) => entry.code)).toContain(
      'RESULT_COMMAND_CONTEXT_REQUIRED',
    );
  });

  it('keeps every produced check free of the legacy boolean and harnessInvalid side channel', () => {
    const checks = [
      ...buildAllFamilyProofs().flatMap((proof) => [...proof.result.checks]),
      ...buildDoctorResult().checks,
      ...buildProductionAbsenceResult().checks,
    ];
    expect(checks).toHaveLength(
      buildAllFamilyProofs().reduce((total, proof) => total + proof.result.checks.length, 0) +
        DOCTOR_COMMAND_CHECKS.length +
        PRODUCTION_ABSENCE_COMMAND_CHECKS.length,
    );
    for (const check of checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'harnessInvalid')).toBe(false);
    }
  });
});

describe('[P7-B pre-cutover joint] current import boundary and retained baseline', () => {
  const source = (relative: string): string => skillSource(relative);

  it('routes the current seven-family and command surfaces through their real post-cutover edges', () => {
    for (const entry of [
      'src/cli/diagnostic.ts',
      'src/cli/suite.ts',
      'src/cli/doctor.ts',
      'src/cli/production-absence.ts',
    ]) {
      expect(source(entry), entry).toContain('orchestration/final-active-path');
    }
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/orchestration/diagnostic-execution.ts',
    ]) {
      const text = source(relative);
      for (const marker of [
        'text-live-facts',
        'object-live-facts',
        'image-live-facts',
        'crossword-live-facts',
        'history-live-facts',
        'restore-live-facts',
      ]) {
        expect(text, `${relative}:${marker}`).toContain(marker);
      }
    }
    expect(source('src/orchestration/command-execution.ts')).toContain('final-record-reader');
    expect(source('src/orchestration/diagnostic-execution.ts')).toContain('final-record-v4');
  });

  it('keeps the current surfaces free of legacy writers and active barrel leakage', () => {
    for (const relative of [
      'src/orchestration/diagnostic-execution.ts',
      'src/orchestration/suite-execution.ts',
      'src/orchestration/command-execution.ts',
      'src/orchestration/doctor-command-execution.ts',
      'src/orchestration/production-absence-command-execution.ts',
    ]) {
      const text = source(relative);
      expect(text, relative).not.toContain('writePublicRunRecord');
      expect(text, relative).not.toContain('writePublicSuiteRecord');
      expect(text, relative).not.toContain("from '../evidence/writer'");
      expect(text, relative).not.toContain("from '../evidence/suite-record'");
    }
    const barrel = source('src/index.ts');
    for (const marker of ['orchestration/', 'final-active-path', 'final-switch-manifest']) {
      expect(barrel, marker).not.toContain(marker);
    }
    for (const marker of ['final-record-v4', 'final-record-reader', 'final-public-record']) {
      expect(barrel, marker).toContain(marker);
    }
  });

  it('keeps each current adapter/kernel reachable only through the executor and orchestration dispatch', () => {
    for (const relative of [
      'src/adapters/text-live-facts.ts',
      'src/adapters/object-live-facts.ts',
      'src/adapters/image-live-facts.ts',
      'src/adapters/crossword-live-facts.ts',
      'src/adapters/history-live-facts.ts',
      'src/adapters/restore-live-facts.ts',
    ]) {
      const text = source(relative);
      expect(text, relative).toContain('kernels/');
      expect(text, relative).not.toContain("from '../evidence/writer'");
      expect(text, relative).not.toContain('writeRunRecord');
    }
    expect(source('src/runtime/execute-plan.ts')).toContain('live-facts');
    expect(source('src/orchestration/diagnostic-execution.ts')).toContain('live-facts');
  });

  it('keeps command orchestration separated from legacy boolean writers while serving current entries', () => {
    for (const relative of [
      'src/orchestration/command-execution.ts',
      'src/orchestration/doctor-command-execution.ts',
      'src/orchestration/production-absence-command-execution.ts',
    ]) {
      const text = source(relative);
      expect(text, relative).not.toContain("from '../evidence/writer'");
      expect(text, relative).not.toContain('writePublicRunRecord');
    }
    expect(source('src/orchestration/command-execution.ts')).toContain('final-record-v4');
    expect(source('src/orchestration/doctor-command-execution.ts')).toContain(
      'executeCommandContext',
    );
    expect(source('src/orchestration/production-absence-command-execution.ts')).toContain(
      'executeCommandContext',
    );
    expect(source('src/cli/doctor.ts')).toContain('orchestration/final-active-path');
    expect(source('src/cli/production-absence.ts')).toContain('orchestration/final-active-path');
  });

  it('keeps the current path free of legacy boolean side-channel authority', () => {
    for (const relative of [
      'src/orchestration/diagnostic-execution.ts',
      'src/orchestration/command-execution.ts',
      'src/orchestration/final-active-path.ts',
    ]) {
      const text = source(relative);
      const executableText = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(executableText, relative).not.toContain('passed: boolean');
      expect(executableText, relative).not.toContain('harnessInvalid');
    }
  });

  it('leaves the retired boolean/v3 baseline available only as compatibility history', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
    expect(source('src/runtime/outcomes.ts')).toContain('harnessInvalid');
  });
});
