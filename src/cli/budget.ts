import {
  BUDGET_MEASUREMENT_SET_ID_PATTERN,
  BUDGET_POLICY_ARTIFACT_ID_PATTERN,
  DIAGNOSTIC_CALIBRATION_ID_PATTERN,
  type BudgetMeasurementFailureCode,
  type CalibrationFailureCode,
} from '../contracts/budget-retention';
import { isQualificationBatchId } from '../contracts/qualification-runtime';
import type { CliResult } from '../contracts/runtime';
import {
  createFreshMeasurementSet,
  inspectBudgetPolicyProposal,
  prepareDiagnosticCalibration,
  runDiagnosticCalibration,
  verifyApprovedBudgetPolicy,
  verifyBudgetMeasurementSet,
  verifyDiagnosticCalibration,
  type BudgetPolicyProposalInspectionFailureCode,
  type BudgetPolicyVerificationFailureCode,
  type BudgetRuntimeOptions,
} from '../governance/budget';
import { buildCliResult, usageDiagnostic } from './output';

/**
 * Retention audit ids are governed by a private constant inside
 * `src/governance/retention.ts`. The CLI mirrors that closed shape only to fail
 * fast on a malformed/traversal-shaped locator before any service call; the
 * governance reader independently revalidates it.
 */
const RETENTION_AUDIT_ID_PATTERN = /^retention-[0-9a-f]{64}$/;

export interface BudgetCalibrationCommandDetails {
  readonly reportLabel: 'budget-calibration-command.v1';
  readonly calibrationId: string | null;
  readonly state: 'COMPLETE_ALL_PASS' | 'NON_CREDITABLE' | 'INTERRUPTED' | null;
  readonly completedCount: number;
  readonly workCount: number;
  readonly unstartedOrders: readonly number[];
  readonly failureCode: CalibrationFailureCode | 'ARGUMENTS_INVALID' | null;
  readonly releaseCredit: false;
}

export interface BudgetMeasureCommandDetails {
  readonly reportLabel: 'budget-measure-command.v1';
  readonly measurementSetId: string | null;
  readonly contentDigest: string | null;
  readonly calibrationId: string | null;
  readonly qualificationBatchId: string | null;
  readonly retentionAuditId: string | null;
  readonly failureCode: BudgetMeasurementFailureCode | 'ARGUMENTS_INVALID' | null;
  readonly releaseCredit: false;
}

export interface BudgetSetInspectCommandDetails {
  readonly reportLabel: 'budget-inspect-set-command.v1';
  readonly measurementSetId: string | null;
  readonly contentDigest: string | null;
  readonly calibrationId: string | null;
  readonly qualificationBatchId: string | null;
  readonly retentionAuditId: string | null;
  readonly manifestId: string | null;
  readonly requiredCellId: string | null;
  readonly failureCode: BudgetMeasurementFailureCode | 'ARGUMENTS_INVALID' | null;
  readonly releaseCredit: false;
}

export interface BudgetProposalInspectCommandDetails {
  readonly reportLabel: 'budget-inspect-proposal-command.v1';
  readonly state: 'PROPOSED_NOT_APPROVED' | null;
  readonly decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED' | null;
  readonly proposalId: string | null;
  readonly proposalDigest: string | null;
  readonly measurementSetId: string | null;
  readonly retentionAuditId: string | null;
  readonly failureCode: BudgetPolicyProposalInspectionFailureCode | 'ARGUMENTS_INVALID' | null;
  readonly releaseCredit: false;
}

export interface BudgetApprovedInspectCommandDetails {
  readonly reportLabel: 'budget-inspect-approved-command.v1';
  readonly decision: 'POLICY_VERIFIED_NON_CREDITABLE' | null;
  readonly approvalId: string | null;
  readonly approvalDigest: string | null;
  readonly proposalId: string | null;
  readonly measurementSetId: string | null;
  readonly failureCode: BudgetPolicyVerificationFailureCode | 'ARGUMENTS_INVALID' | null;
  readonly releaseCredit: false;
}

export interface BudgetUsageCommandDetails {
  readonly reportLabel: 'budget-command.v1';
  readonly failureCode: 'ARGUMENTS_INVALID';
  readonly releaseCredit: false;
}

/** Every `budget` invocation reports exactly one of these sanitized shapes. */
export type BudgetCommandDetails =
  | BudgetCalibrationCommandDetails
  | BudgetMeasureCommandDetails
  | BudgetSetInspectCommandDetails
  | BudgetProposalInspectCommandDetails
  | BudgetApprovedInspectCommandDetails
  | BudgetUsageCommandDetails;

export interface BudgetCommandOptions {
  /** Harness-controlled dependencies; public CLI arguments never select an evidence root. */
  readonly runtime?: BudgetRuntimeOptions;
}

/** Sanitized, stable usage envelope shared by every refused budget invocation. */
function budgetUsage(
  subcommand: string | null,
  detail: string,
  details: BudgetCommandDetails,
): CliResult<BudgetCommandDetails> {
  return buildCliResult<BudgetCommandDetails>({
    command: 'budget',
    subcommand,
    status: 'USAGE',
    detail,
    diagnostics: [usageDiagnostic(detail)],
    details,
  });
}

/** Pre-activation, no-credit calibration. Top-level routing is registered in WP6. */
export async function runBudgetCalibrationCommand(
  argv: readonly string[],
  options: BudgetCommandOptions = {},
): Promise<CliResult<BudgetCalibrationCommandDetails>> {
  const empty: BudgetCalibrationCommandDetails = {
    reportLabel: 'budget-calibration-command.v1',
    calibrationId: null,
    state: null,
    completedCount: 0,
    workCount: 0,
    unstartedOrders: [],
    failureCode: null,
    releaseCredit: false,
  };
  if (
    argv.length !== 3 ||
    argv[0] !== 'calibrate' ||
    argv[1] !== '--manifest' ||
    !argv[2] ||
    argv[2].startsWith('--')
  ) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'calibrate',
      status: 'USAGE',
      detail: 'Expected budget calibrate --manifest <draft-path>.',
      details: { ...empty, failureCode: 'ARGUMENTS_INVALID' },
      diagnostics: [usageDiagnostic('Invalid budget calibration arguments.')],
    });
  }
  const prepared = prepareDiagnosticCalibration({ draftFile: argv[2] }, options.runtime);
  if (!prepared.ok) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'calibrate',
      status: 'HARNESS_BLOCKED',
      detail: 'Calibration preflight refused; no work allocated.',
      details: { ...empty, failureCode: prepared.code },
    });
  }
  const result = await runDiagnosticCalibration(prepared.value, options.runtime);
  if (!result.ok) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'calibrate',
      status: 'HARNESS_BLOCKED',
      detail: 'Calibration execution refused; inspect preserved attempt.',
      details: {
        ...empty,
        calibrationId: prepared.value.calibration.calibrationId,
        failureCode: result.code,
      },
    });
  }
  const verified = verifyDiagnosticCalibration(result.value.calibrationId, options.runtime);
  const complete = verified.ok && verified.value.state === 'COMPLETE_ALL_PASS';
  return buildCliResult({
    command: 'budget',
    subcommand: 'calibrate',
    status: complete ? 'PASS' : 'HARNESS_BLOCKED',
    detail: complete
      ? 'Complete strict Diagnostic calibration verified; no Release credit or budget approval.'
      : 'Calibration is preserved but not eligible for a measurement set.',
    details: {
      ...empty,
      calibrationId: result.value.calibrationId,
      state: result.value.state,
      completedCount: result.value.completedCount,
      workCount: result.value.workCount,
      unstartedOrders: result.value.unstartedOrders,
      failureCode: verified.ok ? null : verified.code,
    },
  });
}

/** Exact `budget measure --calibration <id> --qualification <id> --retention <id>`. */
function runBudgetMeasureCommand(
  argv: readonly string[],
  options: BudgetCommandOptions,
): CliResult<BudgetMeasureCommandDetails> {
  const empty: BudgetMeasureCommandDetails = {
    reportLabel: 'budget-measure-command.v1',
    measurementSetId: null,
    contentDigest: null,
    calibrationId: null,
    qualificationBatchId: null,
    retentionAuditId: null,
    failureCode: null,
    releaseCredit: false,
  };
  const invalid =
    argv.length !== 7 ||
    argv[0] !== 'measure' ||
    argv[1] !== '--calibration' ||
    !argv[2] ||
    argv[3] !== '--qualification' ||
    !argv[4] ||
    argv[5] !== '--retention' ||
    !argv[6] ||
    !DIAGNOSTIC_CALIBRATION_ID_PATTERN.test(argv[2]) ||
    !isQualificationBatchId(argv[4]) ||
    !RETENTION_AUDIT_ID_PATTERN.test(argv[6]);
  if (invalid) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'measure',
      status: 'USAGE',
      detail:
        'Expected budget measure --calibration <id> --qualification <id> --retention <id> exactly once each.',
      diagnostics: [usageDiagnostic('Invalid budget measurement arguments.')],
      details: { ...empty, failureCode: 'ARGUMENTS_INVALID' },
    });
  }
  const result = createFreshMeasurementSet(
    {
      calibrationId: argv[2],
      qualificationBatchId: argv[4],
      retentionAuditId: argv[6],
    },
    options.runtime,
  );
  if (!result.ok) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'measure',
      status: 'HARNESS_BLOCKED',
      detail: 'Measurement set refused; no record appended.',
      details: {
        ...empty,
        calibrationId: argv[2],
        qualificationBatchId: argv[4],
        retentionAuditId: argv[6],
        failureCode: result.code,
      },
    });
  }
  return buildCliResult({
    command: 'budget',
    subcommand: 'measure',
    status: 'PASS',
    detail: 'Immutable no-credit measurement set appended from freshly verified current lineage.',
    details: {
      ...empty,
      measurementSetId: result.value.measurementSetId,
      contentDigest: result.value.contentDigest,
      calibrationId: argv[2],
      qualificationBatchId: argv[4],
      retentionAuditId: argv[6],
    },
  });
}

/** Exact `budget inspect --set <measurement-set-id>`. */
function inspectMeasurementSet(
  id: string,
  options: BudgetCommandOptions,
): CliResult<BudgetSetInspectCommandDetails> {
  const empty: BudgetSetInspectCommandDetails = {
    reportLabel: 'budget-inspect-set-command.v1',
    measurementSetId: null,
    contentDigest: null,
    calibrationId: null,
    qualificationBatchId: null,
    retentionAuditId: null,
    manifestId: null,
    requiredCellId: null,
    failureCode: null,
    releaseCredit: false,
  };
  if (!BUDGET_MEASUREMENT_SET_ID_PATTERN.test(id)) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'inspect',
      status: 'USAGE',
      detail: 'Expected budget inspect --set <measurement-set-id>.',
      diagnostics: [usageDiagnostic('Invalid budget measurement-set id.')],
      details: { ...empty, failureCode: 'ARGUMENTS_INVALID' },
    });
  }
  const result = verifyBudgetMeasurementSet(id, options.runtime);
  if (!result.ok) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'inspect',
      status: 'HARNESS_BLOCKED',
      detail: 'Measurement set did not verify against current lineage.',
      details: { ...empty, measurementSetId: id, failureCode: result.code },
    });
  }
  return buildCliResult({
    command: 'budget',
    subcommand: 'inspect',
    status: 'PASS',
    detail: 'Measurement set reverified against current verified lineage; no Release credit.',
    details: {
      ...empty,
      measurementSetId: result.value.measurementSetId,
      contentDigest: result.value.contentDigest,
      calibrationId: result.value.content.calibrationId,
      qualificationBatchId: result.value.content.qualificationBatchId,
      retentionAuditId: result.value.content.retentionAuditId,
      manifestId: result.value.content.manifestId,
      requiredCellId: result.value.content.requiredCellId,
    },
  });
}

/** Exact `budget inspect --proposal <proposal-id>`. */
function inspectProposal(
  id: string,
  options: BudgetCommandOptions,
): CliResult<BudgetProposalInspectCommandDetails> {
  const empty: BudgetProposalInspectCommandDetails = {
    reportLabel: 'budget-inspect-proposal-command.v1',
    state: null,
    decision: null,
    proposalId: null,
    proposalDigest: null,
    measurementSetId: null,
    retentionAuditId: null,
    failureCode: null,
    releaseCredit: false,
  };
  if (!BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(id)) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'inspect',
      status: 'USAGE',
      detail: 'Expected budget inspect --proposal <proposal-id>.',
      diagnostics: [usageDiagnostic('Invalid budget-policy proposal id.')],
      details: { ...empty, failureCode: 'ARGUMENTS_INVALID' },
    });
  }
  const result = inspectBudgetPolicyProposal(id, options.runtime);
  if (!result.ok) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'inspect',
      status: 'HARNESS_BLOCKED',
      detail: 'Proposal inspection refused; no approval or credit is claimed.',
      details: { ...empty, proposalId: id, failureCode: result.code },
    });
  }
  return buildCliResult({
    command: 'budget',
    subcommand: 'inspect',
    status: 'PASS',
    detail: 'Proposal is feasible against current lineage; it is explicitly not approved.',
    details: {
      ...empty,
      state: result.state,
      decision: result.decision,
      proposalId: result.proposalId,
      proposalDigest: result.proposalDigest,
      measurementSetId: result.measurementSetId,
      retentionAuditId: result.retentionAuditId,
    },
  });
}

/** Exact `budget inspect --approved <approval-id>` with the refusing default root. */
function inspectApproved(
  id: string,
  options: BudgetCommandOptions,
): CliResult<BudgetApprovedInspectCommandDetails> {
  const empty: BudgetApprovedInspectCommandDetails = {
    reportLabel: 'budget-inspect-approved-command.v1',
    decision: null,
    approvalId: null,
    approvalDigest: null,
    proposalId: null,
    measurementSetId: null,
    failureCode: null,
    releaseCredit: false,
  };
  if (!BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(id)) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'inspect',
      status: 'USAGE',
      detail: 'Expected budget inspect --approved <approval-id>.',
      diagnostics: [usageDiagnostic('Invalid budget-policy approval id.')],
      details: { ...empty, failureCode: 'ARGUMENTS_INVALID' },
    });
  }
  // The production runner supplies no independent authority provider: this
  // refuses `AUTHORITY_UNATTESTED` even when canonical artifacts exist, and it
  // can never inject a root, attestation or credit through argv or options.
  const result = verifyApprovedBudgetPolicy(id, options.runtime);
  if (!result.ok) {
    return buildCliResult({
      command: 'budget',
      subcommand: 'inspect',
      status: 'HARNESS_BLOCKED',
      detail: 'Approved policy is not attested by an independent authority; no credit claimed.',
      details: { ...empty, approvalId: id, failureCode: result.code },
    });
  }
  return buildCliResult({
    command: 'budget',
    subcommand: 'inspect',
    status: 'PASS',
    detail: 'Approved policy verified against current lineage; still no Release execution credit.',
    details: {
      ...empty,
      decision: result.decision,
      approvalId: result.approvalId,
      approvalDigest: result.approvalDigest,
      proposalId: result.proposalId,
      measurementSetId: result.measurementSetId,
    },
  });
}

/** Exact `budget inspect` selector. One and only one selector is accepted. */
function runBudgetInspectCommand(
  argv: readonly string[],
  options: BudgetCommandOptions,
): CliResult<BudgetCommandDetails> {
  if (argv.length !== 3 || !argv[2]) {
    return budgetUsage(
      'inspect',
      'Expected budget inspect with exactly one of --set, --proposal or --approved and its id.',
      {
        reportLabel: 'budget-command.v1',
        failureCode: 'ARGUMENTS_INVALID',
        releaseCredit: false,
      },
    );
  }
  const selector = argv[1];
  const id = argv[2];
  if (selector === '--set') return inspectMeasurementSet(id, options);
  if (selector === '--proposal') return inspectProposal(id, options);
  if (selector === '--approved') return inspectApproved(id, options);
  return budgetUsage(
    'inspect',
    'Expected budget inspect with exactly one of --set, --proposal or --approved and its id.',
    {
      reportLabel: 'budget-command.v1',
      failureCode: 'ARGUMENTS_INVALID',
      releaseCredit: false,
    },
  );
}

/**
 * Stable `budget` route. The raw argv is matched strictly (exact token
 * sequence) so unknown keys, duplicates, extra tokens, reordering, missing
 * values and malformed/traversal-shaped ids refuse as `USAGE` before any
 * service call or filesystem write. No argument can select a root, evidence
 * path, authority provider or credit.
 */
export async function runBudgetCommand(
  argv: readonly string[],
  options: BudgetCommandOptions = {},
): Promise<CliResult<BudgetCommandDetails>> {
  if (argv[0] === 'calibrate') return runBudgetCalibrationCommand(argv, options);
  if (argv[0] === 'measure') return runBudgetMeasureCommand(argv, options);
  if (argv[0] === 'inspect') return runBudgetInspectCommand(argv, options);
  const subcommand = argv[0] ?? null;
  return budgetUsage(
    subcommand,
    'Expected budget calibrate|measure|inspect with its exact arguments.',
    {
      reportLabel: 'budget-command.v1',
      failureCode: 'ARGUMENTS_INVALID',
      releaseCredit: false,
    },
  );
}
