import type { DoctorRawCommandFacts } from '../browser/doctor';
import type { CommandExecutionContextInput } from '../orchestration/command-execution';

/**
 * P7-B2-E2R inactive Doctor command live-fact adapter (ADR 0031 §2).
 *
 * The additive raw Doctor API exposes only named observations, explicit
 * authority/currentness, evidence availability, and external page/environment
 * failure facts. This adapter is the single place that maps those raw facts onto
 * the accepted B1-G command vocabulary (`CommandCheckFact[]` +
 * `CommandEvidenceFact[]`) bound to the caller-supplied versioned Doctor command
 * authority. The browser module never fabricates a `CommandCheckResult`, a
 * `passed` boolean, a `harnessInvalid` side channel, a status, an outcome, or a
 * correctness profile; the adapter never reads any legacy composite check array
 * either.
 *
 * The declared check ids, evidence roles, and projected status authority are
 * supplied by the caller (the eventual active command boundary owns its
 * declaration), so this adapter has no authoring-catalogue, policy, or
 * declaration edge of its own. A raw fact set that does not cover exactly the
 * declared checks and evidence roles fails closed instead of producing a
 * partial handoff.
 *
 * It is deliberately inactive: it is not exported from `src/index.ts`, is
 * imported only by its focused foundation test, and is referenced by no active
 * Doctor CLI, browser runner, writer, reader, classifier, or public projection.
 */

/** Closed adapter refusal vocabulary; deliberately local to the inactive adapter. */
export const DOCTOR_LIVE_FACT_ISSUE_CODES = [
  'RAW_FACTS_NOT_OBJECT',
  'RAW_FACTS_COMMAND_MISMATCH',
  'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
  'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
  'RAW_FACTS_EVIDENCE_MALFORMED',
  'RAW_FACTS_AUTHORITY_UNKNOWN',
  'RAW_FACTS_COMPARISON_INVALID',
  'RAW_FACTS_EVIDENCE_AVAILABILITY_UNKNOWN',
  'DECLARATION_INVALID',
] as const;
export type DoctorLiveFactIssueCode = (typeof DOCTOR_LIVE_FACT_ISSUE_CODES)[number];

export interface DoctorLiveFactIssue {
  readonly code: DoctorLiveFactIssueCode;
  readonly detail: string;
}

/** The versioned command authority, structurally the B1-G `CommandStatusAuthority`. */
type CommandStatusAuthority = CommandExecutionContextInput['commandAuthority'];
type CommandCheckFact = CommandExecutionContextInput['checks'][number];
type CommandEvidenceFact = CommandExecutionContextInput['evidence'][number];

/**
 * The caller-supplied closed Doctor declaration view: the declared required
 * check ids, the declared evidence roles, and the projected status authority.
 * It carries no correctness profile.
 */
export interface DoctorCommandDeclarationView {
  readonly authority: CommandStatusAuthority;
  readonly requiredCheckIds: readonly string[];
  readonly requiredEvidenceIds: readonly string[];
  readonly diagnosticEvidenceIds: readonly string[];
}

/** The closed authority/evidence vocabularies the B1-G command facts accept. */
const COMMAND_AUTHORITY_STATES: readonly string[] = Object.freeze([
  'ambiguous',
  'current',
  'incomplete',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
  'unsupported',
]);
const COMMAND_EVIDENCE_AVAILABILITIES: readonly string[] = Object.freeze([
  'ambiguous',
  'authoritative',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
]);

export type DoctorCommandFactAdaptation =
  | { readonly ok: true; readonly input: CommandExecutionContextInput }
  | {
      readonly ok: false;
      readonly status: 'HARNESS_BLOCKED';
      readonly issues: readonly DoctorLiveFactIssue[];
    };

function fail(issues: readonly DoctorLiveFactIssue[]): DoctorCommandFactAdaptation {
  return { ok: false, status: 'HARNESS_BLOCKED', issues: Object.freeze([...issues]) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Maps one raw Doctor fact set onto the B1-G command-context input. Every
 * declared check and evidence role must be present exactly once; an unknown
 * authority state, an unknown evidence availability, or a non-boolean current
 * comparison fails closed so no status can be derived from a fabricated fact.
 */
export function adaptDoctorCommandFacts(input: {
  readonly declaration: DoctorCommandDeclarationView;
  readonly raw: DoctorRawCommandFacts;
}): DoctorCommandFactAdaptation {
  const declaration = input.declaration;
  const raw = input.raw;
  if (
    !isPlainRecord(declaration) ||
    !isStringArray(declaration.requiredCheckIds) ||
    !isStringArray(declaration.requiredEvidenceIds) ||
    !isStringArray(declaration.diagnosticEvidenceIds) ||
    !isPlainRecord(declaration.authority)
  ) {
    return fail([
      {
        code: 'DECLARATION_INVALID',
        detail:
          'The Doctor command declaration view must carry check ids, evidence roles, and a projected authority.',
      },
    ]);
  }
  if (!isPlainRecord(raw)) {
    return fail([
      { code: 'RAW_FACTS_NOT_OBJECT', detail: 'Raw Doctor facts must be a plain object.' },
    ]);
  }
  if (raw.command !== 'doctor') {
    return fail([
      {
        code: 'RAW_FACTS_COMMAND_MISMATCH',
        detail: `Raw facts declare command "${String(raw.command)}", not "doctor".`,
      },
    ]);
  }

  const declaredCheckIds = declaration.requiredCheckIds;
  const declaredEvidenceIds = [
    ...declaration.requiredEvidenceIds,
    ...declaration.diagnosticEvidenceIds,
  ];
  const issues: DoctorLiveFactIssue[] = [];
  // The declaration itself must be closed: a repeated declared check or
  // evidence role would otherwise admit an ambiguous duplicate handoff.
  if (
    new Set(declaredCheckIds).size !== declaredCheckIds.length ||
    declaredCheckIds.some((entry) => entry.length === 0) ||
    new Set(declaredEvidenceIds).size !== declaredEvidenceIds.length ||
    declaredEvidenceIds.some((entry) => entry.length === 0)
  ) {
    return fail([
      {
        code: 'DECLARATION_INVALID',
        detail:
          'The Doctor command declaration must name every check and evidence role exactly once.',
      },
    ]);
  }
  const checks = Array.isArray(raw.checks) ? raw.checks : [];
  const byCheckId = new Map<string, (typeof checks)[number]>();
  for (const check of checks) {
    const checkId = typeof check?.checkId === 'string' ? check.checkId : null;
    if (checkId === null || checkId.length === 0) {
      issues.push({
        code: 'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
        detail: 'A raw check has no check id.',
      });
      continue;
    }
    if (byCheckId.has(checkId)) {
      issues.push({
        code: 'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
        detail: `Raw check "${checkId}" appears more than once.`,
      });
      continue;
    }
    byCheckId.set(checkId, check);
  }
  for (const declared of declaredCheckIds) {
    if (!byCheckId.has(declared)) {
      issues.push({
        code: 'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
        detail: `Raw Doctor facts do not observe the declared check "${declared}".`,
      });
    }
  }
  for (const observed of byCheckId.keys()) {
    if (!declaredCheckIds.includes(observed)) {
      issues.push({
        code: 'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
        detail: `Raw Doctor facts observe undeclared check "${observed}".`,
      });
    }
  }

  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const byEvidenceId = new Map<string, (typeof evidence)[number]>();
  for (const entry of evidence) {
    if (
      !isPlainRecord(entry) ||
      typeof entry.evidenceId !== 'string' ||
      entry.evidenceId.length === 0
    ) {
      issues.push({
        code: 'RAW_FACTS_EVIDENCE_MALFORMED',
        detail: 'A raw evidence observation is not a plain object with a non-empty evidence id.',
      });
      continue;
    }
    const evidenceId = entry.evidenceId;
    if (byEvidenceId.has(evidenceId)) {
      issues.push({
        code: 'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
        detail: `Raw evidence "${evidenceId}" appears more than once.`,
      });
      continue;
    }
    byEvidenceId.set(evidenceId, entry);
  }
  for (const declared of declaredEvidenceIds) {
    if (!byEvidenceId.has(declared)) {
      issues.push({
        code: 'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
        detail: `Raw Doctor facts do not observe the declared evidence role "${declared}".`,
      });
    }
  }
  for (const observed of byEvidenceId.keys()) {
    if (!declaredEvidenceIds.includes(observed)) {
      issues.push({
        code: 'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
        detail: `Raw Doctor facts observe undeclared evidence role "${observed}".`,
      });
    }
  }

  const mappedChecks: CommandCheckFact[] = [];
  for (const declared of declaredCheckIds) {
    const check = byCheckId.get(declared);
    if (check === undefined) continue;
    if (
      typeof check.authority !== 'string' ||
      !COMMAND_AUTHORITY_STATES.includes(check.authority)
    ) {
      issues.push({
        code: 'RAW_FACTS_AUTHORITY_UNKNOWN',
        detail: `Raw check "${declared}" declares unknown authority "${String(check.authority)}".`,
      });
      continue;
    }
    if (check.authority === 'current' && typeof check.comparison !== 'boolean') {
      issues.push({
        code: 'RAW_FACTS_COMPARISON_INVALID',
        detail: `Raw check "${declared}" has current authority but no boolean comparison.`,
      });
      continue;
    }
    mappedChecks.push(
      Object.freeze({
        checkId: declared,
        authorityState: check.authority as CommandCheckFact['authorityState'],
        matched: check.authority === 'current' ? (check.comparison as boolean) : null,
        actual: isPlainRecord(check.observed) ? Object.freeze({ ...check.observed }) : {},
      }),
    );
  }

  const mappedEvidence: CommandEvidenceFact[] = [];
  for (const declared of declaredEvidenceIds) {
    const entry = byEvidenceId.get(declared);
    if (entry === undefined) continue;
    if (
      typeof entry.availability !== 'string' ||
      !COMMAND_EVIDENCE_AVAILABILITIES.includes(entry.availability)
    ) {
      issues.push({
        code: 'RAW_FACTS_EVIDENCE_AVAILABILITY_UNKNOWN',
        detail: `Raw evidence "${declared}" declares unknown availability "${String(entry.availability)}".`,
      });
      continue;
    }
    mappedEvidence.push(
      Object.freeze({
        evidenceId: declared,
        availability: entry.availability as CommandEvidenceFact['availability'],
      }),
    );
  }

  if (issues.length > 0) return fail(issues);

  return {
    ok: true,
    input: {
      commandAuthority: declaration.authority,
      checks: Object.freeze(mappedChecks),
      evidence: Object.freeze(mappedEvidence),
      environmentFailure: raw.externalFailure === true,
      cleanupSucceeded: raw.cleanupSucceeded === true,
    },
  };
}
