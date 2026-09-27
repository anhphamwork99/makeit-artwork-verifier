import { readFinalRecord } from '../contracts/final-record-reader';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { Outcome } from '../contracts/discriminants';
import {
  FINAL_SUITE_AGGREGATE_STATUSES,
  type FinalSuiteAggregateStatus,
} from '../contracts/final-suite-record';
import type { MaterializedExecutionEnvelopeV1 } from '../planner/execution-materialization';
import {
  executeDiagnosticCase,
  type DiagnosticExecutionInput,
  type DiagnosticExecutionOutcome,
} from './diagnostic-execution';

/**
 * P7-B2-D1 representative-suite child execution and aggregation (ADR 0029 §4
 * B2-D; post-cutover current path, ADR 0032 §E3-S2).
 *
 * A suite is a canonical sequence of independent Diagnostic cases. Each child
 * owns its own compile-once envelope; no child may recover a profile from a
 * sibling merely because a profile id or fingerprint happens to match. The
 * aggregation preserves every child's behavior and final outcome independently
 * and refuses a child whose record is legacy, mixed, identity-mismatched, or
 * does not carry the exact compiled required-check set.
 *
 * This module is the current suite-child orchestration: the post-cutover suite
 * entry reaches it through the final façade. It writes no evidence itself and
 * references no legacy boolean/v3 writer, reader, or classifier.
 */

/** Suite membership facts added to a Diagnostic child execution. */
export interface SuiteChildExecutionInput extends DiagnosticExecutionInput {
  /** 1-based canonical position; the declared order is the execution order. */
  readonly order: number;
  /** Planner-derived semantic case identity asserted by the declaration. */
  readonly caseId: string;
  /** Stable skill-relative request path; never an absolute path. */
  readonly request: string;
  /** The representative assertion; a non-`PASS` expectation is not accepted. */
  readonly expectedOutcome: 'PASS';
}

/** One executed suite child with its own envelope and classified outcome. */
export interface SuiteChildOutcome {
  readonly order: number;
  readonly caseId: string;
  readonly request: string;
  readonly expectedOutcome: 'PASS';
  /** The child's own exact envelope, or `null` for an undelivered binding. */
  readonly envelope: MaterializedExecutionEnvelopeV1 | null;
  readonly execution: DiagnosticExecutionOutcome;
  /** True only when the declared case id equals the child's planned identity. */
  readonly identityAgrees: boolean;
}

/**
 * Runs one suite child through the inactive Diagnostic orchestration. The child
 * keeps its own envelope; nothing is shared or looked up across children.
 */
export function executeSuiteChild(input: SuiteChildExecutionInput): SuiteChildOutcome {
  const execution = executeDiagnosticCase(input);
  const envelope = input.planning.status === 'PLANNED' ? input.planning.envelope : null;
  return {
    order: input.order,
    caseId: input.caseId,
    request: input.request,
    expectedOutcome: input.expectedOutcome,
    envelope,
    execution,
    identityAgrees: execution.caseId === input.caseId,
  };
}

/** Closed aggregation refusal vocabulary. */
export const SUITE_AGGREGATION_ISSUE_CODES = [
  'SUITE_MEMBER_COUNT_MISMATCH',
  'SUITE_ORDER_INVALID',
  'SUITE_MEMBER_IDENTITY_MISMATCH',
  'SUITE_ENVELOPE_MISSING',
  'SUITE_CHILD_LEGACY_RECORD',
  'SUITE_CHILD_MIXED_RECORD',
  'SUITE_CHILD_INVALID_RECORD',
  'SUITE_CHILD_INCOMPLETE',
] as const;
export type SuiteAggregationIssueCode = (typeof SUITE_AGGREGATION_ISSUE_CODES)[number];

const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<SuiteAggregationIssueCode, DiagnosticCode>> =
  Object.freeze({
    SUITE_MEMBER_COUNT_MISMATCH: 'DIAGNOSTIC_SUITE_INCOMPLETE',
    SUITE_ORDER_INVALID: 'DIAGNOSTIC_SUITE_INVALID',
    SUITE_MEMBER_IDENTITY_MISMATCH: 'DIAGNOSTIC_SUITE_INVALID',
    SUITE_ENVELOPE_MISSING: 'CORRECTNESS_PROFILE_MISSING',
    SUITE_CHILD_LEGACY_RECORD: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    SUITE_CHILD_MIXED_RECORD: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    SUITE_CHILD_INVALID_RECORD: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    SUITE_CHILD_INCOMPLETE: 'CORRECTNESS_REFERENCE_UNRESOLVED',
  } satisfies Record<SuiteAggregationIssueCode, DiagnosticCode>);

export interface SuiteAggregationIssue {
  readonly code: SuiteAggregationIssueCode;
  readonly detail: string;
}

export interface SuiteAggregationInput {
  readonly declaredCaseCount: number;
  readonly children: readonly SuiteChildOutcome[];
  /** External interruption after validated execution began. */
  readonly interrupted?: boolean;
  /** A child stopped the sequence because its cleanup was not complete. */
  readonly stoppedOnCleanup?: boolean;
}

/** One preserved child verdict; behavior and final are never collapsed. */
export interface SuiteChildSummary {
  readonly order: number;
  readonly caseId: string;
  readonly request: string;
  readonly expectedOutcome: 'PASS';
  readonly expectedMet: boolean;
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly recordPresent: boolean;
}

export interface SuiteAggregateDecision {
  /** Aggregate of the child behavior outcomes; `null` behavior is `HARNESS_BLOCKED`. */
  readonly behaviorStatus: FinalSuiteAggregateStatus;
  /** Aggregate of the child final outcomes; this is the terminal suite status. */
  readonly finalStatus: FinalSuiteAggregateStatus;
  /** Exactly the declared children were executed once in canonical order. */
  readonly complete: boolean;
  readonly pass: boolean;
  readonly children: readonly SuiteChildSummary[];
}

export type SuiteAggregationResult =
  | { readonly ok: true; readonly decision: SuiteAggregateDecision }
  | {
      readonly ok: false;
      readonly status: 'HARNESS_BLOCKED';
      readonly code: DiagnosticCode;
      readonly diagnostic: DiagnosticRecord;
      readonly issues: readonly SuiteAggregationIssue[];
    };

/**
 * The aggregate precedence vocabulary is reused from the current v4-bound suite
 * authority (`contracts/final-suite-record.ts`), whose declared order is the
 * accepted precedence: `ENVIRONMENT_FAILURE` > `HARNESS_BLOCKED` > `BUG` >
 * `PASS`.
 */
const STATUS_BY_SEVERITY: Readonly<Record<number, FinalSuiteAggregateStatus>> = Object.freeze({
  0: FINAL_SUITE_AGGREGATE_STATUSES[3],
  1: FINAL_SUITE_AGGREGATE_STATUSES[2],
  2: FINAL_SUITE_AGGREGATE_STATUSES[1],
  3: FINAL_SUITE_AGGREGATE_STATUSES[0],
});

/**
 * The child-outcome severity rank, re-homed here when E3-S2 removed the
 * schema-v1 aggregate authority from `contracts/suite.ts` (ADR 0032 §E3-S2,
 * Option B: the v2 module owns the status vocabulary; the aggregator owns the
 * mapping). It ranks one child outcome; it never rewrites, downgrades, or
 * reclassifies a child verdict.
 */
const OUTCOME_SEVERITY: Readonly<Record<Outcome, number>> = Object.freeze({
  PASS: 0,
  BUG: 1,
  HARNESS_BLOCKED: 2,
  ENVIRONMENT_FAILURE: 3,
});

/** The one local child-outcome→severity mapping; an unknown outcome fails closed. */
export function suiteSeverityOf(outcome: Outcome): number {
  const severity = OUTCOME_SEVERITY[outcome];
  if (severity === undefined) {
    throw new Error(`Unknown child outcome "${String(outcome)}".`);
  }
  return severity;
}

function refusal(issues: readonly SuiteAggregationIssue[]): SuiteAggregationResult {
  const primary = issues[0] as SuiteAggregationIssue;
  const code = PRIMARY_DIAGNOSTIC_CODE[primary.code];
  return {
    ok: false,
    status: 'HARNESS_BLOCKED',
    code,
    diagnostic: createDiagnostic(code, `${primary.code}: ${primary.detail}`, {
      context: { issueCode: primary.code },
    }),
    issues: Object.freeze([...issues]),
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

interface RecordIdentity {
  readonly caseId: unknown;
  readonly materializationFingerprint: unknown;
  readonly planFingerprint: unknown;
  readonly resolvedProfileFingerprint: unknown;
  readonly requiredChecks: readonly unknown[];
}

/**
 * Validates one child's strict v4 record against its own exact envelope and
 * fails closed on a legacy/mixed/invalid record, an identity mismatch, or an
 * incomplete required-check set. A child with no record is accepted and
 * contributes only its already-classified verdict.
 */
function validateChildRecord(child: SuiteChildOutcome, issues: SuiteAggregationIssue[]): void {
  if (!child.identityAgrees) {
    issues.push({
      code: 'SUITE_MEMBER_IDENTITY_MISMATCH',
      detail: `Suite member ${child.order} declares case id "${child.caseId}" which does not equal its planned identity "${String(child.execution.caseId)}".`,
    });
  }
  const record = child.execution.record;
  if (record === null) return;
  if (child.envelope === null) {
    issues.push({
      code: 'SUITE_ENVELOPE_MISSING',
      detail: `Suite member ${child.order} produced a v4 record without its own execution envelope.`,
    });
    return;
  }
  const read = readFinalRecord(record);
  if (read.kind !== 'current-v4') {
    const code: SuiteAggregationIssueCode = read.legacy
      ? 'SUITE_CHILD_LEGACY_RECORD'
      : read.kind === 'mixed'
        ? 'SUITE_CHILD_MIXED_RECORD'
        : 'SUITE_CHILD_INVALID_RECORD';
    issues.push({
      code,
      detail: `Suite member ${child.order} record classified as "${read.label}" (${read.issues
        .map((issue) => issue.code)
        .join(', ')}); only a strict current v4 child record may be aggregated.`,
    });
    return;
  }

  const envelopeRecord = child.envelope as unknown as Record<string, unknown>;
  const profile = envelopeRecord.correctnessProfile as unknown as
    | Record<string, unknown>
    | undefined;
  const identity = read.record as unknown as RecordIdentity;
  if (
    identity.caseId !== child.envelope.caseId ||
    identity.materializationFingerprint !== envelopeRecord.materializationFingerprint ||
    identity.planFingerprint !== envelopeRecord.planFingerprint ||
    identity.resolvedProfileFingerprint !== profile?.resolvedFingerprint
  ) {
    issues.push({
      code: 'SUITE_MEMBER_IDENTITY_MISMATCH',
      detail: `Suite member ${child.order} record identities do not agree with its own envelope.`,
    });
    return;
  }

  const declared = Array.isArray(profile?.requiredChecks)
    ? (profile.requiredChecks as readonly { checkId?: unknown }[]).map((entry) =>
        typeof entry.checkId === 'string' ? entry.checkId : '',
      )
    : [];
  const produced = Array.isArray(identity.requiredChecks)
    ? identity.requiredChecks.map((entry) =>
        typeof (entry as { checkId?: unknown }).checkId === 'string'
          ? (entry as { checkId: string }).checkId
          : '',
      )
    : [];
  if (
    declared.length === 0 ||
    declared.some((entry) => entry.length === 0) ||
    !sameStringArray(sortedUnique(declared), sortedUnique(produced)) ||
    new Set(produced).size !== produced.length
  ) {
    issues.push({
      code: 'SUITE_CHILD_INCOMPLETE',
      detail: `Suite member ${child.order} record required checks [${produced.join(', ')}] do not exactly equal its compiled required-check set [${declared.join(', ')}].`,
    });
  }
}

function aggregateStatus(
  children: readonly SuiteChildOutcome[],
  select: (child: SuiteChildOutcome) => Outcome | null,
): FinalSuiteAggregateStatus {
  let severity = 0;
  for (const child of children) {
    const outcome = select(child) ?? 'HARNESS_BLOCKED';
    severity = Math.max(severity, suiteSeverityOf(outcome));
  }
  return STATUS_BY_SEVERITY[severity] as FinalSuiteAggregateStatus;
}

/**
 * Aggregates executed suite children. It preserves each child's behavior and
 * final verdict exactly, derives the terminal status from the final outcomes
 * with the accepted precedence, and refuses the whole suite (no aggregate) when
 * any child is legacy, mixed, invalid, identity-mismatched, or incomplete.
 */
export function aggregateSuiteChildren(input: SuiteAggregationInput): SuiteAggregationResult {
  const issues: SuiteAggregationIssue[] = [];
  const children = Array.isArray(input.children) ? [...input.children] : [];
  if (children.length !== input.declaredCaseCount) {
    issues.push({
      code: 'SUITE_MEMBER_COUNT_MISMATCH',
      detail: `The suite declared ${input.declaredCaseCount} members but ${children.length} were executed.`,
    });
  }
  const orders = children.map((child) => child.order);
  const canonical =
    orders.every((order, index) => order === index + 1) && new Set(orders).size === orders.length;
  if (!canonical) {
    issues.push({
      code: 'SUITE_ORDER_INVALID',
      detail: `Suite members must execute once in the contiguous canonical order 1..N; received [${orders.join(', ')}].`,
    });
  }
  const caseIds = children.map((child) => child.caseId);
  const requests = children.map((child) => child.request);
  if (new Set(caseIds).size !== caseIds.length || new Set(requests).size !== requests.length) {
    issues.push({
      code: 'SUITE_ORDER_INVALID',
      detail: 'Suite members must declare distinct case ids and request paths.',
    });
  }

  for (const child of children) validateChildRecord(child, issues);
  if (issues.length > 0) return refusal(issues);

  const stoppedOnCleanup = input.stoppedOnCleanup === true;
  const interrupted = input.interrupted === true;
  const complete = children.length === input.declaredCaseCount && !stoppedOnCleanup;

  const behaviorStatus = aggregateStatus(children, (child) => child.execution.behaviorOutcome);
  let finalStatus = aggregateStatus(children, (child) => child.execution.finalOutcome);
  if (interrupted) finalStatus = 'ENVIRONMENT_FAILURE';
  else if (!complete && finalStatus === 'PASS') finalStatus = 'HARNESS_BLOCKED';

  const summaries: SuiteChildSummary[] = children.map((child) => ({
    order: child.order,
    caseId: child.caseId,
    request: child.request,
    expectedOutcome: child.expectedOutcome,
    expectedMet: child.execution.finalOutcome === child.expectedOutcome,
    behaviorOutcome: child.execution.behaviorOutcome,
    finalOutcome: child.execution.finalOutcome,
    recordPresent: child.execution.record !== null,
  }));

  return {
    ok: true,
    decision: {
      behaviorStatus,
      finalStatus,
      complete,
      pass:
        finalStatus === 'PASS' &&
        complete &&
        !interrupted &&
        children.every(
          (child) =>
            child.execution.finalOutcome === 'PASS' && child.execution.behaviorOutcome === 'PASS',
        ),
      children: Object.freeze(summaries),
    },
  };
}
