import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessComponentFingerprints,
  ResolvedCheckContract,
  ResolvedCorrectnessProfile,
  ResolvedNormalization,
} from './correctness';
import { isCheckResultStatus, isFullCanonicalFingerprint } from './correctness';

/**
 * Final result-contract validation issues (P7-B B1-A, ADR 0028 §2/§3).
 *
 * These are structured, closed issue codes local to the inactive final result
 * kernel. They are deliberately not added to the active `DiagnosticCode`
 * vocabulary: B1-A defines an inactive pure kernel and must not change any
 * active diagnostic, classifier, writer, or record behavior. The atomic B2
 * cutover maps these issues into the active vocabulary when the kernel is
 * wired in.
 */
export const RESULT_CONTRACT_ISSUE_CODES = [
  'RESULT_RECORD_NOT_OBJECT',
  'RESULT_SCHEMA_VERSION_UNSUPPORTED',
  'RESULT_PROFILE_IDENTITY_INVALID',
  'RESULT_COMPONENT_FINGERPRINTS_MISSING',
  'RESULT_FINGERPRINT_MISSING',
  'RESULT_FINGERPRINT_INVALID',
  'RESULT_ACTION_CYCLE_MISSING',
  'RESULT_ACTION_CYCLE_DUPLICATE',
  'RESULT_ACTION_CYCLE_REF_MISSING',
  'RESULT_ACTION_CYCLE_UNRESOLVED',
  'RESULT_ACTION_CYCLE_PROFILE_MISMATCH',
  'RESULT_READINESS_FINGERPRINT_MISMATCH',
  'RESULT_CONSUMED_COMPONENT_MISMATCH',
  'RESULT_REQUIRED_CHECK_MISSING',
  'RESULT_REQUIRED_CHECK_UNKNOWN',
  'RESULT_REQUIRED_CHECK_DUPLICATE',
  'RESULT_EMPTY_REQUIRED_CHECKS',
  'RESULT_CHECK_STATUS_MISSING',
  'RESULT_CHECK_STATUS_UNKNOWN',
  'RESULT_CHECK_SHAPE_MIXED',
  'RESULT_BOOLEAN_PASSED_PRESENT',
  'RESULT_HARNESS_INVALID_PRESENT',
  'RESULT_EXPECTED_INVALID',
  'RESULT_ACTUAL_INVALID',
  'RESULT_EVIDENCE_UNDECLARED',
  'RESULT_EVIDENCE_MISSING',
  'RESULT_TOLERANCE_REF_UNDECLARED',
  'RESULT_VISUAL_REF_UNDECLARED',
  'RESULT_NORMALIZATION_REF_INVALID',
  'RESULT_COMMAND_CONTEXT_REQUIRED',
  'RESULT_COMMAND_CONTEXT_FORBIDDEN',
  'RESULT_COMMAND_AUTHORITY_INVALID',
  'RESULT_LEGACY_BOOLEAN_AMBIGUOUS',
] as const;
export type ResultContractIssueCode = (typeof RESULT_CONTRACT_ISSUE_CODES)[number];

export interface ResultContractIssue {
  code: ResultContractIssueCode;
  detail: string;
  /** The owning check when the issue is check-scoped; null otherwise. */
  checkId: string | null;
}

export function resultIssue(
  code: ResultContractIssueCode,
  detail: string,
  checkId: string | null = null,
): ResultContractIssue {
  return { code, detail, checkId };
}

export interface ResultContractValidation {
  ok: boolean;
  issues: readonly ResultContractIssue[];
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((entry, index) => entry === right[index]);
}

const CONSUMED_COMPONENT_FIELDS = [
  'requiredCheckSet',
  'oracle',
  'capture',
  'tolerances',
  'visuals',
  'normalization',
] as const;

/**
 * The compact compiled-profile identity a final result must agree with. It is a
 * projection of one `ResolvedCorrectnessProfile` carrying exactly the facts the
 * result kernel needs: the resolved identity, component fingerprints, declared
 * required checks, required-authoritative evidence, tolerance/visual ids, and
 * the normalization declaration (or its explicit non-applicable variant).
 */
export interface CorrectnessProfileIdentityView {
  resolvedFingerprint: string;
  componentFingerprints: CorrectnessComponentFingerprints;
  requiredCheckIds: readonly string[];
  requiredChecks: readonly ResolvedCheckContract[];
  requiredAuthoritativeEvidence: readonly string[];
  toleranceIds: readonly string[];
  visualIds: readonly string[];
  normalization: ResolvedNormalization;
}

export function projectCorrectnessProfileIdentity(
  profile: ResolvedCorrectnessProfile,
): CorrectnessProfileIdentityView {
  return {
    resolvedFingerprint: profile.resolvedFingerprint,
    componentFingerprints: profile.componentFingerprints,
    requiredCheckIds: profile.requiredChecks.map((check) => check.checkId),
    requiredChecks: profile.requiredChecks,
    requiredAuthoritativeEvidence: profile.requiredAuthoritativeEvidence,
    toleranceIds: profile.tolerances.map((tolerance) => tolerance.toleranceId),
    visualIds: profile.visuals.map((visual) => visual.visualId),
    normalization: profile.normalization,
  };
}

/**
 * Validates one final check result's shape without consulting a compiled
 * profile: the absent boolean/`harnessInvalid` legacy surfaces, status
 * presence/vocabulary, expected/actual interpretation, Action Cycle reference
 * presence, and the presence of full canonical consumed fingerprints.
 */
export function validateCheckResultShape(check: unknown, issues: ResultContractIssue[]): void {
  const record = isPlainRecord(check) ? check : {};
  const checkId = typeof record.checkId === 'string' ? record.checkId : null;
  const label = `Check "${String(record.checkId)}"`;

  if (hasOwn(record, 'passed')) {
    issues.push(
      resultIssue(
        'RESULT_BOOLEAN_PASSED_PRESENT',
        `${label} carries a legacy boolean "passed".`,
        checkId,
      ),
    );
  }
  if (hasOwn(record, 'harnessInvalid')) {
    issues.push(
      resultIssue(
        'RESULT_HARNESS_INVALID_PRESENT',
        `${label} carries the removed "harnessInvalid" side channel.`,
        checkId,
      ),
    );
  }
  if (!hasOwn(record, 'status')) {
    issues.push(
      resultIssue(
        'RESULT_CHECK_STATUS_MISSING',
        `${label} has no status; no default is permitted.`,
        checkId,
      ),
    );
  } else if (!isCheckResultStatus(record.status)) {
    issues.push(
      resultIssue(
        'RESULT_CHECK_STATUS_UNKNOWN',
        `${label} has unknown status "${String(record.status)}".`,
        checkId,
      ),
    );
  }
  if (!isPlainRecord(record.expected)) {
    issues.push(
      resultIssue(
        'RESULT_EXPECTED_INVALID',
        `${label} expected interpretation is not a plain object.`,
        checkId,
      ),
    );
  }
  if (!isPlainRecord(record.actual)) {
    issues.push(
      resultIssue(
        'RESULT_ACTUAL_INVALID',
        `${label} actual interpretation is not a plain object.`,
        checkId,
      ),
    );
  }
  if (typeof record.actionCycleRef !== 'string' || record.actionCycleRef.length === 0) {
    issues.push(
      resultIssue(
        'RESULT_ACTION_CYCLE_REF_MISSING',
        `${label} has no Action Cycle reference.`,
        checkId,
      ),
    );
  }
  const consumed = record.consumedComponentFingerprints;
  if (!isPlainRecord(consumed)) {
    issues.push(
      resultIssue(
        'RESULT_COMPONENT_FINGERPRINTS_MISSING',
        `${label} has no consumed component fingerprints.`,
        checkId,
      ),
    );
    return;
  }
  if (!isFullCanonicalFingerprint(consumed.resolvedProfile)) {
    issues.push(
      resultIssue(
        'RESULT_FINGERPRINT_MISSING',
        `${label} consumed resolved-profile fingerprint is missing or invalid.`,
        checkId,
      ),
    );
  }
  for (const field of CONSUMED_COMPONENT_FIELDS) {
    if (!isFullCanonicalFingerprint(consumed[field])) {
      issues.push(
        resultIssue(
          'RESULT_FINGERPRINT_MISSING',
          `${label} consumed component "${field}" is missing or invalid.`,
          checkId,
        ),
      );
    }
  }
}

interface ResultIdentityInput {
  actionCycles: readonly ActionCycleCorrectnessIdentity[];
  requiredChecks: readonly CorrectnessCheckResult[];
}

/**
 * Validates the complete agreement between one compiled-profile identity and
 * the final result checks/action cycles that claim to have consumed it.
 *
 * Every rule is fail-closed and produces a structured issue rather than
 * coercing, defaulting, or rescuing a value. This is a pure function: it reads
 * values and returns issues, and never writes a record or mutates an argument.
 */
export function validateResultIdentityAgreement(
  identity: CorrectnessProfileIdentityView,
  result: ResultIdentityInput,
): ResultContractValidation {
  const issues: ResultContractIssue[] = [];

  if (!isFullCanonicalFingerprint(identity.resolvedFingerprint)) {
    issues.push(
      resultIssue(
        'RESULT_PROFILE_IDENTITY_INVALID',
        `Resolved-profile fingerprint "${String(identity.resolvedFingerprint)}" is not a full canonical 64-hex identity.`,
      ),
    );
  }
  for (const [name, value] of Object.entries(identity.componentFingerprints)) {
    if (!isFullCanonicalFingerprint(value)) {
      issues.push(
        resultIssue(
          'RESULT_FINGERPRINT_INVALID',
          `Compiled component fingerprint "${name}" is not a full canonical 64-hex identity.`,
        ),
      );
    }
  }

  const cyclesById = new Map<string, ActionCycleCorrectnessIdentity>();
  for (const cycle of result.actionCycles) {
    if (typeof cycle.actionCycleId !== 'string' || cycle.actionCycleId.length === 0) {
      issues.push(
        resultIssue('RESULT_ACTION_CYCLE_MISSING', 'An Action Cycle identity has no id.'),
      );
      continue;
    }
    if (cyclesById.has(cycle.actionCycleId)) {
      issues.push(
        resultIssue(
          'RESULT_ACTION_CYCLE_DUPLICATE',
          `Action Cycle id "${cycle.actionCycleId}" is declared more than once.`,
        ),
      );
      continue;
    }
    cyclesById.set(cycle.actionCycleId, cycle);
    if (!isFullCanonicalFingerprint(cycle.resolvedProfileFingerprint)) {
      issues.push(
        resultIssue(
          'RESULT_FINGERPRINT_INVALID',
          `Action Cycle "${cycle.actionCycleId}" resolved-profile fingerprint is not a full canonical 64-hex identity.`,
        ),
      );
    }
    if (!isFullCanonicalFingerprint(cycle.readinessFingerprint)) {
      issues.push(
        resultIssue(
          'RESULT_FINGERPRINT_INVALID',
          `Action Cycle "${cycle.actionCycleId}" readiness fingerprint is not a full canonical 64-hex identity.`,
        ),
      );
    }
  }

  const seen = new Set<string>();
  for (const check of result.requiredChecks) {
    if (typeof check.checkId === 'string' && seen.has(check.checkId)) {
      issues.push(
        resultIssue(
          'RESULT_REQUIRED_CHECK_DUPLICATE',
          `Required check "${check.checkId}" appears more than once.`,
          check.checkId,
        ),
      );
      continue;
    }
    if (typeof check.checkId === 'string') seen.add(check.checkId);
    if (typeof check.checkId !== 'string' || !identity.requiredCheckIds.includes(check.checkId)) {
      issues.push(
        resultIssue(
          'RESULT_REQUIRED_CHECK_UNKNOWN',
          `Check "${String(check.checkId)}" is not a declared required check of the compiled profile.`,
          typeof check.checkId === 'string' ? check.checkId : null,
        ),
      );
    }
  }
  if (result.requiredChecks.length === 0 && identity.requiredCheckIds.length > 0) {
    issues.push(
      resultIssue(
        'RESULT_EMPTY_REQUIRED_CHECKS',
        'A compiled profile with declared required checks cannot produce an empty check set.',
      ),
    );
  }
  for (const requiredId of identity.requiredCheckIds) {
    if (!seen.has(requiredId)) {
      issues.push(
        resultIssue(
          'RESULT_REQUIRED_CHECK_MISSING',
          `Declared required check "${requiredId}" is absent from the result.`,
          requiredId,
        ),
      );
    }
  }

  for (const check of result.requiredChecks) {
    validateCheckResultShape(check, issues);
    const contract = identity.requiredChecks.find((entry) => entry.checkId === check.checkId);
    validateCheckAgreement(check, contract, identity, cyclesById, issues);
  }

  return { ok: issues.length === 0, issues };
}

function validateCheckAgreement(
  check: CorrectnessCheckResult,
  contract: ResolvedCheckContract | undefined,
  identity: CorrectnessProfileIdentityView,
  cyclesById: ReadonlyMap<string, ActionCycleCorrectnessIdentity>,
  issues: ResultContractIssue[],
): void {
  const checkId = typeof check.checkId === 'string' ? check.checkId : null;
  const label = `Check "${String(check.checkId)}"`;

  const actionCycleRef = check.actionCycleRef;
  if (typeof actionCycleRef === 'string' && actionCycleRef.length > 0) {
    const cycle = cyclesById.get(actionCycleRef);
    if (cycle === undefined) {
      issues.push(
        resultIssue(
          'RESULT_ACTION_CYCLE_UNRESOLVED',
          `${label} references Action Cycle "${actionCycleRef}" which does not resolve in this record.`,
          checkId,
        ),
      );
    } else {
      const consumedResolved = check.consumedComponentFingerprints?.resolvedProfile;
      if (cycle.resolvedProfileFingerprint !== consumedResolved) {
        issues.push(
          resultIssue(
            'RESULT_ACTION_CYCLE_PROFILE_MISMATCH',
            `Action Cycle "${actionCycleRef}" resolved-profile fingerprint does not equal the check's consumed resolved profile.`,
            checkId,
          ),
        );
      }
      if (cycle.readinessFingerprint !== identity.componentFingerprints.readiness) {
        issues.push(
          resultIssue(
            'RESULT_READINESS_FINGERPRINT_MISMATCH',
            `Action Cycle "${actionCycleRef}" readiness fingerprint does not equal the compiled readiness component.`,
            checkId,
          ),
        );
      }
    }
  }

  const consumed = check.consumedComponentFingerprints as unknown;
  if (!isPlainRecord(consumed)) return;

  if (isFullCanonicalFingerprint(consumed.resolvedProfile)) {
    if (consumed.resolvedProfile !== identity.resolvedFingerprint) {
      issues.push(
        resultIssue(
          'RESULT_CONSUMED_COMPONENT_MISMATCH',
          `${label} consumed resolved profile "${consumed.resolvedProfile}" does not equal the compiled "${identity.resolvedFingerprint}".`,
          checkId,
        ),
      );
    }
  }
  for (const field of CONSUMED_COMPONENT_FIELDS) {
    const value = consumed[field];
    if (!isFullCanonicalFingerprint(value)) continue;
    if (value !== identity.componentFingerprints[field]) {
      issues.push(
        resultIssue(
          'RESULT_CONSUMED_COMPONENT_MISMATCH',
          `${label} consumed component "${field}" does not equal the compiled component fingerprint.`,
          checkId,
        ),
      );
    }
  }

  if (contract === undefined) return;
  validateEvidenceAndReferences(check, contract, identity, issues);
}

function validateEvidenceAndReferences(
  check: CorrectnessCheckResult,
  contract: ResolvedCheckContract,
  identity: CorrectnessProfileIdentityView,
  issues: ResultContractIssue[],
): void {
  const checkId = typeof check.checkId === 'string' ? check.checkId : null;
  const label = `Check "${String(check.checkId)}"`;
  const evidenceIds = isReadonlyStringArray(check.evidenceIds) ? check.evidenceIds : [];
  const declared = new Set(contract.requiredEvidence);
  const globalDeclared = new Set(identity.requiredAuthoritativeEvidence);
  for (const evidenceId of evidenceIds) {
    if (!declared.has(evidenceId) || !globalDeclared.has(evidenceId)) {
      issues.push(
        resultIssue(
          'RESULT_EVIDENCE_UNDECLARED',
          `${label} consumed undeclared evidence "${evidenceId}".`,
          checkId,
        ),
      );
    }
  }
  if (check.status === 'PASS') {
    for (const requiredEvidenceId of declared) {
      if (!evidenceIds.includes(requiredEvidenceId)) {
        issues.push(
          resultIssue(
            'RESULT_EVIDENCE_MISSING',
            `Passing ${label.toLowerCase()} is missing declared required evidence "${requiredEvidenceId}".`,
            checkId,
          ),
        );
      }
    }
  }

  const toleranceRefs = isReadonlyStringArray(check.toleranceRefs) ? check.toleranceRefs : [];
  if (!sameStringSet(toleranceRefs, contract.toleranceRefs)) {
    issues.push(
      resultIssue(
        'RESULT_TOLERANCE_REF_UNDECLARED',
        `${label} tolerance references do not equal the compiled declaration.`,
        checkId,
      ),
    );
  }
  for (const toleranceRef of toleranceRefs) {
    if (!identity.toleranceIds.includes(toleranceRef)) {
      issues.push(
        resultIssue(
          'RESULT_TOLERANCE_REF_UNDECLARED',
          `${label} references unknown tolerance "${toleranceRef}".`,
          checkId,
        ),
      );
    }
  }

  const visualRefs = isReadonlyStringArray(check.visualRefs) ? check.visualRefs : [];
  if (!sameStringSet(visualRefs, contract.visualRefs)) {
    issues.push(
      resultIssue(
        'RESULT_VISUAL_REF_UNDECLARED',
        `${label} visual references do not equal the compiled declaration.`,
        checkId,
      ),
    );
  }
  for (const visualRef of visualRefs) {
    if (!identity.visualIds.includes(visualRef)) {
      issues.push(
        resultIssue(
          'RESULT_VISUAL_REF_UNDECLARED',
          `${label} references unknown visual "${visualRef}".`,
          checkId,
        ),
      );
    }
  }

  const normalization = identity.normalization;
  if (normalization.applicable) {
    if (check.normalizationRef !== contract.normalizationRef) {
      issues.push(
        resultIssue(
          'RESULT_NORMALIZATION_REF_INVALID',
          `${label} normalization reference does not equal the compiled declaration.`,
          checkId,
        ),
      );
    }
  } else if (check.normalizationRef !== null) {
    issues.push(
      resultIssue(
        'RESULT_NORMALIZATION_REF_INVALID',
        `${label} declares normalization "${String(check.normalizationRef)}" while the compiled profile is explicitly non-applicable.`,
        checkId,
      ),
    );
  } else if (contract.normalizationRef !== null) {
    issues.push(
      resultIssue(
        'RESULT_NORMALIZATION_REF_INVALID',
        `${label} compiled contract still declares normalization while the profile is non-applicable.`,
        checkId,
      ),
    );
  }
}
