import { isFullCanonicalFingerprint } from './correctness';
import { isOutcome, type Outcome } from './discriminants';
import { finalRecordLegacyAuthorityIssues } from './final-record-v4';
import { isPlainRecord } from './result-agreement';
import { DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION } from './schema-versions';
import { isDiagnosticSuiteId, type DiagnosticSuiteId } from './suite';

/**
 * P7-B2-E2R v4-bound suite aggregate contract, schema version 2 (ADR 0031 §4).
 *
 * The current strict suite aggregate replaces the V1 `suite-record.json`
 * authority for the post-cutover path. It preserves the safe operational fields
 * of `PublicDiagnosticSuiteRecordV1` (suite identity, declaration fingerprint,
 * repository identity, timing, canonical order, completeness, interruption,
 * cleanup-stop, detail, and each child's behavior/final outcome verbatim) and it
 * carries its own closed discriminant (`label: 'suite-v2'`) and schema version
 * `2`. It never reuses the unrelated child schema number as its own version.
 *
 * "Strict-v4 bound" means every record-bearing child was independently read and
 * validated as a current strict-v4 child before the aggregate was assembled: the
 * child entry carries the child record schema version `4` and its verified plan
 * and profile identities, and a child that was explicitly refused before any
 * record is labelled `no-record-refusal` instead. A legacy, mixed,
 * identity-mismatched, misordered, duplicate, or unreadable child is rejected by
 * the assembler, never silently downgraded or rewritten.
 *
 * The aggregate additionally carries an immutable `suiteLineageId`, and each
 * child entry carries an independent `executionId` (never aliased to the
 * child's own `runId`) plus `parentSuiteExecutionId` and `suiteLineageId`, so
 * every child is attributable to exactly one suite execution (ADR 0019 R11).
 *
 * This module is the sole current suite authority: the active suite entry path
 * reaches it through the current final modules and no current/active surface
 * reads the removed V1 suite-record authority. It owns no filesystem access; the guarded exclusive writer and
 * the strict reader live beside it in `evidence/`.
 */

/** The suite aggregate's own closed schema version; never a child schema number. */
export const FINAL_SUITE_RECORD_SCHEMA_VERSION = 2;

/** The suite aggregate's closed discriminant. */
export const FINAL_SUITE_RECORD_LABEL = 'suite-v2';

/** The suite aggregate's stable command. */
export const FINAL_SUITE_RECORD_COMMAND = 'diagnostic';

export const FINAL_SUITE_RECORD_PROFILE = 'diagnostic';
export const FINAL_SUITE_RECORD_EXECUTION = 'sequential-independent-runs';

/**
 * The closed current suite aggregate status vocabulary (ADR 0031 §4).
 *
 * E3-S2 makes this v4-bound v2 aggregate the sole current suite authority, so it
 * owns the closed status set it accepts rather than importing the removed
 * schema-v1 aggregate authority. The declared order is the accepted aggregate
 * precedence: `ENVIRONMENT_FAILURE` > `HARNESS_BLOCKED` > `BUG` > `PASS`. The
 * statuses are the accepted `Outcome` vocabulary and are preserved verbatim from
 * each child, never converted into current meaning.
 */
export const FINAL_SUITE_AGGREGATE_STATUSES = [
  'ENVIRONMENT_FAILURE',
  'HARNESS_BLOCKED',
  'BUG',
  'PASS',
] as const;
export type FinalSuiteAggregateStatus = (typeof FINAL_SUITE_AGGREGATE_STATUSES)[number];

/** The closed discriminant of a record-bearing child entry. */
export const FINAL_SUITE_CHILD_CURRENT_LABEL = 'current-v4';
/** The closed discriminant of an explicit no-record refusal child entry. */
export const FINAL_SUITE_CHILD_REFUSAL_LABEL = 'no-record-refusal';

export const FINAL_SUITE_CHILD_CURRENT_LABEL_VALUE = 4;

/** The closed key set of one suite aggregate child entry. */
export const FINAL_SUITE_CHILD_KEYS: readonly string[] = Object.freeze([
  'order',
  'caseId',
  'request',
  'expectedOutcome',
  'runId',
  'executionId',
  'parentSuiteExecutionId',
  'suiteLineageId',
  'recordPresent',
  'childRecordLabel',
  'childRecordSchemaVersion',
  'childProfile',
  'materializationFingerprint',
  'planFingerprint',
  'expectedMet',
  'behaviorOutcome',
  'finalOutcome',
  'cleanupComplete',
  'startedAt',
  'endedAt',
  'durationMs',
  'runRecordRole',
]);

/** The closed key set of the complete suite aggregate record. */
export const FINAL_SUITE_RECORD_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'command',
  'label',
  'recordedAt',
  'suiteExecutionId',
  'suiteLineageId',
  'suiteId',
  'suiteVersion',
  'suiteFingerprint',
  'profile',
  'execution',
  'repository',
  'declaredCaseCount',
  'executedCount',
  'canonicalOrder',
  'children',
  'complete',
  'stoppedEarly',
  'stopReason',
  'interrupted',
  'aggregateStatus',
  'startedAt',
  'endedAt',
  'durationMs',
  'detail',
]);

const REPOSITORY_KEYS = ['commit', 'dirty', 'lockfileDigest'] as const;

/**
 * One aggregate child entry. A record-bearing child carries its strict-v4 child
 * identity; an explicit no-record refusal carries null identities instead. In
 * both cases the child's behavior and final outcome are preserved verbatim.
 */
export interface FinalSuiteChildRecordV2 {
  order: number;
  caseId: string;
  request: string;
  expectedOutcome: 'PASS';
  /** The child's own run-record identity; never aliased to `executionId`. */
  runId: string;
  /** The independent child execution identity; never aliased to `runId`. */
  executionId: string;
  /** The immutable parent suite execution identity. */
  parentSuiteExecutionId: string;
  /** The immutable suite-lineage identity shared by every member. */
  suiteLineageId: string;
  recordPresent: boolean;
  childRecordLabel: typeof FINAL_SUITE_CHILD_CURRENT_LABEL | typeof FINAL_SUITE_CHILD_REFUSAL_LABEL;
  childRecordSchemaVersion: number | null;
  childProfile: string | null;
  materializationFingerprint: string | null;
  planFingerprint: string | null;
  expectedMet: boolean;
  behaviorOutcome: Outcome | null;
  finalOutcome: Outcome;
  cleanupComplete: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  runRecordRole: 'run-record';
}

/**
 * The complete closed v4-bound suite aggregate record. It preserves the safe
 * operational fields of the V1 suite record and never carries a child `status`,
 * a `passed` boolean, or a `harnessInvalid` side channel.
 */
export interface FinalSuiteRecordV2 {
  schemaVersion: typeof FINAL_SUITE_RECORD_SCHEMA_VERSION;
  command: typeof FINAL_SUITE_RECORD_COMMAND;
  label: typeof FINAL_SUITE_RECORD_LABEL;
  recordedAt: string;
  suiteExecutionId: string;
  /** The immutable suite-lineage identity; every child must agree with it. */
  suiteLineageId: string;
  suiteId: DiagnosticSuiteId;
  suiteVersion: number;
  suiteFingerprint: string;
  profile: typeof FINAL_SUITE_RECORD_PROFILE;
  execution: typeof FINAL_SUITE_RECORD_EXECUTION;
  repository: { commit: string | null; dirty: boolean | null; lockfileDigest: string };
  declaredCaseCount: number;
  executedCount: number;
  canonicalOrder: readonly number[];
  children: readonly FinalSuiteChildRecordV2[];
  complete: boolean;
  stoppedEarly: boolean;
  stopReason: string | null;
  interrupted: boolean;
  aggregateStatus: FinalSuiteAggregateStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  detail: string;
}

/** Closed aggregate-assembly issue vocabulary; deliberately local. */
export const FINAL_SUITE_RECORD_ISSUE_CODES = [
  'SUITE_RECORD_NOT_OBJECT',
  'SUITE_RECORD_SCHEMA_UNSUPPORTED',
  'SUITE_RECORD_LABEL_UNSUPPORTED',
  'SUITE_RECORD_COMMAND_UNSUPPORTED',
  'SUITE_RECORD_UNKNOWN_KEY',
  'SUITE_RECORD_MISSING_KEY',
  'SUITE_RECORD_FIELD_INVALID',
  'SUITE_RECORD_SUITE_ID_UNKNOWN',
  'SUITE_RECORD_FINGERPRINT_INVALID',
  'SUITE_RECORD_COUNT_MISMATCH',
  'SUITE_RECORD_ORDER_INVALID',
  'SUITE_RECORD_CHILD_INVALID',
  'SUITE_RECORD_CHILD_DUPLICATE',
  'SUITE_RECORD_CHILD_NOT_STRICT_V4',
  'SUITE_RECORD_CHILD_IDENTITY_MISMATCH',
  'SUITE_RECORD_CHILD_EXECUTION_ALIASED',
  'SUITE_RECORD_LINEAGE_MISMATCH',
  'SUITE_RECORD_LEGACY_AUTHORITY_PRESENT',
] as const;
export type FinalSuiteRecordIssueCode = (typeof FINAL_SUITE_RECORD_ISSUE_CODES)[number];

export interface FinalSuiteRecordIssue {
  readonly code: FinalSuiteRecordIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface FinalSuiteRecordValidation {
  readonly ok: boolean;
  readonly issues: readonly FinalSuiteRecordIssue[];
}

export interface FinalSuiteRecordAssemblyFailure {
  readonly ok: false;
  readonly status: 'HARNESS_BLOCKED';
  readonly issues: readonly FinalSuiteRecordIssue[];
}

export type FinalSuiteRecordAssemblyResult =
  | { readonly ok: true; readonly record: FinalSuiteRecordV2 }
  | FinalSuiteRecordAssemblyFailure;

function issue(
  code: FinalSuiteRecordIssueCode,
  detail: string,
  checkId: string | null = null,
): FinalSuiteRecordIssue {
  return { code, detail, checkId };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function closedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  issues: FinalSuiteRecordIssue[],
): void {
  for (const key of expected) {
    if (!hasOwn(value, key)) {
      issues.push(issue('SUITE_RECORD_MISSING_KEY', `${label} is missing closed key "${key}".`));
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      issues.push(issue('SUITE_RECORD_UNKNOWN_KEY', `${label} carries unknown key "${key}".`));
    }
  }
}

function legacyAuthorityIssues(value: unknown): FinalSuiteRecordIssue[] {
  return finalRecordLegacyAuthorityIssues(value, 'The v4-bound suite aggregate').map((entry) =>
    issue('SUITE_RECORD_LEGACY_AUTHORITY_PRESENT', entry.detail),
  );
}

function validateRepository(value: unknown, issues: FinalSuiteRecordIssue[]): void {
  if (!isPlainRecord(value)) {
    issues.push(issue('SUITE_RECORD_FIELD_INVALID', 'repository is not a plain object.'));
    return;
  }
  closedKeys(value, REPOSITORY_KEYS, 'repository', issues);
  if (!(value.commit === null || isNonEmptyString(value.commit))) {
    issues.push(
      issue(
        'SUITE_RECORD_FIELD_INVALID',
        'repository.commit is neither null nor a non-empty string.',
      ),
    );
  }
  if (!(value.dirty === null || typeof value.dirty === 'boolean')) {
    issues.push(
      issue('SUITE_RECORD_FIELD_INVALID', 'repository.dirty is neither null nor a boolean.'),
    );
  }
  if (!isNonEmptyString(value.lockfileDigest)) {
    issues.push(
      issue('SUITE_RECORD_FIELD_INVALID', 'repository.lockfileDigest is not a non-empty string.'),
    );
  }
}

function validateChild(value: unknown, index: number, issues: FinalSuiteRecordIssue[]): void {
  const label = `children[${index}]`;
  if (!isPlainRecord(value)) {
    issues.push(issue('SUITE_RECORD_CHILD_INVALID', `${label} is not a plain object.`));
    return;
  }
  closedKeys(value, FINAL_SUITE_CHILD_KEYS, label, issues);
  if (!isPositiveInteger(value.order)) {
    issues.push(issue('SUITE_RECORD_CHILD_INVALID', `${label}.order is not a positive integer.`));
  }
  if (value.order !== index + 1) {
    issues.push(
      issue(
        'SUITE_RECORD_ORDER_INVALID',
        `${label}.order ${String(value.order)} is not canonical position ${index + 1}.`,
      ),
    );
  }
  for (const key of [
    'caseId',
    'request',
    'runId',
    'executionId',
    'parentSuiteExecutionId',
    'suiteLineageId',
    'startedAt',
    'endedAt',
  ] as const) {
    if (!isNonEmptyString(value[key])) {
      issues.push(
        issue('SUITE_RECORD_CHILD_INVALID', `${label}.${key} is not a non-empty string.`),
      );
    }
  }
  if (value.expectedOutcome !== 'PASS') {
    issues.push(issue('SUITE_RECORD_CHILD_INVALID', `${label}.expectedOutcome must be "PASS".`));
  }
  // A child execution identity equal to the child's own run id carries no
  // independent information: it is an alias, not a second identity.
  if (
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.executionId) &&
    value.runId === value.executionId
  ) {
    issues.push(
      issue(
        'SUITE_RECORD_CHILD_EXECUTION_ALIASED',
        `${label}.executionId is an alias of its own runId; the child execution identity must be independent.`,
      ),
    );
  }
  if (typeof value.recordPresent !== 'boolean') {
    issues.push(issue('SUITE_RECORD_CHILD_INVALID', `${label}.recordPresent is not a boolean.`));
  }
  if (value.recordPresent === true) {
    if (value.childRecordLabel !== FINAL_SUITE_CHILD_CURRENT_LABEL) {
      issues.push(
        issue(
          'SUITE_RECORD_CHILD_NOT_STRICT_V4',
          `${label}.childRecordLabel must be "${FINAL_SUITE_CHILD_CURRENT_LABEL}" for a record-bearing child.`,
        ),
      );
    }
    if (value.childRecordSchemaVersion !== FINAL_SUITE_CHILD_CURRENT_LABEL_VALUE) {
      issues.push(
        issue(
          'SUITE_RECORD_CHILD_NOT_STRICT_V4',
          `${label}.childRecordSchemaVersion must be ${FINAL_SUITE_CHILD_CURRENT_LABEL_VALUE}.`,
        ),
      );
    }
    if (!isNonEmptyString(value.childProfile)) {
      issues.push(
        issue('SUITE_RECORD_CHILD_INVALID', `${label}.childProfile is not a non-empty string.`),
      );
    }
    if (!isFullCanonicalFingerprint(value.materializationFingerprint)) {
      issues.push(
        issue(
          'SUITE_RECORD_CHILD_IDENTITY_MISMATCH',
          `${label}.materializationFingerprint is not a full canonical 64-hex identity.`,
        ),
      );
    }
    if (!isFullCanonicalFingerprint(value.planFingerprint)) {
      issues.push(
        issue(
          'SUITE_RECORD_CHILD_IDENTITY_MISMATCH',
          `${label}.planFingerprint is not a full canonical 64-hex identity.`,
        ),
      );
    }
  } else if (value.recordPresent === false) {
    if (value.childRecordLabel !== FINAL_SUITE_CHILD_REFUSAL_LABEL) {
      issues.push(
        issue(
          'SUITE_RECORD_CHILD_INVALID',
          `${label}.childRecordLabel must be "${FINAL_SUITE_CHILD_REFUSAL_LABEL}" for an explicit no-record refusal.`,
        ),
      );
    }
    for (const key of [
      'childRecordSchemaVersion',
      'childProfile',
      'materializationFingerprint',
      'planFingerprint',
    ] as const) {
      if (value[key] !== null) {
        issues.push(
          issue(
            'SUITE_RECORD_CHILD_INVALID',
            `${label}.${key} must be null for an explicit no-record refusal.`,
          ),
        );
      }
    }
  }
  if (typeof value.expectedMet !== 'boolean' || typeof value.cleanupComplete !== 'boolean') {
    issues.push(
      issue('SUITE_RECORD_CHILD_INVALID', `${label} expectedMet/cleanupComplete are not booleans.`),
    );
  }
  if (!(value.behaviorOutcome === null || isOutcome(value.behaviorOutcome))) {
    issues.push(
      issue(
        'SUITE_RECORD_CHILD_INVALID',
        `${label}.behaviorOutcome is not a terminal outcome or null.`,
      ),
    );
  }
  if (!isOutcome(value.finalOutcome)) {
    issues.push(
      issue('SUITE_RECORD_CHILD_INVALID', `${label}.finalOutcome is not a terminal outcome.`),
    );
  }
  if (!isFiniteNonNegativeNumber(value.durationMs)) {
    issues.push(
      issue(
        'SUITE_RECORD_CHILD_INVALID',
        `${label}.durationMs is not a finite non-negative number.`,
      ),
    );
  }
  if (value.runRecordRole !== 'run-record') {
    issues.push(
      issue('SUITE_RECORD_CHILD_INVALID', `${label}.runRecordRole must be "run-record".`),
    );
  }
}

function validateBaseShape(value: Record<string, unknown>, issues: FinalSuiteRecordIssue[]): void {
  closedKeys(value, FINAL_SUITE_RECORD_KEYS, 'suite aggregate', issues);
  if (value.schemaVersion !== FINAL_SUITE_RECORD_SCHEMA_VERSION) {
    issues.push(
      issue(
        'SUITE_RECORD_SCHEMA_UNSUPPORTED',
        `Suite aggregate schema ${String(value.schemaVersion)} is not the supported ${FINAL_SUITE_RECORD_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (value.command !== FINAL_SUITE_RECORD_COMMAND) {
    issues.push(
      issue(
        'SUITE_RECORD_COMMAND_UNSUPPORTED',
        `Suite aggregate command "${String(value.command)}" is not "${FINAL_SUITE_RECORD_COMMAND}".`,
      ),
    );
  }
  if (value.label !== FINAL_SUITE_RECORD_LABEL) {
    issues.push(
      issue(
        'SUITE_RECORD_LABEL_UNSUPPORTED',
        `Suite aggregate label "${String(value.label)}" is not "${FINAL_SUITE_RECORD_LABEL}".`,
      ),
    );
  }
  if (!isDiagnosticSuiteId(value.suiteId)) {
    issues.push(
      issue(
        'SUITE_RECORD_SUITE_ID_UNKNOWN',
        `Suite aggregate suiteId "${String(value.suiteId)}" is not a closed suite identity.`,
      ),
    );
  }
  if (!isPositiveInteger(value.suiteVersion)) {
    issues.push(issue('SUITE_RECORD_FIELD_INVALID', 'suiteVersion is not a positive integer.'));
  }
  if (!isFullCanonicalFingerprint(value.suiteFingerprint)) {
    issues.push(
      issue(
        'SUITE_RECORD_FINGERPRINT_INVALID',
        'suiteFingerprint is not a full canonical 64-hex identity.',
      ),
    );
  }
  for (const key of [
    'recordedAt',
    'suiteExecutionId',
    'suiteLineageId',
    'startedAt',
    'endedAt',
    'detail',
  ] as const) {
    if (!isNonEmptyString(value[key])) {
      issues.push(issue('SUITE_RECORD_FIELD_INVALID', `${key} is not a non-empty string.`));
    }
  }
  // A suite execution identity and the suite-lineage identity are two distinct
  // roles; an execution that merely re-states its lineage carries no independent
  // binding and is rejected rather than accepted as an alias.
  if (
    isNonEmptyString(value.suiteExecutionId) &&
    isNonEmptyString(value.suiteLineageId) &&
    value.suiteExecutionId === value.suiteLineageId
  ) {
    issues.push(
      issue(
        'SUITE_RECORD_LINEAGE_MISMATCH',
        'suiteExecutionId aliases suiteLineageId; the two suite identities must be independent.',
      ),
    );
  }
  if (value.profile !== FINAL_SUITE_RECORD_PROFILE) {
    issues.push(
      issue('SUITE_RECORD_FIELD_INVALID', `profile must be "${FINAL_SUITE_RECORD_PROFILE}".`),
    );
  }
  if (value.execution !== FINAL_SUITE_RECORD_EXECUTION) {
    issues.push(
      issue('SUITE_RECORD_FIELD_INVALID', `execution must be "${FINAL_SUITE_RECORD_EXECUTION}".`),
    );
  }
  validateRepository(value.repository, issues);
  for (const key of ['complete', 'stoppedEarly', 'interrupted'] as const) {
    if (typeof value[key] !== 'boolean') {
      issues.push(issue('SUITE_RECORD_FIELD_INVALID', `${key} is not a boolean.`));
    }
  }
  if (!(value.stopReason === null || isNonEmptyString(value.stopReason))) {
    issues.push(
      issue('SUITE_RECORD_FIELD_INVALID', 'stopReason is neither null nor a non-empty string.'),
    );
  }
  if (!(FINAL_SUITE_AGGREGATE_STATUSES as readonly unknown[]).includes(value.aggregateStatus)) {
    issues.push(
      issue(
        'SUITE_RECORD_FIELD_INVALID',
        `aggregateStatus "${String(value.aggregateStatus)}" is not a closed aggregate status.`,
      ),
    );
  }
  if (!isFiniteNonNegativeNumber(value.durationMs)) {
    issues.push(
      issue('SUITE_RECORD_FIELD_INVALID', 'durationMs is not a finite non-negative number.'),
    );
  }
  if (!isPositiveInteger(value.declaredCaseCount) || !isNonNegativeInteger(value.executedCount)) {
    issues.push(
      issue(
        'SUITE_RECORD_FIELD_INVALID',
        'declaredCaseCount/executedCount are not non-negative integers.',
      ),
    );
  } else if (value.executedCount > value.declaredCaseCount) {
    issues.push(issue('SUITE_RECORD_COUNT_MISMATCH', 'executedCount exceeds declaredCaseCount.'));
  }
}

function validateChildrenAndOrder(
  value: Record<string, unknown>,
  issues: FinalSuiteRecordIssue[],
): void {
  const children = Array.isArray(value.children) ? value.children : null;
  if (children === null) {
    issues.push(issue('SUITE_RECORD_FIELD_INVALID', 'children is not an array.'));
    return;
  }
  if (isNonNegativeInteger(value.executedCount) && children.length !== value.executedCount) {
    issues.push(
      issue(
        'SUITE_RECORD_COUNT_MISMATCH',
        `children length ${children.length} does not equal executedCount ${String(value.executedCount)}.`,
      ),
    );
  }
  children.forEach((child, index) => {
    validateChild(child, index, issues);
  });

  const order = value.canonicalOrder;
  if (!Array.isArray(order) || !order.every((entry) => isPositiveInteger(entry))) {
    issues.push(
      issue('SUITE_RECORD_ORDER_INVALID', 'canonicalOrder is not an array of positive integers.'),
    );
  } else {
    if (isNonNegativeInteger(value.executedCount) && order.length !== value.executedCount) {
      issues.push(
        issue('SUITE_RECORD_ORDER_INVALID', 'canonicalOrder length does not equal executedCount.'),
      );
    }
    if (!order.every((entry, index) => entry === index + 1)) {
      issues.push(
        issue(
          'SUITE_RECORD_ORDER_INVALID',
          `canonicalOrder [${order.join(', ')}] is not the contiguous order 1..N.`,
        ),
      );
    }
  }
  const caseIds = children.map((child) => (isPlainRecord(child) ? child.caseId : undefined));
  const requests = children.map((child) => (isPlainRecord(child) ? child.request : undefined));
  const orders = children.map((child) => (isPlainRecord(child) ? child.order : undefined));
  const runIds = children.map((child) => (isPlainRecord(child) ? child.runId : undefined));
  const executionIds = children.map((child) =>
    isPlainRecord(child) ? child.executionId : undefined,
  );
  if (
    new Set(caseIds).size !== caseIds.length ||
    new Set(requests).size !== requests.length ||
    new Set(orders).size !== orders.length ||
    new Set(runIds).size !== runIds.length ||
    new Set(executionIds).size !== executionIds.length
  ) {
    issues.push(
      issue(
        'SUITE_RECORD_CHILD_DUPLICATE',
        'Suite aggregate children repeat a case id, request, order, run id, or execution id.',
      ),
    );
  }

  // A child execution identity must be independent from every child run id, not
  // only from its own: an execution id copied across members is an alias that
  // destroys the one-execution-per-child binding.
  const runIdSet = new Set(runIds.filter(isNonEmptyString));
  children.forEach((child, index) => {
    if (!isPlainRecord(child)) return;
    if (
      isNonEmptyString(child.executionId) &&
      child.executionId !== child.runId &&
      runIdSet.has(child.executionId)
    ) {
      issues.push(
        issue(
          'SUITE_RECORD_CHILD_EXECUTION_ALIASED',
          `children[${index}].executionId aliases another child's runId; the child execution identity must be independent.`,
        ),
      );
    }
  });

  // Every child must carry the aggregate's immutable suite execution and
  // lineage identities; a child copied from another suite execution can never
  // be aggregated as if it belonged to this one.
  const suiteExecutionId = value.suiteExecutionId;
  const suiteLineageId = value.suiteLineageId;
  children.forEach((child, index) => {
    if (!isPlainRecord(child)) return;
    const label = `children[${index}]`;
    if (
      isNonEmptyString(suiteExecutionId) &&
      isNonEmptyString(child.parentSuiteExecutionId) &&
      child.parentSuiteExecutionId !== suiteExecutionId
    ) {
      issues.push(
        issue(
          'SUITE_RECORD_LINEAGE_MISMATCH',
          `${label}.parentSuiteExecutionId does not equal the aggregate suiteExecutionId.`,
        ),
      );
    }
    if (
      isNonEmptyString(suiteLineageId) &&
      isNonEmptyString(child.suiteLineageId) &&
      child.suiteLineageId !== suiteLineageId
    ) {
      issues.push(
        issue(
          'SUITE_RECORD_LINEAGE_MISMATCH',
          `${label}.suiteLineageId does not equal the aggregate suiteLineageId.`,
        ),
      );
    }
  });
}

/** Validates a complete v4-bound suite aggregate record. */
export function validateFinalSuiteRecordV2(value: unknown): FinalSuiteRecordValidation {
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: Object.freeze([
        issue('SUITE_RECORD_NOT_OBJECT', 'A suite aggregate must be a plain object.'),
      ]),
    };
  }
  const issues: FinalSuiteRecordIssue[] = [];
  validateBaseShape(value, issues);
  validateChildrenAndOrder(value, issues);
  issues.push(...legacyAuthorityIssues(value));
  return { ok: issues.length === 0, issues: Object.freeze(issues) };
}

/**
 * Builds the complete closed suite aggregate record from a validated payload.
 * It never coerces a missing field: the payload is the responsibility of the
 * current final-path assembler, which supplies only accepted current-v4 child
 * identities and explicit no-record refusals.
 */
export function buildFinalSuiteRecordV2(
  payload: Omit<FinalSuiteRecordV2, 'schemaVersion' | 'command' | 'label' | 'recordedAt'>,
  recordedAt: string = new Date().toISOString(),
): FinalSuiteRecordV2 {
  return {
    schemaVersion: FINAL_SUITE_RECORD_SCHEMA_VERSION,
    command: FINAL_SUITE_RECORD_COMMAND,
    label: FINAL_SUITE_RECORD_LABEL,
    recordedAt,
    ...payload,
  };
}

/** Assembles and validates one complete v4-bound suite aggregate record. */
export function assembleFinalSuiteRecordV2(
  payload: Omit<FinalSuiteRecordV2, 'schemaVersion' | 'command' | 'label' | 'recordedAt'>,
  recordedAt?: string,
): FinalSuiteRecordAssemblyResult {
  const record = buildFinalSuiteRecordV2(payload, recordedAt);
  const validation = validateFinalSuiteRecordV2(record);
  if (!validation.ok) {
    return { ok: false, status: 'HARNESS_BLOCKED', issues: validation.issues };
  }
  return { ok: true, record };
}

// ── Strict reader ────────────────────────────────────────────────────────────

export interface FinalSuiteCurrentV2View {
  readonly kind: 'suite-v2';
  readonly label: typeof FINAL_SUITE_RECORD_LABEL;
  readonly schemaVersion: typeof FINAL_SUITE_RECORD_SCHEMA_VERSION;
  readonly legacy: false;
  readonly current: true;
  readonly record: FinalSuiteRecordV2;
  readonly issues: readonly FinalSuiteRecordIssue[];
}

/**
 * Labelled, read-only, non-converting historical V1 suite record. The historical
 * value is preserved verbatim and can never satisfy current acceptance.
 */
export interface FinalSuiteLegacyV1View {
  readonly kind: 'legacy-suite-v1';
  readonly label: 'suite-v1-legacy';
  readonly schemaVersion: number;
  readonly legacy: true;
  readonly current: false;
  readonly record: Record<string, unknown>;
  readonly issues: readonly FinalSuiteRecordIssue[];
}

export interface FinalSuiteInvalidView {
  readonly kind: 'invalid';
  readonly label: 'invalid';
  readonly schemaVersion: null;
  readonly legacy: false;
  readonly current: false;
  readonly record: null;
  readonly issues: readonly FinalSuiteRecordIssue[];
}

export type FinalSuiteRecordReadResult =
  | FinalSuiteCurrentV2View
  | FinalSuiteLegacyV1View
  | FinalSuiteInvalidView;

function invalidView(issues: readonly FinalSuiteRecordIssue[]): FinalSuiteInvalidView {
  return {
    kind: 'invalid',
    label: 'invalid',
    schemaVersion: null,
    legacy: false,
    current: false,
    record: null,
    issues,
  };
}

/**
 * Reads an already-parsed suite record into exactly one branch. A schema-2
 * `suite-v2` record is accepted only when its complete closed DTO validates; a
 * historical schema-1 record is exposed through the labelled, non-converting
 * legacy branch (never converted into current meaning); everything else is
 * rejected.
 */
export function readFinalSuiteRecord(value: unknown): FinalSuiteRecordReadResult {
  if (!isPlainRecord(value)) {
    return invalidView([
      issue('SUITE_RECORD_NOT_OBJECT', 'A suite record must be a plain object.'),
    ]);
  }
  if (value.schemaVersion === FINAL_SUITE_RECORD_SCHEMA_VERSION) {
    const validation = validateFinalSuiteRecordV2(value);
    if (!validation.ok) return invalidView(validation.issues);
    return {
      kind: 'suite-v2',
      label: FINAL_SUITE_RECORD_LABEL,
      schemaVersion: FINAL_SUITE_RECORD_SCHEMA_VERSION,
      legacy: false,
      current: true,
      record: value as unknown as FinalSuiteRecordV2,
      issues: Object.freeze([]),
    };
  }
  if (
    value.schemaVersion === DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION &&
    !hasOwn(value, 'label') &&
    value.command === FINAL_SUITE_RECORD_COMMAND
  ) {
    return {
      kind: 'legacy-suite-v1',
      label: 'suite-v1-legacy',
      schemaVersion: DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION,
      legacy: true,
      current: false,
      record: value,
      issues: Object.freeze([]),
    };
  }
  return invalidView([
    issue(
      'SUITE_RECORD_SCHEMA_UNSUPPORTED',
      `Suite record schema ${String(value.schemaVersion)} is neither the current ${FINAL_SUITE_RECORD_SCHEMA_VERSION} nor the historical ${DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION}.`,
    ),
  ]);
}
