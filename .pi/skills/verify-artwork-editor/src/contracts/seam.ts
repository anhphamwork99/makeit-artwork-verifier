import type { DiagnosticCode, DiagnosticRecord } from './diagnostics';
import { createDiagnostic } from './diagnostics';

/**
 * Versioned setup-boundary seam contract (TS-3, Gate C).
 *
 * This module is the toolkit-side authority for the one-shot setup boundary the
 * product exposes at `window.__MAKEIT_ARTWORK_SETUP__`. It mirrors the closed
 * vocabularies the product publishes, without importing product source at
 * runtime, so the harness can deliver one authorization, read one seal record,
 * map every refusal onto a blocking diagnostic, and prove that setup facts earn
 * no Capability or Coverage Obligation credit.
 *
 * A setup fact is precondition state, never evidence of seller behavior. Nothing
 * in this contract may be used to satisfy a required check.
 */

/** Version of the setup-boundary seam contract itself. */
export const SETUP_SEAM_SCHEMA_VERSION = 1;

/** The visible setup global. Must never be the observation bridge's global. */
export const SETUP_GLOBAL_NAME = '__MAKEIT_ARTWORK_SETUP__';

/** The read-only observation bridge global, for the separation assertion. */
export const OBSERVATION_GLOBAL_NAME = '__MAKEIT_ARTWORK_VERIFICATION__';

/**
 * Expected observation bridge contract version for WP5 Slice 5-E. A live v6
 * bridge is unsupported and blocks before any setup or tested action; no v6/v7
 * compatibility parser, synchronous raster alias, or dual global exists.
 */
export const OBSERVATION_BRIDGE_VERSION = 7;

/** Observation cursor schema expected by Doctor v3 and coherent capture. */
export const OBSERVATION_CURSOR_SCHEMA_VERSION = 1;

/** The closed v7 read-only method allowlist (unchanged eight-method surface). */
export const OBSERVATION_BRIDGE_READ_ONLY_METHODS = [
  'doctor',
  'snapshot',
  'elements',
  'geometry',
  'raster',
  'cursor',
  'waitForChange',
  'waitForIdle',
] as const;
export type ObservationBridgeMethod = (typeof OBSERVATION_BRIDGE_READ_ONLY_METHODS)[number];

/** Closed cursor invalidation vocabulary (bridge v3 `waitForChange`). */
export const OBSERVATION_CURSOR_INVALIDATION_REASONS = [
  'document-mismatch',
  'document-epoch-mismatch',
  'bridge-version-mismatch',
  'bridge-generation-mismatch',
  'bridge-unmounted',
] as const;
export type ObservationCursorInvalidationReason =
  (typeof OBSERVATION_CURSOR_INVALIDATION_REASONS)[number];

/**
 * Registered-Symbol description of the harness-controlled broker slot. The
 * harness installs it once per browser Document after load; it is not an init
 * script, so a reload never re-delivers it.
 */
export const SETUP_BROKER_KEY_DESCRIPTION = 'makeit.artwork-setup.broker';

/** The only route the setup seam is available on. */
export const SETUP_ROUTE = '/artwork/editor';

/** Raw capability shape the broker must hold: 32 random bytes, lowercase hex. */
export const SETUP_AUTHORIZATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Full case lifecycle (production specification 9.1). */
export const SETUP_LIFECYCLE_STATES = [
  'ALLOCATED',
  'SETUP_OPEN',
  'SETUP_COMPLETE',
  'SEALED',
  'TESTING',
  'OBSERVING',
  'CLEANUP',
] as const;
export type SetupLifecycleState = (typeof SETUP_LIFECYCLE_STATES)[number];

/** The lifecycle states the product seam holds and can be observed in. */
export const SETUP_BOUNDARY_STATES = ['SETUP_OPEN', 'SETUP_COMPLETE', 'SEALED'] as const;
export type SetupBoundaryState = (typeof SETUP_BOUNDARY_STATES)[number];

/** The lifecycle order a sealed construction must have passed through. */
export const SETUP_CONSTRUCTION_LIFECYCLE_TRACE = [
  'SETUP_OPEN',
  'SETUP_COMPLETE',
  'SEALED',
] as const satisfies readonly SetupBoundaryState[];

/**
 * Closed refusal vocabulary. Every code is `HARNESS_BLOCKED`-compatible: a
 * refusal is a harness contract failure, never a product `BUG` and never an
 * `ENVIRONMENT_FAILURE`.
 */
export const SETUP_REFUSAL_CODES = [
  'SETUP_ALREADY_SEALED',
  'SETUP_AUTHORIZATION_INVALID',
  'SETUP_AUTHORIZATION_MISSING',
  'SETUP_CONSTRUCTOR_UNKNOWN',
  'SETUP_CONSTRUCTOR_VERSION_MISMATCH',
  'FIXTURE_NOT_NORMALIZED',
  'SETUP_GATE_DISABLED',
  'SETUP_HYDRATE_REJECTED',
  'SETUP_INPUT_INVALID',
  'SETUP_REQUEST_INVALID',
  'SETUP_ROUTE_INVALID',
  'SETUP_SCOPE_MISMATCH',
] as const;
export type SetupRefusalCode = (typeof SETUP_REFUSAL_CODES)[number];

/** The scope dimension a `SETUP_SCOPE_MISMATCH` must name. */
export const SETUP_SCOPE_DIMENSIONS = ['run', 'case', 'document', 'origin'] as const;
export type SetupScopeDimension = (typeof SETUP_SCOPE_DIMENSIONS)[number];

/** Constructor ids the product registry may publish at this seam version. */
export const SETUP_CONSTRUCTOR_IDS = [
  'artwork.two-layout-text.v1',
  'artwork.two-layout-text.v2',
  'artwork.two-layout-image.v1',
  'artwork.nested-object.v2',
  'artwork.nested-object.normalization-negative.v1',
] as const;
export type SetupConstructorId = (typeof SETUP_CONSTRUCTOR_IDS)[number];

/** Module-private normalization literal profiles (ADR 0016 R4). */
export const SETUP_NORMALIZATION_LITERAL_PROFILES = [
  'normalized-v2',
  'known-malformed-v1-negative',
] as const;
export type SetupNormalizationLiteralProfile =
  (typeof SETUP_NORMALIZATION_LITERAL_PROFILES)[number];

/** Closed certificate refusal vocabulary the setup boundary may publish. */
export const SETUP_NORMALIZATION_REFUSAL_REASONS = [
  'FIXTURE_NOT_FIXED_POINT',
  'NEGATIVE_FIXTURE_LITERALS_MISMATCH',
  'FIXTURE_INPUT_MUTATED',
  'NEGATIVE_FIXTURE_UNEXPECTEDLY_NORMALIZED',
  'FIXTURE_LAYOUT_MISSING',
  'FIXTURE_LITERALS_MISMATCH',
  'FIXTURE_NORMALIZATION_NOT_REFERENTIAL',
  'CERTIFICATE_INCONSISTENT',
] as const;
export type SetupNormalizationRefusalReason = (typeof SETUP_NORMALIZATION_REFUSAL_REASONS)[number];

/** The only refusal code that carries the closed setup-refusal projection. */
export const SETUP_REFUSAL_PROJECTION_CODE = 'FIXTURE_NOT_NORMALIZED' as const;

/** Safe correlation facts for one normalization subtree (ADR 0016 R7). */
export interface SetupNormalizationGroupEvidence {
  inputFingerprint: string;
  normalizedFingerprint: string;
  fixedPoint: boolean;
}

/**
 * Closed pre-hydration setup-refusal projection (ADR 0016 R7) minus the five
 * runner-owned phase counters. Raw Layouts, layers, transforms, absolute paths,
 * authorization data, globals and unrestricted contexts are prohibited.
 */
export interface SetupNormalizationRefusalEvidence {
  phase: 'pre-hydration';
  code: typeof SETUP_REFUSAL_PROJECTION_CODE;
  reason: SetupNormalizationRefusalReason;
  constructorId: string;
  constructorVersion: number;
  fixtureId: string;
  fixtureVersion: number;
  certificateVersion: string;
  normalizationFunction: 'normalizeArtworkGroupFrames';
  literalProfile: 'known-malformed-v1-negative';
  expectedLiteralsMatched: boolean;
  active: SetupNormalizationGroupEvidence;
  control: SetupNormalizationGroupEvidence;
  inputGraphUnchanged: boolean;
  historyMutationCount: 0;
  mutationApplied: false;
  authorizationConsumed: true;
  lifecycle: 'SEALED';
  sealCreated: false;
  constructAttemptCount: 1;
  hydrateCallCount: 0;
  storeMutationCount: 0;
}

/**
 * The complete public run-record projection: the product evidence plus the five
 * runner-owned phase counters, which are exact zeros/false because no behavior
 * phase was entered (ADR 0016 R6/R7).
 */
export interface SetupRefusalPublicProjection extends SetupNormalizationRefusalEvidence {
  targetResolutionCount: 0;
  readinessEntered: false;
  observationCaptureCount: 0;
  oracleExecutionCount: 0;
  nativePointerDispatchCount: 0;
}

/** The status projections a boundary may report for its authorization. */
export const SETUP_AUTHORIZATION_STATES = ['absent', 'available', 'consumed'] as const;
export type SetupAuthorizationState = (typeof SETUP_AUTHORIZATION_STATES)[number];

/** Proof that a setup fact is precondition state, not seller-behavior evidence. */
export const SETUP_EVIDENCE_ROLE = 'setup-only';

/**
 * Channels the raw capability must never reach (production specification 9.1).
 * Any occurrence is a non-weakening failure, not a warning.
 */
export const SETUP_FORBIDDEN_TRANSPORT_CHANNELS = [
  'cookie',
  'environment',
  'evidence',
  'indexedDb',
  'localStorage',
  'log',
  'query',
  'sealRecord',
  'sessionStorage',
  'setupRecord',
  'url',
] as const;
export type SetupForbiddenTransportChannel = (typeof SETUP_FORBIDDEN_TRANSPORT_CHANNELS)[number];

// ── Observed seam shapes ─────────────────────────────────────────────────────

export interface SetupScope {
  runId: string;
  caseId: string;
}

export interface SetupConstructRequest {
  constructorId: string;
  constructorVersion: number;
  scope: SetupScope;
  inputs: Record<string, unknown>;
}

export interface SetupRefusal {
  ok: false;
  outcome: 'refused';
  code: SetupRefusalCode;
  detail: string;
  context: Record<string, string>;
  mutationApplied: boolean;
  authorizationConsumed: boolean;
  lifecycle: SetupBoundaryState;
  at: string;
  /** Present only for a dedicated negative-normalization refusal (ADR 0016 R7). */
  normalizationRefusal?: SetupNormalizationRefusalEvidence;
}

export interface SetupSealRecord {
  schemaVersion: number;
  boundaryVersion: number;
  outcome: 'constructed';
  route: string;
  origin: string;
  authorization: { id: string; consumed: true };
  scope: SetupScope;
  document: { documentId: string; documentEpoch: number };
  constructor: {
    id: string;
    version: number;
    fixtureId: string;
    fixtureVersion: number;
  };
  fingerprints: { algorithm: string; content: string; layoutItems: string };
  environmentFingerprint: string;
  semanticPrecondition: {
    layoutCount: number;
    layerCount: number;
    nodeCount: number;
    activeLayoutId: string;
    selectedLayoutIds: string[];
  };
  historyBaseline: { pastDepth: number; futureDepth: number; baselineClean: boolean };
  normalizationCertificate: {
    certificateVersion: string;
    normalizationFunction: string;
    skipGroupIds: readonly string[];
    active: {
      exactInputFingerprint: string;
      exactNormalizedFingerprint: string;
      deepEqual: true;
      referentiallyUnchanged: true;
    };
    control: {
      exactInputFingerprint: string;
      exactNormalizedFingerprint: string;
      deepEqual: true;
      referentiallyUnchanged: true;
    };
    expectedLiteralsMatched: true;
    inputGraphUnchanged: true;
    historyMutationCount: 0;
  } | null;
  mutationSummary: { constructCalls: 1; hydrateCalls: 1 };
  sealedAt: string;
  sealedAtEpochMs: number;
}

export interface SetupStatusFacts {
  boundaryVersion: number;
  sealSchemaVersion: number;
  globalName: string;
  route: string;
  routeAllowed: boolean;
  document: { documentId: string; documentEpoch: number };
  lifecycle: SetupBoundaryState;
  lifecycleTrace: SetupBoundaryState[];
  constructAttempted: boolean;
  sealed: boolean;
  authorization: SetupAuthorizationState;
  historyBaselineClean: boolean;
  environment: {
    origin: string;
    route: string;
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    language: string | null;
    timezoneId: string | null;
  };
  environmentFingerprint: string;
}

/** One delivered authorization; the raw `token` never leaves the harness. */
export interface SetupAuthorization {
  authorizationId: string;
  token: string;
  scope: SetupScope;
  origin: string;
  documentId: string;
}

/**
 * Property names a seal/setup record must never carry. The list is deliberately
 * name-based so a shape change cannot quietly reintroduce a raw capability.
 */
export const SETUP_RECORD_FORBIDDEN_KEYS = [
  'capability',
  'capabilityToken',
  'rawAuthorization',
  'secret',
  'token',
] as const;

/** Keys a seal record may carry; anything else is an unversioned addition. */
export const SETUP_SEAL_RECORD_KEYS = [
  'authorization',
  'boundaryVersion',
  'constructor',
  'document',
  'environmentFingerprint',
  'fingerprints',
  'historyBaseline',
  'mutationSummary',
  'normalizationCertificate',
  'origin',
  'outcome',
  'route',
  'schemaVersion',
  'scope',
  'sealedAt',
  'sealedAtEpochMs',
  'semanticPrecondition',
] as const;

/** True when a string is the raw-capability shape the harness mints. */
export function looksLikeSetupAuthorizationToken(value: string): boolean {
  return SETUP_AUTHORIZATION_TOKEN_PATTERN.test(value);
}

/** True when a code is a member of the closed setup refusal vocabulary. */
export function isSetupRefusalCode(value: unknown): value is SetupRefusalCode {
  return typeof value === 'string' && (SETUP_REFUSAL_CODES as readonly string[]).includes(value);
}

/**
 * Maps a product refusal onto the toolkit's blocking diagnostic vocabulary.
 * The code, detail, and bounded context are preserved; the raw capability can
 * never reach the diagnostic because the product never records it.
 */
export function setupRefusalDiagnostic(
  refusal: SetupRefusal,
  hints: { runId?: string; caseId?: string } = {},
): DiagnosticRecord {
  return createDiagnostic(refusal.code as DiagnosticCode, refusal.detail, {
    context: {
      ...refusal.context,
      ...(hints.runId === undefined ? {} : { runId: hints.runId }),
      ...(hints.caseId === undefined ? {} : { caseId: hints.caseId }),
      mutationApplied: String(refusal.mutationApplied),
      lifecycle: refusal.lifecycle,
    },
  });
}

/**
 * Setup facts are precondition state and can never satisfy a required check or
 * a Coverage Obligation. This is the single place that answers the question, so
 * no caller can drift into counting setup as behavior evidence.
 */
export function setupFactsProvideCapabilityEvidence(): false {
  return false;
}

/**
 * The named ADR 0015 live-outcome-5 acceptance test (ADR 0016 R5/R6). Exactly
 * one closed tuple closes it: a live owned launch, an exact pre-hydration
 * `FIXTURE_NOT_NORMALIZED / FIXTURE_NOT_FIXED_POINT` refusal, `behaviorOutcome:
 * null`, final `HARNESS_BLOCKED`, complete cleanup, and every behavior/Oracle
 * counter at its exact zero. Every other refusal reason, code, or non-zero
 * counter is a safe refusal but makes no live acceptance claim.
 */
export function setupRefusalSatisfiesNegativeNormalizationProof(input: {
  setupRefusal: SetupRefusalPublicProjection | null | undefined;
  behaviorOutcome: string | null;
  finalOutcome: string | null;
  launchAttempted: boolean;
  cleanupComplete: boolean;
}): boolean {
  const proof = input.setupRefusal;
  if (!proof) return false;
  return (
    proof.phase === 'pre-hydration' &&
    proof.code === SETUP_REFUSAL_PROJECTION_CODE &&
    proof.reason === 'FIXTURE_NOT_FIXED_POINT' &&
    proof.normalizationFunction === 'normalizeArtworkGroupFrames' &&
    proof.literalProfile === 'known-malformed-v1-negative' &&
    proof.expectedLiteralsMatched === true &&
    proof.active.fixedPoint === false &&
    proof.control.fixedPoint === false &&
    proof.inputGraphUnchanged === true &&
    proof.mutationApplied === false &&
    proof.authorizationConsumed === true &&
    proof.lifecycle === 'SEALED' &&
    proof.sealCreated === false &&
    proof.constructAttemptCount === 1 &&
    proof.hydrateCallCount === 0 &&
    proof.storeMutationCount === 0 &&
    proof.targetResolutionCount === 0 &&
    proof.readinessEntered === false &&
    proof.observationCaptureCount === 0 &&
    proof.oracleExecutionCount === 0 &&
    proof.nativePointerDispatchCount === 0 &&
    input.behaviorOutcome === null &&
    input.finalOutcome === 'HARNESS_BLOCKED' &&
    input.launchAttempted === true &&
    input.cleanupComplete === true
  );
}

/** Validates that a seal record carries no raw capability and no unknown key. */
export function setupSealRecordViolations(
  record: Record<string, unknown>,
  token?: string,
): string[] {
  const violations: string[] = [];
  const forbidden = new Set<string>(SETUP_RECORD_FORBIDDEN_KEYS);
  const allowed = new Set<string>(SETUP_SEAL_RECORD_KEYS);

  for (const key of Object.keys(record)) {
    if (forbidden.has(key)) violations.push(`forbidden-key:${key}`);
    else if (!allowed.has(key)) violations.push(`unknown-key:${key}`);
  }
  const serialized = JSON.stringify(record);
  for (const key of SETUP_RECORD_FORBIDDEN_KEYS) {
    if (serialized.includes(`"${key}"`)) violations.push(`serialized-forbidden-key:${key}`);
  }
  if (token !== undefined && serialized.includes(token)) {
    violations.push('raw-capability-value');
  }
  return violations;
}

/**
 * Scans the channels a capability could leak into. `facts` is everything a run
 * would write or expose; `token` is the raw value the harness minted and must
 * never find again.
 */
export function setupTransportLeaks(
  facts: Readonly<Record<SetupForbiddenTransportChannel, string>>,
  token: string,
): SetupForbiddenTransportChannel[] {
  return SETUP_FORBIDDEN_TRANSPORT_CHANNELS.filter((channel) =>
    (facts[channel] ?? '').includes(token),
  );
}
