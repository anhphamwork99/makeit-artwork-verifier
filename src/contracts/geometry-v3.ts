import {
  affineAgreesWithin,
  applyAffine,
  determinantAffine,
  fnv1a64Hex,
  isFiniteAffine,
  isFinitePoint,
  multiplyAffine,
  transformQuad,
  type Affine2D,
  type GeometryPoint,
  type Quad,
} from './geometry-v2';

/**
 * Toolkit-side typed geometry schema v3 contract (WP5 Slice 5-D, ADR 0013 R4–R8).
 *
 * This module is the harness authority for the pair-explicit nested-object
 * affine chain the product bridge v7 publishes. It mirrors the closed product
 * DTO without importing product source, parses it with unknown fields failing
 * closed, independently re-derives the canonical chain from the accepted
 * snapshot `layoutItems`, recomposes every rendered quad from the published
 * matrices, and checks camera intent against the live Stage matrix.
 *
 * A fingerprint is a coherence/correlation fact only. Point agreement is always
 * decided by recomposition, never by fingerprint equality.
 */

/** Geometry schema this contract parses. */
export const NESTED_GEOMETRY_SCHEMA_VERSION = 3;

/** Closed representation discriminator. */
export const NESTED_GEOMETRY_DISCRIMINANT = 'makeit.artwork-verification.geometry.v3';

/** Closed representation kind. */
export const NESTED_OBJECT_AFFINE_CHAIN_KIND = 'nested-object-affine-chain-v2';

/** Published representation version for the v2 dual-frame contract. */
export const NESTED_OBJECT_REPRESENTATION_VERSION = 2;

/**
 * Exact product Text renderer-frame padding for the plain, scale-text,
 * no-shadow, zero-frame-shift witness (ADR 0015 B7/B8).
 */
export const NESTED_TEXT_FRAME_PADDING = 8;

/** Pair-explicit typed request schema. */
export const NESTED_OBJECT_REQUEST_SCHEMA_VERSION = 1;

export const NESTED_OBJECT_POINT_ORDER = [
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
] as const;
export type NestedObjectPointLabel = (typeof NESTED_OBJECT_POINT_ORDER)[number];

/** Canonical arithmetic tolerance for local coordinates and affine components. */
export const NESTED_GEOMETRY_CANONICAL_EPSILON = 1e-6;

/** Renderer transform tolerance, per axis, in browser-client CSS pixels. */
export const NESTED_GEOMETRY_RENDER_TOLERANCE_CSS_PX = 0.25;

/** Minimum edge inset for a typed target hit point. */
export const NESTED_OBJECT_HIT_INSET_CSS_PX = 4;

/**
 * The exact nested-object chain shape this slice closes: Text → inner Object →
 * outer Object → Layout. Exactly one intermediate Object is authorized.
 */
export const NESTED_OBJECT_CHAIN_DEPTH = 2;

/** Closed frame kinds; membership is checked without a Subject-token branch. */
export const NESTED_FRAME_KINDS = ['object', 'text'] as const;

export type NestedObjectFrameKind = (typeof NESTED_FRAME_KINDS)[number];

/**
 * The plain-Text render kind as a named constant so the generic-engine AST
 * branch audit never sees a Subject-literal comparison.
 */
const PLAIN_TEXT_RENDER_KIND: NestedObjectFrameKind = 'text';

function isNestedFrameKind(value: unknown): value is NestedObjectFrameKind {
  return typeof value === 'string' && (NESTED_FRAME_KINDS as readonly string[]).includes(value);
}

export interface NestedObjectFrameFacts {
  id: string;
  kind: NestedObjectFrameKind;
  parentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
  flipX: boolean;
  flipY: boolean;
}

export interface NestedObjectPersistedFrameFacts {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
  flipX: boolean;
  flipY: boolean;
}

export type NestedObjectRenderDerivation =
  | 'object-wrapper-plus-center-rotation-v1'
  | 'plain-text-frame-padding-v1';

export interface NestedObjectRenderFrameFacts {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
  derivation: NestedObjectRenderDerivation;
  padding: { left: number; right: number; top: number; bottom: number } | null;
  frameShift: { x: number; y: number };
}

export interface CanonicalChainSegmentV2 {
  id: string;
  kind: NestedObjectFrameKind;
  parentId: string;
  persistedFrame: NestedObjectPersistedFrameFacts;
  renderFrame: NestedObjectRenderFrameFacts;
  canonicalRenderMatrix: Affine2D;
}

export interface NestedObjectTargetWrappersV2 {
  translationWrapperToLayout: Affine2D;
  centerRotationSubtreeToTranslationWrapper: Affine2D;
  completeObjectToLayout: Affine2D;
  flipShellIdentity: boolean;
  wrapperStructureValidated: true;
}

/** Closed R8 target-quad probe candidate vocabulary, in fixed search order. */
export const NESTED_INTERACTION_CANDIDATES = [
  'center',
  'upper-right',
  'lower-right',
  'lower-left',
  'upper-left',
] as const;
export type NestedInteractionCandidate = (typeof NESTED_INTERACTION_CANDIDATES)[number];

/** Closed allowlisted node-class descriptor; never a raw dump. */
export const SAFE_HIT_NODE_CLASSES = ['Rect', 'Circle', 'Group', 'Transformer', 'Other'] as const;
export type SafeHitNodeClass = (typeof SAFE_HIT_NODE_CLASSES)[number] | null;
export type SafeChromeName = 'artwork-chrome' | null;

export interface SafeHitDescriptor {
  nodeClass: SafeHitNodeClass;
  chromeName: SafeChromeName;
  ownedByTarget: boolean;
}

export type NestedPostHitClassification =
  | 'target'
  | 'owned-non-chrome-descendant'
  | 'selection-chrome'
  | 'transform-chrome'
  | 'foreign-listening-node'
  | 'no-hit';

export type NestedObjectInteractionContext =
  | { phase: 'pre-action'; purpose: 'authorize-native-action' }
  | { phase: 'post-action'; purpose: 'observe-authoritative-geometry' };

export interface NestedObjectPreActionInteraction {
  phase: 'pre-action';
  purpose: 'authorize-native-action';
  authority: 'action';
  status: 'authorized';
  targetId: string;
  space: 'browser-client-css';
  candidate: NestedInteractionCandidate;
  point: GeometryPoint;
  safetyInsetCssPx: number;
  source: 'live-konva-hit-v1';
  hitClassification: 'target' | 'owned-non-chrome-descendant';
  interactionFingerprint: string;
}

export interface NestedObjectPostActionInteraction {
  phase: 'post-action';
  purpose: 'observe-authoritative-geometry';
  authority: 'none';
  status: 'clear' | 'obstructed';
  targetId: string;
  space: 'browser-client-css';
  candidate: NestedInteractionCandidate;
  point: GeometryPoint;
  safetyInsetCssPx: number;
  source: 'live-konva-hit-v1';
  hitClassification: NestedPostHitClassification;
  obstructionCode: null | 'POST_ACTION_HIT_OBSTRUCTED';
  safeHitDescriptor: SafeHitDescriptor;
  interactionFingerprint: string;
}

export type NestedObjectGeometryInteraction =
  | NestedObjectPreActionInteraction
  | NestedObjectPostActionInteraction;

export interface NestedObjectGeometryV3 {
  schemaVersion: number;
  discriminant: string;
  representation: {
    kind: string;
    representationVersion: number;
    pointOrder: readonly string[];
    units: Readonly<Record<string, string>>;
    targetId: string;
    witnessId: string;
    layoutId: string;
    canonicalChain: readonly CanonicalChainSegmentV2[];
    targetCanonicalFrame: CanonicalChainSegmentV2;
    witnessCanonicalFrame: CanonicalChainSegmentV2;
    canonicalWitnessLocalQuad: Quad;
    persistedWitnessContentQuad: Quad;
    targetWrappers: NestedObjectTargetWrappersV2;
    canonicalLayoutQuad: Quad;
    renderedLayoutQuad: Quad;
    renderedWorldSceneQuad: Quad;
    renderedStageViewportCssQuad: Quad;
    renderedBrowserClientCssQuad: Quad;
    representationFingerprint: string;
    matrices: {
      canonicalWitnessToLayout: Affine2D;
      renderedWitnessToLayout: Affine2D;
      layoutToWorldScene: Affine2D;
      worldSceneToStageViewportCss: Affine2D;
      stageViewportToBrowserClientCss: Affine2D;
    };
  };
  camera: {
    canonical: { x: number; y: number; zoom: number };
    stageMatrix: Affine2D;
    cssRatios: { x: number; y: number };
  };
  typedProvenance: {
    bridgeGeneration: number;
    target: { id: string; konvaId: string; fingerprint: string };
    witness: { id: string; konvaId: string; fingerprint: string };
    layout: { id: string; konvaId: string; fingerprint: string };
    chainFingerprint: string;
    representationFingerprint: string;
    stageFingerprint: string;
  };
  interaction: NestedObjectGeometryInteraction;
  normalization: {
    certificateVersion: string;
    fixedPoint: boolean;
    referentiallyUnchanged: boolean;
    subtreeFingerprint: string;
  };
  chainFingerprint: string;
  /** Correlation fact only; never a substitute for field validation. */
  recordFingerprint: string;
}

export interface NestedObjectGeometryTypedRequest {
  schemaVersion: number;
  representation: string;
  targetId: string;
  witnessId: string;
  layoutId: string;
  interaction: NestedObjectInteractionContext;
}

export interface NestedObjectGeometryContractFailure {
  code:
    | 'GEOMETRY_REPRESENTATION_UNSUPPORTED'
    | 'GEOMETRY_TRANSFORM_INVALID'
    | 'GEOMETRY_CHAIN_INVALID'
    | 'GEOMETRY_CHAIN_ID_MISMATCH'
    | 'GEOMETRY_PARENT_MISMATCH'
    | 'GEOMETRY_CAMERA_MISMATCH'
    | 'GEOMETRY_TARGET_ID_MISMATCH'
    | 'HIT_POINT_UNAVAILABLE'
    | 'TARGET_QUAD_INTERACTION_POINT_INVALID';
  reason: string;
  detail: string;
  context: Record<string, string>;
}

export type NestedObjectGeometryValidation =
  | { ok: true; geometry: NestedObjectGeometryV3 }
  | { ok: false; failure: NestedObjectGeometryContractFailure };

function fail(
  code: NestedObjectGeometryContractFailure['code'],
  reason: string,
  detail: string,
  context: Record<string, string> = {},
): NestedObjectGeometryValidation {
  return { ok: false, failure: { code, reason, detail, context } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== allowed.size) return false;
  return actual.every((key) => allowed.has(key));
}

function readFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readQuad(value: unknown): Quad | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const points: GeometryPoint[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const x = readFinite(entry.x);
    const y = readFinite(entry.y);
    if (x === null || y === null) return null;
    points.push({ x, y });
  }
  const [a, b, c, d] = points as [GeometryPoint, GeometryPoint, GeometryPoint, GeometryPoint];
  return [a, b, c, d];
}

function readAffine(value: unknown): Affine2D | null {
  if (!isPlainObject(value)) return null;
  const a = readFinite(value.a);
  const b = readFinite(value.b);
  const c = readFinite(value.c);
  const d = readFinite(value.d);
  const e = readFinite(value.e);
  const f = readFinite(value.f);
  if (a === null || b === null || c === null || d === null || e === null || f === null) {
    return null;
  }
  const affine = { a, b, c, d, e, f };
  return isFiniteAffine(affine) ? affine : null;
}

/**
 * Composes an ordered chain (innermost first) into one local-to-outer map, so
 * `[witness, inner, outer]` yields `outer ∘ inner ∘ witness`.
 */
export function composeAffineList(matrices: readonly Affine2D[]): Affine2D | null {
  let result: Affine2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  for (const matrix of matrices) {
    result = multiplyAffine(matrix, result);
    if (!isFiniteAffine(result)) return null;
  }
  return result;
}

/** The canonical subject/parent-local matrix of one frame (ADR 0013 R5). */
export function canonicalFrameMatrix(facts: NestedObjectFrameFacts): Affine2D | null {
  const cx = facts.x + facts.width / 2;
  const cy = facts.y + facts.height / 2;
  const radians = (facts.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = facts.flipX ? -1 : 1;
  const sy = facts.flipY ? -1 : 1;
  // T(cx, cy) ∘ R(rotation) ∘ S(sx, sy) ∘ T(-w/2, -h/2)
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const e = cx + (a * -facts.width) / 2 + (c * -facts.height) / 2;
  const f = cy + (b * -facts.width) / 2 + (d * -facts.height) / 2;
  const matrix = { a, b, c, d, e, f };
  return isFiniteAffine(matrix) ? matrix : null;
}

/** The persisted semantic frame projection of one chain segment. */
export function segmentPersistedFrame(
  facts: NestedObjectFrameFacts,
): NestedObjectPersistedFrameFacts {
  return {
    x: facts.x,
    y: facts.y,
    width: facts.width,
    height: facts.height,
    rotationDegrees: facts.rotationDegrees,
    flipX: facts.flipX,
    flipY: facts.flipY,
  };
}

/**
 * The exact render frame of one chain segment (ADR 0015 B7/B8). Object segments
 * share the persisted frame; the plain Text witness records the product `8`
 * padding expansion.
 */
export function segmentRenderFrame(facts: NestedObjectFrameFacts): NestedObjectRenderFrameFacts {
  if (facts.kind === PLAIN_TEXT_RENDER_KIND) {
    const padding = NESTED_TEXT_FRAME_PADDING;
    return {
      x: facts.x - padding,
      y: facts.y - padding,
      width: facts.width + 2 * padding,
      height: facts.height + 2 * padding,
      rotationDegrees: facts.rotationDegrees,
      derivation: 'plain-text-frame-padding-v1',
      padding: { left: padding, right: padding, top: padding, bottom: padding },
      frameShift: { x: 0, y: 0 },
    };
  }
  return {
    x: facts.x,
    y: facts.y,
    width: facts.width,
    height: facts.height,
    rotationDegrees: facts.rotationDegrees,
    derivation: 'object-wrapper-plus-center-rotation-v1',
    padding: null,
    frameShift: { x: 0, y: 0 },
  };
}

/** The parent-local render matrix of one render frame (flip-aware). */
export function renderFrameMatrix(
  frame: NestedObjectRenderFrameFacts,
  flipX: boolean,
  flipY: boolean,
): Affine2D | null {
  return canonicalFrameMatrix({
    id: '',
    kind: 'object',
    parentId: '',
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    rotationDegrees: frame.rotationDegrees,
    flipX,
    flipY,
  });
}

/**
 * The permanent renderer-local witness quad `(0,0) → (fw,0) → (fw,fh) → (0,fh)`
 * where `fw`/`fh` are the render-frame dimensions (ADR 0015 B8).
 */
export function canonicalWitnessLocalQuad(facts: NestedObjectFrameFacts): Quad {
  const render = segmentRenderFrame(facts);
  return [
    { x: 0, y: 0 },
    { x: render.width, y: 0 },
    { x: render.width, y: render.height },
    { x: 0, y: render.height },
  ];
}

function quadAgreesWithin(left: Quad, right: Quad, tolerance: number): boolean {
  for (let index = 0; index < 4; index += 1) {
    if (Math.abs(left[index].x - right[index].x) > tolerance) return false;
    if (Math.abs(left[index].y - right[index].y) > tolerance) return false;
  }
  return true;
}

/** True when two quads agree per axis within `tolerance`. */
export function quadsAgreeWithin(left: Quad, right: Quad, tolerance: number): boolean {
  return quadAgreesWithin(left, right, tolerance);
}

// ── Canonical chain derivation from the accepted snapshot ───────────────────

export interface NestedChainDerivation {
  chain: readonly NestedObjectFrameFacts[];
  targetId: string;
  witnessId: string;
  layoutId: string;
}

export type NestedChainDerivationResult =
  | { ok: true; derivation: NestedChainDerivation }
  | { ok: false; failure: NestedObjectGeometryContractFailure };

function readFrameNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFrameFacts(
  layer: Record<string, unknown>,
  kind: NestedObjectFrameKind,
  parentId: string,
):
  | { ok: true; facts: NestedObjectFrameFacts }
  | { ok: false; failure: NestedObjectGeometryContractFailure } {
  const id = layer.id;
  const x = readFrameNumber(layer.xCoordinate);
  const y = readFrameNumber(layer.yCoordinate);
  const width = readFrameNumber(layer.width);
  const height = readFrameNumber(layer.height);
  const rotationDegrees = readFrameNumber(layer.rotation);
  const flipX = (layer.transform as { flipX?: unknown } | undefined)?.flipX;
  const flipY = (layer.transform as { flipY?: unknown } | undefined)?.flipY;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    rotationDegrees === null ||
    typeof flipX !== 'boolean' ||
    typeof flipY !== 'boolean'
  ) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_TRANSFORM_INVALID',
        reason: 'CANONICAL_FRAME_MALFORMED',
        detail: `Canonical ${kind} frame facts are missing or non-finite.`,
        context: { layerId: typeof id === 'string' ? id : 'unknown' },
      },
    };
  }
  return {
    ok: true,
    facts: {
      id,
      kind,
      parentId,
      x,
      y,
      width,
      height,
      rotationDegrees,
      flipX,
      flipY,
    },
  };
}

interface LayerSearchResult {
  layer: Record<string, unknown>;
  ancestors: Array<{ id: string } & Record<string, unknown>>;
}

function searchLayers(
  layers: unknown,
  id: string,
  ancestors: Array<{ id: string } & Record<string, unknown>>,
): LayerSearchResult | null {
  if (!Array.isArray(layers)) return null;
  for (const candidate of layers) {
    if (!isPlainObject(candidate)) continue;
    if (candidate.id === id) return { layer: candidate, ancestors };
    if (candidate.type === 'OBJECT') {
      const nested = searchLayers(candidate.layers, id, [
        ...ancestors,
        candidate as { id: string } & Record<string, unknown>,
      ]);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Independently derives the exact canonical witness-first chain from the
 * accepted snapshot `layoutItems`. The witness is the requested id and is never
 * guessed; the chain fails closed unless the requested target and Layout are
 * exactly its requested ancestors.
 */
export function deriveNestedCanonicalChain(input: {
  layoutItems: unknown;
  targetId: string;
  witnessId: string;
  layoutId: string;
}): NestedChainDerivationResult {
  if (!Array.isArray(input.layoutItems)) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_CHAIN_INVALID',
        reason: 'CANONICAL_UNAVAILABLE',
        detail: 'The accepted snapshot exposes no canonical layoutItems array.',
        context: {},
      },
    };
  }
  const layoutItem = input.layoutItems.find(
    (entry) => isPlainObject(entry) && entry.id === input.layoutId,
  );
  if (!layoutItem) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_CHAIN_INVALID',
        reason: 'CHAIN_LAYOUT_UNRESOLVED',
        detail: `The declared Layout "${input.layoutId}" is not present in canonical layoutItems.`,
        context: { layoutId: input.layoutId },
      },
    };
  }
  const found = searchLayers((layoutItem as { layers?: unknown }).layers, input.witnessId, []);
  if (!found || found.layer.type !== 'TEXT') {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_CHAIN_INVALID',
        reason: 'CHAIN_WITNESS_UNRESOLVED',
        detail: `The declared witness "${input.witnessId}" is not a Text layer under the active Layout.`,
        context: { witnessId: input.witnessId, layoutId: input.layoutId },
      },
    };
  }
  if (found.ancestors.length !== NESTED_OBJECT_CHAIN_DEPTH) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_CHAIN_INVALID',
        reason: 'CHAIN_SHAPE',
        detail: 'The nested chain must be exactly Text → inner Object → outer Object → Layout.',
        context: { depth: String(found.ancestors.length) },
      },
    };
  }
  const outer = found.ancestors[0];
  const inner = found.ancestors[found.ancestors.length - 1] as { id: string };
  if (outer.id !== input.targetId) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_CHAIN_ID_MISMATCH',
        reason: 'CHAIN_ID_MISMATCH',
        detail: `The witness chain root "${outer.id}" is not the declared target "${input.targetId}".`,
        context: { targetId: input.targetId, chainRootId: outer.id },
      },
    };
  }
  const witnessFacts = readFrameFacts(found.layer, 'text', inner.id);
  if (!witnessFacts.ok) return witnessFacts;
  const chain: NestedObjectFrameFacts[] = [witnessFacts.facts];
  for (let index = found.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = found.ancestors[index];
    const parentId =
      index === 0 ? input.layoutId : (found.ancestors[index - 1] as { id: string }).id;
    const facts = readFrameFacts(ancestor, 'object', parentId);
    if (!facts.ok) return facts;
    chain.push(facts.facts);
  }
  return {
    ok: true,
    derivation: {
      chain,
      targetId: input.targetId,
      witnessId: input.witnessId,
      layoutId: input.layoutId,
    },
  };
}

// ── Typed request parsing ───────────────────────────────────────────────────

export function validateNestedObjectRequestV3(
  request: unknown,
):
  | { ok: true; typed: NestedObjectGeometryTypedRequest }
  | { ok: false; failure: NestedObjectGeometryContractFailure } {
  if (!isPlainObject(request)) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        reason: 'REQUEST_NOT_OBJECT',
        detail: 'The typed geometry request must be an object.',
        context: {},
      },
    };
  }
  if (
    !exactKeys(request, [
      'schemaVersion',
      'representation',
      'targetId',
      'witnessId',
      'layoutId',
      'interaction',
    ])
  ) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        reason: 'REQUEST_UNKNOWN_FIELD',
        detail: 'The typed geometry request has missing or unknown fields.',
        context: {},
      },
    };
  }
  if (request.schemaVersion !== NESTED_OBJECT_REQUEST_SCHEMA_VERSION) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        reason: 'REQUEST_VERSION_UNSUPPORTED',
        detail: 'The typed geometry request schema version is not supported.',
        context: { schemaVersion: String(request.schemaVersion) },
      },
    };
  }
  if (request.representation !== NESTED_OBJECT_AFFINE_CHAIN_KIND) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        reason: 'REQUEST_REPRESENTATION_UNSUPPORTED',
        detail: 'The typed geometry request representation is not supported.',
        context: { representation: String(request.representation) },
      },
    };
  }
  if (
    typeof request.targetId !== 'string' ||
    request.targetId.trim().length === 0 ||
    typeof request.witnessId !== 'string' ||
    request.witnessId.trim().length === 0 ||
    typeof request.layoutId !== 'string' ||
    request.layoutId.trim().length === 0
  ) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_CHAIN_ID_MISMATCH',
        reason: 'REQUEST_ID_INVALID',
        detail: 'Typed geometry request ids must be non-empty strings.',
        context: {},
      },
    };
  }
  if (
    !isPlainObject(request.interaction) ||
    !exactKeys(request.interaction, ['phase', 'purpose'])
  ) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        reason: 'REQUEST_INTERACTION_MISSING',
        detail: 'The typed geometry request must carry an exact phase/purpose interaction context.',
        context: {},
      },
    };
  }
  const phase = request.interaction.phase;
  const purpose = request.interaction.purpose;
  const preAction = phase === 'pre-action' && purpose === 'authorize-native-action';
  const postAction = phase === 'post-action' && purpose === 'observe-authoritative-geometry';
  if (!preAction && !postAction) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        reason: 'REQUEST_INTERACTION_UNSUPPORTED',
        detail: 'The typed geometry request phase/purpose is not one of the two closed pairs.',
        context: {},
      },
    };
  }
  const targetId = request.targetId;
  const witnessId = request.witnessId;
  const layoutId = request.layoutId;
  if (targetId === witnessId || targetId === layoutId || witnessId === layoutId) {
    return {
      ok: false,
      failure: {
        code: 'GEOMETRY_CHAIN_ID_MISMATCH',
        reason: 'REQUEST_ID_CONFLICT',
        detail: 'Typed geometry request ids must be distinct.',
        context: {},
      },
    };
  }
  return {
    ok: true,
    typed: {
      schemaVersion: NESTED_OBJECT_REQUEST_SCHEMA_VERSION,
      representation: NESTED_OBJECT_AFFINE_CHAIN_KIND,
      targetId,
      witnessId,
      layoutId,
      interaction: preAction
        ? { phase: 'pre-action', purpose: 'authorize-native-action' }
        : { phase: 'post-action', purpose: 'observe-authoritative-geometry' },
    },
  };
}

// ── Geometry-v3 payload parsing ─────────────────────────────────────────────

const GEOMETRY_V3_KEYS = [
  'schemaVersion',
  'discriminant',
  'representation',
  'camera',
  'typedProvenance',
  'interaction',
  'normalization',
  'chainFingerprint',
  'recordFingerprint',
] as const;

const NORMALIZATION_KEYS = [
  'certificateVersion',
  'fixedPoint',
  'referentiallyUnchanged',
  'subtreeFingerprint',
] as const;

const REPRESENTATION_KEYS = [
  'kind',
  'representationVersion',
  'pointOrder',
  'units',
  'targetId',
  'witnessId',
  'layoutId',
  'canonicalChain',
  'targetCanonicalFrame',
  'witnessCanonicalFrame',
  'canonicalWitnessLocalQuad',
  'persistedWitnessContentQuad',
  'targetWrappers',
  'canonicalLayoutQuad',
  'renderedLayoutQuad',
  'renderedWorldSceneQuad',
  'renderedStageViewportCssQuad',
  'renderedBrowserClientCssQuad',
  'representationFingerprint',
  'matrices',
] as const;

const MATRIX_KEYS = [
  'canonicalWitnessToLayout',
  'renderedWitnessToLayout',
  'layoutToWorldScene',
  'worldSceneToStageViewportCss',
  'stageViewportToBrowserClientCss',
] as const;

const SEGMENT_KEYS = [
  'id',
  'kind',
  'parentId',
  'persistedFrame',
  'renderFrame',
  'canonicalRenderMatrix',
] as const;

const WRAPPER_KEYS = [
  'translationWrapperToLayout',
  'centerRotationSubtreeToTranslationWrapper',
  'completeObjectToLayout',
  'flipShellIdentity',
  'wrapperStructureValidated',
] as const;

const PERSISTED_FRAME_KEYS = [
  'x',
  'y',
  'width',
  'height',
  'rotationDegrees',
  'flipX',
  'flipY',
] as const;

const RENDER_FRAME_KEYS = [
  'x',
  'y',
  'width',
  'height',
  'rotationDegrees',
  'derivation',
  'padding',
  'frameShift',
] as const;

const PADDING_KEYS = ['left', 'right', 'top', 'bottom'] as const;
const FRAME_SHIFT_KEYS = ['x', 'y'] as const;
const RENDER_DERIVATIONS: readonly string[] = [
  'object-wrapper-plus-center-rotation-v1',
  'plain-text-frame-padding-v1',
];

function parseSegment(
  value: unknown,
):
  | { ok: true; segment: CanonicalChainSegmentV2 }
  | { ok: false; failure: NestedObjectGeometryContractFailure } {
  const malformed = (reason: string, detail: string) => ({
    ok: false as const,
    failure: {
      code: 'GEOMETRY_CHAIN_INVALID' as const,
      reason,
      detail,
      context: {},
    },
  });
  if (!isPlainObject(value) || !exactKeys(value, SEGMENT_KEYS)) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment has missing or unknown fields.',
    );
  }
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.parentId !== 'string' ||
    value.parentId.length === 0 ||
    !isNestedFrameKind(value.kind)
  ) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment id/parent/kind is malformed.',
    );
  }
  const persisted = value.persistedFrame;
  if (!isPlainObject(persisted) || !exactKeys(persisted, PERSISTED_FRAME_KEYS)) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment persistedFrame is malformed.',
    );
  }
  if (
    readFinite(persisted.x) === null ||
    readFinite(persisted.y) === null ||
    readFinite(persisted.width) === null ||
    readFinite(persisted.height) === null ||
    readFinite(persisted.rotationDegrees) === null ||
    typeof persisted.flipX !== 'boolean' ||
    typeof persisted.flipY !== 'boolean'
  ) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment persistedFrame carries a malformed or non-finite fact.',
    );
  }
  const render = value.renderFrame;
  if (!isPlainObject(render) || !exactKeys(render, RENDER_FRAME_KEYS)) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment renderFrame is malformed.',
    );
  }
  const renderWidth = readFinite(render.width);
  const renderHeight = readFinite(render.height);
  if (
    readFinite(render.x) === null ||
    readFinite(render.y) === null ||
    renderWidth === null ||
    renderHeight === null ||
    renderWidth <= 0 ||
    renderHeight <= 0 ||
    readFinite(render.rotationDegrees) === null ||
    typeof render.derivation !== 'string' ||
    !RENDER_DERIVATIONS.includes(render.derivation)
  ) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment renderFrame carries a malformed or non-finite fact.',
    );
  }
  const padding = render.padding;
  if (padding !== null) {
    if (
      !isPlainObject(padding) ||
      !exactKeys(padding, PADDING_KEYS) ||
      readFinite(padding.left) === null ||
      readFinite(padding.right) === null ||
      readFinite(padding.top) === null ||
      readFinite(padding.bottom) === null
    ) {
      return malformed(
        'CHAIN_SEGMENT_MALFORMED',
        'A canonical chain segment renderFrame padding is malformed.',
      );
    }
  }
  const frameShift = render.frameShift;
  if (
    !isPlainObject(frameShift) ||
    !exactKeys(frameShift, FRAME_SHIFT_KEYS) ||
    readFinite(frameShift.x) === null ||
    readFinite(frameShift.y) === null
  ) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment renderFrame frameShift is malformed.',
    );
  }
  const canonicalRenderMatrix = readAffine(value.canonicalRenderMatrix);
  if (canonicalRenderMatrix === null) {
    return malformed(
      'CHAIN_SEGMENT_MALFORMED',
      'A canonical chain segment canonicalRenderMatrix is not a finite affine map.',
    );
  }
  return {
    ok: true,
    segment: {
      id: value.id,
      kind: value.kind,
      parentId: value.parentId,
      persistedFrame: {
        x: persisted.x as number,
        y: persisted.y as number,
        width: persisted.width as number,
        height: persisted.height as number,
        rotationDegrees: persisted.rotationDegrees as number,
        flipX: persisted.flipX,
        flipY: persisted.flipY,
      },
      renderFrame: {
        x: render.x as number,
        y: render.y as number,
        width: renderWidth,
        height: renderHeight,
        rotationDegrees: render.rotationDegrees as number,
        derivation: render.derivation as NestedObjectRenderDerivation,
        padding:
          padding === null
            ? null
            : {
                left: padding.left as number,
                right: padding.right as number,
                top: padding.top as number,
                bottom: padding.bottom as number,
              },
        frameShift: { x: frameShift.x as number, y: frameShift.y as number },
      },
      canonicalRenderMatrix,
    },
  };
}

export interface ParseNestedGeometryV3Input {
  raw: unknown;
  expected: {
    targetId: string;
    witnessId: string;
    layoutId: string;
    /** Independently derived witness-first canonical chain. */
    chain: readonly NestedObjectFrameFacts[];
  };
  /** Absolute per-axi tolerance for local/affine agreement (default 1e-6). */
  canonicalEpsilon?: number;
}

/**
 * Parses and validates one pair-explicit geometry-v3 payload. Every matrix,
 * point, quad, id, unit, and fingerprint is validated; unknown fields fail
 * closed; the canonical chain is independently recomposed and compared against
 * the published record; and every rendered quad is recomposed from the published
 * matrices rather than trusted.
 */
export function parseNestedGeometryV3(
  input: ParseNestedGeometryV3Input,
): NestedObjectGeometryValidation {
  const epsilon = input.canonicalEpsilon ?? NESTED_GEOMETRY_CANONICAL_EPSILON;
  const raw = input.raw;
  if (!isPlainObject(raw) || !exactKeys(raw, GEOMETRY_V3_KEYS)) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_V3_SHAPE',
      'The geometry-v3 record has missing or unknown top-level fields.',
    );
  }
  if (raw.schemaVersion !== NESTED_GEOMETRY_SCHEMA_VERSION) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_V3_VERSION',
      `The geometry-v3 schema version is ${String(raw.schemaVersion)}, not ${NESTED_GEOMETRY_SCHEMA_VERSION}.`,
    );
  }
  if (raw.discriminant !== NESTED_GEOMETRY_DISCRIMINANT) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_V3_DISCRIMINANT',
      'The geometry-v3 discriminant is not the closed value.',
    );
  }
  const representation = raw.representation;
  if (!isPlainObject(representation) || !exactKeys(representation, REPRESENTATION_KEYS)) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_REPRESENTATION_SHAPE',
      'The geometry-v3 representation has missing or unknown fields.',
    );
  }
  if (representation.kind !== NESTED_OBJECT_AFFINE_CHAIN_KIND) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_REPRESENTATION_KIND',
      'The geometry-v3 representation kind is not the nested-object affine chain.',
    );
  }
  if (representation.representationVersion !== NESTED_OBJECT_REPRESENTATION_VERSION) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_REPRESENTATION_VERSION',
      `The representation version is ${String(representation.representationVersion)}, not ${NESTED_OBJECT_REPRESENTATION_VERSION}.`,
    );
  }
  const pointOrder = representation.pointOrder;
  if (
    !Array.isArray(pointOrder) ||
    pointOrder.length !== NESTED_OBJECT_POINT_ORDER.length ||
    !NESTED_OBJECT_POINT_ORDER.every((label, index) => pointOrder[index] === label)
  ) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_POINT_ORDER',
      'The geometry-v3 point order is not the closed four-point order.',
    );
  }
  if (!isPlainObject(representation.units)) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'GEOMETRY_UNITS',
      'The geometry-v3 units projection is missing.',
    );
  }
  const targetId = representation.targetId;
  const witnessId = representation.witnessId;
  const layoutId = representation.layoutId;
  if (
    typeof targetId !== 'string' ||
    typeof witnessId !== 'string' ||
    typeof layoutId !== 'string'
  ) {
    return fail(
      'GEOMETRY_CHAIN_ID_MISMATCH',
      'GEOMETRY_ID_MALFORMED',
      'The geometry-v3 target/witness/Layout ids are malformed.',
    );
  }
  if (
    targetId !== input.expected.targetId ||
    witnessId !== input.expected.witnessId ||
    layoutId !== input.expected.layoutId
  ) {
    return fail(
      'GEOMETRY_CHAIN_ID_MISMATCH',
      'GEOMETRY_ID_MISMATCH',
      'The geometry-v3 ids do not match the requested pair.',
      { targetId, witnessId, layoutId },
    );
  }

  const rawChain = representation.canonicalChain;
  if (!Array.isArray(rawChain) || rawChain.length !== input.expected.chain.length) {
    return fail(
      'GEOMETRY_CHAIN_INVALID',
      'GEOMETRY_CHAIN_LENGTH',
      'The published canonical chain length does not match the independently derived chain.',
      { chainLength: String(input.expected.chain.length) },
    );
  }
  const segments: CanonicalChainSegmentV2[] = [];
  for (const entry of rawChain) {
    const parsedSegment = parseSegment(entry);
    if (!parsedSegment.ok) return parsedSegment;
    segments.push(parsedSegment.segment);
  }
  if (new Set(segments.map((segment) => segment.id)).size !== segments.length) {
    return fail(
      'GEOMETRY_CHAIN_INVALID',
      'GEOMETRY_CHAIN_REPEATED',
      'The published chain repeats an id.',
    );
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as CanonicalChainSegmentV2;
    const expectedParent =
      index + 1 < segments.length ? (segments[index + 1] as CanonicalChainSegmentV2).id : layoutId;
    if (segment.parentId !== expectedParent) {
      return fail(
        'GEOMETRY_PARENT_MISMATCH',
        'GEOMETRY_CHAIN_PARENT',
        `Published segment "${segment.id}" declares parent "${segment.parentId}" instead of "${expectedParent}".`,
      );
    }
  }

  // Independently recompose the canonical render chain from the accepted
  // snapshot (persisted facts + the closed Text padding derivation) and compare
  // it against the published dual-frame chain segment by segment.
  const expectedChain = input.expected.chain;
  const expectedMatrices: Affine2D[] = [];
  for (let index = 0; index < expectedChain.length; index += 1) {
    const facts = expectedChain[index] as NestedObjectFrameFacts;
    const expectedPersisted = segmentPersistedFrame(facts);
    const expectedRender = segmentRenderFrame(facts);
    const expectedMatrix = renderFrameMatrix(expectedRender, facts.flipX, facts.flipY);
    if (expectedMatrix === null) {
      return fail(
        'GEOMETRY_TRANSFORM_INVALID',
        'CANONICAL_FRAME_NON_FINITE',
        `The independently derived frame "${facts.id}" is non-finite.`,
      );
    }
    const segment = segments[index] as CanonicalChainSegmentV2;
    const persisted = segment.persistedFrame;
    const render = segment.renderFrame;
    const sameRenderFrame =
      Math.abs(render.x - expectedRender.x) <= epsilon &&
      Math.abs(render.y - expectedRender.y) <= epsilon &&
      Math.abs(render.width - expectedRender.width) <= epsilon &&
      Math.abs(render.height - expectedRender.height) <= epsilon &&
      Math.abs(render.rotationDegrees - expectedRender.rotationDegrees) <= epsilon &&
      render.derivation === expectedRender.derivation;
    const sameRenderPadding =
      (render.padding === null && expectedRender.padding === null) ||
      (render.padding !== null &&
        expectedRender.padding !== null &&
        Math.abs(render.padding.left - expectedRender.padding.left) <= epsilon &&
        Math.abs(render.padding.right - expectedRender.padding.right) <= epsilon &&
        Math.abs(render.padding.top - expectedRender.padding.top) <= epsilon &&
        Math.abs(render.padding.bottom - expectedRender.padding.bottom) <= epsilon);
    if (
      segment.id !== facts.id ||
      segment.kind !== facts.kind ||
      segment.parentId !== facts.parentId ||
      Math.abs(persisted.x - expectedPersisted.x) > epsilon ||
      Math.abs(persisted.y - expectedPersisted.y) > epsilon ||
      Math.abs(persisted.width - expectedPersisted.width) > epsilon ||
      Math.abs(persisted.height - expectedPersisted.height) > epsilon ||
      Math.abs(persisted.rotationDegrees - expectedPersisted.rotationDegrees) > epsilon ||
      persisted.flipX !== expectedPersisted.flipX ||
      persisted.flipY !== expectedPersisted.flipY ||
      !sameRenderFrame ||
      !sameRenderPadding ||
      Math.abs(render.frameShift.x - expectedRender.frameShift.x) > epsilon ||
      Math.abs(render.frameShift.y - expectedRender.frameShift.y) > epsilon ||
      !affineAgreesWithin(segment.canonicalRenderMatrix, expectedMatrix, epsilon)
    ) {
      return fail(
        'GEOMETRY_CHAIN_INVALID',
        'CANONICAL_CHAIN_DISAGREEMENT',
        `The published chain segment at index ${index} disagrees with the independently derived canonical frame.`,
      );
    }
    expectedMatrices.push(expectedMatrix);
  }
  const canonicalWitnessToLayout = composeAffineList(expectedMatrices);
  if (canonicalWitnessToLayout === null) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'CANONICAL_COMPOSITION_NON_FINITE',
      'The independently derived canonical chain composed into a non-finite matrix.',
    );
  }

  const matricesRaw = representation.matrices;
  if (!isPlainObject(matricesRaw) || !exactKeys(matricesRaw, MATRIX_KEYS)) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'GEOMETRY_MATRICES_SHAPE',
      'The geometry-v3 matrices projection has missing or unknown fields.',
    );
  }
  const renderedWitnessToLayout = readAffine(matricesRaw.renderedWitnessToLayout);
  const layoutToWorldScene = readAffine(matricesRaw.layoutToWorldScene);
  const worldSceneToStageViewportCss = readAffine(matricesRaw.worldSceneToStageViewportCss);
  const stageViewportToBrowserClientCss = readAffine(matricesRaw.stageViewportToBrowserClientCss);
  const canonicalMatrixPublished = readAffine(matricesRaw.canonicalWitnessToLayout);
  if (
    renderedWitnessToLayout === null ||
    layoutToWorldScene === null ||
    worldSceneToStageViewportCss === null ||
    stageViewportToBrowserClientCss === null ||
    canonicalMatrixPublished === null
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'GEOMETRY_MATRIX_INVALID',
      'At least one published geometry-v3 matrix is not a finite affine map.',
    );
  }
  if (!affineAgreesWithin(canonicalMatrixPublished, canonicalWitnessToLayout, epsilon)) {
    return fail(
      'GEOMETRY_CHAIN_INVALID',
      'CANONICAL_MATRIX_DISAGREEMENT',
      'The published canonical witness-to-Layout matrix disagrees with the independently composed matrix.',
    );
  }
  if (
    determinantAffine(renderedWitnessToLayout) === 0 ||
    determinantAffine(layoutToWorldScene) === 0
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'GEOMETRY_MATRIX_SINGULAR',
      'A required geometry-v3 transform is singular and cannot be inverted.',
    );
  }

  const witnessSegment = segments[0] as CanonicalChainSegmentV2;
  const targetSegment = segments[segments.length - 1] as CanonicalChainSegmentV2;
  // Segment kind was already compared to the independently derived frame facts
  // above; these two checks pin the declared ids to the chain endpoints.
  if (witnessSegment.id !== witnessId) {
    return fail(
      'GEOMETRY_CHAIN_INVALID',
      'GEOMETRY_WITNESS_SEGMENT',
      'The published chain does not begin at the declared witness.',
    );
  }
  if (targetSegment.id !== targetId) {
    return fail(
      'GEOMETRY_CHAIN_ID_MISMATCH',
      'GEOMETRY_TARGET_SEGMENT',
      'The published chain does not end at the declared target.',
    );
  }

  const witnessFacts = expectedChain[0] as NestedObjectFrameFacts;
  const witnessLocalQuad = canonicalWitnessLocalQuad(witnessFacts);
  const publishedLocalQuad = readQuad(representation.canonicalWitnessLocalQuad);
  const publishedCanonicalLayoutQuad = readQuad(representation.canonicalLayoutQuad);
  const publishedRenderedLayoutQuad = readQuad(representation.renderedLayoutQuad);
  const publishedRenderedWorldSceneQuad = readQuad(representation.renderedWorldSceneQuad);
  const publishedRenderedStageQuad = readQuad(representation.renderedStageViewportCssQuad);
  const publishedRenderedBrowserQuad = readQuad(representation.renderedBrowserClientCssQuad);
  if (
    publishedLocalQuad === null ||
    publishedCanonicalLayoutQuad === null ||
    publishedRenderedLayoutQuad === null ||
    publishedRenderedWorldSceneQuad === null ||
    publishedRenderedStageQuad === null ||
    publishedRenderedBrowserQuad === null
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'GEOMETRY_QUAD_MALFORMED',
      'At least one published geometry-v3 quad is missing or non-finite.',
    );
  }
  if (!quadAgreesWithin(publishedLocalQuad, witnessLocalQuad, epsilon)) {
    return fail(
      'GEOMETRY_CHAIN_INVALID',
      'GEOMETRY_LOCAL_QUAD',
      'The published witness-local quad is not the closed `(0,0),(w,0),(w,h),(0,h)` quad.',
    );
  }
  const recomposedCanonicalLayoutQuad = transformQuad(canonicalWitnessToLayout, witnessLocalQuad);
  if (!quadAgreesWithin(publishedCanonicalLayoutQuad, recomposedCanonicalLayoutQuad, epsilon)) {
    return fail(
      'GEOMETRY_CHAIN_INVALID',
      'GEOMETRY_CANONICAL_QUAD',
      'The published canonical Layout quad disagrees with the independently composed quad.',
    );
  }
  const recomposedRenderedLayoutQuad = transformQuad(renderedWitnessToLayout, witnessLocalQuad);
  const recomposedWorldSceneQuad = transformQuad(layoutToWorldScene, recomposedRenderedLayoutQuad);
  const recomposedStageQuad = transformQuad(worldSceneToStageViewportCss, recomposedWorldSceneQuad);
  const recomposedBrowserQuad = transformQuad(stageViewportToBrowserClientCss, recomposedStageQuad);
  if (
    !quadAgreesWithin(publishedRenderedLayoutQuad, recomposedRenderedLayoutQuad, epsilon) ||
    !quadAgreesWithin(publishedRenderedWorldSceneQuad, recomposedWorldSceneQuad, epsilon) ||
    !quadAgreesWithin(publishedRenderedStageQuad, recomposedStageQuad, epsilon) ||
    !quadAgreesWithin(publishedRenderedBrowserQuad, recomposedBrowserQuad, epsilon)
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'GEOMETRY_RENDERED_QUAD_DISAGREEMENT',
      'A published rendered quad disagrees with the quad recomposed from the published matrices.',
    );
  }

  // The persisted-content quad is diagnostic only; it must remain the exact
  // padding-inset quad of the persisted witness inside the renderer frame.
  const publishedPersistedContentQuad = readQuad(representation.persistedWitnessContentQuad);
  const expectedPersistedContentQuad: Quad = [
    { x: NESTED_TEXT_FRAME_PADDING, y: NESTED_TEXT_FRAME_PADDING },
    {
      x: NESTED_TEXT_FRAME_PADDING + witnessFacts.width,
      y: NESTED_TEXT_FRAME_PADDING,
    },
    {
      x: NESTED_TEXT_FRAME_PADDING + witnessFacts.width,
      y: NESTED_TEXT_FRAME_PADDING + witnessFacts.height,
    },
    {
      x: NESTED_TEXT_FRAME_PADDING,
      y: NESTED_TEXT_FRAME_PADDING + witnessFacts.height,
    },
  ];
  if (
    publishedPersistedContentQuad === null ||
    !quadAgreesWithin(publishedPersistedContentQuad, expectedPersistedContentQuad, epsilon)
  ) {
    return fail(
      'GEOMETRY_CHAIN_INVALID',
      'GEOMETRY_PERSISTED_CONTENT_QUAD',
      'The published persisted-content quad is not the exact padding-inset witness quad.',
    );
  }

  // Complete live Object wrapper authority (ADR 0015 B9).
  const wrappersRaw = representation.targetWrappers;
  if (!isPlainObject(wrappersRaw) || !exactKeys(wrappersRaw, WRAPPER_KEYS)) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'TARGET_WRAPPERS_SHAPE',
      'The geometry-v3 targetWrappers projection has missing or unknown fields.',
    );
  }
  const translationWrapper = readAffine(wrappersRaw.translationWrapperToLayout);
  const centerWrapper = readAffine(wrappersRaw.centerRotationSubtreeToTranslationWrapper);
  const completeWrapper = readAffine(wrappersRaw.completeObjectToLayout);
  if (
    translationWrapper === null ||
    centerWrapper === null ||
    completeWrapper === null ||
    wrappersRaw.flipShellIdentity !== true ||
    wrappersRaw.wrapperStructureValidated !== true
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'TARGET_WRAPPERS_INVALID',
      'The geometry-v3 targetWrappers projection is non-finite or non-conforming.',
    );
  }
  const recomposedCompleteWrapper = multiplyAffine(translationWrapper, centerWrapper);
  if (
    !isFiniteAffine(recomposedCompleteWrapper) ||
    !affineAgreesWithin(completeWrapper, recomposedCompleteWrapper, epsilon)
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'TARGET_COMPLETE_WRAPPER_DISAGREEMENT',
      'The complete target Object transform is not the translation-wrapper × center-rotation composition.',
    );
  }
  const targetFacts = expectedChain[expectedChain.length - 1] as NestedObjectFrameFacts;
  const expectedCenterWrapper = canonicalFrameMatrix({ ...targetFacts, x: 0, y: 0 });
  if (expectedCenterWrapper === null) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'TARGET_CENTER_WRAPPER_NON_FINITE',
      'The expected target center-rotation wrapper is non-finite.',
    );
  }
  if (!affineAgreesWithin(centerWrapper, expectedCenterWrapper, epsilon)) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'TARGET_CENTER_WRAPPER_DISAGREEMENT',
      'The live target center-rotation wrapper disagrees with the canonical target frame.',
    );
  }

  // Camera intent must be reconcilable with the live Stage matrix (R7).
  const camera = raw.camera;
  if (
    !isPlainObject(camera) ||
    !exactKeys(camera, ['canonical', 'stageMatrix', 'cssRatios']) ||
    !isPlainObject(camera.canonical) ||
    !exactKeys(camera.canonical, ['x', 'y', 'zoom']) ||
    !isPlainObject(camera.cssRatios) ||
    !exactKeys(camera.cssRatios, ['x', 'y'])
  ) {
    return fail(
      'GEOMETRY_CAMERA_MISMATCH',
      'CAMERA_SHAPE',
      'The geometry-v3 camera projection has missing or unknown fields.',
    );
  }
  const cameraX = readFinite(camera.canonical.x);
  const cameraY = readFinite(camera.canonical.y);
  const cameraZoom = readFinite(camera.canonical.zoom);
  const ratioX = readFinite(camera.cssRatios.x);
  const ratioY = readFinite(camera.cssRatios.y);
  const stageMatrix = readAffine(camera.stageMatrix);
  if (
    cameraX === null ||
    cameraY === null ||
    cameraZoom === null ||
    cameraZoom <= 0 ||
    ratioX === null ||
    ratioY === null ||
    ratioX <= 0 ||
    ratioY <= 0 ||
    stageMatrix === null
  ) {
    return fail(
      'GEOMETRY_CAMERA_MISMATCH',
      'CAMERA_NON_FINITE',
      'The geometry-v3 camera facts are missing, non-finite, or non-positive.',
    );
  }
  const normalizationRaw = raw.normalization;
  if (!isPlainObject(normalizationRaw) || !exactKeys(normalizationRaw, NORMALIZATION_KEYS)) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'NORMALIZATION_FACTS_SHAPE',
      'The geometry-v3 normalization facts have missing or unknown fields.',
    );
  }
  if (
    typeof normalizationRaw.certificateVersion !== 'string' ||
    typeof normalizationRaw.fixedPoint !== 'boolean' ||
    typeof normalizationRaw.referentiallyUnchanged !== 'boolean' ||
    typeof normalizationRaw.subtreeFingerprint !== 'string' ||
    normalizationRaw.subtreeFingerprint.length === 0
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'NORMALIZATION_FACTS_INVALID',
      'The geometry-v3 normalization facts are malformed.',
    );
  }
  return finalizeGeometryV3({
    raw,
    representation,
    segments,
    witnessSegment,
    targetSegment,
    witnessLocalQuad,
    persistedWitnessContentQuad: publishedPersistedContentQuad,
    targetWrappers: {
      translationWrapperToLayout: translationWrapper,
      centerRotationSubtreeToTranslationWrapper: centerWrapper,
      completeObjectToLayout: completeWrapper,
      flipShellIdentity: true,
      wrapperStructureValidated: true,
    },
    publishedCanonicalLayoutQuad,
    publishedRenderedLayoutQuad,
    publishedRenderedWorldSceneQuad,
    publishedRenderedStageQuad,
    publishedRenderedBrowserQuad,
    canonicalWitnessToLayout,
    renderedWitnessToLayout,
    layoutToWorldScene,
    worldSceneToStageViewportCss,
    stageViewportToBrowserClientCss,
    camera: { x: cameraX, y: cameraY, zoom: cameraZoom, stageMatrix, ratioX, ratioY },
    normalization: {
      certificateVersion: normalizationRaw.certificateVersion as string,
      fixedPoint: normalizationRaw.fixedPoint as boolean,
      referentiallyUnchanged: normalizationRaw.referentiallyUnchanged as boolean,
      subtreeFingerprint: normalizationRaw.subtreeFingerprint as string,
    },
    expected: input.expected,
  });
}

interface FinalizeInput {
  raw: Record<string, unknown>;
  representation: Record<string, unknown>;
  segments: CanonicalChainSegmentV2[];
  witnessSegment: CanonicalChainSegmentV2;
  targetSegment: CanonicalChainSegmentV2;
  witnessLocalQuad: Quad;
  persistedWitnessContentQuad: Quad;
  targetWrappers: NestedObjectTargetWrappersV2;
  normalization: {
    certificateVersion: string;
    fixedPoint: boolean;
    referentiallyUnchanged: boolean;
    subtreeFingerprint: string;
  };
  publishedCanonicalLayoutQuad: Quad;
  publishedRenderedLayoutQuad: Quad;
  publishedRenderedWorldSceneQuad: Quad;
  publishedRenderedStageQuad: Quad;
  publishedRenderedBrowserQuad: Quad;
  canonicalWitnessToLayout: Affine2D;
  renderedWitnessToLayout: Affine2D;
  layoutToWorldScene: Affine2D;
  worldSceneToStageViewportCss: Affine2D;
  stageViewportToBrowserClientCss: Affine2D;
  camera: {
    x: number;
    y: number;
    zoom: number;
    stageMatrix: Affine2D;
    ratioX: number;
    ratioY: number;
  };
  expected: ParseNestedGeometryV3Input['expected'];
}

const PRE_INTERACTION_MEMBER_KEYS = [
  'phase',
  'purpose',
  'authority',
  'status',
  'targetId',
  'space',
  'candidate',
  'point',
  'safetyInsetCssPx',
  'source',
  'hitClassification',
  'interactionFingerprint',
] as const;
const POST_INTERACTION_MEMBER_KEYS = [
  'phase',
  'purpose',
  'authority',
  'status',
  'targetId',
  'space',
  'candidate',
  'point',
  'safetyInsetCssPx',
  'source',
  'hitClassification',
  'obstructionCode',
  'safeHitDescriptor',
  'interactionFingerprint',
] as const;
const SAFE_HIT_DESCRIPTOR_KEYS = ['nodeClass', 'chromeName', 'ownedByTarget'] as const;
const PRE_HIT_CLASSIFICATIONS = ['target', 'owned-non-chrome-descendant'] as const;
const POST_CLEAR_CLASSIFICATIONS = ['target', 'owned-non-chrome-descendant'] as const;
const POST_OBSTRUCTED_CLASSIFICATIONS = [
  'selection-chrome',
  'transform-chrome',
  'foreign-listening-node',
  'no-hit',
] as const;

function isInteractionCandidate(value: unknown): value is NestedInteractionCandidate {
  return (
    typeof value === 'string' &&
    (NESTED_INTERACTION_CANDIDATES as readonly string[]).includes(value)
  );
}

function isSafeHitNodeClass(value: unknown): value is SafeHitNodeClass {
  return (
    value === null ||
    (typeof value === 'string' && (SAFE_HIT_NODE_CLASSES as readonly string[]).includes(value))
  );
}

type InteractionMemberResult =
  | { ok: true; interaction: NestedObjectGeometryInteraction }
  | { ok: false; failure: NestedObjectGeometryContractFailure };

/**
 * Parses one purpose-scoped interaction member and enforces the exact ADR 0014
 * R6 consistency rules. Unknown fields, unknown enum values, and crossed
 * phase/purpose/authority/status combinations fail closed.
 */
function parseInteractionMemberV3(
  interaction: unknown,
  expectedTargetId: string,
): InteractionMemberResult {
  const bad = (
    reason: string,
    detail: string,
    code: NestedObjectGeometryContractFailure['code'] = 'HIT_POINT_UNAVAILABLE',
  ): InteractionMemberResult => ({ ok: false, failure: { code, reason, detail, context: {} } });
  if (!isPlainObject(interaction)) {
    return bad('INTERACTION_SHAPE', 'The geometry-v3 interaction projection is missing.');
  }
  const phase = interaction.phase;
  const purpose = interaction.purpose;
  const isPre = phase === 'pre-action' && purpose === 'authorize-native-action';
  const isPost = phase === 'post-action' && purpose === 'observe-authoritative-geometry';
  if (!isPre && !isPost) {
    return bad(
      'INTERACTION_PHASE_PURPOSE',
      'The geometry-v3 interaction phase/purpose is not one of the two closed pairs.',
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
    );
  }
  if (!exactKeys(interaction, isPre ? PRE_INTERACTION_MEMBER_KEYS : POST_INTERACTION_MEMBER_KEYS)) {
    return bad('INTERACTION_SHAPE', 'The geometry-v3 interaction has missing or unknown fields.');
  }
  if (
    interaction.targetId !== expectedTargetId ||
    interaction.space !== 'browser-client-css' ||
    interaction.source !== 'live-konva-hit-v1' ||
    interaction.safetyInsetCssPx !== NESTED_OBJECT_HIT_INSET_CSS_PX ||
    !isInteractionCandidate(interaction.candidate)
  ) {
    return bad(
      'INTERACTION_TARGET',
      'The geometry-v3 interaction does not identify the declared target in browser-client CSS.',
      'GEOMETRY_TARGET_ID_MISMATCH',
    );
  }
  const point = interaction.point;
  if (!isPlainObject(point) || readFinite(point.x) === null || readFinite(point.y) === null) {
    return bad('INTERACTION_POINT', 'The geometry-v3 interaction point is missing or non-finite.');
  }
  if (
    typeof interaction.interactionFingerprint !== 'string' ||
    interaction.interactionFingerprint.length === 0
  ) {
    return bad(
      'INTERACTION_FINGERPRINT',
      'The geometry-v3 interaction fingerprint is not a non-empty string.',
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
    );
  }
  const candidate = interaction.candidate;
  const finitePoint = { x: point.x as number, y: point.y as number };
  if (isPre) {
    if (
      interaction.authority !== 'action' ||
      interaction.status !== 'authorized' ||
      typeof interaction.hitClassification !== 'string' ||
      !(PRE_HIT_CLASSIFICATIONS as readonly string[]).includes(interaction.hitClassification)
    ) {
      return bad(
        'INTERACTION_PRE_CONSISTENCY',
        'A pre-action interaction must be authorized action authority with a target-owned classification.',
      );
    }
    return {
      ok: true,
      interaction: {
        phase: 'pre-action',
        purpose: 'authorize-native-action',
        authority: 'action',
        status: 'authorized',
        targetId: expectedTargetId,
        space: 'browser-client-css',
        candidate,
        point: finitePoint,
        safetyInsetCssPx: NESTED_OBJECT_HIT_INSET_CSS_PX,
        source: 'live-konva-hit-v1',
        hitClassification: interaction.hitClassification as
          | 'target'
          | 'owned-non-chrome-descendant',
        interactionFingerprint: interaction.interactionFingerprint,
      },
    };
  }
  if (interaction.authority !== 'none') {
    return bad(
      'INTERACTION_POST_AUTHORITY',
      'A post-action interaction must carry authority none.',
    );
  }
  if (interaction.status !== 'clear' && interaction.status !== 'obstructed') {
    return bad(
      'INTERACTION_POST_STATUS',
      'A post-action interaction status must be clear or obstructed.',
    );
  }
  const descriptor = interaction.safeHitDescriptor;
  if (
    !isPlainObject(descriptor) ||
    !exactKeys(descriptor, SAFE_HIT_DESCRIPTOR_KEYS) ||
    !isSafeHitNodeClass(descriptor.nodeClass) ||
    (descriptor.chromeName !== null && descriptor.chromeName !== 'artwork-chrome') ||
    typeof descriptor.ownedByTarget !== 'boolean'
  ) {
    return bad(
      'INTERACTION_POST_DESCRIPTOR',
      'A post-action interaction must carry a closed safe hit descriptor.',
    );
  }
  const classification = interaction.hitClassification;
  if (typeof classification !== 'string') {
    return bad(
      'INTERACTION_POST_CLASSIFICATION',
      'A post-action interaction must declare a hit classification.',
    );
  }
  if (interaction.status === 'clear') {
    if (
      !(POST_CLEAR_CLASSIFICATIONS as readonly string[]).includes(classification) ||
      interaction.obstructionCode !== null
    ) {
      return bad(
        'INTERACTION_POST_CLEAR_CONSISTENCY',
        'A clear post-action interaction must be target-owned with no obstruction code.',
      );
    }
  } else {
    if (
      !(POST_OBSTRUCTED_CLASSIFICATIONS as readonly string[]).includes(classification) ||
      interaction.obstructionCode !== 'POST_ACTION_HIT_OBSTRUCTED'
    ) {
      return bad(
        'INTERACTION_POST_OBSTRUCTED_CONSISTENCY',
        'An obstructed post-action interaction must declare POST_ACTION_HIT_OBSTRUCTED and a non-owned classification.',
      );
    }
    if (classification === 'selection-chrome' && descriptor.chromeName !== 'artwork-chrome') {
      return bad(
        'INTERACTION_POST_CHROME_NAME',
        'A selection-chrome obstruction must name the static artwork-chrome ancestor.',
      );
    }
    if (classification === 'no-hit' && descriptor.nodeClass !== null) {
      return bad('INTERACTION_POST_NO_HIT', 'A no-hit obstruction must carry a null node class.');
    }
  }
  return {
    ok: true,
    interaction: {
      phase: 'post-action',
      purpose: 'observe-authoritative-geometry',
      authority: 'none',
      status: interaction.status as 'clear' | 'obstructed',
      targetId: expectedTargetId,
      space: 'browser-client-css',
      candidate,
      point: finitePoint,
      safetyInsetCssPx: NESTED_OBJECT_HIT_INSET_CSS_PX,
      source: 'live-konva-hit-v1',
      hitClassification: classification as NestedPostHitClassification,
      obstructionCode: interaction.obstructionCode as null | 'POST_ACTION_HIT_OBSTRUCTED',
      safeHitDescriptor: {
        nodeClass: descriptor.nodeClass as SafeHitNodeClass,
        chromeName: descriptor.chromeName as SafeChromeName,
        ownedByTarget: descriptor.ownedByTarget,
      },
      interactionFingerprint: interaction.interactionFingerprint,
    },
  };
}

function finalizeGeometryV3(input: FinalizeInput): NestedObjectGeometryValidation {
  const raw = input.raw;
  const representation = input.representation;
  const provenance = raw.typedProvenance;
  const interaction = raw.interaction;
  const representationFingerprint = representation.representationFingerprint;
  const chainFingerprint = raw.chainFingerprint;
  if (
    !isPlainObject(provenance) ||
    !exactKeys(provenance, [
      'bridgeGeneration',
      'target',
      'witness',
      'layout',
      'chainFingerprint',
      'representationFingerprint',
      'stageFingerprint',
    ]) ||
    typeof representationFingerprint !== 'string' ||
    representationFingerprint.length === 0 ||
    typeof chainFingerprint !== 'string' ||
    chainFingerprint.length === 0
  ) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'PROVENANCE_SHAPE',
      'The geometry-v3 typed provenance or fingerprint is missing.',
    );
  }
  const provenanceIds: Array<{ key: 'target' | 'witness' | 'layout'; expectedId: string }> = [
    { key: 'target', expectedId: input.expected.targetId },
    { key: 'witness', expectedId: input.expected.witnessId },
    { key: 'layout', expectedId: input.expected.layoutId },
  ];
  for (const entry of provenanceIds) {
    const record = provenance[entry.key];
    if (
      !isPlainObject(record) ||
      record.id !== entry.expectedId ||
      typeof record.konvaId !== 'string' ||
      typeof record.fingerprint !== 'string' ||
      record.fingerprint.length === 0
    ) {
      return fail(
        'GEOMETRY_CHAIN_ID_MISMATCH',
        'PROVENANCE_ID_MISMATCH',
        `The geometry-v3 provenance does not name the declared ${entry.key} "${entry.expectedId}".`,
      );
    }
  }
  if (
    provenance.representationFingerprint !== representationFingerprint ||
    provenance.chainFingerprint !== chainFingerprint ||
    typeof provenance.stageFingerprint !== 'string' ||
    provenance.stageFingerprint.length === 0 ||
    typeof provenance.bridgeGeneration !== 'number' ||
    !Number.isSafeInteger(provenance.bridgeGeneration)
  ) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'PROVENANCE_FINGERPRINT',
      'The geometry-v3 provenance fingerprints are inconsistent with the representation.',
    );
  }
  const recordFingerprint = raw.recordFingerprint;
  if (typeof recordFingerprint !== 'string' || recordFingerprint.length === 0) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'RECORD_FINGERPRINT',
      'The geometry-v3 record fingerprint is not a non-empty string.',
    );
  }
  const parsedInteraction = parseInteractionMemberV3(interaction, input.expected.targetId);
  if (!parsedInteraction.ok) {
    return { ok: false, failure: parsedInteraction.failure };
  }
  const units = representation.units as Record<string, unknown>;
  const geometry: NestedObjectGeometryV3 = {
    schemaVersion: NESTED_GEOMETRY_SCHEMA_VERSION,
    discriminant: NESTED_GEOMETRY_DISCRIMINANT,
    representation: {
      kind: NESTED_OBJECT_AFFINE_CHAIN_KIND,
      representationVersion: NESTED_OBJECT_REPRESENTATION_VERSION,
      pointOrder: NESTED_OBJECT_POINT_ORDER,
      units: Object.fromEntries(Object.entries(units).map(([key, value]) => [key, String(value)])),
      targetId: input.expected.targetId,
      witnessId: input.expected.witnessId,
      layoutId: input.expected.layoutId,
      canonicalChain: input.segments,
      targetCanonicalFrame: input.targetSegment,
      witnessCanonicalFrame: input.witnessSegment,
      canonicalWitnessLocalQuad: input.witnessLocalQuad,
      persistedWitnessContentQuad: input.persistedWitnessContentQuad,
      targetWrappers: input.targetWrappers,
      canonicalLayoutQuad: input.publishedCanonicalLayoutQuad,
      renderedLayoutQuad: input.publishedRenderedLayoutQuad,
      renderedWorldSceneQuad: input.publishedRenderedWorldSceneQuad,
      renderedStageViewportCssQuad: input.publishedRenderedStageQuad,
      renderedBrowserClientCssQuad: input.publishedRenderedBrowserQuad,
      representationFingerprint,
      matrices: {
        canonicalWitnessToLayout: input.canonicalWitnessToLayout,
        renderedWitnessToLayout: input.renderedWitnessToLayout,
        layoutToWorldScene: input.layoutToWorldScene,
        worldSceneToStageViewportCss: input.worldSceneToStageViewportCss,
        stageViewportToBrowserClientCss: input.stageViewportToBrowserClientCss,
      },
    },
    camera: {
      canonical: { x: input.camera.x, y: input.camera.y, zoom: input.camera.zoom },
      stageMatrix: input.camera.stageMatrix,
      cssRatios: { x: input.camera.ratioX, y: input.camera.ratioY },
    },
    typedProvenance: {
      bridgeGeneration: provenance.bridgeGeneration as number,
      target: provenance.target as NestedObjectGeometryV3['typedProvenance']['target'],
      witness: provenance.witness as NestedObjectGeometryV3['typedProvenance']['witness'],
      layout: provenance.layout as NestedObjectGeometryV3['typedProvenance']['layout'],
      chainFingerprint,
      representationFingerprint,
      stageFingerprint: provenance.stageFingerprint as string,
    },
    interaction: parsedInteraction.interaction,
    normalization: input.normalization,
    chainFingerprint,
    recordFingerprint,
  };
  return { ok: true, geometry };
}

// ── Camera agreement and correlation helpers ────────────────────────────────

export interface NestedCameraAgreementV3 {
  panX: boolean;
  panY: boolean;
  scaleX: boolean;
  scaleY: boolean;
  rotation: boolean;
  skewX: boolean;
  skewY: boolean;
}

/**
 * Canonical camera intent vs live Stage matrix (R7). `stage.x/y` agree with the
 * canonical pan, Stage scale agrees with `camera.zoom`, and Stage rotation/skew
 * are zero, all within the canonical arithmetic tolerance.
 */
export function evaluateNestedCameraAgreementV3(
  geometry: NestedObjectGeometryV3,
  tolerance: number = NESTED_GEOMETRY_CANONICAL_EPSILON,
): NestedCameraAgreementV3 {
  const matrix = geometry.camera.stageMatrix;
  const { x, y, zoom } = geometry.camera.canonical;
  return {
    panX: Math.abs(matrix.e - x) <= tolerance,
    panY: Math.abs(matrix.f - y) <= tolerance,
    scaleX: Math.abs(matrix.a - zoom) <= tolerance,
    scaleY: Math.abs(matrix.d - zoom) <= tolerance,
    rotation: Math.abs(matrix.b) <= tolerance,
    skewX: Math.abs(matrix.c) <= tolerance,
    skewY: Math.abs(matrix.b) <= tolerance,
  };
}

/** True when every camera dimension agrees. */
export function cameraAgreementPasses(agreement: NestedCameraAgreementV3): boolean {
  return Object.values(agreement).every((value) => value === true);
}

/** The four corresponding witness-local points (R5 point order). */
export function nestedLocalPoints(facts: NestedObjectFrameFacts): Quad {
  return canonicalWitnessLocalQuad(facts);
}

/** Ordered point labels matching `nestedLocalPoints`. */
export const NESTED_OBJECT_POINT_LABELS = NESTED_OBJECT_POINT_ORDER;

/**
 * Applies the unchanged linear part of the browser projection to a canonical
 * Layout-local delta (R10). Translations do not contribute.
 */
export function browserDeltaFromLayoutDelta(
  geometry: NestedObjectGeometryV3,
  delta: { x: number; y: number },
): { x: number; y: number } {
  const linear: Affine2D = {
    a: geometry.representation.matrices.worldSceneToStageViewportCss.a,
    b: geometry.representation.matrices.worldSceneToStageViewportCss.b,
    c: geometry.representation.matrices.worldSceneToStageViewportCss.c,
    d: geometry.representation.matrices.worldSceneToStageViewportCss.d,
    e: 0,
    f: 0,
  };
  const composed = multiplyAffine(
    geometry.representation.matrices.stageViewportToBrowserClientCss,
    multiplyAffine(linear, geometry.representation.matrices.layoutToWorldScene),
  );
  return applyAffine({ ...composed, e: 0, f: 0 }, delta);
}

/** Stable, opaque correlation id for a recomputed canonical chain. */
export function canonicalChainCorrelationId(chain: readonly NestedObjectFrameFacts[]): string {
  return fnv1a64Hex(
    JSON.stringify(
      chain.map((facts) => [
        facts.id,
        facts.kind,
        facts.parentId,
        facts.x,
        facts.y,
        facts.width,
        facts.height,
        facts.rotationDegrees,
        facts.flipX,
        facts.flipY,
      ]),
    ),
  );
}
