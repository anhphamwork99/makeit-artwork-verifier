import type { RetentionFailureCode } from '../contracts/budget-retention';
import type { CliResult } from '../contracts/runtime';
import { appendRetentionAudit } from '../governance/retention';
import { resolveToolkitRoot } from '../runtime/paths';
import { buildCliResult, usageDiagnostic } from './output';

export interface RetentionCommandOptions {
  /** Harness-owned root; never supplied by public command arguments. */
  readonly skillRoot?: string;
}

export interface RetentionCommandDetails {
  readonly reportLabel: 'retention-command.v1';
  readonly policy: 'PRESERVE_ALL';
  readonly auditId: string | null;
  readonly auditDigest: string | null;
  readonly snapshotDigest: string | null;
  readonly fileCount: number | null;
  readonly byteCount: number | null;
  readonly failureCode: RetentionFailureCode | 'ARGUMENTS_INVALID' | null;
  readonly releaseCredit: false;
}

export function runRetentionCommand(
  argv: readonly string[],
  options: RetentionCommandOptions = {},
): CliResult<RetentionCommandDetails> {
  const empty: RetentionCommandDetails = {
    reportLabel: 'retention-command.v1',
    policy: 'PRESERVE_ALL',
    auditId: null,
    auditDigest: null,
    snapshotDigest: null,
    fileCount: null,
    byteCount: null,
    failureCode: null,
    releaseCredit: false,
  };
  if (argv.length !== 1 || argv[0] !== 'audit') {
    return buildCliResult({
      command: 'retention',
      status: 'USAGE',
      detail: 'Expected retention audit without additional arguments.',
      diagnostics: [usageDiagnostic('Invalid retention command arguments.')],
      details: { ...empty, failureCode: 'ARGUMENTS_INVALID' },
    });
  }
  const result = appendRetentionAudit(options.skillRoot ?? resolveToolkitRoot());
  if (!result.ok) {
    return buildCliResult({
      command: 'retention',
      subcommand: 'audit',
      status: 'HARNESS_BLOCKED',
      detail: 'Retention audit refused; captured evidence remains preserved.',
      details: { ...empty, failureCode: result.code },
    });
  }
  return buildCliResult({
    command: 'retention',
    subcommand: 'audit',
    status: 'PASS',
    detail:
      'Preservation inventory appended. Artifact validity and measurement eligibility are unverified.',
    details: {
      ...empty,
      auditId: result.value.auditId,
      auditDigest: result.value.digest,
      snapshotDigest: result.value.snapshot.digest,
      fileCount: result.value.snapshot.totalFileCount,
      byteCount: result.value.snapshot.totalByteCount,
    },
  });
}
