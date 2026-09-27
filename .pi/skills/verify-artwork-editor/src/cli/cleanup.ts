import { createDiagnostic } from '../contracts/diagnostics';
import type { CliResult, CleanupResult } from '../contracts/runtime';
import { cleanupRun } from '../cleanup/cleanup';
import { buildCliResult } from './output';

/**
 * `pnpm verify:artwork cleanup --run-id <run-id>` (TS-2, TS-5, Gate D).
 *
 * Recovery consumes the durable ownership record, refuses unknown or ambiguous
 * ownership without killing or deleting anything, and verifies process death,
 * port closure, scratch removal, and preserved evidence.
 */

export interface CleanupCliDetails {
  cleanup: CleanupResult;
}

export async function runCleanupCommand(runId: string): Promise<CliResult<CleanupCliDetails>> {
  const cleanup = await cleanupRun(runId);

  if (cleanup.refusedReason !== null) {
    return buildCliResult<CleanupCliDetails>({
      command: 'cleanup',
      status: 'HARNESS_BLOCKED',
      detail: cleanup.detail,
      details: { cleanup },
      diagnostics: [
        createDiagnostic(
          cleanup.refusedReason === 'OWNERSHIP_RECORD_INVALID'
            ? 'RUN_OWNERSHIP_RECORD_INVALID'
            : 'RUN_OWNERSHIP_UNKNOWN',
          cleanup.detail,
          { context: { reason: cleanup.refusedReason, runId } },
        ),
      ],
    });
  }

  return buildCliResult<CleanupCliDetails>({
    command: 'cleanup',
    status: cleanup.complete ? 'PASS' : 'ENVIRONMENT_FAILURE',
    detail: cleanup.detail,
    details: { cleanup },
    diagnostics:
      cleanup.complete && cleanup.diagnostics.length === 0
        ? []
        : [
            ...cleanup.diagnostics,
            ...(cleanup.complete
              ? []
              : [createDiagnostic('CLEANUP_INCOMPLETE', cleanup.detail, { context: { runId } })]),
          ],
  });
}
