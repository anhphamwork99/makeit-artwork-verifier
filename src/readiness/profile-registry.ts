import { READINESS_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';
import { CROSSWORD_COMPARISON_PROFILE_ID } from '../contracts/crossword-observation';
import {
  ACTION_CYCLE_V1_PROFILE,
  CROSSWORD_GENERATION_ACTION_CYCLE_PROFILE,
  FRONTEND_RESTORE_ACTION_CYCLE_PROFILE,
  HISTORY_ACTION_CYCLE_PROFILE,
  IMAGE_RASTER_ACTION_CYCLE_PROFILE,
  WARPED_TEXT_ACTION_CYCLE_PROFILE,
  type ReadinessProfile,
} from './correlated-gate';

/**
 * Data-routed readiness/capture/Oracle profile registry (WP5 Slice 5-D, ADR 0013
 * R11/design §10).
 *
 * The generic engine resolves one readiness profile id contributed by the
 * selected adapter to a concrete timing policy, a coherent-capture recipe, and
 * the Oracle profile id that consumes the accepted observation. It never
 * branches on Subject identity, application kind, scenario, or variant; the
 * existing Text/warped-Text/Image ids and behaviour are preserved exactly.
 */

/** Coherent-capture recipes. */
export const CAPTURE_PROFILE_SINGLE_TARGET = 'single-target-v1';
export const CAPTURE_PROFILE_TYPED_ENVELOPE = 'typed-envelope-v1';
export const CAPTURE_PROFILE_RASTER = 'raster-target-v1';
export const CAPTURE_PROFILE_NESTED_PAIR = 'nested-object-affine-capture-v1';
export const CAPTURE_PROFILE_CROSSWORD_SET = 'crossword-generation-raster-v1';
/** Whole-document history capture: the accepted snapshot plus semantic-role facts. */
export const CAPTURE_PROFILE_HISTORY = 'history-whole-document-v1';
/** Whole-document restore capture: source and restored snapshots plus route/raw facts. */
export const CAPTURE_PROFILE_RESTORE = 'restore-whole-document-v1';

/**
 * The nested-object readiness profile (ADR 0013 R9): the accepted Slice 5-A
 * policy unchanged — one monotonic 5,000 ms non-extending deadline, 100 ms
 * signal watchdog, bounded 100/200/250 ms fallback cadence, three stable
 * frames — observing the target and witness pair.
 */
export const NESTED_OBJECT_ACTION_CYCLE_PROFILE: ReadinessProfile = Object.freeze({
  schemaVersion: READINESS_PROFILE_SCHEMA_VERSION,
  profileId: 'nested-object-action-cycle-v1',
  timingCategory: 'INTERACTIVE_RENDER_V1',
  deadlineMs: 5_000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
});

export interface ReadinessProfileRegistration {
  profile: ReadinessProfile;
  captureProfileId: string;
  oracleProfileId: string;
  /** True when the drive must read a pair-explicit typed geometry request. */
  requiresNestedPair: boolean;
  /**
   * True when the drive must collect the three-child generated-Crossword
   * observation set (baseline/repeat/sensitive) before the Oracle runs. Absent
   * for every non-generated binding.
   */
  requiresCrosswordSet?: boolean;
  /**
   * Declared comparison profile id the capture/Oracle pair evaluates. Absent for
   * every non-generated binding.
   */
  comparisonProfileId?: string;
}

export const READINESS_PROFILE_REGISTRY: Readonly<Record<string, ReadinessProfileRegistration>> =
  Object.freeze({
    'action-cycle-v1': Object.freeze({
      profile: ACTION_CYCLE_V1_PROFILE,
      captureProfileId: CAPTURE_PROFILE_SINGLE_TARGET,
      oracleProfileId: 'geometry-delta-v1',
      requiresNestedPair: false,
    }),
    'warped-text-action-cycle-v1': Object.freeze({
      profile: WARPED_TEXT_ACTION_CYCLE_PROFILE,
      captureProfileId: CAPTURE_PROFILE_TYPED_ENVELOPE,
      oracleProfileId: 'warped-text-circle-move-v1',
      requiresNestedPair: false,
    }),
    'image-raster-action-cycle-v1': Object.freeze({
      profile: IMAGE_RASTER_ACTION_CYCLE_PROFILE,
      captureProfileId: CAPTURE_PROFILE_RASTER,
      // P7-A Image reference repair (ADR 0023 §8): the accepted Oracle profile is
      // `image-upload-replace-v1`. No alias named `image-raster-v1` exists.
      oracleProfileId: 'image-upload-replace-v1',
      requiresNestedPair: false,
    }),
    'nested-object-action-cycle-v1': Object.freeze({
      profile: NESTED_OBJECT_ACTION_CYCLE_PROFILE,
      captureProfileId: CAPTURE_PROFILE_NESTED_PAIR,
      oracleProfileId: 'nested-object-move-v1',
      requiresNestedPair: true,
    }),
    'crossword-generation-action-cycle-v1': Object.freeze({
      profile: CROSSWORD_GENERATION_ACTION_CYCLE_PROFILE,
      captureProfileId: CAPTURE_PROFILE_CROSSWORD_SET,
      oracleProfileId: 'crossword-determinism-v1',
      requiresNestedPair: false,
      requiresCrosswordSet: true,
      comparisonProfileId: CROSSWORD_COMPARISON_PROFILE_ID,
    }),
    'history-transition-v1': Object.freeze({
      profile: HISTORY_ACTION_CYCLE_PROFILE,
      captureProfileId: CAPTURE_PROFILE_HISTORY,
      oracleProfileId: 'history-cross-subject-v1',
      requiresNestedPair: false,
    }),
    'frontend-restore-transition-v1': Object.freeze({
      profile: FRONTEND_RESTORE_ACTION_CYCLE_PROFILE,
      captureProfileId: CAPTURE_PROFILE_RESTORE,
      oracleProfileId: 'frontend-restore-v1',
      requiresNestedPair: false,
    }),
  });

/** Resolves one readiness profile registration, or `null` for an unknown id. */
export function resolveReadinessProfile(profileId: string): ReadinessProfileRegistration | null {
  return READINESS_PROFILE_REGISTRY[profileId] ?? null;
}
