import type { ObservationCursor, WaitForChangeOutcome, WakeSource } from '../contracts/observation';
import { cursorKey } from '../contracts/observation';
import { READINESS_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Signal-first correlated readiness gate (supervisor R5, specification 11).
 *
 * The gate waits for the *authoritative* product transition that the claimed
 * capability causes:
 *
 *  1. arm before the native action by retaining the pre-action cursor;
 *  2. wait on the bridge's `waitForChange` — a signal-first wake that closes the
 *     action-before-wait race and never polls first;
 *  3. only after a full 100 ms no-signal watchdog, allow one reconciled
 *     `cursor()` read plus the same cheap target predicate (fallback), then a
 *     bounded 100/200/250 ms adaptive cadence;
 *  4. always inside the single monotonic deadline, which no phase may extend.
 *
 * A wake only means "the store revision advanced": the same-target predicate is
 * what accepts a causal transition. Selection/camera/history-only changes wake
 * evaluation and are rejected by the predicate.
 */

export interface ReadinessProfile {
  schemaVersion: number;
  profileId: string;
  timingCategory: string;
  deadlineMs: number;
  signalWatchdogMs: number;
  fallbackCadenceMs: readonly number[];
  stableFrames: number;
}

/** The one named readiness policy for WP5 Slice 5-A. Cases cannot override it. */
export const ACTION_CYCLE_V1_PROFILE: ReadinessProfile = Object.freeze({
  schemaVersion: READINESS_PROFILE_SCHEMA_VERSION,
  profileId: 'action-cycle-v1',
  timingCategory: 'INTERACTIVE_RENDER_V1',
  deadlineMs: 5_000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
});

/**
 * The typed warped Text readiness profile (WP5 Slice 5-B; supervisor R12). It is
 * the accepted Slice 5-A policy unchanged — one monotonic 5,000 ms deadline,
 * 100 ms signal watchdog, bounded fallback cadence, three stable frames — with
 * the typed profile identity the adapter contributes. No phase may extend the
 * deadline.
 */
export const WARPED_TEXT_ACTION_CYCLE_PROFILE: ReadinessProfile = Object.freeze({
  schemaVersion: READINESS_PROFILE_SCHEMA_VERSION,
  profileId: 'warped-text-action-cycle-v1',
  timingCategory: 'INTERACTIVE_RENDER_V1',
  deadlineMs: 5_000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
});

/**
 * The raster-aware Image readiness profile (WP5 Slice 5-C; supervisor R7). It is
 * a resource-render timing category with one non-extending 8,000 ms deadline
 * covering file selection, product validation, blob creation, store/history
 * transition, decode, canvas rasterization, three stable frames, coherent
 * capture, and raster hashing. The signal-first watchdog and fallback cadence
 * are the accepted Slice 5-A policy; cases and adapters cannot override them.
 */
export const IMAGE_RASTER_ACTION_CYCLE_PROFILE: ReadinessProfile = Object.freeze({
  schemaVersion: READINESS_PROFILE_SCHEMA_VERSION,
  profileId: 'image-raster-action-cycle-v1',
  timingCategory: 'RESOURCE_RENDER_V1',
  deadlineMs: 8_000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
});

/**
 * The generated-Crossword readiness profile (ADR 0017 R13; ADR 0018 CR8).
 *
 * Generation is a native derived-generation action: one non-extending 8,000 ms
 * Node-monotonic deadline starts immediately before the first native input and
 * covers both control activations, the signal-first transition, target
 * set-difference resolution, target-aware idle, fonts, semantic/renderer/raster
 * capture, hashing, and bounded torn recapture. It never resets. The signal
 * watchdog and bounded 100/200/250 ms fallback cadence are the accepted
 * signal-first policy; cases and adapters cannot override the deadline.
 */
export const CROSSWORD_GENERATION_ACTION_CYCLE_PROFILE: ReadinessProfile = Object.freeze({
  schemaVersion: READINESS_PROFILE_SCHEMA_VERSION,
  profileId: 'crossword-generation-action-cycle-v1',
  timingCategory: 'DERIVED_GENERATION_V1',
  deadlineMs: 8_000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
});

/**
 * The cross-subject history readiness profile (WP5 Slice 5-F; ADR 0019 R10,
 * ADR 0020 A2). One monotonic, non-extending 5,000 ms deadline per native
 * Undo/Redo Action Cycle, the accepted 100 ms signal watchdog, bounded fallback
 * cadence, and three stable frames. History is whole-document: the profile is
 * not target-aware, and the guarded selection-clear Escape is not an Action
 * Cycle.
 */
export const HISTORY_ACTION_CYCLE_PROFILE: ReadinessProfile = Object.freeze({
  schemaVersion: READINESS_PROFILE_SCHEMA_VERSION,
  profileId: 'history-transition-v1',
  timingCategory: 'INTERACTIVE_HISTORY_V1',
  deadlineMs: 5_000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
});

/**
 * The frontend serialize/restore readiness profile (WP5 Slice 5-F; ADR 0019
 * R5/R9). One monotonic, non-extending 15,000 ms deadline covers the native
 * seller Save click, the exact create POST, the product redirect, the explicit
 * editor navigation, the exact GET, the new bridge mount, the target-aware
 * idle, and the coherent restored capture. Restore is whole-document: the
 * profile is not target-aware.
 */
export const FRONTEND_RESTORE_ACTION_CYCLE_PROFILE: ReadinessProfile = Object.freeze({
  schemaVersion: READINESS_PROFILE_SCHEMA_VERSION,
  profileId: 'frontend-restore-transition-v1',
  timingCategory: 'FRONTEND_RESTORE_V1',
  deadlineMs: 15_000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
});

export type ReadinessEventKind =
  | 'armed'
  | 'signal-changed'
  | 'signal-timeout'
  | 'signal-invalidated'
  | 'causal-rejected'
  | 'fallback-poll'
  | 'transition-accepted'
  | 'deadline-exceeded';

export interface ReadinessEvent {
  kind: ReadinessEventKind;
  atMs: number;
  detail: string;
  cursor: string | null;
  wakeSource: WakeSource | null;
  fallbackPollCount: number;
}

export interface CausalPredicateResult {
  satisfied: boolean;
  detail: string;
}

export interface CorrelatedGateDeps {
  profile: ReadinessProfile;
  now: () => number;
  /** Monotonic arm timestamp, recorded immediately before the native action. */
  armedAt: number;
  armCursor: ObservationCursor;
  waitForChange: (after: ObservationCursor, timeoutMs: number) => Promise<WaitForChangeOutcome>;
  /** Reads the latest cursor; used only for fallback reconciliation. */
  readCursor: () => Promise<ObservationCursor>;
  /** Cheap same-target predicate; never a full observation capture. */
  evaluateCausalTransition: (cursor: ObservationCursor) => Promise<CausalPredicateResult>;
  sleep?: (ms: number) => Promise<void>;
}

export interface CorrelatedGateResult {
  status: 'transition' | 'deadline-exceeded' | 'invalidated';
  cursor: ObservationCursor | null;
  wakeSource: WakeSource;
  fallbackPollCount: number;
  watchdogWaits: number;
  fallbackDelaysMs: readonly number[];
  remainingMs: number;
  events: readonly ReadinessEvent[];
  invalidatedReason: string | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function awaitCausalTransition(
  deps: CorrelatedGateDeps,
): Promise<CorrelatedGateResult> {
  const profile = deps.profile;
  const sleep = deps.sleep ?? defaultSleep;
  const events: ReadinessEvent[] = [];
  let fallbackPollCount = 0;
  let watchdogWaits = 0;
  let wakeSource: WakeSource = 'none';
  let latest = deps.armCursor;
  const fallbackDelaysMs: number[] = [];
  let fallbackActive = false;

  const elapsed = (): number => deps.now() - deps.armedAt;
  const remaining = (): number => profile.deadlineMs - elapsed();
  const record = (
    kind: ReadinessEventKind,
    cursor: ObservationCursor | null,
    detail: string,
    source: WakeSource | null = null,
  ): void => {
    events.push({
      kind,
      atMs: Math.round(elapsed()),
      detail,
      cursor: cursor === null ? null : cursorKey(cursor),
      wakeSource: source,
      fallbackPollCount,
    });
  };

  record('armed', deps.armCursor, `Armed at cursor ${cursorKey(deps.armCursor)}.`);

  const accept = (
    cursor: ObservationCursor,
    source: WakeSource,
    detail: string,
  ): CorrelatedGateResult => {
    wakeSource = source;
    record('transition-accepted', cursor, detail, source);
    return {
      status: 'transition',
      cursor,
      wakeSource,
      fallbackPollCount,
      watchdogWaits,
      fallbackDelaysMs,
      remainingMs: remaining(),
      events,
      invalidatedReason: null,
    };
  };

  const deadlineExceeded = (): CorrelatedGateResult => {
    record(
      'deadline-exceeded',
      latest,
      `Readiness deadline of ${profile.deadlineMs}ms elapsed without an accepted causal transition.`,
    );
    return {
      status: 'deadline-exceeded',
      cursor: latest,
      wakeSource,
      fallbackPollCount,
      watchdogWaits,
      fallbackDelaysMs,
      remainingMs: remaining(),
      events,
      invalidatedReason: null,
    };
  };

  const invalidated = (reason: string): CorrelatedGateResult => {
    record('signal-invalidated', null, `Observation authority was invalidated: ${reason}.`);
    return {
      status: 'invalidated',
      cursor: null,
      wakeSource,
      fallbackPollCount,
      watchdogWaits,
      fallbackDelaysMs,
      remainingMs: remaining(),
      events,
      invalidatedReason: reason,
    };
  };

  const evaluate = async (cursor: ObservationCursor): Promise<CausalPredicateResult> =>
    deps.evaluateCausalTransition(cursor);

  for (;;) {
    const budget = remaining();
    if (budget <= 0) return deadlineExceeded();

    if (!fallbackActive) {
      // Signal-first: a single bounded wait. Its timeout is the watchdog.
      const waitBudget = Math.min(profile.signalWatchdogMs, budget);
      const outcome = await deps.waitForChange(latest, waitBudget);
      if (outcome.status === 'invalidated') {
        return invalidated(outcome.reason ?? 'unknown');
      }
      if (outcome.status === 'changed' && outcome.cursor !== null) {
        latest = outcome.cursor;
        const source: WakeSource = outcome.wakeSource ?? 'store-signal';
        wakeSource = source;
        record('signal-changed', outcome.cursor, `Signal wake (${source}).`, source);
        const predicate = await evaluate(outcome.cursor);
        if (predicate.satisfied) {
          return accept(outcome.cursor, source, `Causal transition accepted via ${source}.`);
        }
        record('causal-rejected', outcome.cursor, predicate.detail);
        continue;
      }
      // Watchdog timeout: allow exactly one reconciled fallback probe.
      watchdogWaits += 1;
      record(
        'signal-timeout',
        latest,
        `No signal within the ${profile.signalWatchdogMs}ms watchdog; one reconciled fallback probe is permitted.`,
      );
      fallbackActive = true;
      continue;
    }

    // Fallback: the watchdog already elapsed, so exactly one reconciled probe is
    // permitted immediately, then the bounded 100/200/250 ms adaptive cadence.
    // Each iteration first checks for a signal (0 ms wait) so a signal arriving
    // during fallback still returns control to signal-driven evaluation;
    // fallback never resets the deadline and never manufactures a revision.
    const cadence = profile.fallbackCadenceMs;
    const probeIndex = fallbackDelaysMs.length;
    const delay =
      probeIndex === 0 ? 0 : (cadence[Math.min(probeIndex - 1, cadence.length - 1)] as number);
    const boundedDelay = Math.min(delay, Math.max(0, budget));
    if (boundedDelay > 0) await sleep(boundedDelay);
    fallbackDelaysMs.push(Math.round(boundedDelay));

    if (remaining() <= 0) return deadlineExceeded();

    const signal = await deps.waitForChange(latest, 0);
    if (signal.status === 'invalidated') {
      return invalidated(signal.reason ?? 'unknown');
    }
    if (signal.status === 'changed' && signal.cursor !== null) {
      latest = signal.cursor;
      const source: WakeSource = signal.wakeSource ?? 'store-signal';
      wakeSource = source;
      record('signal-changed', signal.cursor, `Signal wake during fallback (${source}).`, source);
      const signalPredicate = await evaluate(signal.cursor);
      if (signalPredicate.satisfied) {
        return accept(signal.cursor, source, `Causal transition accepted via ${source}.`);
      }
      record('causal-rejected', signal.cursor, signalPredicate.detail);
      continue;
    }

    const probe = await deps.readCursor();
    if (probe.documentId !== deps.armCursor.documentId) {
      return invalidated('document-mismatch');
    }
    if (probe.bridgeGeneration !== deps.armCursor.bridgeGeneration) {
      return invalidated('bridge-generation-mismatch');
    }
    latest = probe;
    fallbackPollCount += 1;
    record(
      'fallback-poll',
      probe,
      `Fallback probe ${fallbackPollCount} at cursor ${cursorKey(probe)}.`,
      'poll-fallback',
    );
    const predicate = await evaluate(probe);
    if (predicate.satisfied) {
      return accept(
        probe,
        'poll-fallback',
        'Causal transition accepted via bounded fallback polling.',
      );
    }
    record('causal-rejected', probe, predicate.detail);
  }
}
