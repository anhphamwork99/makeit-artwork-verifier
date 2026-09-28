import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessComponentFingerprints,
} from './correctness';
import { isFullCanonicalFingerprint } from './correctness';
import {
  type CorrectnessProfileIdentityView,
  type ResultContractIssue,
  type ResultContractValidation,
  isPlainRecord,
  resultIssue,
  validateCheckResultShape,
  validateResultIdentityAgreement,
} from './result-agreement';

/**
 * Strict final current result DTO and legacy discrimination (P7-B B1-A,
 * ADR 0025 §7, ADR 0028 §2/§3).
 *
 * This module is entirely inactive during B1-A. The active writer still emits
 * schema v3 boolean records; nothing here is installed on the Diagnostic CLI,
 * the classifier, or any writer. It defines the strict current v4 discriminants
 * and validators so the atomic B2 cutover can install one complete final shape.
 */

/**
 * The final current run-record schema version (ADR 0025 §7). The active
 * `DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION` remains 3 until the atomic cutover, so
 * this constant is deliberately local to the inactive kernel.
 */
export const FINAL_CURRENT_RESULT_SCHEMA_VERSION = 4;
export const CURRENT_RESULT_LABEL = 'current-v4';

export const LEGACY_RESULT_SCHEMA_VERSIONS = [1, 2, 3] as const;
export const LEGACY_RESULT_LABELS: Readonly<Record<number, string>> = {
  1: 'legacy-v1',
  2: 'legacy-v2',
  3: 'legacy-v3',
};

export const RUN_RECORD_VERSION_KINDS = [
  'current-v4',
  'invalid',
  'legacy-v1',
  'legacy-v2',
  'legacy-v3',
  'mixed',
  'unknown',
] as const;
export type RunRecordVersionKind = (typeof RUN_RECORD_VERSION_KINDS)[number];

/**
 * The strict final current result shape (ADR 0025 §7). A current v4 record
 * carries explicit three-state checks, the resolved-profile identity, all
 * component fingerprints, and the Action Cycle identities; it contains no
 * boolean `passed`, no `harnessInvalid`, and no `id@version` substitute.
 */
export interface FinalCurrentResultRecord {
  schemaVersion: 4;
  resolvedProfileFingerprint: string;
  componentFingerprints: CorrectnessComponentFingerprints;
  actionCycles: readonly ActionCycleCorrectnessIdentity[];
  requiredChecks: readonly CorrectnessCheckResult[];
}

export interface RunRecordVersionDiscrimination {
  kind: RunRecordVersionKind;
  schemaVersion: number | null;
  legacy: boolean;
  current: boolean;
  /** A legacy record exposes historical `passed:false`, which stays ambiguous. */
  ambiguousLegacy: boolean;
  issues: readonly ResultContractIssue[];
}

interface CheckShapePresence {
  checkId: string;
  passedBoolean: boolean;
  statusString: boolean;
}

function collectCheckShapes(value: unknown, acc: CheckShapePresence[], depth: number): void {
  if (depth > 12 || acc.length > 512) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectCheckShapes(entry, acc, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) return;
  if (typeof value.checkId === 'string') {
    acc.push({
      checkId: value.checkId,
      passedBoolean: typeof value.passed === 'boolean',
      statusString: typeof value.status === 'string',
    });
  }
  for (const entry of Object.values(value)) collectCheckShapes(entry, acc, depth + 1);
}

function schemaVersionOf(record: Record<string, unknown>): number | null {
  return typeof record.schemaVersion === 'number' ? record.schemaVersion : null;
}

/**
 * Discriminates an already-parsed run record into exactly one version branch
 * without coercing it. Unknown versions fail closed, and a record that mixes
 * legacy boolean checks with status checks is rejected as `mixed` rather than
 * being partially interpreted in either era.
 */
export function discriminateRunRecordVersion(value: unknown): RunRecordVersionDiscrimination {
  if (!isPlainRecord(value)) {
    return {
      kind: 'invalid',
      schemaVersion: null,
      legacy: false,
      current: false,
      ambiguousLegacy: false,
      issues: [resultIssue('RESULT_RECORD_NOT_OBJECT', 'A run record must be a plain object.')],
    };
  }
  const schemaVersion = schemaVersionOf(value);
  if (schemaVersion === null) {
    return {
      kind: 'unknown',
      schemaVersion: null,
      legacy: false,
      current: false,
      ambiguousLegacy: false,
      issues: [
        resultIssue(
          'RESULT_SCHEMA_VERSION_UNSUPPORTED',
          'A run record has no numeric schemaVersion; refusing to coerce it.',
        ),
      ],
    };
  }

  const shapes: CheckShapePresence[] = [];
  collectCheckShapes(value, shapes, 0);
  const mixedShape = shapes.some((shape) => shape.passedBoolean && shape.statusString);
  const booleanOnly = shapes.some((shape) => shape.passedBoolean);
  const statusOnly = shapes.some((shape) => shape.statusString);

  if (schemaVersion === FINAL_CURRENT_RESULT_SCHEMA_VERSION) {
    const issues: ResultContractIssue[] = [];
    if (mixedShape) {
      issues.push(
        resultIssue(
          'RESULT_CHECK_SHAPE_MIXED',
          'Current schema v4 mixes boolean and status check shapes.',
        ),
      );
    } else if (booleanOnly) {
      issues.push(
        resultIssue(
          'RESULT_BOOLEAN_PASSED_PRESENT',
          'Current schema v4 carries a legacy boolean "passed".',
        ),
      );
    }
    const mixed = issues.length > 0;
    return {
      kind: mixed ? 'mixed' : 'current-v4',
      schemaVersion,
      legacy: false,
      current: !mixed,
      ambiguousLegacy: false,
      issues,
    };
  }

  if ((LEGACY_RESULT_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)) {
    const issues: ResultContractIssue[] = [];
    if (statusOnly) {
      issues.push(
        resultIssue(
          'RESULT_CHECK_SHAPE_MIXED',
          `Legacy schema v${schemaVersion} carries a final status check shape.`,
        ),
      );
    }
    const mixed = issues.length > 0;
    return {
      kind: mixed ? 'mixed' : (`legacy-v${schemaVersion}` as RunRecordVersionKind),
      schemaVersion,
      legacy: !mixed,
      current: false,
      ambiguousLegacy: !mixed,
      issues,
    };
  }

  return {
    kind: 'unknown',
    schemaVersion,
    legacy: false,
    current: false,
    ambiguousLegacy: false,
    issues: [
      resultIssue(
        'RESULT_SCHEMA_VERSION_UNSUPPORTED',
        `Unsupported run-record schema ${schemaVersion}; refusing to coerce it.`,
      ),
    ],
  };
}

export interface LegacyCheckResultClassification {
  kind: 'legacy-boolean' | 'invalid';
  checkId: string | null;
  /** Historical boolean preserved exactly; never inferred as FAIL/UNUSABLE. */
  passed: boolean | null;
  status: null;
  /** Historical boolean records are always ambiguous under three-state semantics. */
  ambiguous: true;
  issues: readonly ResultContractIssue[];
}

/**
 * Classifies one historical legacy check without converting it. A legacy
 * `passed:false` remains ambiguous and is never mapped to `FAIL` or `UNUSABLE`;
 * a record carrying both a boolean and a status is rejected as mixed.
 */
export function classifyLegacyCheckResult(value: unknown): LegacyCheckResultClassification {
  if (!isPlainRecord(value)) {
    return {
      kind: 'invalid',
      checkId: null,
      passed: null,
      status: null,
      ambiguous: true,
      issues: [resultIssue('RESULT_RECORD_NOT_OBJECT', 'A legacy check must be a plain object.')],
    };
  }
  const checkId = typeof value.checkId === 'string' ? value.checkId : null;
  const issues: ResultContractIssue[] = [];
  if (typeof value.status === 'string') {
    issues.push(
      resultIssue(
        'RESULT_CHECK_SHAPE_MIXED',
        `Legacy check "${String(value.checkId)}" carries a status shape; mixed records are rejected.`,
        checkId,
      ),
    );
  }
  if (typeof value.passed !== 'boolean') {
    issues.push(
      resultIssue(
        'RESULT_CHECK_STATUS_MISSING',
        `Legacy check "${String(value.checkId)}" has no historical boolean "passed".`,
        checkId,
      ),
    );
    return { kind: 'invalid', checkId, passed: null, status: null, ambiguous: true, issues };
  }
  issues.push(
    resultIssue(
      'RESULT_LEGACY_BOOLEAN_AMBIGUOUS',
      `Legacy check "${String(value.checkId)}" records historical passed:${String(value.passed)}; it is ambiguous and never converted to FAIL or UNUSABLE.`,
      checkId,
    ),
  );
  return {
    kind: issues.some((issue) => issue.code === 'RESULT_CHECK_SHAPE_MIXED')
      ? 'invalid'
      : 'legacy-boolean',
    checkId,
    passed: value.passed,
    status: null,
    ambiguous: true,
    issues,
  };
}

export interface FinalResultRecordValidation extends ResultContractValidation {
  schemaVersion: number | null;
  kind: RunRecordVersionKind;
}

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

/**
 * Strictly validates a parsed current v4 record. Every required identity is
 * checked for presence and full canonical 64-hex form, no legacy boolean or
 * `harnessInvalid` field may appear anywhere in the check region, and — when a
 * compiled-profile identity is supplied — every check must agree with it
 * exactly.
 */
export function validateCurrentResultRecordV4(
  value: unknown,
  identity?: CorrectnessProfileIdentityView,
): FinalResultRecordValidation {
  if (!isPlainRecord(value)) {
    return {
      schemaVersion: null,
      kind: 'invalid',
      ok: false,
      issues: [resultIssue('RESULT_RECORD_NOT_OBJECT', 'A run record must be a plain object.')],
    };
  }
  const discrimination = discriminateRunRecordVersion(value);
  const issues: ResultContractIssue[] = [...discrimination.issues];
  const schemaVersion = schemaVersionOf(value);
  if (schemaVersion !== FINAL_CURRENT_RESULT_SCHEMA_VERSION) {
    issues.push(
      resultIssue(
        'RESULT_SCHEMA_VERSION_UNSUPPORTED',
        `A current record must declare schemaVersion ${FINAL_CURRENT_RESULT_SCHEMA_VERSION}.`,
      ),
    );
  }

  if (Object.hasOwn(value, 'harnessInvalid')) {
    issues.push(
      resultIssue(
        'RESULT_HARNESS_INVALID_PRESENT',
        'A current record carries the removed top-level "harnessInvalid" side channel.',
      ),
    );
  }

  const resolvedProfileFingerprint = value.resolvedProfileFingerprint;
  if (!isFullCanonicalFingerprint(resolvedProfileFingerprint)) {
    issues.push(
      resultIssue(
        resolvedProfileFingerprint === undefined
          ? 'RESULT_FINGERPRINT_MISSING'
          : 'RESULT_FINGERPRINT_INVALID',
        'A current record must carry a full canonical resolved-profile fingerprint.',
      ),
    );
  }

  const componentFingerprints = value.componentFingerprints;
  if (!isPlainRecord(componentFingerprints)) {
    issues.push(
      resultIssue(
        'RESULT_COMPONENT_FINGERPRINTS_MISSING',
        'A current record must carry all compiled component fingerprints.',
      ),
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(componentFingerprints[field])) {
        issues.push(
          resultIssue(
            'RESULT_FINGERPRINT_INVALID',
            `Current record component fingerprint "${field}" is not a full canonical 64-hex identity.`,
          ),
        );
      }
    }
  }

  if (!Array.isArray(value.actionCycles)) {
    issues.push(
      resultIssue(
        'RESULT_ACTION_CYCLE_MISSING',
        'A current record must carry Action Cycle identities.',
      ),
    );
  }
  if (!Array.isArray(value.requiredChecks)) {
    issues.push(
      resultIssue(
        'RESULT_REQUIRED_CHECK_MISSING',
        'A current record must carry a required-check array.',
      ),
    );
  }

  if (identity !== undefined) {
    if (
      isFullCanonicalFingerprint(resolvedProfileFingerprint) &&
      resolvedProfileFingerprint !== identity.resolvedFingerprint
    ) {
      issues.push(
        resultIssue(
          'RESULT_PROFILE_IDENTITY_INVALID',
          'Current record resolved-profile fingerprint does not equal the compiled profile identity.',
        ),
      );
    }
    if (isPlainRecord(componentFingerprints)) {
      for (const field of COMPONENT_FINGERPRINT_FIELDS) {
        const recordValue = componentFingerprints[field];
        if (
          isFullCanonicalFingerprint(recordValue) &&
          recordValue !== identity.componentFingerprints[field]
        ) {
          issues.push(
            resultIssue(
              'RESULT_CONSUMED_COMPONENT_MISMATCH',
              `Current record component fingerprint "${field}" does not equal the compiled component.`,
            ),
          );
        }
      }
    }
    const agreement = validateResultIdentityAgreement(identity, {
      actionCycles: Array.isArray(value.actionCycles)
        ? (value.actionCycles as readonly ActionCycleCorrectnessIdentity[])
        : [],
      requiredChecks: Array.isArray(value.requiredChecks)
        ? (value.requiredChecks as readonly CorrectnessCheckResult[])
        : [],
    });
    issues.push(...agreement.issues);
  } else if (Array.isArray(value.requiredChecks)) {
    for (const check of value.requiredChecks) validateCheckResultShape(check, issues);
  }

  return {
    schemaVersion,
    kind: discrimination.kind,
    ok: issues.length === 0,
    issues,
  };
}
