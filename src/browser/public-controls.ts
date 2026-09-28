/**
 * Declared public interaction targets (WP5 Slice 5-A).
 *
 * Every native pointer primitive must start inside the live listening region of
 * the resolved target, with a declared safety inset so a drag never starts on a
 * border, a selection handle, or an antialiased edge that the renderer may or
 * may not hit. A point that does not clear the inset is refused *before* any
 * input is dispatched, so an ambiguous hit can never be mistaken for a product
 * defect.
 *
 * All geometry here is pure and in viewport CSS pixels, matching the bridge's
 * `geometry().hitPoint` and `geometry().viewportRect`.
 */

export const INTERACTION_TARGET = Object.freeze({
  /** Minimum distance a drag origin must keep from the region edge, in CSS px. */
  safetyInsetPx: 2,
  /** Regions smaller than this cannot host a safe native drag. */
  minimumRegionPx: 6,
});

/**
 * Closed public-control and dialog vocabulary (WP5 Slice 5-C; extended 5-E).
 *
 * A workflow targets a control by slug, never by a Subject/scenario branch: the
 * engine resolves the slug to the exact accessible name the product exposes.
 * `more` and `crossword` are the exact native create path of a generated
 * Crossword layer (`More` left-tool button → `Crossword` element preset card).
 */
export const PUBLIC_CONTROLS: Readonly<Record<string, string>> = Object.freeze({
  'test-with-image': 'Upload image',
  'replace-image': 'Replace image',
  more: 'More',
  crossword: 'Crossword',
  save: 'Save',
});

export const PUBLIC_DIALOGS: Readonly<Record<string, string>> = Object.freeze({
  'test-with-image': 'Test with image',
});

/** Exact accepted MIME types for the native Image file input. */
export const FILE_INPUT_ACCEPT = 'image/png,image/jpeg';

/** Exact accessible name for a declared control slug, or `null`. */
export function controlAccessibleName(slug: string): string | null {
  return Object.hasOwn(PUBLIC_CONTROLS, slug) ? (PUBLIC_CONTROLS[slug] as string) : null;
}

/** Exact accessible name for a declared dialog slug, or `null`. */
export function dialogAccessibleName(slug: string): string | null {
  return Object.hasOwn(PUBLIC_DIALOGS, slug) ? (PUBLIC_DIALOGS[slug] as string) : null;
}

export interface InteractionPoint {
  x: number;
  y: number;
}

export interface InteractionRegion extends InteractionPoint {
  width: number;
  height: number;
}

export interface InteractionTargetCandidate {
  hitPoint: InteractionPoint | undefined;
  viewportRect: InteractionRegion | undefined;
}

export type InteractionTargetVerdict =
  | { ok: true; point: InteractionPoint; region: InteractionRegion; insetRegion: InteractionRegion }
  | {
      ok: false;
      reason:
        | 'no-hit-point'
        | 'no-region'
        | 'region-too-small'
        | 'hit-point-outside-region'
        | 'hit-point-inside-safety-inset';
      detail: string;
    };

export function insetRegion(region: InteractionRegion, insetPx: number): InteractionRegion | null {
  const width = region.width - insetPx * 2;
  const height = region.height - insetPx * 2;
  if (width <= 0 || height <= 0) return null;
  return { x: region.x + insetPx, y: region.y + insetPx, width, height };
}

export function isPointInsideRegion(point: InteractionPoint, region: InteractionRegion): boolean {
  return (
    point.x >= region.x &&
    point.x <= region.x + region.width &&
    point.y >= region.y &&
    point.y <= region.y + region.height
  );
}

/**
 * Verifies the bridge-reported hit point against the live region with the
 * declared safety inset. `hitPoint` is the point the renderer itself reported as
 * hitting the target (inside its listening region); the inset check additionally
 * proves the point is robust to a one-pixel rounding shift.
 */
export function verifyInteractionTarget(
  candidate: InteractionTargetCandidate,
  insetPx: number = INTERACTION_TARGET.safetyInsetPx,
): InteractionTargetVerdict {
  const { hitPoint, viewportRect } = candidate;
  if (!hitPoint) {
    return { ok: false, reason: 'no-hit-point', detail: 'The target exposes no live hit point.' };
  }
  if (!viewportRect) {
    return {
      ok: false,
      reason: 'no-region',
      detail: 'The target exposes no live viewport region.',
    };
  }
  if (
    viewportRect.width < INTERACTION_TARGET.minimumRegionPx ||
    viewportRect.height < INTERACTION_TARGET.minimumRegionPx
  ) {
    return {
      ok: false,
      reason: 'region-too-small',
      detail: `Target region ${viewportRect.width}x${viewportRect.height} is smaller than the ${INTERACTION_TARGET.minimumRegionPx}px minimum for a safe native drag.`,
    };
  }
  if (!isPointInsideRegion(hitPoint, viewportRect)) {
    return {
      ok: false,
      reason: 'hit-point-outside-region',
      detail: `Hit point (${hitPoint.x}, ${hitPoint.y}) is outside the live viewport region.`,
    };
  }
  const safe = insetRegion(viewportRect, insetPx);
  if (safe === null) {
    return {
      ok: false,
      reason: 'region-too-small',
      detail: `Target region is too small for the declared ${insetPx}px safety inset.`,
    };
  }
  if (!isPointInsideRegion(hitPoint, safe)) {
    return {
      ok: false,
      reason: 'hit-point-inside-safety-inset',
      detail: `Hit point (${hitPoint.x}, ${hitPoint.y}) is inside the ${insetPx}px safety inset of the target region.`,
    };
  }
  return { ok: true, point: hitPoint, region: viewportRect, insetRegion: safe };
}
