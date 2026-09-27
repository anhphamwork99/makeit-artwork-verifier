import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { normalizeCaseRequest } from '../planner/normalize-intent';
import { loadCatalogueBundle } from '../catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../catalogue/suite';
import type {
  ExecutableManifestValidationContext,
  ExecutableSelectionManifestDraftV1,
} from '../contracts/executable-selection-manifest';
import type { CliResult } from '../contracts/runtime';
import type {
  QualificationFailureCode,
  QualificationRuntimeResult,
} from '../contracts/qualification-runtime';
import { buildCliResult, usageDiagnostic } from './output';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../runtime/environment';
import { resolveSkillRoot, resolveRepoRoot } from '../runtime/paths';
import {
  prepareQualificationBatch,
  runQualificationBatch,
  type QualificationRuntimeOptions,
} from '../governance/qualification-runtime';

const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;

export interface QualificationCommandDetails {
  readonly reportLabel: 'qualification-command.v1';
  readonly batchId: string | null;
  readonly batchFingerprint: string | null;
  readonly state: 'PREDECLARED' | 'REVIEW_READY' | 'FAILED' | 'INTERRUPTED' | null;
  readonly failureCode: QualificationFailureCode | null;
  readonly attempts: QualificationRuntimeResult['attempts'];
  readonly releaseCredit: false;
}

export interface QualificationCommandOptions {
  /** Harness-owned root/dependencies; never parsed from public CLI tokens. */
  readonly skillRoot?: string;
  readonly repoRoot?: string;
  readonly runtime?: QualificationRuntimeOptions;
  readonly loadContext?: () => ExecutableManifestValidationContext;
}

type Invocation =
  | {
      readonly action: 'prepare';
      readonly candidateFile: string;
      readonly entryIds: readonly string[];
      readonly rationale: string;
      readonly predecessorBatchId?: string;
      readonly correctionRationale?: string;
    }
  | { readonly action: 'run'; readonly batchId: string };

function parseInvocation(argv: readonly string[]): Invocation | null {
  if (argv.length === 0) return null;
  const [action, ...tokens] = argv;
  if (action === 'run') {
    if (tokens.length !== 2 || tokens[0] !== '--batch' || !tokens[1] || tokens[1].startsWith('--'))
      return null;
    return { action, batchId: tokens[1] as string };
  }
  if (action !== 'prepare') return null;
  let candidateFile: string | undefined;
  let rationale: string | undefined;
  let predecessorBatchId: string | undefined;
  let correctionRationale: string | undefined;
  const entryIds: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) return null;
    index += 1;
    switch (flag) {
      case '--candidate':
        if (candidateFile !== undefined) return null;
        candidateFile = value;
        break;
      case '--entry':
        entryIds.push(value);
        break;
      case '--rationale':
        if (rationale !== undefined) return null;
        rationale = value;
        break;
      case '--predecessor':
        if (predecessorBatchId !== undefined) return null;
        predecessorBatchId = value;
        break;
      case '--correction-rationale':
        if (correctionRationale !== undefined) return null;
        correctionRationale = value;
        break;
      default:
        return null;
    }
  }
  if (!candidateFile || entryIds.length !== 3 || !rationale) return null;
  if (new Set(entryIds).size !== 3) return null;
  if ((predecessorBatchId === undefined) !== (correctionRationale === undefined)) return null;
  if (correctionRationale !== undefined && correctionRationale.trim().length === 0) return null;
  return {
    action,
    candidateFile,
    entryIds,
    rationale,
    ...(predecessorBatchId === undefined ? {} : { predecessorBatchId }),
    ...(correctionRationale === undefined ? {} : { correctionRationale }),
  };
}

function usage(detail: string): CliResult<QualificationCommandDetails> {
  return buildCliResult({
    command: 'qualify',
    status: 'USAGE',
    detail,
    details: {
      reportLabel: 'qualification-command.v1',
      batchId: null,
      batchFingerprint: null,
      state: null,
      failureCode: null,
      attempts: [],
      releaseCredit: false,
    },
    diagnostics: [usageDiagnostic('Invalid qualification command arguments.')],
  });
}

function readCandidate(filePath: string, skillRoot: string): ExecutableSelectionManifestDraftV1 {
  if (filePath.split(/[\\/]+/).includes('..')) throw new Error('CANDIDATE_UNSAFE');
  const absolute = path.resolve(filePath);
  const parent = path.dirname(absolute);
  const draftsRoot = path.join(skillRoot, 'cases', 'selection-manifests', 'drafts');
  const relative = path.relative(draftsRoot, absolute);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  )
    throw new Error('CANDIDATE_UNSAFE');
  const draftsStat = lstatSync(draftsRoot);
  if (
    !draftsStat.isDirectory() ||
    draftsStat.isSymbolicLink() ||
    realpathSync(draftsRoot) !== draftsRoot
  )
    throw new Error('CANDIDATE_UNSAFE');
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent)
    throw new Error('CANDIDATE_UNSAFE');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_CANDIDATE_BYTES)
      throw new Error('CANDIDATE_UNSAFE');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      throw new Error('CANDIDATE_CHANGED');
    const value: unknown = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('CANDIDATE_INVALID');
    return value as ExecutableSelectionManifestDraftV1;
  } finally {
    closeSync(fd);
  }
}

function currentContext(root: string): ExecutableManifestValidationContext {
  const environmentCatalogue = loadEnvironmentCatalogue({ rootDir: root });
  const requestTemplates = resolveSuiteRequests(
    loadDiagnosticSuite('representative', { rootDir: root }),
  ).map((member) => {
    const normalized = normalizeCaseRequest(member.request);
    if (!normalized.ok) throw new Error('CANDIDATE_TEMPLATE_INVALID');
    const { intent } = normalized.request;
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

function failureCodeForPreparation(code: QualificationFailureCode): 'USAGE' | 'HARNESS_BLOCKED' {
  return code === 'ENTRY_SELECTION_INVALID' ? 'USAGE' : 'HARNESS_BLOCKED';
}

function runtimeStatus(result: QualificationRuntimeResult): {
  status: 'BUG' | 'HARNESS_BLOCKED';
  outcome: 'BUG' | null;
} {
  if (result.attempts.some((attempt) => attempt.outcome === 'BUG'))
    return { status: 'BUG', outcome: 'BUG' };
  return { status: 'HARNESS_BLOCKED', outcome: null };
}

export async function runQualificationCommand(
  argv: readonly string[],
  options: QualificationCommandOptions = {},
): Promise<CliResult<QualificationCommandDetails>> {
  const invocation = parseInvocation(argv);
  if (!invocation)
    return usage(
      'Expected qualify prepare with one candidate, three ordered entries and rationale, or qualify run --batch <id>.',
    );
  const skillRoot = options.skillRoot ?? realpathSync(resolveSkillRoot());
  const repoRoot = options.repoRoot ?? realpathSync(resolveRepoRoot());
  const loadContext = options.loadContext ?? (() => currentContext(skillRoot));
  const runtimeOptions: QualificationRuntimeOptions = {
    ...options.runtime,
    dependencies: {
      ...options.runtime?.dependencies,
      skillRoot,
      repoRoot,
      loadContext,
    },
  };
  if (invocation.action === 'prepare') {
    let draft: ExecutableSelectionManifestDraftV1;
    try {
      draft = readCandidate(invocation.candidateFile, skillRoot);
    } catch {
      return buildCliResult({
        command: 'qualify',
        subcommand: 'prepare',
        status: 'HARNESS_BLOCKED',
        detail: 'Qualification candidate could not be safely read.',
        details: {
          reportLabel: 'qualification-command.v1',
          batchId: null,
          batchFingerprint: null,
          state: 'FAILED',
          failureCode: 'CANDIDATE_INVALID',
          attempts: [],
          releaseCredit: false,
        },
      });
    }
    const prepared = prepareQualificationBatch(
      {
        draft,
        entryIds: invocation.entryIds,
        selectionRationale: invocation.rationale,
        ...(invocation.predecessorBatchId === undefined
          ? {}
          : { predecessorBatchId: invocation.predecessorBatchId }),
        ...(invocation.correctionRationale === undefined
          ? {}
          : { correctionRationale: invocation.correctionRationale }),
      },
      runtimeOptions,
    );
    if (!prepared.ok) {
      const status = failureCodeForPreparation(prepared.code);
      return buildCliResult({
        command: 'qualify',
        subcommand: 'prepare',
        status,
        detail: 'Qualification batch preparation refused.',
        details: {
          reportLabel: 'qualification-command.v1',
          batchId: null,
          batchFingerprint: null,
          state: 'FAILED',
          failureCode: prepared.code,
          attempts: [],
          releaseCredit: false,
        },
        ...(status === 'USAGE'
          ? { diagnostics: [usageDiagnostic('Invalid qualification entry selection.')] }
          : {}),
      });
    }
    return buildCliResult({
      command: 'qualify',
      subcommand: 'prepare',
      status: 'PASS',
      detail:
        'Qualification batch predeclared; no Qualification execution or Release credit has occurred.',
      details: {
        reportLabel: 'qualification-command.v1',
        batchId: prepared.batch.batchId,
        batchFingerprint: prepared.batch.batchFingerprint,
        state: 'PREDECLARED',
        failureCode: null,
        attempts: [],
        releaseCredit: false,
      },
    });
  }
  const result = await runQualificationBatch(invocation.batchId, runtimeOptions);
  if (!result) {
    return buildCliResult({
      command: 'qualify',
      subcommand: 'run',
      status: 'HARNESS_BLOCKED',
      detail: 'Qualification batch is missing, malformed, or already consumed.',
      details: {
        reportLabel: 'qualification-command.v1',
        batchId: invocation.batchId,
        batchFingerprint: null,
        state: 'FAILED',
        failureCode: 'LEDGER_INVALID',
        attempts: [],
        releaseCredit: false,
      },
    });
  }
  const details: QualificationCommandDetails = {
    reportLabel: 'qualification-command.v1',
    batchId: result.batchId,
    batchFingerprint: result.batchFingerprint,
    state: result.state,
    failureCode: result.failureCode,
    attempts: result.attempts,
    releaseCredit: false,
  };
  if (result.state === 'REVIEW_READY') {
    return buildCliResult({
      command: 'qualify',
      subcommand: 'run',
      status: 'PASS',
      detail:
        'Qualification batch reached REVIEW_READY; independent approval is still required and Release credit is false.',
      details,
    });
  }
  const mapped = runtimeStatus(result);
  return buildCliResult({
    command: 'qualify',
    subcommand: 'run',
    status: mapped.status,
    outcome: mapped.outcome,
    detail: 'Qualification batch did not reach REVIEW_READY.',
    details,
  });
}
