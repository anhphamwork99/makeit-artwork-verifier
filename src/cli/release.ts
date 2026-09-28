import path from 'node:path';

import { normalizeCaseRequest } from '../planner/normalize-intent';
import { loadCatalogueBundle } from '../catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../catalogue/suite';
import type { ExecutableManifestValidationContext } from '../contracts/executable-selection-manifest';
import type { CliResult } from '../contracts/runtime';
import type { ReleaseRuntimeFailureCode } from '../contracts/release-runtime';
import { buildCliResult, usageDiagnostic } from './output';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../runtime/environment';
import { resolveRepoRoot, resolveToolkitRoot } from '../runtime/paths';
import {
  activateRelease,
  runRelease,
  type ReleaseRuntimeOptions,
} from '../governance/release-runtime';
import { verifyQualificationBatch } from '../governance/qualification-runtime';

export interface ReleaseCommandOptions {
  readonly skillRoot?: string;
  readonly repoRoot?: string;
  readonly loadContext?: () => ExecutableManifestValidationContext;
  readonly runtime?: ReleaseRuntimeOptions;
}

export interface ReleaseCommandDetails {
  readonly reportLabel: 'release-command.v1';
  readonly action: 'activate' | 'run' | null;
  readonly failureCode: ReleaseRuntimeFailureCode | null;
  readonly manifestId: string | null;
  readonly manifestFingerprint: string | null;
  readonly runId: string | null;
  readonly state: string | null;
  readonly releaseCreditGranted: boolean;
  readonly workCount: number;
  readonly exclusions: readonly unknown[];
  readonly lostObligationsByBinding: readonly unknown[];
}

type Invocation =
  | {
      readonly action: 'activate';
      readonly manifestFile: string;
      readonly batchId: string;
      readonly approvalId: string;
    }
  | { readonly action: 'run'; readonly manifestFile: string };

/** Exact raw token grammar: no aliases, duplicates, options or trailing values. */
function parse(argv: readonly string[]): Invocation | null {
  if (
    argv[0] === 'run' &&
    argv.length === 3 &&
    argv[1] === '--manifest' &&
    argv[2] &&
    !argv[2].startsWith('--')
  )
    return { action: 'run', manifestFile: argv[2] as string };
  if (
    argv[0] === 'activate' &&
    argv.length === 7 &&
    argv[1] === '--manifest' &&
    argv[2] &&
    argv[3] === '--batch' &&
    argv[4] &&
    argv[5] === '--approval' &&
    argv[6] &&
    !argv[2].startsWith('--') &&
    !argv[4].startsWith('--') &&
    !argv[6].startsWith('--')
  )
    return {
      action: 'activate',
      manifestFile: argv[2] as string,
      batchId: argv[4] as string,
      approvalId: argv[6] as string,
    };
  return null;
}

function currentContext(root: string): ExecutableManifestValidationContext {
  const environmentCatalogue = loadEnvironmentCatalogue({ rootDir: root });
  const requestTemplates = resolveSuiteRequests(
    loadDiagnosticSuite('representative', { rootDir: root }),
  ).map((member) => {
    const normalized = normalizeCaseRequest(member.request);
    if (!normalized.ok) throw new Error('TEMPLATE_INVALID');
    const intent = normalized.request.intent;
    return {
      templateId: path.basename(member.relativePath, '.json'),
      subjectId: intent.subjectId,
      capability: intent.capability,
      scenarioId: intent.scenario,
      intent,
    };
  });
  return {
    catalogues: loadCatalogueBundle({ rootDir: root }),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates,
  };
}

function makeRuntime(
  options: ReleaseCommandOptions,
  skillRoot: string,
  repoRoot: string,
  loadContext: () => ExecutableManifestValidationContext,
): ReleaseRuntimeOptions {
  const configured = options.runtime ?? {};
  return {
    ...configured,
    dependencies: {
      ...configured.dependencies,
      skillRoot,
      repoRoot,
      loadContext,
      verifyQualification: (batchId) =>
        verifyQualificationBatch(batchId, {
          dependencies: { ...configured.dependencies, skillRoot, repoRoot, loadContext },
        }),
    },
  };
}

function baseDetails(
  action: ReleaseCommandDetails['action'],
  failureCode: ReleaseRuntimeFailureCode | null = null,
): ReleaseCommandDetails {
  return {
    reportLabel: 'release-command.v1',
    action,
    failureCode,
    manifestId: null,
    manifestFingerprint: null,
    runId: null,
    state: null,
    releaseCreditGranted: false,
    workCount: 0,
    exclusions: [],
    lostObligationsByBinding: [],
  };
}

function usage(detail: string): CliResult<ReleaseCommandDetails> {
  return buildCliResult({
    command: 'release',
    status: 'USAGE',
    detail,
    details: baseDetails(null, 'ARGUMENTS_INVALID'),
    diagnostics: [usageDiagnostic('Invalid release command arguments.')],
  });
}

export async function runReleaseCommand(
  argv: readonly string[],
  options: ReleaseCommandOptions = {},
): Promise<CliResult<ReleaseCommandDetails>> {
  const invocation = parse(argv);
  if (!invocation)
    return usage(
      'Expected release activate --manifest <draft.json> --batch <id> --approval <id>, or release run --manifest <draft.json>.',
    );
  try {
    const skillRoot = options.skillRoot ?? resolveToolkitRoot();
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    const loadContext = options.loadContext ?? (() => currentContext(skillRoot));
    const runtime = makeRuntime(options, skillRoot, repoRoot, loadContext);
    if (invocation.action === 'activate') {
      const result = activateRelease(invocation, runtime);
      if (!result.ok)
        return buildCliResult({
          command: 'release',
          subcommand: 'activate',
          status: 'HARNESS_BLOCKED',
          detail: 'Release activation refused; no Release allocation was attempted.',
          details: baseDetails('activate', result.code),
        });
      return buildCliResult({
        command: 'release',
        subcommand: 'activate',
        status: 'PASS',
        detail: 'Exact approved candidate activated; no Release instances were allocated.',
        details: {
          ...baseDetails('activate'),
          manifestId: result.value.manifestId,
          manifestFingerprint: result.value.manifestFingerprint,
          state: 'ACTIVE',
          workCount: result.value.workCount,
          exclusions: result.value.exclusions,
          lostObligationsByBinding: result.value.lostObligationsByBinding,
        },
      });
    }
    const result = await runRelease(invocation, runtime);
    if (!result.ok)
      return buildCliResult({
        command: 'release',
        subcommand: 'run',
        status: 'HARNESS_BLOCKED',
        detail: 'Release run refused before execution or could not be verified.',
        details: baseDetails('run', result.code),
      });
    const value = result.value;
    const pass = value.state === 'COMPLETE_ALL_PASS' && value.releaseCreditGranted;
    return buildCliResult({
      command: 'release',
      subcommand: 'run',
      status: pass ? 'PASS' : 'HARNESS_BLOCKED',
      detail: pass
        ? 'Every approved Release work item passed with verified evidence and cleanup.'
        : 'Release completed without credit; inspect the persisted structured run record.',
      details: {
        ...baseDetails('run'),
        runId: value.runId,
        manifestId: value.manifestId,
        manifestFingerprint: value.manifestFingerprint,
        state: value.state,
        releaseCreditGranted: value.releaseCreditGranted,
        workCount: value.workCount,
        exclusions: value.exclusions,
        lostObligationsByBinding: value.lostObligationsByBinding,
      },
    });
  } catch {
    return buildCliResult({
      command: 'release',
      subcommand: invocation.action,
      status: 'HARNESS_BLOCKED',
      detail: 'Release command failed closed.',
      details: baseDetails(invocation.action, 'CANDIDATE_INVALID'),
    });
  }
}
