import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

import {
  adaptDoctorCommandFacts,
  type DoctorCommandDeclarationView,
} from '../adapters/doctor-command-live-facts';
import { allocateRun, allocationFailureCliStatus } from '../allocation/allocate';
import { admitCase, releaseCase } from '../allocation/lease';
import { runDoctor, type DoctorRegistryFactsInput } from '../browser/doctor';
import { loadCatalogueBundle } from '../catalogue/load';
import { cleanupRun } from '../cleanup/cleanup';
import {
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
} from '../commands/doctor-command-context';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import { assessHostCompatibility } from '../contracts/host-compatibility';
import type { CliStatus, Outcome } from '../contracts/discriminants';
import type { CliResult, CleanupResult, RunAllocation } from '../contracts/runtime';
import {
  buildCleanupProjection,
  buildNotEstablishedOwnership,
  buildPublicLaunchFacts,
  redactDiagnostics,
  redactRecordText,
  sensitiveRootsOf,
  type PublicOwnershipProjection,
} from '../evidence/public-dto';
import { sensitiveGuardPaths, type CleanupAuthoritySnapshot } from '../evidence/cleanup-authority';
import {
  capturePrivateSnapshots,
  OPTIONAL_PNG_MAX_BYTES,
  type PrivateSnapshotCollection,
} from '../evidence/private-snapshot';
import { runFinalDoctorActivePath } from '../orchestration/final-active-path';
import type { CommandExecutionContextInput } from '../orchestration/command-execution';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../runtime/environment';
import { collectAppRevision, collectEnvironmentFacts } from '../runtime/environment-facts';
import { launchOwnedServer } from '../runtime/launch';
import {
  loadProductMeaningProvider,
  type ProductMeaningProviderFailureCode,
} from '../runtime/product-meaning-provider';
import { generateRunId } from '../runtime/run-id';
import { reconcileRegistry } from '../registry/reconcile';
import { buildCliResult } from './output';
import { setActiveRun } from './termination';

/**
 * `pnpm verify:artwork doctor` (TS-2, TS-4, TS-5; Gate D; post-cutover current
 * path, ADR 0032 §E3-S2).
 *
 * Allocates exclusive run resources, launches exactly one owned Next.js server,
 * runs the read-only Doctor in a fresh Chromium context, and always cleans up on
 * every terminal path. The raw Doctor observations are mapped through the
 * command live-fact adapter onto the accepted B1-G Doctor declaration, and the
 * current final façade classifies the three-state command checks and writes the
 * strict-v4 command record. This entry never reads a legacy boolean check,
 * `harnessInvalid`, status, or outcome; it owns operational facts only.
 */

/** The closed Doctor declaration view the command adapter is bound to. */
const DOCTOR_COMMAND_DECLARATION: DoctorCommandDeclarationView = Object.freeze({
  authority: DOCTOR_COMMAND_STATUS_AUTHORITY,
  requiredCheckIds: Object.freeze(DOCTOR_COMMAND_CHECKS.map((check) => check.checkId)),
  requiredEvidenceIds: Object.freeze([...DOCTOR_COMMAND_REQUIRED_EVIDENCE]),
  diagnosticEvidenceIds: Object.freeze([...DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE]),
});

export interface DoctorCliDetails {
  runId: string;
  allocation: RunAllocation | null;
  launch: {
    pid: number;
    processGroupId: number;
    readinessMs: number | null;
    serverLogPath: string;
  } | null;
  behaviorOutcome: Outcome | null;
  /** Three-state command check statuses; never a legacy boolean `passed`. */
  requiredChecks: readonly { checkId: string; status: string }[];
  /** Closed orchestration refusal codes; empty on a trustworthy command. */
  issues: readonly string[];
  cleanup: CleanupResult | null;
  finalOutcome: Outcome | null;
  evidenceRoot: string | null;
  runRecordPath: string | null;
  /** True only when the declaration and the consumed authority were trustworthy. */
  authoritative: boolean;
}

export interface RunDoctorCommandInput {
  runId?: string;
  /** Explicit application checkout that owns the Next.js runtime and bridge. */
  appRoot?: string;
  readinessDeadlineMs?: number;
  /** Diagnostic override only; production always removes the owned distDir. */
  keepDistDir?: boolean;
}

function registryFacts(): DoctorRegistryFactsInput {
  try {
    const bundle = loadCatalogueBundle();
    const reconciliation = reconcileRegistry({
      subjectCatalogue: bundle.subjectCatalogue,
      applicationInventory: bundle.applicationInventory,
      operationCatalogue: bundle.operationCatalogue,
      adapterCatalogue: bundle.adapterCatalogue,
      workflowCatalogue: bundle.workflowCatalogue,
    });
    return {
      schemaVersion: bundle.subjectCatalogue.schemaVersion,
      fingerprint: reconciliation.registryFingerprint,
      resolvedSubjects: reconciliation.resolvedSubjects.length,
    };
  } catch {
    return { schemaVersion: null, fingerprint: null, resolvedSubjects: null };
  }
}

function details(input: Partial<DoctorCliDetails>): DoctorCliDetails {
  return {
    runId: input.runId ?? '',
    allocation: input.allocation ?? null,
    launch: input.launch ?? null,
    behaviorOutcome: input.behaviorOutcome ?? null,
    requiredChecks: input.requiredChecks ?? [],
    issues: input.issues ?? [],
    cleanup: input.cleanup ?? null,
    finalOutcome: input.finalOutcome ?? null,
    evidenceRoot: input.evidenceRoot ?? null,
    runRecordPath: input.runRecordPath ?? null,
    authoritative: input.authoritative ?? false,
  };
}

function productMeaningProviderDiagnosticCode(
  code: ProductMeaningProviderFailureCode,
): DiagnosticRecord['code'] {
  if (code === 'PROVIDER_INCOMPATIBLE') return 'PRODUCT_MEANING_PROVIDER_INCOMPATIBLE';
  return 'PRODUCT_MEANING_PROVIDER_UNAVAILABLE';
}

export async function runDoctorCommand(
  input: RunDoctorCommandInput = {},
): Promise<CliResult<DoctorCliDetails>> {
  const runId = input.runId ?? generateRunId();

  if (typeof input.appRoot !== 'string' || input.appRoot.trim().length === 0) {
    const detail =
      'doctor requires an explicit `--app-root <path>` naming the application checkout.';
    return buildCliResult<DoctorCliDetails>({
      command: 'doctor',
      status: 'USAGE',
      detail,
      launchAttempted: false,
      details: details({ runId }),
      diagnostics: [createDiagnostic('CLI_USAGE_INVALID', detail)],
    });
  }

  const providerResult = await loadProductMeaningProvider(input.appRoot);
  if (!providerResult.ok) {
    const code = productMeaningProviderDiagnosticCode(providerResult.code);
    const detail = 'Doctor product-meaning provider preflight failed.';
    return buildCliResult<DoctorCliDetails>({
      command: 'doctor',
      status: 'HARNESS_BLOCKED',
      detail,
      launchAttempted: false,
      details: details({ runId }),
      diagnostics: [
        createDiagnostic(code, detail, {
          context: { appRootCode: providerResult.code },
        }),
      ],
    });
  }

  const hostCompatibility = assessHostCompatibility(
    providerResult.ref.provider.hostCompatibility,
    [],
  );
  if (!hostCompatibility.ok) {
    return buildCliResult<DoctorCliDetails>({
      command: 'doctor',
      status: 'HARNESS_BLOCKED',
      detail: hostCompatibility.detail,
      launchAttempted: false,
      details: details({ runId }),
      diagnostics: [
        createDiagnostic(hostCompatibility.code, hostCompatibility.detail, {
          context: hostCompatibility.context,
        }),
      ],
    });
  }

  const allocationResult = await allocateRun({
    runId,
    appRoot: providerResult.ref.appRoot,
  });
  if (!allocationResult.ok) {
    const failureIsEnvironment =
      allocationFailureCliStatus(allocationResult.reason) === 'ENVIRONMENT_FAILURE';
    return buildCliResult<DoctorCliDetails>({
      command: 'doctor',
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
  const admission = admitCase(runId, 'doctor', allocation.repoRoot);
  if (!admission.ok) {
    await cleanupRun(runId, { expectedAppRoot: allocation.repoRoot });
    return buildCliResult<DoctorCliDetails>({
      command: 'doctor',
      status: 'HARNESS_BLOCKED',
      detail: admission.detail,
      launchAttempted: false,
      details: details({ runId, allocation, evidenceRoot: allocation.evidenceRoot }),
      diagnostics: [
        createDiagnostic('SAME_RUN_CASE_ACTIVE', admission.detail, { context: { runId } }),
      ],
    });
  }

  let launch: {
    pid: number;
    processGroupId: number;
    readinessMs: number | null;
    serverLogPath: string;
  } | null = null;
  let rawFacts: CommandExecutionContextInput['checks'] | null = null;
  let adaptedInput: CommandExecutionContextInput | null = null;
  let adapterIssues: readonly string[] = [];
  let environmentInvalid = false;
  let runError: string | null = null;
  let browserCleanup: { closed: boolean; detail: string | null } | undefined;
  let privateSnapshots: PrivateSnapshotCollection | undefined;
  let candidateCaptureError: string | null = null;
  let doctorScreenshotProduced = false;

  // From here on the CLI process owns live run resources; a SIGINT/SIGTERM must
  // route to exact run cleanup by run id.
  setActiveRun(runId);

  try {
    const launchResult = await launchOwnedServer({
      allocation,
      readinessDeadlineMs: input.readinessDeadlineMs,
    });
    if (
      launchResult.pid !== null &&
      launchResult.processGroupId !== null &&
      launchResult.serverLogPath !== null
    ) {
      launch = {
        pid: launchResult.pid,
        processGroupId: launchResult.processGroupId,
        readinessMs: launchResult.ok ? launchResult.readinessMs : null,
        serverLogPath: launchResult.serverLogPath,
      };
    }
    if (!launchResult.ok) {
      environmentInvalid = true;
      runError = launchResult.detail;
      diagnostics.push(createDiagnostic(launchResult.reason, launchResult.detail));
    } else {
      const environment = resolveEnvironmentCell(
        loadEnvironmentCatalogue(),
        allocation.environmentCellId,
      );
      const environmentFacts = collectEnvironmentFacts({
        cell: environment,
        baseUrl: allocation.baseUrl,
        chromiumExecutablePath: chromium.executablePath(),
      });
      const doctorRun = await runDoctor({
        allocation,
        environment,
        environmentFacts,
        registry: registryFacts(),
        appRevision: collectAppRevision(allocation.repoRoot),
      });
      browserCleanup = {
        closed: doctorRun.browserCloseError === null,
        detail: doctorRun.browserCloseError,
      };
      diagnostics.push(...doctorRun.result.diagnostics);
      doctorScreenshotProduced = existsSync(
        path.join(allocation.scratchRoot, 'candidates', 'doctor.png'),
      );
      if (doctorScreenshotProduced) {
        try {
          privateSnapshots = capturePrivateSnapshots({
            scratchRoot: allocation.scratchRoot,
            descriptors: [
              {
                artifactId: 'doctor.screenshot',
                relativePath: 'candidates/doctor.png',
                role: 'optional-diagnostic',
                maxBytes: OPTIONAL_PNG_MAX_BYTES,
              },
            ],
          });
        } catch (error) {
          candidateCaptureError = error instanceof Error ? error.message : String(error);
          diagnostics.push(
            createDiagnostic(
              'DOCTOR_INSTANCE_MISMATCH',
              `Doctor screenshot capture failed: ${candidateCaptureError}`,
            ),
          );
        }
      }
      // The raw Doctor observations are the only correctness input; the legacy
      // composite report fields on `doctorRun.result` are never read.
      const adaptation = adaptDoctorCommandFacts({
        declaration: DOCTOR_COMMAND_DECLARATION,
        raw: doctorRun.rawFacts,
      });
      if (adaptation.ok) {
        rawFacts = adaptation.input.checks;
        adaptedInput = adaptation.input;
      } else {
        adapterIssues = adaptation.issues.map((entry) => entry.code);
        environmentInvalid = true;
        runError = `Raw Doctor facts do not cover the declared Doctor command: ${adaptation.issues
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
    runError = `Doctor runtime failed: ${(error as Error).message}`;
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
      attempted: launch !== null,
      pid: launch?.pid ?? null,
      processGroupId: launch?.processGroupId ?? null,
      readinessMs: launch?.readinessMs ?? null,
      serverLogPath: launch?.serverLogPath ?? null,
    }),
    ownership,
    cleanup: buildCleanupProjection(cleanup),
    diagnostics: redactDiagnostics(harnessDiagnostics, forbiddenPaths),
    runError: redactRecordText(runError, forbiddenPaths),
  } as const;

  // A run that never obtained its raw command facts (allocation/admission/launch
  // failure, or an adapter refusal) is refused operationally: no check is
  // fabricated and no record is produced.
  if (adaptedInput === null) {
    const detail = runError ?? `Doctor ${runId} did not reach a trustworthy raw observation set.`;
    const status: CliStatus = environmentInvalid ? 'ENVIRONMENT_FAILURE' : 'HARNESS_BLOCKED';
    return buildCliResult<DoctorCliDetails>({
      command: 'doctor',
      status,
      detail,
      launchAttempted: launch !== null,
      ...(status === 'ENVIRONMENT_FAILURE' ? { outcome: 'ENVIRONMENT_FAILURE' as const } : {}),
      details: details({
        runId,
        allocation,
        launch,
        cleanup,
        finalOutcome: status === 'ENVIRONMENT_FAILURE' ? 'ENVIRONMENT_FAILURE' : null,
        evidenceRoot: allocation.evidenceRoot,
        issues: adapterIssues,
      }),
      diagnostics,
    });
  }

  void rawFacts;
  const finalized = runFinalDoctorActivePath({
    input: { ...adaptedInput, cleanupSucceeded: cleanup.complete },
    operational,
    durable: {
      evidenceRoot: allocation.evidenceRoot,
      forbiddenPaths,
      privateSnapshots,
      candidateCaptureError,
      optionalCandidates: [
        {
          artifactId: 'doctor.screenshot',
          relativePath: 'candidates/doctor.png',
          publicRelativePath: 'doctor.png',
          produced: doctorScreenshotProduced,
        },
      ],
    },
  });

  const emitted = finalized.cli;
  return buildCliResult<DoctorCliDetails>({
    command: 'doctor',
    status: emitted.status,
    detail: emitted.detail,
    launchAttempted: emitted.launchAttempted,
    outcome: emitted.outcome,
    details: details({
      runId,
      allocation,
      launch,
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
