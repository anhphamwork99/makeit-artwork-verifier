import { realpathSync } from 'node:fs';
import path from 'node:path';

import { createDiagnostic } from '../contracts/diagnostics';
import type { CliResult, CleanupResult } from '../contracts/runtime';
import { cleanupRun, noOwnedLeaseCleanup } from '../cleanup/cleanup';
import { buildCliResult } from './output';

/**
 * `pnpm verify:artwork cleanup --run-id <run-id> --app-root <trusted FE checkout>`
 * (TS-2, TS-5, Gate D, ADR 0119).
 *
 * Public recovery requires the same explicit, canonical application root the
 * run was allocated against. Missing input is a usage error; a record whose
 * owned root is not exactly that root (or any other tampering) is refused with
 * no kill, restore or deletion. The provider is a preflight compatibility test,
 * not cleanup authority, so cleanup validates only the exact root and the
 * toolkit-owned derived paths.
 */

export interface CleanupCliDetails {
  cleanup: CleanupResult;
}

/**
 * Canonicalize the explicit trusted root before it is used as cleanup authority
 * (ADR 0119). `realpathSync` is the only accepted identity: a symlinked root can
 * be retargeted between allocation and recovery, so cleanup binds to the real
 * directory or refuses. There is no fallback to the lexical path, and the
 * filesystem root is never a valid application root.
 */
function canonicalizeAppRoot(appRoot: string): string | null {
  const resolved = path.resolve(appRoot.trim());
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch {
    return null;
  }
  if (canonical === path.parse(canonical).root) return null;
  return canonical;
}

export async function runCleanupCommand(
  runId: string,
  appRoot: string,
): Promise<CliResult<CleanupCliDetails>> {
  const expectedAppRoot = canonicalizeAppRoot(appRoot);
  if (expectedAppRoot === null) {
    const detail =
      'cleanup requires `--app-root <trusted application checkout>` that resolves to a real, non-root directory.';
    // Uncanonicalizable input is a usage error: no ownership is established and
    // no kill, restore or delete is attempted.
    return buildCliResult<CleanupCliDetails>({
      command: 'cleanup',
      status: 'USAGE',
      detail,
      details: { cleanup: noOwnedLeaseCleanup(runId, 'OWNERSHIP_UNKNOWN', detail) },
      diagnostics: [createDiagnostic('CLI_USAGE_INVALID', detail, { context: { runId } })],
    });
  }
  const cleanup = await cleanupRun(runId, { expectedAppRoot });

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
