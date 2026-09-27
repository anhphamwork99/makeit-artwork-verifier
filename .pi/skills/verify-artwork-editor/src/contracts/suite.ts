import { IDENTITY_DOMAINS, domainSeparatedDigest } from '../canonical/canonicalize';
import { DIAGNOSTIC_SUITE_SCHEMA_VERSION } from './schema-versions';

/**
 * Representative Diagnostic suite declaration and aggregate result contract
 * (ADR 0019 R12–R14; design §7).
 *
 * A suite declaration is closed authoring data: it names one canonical order of
 * stable request copies under `cases/diagnostic/requests/` and asserts the
 * expected representative outcome. It never references `tests/**`, a volatile
 * absolute path, or a per-child allocation override. The suite coordinator owns
 * no server, port, browser, or child resource — every declared case remains one
 * normal independently allocated Diagnostic execution.
 */

/** Closed suite identity vocabulary. A caller cannot widen it by passing a string. */
export const DIAGNOSTIC_SUITE_IDS = ['representative'] as const;
export type DiagnosticSuiteId = (typeof DIAGNOSTIC_SUITE_IDS)[number];

export const REPRESENTATIVE_SUITE_ID: DiagnosticSuiteId = 'representative';

/**
 * The representative suite declares exactly eight members in canonical order
 * (ADR 0019 R12). The count is a contract, not an authoring convenience: a
 * seven- or nine-child declaration is `DIAGNOSTIC_SUITE_INCOMPLETE` and fails
 * closed before any child launches.
 */
export const REPRESENTATIVE_SUITE_CASE_COUNT = 8;

/** Stable request copies live only under this skill-relative prefix. */
export const DIAGNOSTIC_SUITE_REQUEST_PREFIX = 'cases/diagnostic/requests/';

export function isDiagnosticSuiteId(value: unknown): value is DiagnosticSuiteId {
  return (DIAGNOSTIC_SUITE_IDS as readonly unknown[]).includes(value);
}

export interface DiagnosticSuiteCaseV1 {
  /** 1-based canonical position; the declared order is the execution order. */
  order: number;
  /** Planner-derived semantic case identity (`deriveCaseId`), asserted at validation. */
  caseId: string;
  /** Canonical skill-relative request path under `cases/diagnostic/requests/`. */
  request: string;
  /** The representative assertion; a non-`PASS` expectation is rejected pre-launch. */
  expectedOutcome: 'PASS';
}

export interface DiagnosticSuiteV1 {
  schemaVersion: typeof DIAGNOSTIC_SUITE_SCHEMA_VERSION;
  suiteId: DiagnosticSuiteId;
  version: number;
  profile: 'diagnostic';
  execution: 'sequential-independent-runs';
  cases: readonly DiagnosticSuiteCaseV1[];
}

export type DiagnosticSuiteValidationCode =
  | 'DIAGNOSTIC_SUITE_UNKNOWN'
  | 'DIAGNOSTIC_SUITE_INVALID'
  | 'DIAGNOSTIC_SUITE_INCOMPLETE';

export class DiagnosticSuiteValidationError extends Error {
  readonly code: DiagnosticSuiteValidationCode;

  constructor(code: DiagnosticSuiteValidationCode, message: string) {
    super(message);
    this.name = 'DiagnosticSuiteValidationError';
    this.code = code;
  }
}

const SAFE_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REQUEST_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

function fail(code: DiagnosticSuiteValidationCode, message: string): never {
  throw new DiagnosticSuiteValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical skill-relative request path validation. Absolute paths, drive/UNC
 * forms, percent-encoded separators, backslashes, a `..` segment, an empty
 * segment, or a path outside the stable request root are rejected so a suite can
 * never traverse into `tests/**` or outside the toolkit.
 */
export function diagnosticSuiteRequestProblem(request: unknown): string | null {
  if (typeof request !== 'string' || request.length === 0) return 'must be a non-empty string';
  if (request !== request.trim()) return 'must not carry surrounding whitespace';
  if (request.startsWith('/') || request.startsWith('\\')) return 'must be skill-relative';
  if (/^[A-Za-z]:/.test(request)) return 'must not be a drive-letter path';
  if (request.includes('\\')) return 'must use forward slashes';
  if (request.includes('%')) return 'must not be percent-encoded';
  if (request.includes('\0')) return 'must not contain NUL';
  if (!request.startsWith(DIAGNOSTIC_SUITE_REQUEST_PREFIX)) {
    return `must start with "${DIAGNOSTIC_SUITE_REQUEST_PREFIX}"`;
  }
  const rest = request.slice(DIAGNOSTIC_SUITE_REQUEST_PREFIX.length);
  if (rest.includes('/')) return 'must name exactly one file in the stable request root';
  if (rest === '.' || rest === '..') return 'must not be a directory traversal';
  if (!SAFE_REQUEST_FILE.test(rest)) return 'must be a safe `<name>.json` file name';
  return null;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('DIAGNOSTIC_SUITE_INVALID', `${label} must be a positive integer`);
  }
  return value;
}

function parseCase(value: unknown, index: number): DiagnosticSuiteCaseV1 {
  const label = `cases[${index}]`;
  if (!isRecord(value)) fail('DIAGNOSTIC_SUITE_INVALID', `${label} must be an object`);
  const order = requirePositiveInteger(value.order, `${label}.order`);
  if (typeof value.caseId !== 'string' || !SAFE_CASE_ID.test(value.caseId)) {
    fail('DIAGNOSTIC_SUITE_INVALID', `${label}.caseId must be a safe non-empty identity`);
  }
  const requestProblem = diagnosticSuiteRequestProblem(value.request);
  if (requestProblem !== null) {
    fail('DIAGNOSTIC_SUITE_INVALID', `${label}.request ${requestProblem}`);
  }
  if (value.expectedOutcome !== 'PASS') {
    fail(
      'DIAGNOSTIC_SUITE_INVALID',
      `${label}.expectedOutcome must be the representative assertion "PASS"`,
    );
  }
  return {
    order,
    caseId: value.caseId,
    request: value.request as string,
    expectedOutcome: 'PASS',
  };
}

/**
 * Parses and validates one closed suite declaration for a requested suite id.
 *
 * The parser is pure: it never reads a file, resolves a request, plans a case,
 * or launches anything. Every structural violation, duplicate order/request,
 * non-canonical order, wrong profile/execution, or non-`PASS` expectation fails
 * closed here, before the coordinator can start child 1.
 */
export function parseDiagnosticSuite(raw: unknown, suiteId: string): DiagnosticSuiteV1 {
  if (!isDiagnosticSuiteId(suiteId)) {
    fail('DIAGNOSTIC_SUITE_UNKNOWN', `Unknown Diagnostic suite "${suiteId}".`);
  }
  if (!isRecord(raw)) {
    fail('DIAGNOSTIC_SUITE_INVALID', `Suite "${suiteId}" must be a JSON object.`);
  }
  if (raw.schemaVersion !== DIAGNOSTIC_SUITE_SCHEMA_VERSION) {
    fail(
      'DIAGNOSTIC_SUITE_INVALID',
      `Suite "${suiteId}" declares unsupported schema version ${String(raw.schemaVersion)}; expected ${DIAGNOSTIC_SUITE_SCHEMA_VERSION}.`,
    );
  }
  if (raw.suiteId !== suiteId) {
    fail(
      'DIAGNOSTIC_SUITE_INVALID',
      `Suite declaration identity "${String(raw.suiteId)}" does not match requested suite "${suiteId}".`,
    );
  }
  const version = requirePositiveInteger(raw.version, 'version');
  if (raw.profile !== 'diagnostic') {
    fail('DIAGNOSTIC_SUITE_INVALID', 'profile must be "diagnostic"');
  }
  if (raw.execution !== 'sequential-independent-runs') {
    fail('DIAGNOSTIC_SUITE_INVALID', 'execution must be "sequential-independent-runs"');
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    fail('DIAGNOSTIC_SUITE_INCOMPLETE', 'cases must declare at least one member');
  }
  const cases = raw.cases.map(parseCase);

  const orders = cases.map((entry) => entry.order);
  if (new Set(orders).size !== orders.length) {
    fail('DIAGNOSTIC_SUITE_INVALID', 'cases declare a duplicate order');
  }
  const sorted = [...orders].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index] !== index + 1) {
      fail(
        'DIAGNOSTIC_SUITE_INVALID',
        'cases must declare the contiguous canonical order 1..N with no gaps',
      );
    }
  }
  if (cases.some((entry, index) => entry.order !== index + 1)) {
    fail('DIAGNOSTIC_SUITE_INVALID', 'cases must be authored in canonical order');
  }

  const requests = cases.map((entry) => entry.request);
  if (new Set(requests).size !== requests.length) {
    fail('DIAGNOSTIC_SUITE_INVALID', 'cases declare a duplicate request');
  }
  const caseIds = cases.map((entry) => entry.caseId);
  if (new Set(caseIds).size !== caseIds.length) {
    fail('DIAGNOSTIC_SUITE_INVALID', 'cases declare a duplicate caseId');
  }

  if (suiteId === REPRESENTATIVE_SUITE_ID && cases.length !== REPRESENTATIVE_SUITE_CASE_COUNT) {
    fail(
      'DIAGNOSTIC_SUITE_INCOMPLETE',
      `Suite "${suiteId}" must declare exactly ${REPRESENTATIVE_SUITE_CASE_COUNT} representative members; received ${cases.length}.`,
    );
  }

  return {
    schemaVersion: DIAGNOSTIC_SUITE_SCHEMA_VERSION,
    suiteId,
    version,
    profile: 'diagnostic',
    execution: 'sequential-independent-runs',
    cases,
  };
}

/**
 * Fingerprint of the complete closed suite declaration. Member order is
 * meaningful (it is the execution order) and therefore included verbatim.
 */
export function deriveDiagnosticSuiteFingerprint(suite: DiagnosticSuiteV1): string {
  return domainSeparatedDigest(IDENTITY_DOMAINS.diagnosticSuite, DIAGNOSTIC_SUITE_SCHEMA_VERSION, {
    suiteId: suite.suiteId,
    version: suite.version,
    profile: suite.profile,
    execution: suite.execution,
    cases: suite.cases.map((entry) => ({
      order: entry.order,
      caseId: entry.caseId,
      request: entry.request,
      expectedOutcome: entry.expectedOutcome,
    })),
  });
}

// ── Current suite authority ──────────────────────────────────────────────────
//
// E3-S2 removes the schema-1 aggregate suite-record authority that used to live
// here (`SUITE_AGGREGATE_STATUSES`, `suiteSeverityOf`, `DiagnosticSuiteChildV1`,
// `aggregateDiagnosticSuite`, `PublicDiagnosticSuiteRecordV1`,
// `buildPublicDiagnosticSuiteRecordV1`). The current suite aggregate is the
// v4-bound `FinalSuiteRecordV2` (schema version 2, label `suite-v2`) in
// `contracts/final-suite-record.ts`; it aggregates only accepted current-v4
// children plus explicit no-record refusals and never converts a historical v1
// child or aggregate into current meaning. This module keeps only the closed
// declaration authoring contract, its fingerprint, and the suite-lineage
// projection retained below.

/**
 * Closed suite-lineage projection carried by a schema-v3 child run record.
 *
 * A representative-suite child run must be independently attributable to the
 * suite execution that produced it. The aggregate suite record alone is not
 * sufficient: a child record that is copied out of the aggregation directory
 * would otherwise be indistinguishable from a standalone `--case` run. The
 * lineage is populated *before* the child record is written and is never
 * appended to or rewritten afterwards.
 *
 * `executionId` is the aggregate suite execution id (the same value recorded as
 * `suiteExecutionId` on the suite record), so `suiteId`/`suiteVersion`/
 * `executionId`/`order` together bind the child to exactly one suite member.
 */
export interface PublicSuiteLineageV1 {
  suiteId: DiagnosticSuiteId;
  suiteVersion: number;
  executionId: string;
  order: number;
}

/** Closed key vocabulary of the suite-lineage projection. */
export const SUITE_LINEAGE_KEYS = ['suiteId', 'suiteVersion', 'executionId', 'order'] as const;

/** Single safe path segment; mirrors `isSafeRunId` without importing runtime. */
const SAFE_SUITE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validates the closed suite-lineage projection. Any unknown key, missing key,
 * unknown suite id, non-positive version/order, or unsafe execution id is
 * reported so a partial or hand-written lineage can never be written as
 * apparently valid evidence. It is called by the run-record writer before any
 * byte reaches disk.
 */
export function suiteLineageViolations(value: unknown): string[] {
  if (!isRecord(value)) return ['not-object'];
  const violations: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(SUITE_LINEAGE_KEYS as readonly string[]).includes(key)) {
      violations.push(`unknown-key:${key}`);
    }
  }
  for (const key of SUITE_LINEAGE_KEYS) {
    if (!Object.hasOwn(value, key)) violations.push(`missing-key:${key}`);
  }
  if (!isDiagnosticSuiteId(value.suiteId)) violations.push('suiteId:not-closed');
  if (!Number.isInteger(value.suiteVersion) || (value.suiteVersion as number) <= 0) {
    violations.push('suiteVersion:not-positive-integer');
  }
  if (
    typeof value.executionId !== 'string' ||
    !SAFE_SUITE_EXECUTION_ID.test(value.executionId) ||
    value.executionId === '.' ||
    value.executionId === '..'
  ) {
    violations.push('executionId:not-safe');
  }
  if (!Number.isInteger(value.order) || (value.order as number) <= 0) {
    violations.push('order:not-positive-integer');
  }
  return violations;
}
