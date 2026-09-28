import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { ObservationCursor, WaitForChangeOutcome, WakeSource } from '../contracts/observation';
import {
  rasterProbeBackingCoordinate,
  readAcceptedRasterAuthority,
  validateRasterRecord,
} from '../contracts/raster';
import type { RasterBracketView } from './coherent-capture';
import type { ReadinessProfile } from './correlated-gate';

/**
 * Expected-raster currentness (WP5 Slice 5-C supervisor R6).
 *
 * Readiness must not accept a temporary or stale canvas and immediately classify
 * its transient pixels as a product `BUG`. After the semantic transition wakes
 * the cycle, the raster is re-read signal-first (watchdog, then the bounded
 * 100/200/250 ms cadence) inside the *same non-extending* Action Cycle deadline
 * until the live record matches the checkpoint's expected source digest,
 * dimensions, full-opacity expectation and fixed probes.
 *
 * A well-formed but nonmatching record is a non-converged readiness candidate
 * that keeps the deadline; only persistent non-convergence at the deadline is a
 * product `BUG`. A structurally unusable/torn/tainted/ambiguous record is a
 * harness-contract failure. The Oracle still repeats these checks against the
 * accepted R1; readiness never replaces it.
 */

/** Canonical tolerance for drawn-dimension comparisons in product units. */
export const RASTER_CURRENTNESS_EXACT = 1e-6;

export interface ExpectedRasterProbe {
  id: string;
  x: { numerator: number; denominator: number };
  y: { numerator: number; denominator: number };
  expectedRgba: readonly number[];
  channelTolerance: number;
}

export interface ExpectedRasterResource {
  sha256: string;
  byteLength: number;
  mimeType: string;
  dimensions: { width: number; height: number };
  probes: readonly ExpectedRasterProbe[];
}

export interface ExpectedRasterFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface AcceptedRasterUpload {
  sourceSha256: string;
  rgbaSha256: string;
  probes: readonly { probeId: string; rgba: readonly number[] }[];
}

export type RasterCurrentnessStatus = 'converged' | 'mismatch' | 'unusable';

export interface RasterCurrentnessEvaluation {
  status: RasterCurrentnessStatus;
  detail: string;
  /** Non-empty only for a well-formed `mismatch`; the exact fields that differ. */
  mismatchedFields: readonly string[];
  /** Precise blocking diagnostic for `unusable`, otherwise `null`. */
  diagnostic: DiagnosticRecord | null;
}

export interface ExpectedRasterCurrentnessInput {
  raster: RasterBracketView | null;
  targetId: string;
  expectedResource: ExpectedRasterResource;
  expectedFrame: ExpectedRasterFrame;
  mode: 'upload' | 'replacement';
  acceptedUpload: AcceptedRasterUpload | null;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= RASTER_CURRENTNESS_EXACT;
}

function mismatched(detail: string, fields: readonly string[]): RasterCurrentnessEvaluation {
  return { status: 'mismatch', detail, mismatchedFields: fields, diagnostic: null };
}

function unusable(detail: string, diagnostic: DiagnosticRecord): RasterCurrentnessEvaluation {
  return { status: 'unusable', detail, mismatchedFields: [], diagnostic };
}

/** True when the two internal raster capture anchors agree field-for-field. */
function captureAnchorsAgree(view: RasterBracketView): boolean {
  const capture = view.capture;
  if (capture === undefined || capture.started === undefined || capture.completed === undefined) {
    return false;
  }
  const started = capture.started;
  const completed = capture.completed;
  return (
    started.schemaVersion === completed.schemaVersion &&
    started.documentId === completed.documentId &&
    started.documentEpoch === completed.documentEpoch &&
    started.bridgeVersion === completed.bridgeVersion &&
    started.bridgeGeneration === completed.bridgeGeneration &&
    started.revision === completed.revision
  );
}

/**
 * Evaluate whether one live raster record is the checkpoint's expected,
 * fully-converged raster. Pure and side-effect free; the caller owns cadence,
 * deadline and diagnostics.
 */
export function evaluateExpectedRasterCurrentness(
  input: ExpectedRasterCurrentnessInput,
): RasterCurrentnessEvaluation {
  const { raster, targetId } = input;
  if (raster === null) {
    return unusable(
      `No live raster record was captured for "${targetId}".`,
      createDiagnostic(
        'UNUSABLE_EVIDENCE',
        `No live raster record was captured for "${targetId}".`,
      ),
    );
  }

  // Structural authority first. A malformed, tainted, unreadable, ambiguous, or
  // torn record is a harness-contract failure, never a product `BUG`.
  const validation = validateRasterRecord(raster);
  if (!validation.ok) {
    return unusable(
      validation.detail,
      validation.diagnostic ?? createDiagnostic('RASTER_AUTHORITY_UNUSABLE', validation.detail),
    );
  }
  if (raster.authorityKind !== 'image-source-v2') {
    const detail = `Raster target "${targetId}" does not publish the image-source-v2 authority arm; Image currentness cannot interpret it.`;
    return unusable(detail, createDiagnostic('RASTER_AUTHORITY_UNUSABLE', detail));
  }
  if (raster.id !== targetId) {
    const detail = `Raster target id "${String(raster.id)}" does not equal "${targetId}".`;
    return unusable(detail, createDiagnostic('RASTER_TARGET_ID_MISMATCH', detail));
  }
  const rendererTargetId = raster.renderer?.target?.id;
  if (rendererTargetId !== targetId) {
    const detail = `Raster renderer target id "${String(rendererTargetId)}" does not equal "${targetId}".`;
    return unusable(detail, createDiagnostic('RASTER_TARGET_ID_MISMATCH', detail));
  }
  if (!captureAnchorsAgree(raster)) {
    const detail = `Raster target "${targetId}" internal capture start/end anchors do not agree; the record is torn.`;
    return unusable(detail, createDiagnostic('RASTER_OBSERVATION_TORN', detail));
  }
  if (raster.capture?.sourceStable !== true || raster.capture?.rendererStable !== true) {
    const detail = `Raster target "${targetId}" changed during acquisition; the record is torn.`;
    return unusable(detail, createDiagnostic('RASTER_OBSERVATION_TORN', detail));
  }

  // A structurally valid record that is not ready yet is a *non-converged*
  // candidate: the safe file action happened and the render may still be
  // settling. It never becomes a premature product `BUG`.
  if (raster.status !== 'ready') {
    return mismatched(`Raster status is ${String(raster.status)}, not ready.`, [
      `status:${String(raster.status)}`,
    ]);
  }

  // The closed validator and the `image-source-v2` discriminant above proved the
  // structural image arm. Bind the one accepted typed view for that arm so the
  // source/rendered authority is read through the closed contract rather than
  // through scattered optional projections. No side is defaulted: a ready record
  // that cannot publish both members stays unusable authority.
  const accepted = readAcceptedRasterAuthority(raster);
  if (
    !accepted.ok ||
    accepted.record === null ||
    accepted.record.authorityKind !== 'image-source-v2'
  ) {
    const detail = 'A ready raster record must publish source and rendered authority.';
    return unusable(detail, createDiagnostic('RASTER_AUTHORITY_UNUSABLE', detail));
  }
  const source = accepted.record.source;
  const rendered = accepted.record.rendered;
  if (source === null || rendered === null) {
    const detail = 'A ready raster record must publish source and rendered authority.';
    return unusable(detail, createDiagnostic('RASTER_AUTHORITY_UNUSABLE', detail));
  }

  const expected = input.expectedResource;
  const fields: string[] = [];
  if (source.sha256 !== expected.sha256) fields.push('source.sha256');
  if (source.byteLength !== expected.byteLength) fields.push('source.byteLength');
  if (source.mimeType !== expected.mimeType) fields.push('source.mimeType');
  if (source.decodedWidth !== expected.dimensions.width) fields.push('source.decodedWidth');
  if (source.decodedHeight !== expected.dimensions.height) fields.push('source.decodedHeight');

  const backingWidth = rendered.backingWidth;
  const backingHeight = rendered.backingHeight;
  if (
    typeof backingWidth !== 'number' ||
    !Number.isFinite(backingWidth) ||
    backingWidth <= 0 ||
    typeof backingHeight !== 'number' ||
    !Number.isFinite(backingHeight) ||
    backingHeight <= 0
  ) {
    const detail = `Live raster backing dimensions for "${targetId}" are not positive.`;
    return unusable(detail, createDiagnostic('RASTER_AUTHORITY_UNUSABLE', detail));
  }
  if (rendered.rgbaByteLength !== backingWidth * backingHeight * 4) {
    const detail = `Live raster rgbaByteLength ${String(rendered.rgbaByteLength)} does not equal ${backingWidth * backingHeight * 4}.`;
    return unusable(detail, createDiagnostic('RASTER_AUTHORITY_UNUSABLE', detail));
  }

  // R6: the expected fixture is fully opaque. A merely positive alpha count is
  // insufficient, so ask for exact backing coverage.
  if (rendered.nonTransparentPixelCount !== backingWidth * backingHeight) {
    fields.push('rendered.nonTransparentPixelCount');
  }

  // Drawn dimensions must equal the checkpoint's canonical frame (design §9.4).
  if (
    typeof rendered.drawnWidth !== 'number' ||
    !Number.isFinite(rendered.drawnWidth) ||
    !nearlyEqual(rendered.drawnWidth, input.expectedFrame.width)
  ) {
    fields.push('rendered.drawnWidth');
  }
  if (
    typeof rendered.drawnHeight !== 'number' ||
    !Number.isFinite(rendered.drawnHeight) ||
    !nearlyEqual(rendered.drawnHeight, input.expectedFrame.height)
  ) {
    fields.push('rendered.drawnHeight');
  }

  // Fixed probes: identity and derived backing coordinates are structural
  // authority; channel values are the expected structural-visual contract.
  const probes = rendered.probes;
  if (!Array.isArray(probes) || probes.length !== expected.probes.length) {
    const detail = `Live raster publishes no closed probe set for "${targetId}".`;
    return unusable(detail, createDiagnostic('RASTER_SCHEMA_UNSUPPORTED', detail));
  }
  for (const expectedProbe of expected.probes) {
    const actual = probes.find((entry) => entry.probeId === expectedProbe.id);
    if (!actual) {
      const detail = `Live raster is missing probe "${expectedProbe.id}" for "${targetId}".`;
      return unusable(detail, createDiagnostic('RASTER_SCHEMA_UNSUPPORTED', detail));
    }
    const expectedX = rasterProbeBackingCoordinate(
      backingWidth,
      expectedProbe.x.numerator,
      expectedProbe.x.denominator,
    );
    const expectedY = rasterProbeBackingCoordinate(
      backingHeight,
      expectedProbe.y.numerator,
      expectedProbe.y.denominator,
    );
    if (actual.backingX !== expectedX || actual.backingY !== expectedY) {
      const detail = `Probe "${expectedProbe.id}" backing coordinate (${actual.backingX},${actual.backingY}) does not match the derived (${expectedX},${expectedY}).`;
      return unusable(detail, createDiagnostic('RASTER_SCHEMA_UNSUPPORTED', detail));
    }
    for (let channel = 0; channel < 4; channel += 1) {
      const value = actual.rgba[channel];
      const target = expectedProbe.expectedRgba[channel] as number;
      if (typeof value !== 'number' || Math.abs(value - target) > expectedProbe.channelTolerance) {
        fields.push(`rendered.probes.${expectedProbe.id}.${channel}`);
      }
    }
  }

  // Replacement must differ from the accepted upload in bytes and pixels.
  if (input.mode === 'replacement' && input.acceptedUpload !== null) {
    const accepted = input.acceptedUpload;
    if (source.sha256 === accepted.sourceSha256) fields.push('source.sha256===acceptedA');
    if (rendered.rgbaSha256 === accepted.rgbaSha256) {
      fields.push('rendered.rgbaSha256===acceptedA');
    }
  }

  if (fields.length > 0) {
    return mismatched(
      `Live raster for "${targetId}" has not converged to the expected resource (${fields.join(', ')}).`,
      fields,
    );
  }
  return {
    status: 'converged',
    detail: `Live raster for "${targetId}" matches the expected resource.`,
    mismatchedFields: [],
    diagnostic: null,
  };
}

export interface RasterConvergenceDeps {
  profile: ReadinessProfile;
  now: () => number;
  /** Absolute monotonic deadline; the same deadline as the Action Cycle. */
  deadlineAt: number;
  armCursor: ObservationCursor;
  waitForChange: (after: ObservationCursor, timeoutMs: number) => Promise<WaitForChangeOutcome>;
  readCursor: () => Promise<ObservationCursor>;
  /** One live raster read; the caller preserves the evaluation count. */
  readRaster: () => Promise<RasterBracketView>;
  evaluate: (raster: RasterBracketView) => RasterCurrentnessEvaluation;
  /** Wait before the first read (used when re-entering after a torn/stale capture). */
  settleBeforeFirstRead?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type RasterConvergenceResult =
  | {
      status: 'converged';
      raster: RasterBracketView;
      attempts: number;
      wakeSource: WakeSource;
      fallbackPollCount: number;
      watchdogWaits: number;
      mismatches: readonly string[];
    }
  | {
      status: 'deadline-exceeded';
      attempts: number;
      wakeSource: WakeSource;
      fallbackPollCount: number;
      watchdogWaits: number;
      mismatches: readonly string[];
      lastDetail: string;
    }
  | {
      status: 'unusable';
      detail: string;
      diagnostic: DiagnosticRecord | null;
      /** Observed work counters at the unusable exit; never defaulted to zero. */
      wakeSource: WakeSource;
      fallbackPollCount: number;
      watchdogWaits: number;
      attempts: number;
      mismatches: readonly string[];
    };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Signal-first expected-raster convergence loop (R6). The first read is immediate
 * (unless `settleBeforeFirstRead`); every subsequent evaluation is woken by the
 * store signal where available, otherwise by one reconciled probe after the
 * watchdog and then the bounded 100/200/250 ms cadence. The deadline is never
 * extended and no fixed sleep is used on the signal path.
 */
export async function awaitExpectedRasterConvergence(
  deps: RasterConvergenceDeps,
): Promise<RasterConvergenceResult> {
  const profile = deps.profile;
  const sleep = deps.sleep ?? defaultSleep;
  const mismatches: string[] = [];
  let latest = deps.armCursor;
  let fallbackActive = false;
  const fallbackDelaysMs: number[] = [];
  let fallbackPollCount = 0;
  let watchdogWaits = 0;
  let wakeSource: WakeSource = 'none';
  let attempts = 0;

  const remaining = (): number => deps.deadlineAt - deps.now();

  const settle = async (): Promise<void> => {
    const budget = remaining();
    if (budget <= 0) return;
    // Signal-first watchdog, then one reconciled probe and the bounded cadence.
    const waitBudget = Math.min(profile.signalWatchdogMs, budget);
    const outcome = await deps.waitForChange(latest, waitBudget);
    if (outcome.status === 'changed' && outcome.cursor !== null) {
      latest = outcome.cursor;
      wakeSource = outcome.wakeSource ?? 'store-signal';
      return;
    }
    watchdogWaits += 1;
    fallbackActive = true;
  };

  if (deps.settleBeforeFirstRead === true) {
    await settle();
  }

  for (;;) {
    if (remaining() <= 0) {
      return {
        status: 'deadline-exceeded',
        attempts,
        wakeSource,
        fallbackPollCount,
        watchdogWaits,
        mismatches,
        lastDetail: mismatches[mismatches.length - 1] ?? 'The readiness deadline elapsed.',
      };
    }
    attempts += 1;
    const raster = await deps.readRaster();
    const evaluation = deps.evaluate(raster);
    if (evaluation.status === 'converged') {
      return {
        status: 'converged',
        raster,
        attempts,
        wakeSource,
        fallbackPollCount,
        watchdogWaits,
        mismatches,
      };
    }
    if (evaluation.status === 'unusable') {
      return {
        status: 'unusable',
        detail: evaluation.detail,
        diagnostic: evaluation.diagnostic,
        wakeSource,
        fallbackPollCount,
        watchdogWaits,
        attempts,
        mismatches,
      };
    }
    mismatches.push(evaluation.detail);
    if (remaining() <= 0) {
      return {
        status: 'deadline-exceeded',
        attempts,
        wakeSource,
        fallbackPollCount,
        watchdogWaits,
        mismatches,
        lastDetail: evaluation.detail,
      };
    }

    if (!fallbackActive) {
      const waitBudget = Math.min(profile.signalWatchdogMs, remaining());
      const outcome = await deps.waitForChange(latest, waitBudget);
      if (outcome.status === 'invalidated') {
        const detail = `Observation authority was invalidated during raster readiness: ${outcome.reason ?? 'unknown'}.`;
        return {
          status: 'unusable',
          detail,
          diagnostic: createDiagnostic('RASTER_OBSERVATION_TORN', detail),
          wakeSource,
          fallbackPollCount,
          watchdogWaits,
          attempts,
          mismatches,
        };
      }
      if (outcome.status === 'changed' && outcome.cursor !== null) {
        latest = outcome.cursor;
        wakeSource = outcome.wakeSource ?? 'store-signal';
        continue;
      }
      watchdogWaits += 1;
      fallbackActive = true;
      continue;
    }

    const cadence = profile.fallbackCadenceMs;
    const probeIndex = fallbackDelaysMs.length;
    const delay =
      probeIndex === 0 ? 0 : (cadence[Math.min(probeIndex - 1, cadence.length - 1)] as number);
    const boundedDelay = Math.min(delay, Math.max(0, remaining()));
    if (boundedDelay > 0) await sleep(boundedDelay);
    fallbackDelaysMs.push(Math.round(boundedDelay));
    if (remaining() <= 0) continue;

    const signal = await deps.waitForChange(latest, 0);
    if (signal.status === 'invalidated') {
      const detail = `Observation authority was invalidated during raster readiness: ${signal.reason ?? 'unknown'}.`;
      return {
        status: 'unusable',
        detail,
        diagnostic: createDiagnostic('RASTER_OBSERVATION_TORN', detail),
        wakeSource,
        fallbackPollCount,
        watchdogWaits,
        attempts,
        mismatches,
      };
    }
    if (signal.status === 'changed' && signal.cursor !== null) {
      latest = signal.cursor;
      wakeSource = signal.wakeSource ?? 'store-signal';
      continue;
    }
    const probe = await deps.readCursor();
    latest = probe;
    fallbackPollCount += 1;
    if (wakeSource === 'none') wakeSource = 'poll-fallback';
  }
}
