import { IDENTITY_DOMAINS, domainSeparatedDigest } from '../canonical/canonicalize';
import {
  type CommandCheckContext,
  type CommandCheckResult,
  type CommandStatusAuthority,
  isCommandCheckContext,
  validateCheckContextSeparation,
} from '../contracts/command-check';
import {
  type CheckResultStatus,
  isCheckResultStatus,
  isFullCanonicalFingerprint,
} from '../contracts/correctness';
import type { Outcome } from '../contracts/discriminants';
import {
  type ResultContractIssueCode,
  type ResultContractValidation,
  isPlainRecord,
} from '../contracts/result-agreement';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../contracts/schema-versions';
import { classifyStatusOutcome } from '../runtime/result-outcome';

/**
 * P7-B B1-G versioned command-context construction (ADR 0028 §3 B1-G; ADR 0025
 * §6; ADR 0026 "Doctor and production-absence rule").
 *
 * Doctor and production-absence share the explicit `PASS | FAIL | UNUSABLE`
 * status vocabulary, but they do not consume a compiled
 * `ResolvedCorrectnessProfile` and must never fabricate one. They carry their
 * own versioned command authority instead, and the two command contexts are
 * mutually exclusive with the compiled-profile Diagnostic context.
 *
 * This module owns the *shared* command-context machinery: the closed authority
 * state and negative-disposition vocabularies, the strict versioned declaration
 * DTO, the domain-separated authority identity, the fact-to-status mapping, the
 * authority/currentness/evidence agreement validators, and the pure-classifier
 * outcome projection. The concrete Doctor and production-absence declarations
 * live beside it.
 *
 * Mapping meaning (ADR 0025 §3, ADR 0026):
 *
 *  - a current, interpretable, evidence-backed match is `PASS`;
 *  - a current, interpretable, evidence-backed negative on a dimension the
 *    command authority declares as a trustworthy product or environment
 *    mismatch is `FAIL`;
 *  - missing, stale, torn, ambiguous, malformed, incomplete, or unsupported
 *    authority — including a negative on a dimension declared
 *    `authority-unavailable` — is `UNUSABLE`.
 *
 * Behavior and final outcome are kept separate: the behavior outcome is derived
 * from the check statuses only, while an environment/cleanup failure converts
 * the *final* outcome to `ENVIRONMENT_FAILURE` without erasing the behavior
 * fact (ADR 0025 §4 rule 7).
 *
 * This module is deliberately inactive. Nothing here is imported by the active
 * Doctor or production-absence CLI, writer, classifier, or output path, and no
 * current record is emitted from it.
 */

/** Closed authority-availability states for one delivered command fact. */
export const COMMAND_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'incomplete',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
  'unsupported',
] as const;
export type CommandAuthorityState = (typeof COMMAND_AUTHORITY_STATES)[number];

export function isCommandAuthorityState(value: unknown): value is CommandAuthorityState {
  return (
    typeof value === 'string' && (COMMAND_AUTHORITY_STATES as readonly string[]).includes(value)
  );
}

/**
 * The declared disposition of a trustworthy command negative. `product-mismatch`
 * and `environment-mismatch` assert `FAIL`; `environment-mismatch` additionally
 * raises the environment-failure precedence. `authority-unavailable` never
 * asserts a product mismatch: the negative is `UNUSABLE`, because the dimension
 * describes observation authority rather than product output.
 */
export const COMMAND_NEGATIVE_DISPOSITIONS = [
  'authority-unavailable',
  'environment-mismatch',
  'product-mismatch',
] as const;
export type CommandNegativeDisposition = (typeof COMMAND_NEGATIVE_DISPOSITIONS)[number];

export function isCommandNegativeDisposition(value: unknown): value is CommandNegativeDisposition {
  return (
    typeof value === 'string' &&
    (COMMAND_NEGATIVE_DISPOSITIONS as readonly string[]).includes(value)
  );
}

/** Closed evidence-availability vocabulary for one observed command evidence item. */
export const COMMAND_EVIDENCE_AVAILABILITIES = [
  'ambiguous',
  'authoritative',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type CommandEvidenceAvailability = (typeof COMMAND_EVIDENCE_AVAILABILITIES)[number];

export function isCommandEvidenceAvailability(
  value: unknown,
): value is CommandEvidenceAvailability {
  return (
    typeof value === 'string' &&
    (COMMAND_EVIDENCE_AVAILABILITIES as readonly string[]).includes(value)
  );
}

/** Closed command-context issue vocabulary; deliberately local to the inactive modules. */
export const COMMAND_CONTEXT_ISSUE_CODES = [
  'COMMAND_CONTEXT_DECLARATION_NOT_OBJECT',
  'COMMAND_CONTEXT_DECLARATION_INVALID',
  'COMMAND_CONTEXT_SCHEMA_UNSUPPORTED',
  'COMMAND_CONTEXT_COMMAND_UNSUPPORTED',
  'COMMAND_CONTEXT_EMPTY_REQUIRED_CHECKS',
  'COMMAND_CONTEXT_REQUIRED_CHECK_INVALID',
  'COMMAND_CONTEXT_REQUIRED_CHECK_DUPLICATE',
  'COMMAND_CONTEXT_NEGATIVE_DISPOSITION_UNKNOWN',
  'COMMAND_CONTEXT_AUTHORITY_NOT_OBJECT',
  'COMMAND_CONTEXT_AUTHORITY_SCHEMA_UNSUPPORTED',
  'COMMAND_CONTEXT_AUTHORITY_COMMAND_MISMATCH',
  'COMMAND_CONTEXT_AUTHORITY_ID_MISMATCH',
  'COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_MISSING',
  'COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_INVALID',
  'COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_MISMATCH',
  'COMMAND_CONTEXT_FACT_NOT_OBJECT',
  'COMMAND_CONTEXT_FACT_CHECK_UNKNOWN',
  'COMMAND_CONTEXT_FACT_CHECK_DUPLICATE',
  'COMMAND_CONTEXT_FACT_AUTHORITY_STATE_UNKNOWN',
  'COMMAND_CONTEXT_FACT_AUTHORITY_UNUSABLE',
  'COMMAND_CONTEXT_FACT_INCOMPLETE',
  'COMMAND_CONTEXT_FACT_MISMATCH',
  'COMMAND_CONTEXT_FACT_PROFILE_FABRICATION',
  'COMMAND_CONTEXT_FACT_CHECK_MISSING',
  'COMMAND_CONTEXT_EVIDENCE_NOT_OBJECT',
  'COMMAND_CONTEXT_EVIDENCE_UNDECLARED',
  'COMMAND_CONTEXT_EVIDENCE_UNUSABLE',
  'COMMAND_CONTEXT_EVIDENCE_DIAGNOSTIC_ONLY',
  'COMMAND_CONTEXT_EVIDENCE_MISSING',
] as const;
export type CommandContextIssueCode =
  | (typeof COMMAND_CONTEXT_ISSUE_CODES)[number]
  | ResultContractIssueCode;

export interface CommandContextIssue {
  readonly code: CommandContextIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface CommandContextValidation {
  readonly ok: boolean;
  readonly issues: readonly CommandContextIssue[];
}

/** One declared required command check with its stable expectation and disposition. */
export interface CommandCheckDeclaration {
  readonly checkId: string;
  readonly negativeDisposition: CommandNegativeDisposition;
  /** The dormant declared expectation the observed command fact is compared to. */
  readonly expected: Readonly<Record<string, unknown>>;
  /** Declared required-authoritative evidence ids this check consumes. */
  readonly requiredEvidence: readonly string[];
}

/**
 * The strict versioned command authority. It replaces the compiled profile for a
 * command context: it declares the closed required-check set, each check's
 * negative disposition and stable expectation, and the required/diagnostic
 * evidence roles. It carries no correctness-profile identity and no component
 * fingerprints, because a command context never consumes a compiled profile.
 */
export interface CommandAuthorityDeclaration {
  readonly schemaVersion: number;
  readonly command: CommandCheckContext;
  readonly commandAuthorityId: string;
  readonly requiredChecks: readonly CommandCheckDeclaration[];
  readonly requiredAuthoritativeEvidence: readonly string[];
  readonly diagnosticOnlyEvidence: readonly string[];
}

/** One delivered command fact for a declared required check. */
export interface CommandCheckFact {
  readonly checkId: string;
  readonly authorityState: CommandAuthorityState;
  /** True/false only when a current, interpretable comparison exists; null otherwise. */
  readonly matched: boolean | null;
  readonly actual: Readonly<Record<string, unknown>>;
}

/** One observed command evidence item, with its role availability. */
export interface CommandEvidenceFact {
  readonly evidenceId: string;
  readonly availability: CommandEvidenceAvailability;
}

export interface CommandContextInput {
  /** The versioned command authority the command consumed; validated, never trusted. */
  readonly commandAuthority: CommandStatusAuthority;
  readonly checks: readonly CommandCheckFact[];
  readonly evidence: readonly CommandEvidenceFact[];
  /** External allocation/launch/browser/prerequisite failure (environment precedence). */
  readonly environmentFailure?: boolean;
  readonly cleanupSucceeded: boolean;
}

export interface CommandContextOutcome {
  /** Null only for a pre-authority external failure with no evaluated checks. */
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly unusableCheckIds: readonly string[];
  readonly failingCheckIds: readonly string[];
}

export interface CommandContextResult {
  readonly command: CommandCheckContext;
  /** True when the declaration and supplied authority were trustworthy. */
  readonly ok: boolean;
  readonly checks: readonly CommandCheckResult[];
  readonly issues: readonly CommandContextIssue[];
  readonly declaredAuthority: CommandStatusAuthority;
  readonly environmentFailure: boolean;
  readonly outcome: CommandContextOutcome;
}

const PROFILE_IDENTITY_KEYS = [
  'actionCycleRef',
  'componentFingerprints',
  'consumedComponentFingerprints',
  'resolvedProfile',
  'resolvedProfileFingerprint',
] as const;

function issue(
  code: CommandContextIssueCode,
  detail: string,
  checkId: string | null = null,
): CommandContextIssue {
  return { code, detail, checkId };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function carriesProfileIdentity(record: Record<string, unknown>): string | null {
  for (const key of PROFILE_IDENTITY_KEYS) {
    if (hasOwn(record, key)) return key;
  }
  return null;
}

/**
 * Derives the full canonical, domain-separated identity of one command
 * authority declaration. The identity changes when any declared check,
 * disposition, expectation, check id, or evidence role changes, so a mutated or
 * substituted authority is detected rather than trusted.
 */
export function deriveCommandAuthorityFingerprint(
  declaration: CommandAuthorityDeclaration,
): string {
  const preimage = {
    command: declaration.command,
    commandAuthorityId: declaration.commandAuthorityId,
    requiredChecks: declaration.requiredChecks,
    requiredAuthoritativeEvidence: declaration.requiredAuthoritativeEvidence,
    diagnosticOnlyEvidence: declaration.diagnosticOnlyEvidence,
  };
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.commandStatusAuthority,
    declaration.schemaVersion,
    preimage,
  );
}

/** Projects the versioned declaration onto the B1-A `CommandStatusAuthority` identity. */
export function projectCommandStatusAuthority(
  declaration: CommandAuthorityDeclaration,
): CommandStatusAuthority {
  return Object.freeze({
    schemaVersion: declaration.schemaVersion,
    command: declaration.command,
    commandAuthorityId: declaration.commandAuthorityId,
    commandAuthorityFingerprint: deriveCommandAuthorityFingerprint(declaration),
  });
}

/** Validates the strict, closed authority-declaration DTO. */
export function validateCommandAuthorityDeclaration(
  declaration: unknown,
): CommandContextValidation {
  if (!isPlainRecord(declaration)) {
    return {
      ok: false,
      issues: [
        issue(
          'COMMAND_CONTEXT_DECLARATION_NOT_OBJECT',
          'A command authority declaration must be a plain object.',
        ),
      ],
    };
  }
  const issues: CommandContextIssue[] = [];
  if (!isCommandCheckContext(declaration.command)) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_COMMAND_UNSUPPORTED',
        `Command authority context "${String(declaration.command)}" is not a command context.`,
      ),
    );
  }
  if (
    typeof declaration.schemaVersion !== 'number' ||
    !Number.isInteger(declaration.schemaVersion) ||
    declaration.schemaVersion < 1
  ) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_SCHEMA_UNSUPPORTED',
        'A command authority declaration must carry a positive integer schemaVersion.',
      ),
    );
  }
  if (
    typeof declaration.commandAuthorityId !== 'string' ||
    declaration.commandAuthorityId.length === 0
  ) {
    issues.push(
      issue('COMMAND_CONTEXT_DECLARATION_INVALID', 'A command authority must carry an id.'),
    );
  }
  const forbidden = carriesProfileIdentity(declaration);
  if (forbidden !== null) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_FACT_PROFILE_FABRICATION',
        `A command authority declaration carries profile-identity field "${forbidden}".`,
      ),
    );
  }
  if (!isStringArray(declaration.requiredAuthoritativeEvidence)) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_DECLARATION_INVALID',
        'A command authority must declare its required-authoritative evidence ids.',
      ),
    );
  }
  if (!isStringArray(declaration.diagnosticOnlyEvidence)) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_DECLARATION_INVALID',
        'A command authority must declare its diagnostic-only evidence ids.',
      ),
    );
  }
  const requiredEvidence = isStringArray(declaration.requiredAuthoritativeEvidence)
    ? declaration.requiredAuthoritativeEvidence
    : [];
  const diagnosticEvidence = isStringArray(declaration.diagnosticOnlyEvidence)
    ? declaration.diagnosticOnlyEvidence
    : [];
  const overlap = requiredEvidence.filter((id) => diagnosticEvidence.includes(id));
  if (overlap.length > 0) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_DECLARATION_INVALID',
        `Command evidence ids cannot be both required-authoritative and diagnostic-only: ${overlap.join(', ')}.`,
      ),
    );
  }

  if (!Array.isArray(declaration.requiredChecks) || declaration.requiredChecks.length === 0) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_EMPTY_REQUIRED_CHECKS',
        'A command authority must declare at least one required check.',
      ),
    );
  } else {
    const seen = new Set<string>();
    for (const check of declaration.requiredChecks) {
      if (!isPlainRecord(check)) {
        issues.push(
          issue(
            'COMMAND_CONTEXT_REQUIRED_CHECK_INVALID',
            'A required command check is not an object.',
          ),
        );
        continue;
      }
      const checkId = typeof check.checkId === 'string' ? check.checkId : null;
      if (checkId === null || checkId.length === 0) {
        issues.push(
          issue('COMMAND_CONTEXT_REQUIRED_CHECK_INVALID', 'A required command check has no id.'),
        );
        continue;
      }
      if (seen.has(checkId)) {
        issues.push(
          issue(
            'COMMAND_CONTEXT_REQUIRED_CHECK_DUPLICATE',
            `Required command check "${checkId}" is declared more than once.`,
            checkId,
          ),
        );
        continue;
      }
      seen.add(checkId);
      if (!isCommandNegativeDisposition(check.negativeDisposition)) {
        issues.push(
          issue(
            'COMMAND_CONTEXT_NEGATIVE_DISPOSITION_UNKNOWN',
            `Required command check "${checkId}" declares unknown negative disposition "${String(check.negativeDisposition)}".`,
            checkId,
          ),
        );
      }
      if (!isPlainRecord(check.expected)) {
        issues.push(
          issue(
            'COMMAND_CONTEXT_REQUIRED_CHECK_INVALID',
            `Required command check "${checkId}" has no declared expectation object.`,
            checkId,
          ),
        );
      }
      if (!isStringArray(check.requiredEvidence)) {
        issues.push(
          issue(
            'COMMAND_CONTEXT_REQUIRED_CHECK_INVALID',
            `Required command check "${checkId}" has no required-evidence id list.`,
            checkId,
          ),
        );
      } else {
        for (const evidenceId of check.requiredEvidence) {
          if (!requiredEvidence.includes(evidenceId)) {
            issues.push(
              issue(
                'COMMAND_CONTEXT_DECLARATION_INVALID',
                `Required command check "${checkId}" consumes evidence "${evidenceId}" that is not declared required-authoritative.`,
                checkId,
              ),
            );
          }
        }
      }
      const checkForbidden = carriesProfileIdentity(check);
      if (checkForbidden !== null) {
        issues.push(
          issue(
            'COMMAND_CONTEXT_FACT_PROFILE_FABRICATION',
            `Required command check "${checkId}" carries profile-identity field "${checkForbidden}".`,
            checkId,
          ),
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Validates that the supplied versioned authority is exactly the declared
 * authority: same command context, same supported schema version, same id, and
 * the same full canonical fingerprint. Any mismatch fails closed so no check is
 * fabricated from a substituted or stale authority.
 */
export function validateCommandAuthorityAgreement(
  declaration: CommandAuthorityDeclaration,
  authority: unknown,
): CommandContextValidation {
  const issues: CommandContextIssue[] = [];
  if (!isPlainRecord(authority)) {
    return {
      ok: false,
      issues: [
        issue(
          'COMMAND_CONTEXT_AUTHORITY_NOT_OBJECT',
          'The consumed command authority is not a plain object.',
        ),
      ],
    };
  }
  const expected = projectCommandStatusAuthority(declaration);
  if (
    typeof authority.commandAuthorityFingerprint !== 'string' ||
    authority.commandAuthorityFingerprint.length === 0
  ) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_MISSING',
        'The consumed command authority has no fingerprint.',
      ),
    );
  } else if (!isFullCanonicalFingerprint(authority.commandAuthorityFingerprint)) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_INVALID',
        'The consumed command authority fingerprint is not a full canonical 64-hex identity.',
      ),
    );
  } else if (authority.commandAuthorityFingerprint !== expected.commandAuthorityFingerprint) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_MISMATCH',
        'The consumed command authority fingerprint does not equal the declared authority identity.',
      ),
    );
  }
  if (authority.command !== declaration.command) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_AUTHORITY_COMMAND_MISMATCH',
        `The consumed command authority declares context "${String(authority.command)}, not "${declaration.command}".`,
      ),
    );
  }
  if (authority.schemaVersion !== declaration.schemaVersion) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_AUTHORITY_SCHEMA_UNSUPPORTED',
        `The consumed command authority schema ${String(authority.schemaVersion)} is not the supported ${declaration.schemaVersion}.`,
      ),
    );
  }
  if (authority.commandAuthorityId !== declaration.commandAuthorityId) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_AUTHORITY_ID_MISMATCH',
        `The consumed command authority id "${String(authority.commandAuthorityId)}" does not equal "${declaration.commandAuthorityId}".`,
      ),
    );
  }
  return { ok: issues.length === 0, issues };
}

interface EvidenceConsumption {
  readonly consumed: readonly string[];
  readonly authoritative: boolean;
  readonly state: CommandAuthorityState;
}

const UNAVAILABLE_EVIDENCE_STATES: Readonly<Record<string, CommandAuthorityState>> = {
  ambiguous: 'ambiguous',
  'diagnostic-only': 'malformed',
  malformed: 'malformed',
  missing: 'missing',
  stale: 'stale',
  torn: 'torn',
};

/**
 * Derives the exact required-authoritative evidence one command check actually
 * consumed. Only an `authoritative` observed role is consumed; a missing,
 * stale, torn, ambiguous, malformed, or diagnostic-only role makes the check
 * `UNUSABLE` and is never silently ignored.
 */
function consumeRequiredEvidence(
  declaration: CommandCheckDeclaration,
  evidence: readonly CommandEvidenceFact[],
  issues: CommandContextIssue[],
): EvidenceConsumption {
  const byId = new Map<string, CommandEvidenceFact>();
  for (const fact of evidence) {
    if (isPlainRecord(fact) && typeof fact.evidenceId === 'string') {
      byId.set(fact.evidenceId, fact);
    }
  }
  const consumed: string[] = [];
  let state: CommandAuthorityState | null = null;
  for (const evidenceId of declaration.requiredEvidence) {
    const fact = byId.get(evidenceId);
    if (fact === undefined) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_EVIDENCE_MISSING',
          `Required command evidence "${evidenceId}" was not observed.`,
          declaration.checkId,
        ),
      );
      state ??= 'missing';
      continue;
    }
    if (fact.availability === 'authoritative') {
      consumed.push(evidenceId);
      continue;
    }
    issues.push(
      issue(
        fact.availability === 'diagnostic-only'
          ? 'COMMAND_CONTEXT_EVIDENCE_DIAGNOSTIC_ONLY'
          : 'COMMAND_CONTEXT_EVIDENCE_UNUSABLE',
        `Required command evidence "${evidenceId}" is ${fact.availability}; a required check cannot consume it.`,
        declaration.checkId,
      ),
    );
    state ??= UNAVAILABLE_EVIDENCE_STATES[fact.availability] ?? 'ambiguous';
  }
  return { consumed, authoritative: state === null, state: state ?? 'current' };
}

function resolveCommandStatus(
  declaration: CommandCheckDeclaration,
  fact: CommandCheckFact | null,
  evidence: EvidenceConsumption,
  issues: CommandContextIssue[],
): { readonly status: CheckResultStatus; readonly authorityState: CommandAuthorityState } {
  if (!evidence.authoritative) {
    return { status: 'UNUSABLE', authorityState: evidence.state };
  }
  if (fact === null) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_FACT_CHECK_MISSING',
        `No delivered command fact exists for declared check "${declaration.checkId}".`,
        declaration.checkId,
      ),
    );
    return { status: 'UNUSABLE', authorityState: 'missing' };
  }
  if (fact.authorityState !== 'current') {
    issues.push(
      issue(
        'COMMAND_CONTEXT_FACT_AUTHORITY_UNUSABLE',
        `Declared check "${declaration.checkId}" authority is ${fact.authorityState}.`,
        declaration.checkId,
      ),
    );
    return { status: 'UNUSABLE', authorityState: fact.authorityState };
  }
  if (typeof fact.matched !== 'boolean') {
    issues.push(
      issue(
        'COMMAND_CONTEXT_FACT_INCOMPLETE',
        `Declared check "${declaration.checkId}" has current authority but no complete comparison fact.`,
        declaration.checkId,
      ),
    );
    return { status: 'UNUSABLE', authorityState: 'incomplete' };
  }
  if (fact.matched) {
    return { status: 'PASS', authorityState: 'current' };
  }
  if (declaration.negativeDisposition === 'authority-unavailable') {
    issues.push(
      issue(
        'COMMAND_CONTEXT_FACT_AUTHORITY_UNUSABLE',
        `Declared check "${declaration.checkId}" cannot assert a trustworthy mismatch; its negative is unavailable authority.`,
        declaration.checkId,
      ),
    );
    return { status: 'UNUSABLE', authorityState: 'unavailable' };
  }
  issues.push(
    issue(
      'COMMAND_CONTEXT_FACT_MISMATCH',
      `Declared check "${declaration.checkId}" established a trustworthy ${declaration.negativeDisposition === 'environment-mismatch' ? 'environment' : 'product'} mismatch.`,
      declaration.checkId,
    ),
  );
  return { status: 'FAIL', authorityState: 'current' };
}

function actualPayload(
  fact: CommandCheckFact | null,
  authorityState: CommandAuthorityState,
  matched: boolean | null,
): Record<string, unknown> {
  return {
    ...(fact === null ? {} : fact.actual),
    authorityState,
    matched,
  };
}

function classify(
  checks: readonly CommandCheckResult[],
  environmentFailure: boolean,
  cleanupSucceeded: boolean,
): CommandContextOutcome {
  const classified = classifyStatusOutcome({
    requiredChecks: checks.map((check) => ({ checkId: check.checkId, status: check.status })),
    externalFailure: environmentFailure,
    cleanupSucceeded,
  });
  return {
    behaviorOutcome: classified.behaviorOutcome,
    finalOutcome: classified.finalOutcome,
    unusableCheckIds: classified.unusableCheckIds,
    failingCheckIds: classified.failingCheckIds,
  };
}

/**
 * Constructs the complete explicit-status command-context result from a
 * versioned declaration and the delivered command facts. When the declaration or
 * the supplied authority is not trustworthy, no check is fabricated: `ok` is
 * false and `checks` is empty.
 */
export function evaluateCommandContext(
  declaration: CommandAuthorityDeclaration,
  input: CommandContextInput,
): CommandContextResult {
  const issues: CommandContextIssue[] = [];
  const declaredAuthority = projectCommandStatusAuthority(declaration);

  const declarationValidation = validateCommandAuthorityDeclaration(declaration);
  issues.push(...declarationValidation.issues);
  const authorityValidation = validateCommandAuthorityAgreement(
    declaration,
    input.commandAuthority,
  );
  issues.push(...authorityValidation.issues);
  if (!declarationValidation.ok || !authorityValidation.ok) {
    return {
      command: declaration.command,
      ok: false,
      checks: [],
      issues,
      declaredAuthority,
      environmentFailure: input.environmentFailure === true,
      outcome: classify([], input.environmentFailure === true, input.cleanupSucceeded),
    };
  }

  const declaredIds = new Set(declaration.requiredChecks.map((check) => check.checkId));
  const factById = new Map<string, CommandCheckFact>();
  const rawFacts: readonly unknown[] = Array.isArray(input.checks) ? input.checks : [];
  for (const raw of rawFacts) {
    if (!isPlainRecord(raw)) {
      issues.push(
        issue('COMMAND_CONTEXT_FACT_NOT_OBJECT', 'A command fact is not a plain object.'),
      );
      continue;
    }
    const checkId = typeof raw.checkId === 'string' ? raw.checkId : null;
    if (checkId === null || checkId.length === 0) {
      issues.push(issue('COMMAND_CONTEXT_FACT_NOT_OBJECT', 'A command fact has no check id.'));
      continue;
    }
    if (!declaredIds.has(checkId)) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_FACT_CHECK_UNKNOWN',
          `Command fact "${checkId}" is not a declared required check.`,
          checkId,
        ),
      );
      continue;
    }
    if (factById.has(checkId)) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_FACT_CHECK_DUPLICATE',
          `Command fact "${checkId}" is delivered more than once.`,
          checkId,
        ),
      );
      continue;
    }
    if (!isCommandAuthorityState(raw.authorityState)) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_FACT_AUTHORITY_STATE_UNKNOWN',
          `Command fact "${checkId}" declares unknown authority state "${String(raw.authorityState)}".`,
          checkId,
        ),
      );
      continue;
    }
    const forbidden = carriesProfileIdentity(raw);
    if (forbidden !== null) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_FACT_PROFILE_FABRICATION',
          `Command fact "${checkId}" carries profile-identity field "${forbidden}"; command facts must not fabricate a resolved profile.`,
          checkId,
        ),
      );
      continue;
    }
    const matched =
      raw.matched === null || typeof raw.matched === 'boolean'
        ? (raw.matched as boolean | null)
        : undefined;
    if (matched === undefined || !isPlainRecord(raw.actual)) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_FACT_NOT_OBJECT',
          `Command fact "${checkId}" has no interpretable matched/actual facts.`,
          checkId,
        ),
      );
      continue;
    }
    if (raw.authorityState !== 'current' && matched !== null) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_FACT_INCOMPLETE',
          `Command fact "${checkId}" asserts a comparison while its authority state is "${raw.authorityState}".`,
          checkId,
        ),
      );
      continue;
    }
    factById.set(checkId, {
      checkId,
      authorityState: raw.authorityState,
      matched,
      actual: raw.actual,
    });
  }

  const evidence: readonly CommandEvidenceFact[] = Array.isArray(input.evidence)
    ? input.evidence.filter(
        (fact): fact is CommandEvidenceFact =>
          isPlainRecord(fact) &&
          typeof fact.evidenceId === 'string' &&
          isCommandEvidenceAvailability(fact.availability),
      )
    : [];

  let environmentFailure = input.environmentFailure === true;
  const checks: CommandCheckResult[] = [];
  for (const checkDeclaration of declaration.requiredChecks) {
    const evidenceConsumption = consumeRequiredEvidence(checkDeclaration, evidence, issues);
    const fact = factById.get(checkDeclaration.checkId) ?? null;
    const resolved = resolveCommandStatus(checkDeclaration, fact, evidenceConsumption, issues);
    if (
      resolved.status === 'FAIL' &&
      checkDeclaration.negativeDisposition === 'environment-mismatch'
    ) {
      environmentFailure = true;
    }
    const check: CommandCheckResult = {
      schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
      checkId: checkDeclaration.checkId,
      status: resolved.status,
      expected: checkDeclaration.expected,
      actual: actualPayload(
        fact,
        resolved.authorityState,
        resolved.status === 'PASS' || resolved.status === 'FAIL' ? (fact?.matched ?? null) : null,
      ),
      evidenceIds: [...evidenceConsumption.consumed].sort(),
      commandAuthority: input.commandAuthority,
    };
    // A command check must belong to exactly one context and must never fabricate
    // a compiled-profile identity.
    const separation = validateCheckContextSeparation(check);
    issues.push(...separation.issues);
    checks.push(check);
  }

  return {
    command: declaration.command,
    ok: true,
    checks,
    issues,
    declaredAuthority,
    environmentFailure,
    outcome: classify(checks, environmentFailure, input.cleanupSucceeded),
  };
}

/**
 * Strictly validates one produced (or foreign) command check against the
 * declared authority and observed evidence. Unknown/missing status, a mixed
 * profile-command context, an authority that disagrees with the declaration,
 * undeclared or diagnostic-only evidence consumption, and a passing check with
 * missing declared required evidence all fail closed.
 */
export function validateCommandContextResult(
  declaration: CommandAuthorityDeclaration,
  value: unknown,
  evidence: readonly CommandEvidenceFact[] = [],
): CommandContextValidation {
  const separation: ResultContractValidation = validateCheckContextSeparation(value);
  const issues: CommandContextIssue[] = [...separation.issues];
  if (!isPlainRecord(value)) return { ok: false, issues };

  if (hasOwn(value, 'commandAuthority')) {
    const agreement = validateCommandAuthorityAgreement(declaration, value.commandAuthority);
    issues.push(...agreement.issues);
  }
  if (!isCheckResultStatus(value.status)) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_DECLARATION_INVALID',
        `Command check "${String(value.checkId)}" has no valid status.`,
        typeof value.checkId === 'string' ? value.checkId : null,
      ),
    );
  }
  const checkDeclaration = declaration.requiredChecks.find(
    (entry) => entry.checkId === value.checkId,
  );
  if (checkDeclaration === undefined) {
    issues.push(
      issue(
        'COMMAND_CONTEXT_FACT_CHECK_UNKNOWN',
        `Command check "${String(value.checkId)}" is not a declared required check.`,
        typeof value.checkId === 'string' ? value.checkId : null,
      ),
    );
    return { ok: false, issues };
  }
  const evidenceIds = isStringArray(value.evidenceIds) ? value.evidenceIds : [];
  const declaredRequired = new Set(declaration.requiredAuthoritativeEvidence);
  const diagnostic = new Set(declaration.diagnosticOnlyEvidence);
  for (const evidenceId of evidenceIds) {
    if (diagnostic.has(evidenceId)) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_EVIDENCE_DIAGNOSTIC_ONLY',
          `Command check "${checkDeclaration.checkId}" consumed diagnostic-only evidence "${evidenceId}".`,
          checkDeclaration.checkId,
        ),
      );
    } else if (!declaredRequired.has(evidenceId)) {
      issues.push(
        issue(
          'COMMAND_CONTEXT_EVIDENCE_UNDECLARED',
          `Command check "${checkDeclaration.checkId}" consumed undeclared evidence "${evidenceId}".`,
          checkDeclaration.checkId,
        ),
      );
    }
  }
  const observed = new Map(evidence.map((fact) => [fact.evidenceId, fact.availability]));
  for (const requiredId of checkDeclaration.requiredEvidence) {
    if (observed.get(requiredId) !== 'authoritative') {
      issues.push(
        issue(
          'COMMAND_CONTEXT_EVIDENCE_MISSING',
          `Command check "${checkDeclaration.checkId}" required evidence "${requiredId}" is not authoritative.`,
          checkDeclaration.checkId,
        ),
      );
    }
  }
  if (value.status === 'PASS') {
    for (const requiredId of checkDeclaration.requiredEvidence) {
      if (!evidenceIds.includes(requiredId)) {
        issues.push(
          issue(
            'COMMAND_CONTEXT_EVIDENCE_MISSING',
            `Passing command check "${checkDeclaration.checkId}" is missing declared required evidence "${requiredId}".`,
            checkDeclaration.checkId,
          ),
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/** True when the two checks belong to the same command context and authority. */
export function sameCommandContext(
  left: Pick<CommandCheckResult, 'commandAuthority'>,
  right: Pick<CommandCheckResult, 'commandAuthority'>,
): boolean {
  return (
    left.commandAuthority.command === right.commandAuthority.command &&
    left.commandAuthority.commandAuthorityId === right.commandAuthority.commandAuthorityId &&
    left.commandAuthority.schemaVersion === right.commandAuthority.schemaVersion &&
    left.commandAuthority.commandAuthorityFingerprint ===
      right.commandAuthority.commandAuthorityFingerprint
  );
}
