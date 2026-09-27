import {
  CLAIM_STATUSES,
  PRODUCTION_CLAIM_SCHEMA_VERSION,
  type ProductionClaimAssessment,
  type ProductionClaimIssueCode,
} from '../contracts/production-claim';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,179}$/;
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const INPUT_FIELDS = [
  'schemaVersion',
  'scope',
  'coverage',
  'manifest',
  'environment',
  'run',
  'exclusions',
  'approvals',
] as const;
const SCOPE_FIELDS = ['frontendOnly', 'bindings'] as const;
const BINDING_FIELDS = [
  'subjectId',
  'capability',
  'coverageModelFingerprint',
  'correctnessPolicyFingerprint',
] as const;
const COVERAGE_FIELDS = [
  'scenarios',
  'variants',
  'partitions',
  'transitions',
  'obligations',
] as const;
const MANIFEST_FIELDS = ['manifestId', 'contentFingerprint'] as const;
const ENVIRONMENT_FIELDS = ['cells'] as const;
const CELL_FIELDS = [
  'cellId',
  'classification',
  'browser',
  'operatingSystem',
  'viewportWidth',
  'viewportHeight',
  'devicePixelRatio',
  'locale',
  'timezone',
] as const;
const RUN_FIELDS = ['runId', 'executedAtUtc'] as const;
const EXCLUSION_FIELDS = ['exclusions', 'knownGaps', 'status'] as const;
const APPROVAL_FIELDS = ['role', 'authority', 'reference', 'digest'] as const;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null ? (value as RecordValue) : undefined;
}

function closed(value: RecordValue, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function safe(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REFERENCE.test(value);
}

function hex(value: unknown): value is string {
  return typeof value === 'string' && HEX_256.test(value);
}

/** Bounded, trimmed, nonempty human-readable text (exclusions and known gaps). */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500 && value.trim().length > 0;
}

function textList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.every(text);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * A syntactically valid UTC string is not necessarily a real instant: the
 * calendar date and wall-clock time must actually exist (`2026-02-30T25:61:61Z`
 * matches the shape but denotes no moment). A non-existent instant is denied
 * rather than silently normalized.
 */
function utcInstantExists(value: string): boolean {
  const match = UTC_INSTANT.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = month === 2 && isLeapYear(Number(match[1])) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= daysInMonth;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function result(issues: readonly ProductionClaimIssueCode[]): ProductionClaimAssessment {
  const deduped = unique(issues);
  return {
    structurallyComplete: deduped.length === 0,
    issues: deduped,
    approvalAuthenticated: false,
    rendered: false,
    published: false,
    releaseCredit: false,
  };
}

function validateScope(value: unknown, issues: ProductionClaimIssueCode[]): void {
  const scope = record(value);
  if (!scope || !closed(scope, SCOPE_FIELDS) || scope.frontendOnly !== true) {
    issues.push('CLAIM_SCOPE');
    return;
  }
  const bindings = scope.bindings;
  if (!Array.isArray(bindings) || !bindings.length) {
    issues.push('CLAIM_BINDING');
    return;
  }
  const pairs = new Set<string>();
  for (const item of bindings) {
    const binding = record(item);
    if (
      !binding ||
      !closed(binding, BINDING_FIELDS) ||
      !safe(binding.subjectId) ||
      !safe(binding.capability)
    ) {
      issues.push('CLAIM_BINDING');
      continue;
    }
    if (!hex(binding.coverageModelFingerprint) || !hex(binding.correctnessPolicyFingerprint)) {
      issues.push('CLAIM_FINGERPRINT');
      continue;
    }
    const pair = `${binding.subjectId}\u0000${binding.capability}`;
    if (pairs.has(pair)) issues.push('CLAIM_BINDING_DUPLICATE');
    pairs.add(pair);
  }
}

function validateCoverage(value: unknown, issues: ProductionClaimIssueCode[]): void {
  const coverage = record(value);
  if (!coverage || !closed(coverage, COVERAGE_FIELDS)) {
    issues.push('CLAIM_COVERAGE');
    return;
  }
  let declared = 0;
  for (const field of COVERAGE_FIELDS) {
    const list = coverage[field];
    if (!Array.isArray(list) || list.some((entry) => !safe(entry))) {
      issues.push('CLAIM_COVERAGE');
      continue;
    }
    declared += list.length;
  }
  // Every dimension must be declared and at least one coverage entry must exist.
  if (declared === 0) issues.push('CLAIM_COVERAGE');
}

function validateManifest(value: unknown, issues: ProductionClaimIssueCode[]): void {
  const manifest = record(value);
  if (
    !manifest ||
    !closed(manifest, MANIFEST_FIELDS) ||
    !safe(manifest.manifestId) ||
    !hex(manifest.contentFingerprint)
  ) {
    issues.push('CLAIM_MANIFEST');
  }
}

function validateEnvironment(value: unknown, issues: ProductionClaimIssueCode[]): void {
  const environment = record(value);
  if (!environment || !closed(environment, ENVIRONMENT_FIELDS)) {
    issues.push('CLAIM_ENVIRONMENT');
    return;
  }
  const cells = environment.cells;
  if (!Array.isArray(cells) || !cells.length) {
    issues.push('CLAIM_ENVIRONMENT');
    return;
  }
  const cellIds = new Set<string>();
  for (const item of cells) {
    const cell = record(item);
    if (
      !cell ||
      !closed(cell, CELL_FIELDS) ||
      !safe(cell.cellId) ||
      // A claim is limited to required-credit cells; anything else is not claimable.
      cell.classification !== 'required-credit' ||
      !safe(cell.browser) ||
      !safe(cell.operatingSystem) ||
      !Number.isSafeInteger(cell.viewportWidth) ||
      (cell.viewportWidth as number) < 1 ||
      !Number.isSafeInteger(cell.viewportHeight) ||
      (cell.viewportHeight as number) < 1 ||
      typeof cell.devicePixelRatio !== 'number' ||
      !Number.isFinite(cell.devicePixelRatio) ||
      cell.devicePixelRatio <= 0 ||
      !safe(cell.locale) ||
      !safe(cell.timezone)
    ) {
      issues.push('CLAIM_ENVIRONMENT');
      continue;
    }
    if (cellIds.has(cell.cellId)) issues.push('CLAIM_ENVIRONMENT');
    cellIds.add(cell.cellId);
  }
}

function validateRun(value: unknown, issues: ProductionClaimIssueCode[]): void {
  const run = record(value);
  if (
    !run ||
    !closed(run, RUN_FIELDS) ||
    !safe(run.runId) ||
    typeof run.executedAtUtc !== 'string' ||
    !utcInstantExists(run.executedAtUtc)
  ) {
    issues.push('CLAIM_RUN_REFERENCE');
  }
}

function validateExclusions(value: unknown, issues: ProductionClaimIssueCode[]): void {
  const exclusions = record(value);
  if (
    !exclusions ||
    !closed(exclusions, EXCLUSION_FIELDS) ||
    !CLAIM_STATUSES.includes(exclusions.status as never) ||
    !textList(exclusions.exclusions) ||
    !textList(exclusions.knownGaps)
  ) {
    issues.push('CLAIM_EXCLUSIONS');
  }
}

function validateApprovals(value: unknown, issues: ProductionClaimIssueCode[]): void {
  if (!Array.isArray(value) || !value.length) {
    issues.push('CLAIM_APPROVAL_REFERENCE');
    return;
  }
  const roles = new Set<string>();
  for (const item of value) {
    const approval = record(item);
    if (
      !approval ||
      !closed(approval, APPROVAL_FIELDS) ||
      !safe(approval.role) ||
      !safe(approval.authority) ||
      !safe(approval.reference) ||
      !hex(approval.digest)
    ) {
      issues.push('CLAIM_APPROVAL_REFERENCE');
      continue;
    }
    // One reference per role: a duplicated role is not an internally consistent claim.
    if (roles.has(approval.role)) issues.push('CLAIM_APPROVAL_REFERENCE');
    roles.add(approval.role);
  }
}

/**
 * Structural claim-completeness predicate (production specification §13.9).
 *
 * It reports presence/shape only: a claim is structurally complete when every
 * required dimension is present and well formed. It can never authenticate a
 * human approval, adjudicate whether the referenced run actually completed the
 * cells, render a claim, publish a claim, or grant Release credit — a
 * well-formed approval reference is untrusted input and every result carries
 * `approvalAuthenticated: false`, `rendered: false`, `published: false`, and
 * `releaseCredit: false`. It never throws for invalid authoring data.
 */
export function assessProductionClaimCompleteness(input: unknown): ProductionClaimAssessment {
  const issues: ProductionClaimIssueCode[] = [];
  try {
    const envelope = record(input);
    if (!envelope || !closed(envelope, INPUT_FIELDS)) return result(['CLAIM_SHAPE']);
    if (envelope.schemaVersion !== PRODUCTION_CLAIM_SCHEMA_VERSION) issues.push('CLAIM_SCHEMA');

    validateScope(envelope.scope, issues);
    validateCoverage(envelope.coverage, issues);
    validateManifest(envelope.manifest, issues);
    validateEnvironment(envelope.environment, issues);
    validateRun(envelope.run, issues);
    validateExclusions(envelope.exclusions, issues);
    validateApprovals(envelope.approvals, issues);

    return result(issues);
  } catch {
    // Proxy/getter/cyclic input cannot escape the closed predicate.
    return result([...issues, 'CLAIM_SHAPE']);
  }
}
