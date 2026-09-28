import type { CheckResultStatus } from './correctness';
import { isCheckResultStatus, isFullCanonicalFingerprint } from './correctness';
import {
  type ResultContractIssue,
  type ResultContractValidation,
  isPlainRecord,
  resultIssue,
  validateCheckResultShape,
} from './result-agreement';

/**
 * Command-context status authority for Doctor and production-absence (P7-B
 * B1-A, ADR 0025 §6, ADR 0028 §2).
 *
 * Doctor and production-absence share the three-state status vocabulary but do
 * not consume a compiled `ResolvedCorrectnessProfile` and must never fabricate
 * one. They carry their own versioned command authority instead, and a check
 * belongs to exactly one of the two contexts. This module is inactive during
 * B1-A.
 */

export const COMMAND_CHECK_CONTEXTS = ['doctor', 'production-absence'] as const;
export type CommandCheckContext = (typeof COMMAND_CHECK_CONTEXTS)[number];

export function isCommandCheckContext(value: unknown): value is CommandCheckContext {
  return typeof value === 'string' && (COMMAND_CHECK_CONTEXTS as readonly string[]).includes(value);
}

/** The versioned command-specific authority that replaces a compiled profile. */
export interface CommandStatusAuthority {
  schemaVersion: number;
  command: CommandCheckContext;
  commandAuthorityId: string;
  commandAuthorityFingerprint: string;
}

/**
 * One command-context check result. It shares the closed status vocabulary, but
 * carries command authority and no Action Cycle/profile identity.
 */
export interface CommandCheckResult {
  schemaVersion: number;
  checkId: string;
  status: CheckResultStatus;
  expected: Readonly<Record<string, unknown>>;
  actual: Readonly<Record<string, unknown>>;
  evidenceIds: readonly string[];
  commandAuthority: CommandStatusAuthority;
}

const PROFILE_IDENTITY_KEYS = [
  'actionCycleRef',
  'consumedComponentFingerprints',
  'resolvedProfile',
  'resolvedProfileFingerprint',
] as const;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/** Validates one command-context check result. */
export function validateCommandCheck(value: unknown): ResultContractValidation {
  const issues: ResultContractIssue[] = [];
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: [resultIssue('RESULT_RECORD_NOT_OBJECT', 'A command check must be a plain object.')],
    };
  }
  const checkId = typeof value.checkId === 'string' ? value.checkId : null;
  const label = `Command check "${String(value.checkId)}"`;

  if (!hasOwn(value, 'status')) {
    issues.push(resultIssue('RESULT_CHECK_STATUS_MISSING', `${label} has no status.`, checkId));
  } else if (!isCheckResultStatus(value.status)) {
    issues.push(
      resultIssue(
        'RESULT_CHECK_STATUS_UNKNOWN',
        `${label} has unknown status "${String(value.status)}".`,
        checkId,
      ),
    );
  }
  if (!isPlainRecord(value.expected)) {
    issues.push(
      resultIssue('RESULT_EXPECTED_INVALID', `${label} expected is not a plain object.`, checkId),
    );
  }
  if (!isPlainRecord(value.actual)) {
    issues.push(
      resultIssue('RESULT_ACTUAL_INVALID', `${label} actual is not a plain object.`, checkId),
    );
  }
  if (
    !Array.isArray(value.evidenceIds) ||
    !value.evidenceIds.every((id) => typeof id === 'string')
  ) {
    issues.push(
      resultIssue(
        'RESULT_EVIDENCE_UNDECLARED',
        `${label} evidenceIds is not a string array.`,
        checkId,
      ),
    );
  }

  // A command check must not fabricate compiled-profile identity.
  for (const key of PROFILE_IDENTITY_KEYS) {
    if (hasOwn(value, key)) {
      issues.push(
        resultIssue(
          'RESULT_COMMAND_CONTEXT_FORBIDDEN',
          `${label} carries profile-identity field "${key}"; command checks must not fabricate a resolved profile.`,
          checkId,
        ),
      );
    }
  }
  if (hasOwn(value, 'passed')) {
    issues.push(
      resultIssue(
        'RESULT_BOOLEAN_PASSED_PRESENT',
        `${label} carries a legacy boolean "passed".`,
        checkId,
      ),
    );
  }
  if (hasOwn(value, 'harnessInvalid')) {
    issues.push(
      resultIssue(
        'RESULT_HARNESS_INVALID_PRESENT',
        `${label} carries the removed "harnessInvalid" side channel.`,
        checkId,
      ),
    );
  }

  const authority = value.commandAuthority;
  if (!isPlainRecord(authority)) {
    issues.push(
      resultIssue(
        'RESULT_COMMAND_AUTHORITY_INVALID',
        `${label} has no command authority.`,
        checkId,
      ),
    );
  } else {
    if (!isCommandCheckContext(authority.command)) {
      issues.push(
        resultIssue(
          'RESULT_COMMAND_AUTHORITY_INVALID',
          `${label} command context "${String(authority.command)}" is unknown.`,
          checkId,
        ),
      );
    }
    if (typeof authority.schemaVersion !== 'number') {
      issues.push(
        resultIssue(
          'RESULT_COMMAND_AUTHORITY_INVALID',
          `${label} command authority has no numeric schemaVersion.`,
          checkId,
        ),
      );
    }
    if (
      typeof authority.commandAuthorityId !== 'string' ||
      authority.commandAuthorityId.length === 0
    ) {
      issues.push(
        resultIssue(
          'RESULT_COMMAND_AUTHORITY_INVALID',
          `${label} command authority has no id.`,
          checkId,
        ),
      );
    }
    if (!isFullCanonicalFingerprint(authority.commandAuthorityFingerprint)) {
      issues.push(
        resultIssue(
          'RESULT_COMMAND_AUTHORITY_INVALID',
          `${label} command authority fingerprint is not a full canonical 64-hex identity.`,
          checkId,
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Validates that one check belongs to exactly one context. A Diagnostic check
 * must carry the completed final check shape and no command authority; a
 * command check must carry command authority and no compiled-profile identity;
 * a check that declares both or neither is rejected.
 */
export function validateCheckContextSeparation(value: unknown): ResultContractValidation {
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: [resultIssue('RESULT_RECORD_NOT_OBJECT', 'A check must be a plain object.')],
    };
  }
  const hasCommandAuthority = hasOwn(value, 'commandAuthority');
  const hasProfileIdentity = PROFILE_IDENTITY_KEYS.some((key) => hasOwn(value, key));

  if (hasCommandAuthority && hasProfileIdentity) {
    return {
      ok: false,
      issues: [
        resultIssue(
          'RESULT_COMMAND_CONTEXT_FORBIDDEN',
          'A check cannot carry both command authority and compiled-profile identity.',
          typeof value.checkId === 'string' ? value.checkId : null,
        ),
      ],
    };
  }
  if (hasCommandAuthority) return validateCommandCheck(value);
  if (hasProfileIdentity) {
    const issues: ResultContractIssue[] = [];
    validateCheckResultShape(value, issues);
    return { ok: issues.length === 0, issues };
  }
  return {
    ok: false,
    issues: [
      resultIssue(
        'RESULT_COMMAND_CONTEXT_REQUIRED',
        'A check must declare exactly one context: command authority or compiled-profile identity.',
        typeof value.checkId === 'string' ? value.checkId : null,
      ),
    ],
  };
}
