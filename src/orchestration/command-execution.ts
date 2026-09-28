import {
  type CommandAuthorityDeclaration,
  type CommandCheckFact,
  type CommandContextIssue,
  type CommandEvidenceFact,
  evaluateCommandContext,
  projectCommandStatusAuthority,
  sameCommandContext,
} from '../commands/command-context';
import {
  isCommandCheckContext,
  validateCheckContextSeparation,
  type CommandCheckContext,
  type CommandCheckResult,
  type CommandStatusAuthority,
} from '../contracts/command-check';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { Outcome } from '../contracts/discriminants';
import { readFinalRecord } from '../contracts/final-record-reader';
import {
  assembleFinalCommandRecordV4,
  type FinalCommandCheckRecordV4,
} from '../contracts/final-record-v4';
import { isPlainRecord } from '../contracts/result-agreement';

/**
 * P7-B2-D2 command-context execution orchestration (ADR 0029 §4 B2-D;
 * post-cutover current path, ADR 0032 §E3-S2).
 *
 * This is the runtime half of the P7-B2-D checkpoint that backs the current
 * `pnpm verify:artwork doctor` and `pnpm verify:artwork production-absence`
 * boundaries: it consumes the exact B1-G versioned command authority plus the
 * raw active command facts, evidence-role availability, external-failure, and
 * cleanup facts, evaluates the explicit `PASS | FAIL | UNUSABLE` command checks,
 * classifies the behavior and final outcomes with the shared pure classifier,
 * and assembles one strict v4 command-context record through the B2-C assembly.
 *
 * A command context never receives or fabricates a compiled correctness profile
 * or a materialized execution envelope: its versioned `CommandStatusAuthority`
 * is the whole correctness authority. Foreign, stale, malformed, or mixed
 * authorities fail closed before any check is fabricated, and a produced record
 * is accepted only when the strict reader classifies it as a current
 * `command-v4` record. No legacy boolean check projection and no removed
 * aggregate invalidity side channel appears anywhere on this path.
 *
 * This module is the current command-context orchestration: the post-cutover CLI
 * reaches it through the final façade and its sibling command adapters. It owns
 * no policy: no required-check array, no profile/fallback id, no expectation
 * literal, no evidence-role default, and no recompilation. It never writes
 * evidence and never calls a legacy boolean/v3 writer.
 */

/**
 * Raw primary-delivered command-context facts. The declaration (and therefore
 * the closed required-check set and expectations) is bound by the command
 * adapter, never by this input.
 */
export interface CommandExecutionContextInput {
  /** The versioned command authority the command consumed; validated, never trusted. */
  readonly commandAuthority: CommandStatusAuthority;
  /** One delivered raw command fact per declared required check, with its currentness. */
  readonly checks: readonly CommandCheckFact[];
  /** One observed evidence item per evidence role, with its role availability. */
  readonly evidence: readonly CommandEvidenceFact[];
  /** External allocation/launch/browser/prerequisite failure (environment precedence). */
  readonly environmentFailure?: boolean;
  readonly cleanupSucceeded: boolean;
}

/** Closed orchestration refusal vocabulary; deliberately local to this module. */
export const COMMAND_EXECUTION_ISSUE_CODES = [
  'COMMAND_AUTHORITY_UNTRUSTWORTHY',
  'COMMAND_AUTHORITY_MIXED',
  'COMMAND_CHECK_FOREIGN_CONTEXT',
  'COMMAND_CHECK_MIXED_CONTEXT',
  'COMMAND_RECORD_ASSEMBLY_FAILED',
  'COMMAND_RECORD_NOT_STRICT_V4',
] as const;
export type CommandExecutionIssueCode = (typeof COMMAND_EXECUTION_ISSUE_CODES)[number];

/** Primary orchestration diagnostic per issue; never a product `BUG` code. */
const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<CommandExecutionIssueCode, DiagnosticCode>> =
  Object.freeze({
    COMMAND_AUTHORITY_UNTRUSTWORTHY: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    COMMAND_AUTHORITY_MIXED: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    COMMAND_CHECK_FOREIGN_CONTEXT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    COMMAND_CHECK_MIXED_CONTEXT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    COMMAND_RECORD_ASSEMBLY_FAILED: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    COMMAND_RECORD_NOT_STRICT_V4: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
  } satisfies Record<CommandExecutionIssueCode, DiagnosticCode>);

export interface CommandExecutionIssue {
  readonly code: CommandExecutionIssueCode;
  readonly detail: string;
}

export interface CommandExecutionValidation {
  readonly ok: boolean;
  readonly issues: readonly CommandExecutionIssue[];
}

/**
 * The terminal orchestration outcome. `finalOutcome` is one of the four accepted
 * outcomes; `behaviorOutcome` preserves the product behavior verdict
 * independently and is `null` only when no check authority was evaluated (a
 * pre-authority external failure). `record` is the strict v4 command-context
 * record, or `null` when the command was refused before producing one.
 */
export interface CommandExecutionOutcome {
  readonly command: CommandCheckContext;
  /** True only when the declaration and the consumed authority were trustworthy. */
  readonly authoritative: boolean;
  /** True when the refusal happened before any command check could be evaluated. */
  readonly preauthority: boolean;
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly requiredChecks: readonly CommandCheckResult[];
  readonly unusableCheckIds: readonly string[];
  readonly failingCheckIds: readonly string[];
  readonly record: FinalCommandCheckRecordV4 | null;
  /** Orchestration refusals; empty on a trustworthy evaluated command. */
  readonly issues: readonly CommandExecutionIssue[];
  /** The underlying B1-G command-context issues (mismatch/evidence/unusable facts). */
  readonly commandIssues: readonly CommandContextIssue[];
  readonly diagnostics: readonly DiagnosticRecord[];
}

/** The exact closed field set of a versioned command authority. */
const COMMAND_STATUS_AUTHORITY_FIELDS = [
  'command',
  'commandAuthorityFingerprint',
  'commandAuthorityId',
  'schemaVersion',
] as const;

function issue(code: CommandExecutionIssueCode, detail: string): CommandExecutionIssue {
  return { code, detail };
}

/**
 * Strict closed-shape check of the consumed command authority. A non-object, an
 * unknown command context, or any unexpected field (in particular a
 * compiled-profile identity field) fails closed, so a foreign, stale, malformed,
 * or mixed authority can never contribute to a fabricated check or record.
 */
function validateConsumedAuthorityShape(authority: unknown): CommandExecutionIssue | null {
  if (!isPlainRecord(authority)) {
    return issue(
      'COMMAND_AUTHORITY_UNTRUSTWORTHY',
      'The consumed command authority is not a plain object.',
    );
  }
  for (const key of Object.keys(authority)) {
    if (!(COMMAND_STATUS_AUTHORITY_FIELDS as readonly string[]).includes(key)) {
      return issue(
        'COMMAND_AUTHORITY_MIXED',
        `The consumed command authority carries unexpected field "${key}"; a command authority must not mix compiled-profile identity.`,
      );
    }
  }
  if (!isCommandCheckContext(authority.command)) {
    return issue(
      'COMMAND_AUTHORITY_UNTRUSTWORTHY',
      `The consumed command authority declares unknown command context "${String(authority.command)}".`,
    );
  }
  return null;
}

/**
 * Validates that every produced command check belongs to exactly one context
 * (command authority, never compiled-profile identity) and shares the declared
 * command authority exactly. A foreign or mixed check fails closed so no
 * cross-context check can be assembled into a command record.
 */
export function validateCommandExecutionChecks(
  declaration: CommandAuthorityDeclaration,
  checks: readonly unknown[],
): CommandExecutionValidation {
  const expected = projectCommandStatusAuthority(declaration);
  const issues: CommandExecutionIssue[] = [];
  for (const check of checks) {
    const separation = validateCheckContextSeparation(check);
    if (!separation.ok) {
      const mixed = separation.issues.some(
        (entry) =>
          entry.code === 'RESULT_COMMAND_CONTEXT_FORBIDDEN' ||
          entry.code === 'RESULT_COMMAND_CONTEXT_REQUIRED',
      );
      issues.push(
        issue(
          mixed ? 'COMMAND_CHECK_MIXED_CONTEXT' : 'COMMAND_CHECK_FOREIGN_CONTEXT',
          `A produced command check failed context separation: ${separation.issues
            .map((entry) => entry.code)
            .join(', ')}.`,
        ),
      );
      continue;
    }
    const checkAuthority = (check as { readonly commandAuthority?: unknown }).commandAuthority;
    if (
      !isPlainRecord(checkAuthority) ||
      !sameCommandContext(
        { commandAuthority: checkAuthority as unknown as CommandStatusAuthority },
        { commandAuthority: expected },
      )
    ) {
      issues.push(
        issue(
          'COMMAND_CHECK_FOREIGN_CONTEXT',
          'A produced command check does not share the declared command authority.',
        ),
      );
    }
  }
  return { ok: issues.length === 0, issues: Object.freeze(issues) };
}

function refusal(input: {
  readonly command: CommandCheckContext;
  readonly preauthority: boolean;
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly issues: readonly CommandExecutionIssue[];
  readonly commandIssues?: readonly CommandContextIssue[];
}): CommandExecutionOutcome {
  const primary = input.issues[0];
  const diagnostics =
    primary === undefined
      ? []
      : [
          createDiagnostic(
            PRIMARY_DIAGNOSTIC_CODE[primary.code],
            `${primary.code}: ${primary.detail}`,
            { context: { issueCode: primary.code } },
          ),
        ];
  return {
    command: input.command,
    authoritative: false,
    preauthority: input.preauthority,
    behaviorOutcome: input.behaviorOutcome,
    finalOutcome: input.finalOutcome,
    requiredChecks: [],
    unusableCheckIds: [],
    failingCheckIds: [],
    record: null,
    issues: Object.freeze([...input.issues]),
    commandIssues: Object.freeze([...(input.commandIssues ?? [])]),
    diagnostics: Object.freeze(diagnostics),
  };
}

/**
 * Executes one command context (Doctor or production-absence) through the
 * current final path.
 *
 * Order is deliberate and fail-closed:
 *  1. a foreign, stale, malformed, or mixed consumed authority is refused
 *     pre-authority with no fabricated check and no record;
 *  2. the declaration/authority agreement is evaluated by B1-G; a disagreement
 *     fabricates no check and no record;
 *  3. every produced check is confirmed to belong to exactly one command
 *     context and to share the declared authority exactly;
 *  4. the strict v4 command record is assembled and re-read; a record that does
 *     not classify as current `command-v4` is refused.
 *
 * The behavior and final outcomes come solely from the B1-G explicit statuses
 * and the delivered external/cleanup facts. A cleanup failure preserves the
 * behavior verdict and converts only the final outcome to
 * `ENVIRONMENT_FAILURE`; a pre-authority external failure yields a `null`
 * behavior verdict with no checks and no record.
 */
export function executeCommandContext(
  declaration: CommandAuthorityDeclaration,
  input: CommandExecutionContextInput,
): CommandExecutionOutcome {
  const command = declaration.command;

  const authorityShape = validateConsumedAuthorityShape(input.commandAuthority);
  if (authorityShape !== null) {
    return refusal({
      command,
      preauthority: true,
      behaviorOutcome: null,
      finalOutcome: input.environmentFailure === true ? 'ENVIRONMENT_FAILURE' : 'HARNESS_BLOCKED',
      issues: [authorityShape],
    });
  }

  const result = evaluateCommandContext(declaration, {
    commandAuthority: input.commandAuthority,
    checks: input.checks,
    evidence: input.evidence,
    environmentFailure: input.environmentFailure,
    cleanupSucceeded: input.cleanupSucceeded,
  });

  if (!result.ok) {
    // The declaration or the supplied authority is not trustworthy: no check is
    // fabricated and no record is produced. The pre-authority external case
    // keeps a `null` behavior verdict; otherwise the behavior verdict is the
    // classifier's empty-authority `HARNESS_BLOCKED`.
    return refusal({
      command,
      preauthority: true,
      behaviorOutcome: result.outcome.behaviorOutcome,
      finalOutcome: result.outcome.finalOutcome,
      issues: [
        issue(
          'COMMAND_AUTHORITY_UNTRUSTWORTHY',
          `The ${command} command authority was not trustworthy: ${result.issues
            .map((entry) => entry.code)
            .join(', ')}.`,
        ),
      ],
      commandIssues: result.issues,
    });
  }

  const checkValidation = validateCommandExecutionChecks(declaration, result.checks);
  if (!checkValidation.ok) {
    return refusal({
      command,
      preauthority: false,
      behaviorOutcome: null,
      finalOutcome: 'HARNESS_BLOCKED',
      issues: checkValidation.issues,
      commandIssues: result.issues,
    });
  }

  const assembled = assembleFinalCommandRecordV4({
    commandAuthority: result.declaredAuthority,
    checks: result.checks,
  });
  if (!assembled.ok) {
    const primary = assembled.issues[0];
    return refusal({
      command,
      preauthority: false,
      behaviorOutcome: null,
      finalOutcome: 'HARNESS_BLOCKED',
      issues: [
        issue(
          'COMMAND_RECORD_ASSEMBLY_FAILED',
          primary === undefined
            ? 'Strict v4 command-record assembly failed.'
            : `${primary.code}: ${primary.detail}`,
        ),
      ],
      commandIssues: result.issues,
    });
  }

  const read = readFinalRecord(assembled.record);
  if (read.kind !== 'command-v4') {
    return refusal({
      command,
      preauthority: false,
      behaviorOutcome: null,
      finalOutcome: 'HARNESS_BLOCKED',
      issues: [
        issue(
          'COMMAND_RECORD_NOT_STRICT_V4',
          `The assembled command record classified as "${read.label}" rather than "command-v4".`,
        ),
      ],
      commandIssues: result.issues,
    });
  }

  return {
    command,
    authoritative: true,
    preauthority: false,
    behaviorOutcome: result.outcome.behaviorOutcome,
    finalOutcome: result.outcome.finalOutcome,
    requiredChecks: result.checks,
    unusableCheckIds: result.outcome.unusableCheckIds,
    failingCheckIds: result.outcome.failingCheckIds,
    record: read.record,
    issues: Object.freeze([]),
    commandIssues: Object.freeze([...result.issues]),
    diagnostics: Object.freeze([]),
  };
}
