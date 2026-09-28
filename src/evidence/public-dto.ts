import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import type { DiagnosticCode, DiagnosticRecord } from '../contracts/diagnostics';
import type { AllocationFailureReason } from '../contracts/discriminants';
import type { WakeSource } from '../contracts/observation';
import type {
  CleanupResult,
  CleanupVerification,
  RunAllocation,
  RunOwnershipRecord,
  RunOwnershipState,
} from '../contracts/runtime';
import {
  SETUP_NORMALIZATION_LITERAL_PROFILES,
  SETUP_NORMALIZATION_REFUSAL_REASONS,
  SETUP_REFUSAL_PROJECTION_CODE,
  type SetupNormalizationRefusalEvidence,
  type SetupRefusalPublicProjection,
} from '../contracts/seam';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_SETUP_CHECKPOINTS,
  productBaselineClean,
} from '../contracts/history-observation';
import { textContainsProhibitedValue } from './guard';

/**
 * Shared public projection vocabulary for the strict v4 current record
 * (ADR 0032 §E3-S2).
 *
 * E3-S2 removed the schema-v2/v3 public run-record authority that used to live
 * in this module. What remains is the closed operational projection vocabulary
 * the strict v4 public record still consumes, plus the legacy evidence
 * projections retained for the frozen executors. Any projection built here is a
 * *closed* allowlisted shape. It never spreads a `RunAllocation`,
 * `RunOwnershipRecord`, `RepoConfigSnapshot`, raw `CleanupResult`,
 * launch/runtime object, or raw `Error`. Absolute private paths are represented
 * only by role-scoped relative names (where a later contract permits one) and by
 * domain-separated correlation fingerprints.
 *
 * The path fingerprints are one-way correlation identifiers, not anonymization
 * and not protection against a dictionary attack: predictable paths can be
 * guessed and compared. They are never cleanup authority, authorization,
 * evidence-integrity verification, or a Gate F claim.
 */

export const PUBLIC_PATH_REF_DOMAIN = 'makeit:public-path-ref:v1';
export const OWNERSHIP_RECORD_FINGERPRINT_DOMAIN = 'makeit:run-ownership-record:v1';

/** Closed roles for a public path correlation fingerprint. */
export const PUBLIC_PATH_ROLES = [
  'repository',
  'skill-root',
  'next-dist-dir',
  'scratch-root',
  'evidence-root',
  'server-log',
  'downloads',
  'temp',
  'config',
  'snapshot',
] as const;
export type PublicPathRole = (typeof PUBLIC_PATH_ROLES)[number];

/** Roles permitted to expose a canonical repository-relative name (R6). */
export const RELATIVE_PATH_ROLES: readonly PublicPathRole[] = ['skill-root', 'next-dist-dir'];

export interface PublicPathRef {
  algorithm: 'sha256';
  domain: typeof PUBLIC_PATH_REF_DOMAIN;
  role: PublicPathRole;
  /** Lowercase 64-hex digest; the preimage is never emitted. */
  digest: string;
}

export interface PublicPathProjection {
  role: PublicPathRole;
  /** Canonical slash-separated relative name; null unless the role permits one. */
  relativePath: string | null;
  fingerprint: PublicPathRef;
}

export interface PublicOwnedResources {
  repository: PublicPathProjection;
  skillRoot: PublicPathProjection;
  nextDistDir: PublicPathProjection;
  scratchRoot: PublicPathProjection;
  evidenceRoot: PublicPathProjection;
  serverLog: PublicPathProjection;
}

export interface PublicOwnershipEstablished {
  status: 'established';
  runId: string;
  ownershipFingerprint: string;
  ownershipState: RunOwnershipState;
  pid: number | null;
  processGroupId: number | null;
  port: number;
  /** Validated loopback app origin (`http://127.0.0.1:<port>`). */
  appOrigin: string;
  routeNamespace: string;
  storageNamespace: string;
  resources: PublicOwnedResources;
}

export interface PublicOwnershipNotEstablished {
  status: 'not-established';
  runId: string;
  allocationFailureCode: AllocationFailureReason;
  /** Requested but explicitly *not owned*; never a PID/process-group claim. */
  requestedPort: { requested: number; owned: false } | null;
}

export type PublicOwnershipProjection = PublicOwnershipEstablished | PublicOwnershipNotEstablished;

export interface PublicCleanupFactDiagnostic {
  code: DiagnosticCode;
  /** Logical resource role only; never a path. */
  resourceRole: string | null;
}

export interface PublicCleanupProjection {
  schemaVersion: number;
  runId: string;
  attempted: boolean;
  complete: boolean;
  alreadyClean: boolean;
  refusedReason: AllocationFailureReason | null;
  facts: {
    processSignalled: boolean;
    processEscalated: boolean;
    processDead: boolean;
    portClosed: boolean;
    distDirRemoved: boolean;
    scratchRemoved: boolean;
    configRestored: boolean;
    browserClosed: boolean;
    evidencePreserved: boolean;
  };
  diagnostics: readonly PublicCleanupFactDiagnostic[];
}

export interface PublicLaunchFacts {
  attempted: boolean;
  pid: number | null;
  processGroupId: number | null;
  readinessMs: number | null;
  /** Single artifact basename inside the owned evidence root; never a path. */
  serverLogArtifactId: string | null;
}

export interface RunRecordFingerprints {
  registry: string;
  applicationInventory: string;
  operationCatalogue: string;
  adapterCatalogue: string;
  workflowCatalogue: string;
  workflowSteps: string;
  coverageModel: string | null;
  readinessProfile: string;
  oracleProfile: string;
}

/**
 * Accepted target-aware idle facts (ADR 0017 R13). Present only for a drive
 * whose readiness reached `waitForIdle`; a blocked drive publishes `null`.
 */
export interface RunRecordIdleFacts {
  targetCount: number;
  stableFrames: number;
  waitedMs: number;
  observationRevision: number;
}

export interface RunRecordReadiness {
  profileId: string;
  timingCategory: string;
  deadlineMs: number;
  wakeSource: WakeSource;
  fallbackPollCount: number;
  watchdogWaits: number;
  rendererStableFrames: number;
  /** Actual target-aware idle result; omitted for non-target-aware drives. */
  idle?: RunRecordIdleFacts | null;
  timings: Readonly<Record<string, number | null>>;
}

// ── Historical public record projections (removed current authority) ─────────
//
// E3-S2 removes the schema-v2/v3 public run-record authority that used to live
// here: `RunRecordCheck`, `PublicRunRecordV2Payload`, `PublicRunRecordV2`,
// `PublicRunRecordV3Payload`, `PublicRunRecordV3`, `PublicRejectionRecordV2`,
// the closed Crossword generation projection and its boolean builder, and the
// boolean `runRecordCheck` builder. The current public DTO is the strict v4
// `FinalPublicRunRecordV4`/`FinalPublicCommandRecordV4` in
// `contracts/final-public-record.ts`, written by `evidence/final-writer.ts`.
//
// What remains below is the shared operational projection vocabulary the strict
// v4 path still consumes (safe path refs, ownership/cleanup/launch projections,
// fingerprints, and readiness), together with the closed history/restore/
// selection-clear evidence projections retained for the frozen executors and
// their historical structural validators. Those retained legacy projections
// still carry the historical boolean required-check shape (`LegacyProjectionCheck`,
// private and deprecated below); it is never current authority and never
// satisfies current acceptance.

/**
 * Private/deprecated boolean required-check shape retained only by the legacy
 * history/restore evidence projections (ADR 0032 §E3-S2). The current check
 * authority is the three-state `CorrectnessCheckResult` carried by the strict
 * v4 nested projections; this shape is never read to derive a current status.
 *
 * @deprecated Legacy boolean projection check; not current authority.
 */
interface LegacyProjectionCheck {
  checkId: string;
  passed: boolean;
  /** Evidence ids this required check consumed. */
  evidenceIds: readonly string[];
}

export class PublicPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicPathError';
  }
}

/** Platform-aware lexical normalization; the input must be an absolute path. */
export function normalizeLexicalAbsolutePath(value: string): string {
  if (value.length === 0) throw new PublicPathError('A public path reference requires a value.');
  const normalized = path.normalize(value);
  if (!path.isAbsolute(normalized)) {
    throw new PublicPathError('A public path reference requires an absolute path.');
  }
  return normalized;
}

/**
 * Domain-separated public path correlation fingerprint (R7). The exact private
 * path for the role is the only preimage; the result is a correlation
 * identifier, never cleanup authority.
 */
export function publicPathFingerprint(
  role: PublicPathRole,
  runId: string,
  absolutePath: string,
): PublicPathRef {
  const normalized = normalizeLexicalAbsolutePath(absolutePath);
  const digest = sha256Hex(`${PUBLIC_PATH_REF_DOMAIN}\0${role}\0${runId}\0${normalized}`);
  return { algorithm: 'sha256', domain: PUBLIC_PATH_REF_DOMAIN, role, digest };
}

/**
 * Correlation fingerprint of the *exact verified private ownership record*
 * (R2). Computed from the exact record that passed ownership and live-process
 * verification—never from the initial allocation or a reconstructed
 * approximation. It is provenance only, never cleanup authority.
 */
export function ownershipRecordFingerprint(record: RunOwnershipRecord): string {
  return sha256Hex(`${OWNERSHIP_RECORD_FINGERPRINT_DOMAIN}\0${canonicalize(record)}`);
}

const ABSOLUTE_POSIX = /^\//;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const UNC_PREFIX = /^(\\\\|\/\/)/;
const ENCODED_SEPARATOR = /%2f|%5c|%252f|%255c/i;
const ENCODED_TRAVERSAL = /%2e%2e|%252e%252e/i;

/**
 * Role-specific relative-path validator (R6). Relative names are canonical
 * slash-separated forms validated *before* record construction; the recursive
 * guard remains only a backstop.
 */
export function validatePublicRelativePath(
  role: PublicPathRole,
  value: string,
  runId: string,
): string {
  if (!(RELATIVE_PATH_ROLES as readonly string[]).includes(role)) {
    throw new PublicPathError(`Role "${role}" may not expose a relative path.`);
  }
  validateRelativeShape(value);
  if (role === 'skill-root' && value !== '.pi/skills/verify-artwork-editor') {
    throw new PublicPathError('skill-root may expose only .pi/skills/verify-artwork-editor.');
  }
  if (role === 'next-dist-dir' && value !== `.next/verify-runs/${runId}`) {
    throw new PublicPathError(`next-dist-dir may expose only .next/verify-runs/${runId}.`);
  }
  return value;
}

function validateRelativeShape(value: string): void {
  if (value.length === 0) throw new PublicPathError('A relative path may not be empty.');
  if (ABSOLUTE_POSIX.test(value))
    throw new PublicPathError('Absolute POSIX paths are not allowed.');
  if (DRIVE_PREFIX.test(value)) throw new PublicPathError('Drive-letter paths are not allowed.');
  if (UNC_PREFIX.test(value)) throw new PublicPathError('UNC paths are not allowed.');
  if (value.includes('\\')) throw new PublicPathError('Backslashes are not allowed.');
  if (value.includes('?') || value.includes('#')) {
    throw new PublicPathError('Query/fragment content is not allowed.');
  }
  if (ENCODED_SEPARATOR.test(value) || ENCODED_TRAVERSAL.test(value)) {
    throw new PublicPathError('Encoded separators or traversal are not allowed.');
  }
  if (/^file:/i.test(value)) throw new PublicPathError('file: forms are not allowed.');
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new PublicPathError(`Segment "${segment}" is not a canonical relative segment.`);
    }
  }
  if (path.posix.normalize(value) !== value) {
    throw new PublicPathError('A relative path must already be canonical.');
  }
}

/** A single artifact basename (no separators, no traversal, no absolutes). */
export function validateArtifactBasename(value: string): string {
  if (value.length === 0) throw new PublicPathError('A basename may not be empty.');
  if (value === '.' || value === '..') throw new PublicPathError('A basename may not be . or ..');
  if (value.includes('/') || value.includes('\\')) {
    throw new PublicPathError('A basename may not contain a separator.');
  }
  validateRelativeShape(value);
  return value;
}

function pathProjection(
  role: PublicPathRole,
  runId: string,
  absolutePath: string,
  relativePath: string | null,
): PublicPathProjection {
  const projected =
    relativePath === null ? null : validatePublicRelativePath(role, relativePath, runId);
  return {
    role,
    relativePath: projected,
    fingerprint: publicPathFingerprint(role, runId, absolutePath),
  };
}

/**
 * Establish an ownership projection from the exact verified private record.
 * `ownershipState` records the state captured before cleanup.
 */
export function buildEstablishedOwnership(
  record: RunOwnershipRecord,
  ownershipState: RunOwnershipState,
  repoRelativeDistDir: string,
  skillRootRelativePath: string,
): PublicOwnershipEstablished {
  return {
    status: 'established',
    runId: record.runId,
    ownershipFingerprint: ownershipRecordFingerprint(record),
    ownershipState,
    pid: record.processPid,
    processGroupId: record.processGroupId,
    port: record.port,
    appOrigin: new URL(record.baseUrl).origin,
    routeNamespace: record.routeNamespace,
    storageNamespace: record.storageNamespace,
    resources: {
      repository: pathProjection('repository', record.runId, record.repoRoot, null),
      skillRoot: pathProjection(
        'skill-root',
        record.runId,
        record.skillRoot,
        skillRootRelativePath,
      ),
      nextDistDir: pathProjection(
        'next-dist-dir',
        record.runId,
        record.distDir,
        repoRelativeDistDir,
      ),
      scratchRoot: pathProjection('scratch-root', record.runId, record.scratchRoot, null),
      evidenceRoot: pathProjection('evidence-root', record.runId, record.evidenceRoot, null),
      serverLog: pathProjection('server-log', record.runId, record.serverLogPath, null),
    },
  };
}

export function buildNotEstablishedOwnership(input: {
  runId: string;
  allocationFailureCode: AllocationFailureReason;
  requestedPort: number | null;
}): PublicOwnershipNotEstablished {
  return {
    status: 'not-established',
    runId: input.runId,
    allocationFailureCode: input.allocationFailureCode,
    requestedPort:
      input.requestedPort === null ? null : { requested: input.requestedPort, owned: false },
  };
}

const CLEANUP_DIAGNOSTIC_RESOURCE_ROLE: Partial<Record<string, string>> = {
  CLEANUP_IO_FAILED: 'owned-resource',
  CLEANUP_INCOMPLETE: 'run-resource',
  CLEANUP_OWNERSHIP_AMBIGUOUS: 'ownership',
  BROWSER_CLEANUP_FAILED: 'browser',
};

/**
 * Allowlisted public cleanup projection (R10). No raw `CleanupResult.detail`,
 * no raw diagnostics, and no absolute paths; incomplete or refused cleanup
 * truth is preserved rather than redacted into apparent success.
 */
export function buildCleanupProjection(result: CleanupResult): PublicCleanupProjection {
  const verification: CleanupVerification = result.verification;
  return {
    schemaVersion: result.schemaVersion,
    runId: result.runId,
    attempted: result.attempted,
    complete: result.complete,
    alreadyClean: result.alreadyClean,
    refusedReason: result.refusedReason,
    facts: {
      processSignalled: verification.processSignalled !== null,
      processEscalated: verification.processEscalated,
      processDead: verification.processDead,
      portClosed: verification.portClosed,
      distDirRemoved: verification.distDirRemoved,
      scratchRemoved: verification.scratchRemoved,
      configRestored: verification.configRestored,
      browserClosed: verification.browserClosed,
      evidencePreserved: verification.evidencePreserved,
    },
    diagnostics: result.diagnostics.map((entry) => ({
      code: entry.code,
      resourceRole: CLEANUP_DIAGNOSTIC_RESOURCE_ROLE[entry.code] ?? null,
    })),
  };
}

/** Public ownership path roots the recursive guard must treat as sensitive. */
export function sensitiveRootsOf(
  allocation: Pick<
    RunAllocation,
    'repoRoot' | 'skillRoot' | 'distDir' | 'scratchRoot' | 'evidenceRoot'
  >,
): readonly string[] {
  return [
    allocation.repoRoot,
    allocation.skillRoot,
    allocation.distDir,
    allocation.scratchRoot,
    allocation.evidenceRoot,
  ];
}

/** Public launch facts; the server log is reduced to an artifact basename. */
export function buildPublicLaunchFacts(input: {
  attempted: boolean;
  pid: number | null;
  processGroupId: number | null;
  readinessMs: number | null;
  serverLogPath: string | null;
}): PublicLaunchFacts {
  return {
    attempted: input.attempted,
    pid: input.pid,
    processGroupId: input.processGroupId,
    readinessMs: input.readinessMs,
    serverLogArtifactId:
      input.serverLogPath === null
        ? null
        : validateArtifactBasename(path.basename(input.serverLogPath)),
  };
}

// ── Closed cross-subject history projection (ADR 0019 R4/R11) ───────────────

/** One accepted native history transition inside the history projection. */
export interface PublicHistoryActionEvidenceV1 {
  actionEpochId: string;
  stepIndex: number;
  stepId: string;
  control: 'undo' | 'redo';
  controlAccessibleName: string;
  controlTitle: string;
  controlNativeTag: string;
  controlButtonType: string | null;
  controlVisible: boolean;
  controlEnabledBeforeDispatch: boolean;
  dispatchCount: 1;
  preActionRevision: number;
  postActionRevision: number;
  historyBefore: HistoryTupleWithCleanView;
  historyAfter: HistoryTupleWithCleanView;
  expectedHistory: HistoryTupleWithCleanView;
  historyTupleExact: boolean;
  expectedMeaning: string;
  meaningFingerprint: string | null;
  expectedMeaningFingerprint: string | null;
  meaningStructurallyEqual: boolean;
  observationId: string | null;
  idle: { stableFrames: number; waitedMs: number; observationRevision: number } | null;
  tornRecaptureCount: number;
  /** True when a real post-epoch transition was observed (F3; ADR 0019 R4/R11). */
  transitionObserved: boolean;
}

interface HistoryTupleWithCleanView {
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
}

/** One accepted setup checkpoint inside the history projection. */
export interface PublicHistorySetupCheckpointV1 {
  checkpointId: 'H0' | 'H1' | 'H2' | 'H3';
  role: string;
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
  meaning: 'M0' | 'M1' | 'M2' | 'M3';
  meaningFingerprint: string;
}

/** Closed public cross-subject history projection (ADR 0019 R11). */
export interface PublicHistoryEvidenceV1 {
  schemaVersion: 1;
  normalizationProfileId: 'artwork-product-meaning-v1';
  readinessProfileId: 'history-transition-v1';
  oracleProfileId: 'history-cross-subject-v1';
  timingCategory: 'INTERACTIVE_HISTORY_V1';
  deadlineMs: 5000;
  retainedLayoutId: string;
  setup: readonly PublicHistorySetupCheckpointV1[];
  actions: readonly PublicHistoryActionEvidenceV1[];
  finalHistory: HistoryTupleWithCleanView;
  checks: readonly LegacyProjectionCheck[];
}

// ── Closed guarded selection-clear projection (ADR 0020 A4) ─────────────────

/** Closed public guarded selection-clear projection (ADR 0020 A4). */
export interface PublicSelectionClearEvidenceV1 {
  schemaVersion: 1;
  profileId: 'artwork-guarded-selection-clear-v1';
  tutorialPresence: 'absent' | 'present';
  tutorialDismissCount: 0 | 1;
  onboardingBranch: 'fresh' | 'already-seen';
  imageRowClickCount: 1;
  imageGotItCount: 0 | 1;
  preEscapeObservationId: string;
  postEscapeObservationId: string;
  selectedCreatedRoleBefore: string;
  selectedLayerCountAfter: 0;
  historyBefore: HistoryTupleWithCleanView;
  historyAfter: HistoryTupleWithCleanView;
  meaningStructurallyEqual: true;
  meaningFingerprintEqual: boolean;
  inventoryEqual: true;
  containmentEqual: true;
  routePreserved: true;
  documentPreserved: true;
  pageCountPreserved: true;
  moreActionableCountBefore: 2;
  moreActionableCountAfter: 1;
  nativePrimitive: 'keyboard.press';
  key: 'Escape';
  escapeDispatchCount: 1;
  selectionClearEpochId: string;
  historyActionEpochId: null;
  historyCredit: false;
  capabilityCredit: false;
  createCredit: false;
  coverageCredit: false;
  gateECredit: false;
  railMore: {
    accessibleName: 'More';
    title: 'More';
    nativeButton: true;
    buttonType: 'button';
    visible: true;
    enabled: true;
  };
}

const HISTORY_SETUP_CHECKPOINT_IDS = ['H0', 'H1', 'H2', 'H3'] as const;
const HISTORY_MEANINGS = ['M0', 'M1', 'M2', 'M3'] as const;
const HISTORY_REQUIRED_CHECK_IDS = ['history.depth', 'history.meaning'] as const;
const HISTORY_TUPLE_KEYS = ['pastDepth', 'futureDepth', 'baselineClean'] as const;
const HISTORY_IDLE_KEYS = ['stableFrames', 'waitedMs', 'observationRevision'] as const;
const HISTORY_SETUP_KEYS = [
  'checkpointId',
  'role',
  'pastDepth',
  'futureDepth',
  'baselineClean',
  'meaning',
  'meaningFingerprint',
] as const;
/** Closed key vocabulary of one public history action epoch (ADR 0019 R11). */
const HISTORY_ACTION_KEYS = [
  'actionEpochId',
  'stepIndex',
  'stepId',
  'control',
  'controlAccessibleName',
  'controlTitle',
  'controlNativeTag',
  'controlButtonType',
  'controlVisible',
  'controlEnabledBeforeDispatch',
  'dispatchCount',
  'preActionRevision',
  'postActionRevision',
  'historyBefore',
  'historyAfter',
  'expectedHistory',
  'historyTupleExact',
  'expectedMeaning',
  'meaningFingerprint',
  'expectedMeaningFingerprint',
  'meaningStructurallyEqual',
  'observationId',
  'idle',
  'tornRecaptureCount',
  'transitionObserved',
] as const;
/** Closed key vocabulary of the public history projection (ADR 0019 R11). */
const HISTORY_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'normalizationProfileId',
  'readinessProfileId',
  'oracleProfileId',
  'timingCategory',
  'deadlineMs',
  'retainedLayoutId',
  'setup',
  'actions',
  'finalHistory',
  'checks',
] as const;

interface HistoryCleanTuple {
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
}

function unknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  violations: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!(allowed as readonly string[]).includes(key)) {
      violations.push(`${label}:unknown-key:${key}`);
    }
  }
}

/**
 * Validates one closed history tuple: integer non-negative depth, boolean
 * product-positional `baselineClean`, and no unknown keys.
 */
function historyTupleViolations(
  value: unknown,
  label: string,
  violations: string[],
): HistoryCleanTuple | null {
  if (!isPlainRecord(value)) {
    violations.push(`${label}:not-object`);
    return null;
  }
  unknownKeys(value, HISTORY_TUPLE_KEYS, label, violations);
  const { pastDepth, futureDepth, baselineClean } = value;
  if (!Number.isInteger(pastDepth) || (pastDepth as number) < 0) {
    violations.push(`${label}:past-depth`);
  }
  if (!Number.isInteger(futureDepth) || (futureDepth as number) < 0) {
    violations.push(`${label}:future-depth`);
  }
  if (typeof baselineClean !== 'boolean') {
    violations.push(`${label}:baseline-clean-type`);
  } else if (
    typeof pastDepth === 'number' &&
    typeof futureDepth === 'number' &&
    baselineClean !== productBaselineClean(pastDepth, futureDepth)
  ) {
    violations.push(`${label}:baseline-clean`);
  }
  if (
    typeof pastDepth !== 'number' ||
    typeof futureDepth !== 'number' ||
    typeof baselineClean !== 'boolean'
  ) {
    return null;
  }
  return { pastDepth, futureDepth, baselineClean };
}

/**
 * Validates the closed history projection (ADR 0019 R11; F1/F3). Any unknown
 * key, missing key, wrong checkpoint/meaning/step count, non-exact tuple, or a
 * `baselineClean`/revision/identity inconsistency is reported, so a partial or
 * hand-written history claim can never be written as apparently valid evidence.
 * It is called by the writer before any byte reaches disk.
 */
export function historyEvidenceViolations(record: Record<string, unknown>): string[] {
  const violations: string[] = [];
  unknownKeys(record, HISTORY_TOP_LEVEL_KEYS, 'history', violations);
  const setup = record.setup;
  const actions = record.actions;
  if (!Array.isArray(setup) || setup.length !== HISTORY_SETUP_CHECKPOINT_IDS.length) {
    violations.push('setup:not-four-checkpoints');
  } else {
    for (let index = 0; index < HISTORY_SETUP_CHECKPOINT_IDS.length; index += 1) {
      const checkpoint = setup[index] as Record<string, unknown>;
      if (!isPlainRecord(checkpoint)) {
        violations.push(`setup[${index}]:not-object`);
        continue;
      }
      unknownKeys(checkpoint, HISTORY_SETUP_KEYS, `setup[${index}]`, violations);
      const expected = HISTORY_SETUP_CHECKPOINTS[index];
      if (checkpoint.checkpointId !== HISTORY_SETUP_CHECKPOINT_IDS[index]) {
        violations.push(`setup[${index}]:checkpoint-id`);
      }
      if (checkpoint.role !== expected?.role) {
        violations.push(`setup[${index}]:role`);
      }
      if (checkpoint.meaning !== HISTORY_MEANINGS[index]) {
        violations.push(`setup[${index}]:meaning`);
      }
      if (checkpoint.pastDepth !== index || checkpoint.futureDepth !== 0) {
        violations.push(`setup[${index}]:tuple`);
      }
      // Product `baselineClean` is positional: only the sealed H0 (0/0) is clean.
      if (checkpoint.baselineClean !== (index === 0)) {
        violations.push(`setup[${index}]:baseline-clean`);
      }
      if (
        typeof checkpoint.meaningFingerprint !== 'string' ||
        checkpoint.meaningFingerprint.length === 0
      ) {
        violations.push(`setup[${index}]:meaning-fingerprint`);
      }
    }
  }
  let previousAfter: HistoryCleanTuple = { pastDepth: 3, futureDepth: 0, baselineClean: false };
  const observationIds = new Set<string>();
  if (!Array.isArray(actions) || actions.length !== 6) {
    violations.push('actions:not-six');
  } else {
    for (let index = 0; index < 6; index += 1) {
      const action = actions[index] as Record<string, unknown>;
      if (!isPlainRecord(action)) {
        violations.push(`actions[${index}]:not-object`);
        continue;
      }
      unknownKeys(action, HISTORY_ACTION_KEYS, `actions[${index}]`, violations);
      const step = HISTORY_ACTION_STEPS[index];
      if (step === undefined) continue;
      if (action.stepIndex !== index) violations.push(`actions[${index}]:step-index`);
      if (action.stepId !== step.stepId) violations.push(`actions[${index}]:step-id`);
      // Control identity: role, exact names/titles, native BUTTON/type, visible
      // and enabled before dispatch.
      if (action.control !== step.control) violations.push(`actions[${index}]:control`);
      const contract = HISTORY_CONTROLS[step.control];
      if (action.controlAccessibleName !== contract.accessibleName) {
        violations.push(`actions[${index}]:control-name`);
      }
      if (action.controlTitle !== contract.title) {
        violations.push(`actions[${index}]:control-title`);
      }
      if (action.controlNativeTag !== 'BUTTON') {
        violations.push(`actions[${index}]:control-native-tag`);
      }
      if (action.controlButtonType !== 'button') {
        violations.push(`actions[${index}]:control-button-type`);
      }
      if (action.controlVisible !== true) violations.push(`actions[${index}]:control-visible`);
      if (action.controlEnabledBeforeDispatch !== true) {
        violations.push(`actions[${index}]:control-enabled`);
      }
      if (action.dispatchCount !== 1) violations.push(`actions[${index}]:dispatch-count`);
      if (action.transitionObserved !== true) {
        violations.push(`actions[${index}]:transition-observed`);
      }
      // Pre/post revision identity, validity, and strict order.
      const pre = action.preActionRevision;
      const post = action.postActionRevision;
      if (!Number.isInteger(pre) || (pre as number) < 0) {
        violations.push(`actions[${index}]:pre-revision`);
      }
      if (!Number.isInteger(post) || (post as number) < 0) {
        violations.push(`actions[${index}]:post-revision`);
      }
      if (
        Number.isInteger(pre) &&
        Number.isInteger(post) &&
        !((post as number) > (pre as number))
      ) {
        violations.push(`actions[${index}]:revision-order`);
      }
      // Epoch/observation action identities bind the step and revision exactly.
      if (typeof action.actionEpochId !== 'string' || action.actionEpochId.length === 0) {
        violations.push(`actions[${index}]:action-epoch-id`);
      } else if (
        Number.isInteger(pre) &&
        action.actionEpochId !== `history:${step.stepId}:${String(pre)}`
      ) {
        violations.push(`actions[${index}]:action-epoch-id`);
      }
      if (typeof action.observationId !== 'string' || action.observationId.length === 0) {
        violations.push(`actions[${index}]:observation-id`);
      } else {
        observationIds.add(action.observationId);
        if (
          Number.isInteger(post) &&
          action.observationId !== `history:${step.stepId}:${String(post)}`
        ) {
          violations.push(`actions[${index}]:observation-id`);
        }
      }
      // Idle/currentness facts must be well-formed and current to the post
      // revision.
      const idle = action.idle;
      if (!isPlainRecord(idle)) {
        violations.push(`actions[${index}]:idle`);
      } else {
        unknownKeys(idle, HISTORY_IDLE_KEYS, `actions[${index}]:idle`, violations);
        if (!Number.isInteger(idle.stableFrames) || (idle.stableFrames as number) < 0) {
          violations.push(`actions[${index}]:idle-stable-frames`);
        }
        if (typeof idle.waitedMs !== 'number' || !Number.isFinite(idle.waitedMs)) {
          violations.push(`actions[${index}]:idle-waited`);
        }
        if (!Number.isInteger(idle.observationRevision)) {
          violations.push(`actions[${index}]:idle-revision`);
        } else if (idle.observationRevision !== post) {
          violations.push(`actions[${index}]:idle-revision`);
        }
      }
      // historyBefore -> historyAfter must be the exact chain, and historyAfter
      // must equal the product-exact expected tuple on all three fields.
      const before = historyTupleViolations(
        action.historyBefore,
        `actions[${index}]:history-before`,
        violations,
      );
      const after = historyTupleViolations(
        action.historyAfter,
        `actions[${index}]:history-after`,
        violations,
      );
      const expected = historyTupleViolations(
        action.expectedHistory,
        `actions[${index}]:expected-history`,
        violations,
      );
      if (before !== null) {
        if (
          before.pastDepth !== previousAfter.pastDepth ||
          before.futureDepth !== previousAfter.futureDepth ||
          before.baselineClean !== previousAfter.baselineClean
        ) {
          violations.push(`actions[${index}]:history-chain`);
        }
      }
      const stepExpected = step.expectedHistory;
      if (expected !== null) {
        if (
          expected.pastDepth !== stepExpected.pastDepth ||
          expected.futureDepth !== stepExpected.futureDepth ||
          expected.baselineClean !== stepExpected.baselineClean ||
          expected.baselineClean !== productBaselineClean(expected.pastDepth, expected.futureDepth)
        ) {
          violations.push(`actions[${index}]:expected-history`);
        }
      }
      if (after !== null && expected !== null) {
        if (
          after.pastDepth !== expected.pastDepth ||
          after.futureDepth !== expected.futureDepth ||
          after.baselineClean !== expected.baselineClean
        ) {
          violations.push(`actions[${index}]:history-after`);
        }
      }
      if (after !== null) previousAfter = after;
      if (action.expectedMeaning !== step.expectedMeaning) {
        violations.push(`actions[${index}]:meaning`);
      }
      if (action.historyTupleExact !== true) violations.push(`actions[${index}]:tuple-exact`);
      if (action.meaningStructurallyEqual !== true) {
        violations.push(`actions[${index}]:meaning-structural`);
      }
      if (typeof action.meaningFingerprint !== 'string' || action.meaningFingerprint.length === 0) {
        violations.push(`actions[${index}]:meaning-fingerprint`);
      }
      if (
        typeof action.expectedMeaningFingerprint !== 'string' ||
        action.expectedMeaningFingerprint.length === 0
      ) {
        violations.push(`actions[${index}]:expected-meaning-fingerprint`);
      } else if (action.meaningFingerprint !== action.expectedMeaningFingerprint) {
        violations.push(`actions[${index}]:meaning-fingerprint`);
      }
      if (action.tornRecaptureCount !== 0) {
        violations.push(`actions[${index}]:torn-recapture`);
      }
    }
  }
  // Evidence refs: each required check must pass and cite recorded observations.
  const checks = record.checks;
  if (!Array.isArray(checks) || checks.length !== HISTORY_REQUIRED_CHECK_IDS.length) {
    violations.push('checks:not-two');
  } else {
    const byId = new Map<string, Record<string, unknown>>();
    for (const check of checks) {
      if (isPlainRecord(check)) byId.set(String(check.checkId), check);
    }
    for (const required of HISTORY_REQUIRED_CHECK_IDS) {
      const check = byId.get(required);
      if (check === undefined) {
        violations.push(`checks:missing:${required}`);
        continue;
      }
      if (check.passed !== true) violations.push(`checks:${required}:not-passed`);
      const refs = check.evidenceIds;
      if (!Array.isArray(refs) || refs.length === 0) {
        violations.push(`checks:${required}:no-evidence`);
        continue;
      }
      for (const ref of refs) {
        if (
          typeof ref !== 'string' ||
          !ref.startsWith('observation:') ||
          !observationIds.has(ref.slice('observation:'.length))
        ) {
          violations.push(`checks:${required}:evidence-ref`);
        }
      }
    }
  }
  const final = record.finalHistory as Record<string, unknown> | undefined;
  const finalTuple = historyTupleViolations(final, 'finalHistory', violations);
  if (
    finalTuple !== null &&
    (finalTuple.pastDepth !== 3 ||
      finalTuple.futureDepth !== 0 ||
      finalTuple.baselineClean !== false)
  ) {
    violations.push('finalHistory:not-h3');
  }
  const exact: ReadonlyArray<readonly [string, unknown]> = [
    ['schemaVersion', 1],
    ['normalizationProfileId', 'artwork-product-meaning-v1'],
    ['readinessProfileId', 'history-transition-v1'],
    ['oracleProfileId', 'history-cross-subject-v1'],
    ['timingCategory', 'INTERACTIVE_HISTORY_V1'],
    ['deadlineMs', 5000],
  ];
  for (const [key, expected] of exact) {
    if (record[key] !== expected) violations.push(`${key}:not-exact`);
  }
  if (typeof record.retainedLayoutId !== 'string' || record.retainedLayoutId.length === 0) {
    violations.push('retainedLayoutId:not-string');
  }
  return violations;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Closed key vocabulary of the setup-refusal public projection. */
export const SETUP_REFUSAL_PROJECTION_KEYS = [
  'active',
  'authorizationConsumed',
  'certificateVersion',
  'code',
  'constructAttemptCount',
  'constructorId',
  'constructorVersion',
  'control',
  'expectedLiteralsMatched',
  'fixtureId',
  'fixtureVersion',
  'historyMutationCount',
  'hydrateCallCount',
  'inputGraphUnchanged',
  'lifecycle',
  'literalProfile',
  'mutationApplied',
  'nativePointerDispatchCount',
  'normalizationFunction',
  'observationCaptureCount',
  'oracleExecutionCount',
  'phase',
  'readinessEntered',
  'reason',
  'sealCreated',
  'storeMutationCount',
  'targetResolutionCount',
] as const;

/** Nested group-evidence keys. */
export const SETUP_REFUSAL_GROUP_KEYS = [
  'fixedPoint',
  'inputFingerprint',
  'normalizedFingerprint',
] as const;

/**
 * The five runner-owned phase counters. A pre-behavior setup refusal returns
 * before target resolution, readiness, capture, Oracle, or native dispatch, so
 * these are the only truthful values (ADR 0016 R6).
 */
export const SETUP_REFUSAL_RUNNER_COUNTERS = {
  targetResolutionCount: 0,
  readinessEntered: false,
  observationCaptureCount: 0,
  oracleExecutionCount: 0,
  nativePointerDispatchCount: 0,
} as const;

const FNV1A64_HEX = /^[0-9a-f]{16}$/;

function setupRefusalGroupViolations(value: unknown, label: 'active' | 'control'): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${label}:not-object`];
  }
  const record = value as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(SETUP_REFUSAL_GROUP_KEYS as readonly string[]).includes(key)) {
      violations.push(`${label}:unknown-key:${key}`);
    }
  }
  for (const key of SETUP_REFUSAL_GROUP_KEYS) {
    if (!Object.hasOwn(record, key)) violations.push(`${label}:missing-key:${key}`);
  }
  for (const key of ['inputFingerprint', 'normalizedFingerprint'] as const) {
    const fingerprint = record[key];
    if (typeof fingerprint !== 'string' || !FNV1A64_HEX.test(fingerprint)) {
      violations.push(`${label}:${key}:not-fnv1a64`);
    }
  }
  if (typeof record.fixedPoint !== 'boolean') violations.push(`${label}:fixedPoint:not-boolean`);
  return violations;
}

/**
 * Validates the closed setup-refusal projection (ADR 0016 R7). Any unknown key,
 * missing key, wrong exact literal, or non-boolean/non-string fact is reported,
 * so a raw tree, transform, path, authorization value, or unrestricted context
 * can never be written as apparently valid evidence.
 */
export function setupRefusalProjectionViolations(record: Record<string, unknown>): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(SETUP_REFUSAL_PROJECTION_KEYS as readonly string[]).includes(key)) {
      violations.push(`unknown-key:${key}`);
    }
  }
  for (const key of SETUP_REFUSAL_PROJECTION_KEYS) {
    if (!Object.hasOwn(record, key)) violations.push(`missing-key:${key}`);
  }
  const exact: ReadonlyArray<readonly [string, unknown]> = [
    ['phase', 'pre-hydration'],
    ['code', SETUP_REFUSAL_PROJECTION_CODE],
    ['normalizationFunction', 'normalizeArtworkGroupFrames'],
    ['literalProfile', 'known-malformed-v1-negative'],
    ['historyMutationCount', 0],
    ['mutationApplied', false],
    ['authorizationConsumed', true],
    ['lifecycle', 'SEALED'],
    ['sealCreated', false],
    ['constructAttemptCount', 1],
    ['hydrateCallCount', 0],
    ['storeMutationCount', 0],
    ['targetResolutionCount', 0],
    ['readinessEntered', false],
    ['observationCaptureCount', 0],
    ['oracleExecutionCount', 0],
    ['nativePointerDispatchCount', 0],
  ];
  for (const [key, expected] of exact) {
    if (record[key] !== expected) violations.push(`${key}:not-exact`);
  }
  if (!(SETUP_NORMALIZATION_REFUSAL_REASONS as readonly string[]).includes(String(record.reason))) {
    violations.push('reason:not-closed');
  }
  if (
    !(SETUP_NORMALIZATION_LITERAL_PROFILES as readonly string[]).includes(
      String(record.literalProfile),
    )
  ) {
    violations.push('literalProfile:not-closed');
  }
  for (const key of ['constructorId', 'fixtureId', 'certificateVersion'] as const) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      violations.push(`${key}:not-string`);
    }
  }
  for (const key of ['constructorVersion', 'fixtureVersion'] as const) {
    if (!Number.isInteger(record[key])) violations.push(`${key}:not-integer`);
  }
  for (const key of ['expectedLiteralsMatched', 'inputGraphUnchanged'] as const) {
    if (typeof record[key] !== 'boolean') violations.push(`${key}:not-boolean`);
  }
  violations.push(...setupRefusalGroupViolations(record.active, 'active'));
  violations.push(...setupRefusalGroupViolations(record.control, 'control'));
  return violations;
}

/**
 * Builds the closed public projection from the product-side refusal evidence
 * plus the five runner-owned phase counters. The input is explicitly projected
 * key by key, so an unexpected product field can never ride into the record.
 */
export function buildSetupRefusalProjection(
  evidence: SetupNormalizationRefusalEvidence,
): SetupRefusalPublicProjection {
  return {
    phase: evidence.phase,
    code: evidence.code,
    reason: evidence.reason,
    constructorId: evidence.constructorId,
    constructorVersion: evidence.constructorVersion,
    fixtureId: evidence.fixtureId,
    fixtureVersion: evidence.fixtureVersion,
    certificateVersion: evidence.certificateVersion,
    normalizationFunction: evidence.normalizationFunction,
    literalProfile: evidence.literalProfile,
    expectedLiteralsMatched: evidence.expectedLiteralsMatched,
    active: { ...evidence.active },
    control: { ...evidence.control },
    inputGraphUnchanged: evidence.inputGraphUnchanged,
    historyMutationCount: evidence.historyMutationCount,
    mutationApplied: evidence.mutationApplied,
    authorizationConsumed: evidence.authorizationConsumed,
    lifecycle: evidence.lifecycle,
    sealCreated: evidence.sealCreated,
    constructAttemptCount: evidence.constructAttemptCount,
    hydrateCallCount: evidence.hydrateCallCount,
    storeMutationCount: evidence.storeMutationCount,
    ...SETUP_REFUSAL_RUNNER_COUNTERS,
  };
}

/** Fixed, non-sensitive replacement used when a diagnostic would leak (R8). */
export const REDACTED_DIAGNOSTIC_DETAIL = '[redacted: private value]';

/**
 * Explicit safe diagnostic projector (R8). It removes any private path or
 * transient handle from a diagnostic before it enters the closed public DTO.
 * The full diagnostic survives in the CLI envelope; only the durable record is
 * projected. The recursive guard remains the complete backstop.
 */
export function redactDiagnosticRecord(
  record: DiagnosticRecord,
  forbiddenPaths: readonly string[],
): DiagnosticRecord {
  const leaks = (text: string): boolean => textContainsProhibitedValue(text, forbiddenPaths);
  const context: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.context)) {
    if (leaks(key) || leaks(value)) continue;
    context[key] = value;
  }
  return {
    code: record.code,
    severity: record.severity,
    detail: leaks(record.detail) ? REDACTED_DIAGNOSTIC_DETAIL : record.detail,
    subjectId: record.subjectId !== null && leaks(record.subjectId) ? null : record.subjectId,
    applicationKind:
      record.applicationKind !== null && leaks(record.applicationKind)
        ? null
        : record.applicationKind,
    context,
  };
}

/** Project and redact a diagnostic list for the durable record. */
export function redactDiagnostics(
  records: readonly DiagnosticRecord[],
  forbiddenPaths: readonly string[],
): DiagnosticRecord[] {
  return records.map((record) => redactDiagnosticRecord(record, forbiddenPaths));
}

/** Redact an arbitrary error/detail string for the durable record. */
export function redactRecordText(
  value: string | null,
  forbiddenPaths: readonly string[],
): string | null {
  if (value === null) return null;
  return textContainsProhibitedValue(value, forbiddenPaths) ? REDACTED_DIAGNOSTIC_DETAIL : value;
}

// ── Closed frontend serialize/restore projection (ADR 0019 R5–R7/R11) ───────

/** One declared setup checkpoint the source document was built through. */
export interface PublicRestoreSetupCheckpointV1 {
  role: string;
  stepCount: number;
  historyPastDepth: number;
  historyFutureDepth: number;
  historyBaselineClean: boolean;
  meaningFingerprint: string;
}

/** Closed route/transport facts for the seller Save → restored editor chain. */
export interface PublicRestoreRouteEvidenceV1 {
  saveControlAccessibleName: string;
  saveDispatchCount: 1;
  createMethod: 'POST';
  createPath: '/api/artwork/create';
  createContentType: string;
  createRequestCount: 1;
  redirectPath: '/artwork';
  redirectObserved: true;
  getMethod: 'GET';
  getPath: string;
  getRequestCount: 1;
  navigatePath: string;
}

/** One closed side (source or restored) of the normalized round trip. */
export interface PublicRestoreSideEvidenceV1 {
  documentId: string;
  documentEpoch: number;
  route: string;
  observationId: string;
  observationRevision: number;
  normalizedFingerprint: string;
  canonicalDigest: string;
  layoutCount: number;
  layerCount: number;
  historyPastDepth: number;
  historyFutureDepth: number;
  historyBaselineClean: boolean;
}

/** Closed exclusion honesty facts (design §4.3/§4.4). */
export interface PublicRestoreExclusionEvidenceV1 {
  volatileIdsDiffer: boolean;
  rawConfigPresent: boolean;
  rawServerMetadataPresent: boolean;
  normalizedHasNoIdKey: boolean;
  normalizedHasNoConfigKey: boolean;
  normalizedHasNoServerMetadata: boolean;
}

/** Closed raw Crossword semantic facts (design §4.4). */
export interface PublicRestoreRawSemanticEvidenceV1 {
  crosswordPresent: boolean;
  generationSeed: number | null;
  words: readonly string[];
  layoutDigest: string | null;
  restoredSeedMatches: boolean;
  restoredWordsMatches: boolean;
  restoredLayoutDigestMatches: boolean;
  layoutDigestAlgorithm: 'sha256';
  layoutDigestDomain: 'makeit:restore-crossword-layout:v1';
}

/** Closed deterministic request/response logical identities. */
export interface PublicRestoreTransportEvidenceV1 {
  requestLogicalId: string;
  requestDtoLogicalId: string;
  responseLogicalId: string;
  responseArtworkId: number;
  responseLayoutCount: number;
  responseMessage: string;
  responseTimestamp: string;
  rawArtifactId: string;
  rawArtifactRedactionPassed: true;
}

/** Closed frontend serialize/restore projection (ADR 0019 R11). */
export interface PublicRestoreEvidenceV1 {
  schemaVersion: 1;
  normalizationProfileId: 'artwork-product-meaning-v1';
  readinessProfileId: 'frontend-restore-transition-v1';
  oracleProfileId: 'frontend-restore-v1';
  timingCategory: 'FRONTEND_RESTORE_V1';
  deadlineMs: 15000;
  frontendOnly: true;
  backendPersistenceClaimed: false;
  scenarioId: 'serialize-roundtrip' | 'serialize-raw-semantic';
  source: PublicRestoreSideEvidenceV1;
  restored: PublicRestoreSideEvidenceV1;
  setup: readonly PublicRestoreSetupCheckpointV1[];
  route: PublicRestoreRouteEvidenceV1;
  transport: PublicRestoreTransportEvidenceV1;
  exclusions: PublicRestoreExclusionEvidenceV1;
  rawSemantics: PublicRestoreRawSemanticEvidenceV1;
  documentIdentityDistinct: true;
  normalizedStructurallyEqual: true;
  normalizedFingerprintEqual: true;
  inventoryPreserved: true;
  persistenceLossDetected: false;
  harnessHydrateCalls: 0;
  harnessStoreMutationCalls: 0;
  checks: readonly LegacyProjectionCheck[];
}

const RESTORE_REQUIRED_CHECK_IDS = ['serialize.raw-semantic', 'serialize.roundtrip'] as const;
const RESTORE_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'normalizationProfileId',
  'readinessProfileId',
  'oracleProfileId',
  'timingCategory',
  'deadlineMs',
  'frontendOnly',
  'backendPersistenceClaimed',
  'scenarioId',
  'source',
  'restored',
  'setup',
  'route',
  'transport',
  'exclusions',
  'rawSemantics',
  'documentIdentityDistinct',
  'normalizedStructurallyEqual',
  'normalizedFingerprintEqual',
  'inventoryPreserved',
  'persistenceLossDetected',
  'harnessHydrateCalls',
  'harnessStoreMutationCalls',
  'checks',
] as const;
const RESTORE_SIDE_KEYS = [
  'documentId',
  'documentEpoch',
  'route',
  'observationId',
  'observationRevision',
  'normalizedFingerprint',
  'canonicalDigest',
  'layoutCount',
  'layerCount',
  'historyPastDepth',
  'historyFutureDepth',
  'historyBaselineClean',
] as const;
const RESTORE_SETUP_KEYS = [
  'role',
  'stepCount',
  'historyPastDepth',
  'historyFutureDepth',
  'historyBaselineClean',
  'meaningFingerprint',
] as const;
const RESTORE_ROUTE_KEYS = [
  'saveControlAccessibleName',
  'saveDispatchCount',
  'createMethod',
  'createPath',
  'createContentType',
  'createRequestCount',
  'redirectPath',
  'redirectObserved',
  'getMethod',
  'getPath',
  'getRequestCount',
  'navigatePath',
] as const;
const RESTORE_TRANSPORT_KEYS = [
  'requestLogicalId',
  'requestDtoLogicalId',
  'responseLogicalId',
  'responseArtworkId',
  'responseLayoutCount',
  'responseMessage',
  'responseTimestamp',
  'rawArtifactId',
  'rawArtifactRedactionPassed',
] as const;
const RESTORE_EXCLUSION_KEYS = [
  'volatileIdsDiffer',
  'rawConfigPresent',
  'rawServerMetadataPresent',
  'normalizedHasNoIdKey',
  'normalizedHasNoConfigKey',
  'normalizedHasNoServerMetadata',
] as const;
const RESTORE_RAW_SEMANTIC_KEYS = [
  'crosswordPresent',
  'generationSeed',
  'words',
  'layoutDigest',
  'restoredSeedMatches',
  'restoredWordsMatches',
  'restoredLayoutDigestMatches',
  'layoutDigestAlgorithm',
  'layoutDigestDomain',
] as const;

/**
 * Validates the closed restore projection (ADR 0019 R11). Any unknown key,
 * missing key, wrong exact identity/value, or non-boolean fact is reported, so
 * a partial or hand-written restore claim can never be written as apparently
 * valid evidence. It is called by the writer before any byte reaches disk.
 */
export function restoreEvidenceViolations(record: Record<string, unknown>): string[] {
  const violations: string[] = [];
  unknownKeys(record, RESTORE_TOP_LEVEL_KEYS, 'restore', violations);
  const exact: ReadonlyArray<readonly [string, unknown]> = [
    ['schemaVersion', 1],
    ['normalizationProfileId', 'artwork-product-meaning-v1'],
    ['readinessProfileId', 'frontend-restore-transition-v1'],
    ['oracleProfileId', 'frontend-restore-v1'],
    ['timingCategory', 'FRONTEND_RESTORE_V1'],
    ['deadlineMs', 15000],
    ['frontendOnly', true],
    ['backendPersistenceClaimed', false],
    ['documentIdentityDistinct', true],
    ['normalizedStructurallyEqual', true],
    ['normalizedFingerprintEqual', true],
    ['inventoryPreserved', true],
    ['persistenceLossDetected', false],
    ['harnessHydrateCalls', 0],
    ['harnessStoreMutationCalls', 0],
  ];
  for (const [key, expected] of exact) {
    if (record[key] !== expected) violations.push(`${key}:not-exact`);
  }
  if (
    record.scenarioId !== 'serialize-roundtrip' &&
    record.scenarioId !== 'serialize-raw-semantic'
  ) {
    violations.push('scenarioId:not-closed');
  }

  const sideViolations = (value: unknown, label: 'source' | 'restored'): void => {
    if (!isPlainRecord(value)) {
      violations.push(`${label}:not-object`);
      return;
    }
    unknownKeys(value, RESTORE_SIDE_KEYS, label, violations);
    for (const key of [
      'documentId',
      'route',
      'observationId',
      'normalizedFingerprint',
      'canonicalDigest',
    ] as const) {
      if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
        violations.push(`${label}:${key}`);
      }
    }
    for (const key of [
      'documentEpoch',
      'observationRevision',
      'layoutCount',
      'layerCount',
    ] as const) {
      if (!Number.isInteger(value[key]) || (value[key] as number) < 0) {
        violations.push(`${label}:${key}`);
      }
    }
    for (const key of ['historyPastDepth', 'historyFutureDepth'] as const) {
      if (!Number.isInteger(value[key])) violations.push(`${label}:${key}`);
    }
    if (typeof value.historyBaselineClean !== 'boolean') {
      violations.push(`${label}:historyBaselineClean`);
    }
  };
  sideViolations(record.source, 'source');
  sideViolations(record.restored, 'restored');

  const setup = record.setup;
  if (!Array.isArray(setup) || setup.length === 0) {
    violations.push('setup:empty');
  } else {
    for (let index = 0; index < setup.length; index += 1) {
      const checkpoint = setup[index];
      if (!isPlainRecord(checkpoint)) {
        violations.push(`setup[${index}]:not-object`);
        continue;
      }
      unknownKeys(checkpoint, RESTORE_SETUP_KEYS, `setup[${index}]`, violations);
      if (typeof checkpoint.role !== 'string' || checkpoint.role.length === 0) {
        violations.push(`setup[${index}]:role`);
      }
      if (!Number.isInteger(checkpoint.stepCount) || (checkpoint.stepCount as number) < 1) {
        violations.push(`setup[${index}]:stepCount`);
      }
      if (
        typeof checkpoint.meaningFingerprint !== 'string' ||
        checkpoint.meaningFingerprint.length === 0
      ) {
        violations.push(`setup[${index}]:meaningFingerprint`);
      }
    }
  }

  if (isPlainRecord(record.route)) {
    unknownKeys(record.route, RESTORE_ROUTE_KEYS, 'route', violations);
    const routeExact: ReadonlyArray<readonly [string, unknown]> = [
      ['saveControlAccessibleName', 'Save'],
      ['saveDispatchCount', 1],
      ['createMethod', 'POST'],
      ['createPath', '/api/artwork/create'],
      ['createRequestCount', 1],
      ['redirectPath', '/artwork'],
      ['redirectObserved', true],
      ['getMethod', 'GET'],
      ['getRequestCount', 1],
    ];
    for (const [key, expected] of routeExact) {
      if (record.route[key] !== expected) violations.push(`route:${key}:not-exact`);
    }
    if (
      typeof record.route.createContentType !== 'string' ||
      !(record.route.createContentType as string).includes('application/json')
    ) {
      violations.push('route:createContentType');
    }
    for (const key of ['getPath', 'navigatePath'] as const) {
      if (typeof record.route[key] !== 'string' || (record.route[key] as string).length === 0) {
        violations.push(`route:${key}`);
      }
    }
  } else {
    violations.push('route:not-object');
  }

  if (isPlainRecord(record.transport)) {
    unknownKeys(record.transport, RESTORE_TRANSPORT_KEYS, 'transport', violations);
    for (const key of [
      'requestLogicalId',
      'requestDtoLogicalId',
      'responseLogicalId',
      'responseMessage',
      'responseTimestamp',
      'rawArtifactId',
    ] as const) {
      if (
        typeof record.transport[key] !== 'string' ||
        (record.transport[key] as string).length === 0
      ) {
        violations.push(`transport:${key}`);
      }
    }
    if (!Number.isInteger(record.transport.responseArtworkId)) {
      violations.push('transport:responseArtworkId');
    }
    if (
      !Number.isInteger(record.transport.responseLayoutCount) ||
      (record.transport.responseLayoutCount as number) < 1
    ) {
      violations.push('transport:responseLayoutCount');
    }
    if (record.transport.rawArtifactRedactionPassed !== true) {
      violations.push('transport:rawArtifactRedactionPassed');
    }
  } else {
    violations.push('transport:not-object');
  }

  if (isPlainRecord(record.exclusions)) {
    unknownKeys(record.exclusions, RESTORE_EXCLUSION_KEYS, 'exclusions', violations);
    for (const key of RESTORE_EXCLUSION_KEYS) {
      if (record.exclusions[key] !== true) violations.push(`exclusions:${key}:not-true`);
    }
  } else {
    violations.push('exclusions:not-object');
  }

  if (isPlainRecord(record.rawSemantics)) {
    unknownKeys(record.rawSemantics, RESTORE_RAW_SEMANTIC_KEYS, 'rawSemantics', violations);
    for (const key of [
      'crosswordPresent',
      'restoredSeedMatches',
      'restoredWordsMatches',
      'restoredLayoutDigestMatches',
    ] as const) {
      if (typeof record.rawSemantics[key] !== 'boolean') {
        violations.push(`rawSemantics:${key}:not-boolean`);
      }
    }
    if (record.rawSemantics.crosswordPresent === true) {
      if (typeof record.rawSemantics.generationSeed !== 'number') {
        violations.push('rawSemantics:generationSeed');
      }
      if (
        typeof record.rawSemantics.layoutDigest !== 'string' ||
        (record.rawSemantics.layoutDigest as string).length === 0
      ) {
        violations.push('rawSemantics:layoutDigest');
      }
      if (record.rawSemantics.restoredSeedMatches !== true) {
        violations.push('rawSemantics:restoredSeedMatches');
      }
      if (record.rawSemantics.restoredWordsMatches !== true) {
        violations.push('rawSemantics:restoredWordsMatches');
      }
      if (record.rawSemantics.restoredLayoutDigestMatches !== true) {
        violations.push('rawSemantics:restoredLayoutDigestMatches');
      }
    }
    if (
      !Array.isArray(record.rawSemantics.words) ||
      !record.rawSemantics.words.every((word) => typeof word === 'string')
    ) {
      violations.push('rawSemantics:words');
    }
    if (record.rawSemantics.layoutDigestAlgorithm !== 'sha256') {
      violations.push('rawSemantics:layoutDigestAlgorithm');
    }
    if (record.rawSemantics.layoutDigestDomain !== 'makeit:restore-crossword-layout:v1') {
      violations.push('rawSemantics:layoutDigestDomain');
    }
  } else {
    violations.push('rawSemantics:not-object');
  }

  const checks = record.checks;
  if (!Array.isArray(checks) || checks.length !== RESTORE_REQUIRED_CHECK_IDS.length) {
    violations.push('checks:not-two');
  } else {
    const byId = new Map<string, Record<string, unknown>>();
    for (const check of checks) {
      if (isPlainRecord(check)) byId.set(String(check.checkId), check);
    }
    for (const required of RESTORE_REQUIRED_CHECK_IDS) {
      const check = byId.get(required);
      if (check === undefined) {
        violations.push(`checks:missing:${required}`);
        continue;
      }
      if (check.passed !== true) violations.push(`checks:${required}:not-passed`);
      const refs = check.evidenceIds;
      if (!Array.isArray(refs) || refs.length === 0) {
        violations.push(`checks:${required}:no-evidence`);
      }
    }
  }
  return violations;
}
