/**
 * Generated-Crossword observation contract (ADR 0017 R4–R8; ADR 0018 CR7/CR9).
 *
 * This module owns the closed interpretation of what one generated Crossword
 * drive observes: the per-child accepted execution/currentness DTO, its hostile
 * validator, the governed fixed-wall-clock profile that makes the initial seed
 * reproducible, and the three-child comparison profile identity.
 *
 * Nothing here stores an expected layout or digest of a browser execution. A
 * child is accepted only as *authored observation data* whose semantic payload
 * is validated structurally and whose semantic digest is recomputed here; the
 * Oracle then compares accepted digests only.
 */

import type { ObservationCursor } from './observation';
import {
  CROSSWORD_DEFAULT_WORDS,
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  crosswordWordsFingerprint,
  type CrosswordLayoutSemanticV1,
} from './crossword';
import { readAcceptedRasterAuthority, type GeneratedVectorRasterRecordView } from './raster';
import {
  validateWallClockBaseline,
  WALL_CLOCK_NAMESPACE,
  WALL_CLOCK_PROVIDER_ID,
} from './wall-clock';

/** Versioned shape of one observed generated-Crossword child. */
export const CROSSWORD_OBSERVATION_SCHEMA_VERSION = 1;

/**
 * The three closed execution roles of the determinism comparison (ADR 0017 R2,
 * ADR 0018 CR7). `A1` and `A2` share the same-seed baseline; `B` is the
 * different-seed control. No public or authoritative alias is retained.
 */
export const CROSSWORD_EXECUTION_ROLES = ['A1', 'A2', 'B'] as const;
export type CrosswordExecutionRole = (typeof CROSSWORD_EXECUTION_ROLES)[number];

/** Declared semantic profile that routes a generated role to this contract. */
export const CROSSWORD_SEMANTIC_PROFILE = 'crossword-semantic-v1';

/** Versioned clock profile that pins the per-child initial seed (ADR 0017 R3). */
export const CROSSWORD_CLOCK_PROFILE_ID = 'crossword-create-comparison-clock-v1';
export const CROSSWORD_CLOCK_PROFILE_SCHEMA_VERSION = 1;
export const CROSSWORD_CLOCK_BASELINE_COUNT = CROSSWORD_EXECUTION_ROLES.length;

/** Release baseline epochs (ADR 0017 R2): A1/A2 same, B distinct. */
export const CROSSWORD_RELEASE_EPOCHS: readonly number[] = Object.freeze([
  1767323045000, 1767323045000, 123456789,
]);

/** Capture recipe and comparison profile identities for this binding. */
export const CROSSWORD_GENERATION_CAPTURE_PROFILE_ID = 'crossword-generation-raster-v1';
export const CROSSWORD_COMPARISON_PROFILE_ID = 'crossword-determinism-comparison-v1';

/** The six required authoritative checks of `crossword-determinism-v1`. */
export const CROSSWORD_REQUIRED_CHECKS = [
  'crossword.created',
  'crossword.seed-derived',
  'crossword.semantic-valid',
  'crossword.same-seed-repeatable',
  'crossword.different-seed-sensitive',
  'crossword.raster-current',
] as const;
export type CrosswordRequiredCheck = (typeof CROSSWORD_REQUIRED_CHECKS)[number];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isExecutionRole(value: unknown): value is CrosswordExecutionRole {
  return (CROSSWORD_EXECUTION_ROLES as readonly string[]).includes(value as string);
}

/** Closed malformed/currentness classification vocabulary for this contract. */
export const CROSSWORD_OBSERVATION_FINDING_CODES = [
  'CROSSWORD_OBSERVATION_MALFORMED',
  'CROSSWORD_OBSERVATION_ROLE_UNKNOWN',
  'CROSSWORD_OBSERVATION_MISSING',
  'CROSSWORD_OBSERVATION_DUPLICATE',
  'CROSSWORD_SEMANTIC_MALFORMED',
  'CROSSWORD_SOURCE_FINGERPRINT_INVALID',
  'CROSSWORD_CLOCK_PROFILE_INVALID',
  'CROSSWORD_CURRENTNESS_INVALID',
  'CROSSWORD_RASTER_AUTHORITY_UNUSABLE',
] as const;
export type CrosswordObservationFindingCode = (typeof CROSSWORD_OBSERVATION_FINDING_CODES)[number];

export interface CrosswordObservationFinding {
  code: CrosswordObservationFindingCode;
  detail: string;
  context: Readonly<Record<string, string>>;
}

function finding(
  code: CrosswordObservationFindingCode,
  detail: string,
  context: Record<string, string> = {},
): CrosswordObservationFinding {
  return { code, detail, context };
}

/** A structurally well-formed currentness anchor. */
export function isWellFormedObservationCursor(value: unknown): value is ObservationCursor {
  if (!isRecord(value)) return false;
  return (
    typeof value.schemaVersion === 'number' &&
    isNonEmptyString(value.documentId) &&
    isSafeInteger(value.documentEpoch) &&
    value.documentEpoch >= 1 &&
    typeof value.bridgeVersion === 'number' &&
    isSafeInteger(value.bridgeGeneration) &&
    value.bridgeGeneration >= 1 &&
    isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

// ── Governed clock profile ───────────────────────────────────────────────────

export interface CrosswordClockProfile {
  schemaVersion: typeof CROSSWORD_CLOCK_PROFILE_SCHEMA_VERSION;
  profileId: string;
  providerId: string;
  comparisonProfileId: string;
  baselines: readonly string[];
  epochs: readonly number[];
}

export type CrosswordClockValidation =
  | { ok: true; clock: CrosswordClockProfile }
  | { ok: false; finding: CrosswordObservationFinding };

/**
 * Parses one governed clock profile. Exactly three canonical UTC baselines are
 * required: A1 and A2 share the first baseline (same-seed reproducibility) and
 * B uses a distinct baseline (seed sensitivity). A malformed, non-canonical,
 * duplicated, or provider-less profile fails closed before any observation is
 * accepted.
 */
export function parseCrosswordClockProfile(raw: unknown): CrosswordClockValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      finding: finding('CROSSWORD_CLOCK_PROFILE_INVALID', 'Clock profile must be an object.'),
    };
  }
  if (raw.schemaVersion !== CROSSWORD_CLOCK_PROFILE_SCHEMA_VERSION) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        `Clock profile schema ${String(raw.schemaVersion)} is not ${CROSSWORD_CLOCK_PROFILE_SCHEMA_VERSION}.`,
      ),
    };
  }
  if (raw.profileId !== CROSSWORD_CLOCK_PROFILE_ID) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        `Clock profile id "${String(raw.profileId)}" is not "${CROSSWORD_CLOCK_PROFILE_ID}".`,
      ),
    };
  }
  if (raw.providerId !== WALL_CLOCK_PROVIDER_ID) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        `Clock provider "${String(raw.providerId)}" is not the honest fixed-wall provider "${WALL_CLOCK_PROVIDER_ID}".`,
      ),
    };
  }
  if (
    raw.comparisonProfileId !== undefined &&
    raw.comparisonProfileId !== CROSSWORD_COMPARISON_PROFILE_ID
  ) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        `Clock profile comparison id "${String(raw.comparisonProfileId)}" is not "${CROSSWORD_COMPARISON_PROFILE_ID}".`,
      ),
    };
  }
  if (!Array.isArray(raw.baselines) || raw.baselines.length !== CROSSWORD_CLOCK_BASELINE_COUNT) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        `Clock profile must declare exactly ${CROSSWORD_CLOCK_BASELINE_COUNT} baselines.`,
      ),
    };
  }
  const baselines: string[] = [];
  const epochs: number[] = [];
  for (const [index, baseline] of raw.baselines.entries()) {
    const validation = validateWallClockBaseline(baseline);
    if (!validation.ok) {
      return {
        ok: false,
        finding: finding('CROSSWORD_CLOCK_PROFILE_INVALID', validation.detail, {
          index: String(index),
        }),
      };
    }
    baselines.push(validation.utc);
    epochs.push(validation.epochMs);
  }
  if (epochs[0] !== epochs[1]) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        'The A1 and A2 children must share the exact same clock baseline for same-seed reproducibility.',
      ),
    };
  }
  if (epochs[2] === epochs[0]) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        'The B child must use a distinct clock baseline for seed sensitivity.',
      ),
    };
  }
  return {
    ok: true,
    clock: {
      schemaVersion: CROSSWORD_CLOCK_PROFILE_SCHEMA_VERSION,
      profileId: CROSSWORD_CLOCK_PROFILE_ID,
      providerId: WALL_CLOCK_PROVIDER_ID,
      comparisonProfileId: CROSSWORD_COMPARISON_PROFILE_ID,
      baselines,
      epochs,
    },
  };
}

// ── Per-child currentness / accepted execution evidence (ADR 0017 R10) ───────

export interface CrosswordGenerationCurrentnessV1 {
  schemaVersion: 1;
  documentId: string;
  documentEpoch: number;
  bridgeGeneration: number;
  observationRevision: number;
  actionEpochId: string;
  hostLayoutId: string;
  createdTargetId: string;
  generationSeed: number;
  wordsFingerprint: string;
  semanticLayoutDigest: string;
  rendererFingerprint: string;
  rasterFingerprint: string;
}

export interface CrosswordTransitionFactsV1 {
  preActionHostCrosswordCount: number;
  postActionHostCrosswordCount: number;
  newTargetCount: number;
  historyPastDepthBefore: number;
  historyPastDepthAfter: number;
}

export interface CrosswordClockFactsV1 {
  providerId: string;
  namespace: string;
  baselineUtc: string;
  expectedSeed: number;
}

/**
 * Accepted live target geometry for the created Crossword, in stage-viewport
 * CSS pixels (ADR 0017 R14). It is the authority the mounted-node projection
 * region must agree with within `RENDER_TRANSFORM_CSS` (`0.25` CSS px).
 */
export interface CrosswordTargetGeometryV1 {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Authored raw shape of one observed child. */
export interface CrosswordExecutionChildInput {
  schemaVersion: typeof CROSSWORD_OBSERVATION_SCHEMA_VERSION;
  executionRole: CrosswordExecutionRole;
  clock: CrosswordClockFactsV1;
  sourceContractFingerprint: string;
  transition: CrosswordTransitionFactsV1;
  currentness: CrosswordGenerationCurrentnessV1;
  actualSeed: number;
  words: readonly string[];
  layout: unknown;
  semanticDigest: string;
  targetGeometry: CrosswordTargetGeometryV1;
  raster: unknown;
  observationId: string;
  tornRecaptureCount: number;
  contextClosed: boolean;
}

export interface ValidatedCrosswordExecution {
  executionRole: CrosswordExecutionRole;
  clock: CrosswordClockFactsV1;
  sourceContractFingerprint: string;
  transition: CrosswordTransitionFactsV1;
  currentness: CrosswordGenerationCurrentnessV1;
  actualSeed: number;
  words: readonly string[];
  omittedWords: readonly string[];
  semantic: CrosswordLayoutSemanticV1;
  semanticDigest: string;
  targetGeometry: CrosswordTargetGeometryV1;
  raster: GeneratedVectorRasterRecordView;
  observationId: string;
  tornRecaptureCount: number;
  contextClosed: boolean;
}

export type CrosswordChildValidation =
  | { ok: true; child: ValidatedCrosswordExecution }
  | { ok: false; finding: CrosswordObservationFinding };

function validateCurrentness(
  raw: unknown,
  role: CrosswordExecutionRole,
):
  | { ok: true; currentness: CrosswordGenerationCurrentnessV1 }
  | { ok: false; finding: CrosswordObservationFinding } {
  if (!isRecord(raw)) {
    return {
      ok: false,
      finding: finding('CROSSWORD_CURRENTNESS_INVALID', 'Child currentness must be an object.', {
        role,
      }),
    };
  }
  if (raw.schemaVersion !== 1) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        `Child currentness schema ${String(raw.schemaVersion)} is not 1.`,
        { role },
      ),
    };
  }
  const stringFields = ['documentId', 'actionEpochId', 'hostLayoutId', 'createdTargetId'];
  for (const field of stringFields) {
    if (!isNonEmptyString(raw[field])) {
      return {
        ok: false,
        finding: finding(
          'CROSSWORD_CURRENTNESS_INVALID',
          `Child currentness field "${field}" must be a non-empty string.`,
          { role },
        ),
      };
    }
  }
  if (!isSafeInteger(raw.documentEpoch) || raw.documentEpoch < 1) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'documentEpoch must be a positive safe integer.',
        { role },
      ),
    };
  }
  if (!isSafeInteger(raw.bridgeGeneration) || raw.bridgeGeneration < 1) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'bridgeGeneration must be a positive safe integer.',
        { role },
      ),
    };
  }
  if (!isSafeInteger(raw.observationRevision) || raw.observationRevision < 0) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'observationRevision must be a non-negative safe integer.',
        { role },
      ),
    };
  }
  if (!isSafeInteger(raw.generationSeed)) {
    return {
      ok: false,
      finding: finding('CROSSWORD_CURRENTNESS_INVALID', 'generationSeed must be a safe integer.', {
        role,
      }),
    };
  }
  if (typeof raw.wordsFingerprint !== 'string' || !SHA256_HEX_PATTERN.test(raw.wordsFingerprint)) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'wordsFingerprint must be a lowercase SHA-256.',
        { role },
      ),
    };
  }
  if (
    typeof raw.semanticLayoutDigest !== 'string' ||
    !SHA256_HEX_PATTERN.test(raw.semanticLayoutDigest)
  ) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'semanticLayoutDigest must be a lowercase SHA-256.',
        { role },
      ),
    };
  }
  if (!isNonEmptyString(raw.rendererFingerprint)) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'rendererFingerprint must be a non-empty string.',
        { role },
      ),
    };
  }
  if (!isNonEmptyString(raw.rasterFingerprint)) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'rasterFingerprint must be a non-empty string.',
        { role },
      ),
    };
  }
  return { ok: true, currentness: raw as unknown as CrosswordGenerationCurrentnessV1 };
}

/**
 * Validates one child execution. A malformed coordinate/role/currentness shape,
 * a failed source fingerprint, a structurally inconsistent generated layout, a
 * mismatched actual seed, or an unusable generated-vector raster authority is a
 * precise *unusable-evidence* classification and is never normalized into
 * passing evidence.
 */
export function validateCrosswordExecutionChild(raw: unknown): CrosswordChildValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      finding: finding('CROSSWORD_OBSERVATION_MALFORMED', 'A child observation must be an object.'),
    };
  }
  if (raw.schemaVersion !== CROSSWORD_OBSERVATION_SCHEMA_VERSION) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        `Child observation schema ${String(raw.schemaVersion)} is not ${CROSSWORD_OBSERVATION_SCHEMA_VERSION}.`,
      ),
    };
  }
  if (!isExecutionRole(raw.executionRole)) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_ROLE_UNKNOWN',
        `Child role "${String(raw.executionRole)}" is not one of ${CROSSWORD_EXECUTION_ROLES.join(', ')}.`,
      ),
    };
  }
  const role = raw.executionRole;

  // Clock facts: provider/namespace identity plus exact canonical baseline.
  if (!isRecord(raw.clock)) {
    return {
      ok: false,
      finding: finding('CROSSWORD_CLOCK_PROFILE_INVALID', 'Child clock facts must be an object.', {
        role,
      }),
    };
  }
  if (
    raw.clock.providerId !== WALL_CLOCK_PROVIDER_ID ||
    raw.clock.namespace !== WALL_CLOCK_NAMESPACE
  ) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        'Child clock provider/namespace is not the honest fixed-wall provider.',
        { role },
      ),
    };
  }
  const baseline = validateWallClockBaseline(raw.clock.baselineUtc);
  if (!baseline.ok) {
    return {
      ok: false,
      finding: finding('CROSSWORD_CLOCK_PROFILE_INVALID', baseline.detail, { role }),
    };
  }
  if (!isSafeInteger(raw.clock.expectedSeed) || raw.clock.expectedSeed !== baseline.epochMs) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        'Child expected seed must equal the exact epoch of its canonical baseline.',
        { role },
      ),
    };
  }

  if (
    typeof raw.sourceContractFingerprint !== 'string' ||
    !SHA256_HEX_PATTERN.test(raw.sourceContractFingerprint)
  ) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_SOURCE_FINGERPRINT_INVALID',
        'Child observation declares no 64-hex source-contract fingerprint.',
        { role },
      ),
    };
  }

  // Transition facts: a causal active-host 0 → 1 creation with history advance.
  if (!isRecord(raw.transition)) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'Child transition facts must be an object.',
        { role },
      ),
    };
  }
  const transition = raw.transition as unknown as CrosswordTransitionFactsV1;
  for (const field of [
    'preActionHostCrosswordCount',
    'postActionHostCrosswordCount',
    'newTargetCount',
    'historyPastDepthBefore',
    'historyPastDepthAfter',
  ] as const) {
    if (!isSafeInteger(transition[field])) {
      return {
        ok: false,
        finding: finding(
          'CROSSWORD_OBSERVATION_MALFORMED',
          `transition.${field} must be a safe integer.`,
          { role },
        ),
      };
    }
  }
  if (
    transition.preActionHostCrosswordCount !== 0 ||
    transition.postActionHostCrosswordCount !== 1 ||
    transition.newTargetCount !== 1 ||
    transition.historyPastDepthBefore !== 0 ||
    transition.historyPastDepthAfter <= transition.historyPastDepthBefore
  ) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'Child must prove a causal active-host 0 → 1 creation with exactly one new target and a history advance.',
        { role },
      ),
    };
  }

  const currentnessValidation = validateCurrentness(raw.currentness, role);
  if (!currentnessValidation.ok) return { ok: false, finding: currentnessValidation.finding };
  const currentness = currentnessValidation.currentness;

  // Accepted live target geometry (ADR 0017 R14). It must describe the exact
  // created target with positive finite stage-viewport CSS dimensions; the
  // Oracle then requires the raster projection region to agree with it.
  if (!isRecord(raw.targetGeometry)) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'Child declares no accepted live target geometry.',
        { role },
      ),
    };
  }
  const geometryRecord = raw.targetGeometry;
  if (!isNonEmptyString(geometryRecord.id)) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'Child target geometry declares no target id.',
        { role },
      ),
    };
  }
  const geometryNumbers = [
    geometryRecord.x,
    geometryRecord.y,
    geometryRecord.width,
    geometryRecord.height,
  ];
  if (!geometryNumbers.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'Child target geometry must publish finite x/y/width/height.',
        { role },
      ),
    };
  }
  if ((geometryRecord.width as number) <= 0 || (geometryRecord.height as number) <= 0) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'Child target geometry dimensions must be positive.',
        { role },
      ),
    };
  }
  if (geometryRecord.id !== currentness.createdTargetId) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'Child target geometry id does not equal currentness.createdTargetId.',
        { role },
      ),
    };
  }
  const targetGeometry: CrosswordTargetGeometryV1 = {
    id: geometryRecord.id,
    x: geometryRecord.x as number,
    y: geometryRecord.y as number,
    width: geometryRecord.width as number,
    height: geometryRecord.height as number,
  };

  if (!isSafeInteger(raw.actualSeed) || raw.actualSeed !== currentness.generationSeed) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_CURRENTNESS_INVALID',
        'Child actual product seed must be a safe integer equal to currentness.generationSeed.',
        { role },
      ),
    };
  }

  if (!Array.isArray(raw.words) || !raw.words.every((word) => typeof word === 'string')) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_SEMANTIC_MALFORMED',
        'Child observation declares no complete ordered word list.',
        { role },
      ),
    };
  }
  const words = raw.words as readonly string[];
  const structural = crosswordSemanticPayloadFromLayerShape({ words, layout: raw.layout }, words);
  if (!structural.ok || structural.payload === null) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_SEMANTIC_MALFORMED',
        structural.findings.map((entry) => `${entry.code}: ${entry.detail}`).join('; ') ||
          'The generated layout is structurally inconsistent.',
        { role },
      ),
    };
  }
  const semanticDigest = crosswordSemanticDigest(structural.payload);
  if (
    typeof raw.semanticDigest !== 'string' ||
    raw.semanticDigest !== semanticDigest ||
    currentness.semanticLayoutDigest !== semanticDigest
  ) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_SEMANTIC_MALFORMED',
        'Child semantic digest does not equal the recomputed structural digest or the currentness digest.',
        { role },
      ),
    };
  }
  const wordsFingerprint = crosswordWordsFingerprint(structural.payload.words);
  if (currentness.wordsFingerprint !== wordsFingerprint) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_SEMANTIC_MALFORMED',
        'Child currentness wordsFingerprint does not equal the recomputed word fingerprint.',
        { role },
      ),
    };
  }

  const rasterAuthority = readAcceptedRasterAuthority(raw.raster);
  if (!rasterAuthority.ok || rasterAuthority.record === null) {
    return {
      ok: false,
      finding: finding('CROSSWORD_RASTER_AUTHORITY_UNUSABLE', rasterAuthority.detail, { role }),
    };
  }
  const raster = rasterAuthority.record;
  if (raster.authorityKind !== 'generated-vector-projection-v1' || raster.kind !== 'crossword') {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_RASTER_AUTHORITY_UNUSABLE',
        'Child raster authority is not a generated-vector Crossword projection.',
        { role },
      ),
    };
  }
  if (raster.id !== currentness.createdTargetId) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_RASTER_AUTHORITY_UNUSABLE',
        'Child raster target id does not equal currentness.createdTargetId.',
        { role },
      ),
    };
  }
  if (!raster.mounted || raster.rasterFingerprint !== currentness.rasterFingerprint) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_RASTER_AUTHORITY_UNUSABLE',
        'Child raster authority is not a mounted record whose fingerprint equals currentness.rasterFingerprint.',
        { role },
      ),
    };
  }
  if (raster.renderer.targetFingerprint !== currentness.rendererFingerprint) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_RASTER_AUTHORITY_UNUSABLE',
        'Child raster renderer fingerprint does not equal currentness.rendererFingerprint.',
        { role },
      ),
    };
  }

  if (!isNonEmptyString(raw.observationId)) {
    return {
      ok: false,
      finding: finding('CROSSWORD_OBSERVATION_MALFORMED', 'Child declares no observation id.', {
        role,
      }),
    };
  }
  if (!isSafeInteger(raw.tornRecaptureCount) || raw.tornRecaptureCount < 0) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'tornRecaptureCount must be a non-negative safe integer.',
        { role },
      ),
    };
  }
  if (typeof raw.contextClosed !== 'boolean' || raw.contextClosed !== true) {
    return {
      ok: false,
      finding: finding(
        'CROSSWORD_OBSERVATION_MALFORMED',
        'Child must have completed its fresh context/browser closure.',
        { role },
      ),
    };
  }

  return {
    ok: true,
    child: {
      executionRole: role,
      clock: {
        providerId: WALL_CLOCK_PROVIDER_ID,
        namespace: WALL_CLOCK_NAMESPACE,
        baselineUtc: baseline.utc,
        expectedSeed: baseline.epochMs,
      },
      sourceContractFingerprint: raw.sourceContractFingerprint,
      transition,
      currentness,
      actualSeed: raw.actualSeed,
      words: structural.payload.words,
      omittedWords: structural.payload.layout.omittedWords,
      semantic: structural.payload,
      semanticDigest,
      targetGeometry,
      raster,
      observationId: raw.observationId,
      tornRecaptureCount: raw.tornRecaptureCount,
      contextClosed: true,
    },
  };
}

// ── Three-child execution set ────────────────────────────────────────────────

export interface CrosswordExecutionSet {
  clock: CrosswordClockProfile;
  sourceFingerprintExpected: string;
  executions: readonly ValidatedCrosswordExecution[];
}

export type CrosswordExecutionSetValidation =
  | { ok: true; set: CrosswordExecutionSet }
  | { ok: false; findings: readonly CrosswordObservationFinding[] };

export interface CrosswordExecutionSetInput {
  clock: unknown;
  sourceFingerprintExpected: string;
  executions: readonly unknown[];
}

/**
 * Validates the complete three-child execution set: exactly one child per
 * execution role, pairwise-distinct document identities (no shared
 * document/epoch may satisfy two children), one shared accepted source
 * fingerprint, and clock/child seed agreement.
 */
export function validateCrosswordExecutionSet(raw: unknown): CrosswordExecutionSetValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      findings: [finding('CROSSWORD_OBSERVATION_MALFORMED', 'Execution set must be an object.')],
    };
  }
  const findings: CrosswordObservationFinding[] = [];

  const clockValidation = parseCrosswordClockProfile(raw.clock);
  if (!clockValidation.ok) {
    return { ok: false, findings: [clockValidation.finding] };
  }

  if (
    typeof raw.sourceFingerprintExpected !== 'string' ||
    !SHA256_HEX_PATTERN.test(raw.sourceFingerprintExpected)
  ) {
    return {
      ok: false,
      findings: [
        finding(
          'CROSSWORD_SOURCE_FINGERPRINT_INVALID',
          'Execution set declares no 64-hex expected source-contract fingerprint.',
        ),
      ],
    };
  }

  if (!Array.isArray(raw.executions)) {
    return {
      ok: false,
      findings: [
        finding('CROSSWORD_OBSERVATION_MALFORMED', 'Execution set children must be an array.'),
      ],
    };
  }

  const executions: ValidatedCrosswordExecution[] = [];
  const seenRoles = new Set<CrosswordExecutionRole>();
  const seenDocuments = new Set<string>();
  const seenObservations = new Set<string>();
  for (const [index, entry] of raw.executions.entries()) {
    const validation = validateCrosswordExecutionChild(entry);
    if (!validation.ok) {
      findings.push({
        ...validation.finding,
        context: { ...validation.finding.context, index: String(index) },
      });
      continue;
    }
    const child = validation.child;
    if (seenRoles.has(child.executionRole)) {
      findings.push(
        finding(
          'CROSSWORD_OBSERVATION_DUPLICATE',
          `Child role "${child.executionRole}" occurs more than once; a repeated execution earns no credit.`,
          { role: child.executionRole },
        ),
      );
      continue;
    }
    if (seenDocuments.has(child.currentness.documentId)) {
      findings.push(
        finding(
          'CROSSWORD_OBSERVATION_DUPLICATE',
          `Child document id "${child.currentness.documentId}" is reused across roles; one fresh execution cannot satisfy two children.`,
          { role: child.executionRole },
        ),
      );
      continue;
    }
    if (seenObservations.has(child.observationId)) {
      findings.push(
        finding(
          'CROSSWORD_OBSERVATION_DUPLICATE',
          `Child observation id "${child.observationId}" is reused across roles.`,
          { role: child.executionRole },
        ),
      );
      continue;
    }
    seenRoles.add(child.executionRole);
    seenDocuments.add(child.currentness.documentId);
    seenObservations.add(child.observationId);
    executions.push(child);
  }

  for (const role of CROSSWORD_EXECUTION_ROLES) {
    if (!seenRoles.has(role)) {
      findings.push(
        finding('CROSSWORD_OBSERVATION_MISSING', `Execution set is missing the "${role}" child.`, {
          role,
        }),
      );
    }
  }

  if (findings.length > 0) return { ok: false, findings };

  const ordered = CROSSWORD_EXECUTION_ROLES.map(
    (role) =>
      executions.find((child) => child.executionRole === role) as ValidatedCrosswordExecution,
  );
  // Child clock baselines must agree with the governed profile, in order.
  for (const [index, child] of ordered.entries()) {
    if (child.clock.expectedSeed !== clockValidation.clock.epochs[index]) {
      findings.push(
        finding(
          'CROSSWORD_CLOCK_PROFILE_INVALID',
          `Child "${child.executionRole}" expected seed does not equal governed baseline ${index}.`,
          { role: child.executionRole },
        ),
      );
    }
  }
  if (findings.length > 0) return { ok: false, findings };

  return {
    ok: true,
    set: {
      clock: clockValidation.clock,
      sourceFingerprintExpected: raw.sourceFingerprintExpected,
      executions: ordered,
    },
  };
}

/**
 * True when every child carries the exact structured-error-free default word
 * list. This is the `crossword.semantic-valid` word-set authority; the digest
 * and structural validity are already guaranteed by acceptance.
 */
export function crosswordWordsAreAuthoritative(child: ValidatedCrosswordExecution): boolean {
  if (child.omittedWords.length > 0) return false;
  if (child.words.length !== CROSSWORD_DEFAULT_WORDS.length) return false;
  return child.words.every(
    (word, index) => word === CROSSWORD_DEFAULT_WORDS[index]?.normalize('NFC'),
  );
}
