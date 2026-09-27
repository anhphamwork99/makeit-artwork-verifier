/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this Oracle module compiles until the E3-S2 architecture
 * switch consumes the additive `primitiveFacts` below. It is deliberately
 * declared locally (never imported from `contracts/execution`) so the Oracle no
 * longer reaches the legacy boolean result authority, and it is never the source
 * of a final status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import {
  NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX,
  NESTED_OBJECT_AFFINE_CHAIN_KIND,
  NESTED_OBJECT_POINT_ORDER,
  NESTED_OBJECT_REPRESENTATION_VERSION,
  browserDeltaFromLayoutDelta,
  cameraAgreementPasses,
  evaluateNestedCameraAgreementV3,
  quadsAgreeWithin,
  type NestedObjectGeometryV3,
} from '../contracts/geometry-v3';
import { fnv1a64Hex } from '../contracts/geometry-v2';
import type { MinimumDelta } from './geometry';

/**
 * Nested-object local/world Oracle profile (`nested-object-move-v1`, ADR 0013
 * R9/R10).
 *
 * The Oracle consumes only an accepted coherent baseline/observed pair of
 * geometry-v3 records plus the accepted canonical snapshots. It evaluates the
 * four required checks and never rescues a source with another source, an AABB,
 * a screenshot, a scalar zoom, or a fingerprint:
 *
 *  - `containment.parent-chain`  — chain ids/order/parents unchanged, and only
 *    the outer target's canonical x/y may change inside the nested subtree;
 *  - `geometry.local-invariant` — inner Object and Text parent-local frames stay
 *    unchanged in ids, dims, rotation, flips, content/style/warp, order, z, and
 *    parentage;
 *  - `geometry.world-composition` — canonical and live corresponding witness
 *    points agree before and after;
 *  - `geometry.delta` — the browser movement equals the unchanged linear
 *    projection of the actual canonical target delta, meets the minimum move,
 *    and all witness points share one rigid translation.
 *
 * A failing check with trustworthy authority is a product `BUG`; unusable or
 * contradictory authority is `HARNESS_BLOCKED`. This module returns the checks
 * plus the classification inputs; the engine owns the terminal outcome.
 */

export const NESTED_OBJECT_ORACLE_PROFILE_ID = 'nested-object-move-v1';
export const NESTED_OBJECT_ORACLE_PROFILE_VERSION = 1;

export const NESTED_OBJECT_PARENT_CHAIN_CHECK = 'containment.parent-chain';
export const NESTED_OBJECT_LOCAL_INVARIANT_CHECK = 'geometry.local-invariant';
export const NESTED_OBJECT_WORLD_COMPOSITION_CHECK = 'geometry.world-composition';
export const NESTED_OBJECT_DELTA_CHECK = 'geometry.delta';

/**
 * Closed explicit authority vocabulary for the additive primitive observations
 * (ADR 0029 §4 B2-B). `current` means the accepted typed sources/interaction
 * authority were readable and camera-consistent; `malformed` means the Oracle
 * could not read them (or the camera authority degenerated). This is the only
 * authority a B2-B2 adapter may read; the legacy aggregate harness-validity flag
 * is deliberately not part of this view.
 */
export const NESTED_OBJECT_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type NestedObjectPrimitiveAuthority = (typeof NESTED_OBJECT_PRIMITIVE_AUTHORITIES)[number];

/** The four accepted required nested checks the additive primitives describe. */
export type NestedObjectPrimitiveCheckId =
  | typeof NESTED_OBJECT_PARENT_CHAIN_CHECK
  | typeof NESTED_OBJECT_LOCAL_INVARIANT_CHECK
  | typeof NESTED_OBJECT_WORLD_COMPOSITION_CHECK
  | typeof NESTED_OBJECT_DELTA_CHECK;

/** One explicit per-check predicate derived from the raw observations. */
export interface NestedObjectPrimitiveCheckFact {
  readonly checkId: NestedObjectPrimitiveCheckId;
  readonly predicateMet: boolean;
}

/**
 * Additive, explicitly named primitive nested-evaluation facts (ADR 0029 §4
 * B2-B). They expose an explicit structured authority, the independent
 * canonical/live corresponding-point source-agreement primitive, and one
 * explicit predicate per accepted required check. No field here is a legacy
 * composite boolean check result. The raw persisted rotation, four-sided
 * padding, delta, and composition authority remain available on the Oracle's
 * own `facts` projection.
 */
export interface NestedObjectPrimitiveFacts {
  readonly authority: NestedObjectPrimitiveAuthority;
  readonly sourcesAgree: boolean;
  readonly checks: readonly NestedObjectPrimitiveCheckFact[];
}

/**
 * The explicit primitive facts of a malformed nested evaluation: no readable
 * typed source, so the authority is `malformed`, the source-agreement primitive
 * is false, and no check predicate is met.
 */
function malformedNestedObjectPrimitiveFacts(): NestedObjectPrimitiveFacts {
  return {
    authority: 'malformed',
    sourcesAgree: false,
    checks: [
      { checkId: NESTED_OBJECT_PARENT_CHAIN_CHECK, predicateMet: false },
      { checkId: NESTED_OBJECT_LOCAL_INVARIANT_CHECK, predicateMet: false },
      { checkId: NESTED_OBJECT_WORLD_COMPOSITION_CHECK, predicateMet: false },
      { checkId: NESTED_OBJECT_DELTA_CHECK, predicateMet: false },
    ],
  };
}

export interface NestedObjectOracleFacts {
  targetId: string;
  witnessId: string;
  layoutId: string;
  parentChain: readonly string[];
  requestedPointerDeltaCss: { x: number; y: number };
  canonicalTargetDelta: { x: number; y: number };
  expectedBrowserDeltaCss: { x: number; y: number };
  observedBrowserDeltaCss: readonly { point: string; x: number; y: number }[];
  localInvariant: boolean;
  chainInvariant: boolean;
  worldComposition: boolean;
  cameraAgreement: boolean;
  /** Closed, allowlisted public objectGeometry projection (ADR 0015 B15). */
  objectGeometry: NestedObjectPublicProjection;
}

/**
 * The bounded public nested-object geometry projection. It carries only
 * scalars, booleans, closed enum values, and opaque fingerprints: no raw Konva
 * node dump, no unrestricted ancestry path, no absolute path, and no fabricated
 * post-action hit point.
 */
export interface NestedObjectPublicProjection {
  representation: {
    kind: string;
    representationVersion: number;
    chainFingerprint: string;
    representationFingerprint: string;
    pointOrder: readonly string[];
  };
  fixtureNormalization: {
    certificateVersion: string;
    fixedPointBefore: boolean;
    fixedPointAfter: boolean;
    baselineSubtreeFingerprint: string;
    observedSubtreeFingerprint: string;
  };
  frames: readonly {
    segmentId: string;
    kind: string;
    persistedBefore: NestedObjectPublicFrame;
    persistedAfter: NestedObjectPublicFrame;
    renderBefore: NestedObjectPublicRenderFrame;
    renderAfter: NestedObjectPublicRenderFrame;
  }[];
  wrappers: {
    translationWrapperFingerprint: string;
    centerRotationWrapperFingerprint: string;
    completeMatrixFingerprint: string;
    flipShellIdentity: boolean;
    wrapperStructureValidated: boolean;
  };
  composition: {
    correspondingPointOrder: readonly string[];
    maxBaselineResidualCss: number;
    maxObservedResidualCss: number;
    toleranceCss: number;
  };
  movement: {
    canonicalRootDeltaLayout: { x: number; y: number };
    expectedBrowserDeltaCss: { x: number; y: number };
    observedBrowserDeltaCssByPoint: readonly { point: string; x: number; y: number }[];
    rigidTranslation: boolean;
    minimumSatisfied: boolean;
  };
  interaction: {
    baseline: NestedObjectPublicInteraction;
    observed: NestedObjectPublicInteraction;
  };
}

export interface NestedObjectPublicFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
  flipX: boolean;
  flipY: boolean;
}

export interface NestedObjectPublicRenderFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
  derivation: string;
  padding: { left: number; right: number; top: number; bottom: number } | null;
  frameShift: { x: number; y: number };
}

export interface NestedObjectPublicInteraction {
  phase: string;
  purpose: string;
  authority: string;
  status: string;
  candidate: string;
  hitClassification: string;
  obstructionCode: string | null;
  interactionFingerprint: string;
}

export interface NestedObjectOracleInput {
  minimumDelta: MinimumDelta;
  targetId: string;
  witnessId: string;
  layoutId: string;
  requestedPointerDeltaCss: { x: number; y: number };
  baseline: {
    geometry: NestedObjectGeometryV3;
    layoutItems: unknown;
  };
  observed: {
    geometry: NestedObjectGeometryV3;
    layoutItems: unknown;
  };
}

export interface NestedObjectOracleEvaluation {
  checks: readonly LegacyCompositeCheck[];
  requiredSourcesAgree: boolean;
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  facts: NestedObjectOracleFacts | null;
  /**
   * Additive primitive facts for the inactive B2-B2 live-fact adapter. The
   * legacy `checks`/`requiredSourcesAgree`/`harnessInvalid` fields above remain
   * for the active runtime until the B2-E cutover; the adapter reads only this
   * view and the raw `facts` projection.
   */
  primitiveFacts: NestedObjectPrimitiveFacts;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findLayoutItem(layoutItems: unknown, layoutId: string): Record<string, unknown> | null {
  if (!Array.isArray(layoutItems)) return null;
  const found = layoutItems.find((entry) => isRecord(entry) && entry.id === layoutId);
  return found === undefined ? null : (found as Record<string, unknown>);
}

function findLayer(layers: unknown, id: string): Record<string, unknown> | null {
  if (!Array.isArray(layers)) return null;
  for (const candidate of layers) {
    if (!isRecord(candidate)) continue;
    if (candidate.id === id) return candidate;
    if (candidate.type === 'OBJECT') {
      const nested = findLayer(candidate.layers, id);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Normalizes the nested subtree for invariance comparison: the subtree rooted at
 * `targetId` with only the root's own `xCoordinate`/`yCoordinate` removed. Every
 * descendant fact (coordinates, dims, rotation, flips, opacity, content, style,
 * warp, order, z, parentage) remains covered.
 */
function normalizedNestedSubtree(
  layoutItems: unknown,
  layoutId: string,
  targetId: string,
): string | null {
  const layout = findLayoutItem(layoutItems, layoutId);
  if (!layout) return null;
  const layer = findLayer(layout.layers, targetId);
  if (!layer) return null;
  const clone = structuredClone(layer);
  delete clone.xCoordinate;
  delete clone.yCoordinate;
  return stableStringify(clone);
}

function chainShape(geometry: NestedObjectGeometryV3): readonly { id: string; parentId: string }[] {
  return geometry.representation.canonicalChain.map((segment) => ({
    id: segment.id,
    parentId: segment.parentId,
  }));
}

function chainShapesEqual(
  left: readonly { id: string; parentId: string }[],
  right: readonly { id: string; parentId: string }[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) => entry.id === right[index].id && entry.parentId === right[index].parentId,
  );
}

function localFramesEqual(left: NestedObjectGeometryV3, right: NestedObjectGeometryV3): boolean {
  const leftChain = left.representation.canonicalChain;
  const rightChain = right.representation.canonicalChain;
  if (leftChain.length !== rightChain.length) return false;
  // Only the outer target (last segment) may change, and only its x/y.
  for (let index = 0; index < leftChain.length; index += 1) {
    const a = leftChain[index];
    const b = rightChain[index];
    if (a.id !== b.id || a.kind !== b.kind || a.parentId !== b.parentId) return false;
    if (a.persistedFrame.rotationDegrees !== b.persistedFrame.rotationDegrees) return false;
    if (a.persistedFrame.flipX !== b.persistedFrame.flipX) return false;
    if (a.persistedFrame.flipY !== b.persistedFrame.flipY) return false;
    if (
      a.persistedFrame.width !== b.persistedFrame.width ||
      a.persistedFrame.height !== b.persistedFrame.height
    ) {
      return false;
    }
    const isTarget = index === leftChain.length - 1;
    if (!isTarget) {
      if (a.persistedFrame.x !== b.persistedFrame.x || a.persistedFrame.y !== b.persistedFrame.y) {
        return false;
      }
    }
  }
  return true;
}

const EPSILON = 1e-6;

function publicInteractionFromGeometry(
  geometry: NestedObjectGeometryV3,
): NestedObjectPublicInteraction {
  const interaction = geometry.interaction;
  return {
    phase: interaction.phase,
    purpose: interaction.purpose,
    authority: interaction.authority,
    status: interaction.status,
    candidate: interaction.candidate,
    hitClassification: interaction.hitClassification,
    obstructionCode: interaction.phase === 'post-action' ? interaction.obstructionCode : null,
    interactionFingerprint: interaction.interactionFingerprint,
  };
}

function maxQuadResidualCss(
  canonical: readonly { x: number; y: number }[],
  rendered: readonly { x: number; y: number }[],
): number {
  let max = 0;
  for (let index = 0; index < 4; index += 1) {
    max = Math.max(
      max,
      Math.abs(canonical[index].x - rendered[index].x),
      Math.abs(canonical[index].y - rendered[index].y),
    );
  }
  return max;
}

function buildObjectGeometryProjection(input: {
  baseline: NestedObjectGeometryV3;
  observed: NestedObjectGeometryV3;
  canonicalTargetDelta: { x: number; y: number };
  expectedBrowserDeltaCss: { x: number; y: number };
  observedBrowserDeltaCss: readonly { point: string; x: number; y: number }[];
  minimumOk: boolean;
  rigid: boolean;
}): NestedObjectPublicProjection {
  const { baseline, observed } = input;
  const frames = baseline.representation.canonicalChain.map((segment, index) => {
    const after = observed.representation.canonicalChain[index];
    const afterRender = after?.renderFrame ?? segment.renderFrame;
    return {
      segmentId: segment.id,
      kind: segment.kind,
      persistedBefore: { ...segment.persistedFrame },
      persistedAfter: { ...(after?.persistedFrame ?? segment.persistedFrame) },
      renderBefore: {
        ...segment.renderFrame,
        padding:
          segment.renderFrame.padding === null
            ? null
            : {
                left: segment.renderFrame.padding.left,
                right: segment.renderFrame.padding.right,
                top: segment.renderFrame.padding.top,
                bottom: segment.renderFrame.padding.bottom,
              },
        frameShift: {
          x: segment.renderFrame.frameShift.x,
          y: segment.renderFrame.frameShift.y,
        },
      },
      renderAfter: {
        ...afterRender,
        padding:
          afterRender.padding === null
            ? null
            : {
                left: afterRender.padding.left,
                right: afterRender.padding.right,
                top: afterRender.padding.top,
                bottom: afterRender.padding.bottom,
              },
        frameShift: {
          x: afterRender.frameShift.x,
          y: afterRender.frameShift.y,
        },
      },
    };
  });
  const wrappers = observed.representation.targetWrappers;
  return {
    representation: {
      kind: baseline.representation.kind,
      representationVersion: NESTED_OBJECT_REPRESENTATION_VERSION,
      chainFingerprint: baseline.chainFingerprint,
      representationFingerprint: baseline.representation.representationFingerprint,
      pointOrder: [...NESTED_OBJECT_POINT_ORDER],
    },
    fixtureNormalization: {
      certificateVersion: baseline.normalization.certificateVersion,
      fixedPointBefore: baseline.normalization.fixedPoint,
      fixedPointAfter: observed.normalization.fixedPoint,
      baselineSubtreeFingerprint: baseline.normalization.subtreeFingerprint,
      observedSubtreeFingerprint: observed.normalization.subtreeFingerprint,
    },
    frames,
    wrappers: {
      translationWrapperFingerprint: fnv1a64Hex(
        JSON.stringify(wrappers.translationWrapperToLayout),
      ),
      centerRotationWrapperFingerprint: fnv1a64Hex(
        JSON.stringify(wrappers.centerRotationSubtreeToTranslationWrapper),
      ),
      completeMatrixFingerprint: fnv1a64Hex(JSON.stringify(wrappers.completeObjectToLayout)),
      flipShellIdentity: wrappers.flipShellIdentity,
      wrapperStructureValidated: wrappers.wrapperStructureValidated,
    },
    composition: {
      correspondingPointOrder: [...NESTED_OBJECT_POINT_ORDER],
      maxBaselineResidualCss: maxQuadResidualCss(
        baseline.representation.canonicalLayoutQuad,
        baseline.representation.renderedLayoutQuad,
      ),
      maxObservedResidualCss: maxQuadResidualCss(
        observed.representation.canonicalLayoutQuad,
        observed.representation.renderedLayoutQuad,
      ),
      toleranceCss: NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX,
    },
    movement: {
      canonicalRootDeltaLayout: { ...input.canonicalTargetDelta },
      expectedBrowserDeltaCss: { ...input.expectedBrowserDeltaCss },
      observedBrowserDeltaCssByPoint: input.observedBrowserDeltaCss.map((entry) => ({
        point: entry.point,
        x: entry.x,
        y: entry.y,
      })),
      rigidTranslation: input.rigid,
      minimumSatisfied: input.minimumOk,
    },
    interaction: {
      baseline: publicInteractionFromGeometry(baseline),
      observed: publicInteractionFromGeometry(observed),
    },
  };
}

export function evaluateNestedObjectOracle(
  input: NestedObjectOracleInput,
): NestedObjectOracleEvaluation {
  const diagnostics: DiagnosticRecord[] = [];
  const { baseline, observed } = input;
  const baselineGeometry = baseline.geometry;
  const observedGeometry = observed.geometry;

  if (
    input.targetId !== observedGeometry.representation.targetId ||
    input.witnessId !== observedGeometry.representation.witnessId ||
    input.layoutId !== observedGeometry.representation.layoutId ||
    input.targetId !== baselineGeometry.representation.targetId ||
    input.witnessId !== baselineGeometry.representation.witnessId ||
    input.layoutId !== baselineGeometry.representation.layoutId
  ) {
    return {
      checks: [
        { checkId: NESTED_OBJECT_PARENT_CHAIN_CHECK, passed: false },
        { checkId: NESTED_OBJECT_LOCAL_INVARIANT_CHECK, passed: false },
        { checkId: NESTED_OBJECT_WORLD_COMPOSITION_CHECK, passed: false },
        { checkId: NESTED_OBJECT_DELTA_CHECK, passed: false },
      ],
      requiredSourcesAgree: false,
      harnessInvalid: true,
      diagnostics: [
        createDiagnostic(
          'GEOMETRY_CHAIN_ID_MISMATCH',
          'The accepted baseline/observed nested geometry does not name the declared target/witness/Layout pair.',
        ),
      ],
      facts: null,
      primitiveFacts: malformedNestedObjectPrimitiveFacts(),
    };
  }

  // ADR 0014 R10 contract-shape preconditions: the baseline must be the
  // accepted pre-action authorization and the observed record must be a
  // post-action observation with no interaction authority. A wrong combination
  // makes the typed authority unusable (`HARNESS_BLOCKED`). The post-action
  // hit status/classification/descriptor/fingerprints are never consumed.
  const baselineShapeOk =
    baselineGeometry.interaction.phase === 'pre-action' &&
    baselineGeometry.interaction.purpose === 'authorize-native-action' &&
    baselineGeometry.interaction.authority === 'action' &&
    baselineGeometry.interaction.status === 'authorized';
  const observedShapeOk =
    observedGeometry.interaction.phase === 'post-action' &&
    observedGeometry.interaction.purpose === 'observe-authoritative-geometry' &&
    observedGeometry.interaction.authority === 'none';
  if (!baselineShapeOk || !observedShapeOk) {
    return {
      checks: [
        { checkId: NESTED_OBJECT_PARENT_CHAIN_CHECK, passed: false },
        { checkId: NESTED_OBJECT_LOCAL_INVARIANT_CHECK, passed: false },
        { checkId: NESTED_OBJECT_WORLD_COMPOSITION_CHECK, passed: false },
        { checkId: NESTED_OBJECT_DELTA_CHECK, passed: false },
      ],
      requiredSourcesAgree: false,
      harnessInvalid: true,
      diagnostics: [
        createDiagnostic(
          'UNUSABLE_EVIDENCE',
          'The nested baseline/observed typed authority does not carry the accepted pre-action authorization and post-action observation contract shape.',
        ),
      ],
      facts: null,
      primitiveFacts: malformedNestedObjectPrimitiveFacts(),
    };
  }

  const cameraBaseline = cameraAgreementPasses(evaluateNestedCameraAgreementV3(baselineGeometry));
  const cameraObserved = cameraAgreementPasses(evaluateNestedCameraAgreementV3(observedGeometry));
  const cameraAgreement = cameraBaseline && cameraObserved;

  const chainInvariant = chainShapesEqual(
    chainShape(baselineGeometry),
    chainShape(observedGeometry),
  );
  const normalizedBefore = baselineGeometry.normalization.fixedPoint === true;
  const normalizedAfter = observedGeometry.normalization.fixedPoint === true;
  const localFrames = localFramesEqual(baselineGeometry, observedGeometry);
  const baselineSubtree = normalizedNestedSubtree(
    baseline.layoutItems,
    input.layoutId,
    input.targetId,
  );
  const observedSubtree = normalizedNestedSubtree(
    observed.layoutItems,
    input.layoutId,
    input.targetId,
  );
  const subtreeInvariant =
    baselineSubtree !== null && observedSubtree !== null && baselineSubtree === observedSubtree;
  // ADR 0015 B11: strict descendant equality is only meaningful after the
  // actual product normalization fixed point holds before and after capture.
  const localInvariant = normalizedBefore && normalizedAfter && localFrames && subtreeInvariant;

  const worldComposition =
    quadsAgreeWithin(
      baselineGeometry.representation.canonicalLayoutQuad,
      baselineGeometry.representation.renderedLayoutQuad,
      NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX,
    ) &&
    quadsAgreeWithin(
      observedGeometry.representation.canonicalLayoutQuad,
      observedGeometry.representation.renderedLayoutQuad,
      NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX,
    );

  // Actual canonical target delta, from the independently parsed chain.
  const baselineTarget =
    baselineGeometry.representation.canonicalChain[
      baselineGeometry.representation.canonicalChain.length - 1
    ];
  const observedTarget =
    observedGeometry.representation.canonicalChain[
      observedGeometry.representation.canonicalChain.length - 1
    ];
  const canonicalTargetDelta = {
    x: observedTarget.persistedFrame.x - baselineTarget.persistedFrame.x,
    y: observedTarget.persistedFrame.y - baselineTarget.persistedFrame.y,
  };
  const expectedBrowserDeltaCss = browserDeltaFromLayoutDelta(
    observedGeometry,
    canonicalTargetDelta,
  );

  const observedBrowserDeltaCss = observedGeometry.representation.renderedBrowserClientCssQuad.map(
    (point, index) => {
      const before = baselineGeometry.representation.renderedBrowserClientCssQuad[index];
      return {
        point: (observedGeometry.representation.pointOrder[index] ?? `point-${index}`) as string,
        x: point.x - before.x,
        y: point.y - before.y,
      };
    },
  );

  const tolerance = NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX;
  const minimumOk = observedBrowserDeltaCss.every(
    (delta) =>
      Math.abs(delta.x) >= input.minimumDelta.x && Math.abs(delta.y) >= input.minimumDelta.y,
  );
  const expectedOk = observedBrowserDeltaCss.every(
    (delta) =>
      Math.abs(delta.x - expectedBrowserDeltaCss.x) <= tolerance &&
      Math.abs(delta.y - expectedBrowserDeltaCss.y) <= tolerance,
  );
  const rigid =
    observedBrowserDeltaCss.length > 0 &&
    observedBrowserDeltaCss.every(
      (delta) =>
        Math.abs(delta.x - (observedBrowserDeltaCss[0]?.x ?? 0)) <= tolerance &&
        Math.abs(delta.y - (observedBrowserDeltaCss[0]?.y ?? 0)) <= tolerance,
    );
  const targetTranslationOk =
    rigid &&
    Math.abs((observedBrowserDeltaCss[0]?.x ?? 0) - expectedBrowserDeltaCss.x) <= tolerance &&
    Math.abs((observedBrowserDeltaCss[0]?.y ?? 0) - expectedBrowserDeltaCss.y) <= tolerance;
  const axisSignOk =
    Math.sign(canonicalTargetDelta.x) === Math.sign(expectedBrowserDeltaCss.x || 1) ||
    canonicalTargetDelta.x !== 0;
  const deltaPassed =
    minimumOk &&
    expectedOk &&
    targetTranslationOk &&
    Math.abs(canonicalTargetDelta.x) > EPSILON &&
    Math.abs(canonicalTargetDelta.y) > EPSILON;

  const checks: LegacyCompositeCheck[] = [
    { checkId: NESTED_OBJECT_PARENT_CHAIN_CHECK, passed: chainInvariant },
    { checkId: NESTED_OBJECT_LOCAL_INVARIANT_CHECK, passed: localInvariant },
    { checkId: NESTED_OBJECT_WORLD_COMPOSITION_CHECK, passed: worldComposition },
    { checkId: NESTED_OBJECT_DELTA_CHECK, passed: deltaPassed },
  ];

  if (!chainInvariant) {
    diagnostics.push(
      createDiagnostic(
        'GEOMETRY_CHAIN_INVALID',
        'The nested target/witness/Layout chain ids, order, or parentage changed across the accepted observation.',
      ),
    );
  }
  if (!localInvariant) {
    diagnostics.push(
      createDiagnostic(
        'GEOMETRY_LOCAL_INVARIANT_FAILED',
        'A descendant Object/Text parent-local coordinate, dimension, rotation, flip, content/style/warp, order, z-order, or parentage changed across the accepted observation.',
      ),
    );
  }
  if (!worldComposition) {
    diagnostics.push(
      createDiagnostic(
        'GEOMETRY_WORLD_COMPOSITION_FAILED',
        'Canonical and live corresponding witness points disagree beyond the accepted render tolerance.',
      ),
    );
  }
  if (!deltaPassed) {
    diagnostics.push(
      createDiagnostic(
        'UNUSABLE_EVIDENCE',
        `Nested movement did not meet the required delta: minimum=${minimumOk}, expectedProjection=${expectedOk}, rigidTranslation=${targetTranslationOk}, canonicalDelta=(${canonicalTargetDelta.x}, ${canonicalTargetDelta.y}).`,
      ),
    );
  }
  if (!cameraAgreement) {
    diagnostics.push(
      createDiagnostic(
        'GEOMETRY_CAMERA_MISMATCH',
        'Canonical camera intent does not agree with the live Stage matrix in the accepted observation.',
      ),
    );
  }
  void axisSignOk;

  const facts: NestedObjectOracleFacts = {
    targetId: input.targetId,
    witnessId: input.witnessId,
    layoutId: input.layoutId,
    parentChain: [
      ...observedGeometry.representation.canonicalChain.map((segment) => segment.id),
      input.layoutId,
    ],
    requestedPointerDeltaCss: input.requestedPointerDeltaCss,
    canonicalTargetDelta,
    expectedBrowserDeltaCss,
    observedBrowserDeltaCss,
    localInvariant,
    chainInvariant,
    worldComposition,
    cameraAgreement,
    objectGeometry: buildObjectGeometryProjection({
      baseline: baselineGeometry,
      observed: observedGeometry,
      canonicalTargetDelta,
      expectedBrowserDeltaCss,
      observedBrowserDeltaCss,
      minimumOk,
      rigid,
    }),
  };

  return {
    checks,
    requiredSourcesAgree: worldComposition,
    harnessInvalid: !cameraAgreement,
    diagnostics,
    facts,
    primitiveFacts: {
      authority: cameraAgreement ? 'current' : 'malformed',
      sourcesAgree: worldComposition,
      checks: [
        { checkId: NESTED_OBJECT_PARENT_CHAIN_CHECK, predicateMet: chainInvariant },
        { checkId: NESTED_OBJECT_LOCAL_INVARIANT_CHECK, predicateMet: localInvariant },
        { checkId: NESTED_OBJECT_WORLD_COMPOSITION_CHECK, predicateMet: worldComposition },
        { checkId: NESTED_OBJECT_DELTA_CHECK, predicateMet: deltaPassed },
      ],
    },
  };
}
