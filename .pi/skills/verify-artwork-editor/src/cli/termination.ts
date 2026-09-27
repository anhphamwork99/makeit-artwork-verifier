import { cleanupRun } from '../cleanup/cleanup';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { CleanupResult, CliResult } from '../contracts/runtime';
import { buildCliResult } from './output';
import { markTerminationEmitted } from './termination-state';

/**
 * Bounded SIGINT/SIGTERM terminal safety net (specification 10, Gate D).
 *
 * When the CLI process is interrupted mid-Doctor, it must still attempt exact
 * cleanup of the run it owns and terminate with structured, non-zero semantics.
 * It never performs a broad process-name or port sweep: cleanup is keyed only by
 * the single active run id this process registered, and the standard cleanup
 * ownership gates still apply.
 */

export const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];

/** Conventional 128 + signal number exit codes. */
export const SIGNAL_EXIT_CODES: Readonly<Record<TerminationSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export const DEFAULT_TERMINATION_CLEANUP_DEADLINE_MS = 30_000;

let activeRunId: string | null = null;

export function setActiveRun(runId: string | null): void {
  activeRunId = runId;
}

export function getActiveRunId(): string | null {
  return activeRunId;
}

export interface TerminationCliDetails {
  signal: TerminationSignal;
  runId: string | null;
  cleanup: CleanupResult | null;
  cleanupTimedOut: boolean;
}

export interface TerminationOutcome {
  result: CliResult<TerminationCliDetails>;
  exitCode: number;
}

export interface TerminationCleanupDeps {
  clean?: (runId: string) => Promise<CleanupResult>;
  deadlineMs?: number;
}

function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  onTimeout: () => void,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      resolve(null);
    }, deadlineMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Attempts exact cleanup for the active run (if any) and builds the structured
 * non-zero termination envelope. Bounded by `deadlineMs` so an unresponsive
 * cleanup can never hang process termination.
 */
export async function runTerminationCleanup(
  signal: TerminationSignal,
  deps: TerminationCleanupDeps = {},
): Promise<TerminationOutcome> {
  const runId = activeRunId;
  const clean = deps.clean ?? cleanupRun;
  let cleanup: CleanupResult | null = null;
  let cleanupTimedOut = false;

  if (runId !== null) {
    cleanup = await withDeadline(
      clean(runId),
      deps.deadlineMs ?? DEFAULT_TERMINATION_CLEANUP_DEADLINE_MS,
      () => {
        cleanupTimedOut = true;
      },
    );
  }

  const diagnostics: DiagnosticRecord[] = [
    createDiagnostic(
      'RUNTIME_TERMINATED_BY_SIGNAL',
      `verify:artwork received ${signal}; routing to exact owned-run cleanup.`,
      { context: { signal, runId: runId ?? 'none' } },
    ),
  ];

  if (runId === null) {
    diagnostics.push(
      createDiagnostic(
        'CLEANUP_INCOMPLETE',
        `No owned run was active when ${signal} arrived; no process or path was touched.`,
        { context: { signal } },
      ),
    );
  } else if (cleanup === null) {
    diagnostics.push(
      createDiagnostic(
        'CLEANUP_INCOMPLETE',
        cleanupTimedOut
          ? `Owned cleanup for run ${runId} exceeded its bounded deadline after ${signal}.`
          : `Owned cleanup for run ${runId} could not be completed after ${signal}.`,
        { context: { signal, runId } },
      ),
    );
  } else {
    diagnostics.push(...cleanup.diagnostics);
    if (!cleanup.complete) {
      diagnostics.push(
        createDiagnostic('CLEANUP_INCOMPLETE', cleanup.detail, { context: { signal, runId } }),
      );
    }
  }

  let detail: string;
  if (runId === null) {
    detail = `verify:artwork was interrupted by ${signal}. No owned run was active, so nothing was killed or deleted.`;
  } else if (cleanup?.complete === true) {
    detail = `verify:artwork was interrupted by ${signal}; owned run ${runId} was cleaned up exactly.`;
  } else {
    detail = `verify:artwork was interrupted by ${signal}; owned cleanup for run ${runId} is incomplete: ${cleanup?.detail ?? 'cleanup did not complete within its deadline'}`;
  }

  const built = buildCliResult<TerminationCliDetails>({
    command: 'termination',
    status: 'ENVIRONMENT_FAILURE',
    detail,
    launchAttempted: runId !== null,
    details: { signal, runId, cleanup, cleanupTimedOut },
    diagnostics,
  });

  return {
    result: { ...built, exitCode: SIGNAL_EXIT_CODES[signal] },
    exitCode: SIGNAL_EXIT_CODES[signal],
  };
}

export interface TerminationHandlerDeps extends TerminationCleanupDeps {
  emit?: (result: CliResult<TerminationCliDetails>) => void;
  exit?: (code: number) => void;
}

/**
 * Installs bounded SIGINT/SIGTERM handlers on the real CLI process. Returns a
 * disposer that removes exactly the listeners it added.
 *
 * A second signal while the first is still being handled terminates immediately
 * rather than stacking more cleanup.
 */
export function installTerminationSignalHandlers(deps: TerminationHandlerDeps = {}): () => void {
  const emit =
    deps.emit ??
    ((result: CliResult<TerminationCliDetails>) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let handling = false;

  const listeners = new Map<TerminationSignal, () => void>();
  for (const signal of TERMINATION_SIGNALS) {
    const listener = () => {
      if (handling) {
        exit(SIGNAL_EXIT_CODES[signal]);
        return;
      }
      handling = true;
      void runTerminationCleanup(signal, { clean: deps.clean, deadlineMs: deps.deadlineMs }).then(
        (outcome) => {
          markTerminationEmitted();
          emit(outcome.result);
          exit(outcome.exitCode);
        },
      );
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
  };
}
