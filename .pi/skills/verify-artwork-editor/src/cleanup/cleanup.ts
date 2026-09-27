import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';

import {
  expectedDistDirFor,
  isProcessAlive,
  isProcessGroupAlive,
  OWNERSHIP_FILE,
  ownershipRecordIsVerifiable,
  ownershipRecordPathFor,
  readOwnershipRecord,
  scratchRootFor,
  writeOwnershipRecord,
} from '../allocation/lease';
import { releaseRunPortReservation } from '../allocation/port-reservation';
import { verifyRecordedProcessIdentity } from '../allocation/process-identity';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { CleanupResult, CleanupVerification } from '../contracts/runtime';
import { CLEANUP_RESULT_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  captureCleanupAuthoritySnapshot,
  type CleanupAuthoritySnapshot,
} from '../evidence/cleanup-authority';
import { restoreRepoConfig } from '../runtime/config-snapshot';
import { terminateProcessGroup, waitForPortClosed } from '../runtime/process-group';

/**
 * Owned-run cleanup and recovery (specification 10, Gate D).
 *
 * Cleanup acts only on a verifiable ownership record whose every derived path
 * matches this repository and run id. It structurally validates the recorded
 * process fields and verifies the live pid -> process group and owned command
 * identity before signalling, so a tampered record can never redirect a kill.
 * It terminates only the exact recorded process group, verifies process death,
 * port closure, `distDir` removal, scratch removal, config restoration, and
 * browser closure, and preserves evidence. Every filesystem failure is returned
 * as structured diagnostics instead of throwing.
 */

function emptyVerification(): CleanupVerification {
  return {
    processSignalled: null,
    processEscalated: false,
    processDead: false,
    portClosed: false,
    distDirRemoved: false,
    scratchRemoved: false,
    configRestored: false,
    browserClosed: true,
    evidencePreserved: false,
  };
}

export interface CleanupRunOptions {
  /** Diagnostic/test override; production always removes the owned build output. */
  removeDistDir?: boolean;
  /** Test/diagnostic override: remove one owned path. Defaults to recursive rm. */
  removePath?: (target: string) => void;
  /** Browser context/browser closure outcome reported by the Doctor. */
  browserCleanup?: { closed: boolean; detail: string | null };
  /** Test-only seam for proving the still-live process safety boundary. */
  terminateGroup?: typeof terminateProcessGroup;
  /** Test-only seam for proving pid liveness after attempted termination. */
  processIsAlive?: typeof isProcessAlive;
  /** Test-only seam for proving live process identity without signalling a real process. */
  verifyProcessIdentity?: typeof verifyRecordedProcessIdentity;
  /** Test-only seam for proving config is not restored while the process is alive. */
  restoreConfig?: typeof restoreRepoConfig;
  /**
   * Receives the runtime-only cleanup-authority snapshot captured from the exact
   * private record that passed ownership and live-process verification, before
   * any scratch deletion (ADR 0011 R2). It never authorizes destructive work.
   */
  onAuthoritySnapshot?: (snapshot: CleanupAuthoritySnapshot) => void;
}

function refusal(
  runId: string,
  refusedReason: NonNullable<CleanupResult['refusedReason']>,
  detail: string,
  diagnostics: readonly DiagnosticRecord[] = [],
  verification: CleanupVerification = emptyVerification(),
): CleanupResult {
  return {
    schemaVersion: CLEANUP_RESULT_SCHEMA_VERSION,
    runId,
    attempted: false,
    complete: false,
    alreadyClean: false,
    refusedReason,
    detail,
    verification,
    diagnostics,
  };
}

export async function cleanupRun(
  runId: string,
  options: CleanupRunOptions = {},
): Promise<CleanupResult> {
  // The run's held port reservation is released by every cleanup path, whether
  // or not ownership can be established, so a refused cleanup never leaks it.
  await releaseRunPortReservation(runId);

  const record = readOwnershipRecord(runId);

  if (!ownershipRecordIsVerifiable(record) || record?.runId !== runId) {
    const detail =
      record === null
        ? `No owned verification state exists for run id ${runId}. Refusing to kill or delete anything.`
        : `Owned state for run id ${runId} is not verifiable as this toolkit's own resource. Refusing to kill or delete anything.`;
    return refusal(
      runId,
      record === null ? 'OWNERSHIP_UNKNOWN' : 'OWNERSHIP_RECORD_INVALID',
      detail,
    );
  }

  const active = record as NonNullable<typeof record>;
  const distDir = expectedDistDirFor(runId);
  const scratchRoot = scratchRootFor(runId);

  // The record already proved these derived paths match; assert again so a
  // destructive action can never target an unverified path.
  if (active.distDir !== distDir || active.scratchRoot !== scratchRoot) {
    return refusal(
      runId,
      'OWNERSHIP_RECORD_INVALID',
      'Owned resource paths changed since allocation. Refusing destructive cleanup.',
    );
  }

  const diagnostics: DiagnosticRecord[] = [];
  const context = { runId };

  // Live identity gate: never signal a process group that the live pid/command
  // does not prove belongs to this run.
  if (active.processGroupId !== null) {
    const verifyProcessIdentity = options.verifyProcessIdentity ?? verifyRecordedProcessIdentity;
    const identity = verifyProcessIdentity(active, { isProcessGroupAlive });
    if (!identity.ok) {
      diagnostics.push(
        createDiagnostic(
          'CLEANUP_OWNERSHIP_AMBIGUOUS',
          `Ambiguous ownership blocks destructive cleanup: ${identity.reason}. Evidence preserved.`,
          { context },
        ),
      );
      return refusal(
        runId,
        'PROCESS_GROUP_UNVERIFIABLE',
        `Ambiguous ownership blocks destructive cleanup: ${identity.reason}. Evidence preserved.`,
        diagnostics,
      );
    }
  }

  const verification = emptyVerification();
  // R2: capture the immutable runtime-only snapshot from the exact verified
  // private record *before* any destructive scratch operation. The snapshot is
  // a companion runtime value and never cleanup authority.
  options.onAuthoritySnapshot?.(captureCleanupAuthoritySnapshot(active));

  if (active.processGroupId !== null) {
    const terminateGroup = options.terminateGroup ?? terminateProcessGroup;
    const processIsAlive = options.processIsAlive ?? isProcessAlive;
    const termination = await terminateGroup(active.processGroupId);
    verification.processSignalled = termination.signalled;
    verification.processEscalated = termination.escalated;
    if (termination.refused) {
      diagnostics.push(
        createDiagnostic(
          'CLEANUP_OWNERSHIP_AMBIGUOUS',
          `Ambiguous ownership blocks destructive cleanup: ${termination.refused}. Evidence preserved.`,
          { context },
        ),
      );
      return refusal(
        runId,
        'PROCESS_GROUP_UNVERIFIABLE',
        `Ambiguous ownership blocks destructive cleanup: ${termination.refused}. Evidence preserved.`,
        diagnostics,
        verification,
      );
    }
    verification.processDead =
      termination.dead && (active.processPid === null || !processIsAlive(active.processPid));
  } else {
    // An allocated-but-unlaunched run owns no process.
    verification.processDead = true;
  }

  // Never restore shared config or remove build/scratch state while the owned
  // process may still be using it: the dev server rewrites `tsconfig.json` and
  // `next-env.d.ts` while it runs, so a restore before proven process death
  // would race the writer. Preserve the ownership record so an exact recovery
  // cleanup can be retried after the process is stopped externally.
  if (!verification.processDead) {
    verification.evidencePreserved = true;
    const detail = `Owned process group ${String(active.processGroupId)} is still alive after termination; config and owned paths were preserved for recovery.`;
    diagnostics.push(createDiagnostic('CLEANUP_INCOMPLETE', detail, { context }));
    return {
      schemaVersion: CLEANUP_RESULT_SCHEMA_VERSION,
      runId,
      attempted: true,
      complete: false,
      alreadyClean: false,
      refusedReason: null,
      detail,
      verification,
      diagnostics,
    };
  }

  verification.portClosed = await waitForPortClosed(active.port);

  const restore = (options.restoreConfig ?? restoreRepoConfig)(active.repoConfigSnapshot);
  verification.configRestored = restore.restored;
  const failedRestores = restore.files.filter((file) => file.action === 'failed');
  if (failedRestores.length > 0) {
    // Structured per-file diagnostics: which owned file failed and how. The
    // aggregate detail stays available on `CleanupResult.detail`.
    for (const file of failedRestores) {
      diagnostics.push(
        createDiagnostic('CLEANUP_INCOMPLETE', file.detail, {
          context: { ...context, path: file.relativePath, action: file.action },
        }),
      );
    }
  } else if (!restore.restored) {
    diagnostics.push(createDiagnostic('CLEANUP_INCOMPLETE', restore.detail, { context }));
  }

  const removePath =
    options.removePath ?? ((target: string) => rmSync(target, { recursive: true, force: true }));

  const keepDistDir = options.removeDistDir === false;
  if (keepDistDir) {
    // A diagnostic retention is explicitly non-complete: the owned build output
    // survives, so production Doctor can never PASS with it retained.
    diagnostics.push(
      createDiagnostic(
        'CLEANUP_INCOMPLETE',
        `Owned distDir ${active.repoRelativeDistDir} was retained by --keep-dist-dir; cleanup is not complete and the run cannot PASS.`,
        { context: { ...context, repoRelativeDistDir: active.repoRelativeDistDir } },
      ),
    );
  } else if (existsSync(distDir)) {
    try {
      removePath(distDir);
    } catch (error) {
      diagnostics.push(
        createDiagnostic(
          'CLEANUP_IO_FAILED',
          `Owned distDir ${active.repoRelativeDistDir} could not be removed: ${(error as Error).message}`,
          { context: { ...context, path: active.repoRelativeDistDir } },
        ),
      );
    }
  }
  verification.distDirRemoved = !existsSync(distDir);

  // Evidence is explicitly excluded from every removal path.
  const evidenceExisted = existsSync(active.evidenceRoot);
  verification.evidencePreserved = !evidenceExisted || existsSync(active.evidenceRoot);

  const browserCleanup = options.browserCleanup;
  if (browserCleanup && !browserCleanup.closed) {
    verification.browserClosed = false;
    diagnostics.push(
      createDiagnostic(
        'BROWSER_CLEANUP_FAILED',
        `Owned browser could not be closed: ${browserCleanup.detail ?? 'unknown close failure'}.`,
        { context },
      ),
    );
  }

  const otherComplete =
    verification.processDead &&
    verification.portClosed &&
    verification.distDirRemoved &&
    verification.configRestored &&
    verification.browserClosed &&
    verification.evidencePreserved &&
    !keepDistDir;

  // R3: scratch/ownership deletion is the *final* cleanup operation and is
  // permitted only after every other mandatory cleanup result is verified.
  // When anything else is incomplete, the private ownership record and the
  // required config snapshots survive so exact recovery stays possible.
  if (otherComplete) {
    finalizeScratch();
  } else {
    verification.scratchRemoved = false;
  }

  function recreateRecoveryLease(): void {
    try {
      writeOwnershipRecord(active);
    } catch {
      // Best effort: if the record cannot be recreated, the incomplete cleanup
      // still reports `scratchRemoved: false`, never a false success.
    }
  }

  function finalizeScratch(): void {
    if (!existsSync(scratchRoot)) {
      verification.scratchRemoved = true;
      return;
    }
    let children: string[];
    try {
      children = readdirSync(scratchRoot).filter((entry) => entry !== OWNERSHIP_FILE);
    } catch (error) {
      diagnostics.push(
        createDiagnostic(
          'CLEANUP_IO_FAILED',
          `Owned scratch root ${scratchRoot} could not be enumerated: ${(error as Error).message}`,
          { context: { ...context, path: scratchRoot } },
        ),
      );
      recreateRecoveryLease();
      return;
    }
    for (const child of children) {
      try {
        removePath(path.join(scratchRoot, child));
      } catch (error) {
        diagnostics.push(
          createDiagnostic(
            'CLEANUP_IO_FAILED',
            `Owned scratch entry under ${scratchRoot} could not be removed: ${(error as Error).message}`,
            { context: { ...context, path: scratchRoot } },
          ),
        );
        recreateRecoveryLease();
        return;
      }
    }
    // Final commit: delete the ownership record last, then the empty root. If
    // the root cannot be removed, preserve/recreate the recovery lease.
    try {
      const ownershipPath = ownershipRecordPathFor(runId);
      if (existsSync(ownershipPath)) removePath(ownershipPath);
      rmdirSync(scratchRoot);
    } catch (error) {
      diagnostics.push(
        createDiagnostic(
          'CLEANUP_IO_FAILED',
          `Owned scratch root ${scratchRoot} could not be removed: ${(error as Error).message}`,
          { context: { ...context, path: scratchRoot } },
        ),
      );
      recreateRecoveryLease();
      return;
    }
    verification.scratchRemoved = !existsSync(scratchRoot);
  }

  let detail = 'Owned run resources removed.';
  if (!verification.processDead) {
    detail = `Owned process group ${String(active.processGroupId)} is still alive after termination.`;
  } else if (!verification.portClosed) {
    detail = `Owned port ${active.port} is still open after terminating process group ${String(active.processGroupId)}.`;
  } else if (!verification.distDirRemoved) {
    detail = keepDistDir
      ? `Owned distDir ${active.repoRelativeDistDir} was retained by --keep-dist-dir; cleanup is not complete.`
      : `Owned distDir ${active.repoRelativeDistDir} could not be removed.`;
  } else if (!verification.scratchRemoved) {
    detail = `Owned scratch root ${scratchRoot} could not be removed.`;
  } else if (!verification.configRestored) {
    detail = restore.detail;
  } else if (!verification.browserClosed) {
    detail = `Owned browser could not be closed: ${browserCleanup?.detail ?? 'unknown close failure'}.`;
  }

  const complete =
    verification.processDead &&
    verification.portClosed &&
    verification.distDirRemoved &&
    verification.scratchRemoved &&
    verification.configRestored &&
    verification.browserClosed &&
    verification.evidencePreserved &&
    !keepDistDir;

  return {
    schemaVersion: CLEANUP_RESULT_SCHEMA_VERSION,
    runId,
    attempted: true,
    complete,
    alreadyClean: false,
    refusedReason: null,
    detail,
    verification,
    diagnostics,
  };
}
