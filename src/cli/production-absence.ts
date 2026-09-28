import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  adaptProductionAbsenceCommandFacts,
  type ProductionAbsenceCommandDeclarationView,
} from '../adapters/production-absence-command-live-facts';
import { allocateRun, allocationFailureCliStatus } from '../allocation/allocate';
import { admitCase, releaseCase } from '../allocation/lease';
import {
  projectProductionAbsenceRawCommandFacts,
  proveProductionAbsenceInBrowser,
  type ProductionAbsenceBrowserProof,
} from '../browser/production-absence';
import { cleanupRun } from '../cleanup/cleanup';
import {
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
} from '../commands/production-absence-command-context';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { CliStatus, Outcome } from '../contracts/discriminants';
import {
  PRODUCTION_ABSENCE_ROUTE,
  evaluateProductionAbsence,
  productionAbsenceDiagnostic,
  type ProductionAbsenceVerdict,
  type ProductionArtifactScan,
} from '../contracts/production-absence';
import type { CliResult, CleanupResult, RunAllocation } from '../contracts/runtime';
import { sensitiveGuardPaths, type CleanupAuthoritySnapshot } from '../evidence/cleanup-authority';
import {
  capturePrivateSnapshots,
  OPTIONAL_PNG_MAX_BYTES,
  type PrivateSnapshotCollection,
} from '../evidence/private-snapshot';
import {
  buildCleanupProjection,
  buildNotEstablishedOwnership,
  buildPublicLaunchFacts,
  redactDiagnostics,
  redactRecordText,
  sensitiveRootsOf,
  type PublicOwnershipProjection,
} from '../evidence/public-dto';
import type { CommandExecutionContextInput } from '../orchestration/command-execution';
import { runFinalProductionAbsenceActivePath } from '../orchestration/final-active-path';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../runtime/environment';
import { runOwnedProductionServer, type ProductionRunResult } from '../runtime/production-server';
import { generateRunId } from '../runtime/run-id';
import { scanProductionArtifacts } from '../runtime/static-scan';
import { buildCliResult } from './output';
import { setActiveRun } from './termination';

/**
 * `pnpm verify:artwork production-absence` (TS-2/TS-3, Gate C; post-cutover
 * current path, ADR 0032 §E3-S2, ADR 0031 §3).
 *
 * Builds a hostile production artifact (`NEXT_PUBLIC_ARTWORK_VERIFICATION=true`,
 * `NEXT_PUBLIC_MOCK_API=true`, forced `NODE_ENV=production`) into the run's own
 * `distDir`, serves it with `next start`, and proves the observation and setup
 * seams are absent from both the emitted output and the live production
 * document — on first load and after a reload. Every terminal path cleans up the
 * owned process, port, `distDir`, and scratch root, restores the shared config
 * byte-exactly, and preserves evidence.
 *
 * The raw artifact-scan, initial/reload browser-observation, hydration, and
 * requested-chunk reconciliation facts are mapped through the command live-fact
 * adapter onto the accepted B1-G production-absence declaration, and the current
 * final façade classifies the three-state command checks and writes the
 * strict-v4 command record. This entry owns operational facts only — allocation,
 * build, launch, ownership, cleanup, repository identity, and the explicit
 * durable sink. It never classifies a result, never reads a legacy boolean
 * `passed` check or `harnessInvalid` side channel, and never writes a legacy
 * command bundle.
 */

/** The closed production-absence declaration view the command adapter is bound to. */
const PRODUCTION_ABSENCE_COMMAND_DECLARATION: ProductionAbsenceCommandDeclarationView =
  Object.freeze({
    authority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    requiredCheckIds: Object.freeze(
      PRODUCTION_ABSENCE_COMMAND_CHECKS.map((check) => check.checkId),
    ),
    requiredEvidenceIds: Object.freeze([...PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE]),
    diagnosticEvidenceIds: Object.freeze([...PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE]),
  });

export interface ProductionAbsenceCliDetails {
  runId: string;
  allocation: RunAllocation | null;
  production: {
    buildMs: number;
    readinessMs: number;
    pid: number;
    processGroupId: number;
    buildLogPath: string;
    serverLogPath: string;
  } | null;
  scan: ProductionArtifactScan | null;
  chunkReconciliation: { resolved: number; unresolved: readonly string[] } | null;
  browser: ProductionAbsenceBrowserProof | null;
  absence: ProductionAbsenceVerdict | null;
  /** Three-state command check statuses; never a legacy boolean `passed`. */
  requiredChecks: readonly { checkId: string; status: string }[];
  /** Closed orchestration refusal codes; empty on a trustworthy command. */
  issues: readonly string[];
  behaviorOutcome: Outcome | null;
  cleanup: CleanupResult | null;
  finalOutcome: Outcome | null;
  evidenceRoot: string | null;
  runRecordPath: string | null;
  /** True only when the declaration and the consumed authority were trustworthy. */
  authoritative: boolean;
}

export interface RunProductionAbsenceCommandInput {
  runId?: string;
  buildDeadlineMs?: number;
  startDeadlineMs?: number;
  /** Diagnostic override only; production always removes the owned distDir. */
  keepDistDir?: boolean;
}

/**
 * Maps each requested `/`_next/static/.../*.js` chunk URL to its emitted file in
 * the owned `distDir` and reports any chunk that is not an emitted artifact.
 * Combined with the marker scan this makes the "no verification chunk request"
 * claim non-vacuous for content-hashed chunk names.
 */
export function reconcileRequestedChunks(
  staticChunks: readonly string[],
  distDir: string,
): { resolved: number; unresolved: readonly string[] } {
  const unresolved: string[] = [];
  let resolved = 0;
  for (const url of staticChunks) {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      unresolved.push(url);
      continue;
    }
    const prefix = '/_next/';
    if (!pathname.startsWith(prefix)) {
      unresolved.push(url);
      continue;
    }
    const relative = pathname.slice(prefix.length);
    if (existsSync(path.join(distDir, relative))) resolved += 1;
    else unresolved.push(url);
  }
  return { resolved, unresolved };
}

function details(input: Partial<ProductionAbsenceCliDetails>): ProductionAbsenceCliDetails {
  return {
    runId: input.runId ?? '',
    allocation: input.allocation ?? null,
    production: input.production ?? null,
    scan: input.scan ?? null,
    chunkReconciliation: input.chunkReconciliation ?? null,
    browser: input.browser ?? null,
    absence: input.absence ?? null,
    requiredChecks: input.requiredChecks ?? [],
    issues: input.issues ?? [],
    behaviorOutcome: input.behaviorOutcome ?? null,
    cleanup: input.cleanup ?? null,
    finalOutcome: input.finalOutcome ?? null,
    evidenceRoot: input.evidenceRoot ?? null,
    runRecordPath: input.runRecordPath ?? null,
    authoritative: input.authoritative ?? false,
  };
}

export async function runProductionAbsenceCommand(
  input: RunProductionAbsenceCommandInput = {},
): Promise<CliResult<ProductionAbsenceCliDetails>> {
  const runId = input.runId ?? generateRunId();

  const allocationResult = await allocateRun({ runId });
  if (!allocationResult.ok) {
    const failureIsEnvironment =
      allocationFailureCliStatus(allocationResult.reason) === 'ENVIRONMENT_FAILURE';
    return buildCliResult<ProductionAbsenceCliDetails>({
      command: 'production-absence',
      status: failureIsEnvironment ? 'ENVIRONMENT_FAILURE' : 'HARNESS_BLOCKED',
      detail: allocationResult.detail,
      launchAttempted: false,
      details: details({ runId }),
      diagnostics: [
        createDiagnostic('RUN_RESOURCE_COLLISION', allocationResult.detail, {
          context: { reason: allocationResult.reason, runId },
        }),
      ],
    });
  }

  const allocation = allocationResult.allocation;
  const diagnostics: DiagnosticRecord[] = [];
  const admission = admitCase(runId, 'production-absence', allocation.repoRoot);
  if (!admission.ok) {
    await cleanupRun(runId, { expectedAppRoot: allocation.repoRoot });
    return buildCliResult<ProductionAbsenceCliDetails>({
      command: 'production-absence',
      status: 'HARNESS_BLOCKED',
      detail: admission.detail,
      launchAttempted: false,
      details: details({ runId, allocation, evidenceRoot: allocation.evidenceRoot }),
      diagnostics: [
        createDiagnostic('SAME_RUN_CASE_ACTIVE', admission.detail, { context: { runId } }),
      ],
    });
  }

  setActiveRun(runId);

  let production: ProductionRunResult | null = null;
  let scan: ProductionArtifactScan | null = null;
  let chunkReconciliation: { resolved: number; unresolved: readonly string[] } | null = null;
  let browser: ProductionAbsenceBrowserProof | null = null;
  let absence: ProductionAbsenceVerdict | null = null;
  let adaptedInput: CommandExecutionContextInput | null = null;
  let adapterIssues: readonly string[] = [];
  let environmentInvalid = false;
  let runError: string | null = null;
  let browserCleanup: { closed: boolean; detail: string | null } | undefined;
  let privateSnapshots: PrivateSnapshotCollection | undefined;
  let candidateCaptureError: string | null = null;
  let productionScreenshotProduced = false;

  try {
    production = await runOwnedProductionServer({
      allocation,
      buildDeadlineMs: input.buildDeadlineMs,
      startDeadlineMs: input.startDeadlineMs,
    });

    if (!production.ok) {
      environmentInvalid = true;
      runError = production.detail;
      diagnostics.push(createDiagnostic(production.reason, production.detail));
    } else {
      scan = scanProductionArtifacts({ distDir: allocation.distDir });

      const environment = resolveEnvironmentCell(
        loadEnvironmentCatalogue(),
        allocation.environmentCellId,
      );
      mkdirSync(path.join(allocation.scratchRoot, 'candidates'), { recursive: true });
      browser = await proveProductionAbsenceInBrowser({
        baseUrl: allocation.baseUrl,
        route: PRODUCTION_ABSENCE_ROUTE,
        environment,
        screenshotPath: path.join(allocation.scratchRoot, 'candidates', 'production-absence.png'),
      });
      const productionScreenshotPath = path.join(
        allocation.scratchRoot,
        'candidates',
        'production-absence.png',
      );
      productionScreenshotProduced = existsSync(productionScreenshotPath);
      if (productionScreenshotProduced) {
        try {
          privateSnapshots = capturePrivateSnapshots({
            scratchRoot: allocation.scratchRoot,
            descriptors: [
              {
                artifactId: 'production-absence.screenshot',
                relativePath: 'candidates/production-absence.png',
                role: 'optional-diagnostic',
                maxBytes: OPTIONAL_PNG_MAX_BYTES,
              },
            ],
          });
        } catch (error) {
          candidateCaptureError = error instanceof Error ? error.message : String(error);
          diagnostics.push(
            createDiagnostic(
              'PRODUCTION_ABSENCE_VIOLATION',
              `Production-absence screenshot capture failed: ${candidateCaptureError}`,
            ),
          );
        }
      }
      browserCleanup = {
        closed: browser.browserCloseError === null,
        detail: browser.browserCloseError,
      };
      chunkReconciliation = reconcileRequestedChunks(
        browser.requests.staticChunks,
        allocation.distDir,
      );

      absence = evaluateProductionAbsence({ scan, observations: browser.attempts });

      // A non-hydrated production document cannot prove a seam is absent; it is
      // an external runtime prerequisite failure, never a vacuous pass. The raw
      // projection carries that as its explicit external-failure fact.
      const hydrated = browser.attempts.every((attempt) => attempt.editorMounted);
      if (!hydrated) {
        environmentInvalid = true;
        runError = `Owned production ${PRODUCTION_ABSENCE_ROUTE} did not hydrate (no mounted canvas) before the absence probe.`;
        diagnostics.push(
          createDiagnostic('RUNTIME_READINESS_FAILED', runError, {
            context: { runId, attempts: String(browser.attempts.length) },
          }),
        );
      }

      // Operational transparency only: the exact contract-level violations are
      // preserved as diagnostics; they are never re-derived into a boolean check
      // or a `harnessInvalid` side channel.
      if (!absence.clean) {
        diagnostics.push(productionAbsenceDiagnostic(absence.violations, { runId }));
        for (const violation of absence.violations) {
          diagnostics.push(
            createDiagnostic('PRODUCTION_ABSENCE_VIOLATION', violation, { context: { runId } }),
          );
        }
      }
      if (chunkReconciliation.unresolved.length > 0) {
        diagnostics.push(
          createDiagnostic(
            'PRODUCTION_ABSENCE_VIOLATION',
            `Requested production chunks were not emitted artifacts: ${chunkReconciliation.unresolved.join(', ')}`,
            { context: { runId } },
          ),
        );
      }

      // The raw scan/browser/chunk facts are the only correctness input; the
      // legacy composite verdict and the locally constructed boolean checks are
      // never read. Every declared check and evidence role must be covered or the
      // adapter fails closed with no fabricated fact.
      const raw = projectProductionAbsenceRawCommandFacts({
        scan,
        attempts: browser.attempts,
        chunkReconciliation,
        buildOrStartFailed: false,
        browserCloseError: browser.browserCloseError,
        cleanupSucceeded: true,
      });
      const adaptation = adaptProductionAbsenceCommandFacts({
        declaration: PRODUCTION_ABSENCE_COMMAND_DECLARATION,
        raw,
      });
      if (adaptation.ok) {
        adaptedInput = adaptation.input;
      } else {
        adapterIssues = adaptation.issues.map((entry) => entry.code);
        environmentInvalid = true;
        runError = `Raw production-absence facts do not cover the declared command: ${adaptation.issues
          .map((entry) => `${entry.code}: ${entry.detail}`)
          .join('; ')}`;
        diagnostics.push(
          createDiagnostic('CORRECTNESS_COMPATIBILITY_DIVERGENCE', runError, {
            context: { issueCodes: adapterIssues.join(', ') },
          }),
        );
      }
    }
  } catch (error) {
    environmentInvalid = true;
    runError = `Production absence runtime failed: ${(error as Error).message}`;
    diagnostics.push(createDiagnostic('RUNTIME_LAUNCH_FAILED', runError));
  } finally {
    releaseCase(runId);
  }

  const authorityRef: { current: CleanupAuthoritySnapshot | null } = { current: null };
  let cleanup: CleanupResult;
  try {
    cleanup = await cleanupRun(runId, {
      expectedAppRoot: allocation.repoRoot,
      removeDistDir: input.keepDistDir === true ? false : true,
      browserCleanup,
      onAuthoritySnapshot: (snapshot) => {
        authorityRef.current = snapshot;
      },
    });
  } finally {
    setActiveRun(null);
  }

  const authoritySnapshot = authorityRef.current;
  const harnessDiagnostics = diagnostics.slice();
  diagnostics.push(...cleanup.diagnostics);
  if (!cleanup.complete) {
    diagnostics.push(
      createDiagnostic('CLEANUP_INCOMPLETE', cleanup.detail, { context: { runId } }),
    );
  }

  const forbiddenPaths = [
    ...sensitiveRootsOf(allocation),
    ...(authoritySnapshot === null ? [] : sensitiveGuardPaths(authoritySnapshot)),
    os.tmpdir(),
  ];
  const ownership: PublicOwnershipProjection =
    authoritySnapshot !== null
      ? authoritySnapshot.publicOwnership
      : buildNotEstablishedOwnership({
          runId,
          allocationFailureCode: cleanup.refusedReason ?? 'OWNERSHIP_UNKNOWN',
          requestedPort: null,
        });

  const operational = {
    runId,
    launch: buildPublicLaunchFacts({
      attempted: production !== null,
      pid: production?.pid ?? null,
      processGroupId: production?.processGroupId ?? null,
      readinessMs: production?.ok === true ? production.readinessMs : null,
      serverLogPath: production?.serverLogPath ?? null,
    }),
    ownership,
    cleanup: buildCleanupProjection(cleanup),
    diagnostics: redactDiagnostics(harnessDiagnostics, forbiddenPaths),
    runError: redactRecordText(runError, forbiddenPaths),
  } as const;

  const productionDetails: ProductionAbsenceCliDetails['production'] =
    production?.ok === true
      ? {
          buildMs: production.buildMs,
          readinessMs: production.readinessMs,
          pid: production.pid,
          processGroupId: production.processGroupId,
          buildLogPath: production.buildLogPath,
          serverLogPath: production.serverLogPath,
        }
      : null;

  // A run that never obtained its raw command facts (allocation/admission/build
  // failure, an unreached browser proof, or an adapter refusal) is refused
  // operationally: no check is fabricated and no record is produced.
  if (adaptedInput === null) {
    const detail =
      runError ?? `Production absence ${runId} did not reach a trustworthy raw observation set.`;
    const status: CliStatus = environmentInvalid ? 'ENVIRONMENT_FAILURE' : 'HARNESS_BLOCKED';
    return buildCliResult<ProductionAbsenceCliDetails>({
      command: 'production-absence',
      status,
      detail,
      launchAttempted: production !== null,
      ...(status === 'ENVIRONMENT_FAILURE' ? { outcome: 'ENVIRONMENT_FAILURE' as const } : {}),
      details: details({
        runId,
        allocation,
        production: productionDetails,
        scan,
        chunkReconciliation,
        browser,
        absence,
        cleanup,
        finalOutcome: status === 'ENVIRONMENT_FAILURE' ? 'ENVIRONMENT_FAILURE' : null,
        evidenceRoot: allocation.evidenceRoot,
        issues: adapterIssues,
      }),
      diagnostics,
    });
  }

  const finalized = runFinalProductionAbsenceActivePath({
    input: { ...adaptedInput, cleanupSucceeded: cleanup.complete },
    operational,
    durable: {
      evidenceRoot: allocation.evidenceRoot,
      forbiddenPaths,
      privateSnapshots,
      candidateCaptureError,
      optionalCandidates: [
        {
          artifactId: 'production-absence.screenshot',
          relativePath: 'candidates/production-absence.png',
          publicRelativePath: 'production-absence.png',
          produced: productionScreenshotProduced,
        },
      ],
    },
  });

  const emitted = finalized.cli;
  return buildCliResult<ProductionAbsenceCliDetails>({
    command: 'production-absence',
    status: emitted.status,
    detail: emitted.detail,
    launchAttempted: emitted.launchAttempted,
    outcome: emitted.outcome,
    details: details({
      runId,
      allocation,
      production: productionDetails,
      scan,
      chunkReconciliation,
      browser,
      absence,
      behaviorOutcome: finalized.execution.behaviorOutcome,
      requiredChecks: finalized.execution.requiredChecks.map((check) => ({
        checkId: check.checkId,
        status: String(check.status),
      })),
      issues: finalized.execution.issues.map((entry) => entry.code),
      cleanup,
      finalOutcome: finalized.finalOutcome,
      evidenceRoot: allocation.evidenceRoot,
      runRecordPath: finalized.durable.path,
      authoritative: finalized.execution.authoritative,
    }),
    diagnostics: [...diagnostics, ...emitted.diagnostics],
  });
}
