import {
  CURRENT_RESULT_LABEL,
  LEGACY_RESULT_LABELS,
  classifyLegacyCheckResult,
  discriminateRunRecordVersion,
  type LegacyCheckResultClassification,
} from './final-result-dto';
import {
  FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
  type FinalCommandCheckRecordV4,
  type FinalCurrentChildRecordV4,
  type FinalRecordIssue,
  isFinalCommandRecordShape,
  validateFinalChildRecordV4,
  validateFinalCommandRecordV4,
} from './final-record-v4';
import { isPlainRecord } from './result-agreement';

/**
 * Current strict current/legacy run-record reader (ADR 0025 §7;
 * ADR 0032 §E3-S2).
 *
 * The reader discriminates exactly one branch without coercing:
 *
 * - a strict current v4 child record (or v4 command-context record) is accepted
 *   only when its closed DTO validates;
 * - a historical v1/v2/v3 record is exposed through an explicit read-only,
 *   non-converting legacy branch that preserves the recorded `passed` boolean
 *   exactly and reports it as ambiguous;
 * - a mixed boolean/status record or an unknown schema is rejected.
 *
 * This is the sole current run-record reader: the writer, classifier, CLI, and
 * runtime reach the strict v4 branch through it, while v1/v2/v3 remain
 * non-converting legacy.
 */

/** The stable reader label for a strict current v4 child record. */
export const FINAL_CURRENT_RECORD_READER_LABEL = CURRENT_RESULT_LABEL;
export const FINAL_COMMAND_RECORD_READER_LABEL = 'command-v4';
export const FINAL_MIXED_RECORD_READER_LABEL = 'mixed';
export const FINAL_UNKNOWN_RECORD_READER_LABEL = 'unknown';
export const FINAL_INVALID_RECORD_READER_LABEL = 'invalid';

/** Non-converting read-only view of a historical v1/v2/v3 record. */
export interface FinalLegacyRecordView {
  kind: 'legacy-v1' | 'legacy-v2' | 'legacy-v3';
  label: string;
  schemaVersion: number;
  legacy: true;
  current: false;
  /** Historical boolean records are always ambiguous under three-state semantics. */
  ambiguous: true;
  record: Readonly<Record<string, unknown>>;
  /** One classification per historical check; a boolean is preserved exactly. */
  checks: readonly LegacyCheckResultClassification[];
  issues: readonly FinalRecordIssue[];
}

export interface FinalCurrentRecordView {
  kind: 'current-v4';
  label: typeof FINAL_CURRENT_RECORD_READER_LABEL;
  schemaVersion: typeof FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION;
  legacy: false;
  current: true;
  ambiguous: false;
  record: FinalCurrentChildRecordV4;
  issues: readonly FinalRecordIssue[];
}

export interface FinalCommandRecordView {
  kind: 'command-v4';
  label: typeof FINAL_COMMAND_RECORD_READER_LABEL;
  schemaVersion: typeof FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION;
  legacy: false;
  current: true;
  ambiguous: false;
  record: FinalCommandCheckRecordV4;
  issues: readonly FinalRecordIssue[];
}

export interface FinalRejectedRecordView {
  kind: 'mixed' | 'unknown' | 'invalid';
  label: string;
  schemaVersion: number | null;
  legacy: false;
  current: false;
  ambiguous: false;
  record: null;
  issues: readonly FinalRecordIssue[];
}

export type FinalRecordReadResult =
  | FinalCurrentRecordView
  | FinalCommandRecordView
  | FinalLegacyRecordView
  | FinalRejectedRecordView;

function collectChecks(value: unknown, acc: Record<string, unknown>[], depth = 0): void {
  if (depth > 12 || acc.length > 512) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectChecks(entry, acc, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) return;
  if (typeof value.checkId === 'string') acc.push(value);
  for (const entry of Object.values(value)) collectChecks(entry, acc, depth + 1);
}

function toFinalIssues(
  issues: readonly { code: string; detail: string; checkId: string | null }[],
): FinalRecordIssue[] {
  return issues.map((issue) => ({
    code: issue.code as FinalRecordIssue['code'],
    detail: issue.detail,
    checkId: issue.checkId,
  }));
}

function schemaVersionOf(value: Record<string, unknown>): number | null {
  return typeof value.schemaVersion === 'number' ? value.schemaVersion : null;
}

/**
 * Reads an already-parsed run record into exactly one discriminated branch. It
 * never converts a legacy record, never reinterprets a historical
 * `passed:false`, and never accepts a mixed or unknown record.
 */
export function readFinalRecord(value: unknown): FinalRecordReadResult {
  if (!isPlainRecord(value)) {
    return {
      kind: 'invalid',
      label: FINAL_INVALID_RECORD_READER_LABEL,
      schemaVersion: null,
      legacy: false,
      current: false,
      ambiguous: false,
      record: null,
      issues: [
        {
          code: 'FINAL_RECORD_NOT_OBJECT',
          detail: 'A run record must be a plain object.',
          checkId: null,
        },
      ],
    };
  }
  const discrimination = discriminateRunRecordVersion(value);
  const schemaVersion = schemaVersionOf(value);

  if (discrimination.kind === 'mixed') {
    return {
      kind: 'mixed',
      label: FINAL_MIXED_RECORD_READER_LABEL,
      schemaVersion,
      legacy: false,
      current: false,
      ambiguous: false,
      record: null,
      issues: toFinalIssues(discrimination.issues),
    };
  }
  if (discrimination.kind === 'unknown' || discrimination.kind === 'invalid') {
    return {
      kind: 'unknown',
      label: FINAL_UNKNOWN_RECORD_READER_LABEL,
      schemaVersion,
      legacy: false,
      current: false,
      ambiguous: false,
      record: null,
      issues: toFinalIssues(discrimination.issues),
    };
  }

  if (discrimination.kind.startsWith('legacy-')) {
    const kind = discrimination.kind as 'legacy-v1' | 'legacy-v2' | 'legacy-v3';
    const version = kind === 'legacy-v1' ? 1 : kind === 'legacy-v2' ? 2 : 3;
    const checkRecords: Record<string, unknown>[] = [];
    collectChecks(value, checkRecords);
    const checks = checkRecords.map((check) => classifyLegacyCheckResult(check));
    const issues = checks.flatMap((classification) => toFinalIssues(classification.issues));
    issues.push({
      code: 'RESULT_LEGACY_BOOLEAN_AMBIGUOUS',
      detail: `Historical schema v${version} is read-only and ambiguous; it is never converted to PASS, FAIL, or UNUSABLE and never earns current credit.`,
      checkId: null,
    });
    return {
      kind,
      label: LEGACY_RESULT_LABELS[version] ?? `legacy-v${version}`,
      schemaVersion: version,
      legacy: true,
      current: false,
      ambiguous: true,
      record: value,
      checks,
      issues,
    };
  }

  // Remaining branch is the strict current v4 DTO. Command-context records carry
  // a closed command authority and no fabricated resolved profile.
  if (isFinalCommandRecordShape(value)) {
    const validation = validateFinalCommandRecordV4(value);
    if (!validation.ok) {
      return {
        kind: 'invalid',
        label: FINAL_INVALID_RECORD_READER_LABEL,
        schemaVersion,
        legacy: false,
        current: false,
        ambiguous: false,
        record: null,
        issues: validation.issues,
      };
    }
    return {
      kind: 'command-v4',
      label: FINAL_COMMAND_RECORD_READER_LABEL,
      schemaVersion: FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
      legacy: false,
      current: true,
      ambiguous: false,
      record: value as unknown as FinalCommandCheckRecordV4,
      issues: [],
    };
  }

  const validation = validateFinalChildRecordV4(value);
  if (!validation.ok) {
    return {
      kind: 'invalid',
      label: FINAL_INVALID_RECORD_READER_LABEL,
      schemaVersion,
      legacy: false,
      current: false,
      ambiguous: false,
      record: null,
      issues: validation.issues,
    };
  }
  return {
    kind: 'current-v4',
    label: FINAL_CURRENT_RECORD_READER_LABEL,
    schemaVersion: FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
    legacy: false,
    current: true,
    ambiguous: false,
    record: value as unknown as FinalCurrentChildRecordV4,
    issues: [],
  };
}

/** True only for an accepted strict current v4 child record. */
export function isCurrentFinalRecord(
  result: FinalRecordReadResult,
): result is FinalCurrentRecordView {
  return result.kind === 'current-v4';
}

/** True only for an accepted strict current v4 command-context record. */
export function isCurrentCommandRecord(
  result: FinalRecordReadResult,
): result is FinalCommandRecordView {
  return result.kind === 'command-v4';
}

/** True only for a non-converting historical legacy view. */
export function isLegacyFinalRecord(
  result: FinalRecordReadResult,
): result is FinalLegacyRecordView {
  return result.legacy === true;
}

/** Throws for any record that is not an accepted strict current v4 child record. */
export function readCurrentFinalRecordOrThrow(value: unknown): FinalCurrentChildRecordV4 {
  const result = readFinalRecord(value);
  if (result.kind !== 'current-v4') {
    throw new Error(
      `A strict current v4 record is required; the value classified as "${result.label}" with ${result.issues
        .map((issue) => issue.code)
        .join(', ')}.`,
    );
  }
  return result.record;
}
