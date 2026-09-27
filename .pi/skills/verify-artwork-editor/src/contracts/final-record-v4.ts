import { deriveResolvedCorrectnessProfileFingerprint } from '../catalogue/correctness';
import { derivePlanFingerprint } from '../canonical/identity';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../planner/execution-materialization';
import { createDiagnostic, type DiagnosticCode, type DiagnosticRecord } from './diagnostics';
import {
  isCheckResultStatus,
  isFullCanonicalFingerprint,
  type ActionCycleCorrectnessIdentity,
  type CorrectnessCheckResult,
  type CorrectnessComponentFingerprints,
  type ResolvedCorrectnessProfile,
} from './correctness';
import {
  projectCorrectnessProfileIdentity,
  type CorrectnessProfileIdentityView,
  type ResultContractIssue,
  type ResultContractIssueCode,
  isPlainRecord,
  validateCheckResultShape,
  validateResultIdentityAgreement,
} from './result-agreement';
import {
  COMMAND_CHECK_CONTEXTS,
  isCommandCheckContext,
  validateCheckContextSeparation,
  validateCommandCheck,
  type CommandCheckContext,
  type CommandStatusAuthority,
} from './command-check';
import { RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION } from './schema-versions';

/**
 * Current strict-v4 child-record assembly (ADR 0025 §7; ADR 0032 §E3-S2).
 *
 * This module is the writer-side half of the current record path. It
 * accepts only a validated `MaterializedExecutionEnvelopeV1`, a complete set of
 * final `CorrectnessCheckResult` values, the `ActionCycleCorrectnessIdentity`
 * set that observed the action, and the family check-bearing projections the
 * current public DTO carries (Image, Crossword, History, Restore, and the
 * Action Cycle readiness projection). It checks plan/profile/component/
 * evidence/ref/check/action-cycle/readiness agreement and produces one complete
 * current v4 child record containing no legacy boolean `passed` and no
 * `harnessInvalid` side channel anywhere.
 *
 * This is the sole current child-record assembly. The schema-v2/v3 child
 * writer and reader are removed from current reach, and the historical v1/v2/v3
 * records remain readable only through the labelled, read-only legacy readers.
 */

/** The strict current child-record schema version (ADR 0025 §7). */
export const FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION = 4;

/** Schema version carried by every nested v4 projection. */
export const FINAL_NESTED_PROJECTION_SCHEMA_VERSION = 4;

/**
 * Closed nested check-bearing projection families required by the current
 * public DTO (ADR 0025 §7). A v4 record may carry at most one of each.
 */
export const FINAL_NESTED_PROJECTION_FAMILIES = [
  'action-cycle',
  'crossword',
  'history',
  'image',
  'restore',
] as const;
export type FinalNestedProjectionFamily = (typeof FINAL_NESTED_PROJECTION_FAMILIES)[number];

function isFinalNestedProjectionFamily(value: unknown): value is FinalNestedProjectionFamily {
  return (
    typeof value === 'string' &&
    (FINAL_NESTED_PROJECTION_FAMILIES as readonly string[]).includes(value)
  );
}

/** Closed v4 action-cycle readiness projection (the current public readiness map). */
export interface FinalActionCycleProjectionV4 {
  schemaVersion: typeof FINAL_NESTED_PROJECTION_SCHEMA_VERSION;
  family: 'action-cycle';
  actionCycles: readonly ActionCycleCorrectnessIdentity[];
  readiness: {
    profileId: string;
    timingCategory: string;
    deadlineMs: number;
    signalWatchdogMs: number;
    stableFrames: number;
  };
}

export interface FinalImageCycleProjectionV4 {
  checkpoint: string;
  mode: string;
  outcome: string;
  observationId: string | null;
  tornRecaptureCount: number;
  actionCycleRef: string;
  checks: readonly CorrectnessCheckResult[];
}

export interface FinalImageProjectionV4 {
  schemaVersion: typeof FINAL_NESTED_PROJECTION_SCHEMA_VERSION;
  family: 'image';
  cycles: readonly FinalImageCycleProjectionV4[];
}

export interface FinalCrosswordExecutionProjectionV4 {
  executionRole: 'A1' | 'A2' | 'B';
  clockBaselineUtc: string;
  expectedSeed: number;
  actualSeed: number;
  hostLayoutId: string;
  createdTargetId: string;
  words: readonly string[];
  semanticDigest: string;
  actionCycleRef: string;
  checks: readonly CorrectnessCheckResult[];
}

export interface FinalCrosswordComparisonV4 {
  sameSeedEqual: boolean;
  sameWordsEqual: boolean;
  sameSemanticDigestEqual: boolean;
  controlSeedDifferent: boolean;
  controlWordsEqual: boolean;
  controlSemanticDigestDifferent: boolean;
}

export interface FinalCrosswordProjectionV4 {
  schemaVersion: typeof FINAL_NESTED_PROJECTION_SCHEMA_VERSION;
  family: 'crossword';
  providerId: string;
  namespace: string;
  comparisonProfileId: string;
  executions: readonly FinalCrosswordExecutionProjectionV4[];
  comparison: FinalCrosswordComparisonV4;
}

export interface FinalHistoryTupleV4 {
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
}

export interface FinalHistoryProjectionV4 {
  schemaVersion: typeof FINAL_NESTED_PROJECTION_SCHEMA_VERSION;
  family: 'history';
  normalizationProfileId: string;
  readinessProfileId: string;
  oracleProfileId: string;
  timingCategory: string;
  deadlineMs: number;
  retainedLayoutId: string;
  finalHistory: FinalHistoryTupleV4;
  actionCycleRef: string;
  checks: readonly CorrectnessCheckResult[];
}

export interface FinalRestoreProjectionV4 {
  schemaVersion: typeof FINAL_NESTED_PROJECTION_SCHEMA_VERSION;
  family: 'restore';
  normalizationProfileId: string;
  readinessProfileId: string;
  oracleProfileId: string;
  timingCategory: string;
  deadlineMs: number;
  scenarioId: string;
  sourceDocumentId: string;
  restoredDocumentId: string;
  actionCycleRef: string;
  checks: readonly CorrectnessCheckResult[];
}

export type FinalNestedProjectionV4 =
  | FinalActionCycleProjectionV4
  | FinalImageProjectionV4
  | FinalCrosswordProjectionV4
  | FinalHistoryProjectionV4
  | FinalRestoreProjectionV4;

/**
 * One complete strict current v4 child record (ADR 0025 §7). It carries the
 * final three-state required checks, the resolved-profile identity, the
 * complete component fingerprints, the Action Cycle identities, and the strict
 * nested check-bearing projections; the legacy boolean `passed` and the removed
 * `harnessInvalid` side channel are absent everywhere.
 */
export interface FinalCurrentChildRecordV4 {
  schemaVersion: typeof FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION;
  runId: string;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  profile: string;
  observationId: string | null;
  resolvedProfileFingerprint: string;
  componentFingerprints: CorrectnessComponentFingerprints;
  actionCycles: readonly ActionCycleCorrectnessIdentity[];
  requiredChecks: readonly CorrectnessCheckResult[];
  nestedProjections: readonly FinalNestedProjectionV4[];
}

/** One complete strict v4 command-context child record (Doctor / production-absence). */
export interface FinalCommandCheckRecordV4 {
  schemaVersion: typeof FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION;
  command: CommandCheckContext;
  commandAuthority: CommandStatusAuthority;
  checks: readonly CommandCheckResultView[];
}

/** Structural view of one command check accepted by the strict v4 command record. */
export interface CommandCheckResultView {
  schemaVersion: number;
  checkId: string;
  status: CorrectnessCheckResult['status'];
  expected: Readonly<Record<string, unknown>>;
  actual: Readonly<Record<string, unknown>>;
  evidenceIds: readonly string[];
  commandAuthority: CommandStatusAuthority;
}

const CLOSED_CHILD_RECORD_KEYS = [
  'schemaVersion',
  'runId',
  'caseId',
  'materializationFingerprint',
  'planFingerprint',
  'profile',
  'observationId',
  'resolvedProfileFingerprint',
  'componentFingerprints',
  'actionCycles',
  'requiredChecks',
  'nestedProjections',
] as const;

const CLOSED_COMMAND_RECORD_KEYS = [
  'schemaVersion',
  'command',
  'commandAuthority',
  'checks',
] as const;

/**
 * The closed child-record key vocabulary, exposed read-only so the public
 * v4 DTO port validates the child region with the exact same key
 * set instead of maintaining a second, drift-prone list.
 */
export const FINAL_CHILD_RECORD_KEYS: readonly string[] = CLOSED_CHILD_RECORD_KEYS;

/** The closed command-record key vocabulary, exposed read-only for the same reason. */
export const FINAL_COMMAND_RECORD_KEYS: readonly string[] = CLOSED_COMMAND_RECORD_KEYS;

const COMPONENT_FINGERPRINT_FIELDS = [
  'readiness',
  'capture',
  'oracle',
  'capabilityBaseline',
  'subjectAddition',
  'requiredCheckSet',
  'tolerances',
  'visuals',
  'normalization',
] as const;

const CONSUMED_COMPONENT_FIELDS = [
  'requiredCheckSet',
  'oracle',
  'capture',
  'tolerances',
  'visuals',
  'normalization',
] as const;

/**
 * Local assembly/validation issue vocabulary. The shared B1-A result-contract
 * issue codes are reused verbatim so an assembly failure names the same precise
 * agreement check the final result kernel reports; the additional codes below
 * cover envelope linkage and nested-projection structure only.
 */
export const FINAL_RECORD_ASSEMBLY_ISSUE_CODES = [
  'FINAL_RECORD_NOT_OBJECT',
  'FINAL_RECORD_ENVELOPE_NOT_OBJECT',
  'FINAL_RECORD_ENVELOPE_SCHEMA_UNSUPPORTED',
  'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_INVALID',
  'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
  'FINAL_RECORD_ENVELOPE_PROFILE_MISSING',
  'FINAL_RECORD_ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
  'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_INVALID',
  'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
  'FINAL_RECORD_ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
  'FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT',
  'FINAL_RECORD_ACTION_CYCLE_MISSING',
  'FINAL_RECORD_ACTION_CYCLE_DUPLICATE',
  'FINAL_RECORD_ACTION_CYCLE_READINESS_MISMATCH',
  'FINAL_RECORD_CHECK_CONTEXT_INVALID',
  'FINAL_RECORD_NESTED_PROJECTION_INVALID',
  'FINAL_RECORD_NESTED_PROJECTION_DUPLICATE',
  'FINAL_RECORD_NESTED_PROJECTION_UNKNOWN_FAMILY',
  'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
  'FINAL_RECORD_LEGACY_BOOLEAN_PRESENT',
  'FINAL_RECORD_HARNESS_INVALID_PRESENT',
  'FINAL_RECORD_SCHEMA_UNSUPPORTED',
  'FINAL_RECORD_FIELD_INVALID',
  'FINAL_RECORD_SELF_CHECK_FAILED',
] as const;
export type FinalRecordAssemblyIssueCode = (typeof FINAL_RECORD_ASSEMBLY_ISSUE_CODES)[number];
export type FinalRecordIssueCode = FinalRecordAssemblyIssueCode | ResultContractIssueCode;

export interface FinalRecordIssue {
  code: FinalRecordIssueCode;
  detail: string;
  checkId: string | null;
}

function finalIssue(
  code: FinalRecordIssueCode,
  detail: string,
  checkId: string | null = null,
): FinalRecordIssue {
  return { code, detail, checkId };
}

function asFinalIssue(issue: ResultContractIssue): FinalRecordIssue {
  return { code: issue.code, detail: issue.detail, checkId: issue.checkId };
}

const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<FinalRecordAssemblyIssueCode, DiagnosticCode>> =
  Object.freeze({
    FINAL_RECORD_NOT_OBJECT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_ENVELOPE_NOT_OBJECT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_ENVELOPE_SCHEMA_UNSUPPORTED: 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
    FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_ENVELOPE_PROFILE_MISSING: 'CORRECTNESS_PROFILE_MISSING',
    FINAL_RECORD_ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED: 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
    FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_ENVELOPE_COMPONENT_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT: 'CORRECTNESS_REFERENCE_UNRESOLVED',
    FINAL_RECORD_ACTION_CYCLE_MISSING: 'CORRECTNESS_REFERENCE_UNRESOLVED',
    FINAL_RECORD_ACTION_CYCLE_DUPLICATE: 'CORRECTNESS_REFERENCE_AMBIGUOUS',
    FINAL_RECORD_ACTION_CYCLE_READINESS_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_CHECK_CONTEXT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_NESTED_PROJECTION_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_NESTED_PROJECTION_DUPLICATE: 'CORRECTNESS_REFERENCE_AMBIGUOUS',
    FINAL_RECORD_NESTED_PROJECTION_UNKNOWN_FAMILY: 'CORRECTNESS_UNKNOWN_DISCRIMINANT',
    FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT: 'CORRECTNESS_REFERENCE_UNRESOLVED',
    FINAL_RECORD_LEGACY_BOOLEAN_PRESENT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_HARNESS_INVALID_PRESENT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_SCHEMA_UNSUPPORTED: 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
    FINAL_RECORD_FIELD_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    FINAL_RECORD_SELF_CHECK_FAILED: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
  } satisfies Record<FinalRecordAssemblyIssueCode, DiagnosticCode>);

function diagnosticFor(issue: FinalRecordIssue): DiagnosticRecord {
  const code =
    (PRIMARY_DIAGNOSTIC_CODE as Readonly<Record<string, DiagnosticCode>>)[issue.code] ??
    'CORRECTNESS_COMPATIBILITY_DIVERGENCE';
  return createDiagnostic(code, `${issue.code}: ${issue.detail}`, {
    context: { issueCode: issue.code },
  });
}

export interface FinalRecordAssemblyFailure {
  ok: false;
  status: 'HARNESS_BLOCKED';
  code: DiagnosticCode;
  diagnostic: DiagnosticRecord;
  issues: readonly FinalRecordIssue[];
}

export type FinalChildRecordAssemblyResult =
  | { ok: true; record: FinalCurrentChildRecordV4 }
  | FinalRecordAssemblyFailure;

export type FinalCommandRecordAssemblyResult =
  | { ok: true; record: FinalCommandCheckRecordV4 }
  | FinalRecordAssemblyFailure;

function failure(issues: readonly FinalRecordIssue[]): FinalRecordAssemblyFailure {
  const primary = issues[0] as FinalRecordIssue;
  return {
    ok: false,
    status: 'HARNESS_BLOCKED',
    code: diagnosticFor(primary).code,
    diagnostic: diagnosticFor(primary),
    issues: Object.freeze([...issues]),
  };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Scans a value for the two removed legacy authorities: a boolean `passed`
 * field and the `harnessInvalid` side channel. A strict v4 record may contain
 * neither anywhere (ADR 0025 §7).
 *
 * The traversal is complete and cycle-safe rather than depth-bounded:
 *
 * - it walks the whole reachable value graph with an explicit stack, so a
 *   legacy authority can never be silently skipped because it sits below some
 *   arbitrary nesting depth; nesting is limited only by what the record's own
 *   isolation and serialization can already represent, not by this detector;
 * - it records each visited object identity, so a cyclic or shared sub-graph is
 *   visited exactly once and the walk always terminates;
 * - it inspects every reachable holder (object or array, plain or not) for an
 *   own `passed`/`harnessInvalid` key, so a legacy authority cannot hide inside
 *   an array, behind an alias, or on a non-plain holder.
 *
 * Cost is one visit per reachable node, matching the record's own isolation and
 * serialization traversal; no depth or node-count cutoff can drop a hit.
 */
function scanLegacyAuthority(
  value: unknown,
  found: { passed: boolean; harnessInvalid: boolean },
): void {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    if (found.passed && found.harnessInvalid) return;
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    const holder = current as Record<string, unknown>;
    if (hasOwn(holder, 'passed')) found.passed = true;
    if (hasOwn(holder, 'harnessInvalid')) found.harnessInvalid = true;
    for (const entry of Object.values(holder)) pending.push(entry);
  }
}

/**
 * Reports the two removed legacy authorities (a boolean `passed` field and the
 * `harnessInvalid` side channel) found anywhere in a value. The scan is
 * complete and cycle-safe, so a legacy authority is rejected at any supported
 * nesting depth.
 *
 * Exposed read-only so the public v4 DTO port scans its complete
 * record — including the operational projections — with the exact same detector
 * the child record uses. This is a pure read: nothing is mutated.
 */
export function finalRecordLegacyAuthorityIssues(
  value: unknown,
  label: string,
): readonly FinalRecordIssue[] {
  const issues: FinalRecordIssue[] = [];
  reportLegacyAuthority(value, issues, label);
  return Object.freeze(issues);
}

function reportLegacyAuthority(value: unknown, issues: FinalRecordIssue[], label: string): void {
  const found = { passed: false, harnessInvalid: false };
  scanLegacyAuthority(value, found);
  if (found.passed) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_LEGACY_BOOLEAN_PRESENT',
        `${label} carries a legacy boolean "passed" somewhere in the strict v4 record.`,
      ),
    );
  }
  if (found.harnessInvalid) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_HARNESS_INVALID_PRESENT',
        `${label} carries the removed "harnessInvalid" side channel.`,
      ),
    );
  }
}

function isPlainIsolatableObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep clone and deep freeze one assembled value so the v4 record owns an
 * isolated immutable copy. Non-plain objects, non-finite numbers, functions,
 * symbols, and bigints are rejected so a record is always a closed, canonically
 * comparable value.
 */
function cloneAndFreeze(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}.`);
      return value;
    case 'object':
      break;
    default:
      throw new Error(`Unsupported record value type "${typeof value}" at ${path}.`);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => cloneAndFreeze(entry, `${path}[${index}]`)));
  }
  if (!isPlainIsolatableObject(value)) throw new Error(`Non-plain object at ${path}.`);
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    clone[key] = cloneAndFreeze(source[key], `${path}.${key}`);
  }
  return Object.freeze(clone);
}

/**
 * Deep-clone and deep-freeze one record value into an isolated immutable copy.
 * Exposed read-only so the public v4 DTO port closes its public
 * record by the same rules (plain JSON data, no non-finite numbers, no
 * non-plain objects, no functions/symbols/bigints) as the child record.
 */
export function isolateFinalRecordValue(value: unknown, path: string): unknown {
  return cloneAndFreeze(value, path);
}

function validateComponentFingerprints(
  value: unknown,
  issues: FinalRecordIssue[],
  code: FinalRecordAssemblyIssueCode,
): value is CorrectnessComponentFingerprints {
  if (!isPlainRecord(value)) {
    issues.push(finalIssue(code, 'A record must carry complete component fingerprints.'));
    return false;
  }
  let ok = true;
  for (const field of COMPONENT_FINGERPRINT_FIELDS) {
    if (!isFullCanonicalFingerprint(value[field])) {
      issues.push(
        finalIssue(
          code,
          `Component fingerprint "${field}" is not a full canonical 64-hex identity.`,
        ),
      );
      ok = false;
    }
  }
  return ok;
}

interface CyclesIndex {
  byId: ReadonlyMap<string, ActionCycleCorrectnessIdentity>;
  ids: readonly string[];
}

function indexActionCycles(
  actionCycles: unknown,
  readinessFingerprint: unknown,
  issues: FinalRecordIssue[],
): CyclesIndex {
  if (!Array.isArray(actionCycles) || actionCycles.length === 0) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ACTION_CYCLE_MISSING',
        'A v4 record must carry Action Cycle identities.',
      ),
    );
    return { byId: new Map(), ids: [] };
  }
  const byId = new Map<string, ActionCycleCorrectnessIdentity>();
  const ids: string[] = [];
  for (const entry of actionCycles) {
    if (!isPlainRecord(entry) || !isNonEmptyString(entry.actionCycleId)) {
      issues.push(
        finalIssue('FINAL_RECORD_ACTION_CYCLE_MISSING', 'An Action Cycle identity has no id.'),
      );
      continue;
    }
    if (byId.has(entry.actionCycleId)) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ACTION_CYCLE_DUPLICATE',
          `Action Cycle id "${entry.actionCycleId}" is declared more than once.`,
        ),
      );
      continue;
    }
    const cycle = entry as unknown as ActionCycleCorrectnessIdentity;
    ids.push(entry.actionCycleId);
    byId.set(entry.actionCycleId, cycle);
    if (typeof cycle.schemaVersion !== 'number') {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ACTION_CYCLE_MISSING',
          `Action Cycle "${entry.actionCycleId}" has no numeric schemaVersion.`,
        ),
      );
    }
    if (!isFullCanonicalFingerprint(cycle.resolvedProfileFingerprint)) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_FIELD_INVALID',
          `Action Cycle "${entry.actionCycleId}" resolved-profile fingerprint is not canonical.`,
        ),
      );
    }
    if (!isFullCanonicalFingerprint(cycle.readinessFingerprint)) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_FIELD_INVALID',
          `Action Cycle "${entry.actionCycleId}" readiness fingerprint is not canonical.`,
        ),
      );
    } else if (
      isFullCanonicalFingerprint(readinessFingerprint) &&
      cycle.readinessFingerprint !== readinessFingerprint
    ) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ACTION_CYCLE_READINESS_MISMATCH',
          `Action Cycle "${entry.actionCycleId}" readiness fingerprint does not equal the compiled readiness component.`,
        ),
      );
    }
  }
  return { byId, ids };
}

function validateNestedCheck(
  check: unknown,
  identity: CorrectnessProfileIdentityView,
  cycles: CyclesIndex,
  issues: FinalRecordIssue[],
  label: string,
): void {
  validateCheckResultShape(check, issues as ResultContractIssue[]);
  const context = validateCheckContextSeparation(check);
  for (const issue of context.issues) issues.push(asFinalIssue(issue));
  if (!isPlainRecord(check)) return;
  const checkId = typeof check.checkId === 'string' ? check.checkId : null;
  if (checkId !== null && !identity.requiredCheckIds.includes(checkId)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
        `${label} check "${checkId}" is not a declared required check of the compiled profile.`,
        checkId,
      ),
    );
  }
  const ref = check.actionCycleRef;
  if (typeof ref === 'string' && ref.length > 0 && !cycles.byId.has(ref)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
        `${label} check "${String(checkId)}" references unresolved Action Cycle "${ref}".`,
        checkId,
      ),
    );
  }
  const consumed = check.consumedComponentFingerprints;
  if (isPlainRecord(consumed)) {
    if (consumed.resolvedProfile !== identity.resolvedFingerprint) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
          `${label} check "${String(checkId)}" consumed resolved profile does not equal the compiled profile.`,
          checkId,
        ),
      );
    }
    for (const field of CONSUMED_COMPONENT_FIELDS) {
      if (consumed[field] !== identity.componentFingerprints[field]) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
            `${label} check "${String(checkId)}" consumed component "${field}" does not equal the compiled component.`,
            checkId,
          ),
        );
      }
    }
  }
}

function validateNestedProjection(
  projection: unknown,
  identity: CorrectnessProfileIdentityView,
  readinessProfileId: string,
  cycles: CyclesIndex,
  topLevelCycles: readonly ActionCycleCorrectnessIdentity[],
  issues: FinalRecordIssue[],
): void {
  if (!isPlainRecord(projection)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_INVALID',
        'A nested projection is not a plain object.',
      ),
    );
    return;
  }
  if (!isFinalNestedProjectionFamily(projection.family)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_UNKNOWN_FAMILY',
        `Nested projection family "${String(projection.family)}" is unknown.`,
      ),
    );
    return;
  }
  const family = projection.family;
  if (projection.schemaVersion !== FINAL_NESTED_PROJECTION_SCHEMA_VERSION) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_INVALID',
        `Nested projection "${family}" must declare schemaVersion ${FINAL_NESTED_PROJECTION_SCHEMA_VERSION}.`,
      ),
    );
  }
  reportLegacyAuthority(projection, issues, `Nested projection "${family}"`);
  if (family === 'action-cycle') {
    const projectionCycles = projection.actionCycles;
    if (!Array.isArray(projectionCycles) || projectionCycles.length !== topLevelCycles.length) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
          'The action-cycle projection must carry exactly the record Action Cycle identities.',
        ),
      );
    } else {
      for (let index = 0; index < projectionCycles.length; index += 1) {
        const left = projectionCycles[index] as ActionCycleCorrectnessIdentity;
        const right = topLevelCycles[index] as ActionCycleCorrectnessIdentity;
        if (left?.actionCycleId !== right?.actionCycleId) {
          issues.push(
            finalIssue(
              'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
              'The action-cycle projection identities do not equal the record Action Cycle identities.',
            ),
          );
        }
      }
    }
    const readiness = projection.readiness;
    if (!isPlainRecord(readiness)) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_NESTED_PROJECTION_INVALID',
          'The action-cycle projection has no readiness.',
        ),
      );
    } else if (readiness.profileId !== readinessProfileId) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_NESTED_PROJECTION_INVALID',
          'The action-cycle projection readiness profile id does not equal the compiled readiness profile.',
        ),
      );
    }
    return;
  }
  if (family === 'image') {
    const cycleList = projection.cycles;
    if (!Array.isArray(cycleList) || cycleList.length === 0) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_NESTED_PROJECTION_INVALID',
          'The image projection carries no cycles.',
        ),
      );
      return;
    }
    for (const cycle of cycleList) {
      if (!isPlainRecord(cycle)) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_INVALID',
            'An image cycle is not a plain object.',
          ),
        );
        continue;
      }
      const checks = Array.isArray(cycle.checks) ? cycle.checks : [];
      if (checks.length === 0) {
        issues.push(
          finalIssue('FINAL_RECORD_NESTED_PROJECTION_INVALID', 'An image cycle carries no checks.'),
        );
      }
      for (const check of checks) {
        validateNestedCheck(check, identity, cycles, issues, 'image');
      }
    }
    return;
  }
  if (family === 'crossword') {
    const executions = projection.executions;
    if (!Array.isArray(executions) || executions.length === 0) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_NESTED_PROJECTION_INVALID',
          'The crossword projection carries no executions.',
        ),
      );
      return;
    }
    for (const execution of executions) {
      if (!isPlainRecord(execution)) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_INVALID',
            'A crossword execution is not a plain object.',
          ),
        );
        continue;
      }
      const checks = Array.isArray(execution.checks) ? execution.checks : [];
      if (checks.length === 0) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_INVALID',
            'A crossword execution carries no checks.',
          ),
        );
      }
      for (const check of checks) {
        validateNestedCheck(check, identity, cycles, issues, 'crossword');
      }
    }
    return;
  }
  // history / restore: a single top-level action-cycle-bound check set.
  const checks = Array.isArray(projection.checks) ? projection.checks : [];
  if (checks.length === 0) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_INVALID',
        `The ${family} projection carries no checks.`,
      ),
    );
  }
  for (const check of checks) {
    validateNestedCheck(check, identity, cycles, issues, family);
  }
}

interface EnvelopeAgreement {
  profile: ResolvedCorrectnessProfile;
  identity: CorrectnessProfileIdentityView;
}

function validateEnvelope(
  envelopeValue: unknown,
  issues: FinalRecordIssue[],
): EnvelopeAgreement | null {
  if (!isPlainRecord(envelopeValue)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_NOT_OBJECT',
        'An execution envelope must be a plain object.',
      ),
    );
    return null;
  }
  const envelope = envelopeValue as unknown as Record<string, unknown>;
  if (envelope.schemaVersion !== MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_SCHEMA_UNSUPPORTED',
        `Execution envelope schema ${String(envelope.schemaVersion)} is not supported.`,
      ),
    );
  }
  if (!isFullCanonicalFingerprint(envelope.planFingerprint)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_INVALID',
        'The envelope plan fingerprint is not a full canonical 64-hex identity.',
      ),
    );
  }
  const plan = envelope.plan;
  if (!isPlainRecord(plan)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_INVALID',
        'The envelope carries no readable plan.',
      ),
    );
  } else {
    try {
      const recomputed = derivePlanFingerprint(
        plan as unknown as Parameters<typeof derivePlanFingerprint>[0],
      );
      if (recomputed !== envelope.planFingerprint) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
            'The recomputed plan fingerprint does not equal the envelope plan fingerprint.',
          ),
        );
      }
    } catch (error) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_INVALID',
          `The plan is not canonically fingerprintable: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if (plan.caseId !== envelope.caseId) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
          'The plan case id does not equal the envelope case id.',
        ),
      );
    }
  }
  const profileValue = envelope.correctnessProfile;
  if (!isPlainRecord(profileValue)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_PROFILE_MISSING',
        'The envelope carries no readable resolved correctness profile.',
      ),
    );
    return null;
  }
  const profile = profileValue as unknown as ResolvedCorrectnessProfile;
  if (profile.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
        `Resolved-profile schema ${String(profile.schemaVersion)} is not supported.`,
      ),
    );
  }
  const storedFingerprint = profile.resolvedFingerprint;
  if (!isFullCanonicalFingerprint(storedFingerprint)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_INVALID',
        'The resolved-profile fingerprint is not a full canonical 64-hex identity.',
      ),
    );
  } else {
    const { resolvedFingerprint: _drop, ...content } = profile as unknown as Record<
      string,
      unknown
    >;
    void _drop;
    try {
      const recomputed = deriveResolvedCorrectnessProfileFingerprint(
        content as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
      );
      if (recomputed !== storedFingerprint) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
            'The recomputed resolved-profile fingerprint does not equal the stored fingerprint; a compiled field was mutated.',
          ),
        );
      }
    } catch (error) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_INVALID',
          `The resolved profile is not canonically fingerprintable: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  validateComponentFingerprints(
    (profile as unknown as Record<string, unknown>).componentFingerprints,
    issues,
    'FINAL_RECORD_ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
  );
  const requiredChecks = Array.isArray(profile.requiredChecks) ? profile.requiredChecks : [];
  if (requiredChecks.length === 0) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT',
        'A compiled profile with no declared required check cannot produce a v4 record.',
      ),
    );
  }
  const seen = new Set<string>();
  for (const contract of requiredChecks) {
    const checkId =
      isPlainRecord(contract) && typeof contract.checkId === 'string' ? contract.checkId : '';
    if (checkId.length === 0) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT',
          'A compiled required check has no id.',
        ),
      );
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT',
          `Compiled required check "${checkId}" appears more than once.`,
        ),
      );
    }
    seen.add(checkId);
  }
  return { profile, identity: projectCorrectnessProfileIdentity(profile) };
}

export interface AssembleFinalChildRecordV4Input {
  /** The exact compile-once envelope produced by the same planning invocation. */
  envelope: MaterializedExecutionEnvelopeV1;
  runId: string;
  observationId: string | null;
  actionCycles: readonly ActionCycleCorrectnessIdentity[];
  requiredChecks: readonly CorrectnessCheckResult[];
  nestedProjections: readonly FinalNestedProjectionV4[];
}

/**
 * Assembles one complete strict v4 child record from a validated envelope and
 * the final result values. Every disagreement fails closed with no record.
 */
export function assembleFinalChildRecordV4(
  input: AssembleFinalChildRecordV4Input,
): FinalChildRecordAssemblyResult {
  const issues: FinalRecordIssue[] = [];
  if (!isNonEmptyString(input.runId)) {
    issues.push(
      finalIssue('FINAL_RECORD_FIELD_INVALID', 'A v4 record must carry a non-empty run id.'),
    );
  }
  const agreement = validateEnvelope(input.envelope, issues);
  if (agreement === null || issues.length > 0) return failure(issues);

  const { identity } = agreement as EnvelopeAgreement;
  const cycles = indexActionCycles(
    input.actionCycles,
    identity.componentFingerprints.readiness,
    issues,
  );
  for (const cycle of Array.isArray(input.actionCycles) ? input.actionCycles : []) {
    if (isPlainRecord(cycle) && cycle.resolvedProfileFingerprint !== identity.resolvedFingerprint) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ACTION_CYCLE_READINESS_MISMATCH',
          `Action Cycle "${String(cycle.actionCycleId)}" resolved-profile fingerprint does not equal the compiled profile.`,
        ),
      );
    }
  }
  if (!Array.isArray(input.requiredChecks)) {
    issues.push(
      finalIssue('FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT', 'requiredChecks must be an array.'),
    );
    return failure(issues);
  }
  for (const check of input.requiredChecks) {
    const separation = validateCheckContextSeparation(check);
    if (!separation.ok) {
      for (const issue of separation.issues) issues.push(asFinalIssue(issue));
    }
  }
  const identityAgreement = validateResultIdentityAgreement(identity, {
    actionCycles: Array.isArray(input.actionCycles) ? input.actionCycles : [],
    requiredChecks: input.requiredChecks as readonly CorrectnessCheckResult[],
  });
  for (const issue of identityAgreement.issues) issues.push(asFinalIssue(issue));

  if (!Array.isArray(input.nestedProjections)) {
    issues.push(
      finalIssue('FINAL_RECORD_NESTED_PROJECTION_INVALID', 'nestedProjections must be an array.'),
    );
    return failure(issues);
  }
  const families = new Set<string>();
  for (const projection of input.nestedProjections) {
    const family = isPlainRecord(projection) ? projection.family : undefined;
    if (isFinalNestedProjectionFamily(family)) {
      if (families.has(family)) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_DUPLICATE',
            `Nested projection family "${family}" appears more than once.`,
          ),
        );
      }
      families.add(family);
    }
    validateNestedProjection(
      projection,
      identity,
      (agreement as EnvelopeAgreement).profile.readiness.profileId,
      cycles,
      input.actionCycles,
      issues,
    );
  }
  if (!families.has('action-cycle')) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_INVALID',
        'A v4 record must carry the action-cycle readiness projection.',
      ),
    );
  }

  if (issues.length > 0) return failure(issues);

  let record: FinalCurrentChildRecordV4;
  try {
    record = cloneAndFreeze(
      {
        schemaVersion: FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
        runId: input.runId,
        caseId: (input.envelope as unknown as { caseId: string }).caseId,
        materializationFingerprint: (
          input.envelope as unknown as { materializationFingerprint: string }
        ).materializationFingerprint,
        planFingerprint: (input.envelope as unknown as { planFingerprint: string }).planFingerprint,
        profile: (agreement as EnvelopeAgreement).profile.profileId,
        observationId: input.observationId,
        resolvedProfileFingerprint: identity.resolvedFingerprint,
        componentFingerprints: identity.componentFingerprints,
        actionCycles: input.actionCycles,
        requiredChecks: input.requiredChecks,
        nestedProjections: input.nestedProjections,
      },
      'record',
    ) as unknown as FinalCurrentChildRecordV4;
  } catch (error) {
    return failure([
      finalIssue(
        'FINAL_RECORD_FIELD_INVALID',
        `The record could not be isolated: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    ]);
  }

  const selfCheck = validateFinalChildRecordV4(record);
  if (!selfCheck.ok) {
    return failure([
      finalIssue(
        'FINAL_RECORD_SELF_CHECK_FAILED',
        `The assembled record failed its own strict validation: ${selfCheck.issues
          .map((issue) => issue.code)
          .join(', ')}.`,
      ),
    ]);
  }
  return { ok: true, record };
}

/**
 * Assembles one strict v4 command-context record (Doctor / production-absence).
 * A command record carries its own versioned authority and never a fabricated
 * resolved profile.
 */
export function assembleFinalCommandRecordV4(input: {
  commandAuthority: CommandStatusAuthority;
  checks: readonly CommandCheckResultView[];
}): FinalCommandRecordAssemblyResult {
  const issues: FinalRecordIssue[] = [];
  const authority = input.commandAuthority;
  if (!isPlainRecord(authority) || !isCommandCheckContext(authority.command)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_CHECK_CONTEXT_INVALID',
        'A v4 command record requires a known command authority context.',
      ),
    );
    return failure(issues);
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    issues.push(
      finalIssue('FINAL_RECORD_FIELD_INVALID', 'A v4 command record must carry command checks.'),
    );
    return failure(issues);
  }
  const seen = new Set<string>();
  for (const check of input.checks) {
    const validation = validateCommandCheck(check);
    for (const issue of validation.issues) issues.push(asFinalIssue(issue));
    if (!isPlainRecord(check)) continue;
    const checkId = typeof check.checkId === 'string' ? check.checkId : '';
    if (checkId.length === 0) {
      issues.push(finalIssue('FINAL_RECORD_FIELD_INVALID', 'A command check has no id.'));
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_FIELD_INVALID',
          `Command check "${checkId}" appears more than once.`,
        ),
      );
    }
    seen.add(checkId);
    const checkAuthority = check.commandAuthority as unknown;
    if (
      !isPlainRecord(checkAuthority) ||
      checkAuthority.command !== authority.command ||
      checkAuthority.commandAuthorityFingerprint !== authority.commandAuthorityFingerprint
    ) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_CHECK_CONTEXT_INVALID',
          `Command check "${checkId}" does not share the record command authority.`,
          checkId,
        ),
      );
    }
  }
  if (issues.length > 0) return failure(issues);
  let record: FinalCommandCheckRecordV4;
  try {
    record = cloneAndFreeze(
      {
        schemaVersion: FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
        command: authority.command,
        commandAuthority: authority,
        checks: input.checks,
      },
      'commandRecord',
    ) as unknown as FinalCommandCheckRecordV4;
  } catch (error) {
    return failure([
      finalIssue(
        'FINAL_RECORD_FIELD_INVALID',
        `The command record could not be isolated: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    ]);
  }
  const selfCheck = validateFinalCommandRecordV4(record);
  if (!selfCheck.ok) {
    return failure([
      finalIssue(
        'FINAL_RECORD_SELF_CHECK_FAILED',
        `The assembled command record failed its own strict validation: ${selfCheck.issues
          .map((issue) => issue.code)
          .join(', ')}.`,
      ),
    ]);
  }
  return { ok: true, record };
}

export interface FinalRecordValidation {
  ok: boolean;
  issues: readonly FinalRecordIssue[];
}

function validateCheckInternalConsistency(
  check: unknown,
  record: Record<string, unknown>,
  cycles: CyclesIndex,
  components: Record<string, unknown> | null,
  issues: FinalRecordIssue[],
  label: string,
): void {
  validateCheckResultShape(check, issues as ResultContractIssue[]);
  const separation = validateCheckContextSeparation(check);
  for (const issue of separation.issues) issues.push(asFinalIssue(issue));
  if (!isPlainRecord(check)) return;
  const checkId = typeof check.checkId === 'string' ? check.checkId : null;
  if (typeof check.checkId !== 'string' || check.checkId.length === 0) {
    issues.push(finalIssue('FINAL_RECORD_FIELD_INVALID', `${label} has no check id.`));
  }
  if (typeof check.status === 'string' && !isCheckResultStatus(check.status)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_FIELD_INVALID',
        `${label} has unknown status "${check.status}".`,
        checkId,
      ),
    );
  }
  const ref = check.actionCycleRef;
  if (typeof ref === 'string' && ref.length > 0 && !cycles.byId.has(ref)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_ACTION_CYCLE_MISSING',
        `${label} references unresolved Action Cycle "${ref}".`,
        checkId,
      ),
    );
  }
  const consumed = check.consumedComponentFingerprints;
  if (!isPlainRecord(consumed)) return;
  if (consumed.resolvedProfile !== record.resolvedProfileFingerprint) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_FIELD_INVALID',
        `${label} consumed resolved profile does not equal the record resolved profile.`,
        checkId,
      ),
    );
  }
  if (components !== null) {
    for (const field of CONSUMED_COMPONENT_FIELDS) {
      if (consumed[field] !== components[field]) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_FIELD_INVALID',
            `${label} consumed component "${field}" does not equal the record component.`,
            checkId,
          ),
        );
      }
    }
  }
}

/**
 * Strict internal validation of an already-parsed v4 child record. It does not
 * consult a compiled profile (a stored record is read without one); it validates
 * the closed DTO shape, the internal identity agreement, the Action Cycle
 * resolution, and the absence of any legacy boolean/`harnessInvalid` surface.
 */
export function validateFinalChildRecordV4(value: unknown): FinalRecordValidation {
  const issues: FinalRecordIssue[] = [];
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: [finalIssue('FINAL_RECORD_NOT_OBJECT', 'A v4 record must be a plain object.')],
    };
  }
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CLOSED_CHILD_RECORD_KEYS as readonly string[]).includes(key)) {
      issues.push(
        finalIssue('FINAL_RECORD_FIELD_INVALID', `A v4 record carries unknown field "${key}".`),
      );
    }
  }
  if (record.schemaVersion !== FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_SCHEMA_UNSUPPORTED',
        `A v4 record must declare schemaVersion ${FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION}.`,
      ),
    );
  }
  for (const field of [
    'runId',
    'caseId',
    'materializationFingerprint',
    'planFingerprint',
    'profile',
  ] as const) {
    if (!isNonEmptyString(record[field])) {
      issues.push(
        finalIssue('FINAL_RECORD_FIELD_INVALID', `A v4 record requires a non-empty "${field}".`),
      );
    }
  }
  if (record.observationId !== null && typeof record.observationId !== 'string') {
    issues.push(
      finalIssue(
        'FINAL_RECORD_FIELD_INVALID',
        'A v4 record observationId must be a string or null.',
      ),
    );
  }
  if (!isFullCanonicalFingerprint(record.resolvedProfileFingerprint)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_FIELD_INVALID',
        'A v4 record resolved-profile fingerprint is not a full canonical 64-hex identity.',
      ),
    );
  }
  const components = isPlainRecord(record.componentFingerprints)
    ? (record.componentFingerprints as Record<string, unknown>)
    : null;
  validateComponentFingerprints(record.componentFingerprints, issues, 'FINAL_RECORD_FIELD_INVALID');
  const cycles = indexActionCycles(record.actionCycles, components?.readiness, issues);
  for (const cycle of Array.isArray(record.actionCycles) ? record.actionCycles : []) {
    if (
      isPlainRecord(cycle) &&
      cycle.resolvedProfileFingerprint !== record.resolvedProfileFingerprint
    ) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_ACTION_CYCLE_READINESS_MISMATCH',
          `Action Cycle "${String(cycle.actionCycleId)}" resolved-profile fingerprint does not equal the record resolved profile.`,
        ),
      );
    }
  }
  const requiredChecks = record.requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_FIELD_INVALID',
        'A v4 record must carry a non-empty required-check array.',
      ),
    );
  } else {
    const seen = new Set<string>();
    for (const check of requiredChecks) {
      const checkId =
        isPlainRecord(check) && typeof check.checkId === 'string' ? check.checkId : '';
      if (checkId.length > 0 && seen.has(checkId)) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_FIELD_INVALID',
            `Required check "${checkId}" appears more than once.`,
            checkId,
          ),
        );
        continue;
      }
      if (checkId.length > 0) seen.add(checkId);
      validateCheckInternalConsistency(
        check,
        record,
        cycles,
        components,
        issues,
        `Required check "${checkId}"`,
      );
    }
  }
  if (!Array.isArray(record.nestedProjections)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_NESTED_PROJECTION_INVALID',
        'A v4 record must carry nested projections.',
      ),
    );
  } else {
    const families = new Set<string>();
    let actionCycleProjectionPresent = false;
    for (const projection of record.nestedProjections) {
      if (!isPlainRecord(projection)) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_INVALID',
            'A nested projection is not a plain object.',
          ),
        );
        continue;
      }
      if (!isFinalNestedProjectionFamily(projection.family)) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_UNKNOWN_FAMILY',
            `Nested projection family "${String(projection.family)}" is unknown.`,
          ),
        );
        continue;
      }
      if (families.has(projection.family)) {
        issues.push(
          finalIssue(
            'FINAL_RECORD_NESTED_PROJECTION_DUPLICATE',
            `Nested projection family "${projection.family}" appears more than once.`,
          ),
        );
      }
      families.add(projection.family);
      if (projection.family === 'action-cycle') {
        actionCycleProjectionPresent = true;
        const projectionCycles = projection.actionCycles;
        if (
          !Array.isArray(projectionCycles) ||
          projectionCycles.length !== cycles.ids.length ||
          projectionCycles.some(
            (entry, index) => !isPlainRecord(entry) || entry.actionCycleId !== cycles.ids[index],
          )
        ) {
          issues.push(
            finalIssue(
              'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
              'The action-cycle projection must carry exactly the record Action Cycle identities.',
            ),
          );
        }
        continue;
      }
      const nestedCheckLists: readonly unknown[][] =
        projection.family === 'image'
          ? (Array.isArray(projection.cycles) ? projection.cycles : []).map((cycle) =>
              isPlainRecord(cycle) && Array.isArray(cycle.checks) ? cycle.checks : [],
            )
          : projection.family === 'crossword'
            ? (Array.isArray(projection.executions) ? projection.executions : []).map(
                (execution) =>
                  isPlainRecord(execution) && Array.isArray(execution.checks)
                    ? execution.checks
                    : [],
              )
            : [Array.isArray(projection.checks) ? projection.checks : []];
      for (const list of nestedCheckLists) {
        for (const check of list) {
          validateCheckInternalConsistency(
            check,
            record,
            cycles,
            components,
            issues,
            `Nested ${projection.family} check`,
          );
        }
      }
    }
    if (!actionCycleProjectionPresent) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_NESTED_PROJECTION_INVALID',
          'A v4 record must carry the action-cycle readiness projection.',
        ),
      );
    }
  }
  reportLegacyAuthority(record, issues, 'A v4 record');
  return { ok: issues.length === 0, issues: Object.freeze([...issues]) };
}

/** Strict internal validation of a parsed v4 command-context record. */
export function validateFinalCommandRecordV4(value: unknown): FinalRecordValidation {
  const issues: FinalRecordIssue[] = [];
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: [
        finalIssue('FINAL_RECORD_NOT_OBJECT', 'A v4 command record must be a plain object.'),
      ],
    };
  }
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CLOSED_COMMAND_RECORD_KEYS as readonly string[]).includes(key)) {
      issues.push(
        finalIssue(
          'FINAL_RECORD_FIELD_INVALID',
          `A v4 command record carries unknown field "${key}".`,
        ),
      );
    }
  }
  if (record.schemaVersion !== FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_SCHEMA_UNSUPPORTED',
        `A v4 command record must declare schemaVersion ${FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (!isCommandCheckContext(record.command)) {
    issues.push(
      finalIssue(
        'FINAL_RECORD_CHECK_CONTEXT_INVALID',
        'A v4 command record has an unknown command context.',
      ),
    );
  }
  if (!Array.isArray(record.checks) || record.checks.length === 0) {
    issues.push(
      finalIssue('FINAL_RECORD_FIELD_INVALID', 'A v4 command record must carry command checks.'),
    );
  } else {
    for (const check of record.checks) {
      const validation = validateCommandCheck(check);
      for (const issue of validation.issues) issues.push(asFinalIssue(issue));
    }
  }
  reportLegacyAuthority(record, issues, 'A v4 command record');
  return { ok: issues.length === 0, issues: Object.freeze([...issues]) };
}

/**
 * True when a parsed object is a command-context v4 record rather than a
 * compiled-profile v4 child record. Only the presence of the closed command
 * authority distinguishes them; no record is coerced between the two.
 */
export function isFinalCommandRecordShape(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasOwn(value, 'commandAuthority') &&
    !hasOwn(value, 'resolvedProfileFingerprint')
  );
}

export { COMMAND_CHECK_CONTEXTS };
