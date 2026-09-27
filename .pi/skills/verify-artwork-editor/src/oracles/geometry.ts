import type { StampedGeometryView } from '../readiness/coherent-capture';
import { ORACLE_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * `geometry.delta` Oracle (specification 11; supervisor R7; WP5 Slice 5-A).
 *
 * The claimed move is proven from two independent sources:
 *
 *  - the *canonical* source is the authoritative `layoutItems` content state;
 *  - the *renderer* source is the live Konva geometry the bridge stamped.
 *
 * Both must meet the required minimum delta, and they must agree within a
 * declared tolerance. No source rescues another: canonical/renderer
 * disagreement is a failure, not a preference. Canonical comparison is exact
 * (`CANONICAL_EXACT`), renderer comparison allows the declared transform
 * tolerance (`RENDER_TRANSFORM_CSS`).
 */

export const CANONICAL_EXACT_TOLERANCE = 1e-6;
export const RENDER_TRANSFORM_CSS_TOLERANCE = 0.25;

export interface GeometryPosition {
  x: number;
  y: number;
}

export interface GeometryDelta {
  x: number;
  y: number;
}

export interface MinimumDelta {
  x: number;
  y: number;
}

export function subtractPosition(after: GeometryPosition, before: GeometryPosition): GeometryDelta {
  return { x: after.x - before.x, y: after.y - before.y };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds the canonical `{ x, y }` position of a layer id inside the authoritative
 * `layoutItems` tree. Nested Object layers are walked; the first exact id match
 * wins. A missing id is `null`, never a zero.
 */
export function findCanonicalPosition(
  layoutItems: unknown,
  elementId: string,
): GeometryPosition | null {
  const seen = new Set<unknown>();

  const visit = (value: unknown): GeometryPosition | null => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = visit(entry);
        if (found) return found;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (value.id === elementId) {
      const x = value.xCoordinate;
      const y = value.yCoordinate;
      if (
        typeof x === 'number' &&
        Number.isFinite(x) &&
        typeof y === 'number' &&
        Number.isFinite(y)
      ) {
        return { x, y };
      }
    }
    for (const key of Object.keys(value)) {
      const found = visit(value[key]);
      if (found) return found;
    }
    return null;
  };

  return visit(layoutItems);
}

/** Rendered position of a target from its stamped live geometry. */
export function renderedPosition(
  geometry: StampedGeometryView | undefined,
): GeometryPosition | null {
  if (!geometry || !geometry.mounted) return null;
  if (geometry.sceneRect) return { x: geometry.sceneRect.x, y: geometry.sceneRect.y };
  if (geometry.stageRect) return { x: geometry.stageRect.x, y: geometry.stageRect.y };
  if (geometry.viewportRect) return { x: geometry.viewportRect.x, y: geometry.viewportRect.y };
  return null;
}

/**
 * Rendered *transform* position of a target: the live Konva node transform
 * carried by the bridge's typed, read-only renderer provenance.
 *
 * This is the decoration-independent renderer position. The bridge's bounding
 * rects (`sceneRect`/`stageRect`/`viewportRect`) are `getClientRect`-derived and
 * therefore include selection chrome (handles, rotate icon, hover border), so a
 * selection change moves the rect without moving the target. The typed node
 * transform position (`renderer.target`) is the renderer fact the Oracle
 * compares against the canonical position.
 *
 * The ordinary-Text migration reads only typed renderer provenance (R7, R11;
 * design §6, item 3): an absent/non-finite typed position, or a typed target id
 * that does not agree with both the read geometry id and the resolved target id,
 * is `null`/UNUSABLE, never a silent fallback to the AABB rects. No fingerprint
 * is ever parsed. The rects remain diagnostic capture only.
 */
export function renderedTransformPosition(
  geometry: StampedGeometryView | undefined,
  expectedElementId?: string,
): GeometryPosition | null {
  if (!geometry || !geometry.mounted) return null;
  const provenance = geometry.renderer?.target;
  if (!provenance || typeof provenance.id !== 'string') return null;
  if (provenance.id !== geometry.id) return null;
  if (expectedElementId !== undefined && provenance.id !== expectedElementId) return null;
  if (
    typeof provenance.x === 'number' &&
    Number.isFinite(provenance.x) &&
    typeof provenance.y === 'number' &&
    Number.isFinite(provenance.y)
  ) {
    return { x: provenance.x, y: provenance.y };
  }
  return null;
}

export interface GeometryDeltaOracleInput {
  minimumDelta: MinimumDelta;
  canonicalBefore: GeometryPosition | null;
  canonicalAfter: GeometryPosition | null;
  renderedBefore: GeometryPosition | null;
  renderedAfter: GeometryPosition | null;
}

export interface GeometryDeltaOracleResult {
  checkId: 'geometry.delta';
  status: 'PASS' | 'FAIL' | 'UNUSABLE';
  passed: boolean;
  canonicalDelta: GeometryDelta | null;
  renderedDelta: GeometryDelta | null;
  agreement: GeometryDelta | null;
  sourcesAgree: boolean;
  canonicalMet: boolean;
  renderedMet: boolean;
  detail: string;
  /**
   * Additive primitive geometry facts (ADR 0032 §E3-S1). These are derived
   * directly from the canonical/rendered deltas and their named predicates;
   * they are not a projection of the deprecated composite `passed` field.
   */
  primitiveFacts: GeometryPrimitiveFacts;
}

export interface GeometryPrimitiveCheckFact {
  readonly checkId: 'geometry.delta';
  readonly predicateMet: boolean;
}

export interface GeometryPrimitiveFacts {
  readonly authority: 'current' | 'malformed';
  readonly sourcesAgree: boolean;
  readonly checks: readonly GeometryPrimitiveCheckFact[];
}

function within(actual: number, required: number, tolerance: number): boolean {
  return actual >= required - tolerance;
}

function agrees(delta: GeometryDelta, tolerance: number): boolean {
  return Math.abs(delta.x) <= tolerance && Math.abs(delta.y) <= tolerance;
}

export function evaluateGeometryDeltaOracle(
  input: GeometryDeltaOracleInput,
): GeometryDeltaOracleResult {
  if (
    input.canonicalBefore === null ||
    input.canonicalAfter === null ||
    input.renderedBefore === null ||
    input.renderedAfter === null
  ) {
    return {
      checkId: 'geometry.delta',
      status: 'UNUSABLE',
      passed: false,
      canonicalDelta: null,
      renderedDelta: null,
      agreement: null,
      sourcesAgree: false,
      canonicalMet: false,
      renderedMet: false,
      detail:
        'geometry.delta is unusable: the canonical and/or rendered before/after position could not be read for the resolved target.',
      primitiveFacts: {
        authority: 'malformed',
        sourcesAgree: false,
        checks: [{ checkId: 'geometry.delta', predicateMet: false }],
      },
    };
  }

  const canonicalDelta = subtractPosition(input.canonicalAfter, input.canonicalBefore);
  const renderedDelta = subtractPosition(input.renderedAfter, input.renderedBefore);
  const agreement: GeometryDelta = {
    x: canonicalDelta.x - renderedDelta.x,
    y: canonicalDelta.y - renderedDelta.y,
  };

  const canonicalMet =
    within(canonicalDelta.x, input.minimumDelta.x, CANONICAL_EXACT_TOLERANCE) &&
    within(canonicalDelta.y, input.minimumDelta.y, CANONICAL_EXACT_TOLERANCE);
  const renderedMet =
    within(renderedDelta.x, input.minimumDelta.x, RENDER_TRANSFORM_CSS_TOLERANCE) &&
    within(renderedDelta.y, input.minimumDelta.y, RENDER_TRANSFORM_CSS_TOLERANCE);
  const sourcesAgree = agrees(agreement, RENDER_TRANSFORM_CSS_TOLERANCE);
  const passed = canonicalMet && renderedMet && sourcesAgree;

  const detail = passed
    ? `geometry.delta met: canonical Δ(${canonicalDelta.x.toFixed(3)}, ${canonicalDelta.y.toFixed(3)}) and rendered Δ(${renderedDelta.x.toFixed(3)}, ${renderedDelta.y.toFixed(3)}) both meet the required minimum and agree within ${RENDER_TRANSFORM_CSS_TOLERANCE}px.`
    : `geometry.delta failed: canonicalMet=${String(canonicalMet)}, renderedMet=${String(renderedMet)}, sourcesAgree=${String(sourcesAgree)} (canonical Δ(${canonicalDelta.x.toFixed(3)}, ${canonicalDelta.y.toFixed(3)}), rendered Δ(${renderedDelta.x.toFixed(3)}, ${renderedDelta.y.toFixed(3)}), required ≥(${input.minimumDelta.x}, ${input.minimumDelta.y})).`;

  return {
    checkId: 'geometry.delta',
    status: passed ? 'PASS' : 'FAIL',
    passed,
    canonicalDelta,
    renderedDelta,
    agreement,
    sourcesAgree,
    canonicalMet,
    renderedMet,
    detail,
    primitiveFacts: {
      authority: 'current',
      sourcesAgree,
      checks: [
        {
          checkId: 'geometry.delta',
          predicateMet: canonicalMet && renderedMet && sourcesAgree,
        },
      ],
    },
  };
}

/** Oracle profile identity, recorded with every evaluation. */
export const GEOMETRY_ORACLE_PROFILE = Object.freeze({
  schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
  profileId: 'geometry-delta-v1',
  canonicalTolerance: CANONICAL_EXACT_TOLERANCE,
  rendererTolerance: RENDER_TRANSFORM_CSS_TOLERANCE,
});
