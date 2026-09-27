import { AsyncLocalStorage } from 'node:async_hooks';

import { CLI_STATUSES, isOutcome, type CliStatus, type Outcome } from '../contracts/discriminants';
import type { CliResult } from '../contracts/runtime';
import { CLI_RESULT_SCHEMA_VERSION } from '../contracts/schema-versions';
import type { DiagnosticRecord, DiagnosticHints } from '../contracts/diagnostics';
import { createDiagnostic } from '../contracts/diagnostics';
import { terminationWasEmitted } from './termination-state';

/**
 * Stable structured CLI result envelope (TS-2, WP5 Slice 5-A).
 *
 * Every command emits exactly one machine-readable JSON document under CLI
 * schema v2. Exit codes are stable:
 *
 * - `PASS` → 0;
 * - `BUG` → 1 (a trustworthy product defect/non-convergence);
 * - `HARNESS_BLOCKED` / `ENVIRONMENT_FAILURE` → 2 (unavailable evidence);
 * - `NOT_IMPLEMENTED` → 3 (deliberately deferred);
 * - `USAGE` → 64 (invalid invocation).
 *
 * The outcome→status→exit mapping is centralized and exhaustive so no command
 * can map `BUG` onto `ENVIRONMENT_FAILURE` or emit a contradictory terminal
 * envelope.
 */

export const EXIT_CODES: Readonly<Record<CliStatus, number>> = {
  PASS: 0,
  BUG: 1,
  HARNESS_BLOCKED: 2,
  ENVIRONMENT_FAILURE: 2,
  NOT_IMPLEMENTED: 3,
  USAGE: 64,
};

const TERMINAL_OUTCOME_STATUS: Readonly<Record<Outcome, CliStatus>> = {
  PASS: 'PASS',
  BUG: 'BUG',
  HARNESS_BLOCKED: 'HARNESS_BLOCKED',
  ENVIRONMENT_FAILURE: 'ENVIRONMENT_FAILURE',
};

/**
 * The one exhaustive mapping from a terminal outcome to its CLI status. `BUG`
 * is never represented as environment failure.
 */
export function statusForOutcome(outcome: Outcome): CliStatus {
  const status = TERMINAL_OUTCOME_STATUS[outcome];
  if (status === undefined) {
    throw new Error(`Unknown terminal outcome: ${String(outcome)}.`);
  }
  return status;
}

/** Exit code for a terminal outcome, derived through the shared mapping. */
export function exitCodeForOutcome(outcome: Outcome): number {
  return EXIT_CODES[statusForOutcome(outcome)];
}

export interface BuildCliResultInput<TDetails> {
  command: string;
  subcommand?: string | null;
  status: CliStatus;
  detail: string;
  launchAttempted?: boolean;
  outcome?: CliResult<TDetails>['outcome'];
  details?: TDetails | null;
  diagnostics?: readonly DiagnosticRecord[];
}

export function buildCliResult<TDetails>(
  input: BuildCliResultInput<TDetails>,
): CliResult<TDetails> {
  // A terminal outcome and a contradictory status can never coexist. `BUG`
  // must be emitted as `BUG`, never masked as `ENVIRONMENT_FAILURE`.
  if (input.outcome !== undefined && input.outcome !== null) {
    const expected = statusForOutcome(input.outcome);
    if (input.status !== expected) {
      throw new Error(
        `Contradictory CLI envelope: status "${input.status}" cannot carry outcome "${input.outcome}" (expected "${expected}").`,
      );
    }
  }
  return {
    schemaVersion: CLI_RESULT_SCHEMA_VERSION,
    command: input.command,
    subcommand: input.subcommand ?? null,
    status: input.status,
    exitCode: EXIT_CODES[input.status],
    launchAttempted: input.launchAttempted ?? false,
    outcome: input.outcome ?? null,
    detail: input.detail,
    details: input.details ?? null,
    diagnostics: input.diagnostics ?? [],
  };
}

/**
 * Fails closed on any envelope that is not a self-consistent v2 result. In
 * particular a schema-v1 document is rejected rather than silently accepted
 * under the widened status vocabulary, and a status/outcome/exit tuple that
 * disagrees with the shared mapping is rejected.
 */
export function parseCliResultEnvelope<TDetails = unknown>(value: unknown): CliResult<TDetails> {
  if (value === null || typeof value !== 'object') {
    throw new Error('CLI result envelope must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CLI_RESULT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported CLI result schema ${String(record.schemaVersion)}; expected ${CLI_RESULT_SCHEMA_VERSION}.`,
    );
  }
  if (
    typeof record.status !== 'string' ||
    !(CLI_STATUSES as readonly string[]).includes(record.status)
  ) {
    throw new Error(`Unknown CLI status "${String(record.status)}".`);
  }
  const status = record.status as CliStatus;
  if (record.exitCode !== EXIT_CODES[status]) {
    throw new Error(
      `CLI result exit code ${String(record.exitCode)} does not match status "${status}".`,
    );
  }
  if (record.outcome !== null && record.outcome !== undefined) {
    if (!isOutcome(record.outcome)) {
      throw new Error(`Unknown CLI outcome "${String(record.outcome)}".`);
    }
    if (status !== statusForOutcome(record.outcome)) {
      throw new Error(`CLI result status "${status}" contradicts outcome "${record.outcome}".`);
    }
  }
  return record as unknown as CliResult<TDetails>;
}

export function usageDiagnostic(detail: string, hints?: DiagnosticHints): DiagnosticRecord {
  return createDiagnostic('CLI_USAGE_INVALID', detail, hints);
}

export type CliStdoutSink = (chunk: string) => void;

/**
 * Per-invocation CLI output routing (test/harness seam).
 *
 * Production calls `runCli()` with no sink and the envelope goes to the real
 * `process.stdout`. A caller that owns an invocation may instead supply an
 * explicit sink. Routing through an `AsyncLocalStorage` context — rather than
 * monkey-patching the global `process.stdout.write` — means a capture belongs to
 * exactly one invocation: if a test is abandoned at timeout and its CLI
 * continuation resolves later, that late envelope is written to its own sink and
 * can never leak into a subsequent test's capture. The default sink preserves
 * the previous production behavior byte-for-byte.
 */
const cliStdoutStorage = new AsyncLocalStorage<CliStdoutSink>();

const defaultCliStdout: CliStdoutSink = (chunk) => {
  process.stdout.write(chunk);
};

/** Runs `fn` (and every async continuation it starts) with the given CLI sink. */
export function runWithCliStdout<T>(sink: CliStdoutSink, fn: () => Promise<T>): Promise<T> {
  return cliStdoutStorage.run(sink, fn);
}

/** The sink owning the current CLI invocation, or the real process stdout. */
export function currentCliStdout(): CliStdoutSink {
  return cliStdoutStorage.getStore() ?? defaultCliStdout;
}

export function emitCliResult<TDetails>(result: CliResult<TDetails>): number {
  // A signal-driven termination already emitted the authoritative structured
  // result; the in-flight command flow must not append a second one.
  if (terminationWasEmitted()) return result.exitCode;
  currentCliStdout()(`${JSON.stringify(result, null, 2)}\n`);
  return result.exitCode;
}
