/**
 * Honest fixed wall-clock contract (ADR 0017 R2/R3).
 *
 * A governed drive may pin only wall-calendar reads (`Date`) through Playwright's
 * own pre-navigation page clock; scheduling (`performance.now`, timers, RAF) keeps
 * advancing against real monotonic time. This module owns the provider identity
 * and the strict canonical-UTC baseline validator so the browser launcher and
 * the generated-Crossword clock profile share exactly one interpretation.
 */

/** Identity of the honest fixed-wall-clock provider (ADR 0017 R3). */
export const WALL_CLOCK_PROVIDER_ID = 'playwright-clock-fixed-wall-v1';
export const WALL_CLOCK_PROVIDER_IMPLEMENTATION = '@playwright/test@1.59.1/page.clock.setFixedTime';
export const WALL_CLOCK_NAMESPACE = 'crossword.create.date-now.v1';

/** Exact canonical UTC form required for a governed wall-clock baseline. */
const CANONICAL_UTC_BASELINE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type WallClockBaselineValidation =
  | { ok: true; utc: string; epochMs: number }
  | { ok: false; detail: string };

/**
 * Strict validation of one declared wall-clock baseline (ADR 0017 R2/R4).
 *
 * A baseline is accepted only when it is the exact canonical UTC form
 * `YYYY-MM-DDTHH:mm:ss.sssZ`, parses to a finite safe-integer epoch, and
 * round-trips byte-exactly through `toISOString()`. A malformed, non-canonical,
 * non-UTC, or lossy value blocks before any browser is launched.
 */
export function validateWallClockBaseline(value: unknown): WallClockBaselineValidation {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, detail: 'A wall-clock baseline must be a non-empty string.' };
  }
  if (!CANONICAL_UTC_BASELINE_PATTERN.test(value)) {
    return {
      ok: false,
      detail: `Wall-clock baseline "${value}" is not the exact canonical UTC form YYYY-MM-DDTHH:mm:ss.sssZ.`,
    };
  }
  const epochMs = Date.parse(value);
  if (!Number.isSafeInteger(epochMs)) {
    return {
      ok: false,
      detail: `Wall-clock baseline "${value}" does not parse to a finite safe-integer epoch.`,
    };
  }
  if (new Date(epochMs).toISOString() !== value) {
    return {
      ok: false,
      detail: `Wall-clock baseline "${value}" does not round-trip through toISOString().`,
    };
  }
  return { ok: true, utc: value, epochMs };
}
