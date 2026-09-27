import { lstatSync, realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';

import { resolveAdapterImplementation } from '../adapters/registry';
import { loadCatalogueBundle } from '../catalogue/load';
import { resolveBindingFixture } from '../catalogue/fixtures';
import {
  loadDiagnosticSuite,
  resolveSuiteRequests,
  type LoadedDiagnosticSuite,
} from '../catalogue/suite';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { CliStatus, Outcome } from '../contracts/discriminants';
import type { CliResult } from '../contracts/runtime';
import {
  DiagnosticSuiteValidationError,
  type DiagnosticSuiteCaseV1,
  type PublicSuiteLineageV1,
} from '../contracts/suite';
import type { FinalSuiteAggregateStatus } from '../contracts/final-suite-record';
import { redactRecordText } from '../evidence/public-dto';
import {
  planFinalActivePathCase,
  runFinalSuiteActivePath,
  type FinalSuiteActivePathOutcome,
  type FinalSuiteAggregateContext,
  type FinalSuiteMemberInput,
} from '../orchestration/final-active-path';
import { prepareDiagnosticRun, type DiagnosticCliDetails } from './diagnostic';
import { resolveExecutionSupport } from '../planner/execution-support';
import { collectAppRevision, lockfileDigest } from '../runtime/environment-facts';
import { resolveAppRoot } from '../runtime/product-meaning-provider';
import {
  evidenceBaseDir,
  evidenceSuiteRoot,
  evidenceSuiteRootRelativePath,
  resolveEvidenceRoot,
} from '../runtime/evidence-root';
import { generateRunId } from '../runtime/run-id';
import { isSafeRunId, resolveRepoRoot, resolveSkillRoot } from '../runtime/paths';
import { resolveWorkflowSteps } from '../workflows/steps';
import { buildCliResult } from './output';

/**
 * `pnpm verify:artwork diagnostic --suite <suite-id>` (ADR 0019 R12–R14;
 * design §7; post-cutover current path, ADR 0032 §E3-S2, ADR 0033 §Suite).
 *
 * A thin sequential coordinator. It owns only its append-only aggregation
 * directory: it never starts a server, browser, port, or route handler of its
 * own and never signals or deletes a child resource. Every declared member is
 * one normal, independently allocated Diagnostic execution invoked through the
 * same in-process preparation path as `--case` — no shelling out, no console
 * parsing, no retries, and no rewriting of a child outcome.
 *
 * Each child hands its own atomic executor observation to the one final façade,
 * which classifies it, writes its strict-v4 child record, reads it back, and
 * assembles the v4-bound suite aggregate (schema version 2). This entry never
 * classifies, never reads a legacy suite/boolean authority, and never calls the
 * removed schema-v1 suite writer or aggregator.
 */

export interface SuiteChildSummary {
  order: number;
  caseId: string;
  request: string;
  expectedOutcome: 'PASS';
  runId: string;
  executionId: string;
  status: CliStatus;
  outcome: Outcome | null;
  /**
   * Sanitized durable-finalization refusal for this child. `null` means the
   * strict-v4 write either succeeded or no record was required.
   */
  finalizationError: string | null;
  /** The declared representative expectation was met by this child. */
  expectedMet: boolean;
  cleanupComplete: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface DiagnosticSuiteCliDetails {
  suiteExecutionId: string;
  suiteId: string;
  suiteVersion: number;
  suiteFingerprint: string;
  declaredCaseCount: number;
  executedCount: number;
  canonicalOrder: readonly number[];
  children: readonly SuiteChildSummary[];
  aggregateStatus: FinalSuiteAggregateStatus;
  complete: boolean;
  pass: boolean;
  stoppedEarly: boolean;
  stopReason: string | null;
  interrupted: boolean;
  suiteRecordPath: string | null;
  durationMs: number;
}

export interface RunDiagnosticSuiteInput {
  suiteId: string;
  /** Suite execution id override; must be a safe single path segment. */
  runId?: string;
  /**
   * Explicit, validated application root forwarded unchanged to every suite
   * child (ADR 0118). Each child refuses before allocation without it, and the
   * suite aggregate binds the same application revision/lockfile identity. An
   * unusable supplied root refuses the whole suite before the first child.
   */
  appRoot?: string;
  /** Test seam: the in-process per-child execution preparer. */
  runChild?: (input: {
    casePath: string;
    runId: string;
    /** Closed suite lineage carried into the child record before its write. */
    suiteLineage: PublicSuiteLineageV1;
  }) => ReturnType<typeof prepareDiagnosticRun>;
  /** Test seam: catalogue root override. */
  rootDir?: string;
  /** Legacy test seam for wall chronology, expressed as epoch milliseconds. */
  now?: () => number;
  /** Test seam: monotonic source used exclusively for elapsed duration. */
  monotonicNow?: () => number;
  /** Test seam: ISO wall chronology source; wall jumps never affect duration. */
  wallNow?: () => string;
  /** Test seam: an isolated full-suite aggregation leaf. */
  evidenceRoot?: string;
}

interface ValidatedSuiteMember {
  declaration: DiagnosticSuiteCaseV1;
  relativePath: string;
  absolutePath: string;
}

function suiteEvidenceRoot(suiteExecutionId: string): string {
  return evidenceSuiteRoot(evidenceBaseDir(), suiteExecutionId);
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function validateAggregationRoot(root: string): string | null {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root) {
    return 'Suite aggregation root must be a normalized absolute leaf path.';
  }
  const repoRoot = resolveRepoRoot();
  if (isWithinRoot(root, repoRoot) || isWithinRoot(root, resolveSkillRoot())) {
    return 'Suite aggregation root must be outside the repository and toolkit roots.';
  }
  const parent = path.dirname(root);
  try {
    if (realpathSync(parent) !== parent || !statSync(parent).isDirectory()) {
      return 'Suite aggregation parent must be an existing real directory.';
    }
  } catch {
    return 'Suite aggregation parent must be an existing real directory.';
  }
  return null;
}

/**
 * The shared suite-lineage identity: one stable value every member of one suite
 * execution agrees on verbatim. It is derived from the declaration and the
 * execution identity so it can never be aliased across suites.
 */
function suiteLineageIdentity(
  suiteId: string,
  suiteVersion: number,
  suiteExecutionId: string,
): string {
  return `${suiteId}@v${suiteVersion}#${suiteExecutionId}`;
}

function unlaunchedDetails(
  loaded: LoadedDiagnosticSuite | null,
  suiteExecutionId: string,
): DiagnosticSuiteCliDetails {
  return {
    suiteExecutionId,
    suiteId: loaded?.suite.suiteId ?? 'unknown',
    suiteVersion: loaded?.suite.version ?? 0,
    suiteFingerprint: loaded?.fingerprint ?? '',
    declaredCaseCount: loaded?.suite.cases.length ?? 0,
    executedCount: 0,
    canonicalOrder: loaded?.suite.cases.map((entry) => entry.order) ?? [],
    children: [],
    aggregateStatus: 'HARNESS_BLOCKED',
    complete: false,
    pass: false,
    stoppedEarly: false,
    stopReason: null,
    interrupted: false,
    suiteRecordPath: null,
    durationMs: 0,
  };
}

/**
 * Whole-suite pre-launch validation (design §7.2): the declaration, every
 * stable request, the planner resolution, the fixture, the declarative workflow
 * steps, and the delivered-runtime boundary are all resolved before child 1 can
 * allocate anything. Each member compiles its own exact envelope here; the
 * envelope is recompiled once more inside its own execution preparation.
 */
function validateSuite(
  loaded: LoadedDiagnosticSuite,
  appRoot?: string,
):
  | { ok: true; members: ValidatedSuiteMember[] }
  | {
      ok: false;
      status: 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE';
      diagnostics: readonly DiagnosticRecord[];
    } {
  let bundle: ReturnType<typeof loadCatalogueBundle>;
  try {
    bundle = loadCatalogueBundle();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 'HARNESS_BLOCKED',
      diagnostics: [createDiagnostic('CATALOGUE_UNAVAILABLE', detail)],
    };
  }

  let resolved: ReturnType<typeof resolveSuiteRequests>;
  try {
    resolved = resolveSuiteRequests(loaded);
  } catch (error) {
    if (error instanceof DiagnosticSuiteValidationError) {
      return {
        ok: false,
        status: 'HARNESS_BLOCKED',
        diagnostics: [createDiagnostic(error.code, error.message)],
      };
    }
    throw error;
  }

  const members: ValidatedSuiteMember[] = [];
  for (const entry of resolved) {
    const label = `order ${entry.declaration.order} (${entry.relativePath})`;
    const plan = planFinalActivePathCase(entry.request, bundle, appRoot);
    if (plan.status !== 'PLANNED') {
      const primary =
        plan.status === 'HARNESS_BLOCKED'
          ? plan.diagnostic
          : createDiagnostic(
              'DIAGNOSTIC_SUITE_INVALID',
              `Suite member ${label} could not be planned: ${plan.reason}`,
            );
      return {
        ok: false,
        status: plan.status,
        diagnostics: plan.findings.length > 0 ? plan.findings : [primary],
      };
    }
    if (plan.request.profile !== 'diagnostic') {
      return {
        ok: false,
        status: 'HARNESS_BLOCKED',
        diagnostics: [
          createDiagnostic(
            'DIAGNOSTIC_SUITE_INVALID',
            `Suite member ${label} declares profile "${plan.request.profile}"; a representative member must be a Diagnostic request.`,
          ),
        ],
      };
    }
    if (plan.caseId !== entry.declaration.caseId) {
      return {
        ok: false,
        status: 'HARNESS_BLOCKED',
        diagnostics: [
          createDiagnostic(
            'DIAGNOSTIC_SUITE_INVALID',
            `Suite member ${label} planned case identity does not match the declaration; the declaration is stale.`,
          ),
        ],
      };
    }

    const route = plan.materializedCase.route;
    const adapterResolution = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration: {
        adapterId: route.adapterId,
        compatibilityVersion: route.adapterCompatibilityVersion,
      },
    });
    if (!adapterResolution.ok) {
      return { ok: false, status: 'HARNESS_BLOCKED', diagnostics: [adapterResolution.finding] };
    }
    const fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: plan.materializedCase.intent.subjectId,
      capability: plan.materializedCase.intent.capability,
      scenarioId: plan.materializedCase.intent.scenario,
    });
    if (fixture === null) {
      return {
        ok: false,
        status: 'HARNESS_BLOCKED',
        diagnostics: [
          createDiagnostic(
            'FIXTURE_UNAVAILABLE',
            `Suite member ${label} has no delivered fixture binding.`,
          ),
        ],
      };
    }
    const stepEntry = resolveWorkflowSteps(bundle.workflowStepCatalogue, route.workflowId);
    if (stepEntry === null || stepEntry.steps.length === 0) {
      return {
        ok: false,
        status: 'HARNESS_BLOCKED',
        diagnostics: [
          createDiagnostic(
            'WORKFLOW_STEPS_UNAVAILABLE',
            `Suite member ${label} workflow "${route.workflowId}" declares no delivered declarative step.`,
          ),
        ],
      };
    }
    const executionSupport = resolveExecutionSupport(route.adapterId, route.workflowId);
    if (!executionSupport.supported) {
      return {
        ok: false,
        status: 'HARNESS_BLOCKED',
        diagnostics: [
          createDiagnostic('EXECUTION_NOT_YET_SUPPORTED', executionSupport.detail, {
            context: { adapterId: route.adapterId, workflowId: route.workflowId },
          }),
        ],
      };
    }

    members.push({
      declaration: entry.declaration,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
    });
  }
  return { ok: true, members };
}

export async function runDiagnosticSuiteCommand(
  input: RunDiagnosticSuiteInput,
): Promise<CliResult<DiagnosticSuiteCliDetails>> {
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const wallNow = input.wallNow ?? (() => new Date((input.now ?? Date.now)()).toISOString());
  let loaded: LoadedDiagnosticSuite | null = null;
  try {
    loaded = loadDiagnosticSuite(input.suiteId, {
      ...(input.rootDir === undefined ? {} : { rootDir: input.rootDir }),
    });
  } catch (error) {
    const code =
      error instanceof DiagnosticSuiteValidationError ? error.code : 'DIAGNOSTIC_SUITE_INVALID';
    const detail = error instanceof Error ? error.message : String(error);
    const suiteExecutionId = input.runId ?? `suite-${generateRunId()}`;
    return buildCliResult<DiagnosticSuiteCliDetails>({
      command: 'diagnostic',
      subcommand: input.suiteId,
      status: 'HARNESS_BLOCKED',
      detail,
      launchAttempted: false,
      details: unlaunchedDetails(loaded, suiteExecutionId),
      diagnostics: [createDiagnostic(code, detail)],
    });
  }

  const suiteExecutionId =
    input.runId ?? `${loaded.suite.suiteId}-v${loaded.suite.version}-${generateRunId()}`;
  if (!isSafeRunId(suiteExecutionId)) {
    const detail = `Suite execution id is not a safe path segment: ${suiteExecutionId}`;
    return buildCliResult<DiagnosticSuiteCliDetails>({
      command: 'diagnostic',
      subcommand: loaded.suite.suiteId,
      status: 'HARNESS_BLOCKED',
      detail,
      launchAttempted: false,
      details: unlaunchedDetails(loaded, suiteExecutionId),
      diagnostics: [createDiagnostic('DIAGNOSTIC_SUITE_INVALID', detail)],
    });
  }

  // The optional adapter-owned evidence root is validated before any child can
  // allocate or write: an invalid/relative/symlink value refuses the whole suite
  // as HARNESS_BLOCKED before the first child and before any evidence artifact.
  // An unset variable preserves the toolkit default exactly.
  const evidenceResolution = resolveEvidenceRoot();
  if (!evidenceResolution.ok) {
    const detail = `Suite evidence root is not usable: ${evidenceResolution.problem}`;
    return buildCliResult<DiagnosticSuiteCliDetails>({
      command: 'diagnostic',
      subcommand: loaded.suite.suiteId,
      status: 'HARNESS_BLOCKED',
      detail,
      launchAttempted: false,
      details: unlaunchedDetails(loaded, suiteExecutionId),
      diagnostics: [createDiagnostic('EVIDENCE_ROOT_ENV_INVALID', detail)],
    });
  }

  const resolvedAppRoot = input.appRoot === undefined ? null : resolveAppRoot(input.appRoot);
  if (resolvedAppRoot !== null && !resolvedAppRoot.ok) {
    const detail = `Suite application root is not usable for preflight: ${resolvedAppRoot.detail}`;
    return buildCliResult<DiagnosticSuiteCliDetails>({
      command: 'diagnostic',
      subcommand: loaded.suite.suiteId,
      status: 'HARNESS_BLOCKED',
      detail,
      launchAttempted: false,
      details: unlaunchedDetails(loaded, suiteExecutionId),
      diagnostics: [
        createDiagnostic('PRODUCT_MEANING_PROVIDER_UNAVAILABLE', detail, {
          context: { appRootCode: resolvedAppRoot.code },
        }),
      ],
    });
  }
  const appRootForRuns =
    resolvedAppRoot !== null && resolvedAppRoot.ok ? resolvedAppRoot.appRoot : undefined;

  const validation = validateSuite(loaded, appRootForRuns);
  if (!validation.ok) {
    const detail = `Representative suite "${loaded.suite.suiteId}" failed pre-launch validation; no child was launched.`;
    return buildCliResult<DiagnosticSuiteCliDetails>({
      command: 'diagnostic',
      subcommand: loaded.suite.suiteId,
      status: validation.status,
      detail,
      launchAttempted: false,
      ...(validation.status === 'ENVIRONMENT_FAILURE'
        ? { outcome: 'ENVIRONMENT_FAILURE' as const }
        : {}),
      details: unlaunchedDetails(loaded, suiteExecutionId),
      diagnostics: validation.diagnostics,
    });
  }

  const evidenceRoot = input.evidenceRoot ?? suiteEvidenceRoot(suiteExecutionId);
  const rootProblem =
    input.evidenceRoot === undefined ? null : validateAggregationRoot(evidenceRoot);
  if (rootProblem !== null) {
    return buildCliResult<DiagnosticSuiteCliDetails>({
      command: 'diagnostic',
      subcommand: loaded.suite.suiteId,
      status: 'HARNESS_BLOCKED',
      detail: rootProblem,
      launchAttempted: false,
      details: unlaunchedDetails(loaded, suiteExecutionId),
      diagnostics: [createDiagnostic('DIAGNOSTIC_SUITE_INVALID', rootProblem)],
    });
  }
  try {
    lstatSync(evidenceRoot);
    const detail =
      input.evidenceRoot === undefined
        ? `Suite aggregation directory already exists for execution id ${suiteExecutionId}; refusing to reuse it.`
        : 'Suite aggregation directory already exists; refusing to reuse it.';
    return buildCliResult<DiagnosticSuiteCliDetails>({
      command: 'diagnostic',
      subcommand: loaded.suite.suiteId,
      status: 'HARNESS_BLOCKED',
      detail,
      launchAttempted: false,
      details: unlaunchedDetails(loaded, suiteExecutionId),
      diagnostics: [createDiagnostic('DIAGNOSTIC_SUITE_INVALID', detail)],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const detail = 'Suite aggregation path could not be inspected safely.';
      return buildCliResult<DiagnosticSuiteCliDetails>({
        command: 'diagnostic',
        subcommand: loaded.suite.suiteId,
        status: 'HARNESS_BLOCKED',
        detail,
        launchAttempted: false,
        details: unlaunchedDetails(loaded, suiteExecutionId),
        diagnostics: [createDiagnostic('DIAGNOSTIC_SUITE_INVALID', detail)],
      });
    }
  }

  const runChild =
    input.runChild ??
    ((child) =>
      prepareDiagnosticRun({
        casePath: child.casePath,
        runId: child.runId,
        suiteLineage: child.suiteLineage,
        ...(appRootForRuns === undefined ? {} : { appRoot: appRootForRuns }),
      }));

  const suiteStartedAt = monotonicNow();
  const suiteWallStartedAt = wallNow();
  const members: FinalSuiteMemberInput[] = [];
  const children: SuiteChildSummary[] = [];
  const childDiagnostics: DiagnosticRecord[] = [];
  let stoppedEarly = false;
  let stopReason: string | null = null;
  let interrupted = false;
  let anyChildLaunched = false;

  for (const member of validation.members) {
    const childRunId = `${loaded.suite.suiteId}-v${loaded.suite.version}-c${member.declaration.order}-${generateRunId()}`;
    const startedAt = monotonicNow();
    const wallStartedAt = wallNow();
    // ADR 0019 R11: the child's lineage is populated from the validated suite
    // execution *before* the child writes anything, and is never appended or
    // rewritten afterwards.
    const suiteLineage: PublicSuiteLineageV1 = {
      suiteId: loaded.suite.suiteId,
      suiteVersion: loaded.suite.version,
      executionId: suiteExecutionId,
      order: member.declaration.order,
    };
    let preparation: Awaited<ReturnType<typeof prepareDiagnosticRun>>;
    try {
      preparation = await runChild({
        casePath: member.absolutePath,
        runId: childRunId,
        suiteLineage,
      });
    } catch (error) {
      interrupted = true;
      stopReason = `Suite child order ${member.declaration.order} could not be executed: ${(error as Error).message}`;
      break;
    }
    const endedAt = monotonicNow();
    const wallEndedAt = wallNow();

    if (!preparation.ok) {
      interrupted = true;
      stopReason = `Suite child order ${member.declaration.order} was refused before execution: ${preparation.detail}`;
      childDiagnostics.push(...preparation.diagnostics);
      break;
    }

    const facts = preparation.facts;
    anyChildLaunched = anyChildLaunched || facts.launch !== null;
    members.push({
      planning: facts.planning,
      prelaunch: facts.prelaunch,
      observation: facts.observation,
      runId: facts.runId,
      cleanupSucceeded: facts.cleanupSucceeded,
      externalFailure: facts.externalFailure,
      operational: facts.operational,
      durable: facts.durable,
      order: member.declaration.order,
      caseId: member.declaration.caseId,
      requestPath: member.relativePath,
      expectedOutcome: 'PASS',
      startedAt: wallStartedAt,
      endedAt: wallEndedAt,
      durationMs: endedAt - startedAt,
    });
    childDiagnostics.push(...facts.diagnostics);

    // Continue only after a provably complete child cleanup. An incomplete or
    // refused cleanup keeps its exact private recovery authority but can violate
    // ownership/isolation, so the next child must not start.
    if (!facts.cleanupSucceeded) {
      stoppedEarly = true;
      stopReason = `Suite child order ${member.declaration.order} did not complete exact cleanup; stopping before the next child.`;
      break;
    }
  }

  const suiteEndedAt = monotonicNow();
  const suiteWallEndedAt = wallNow();

  if (stoppedEarly || interrupted || members.length !== loaded.suite.cases.length) {
    childDiagnostics.push(
      createDiagnostic(
        'DIAGNOSTIC_SUITE_INCOMPLETE',
        stopReason ??
          `Suite execution ended after ${members.length} of ${loaded.suite.cases.length} declared children.`,
      ),
    );
  }

  // The suite candidate identity is the same explicit application root the
  // children ran against, so a representative result and its aggregate cannot
  // name different candidates. Evidence remains toolkit-owned.
  const repoRoot = appRootForRuns ?? resolveRepoRoot();
  const appRevision = collectAppRevision(repoRoot);
  const aggregate: FinalSuiteAggregateContext = {
    suiteExecutionId,
    suiteLineageId: suiteLineageIdentity(
      loaded.suite.suiteId,
      loaded.suite.version,
      suiteExecutionId,
    ),
    suiteFingerprint: loaded.fingerprint,
    repository: {
      commit: appRevision.commit,
      dirty: appRevision.dirty,
      lockfileDigest: lockfileDigest(repoRoot),
    },
    startedAt: suiteWallStartedAt,
    endedAt: suiteWallEndedAt,
    durationMs: suiteEndedAt - suiteStartedAt,
    ...(stopReason === null ? {} : { stopReason }),
  };

  const outcome: FinalSuiteActivePathOutcome = runFinalSuiteActivePath({
    suiteId: loaded.suite.suiteId,
    suiteVersion: loaded.suite.version,
    declaredCaseCount: loaded.suite.cases.length,
    members,
    interrupted,
    stoppedOnCleanup: stoppedEarly,
    aggregate,
    suiteDurable: {
      evidenceRoot,
      forbiddenPaths: [repoRoot, resolveSkillRoot(), os.tmpdir(), evidenceBaseDir()],
    },
  });

  // A child summary preserves that child's own delivered verdict verbatim; the
  // façade owns every classification and every durable write.
  members.forEach((member, index) => {
    const child = outcome.children[index];
    const details = child?.cli ?? null;
    children.push({
      order: member.order,
      caseId: member.caseId,
      request: member.requestPath,
      expectedOutcome: 'PASS',
      runId: member.runId,
      executionId: `${aggregate.suiteExecutionId}#${member.order}`,
      status: details?.status ?? 'HARNESS_BLOCKED',
      outcome: details?.outcome ?? null,
      finalizationError: redactRecordText(
        child?.durable.error ?? null,
        member.durable.forbiddenPaths ?? [],
      ),
      expectedMet: details?.status === member.expectedOutcome,
      cleanupComplete: member.cleanupSucceeded,
      startedAt: member.startedAt ?? aggregate.startedAt,
      endedAt: member.endedAt ?? aggregate.endedAt,
      durationMs: member.durationMs ?? 0,
    });
  });

  const aggregateStatus: FinalSuiteAggregateStatus =
    outcome.cli.details?.aggregateStatus ?? 'HARNESS_BLOCKED';
  const detailText = `Suite ${loaded.suite.suiteId}@${loaded.suite.version} (${suiteExecutionId}): ${children.length}/${loaded.suite.cases.length} children executed; aggregate ${outcome.finalOutcome}${stopReason === null ? '' : `; ${stopReason}`}.`;

  return buildCliResult<DiagnosticSuiteCliDetails>({
    command: 'diagnostic',
    subcommand: loaded.suite.suiteId,
    status: outcome.cli.status,
    outcome: outcome.finalOutcome,
    detail: detailText,
    launchAttempted: anyChildLaunched,
    details: {
      suiteExecutionId,
      suiteId: loaded.suite.suiteId,
      suiteVersion: loaded.suite.version,
      suiteFingerprint: loaded.fingerprint,
      declaredCaseCount: loaded.suite.cases.length,
      executedCount: children.length,
      canonicalOrder: loaded.suite.cases.map((entry) => entry.order),
      children,
      aggregateStatus,
      complete: outcome.cli.details?.complete ?? false,
      pass: outcome.cli.details?.pass ?? false,
      stoppedEarly,
      stopReason,
      interrupted,
      // Public output never carries the absolute adapter-owned evidence path.
      suiteRecordPath: outcome.suite.durable.wrote
        ? evidenceSuiteRootRelativePath(suiteExecutionId)
        : null,
      durationMs: suiteEndedAt - suiteStartedAt,
    },
    diagnostics: [...childDiagnostics, ...outcome.cli.diagnostics],
  });
}
