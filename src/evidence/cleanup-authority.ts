import type { RunOwnershipRecord, RunOwnershipState } from '../contracts/runtime';
import { toolkitRelativeSkillRoot } from '../runtime/paths';
import {
  buildEstablishedOwnership,
  ownershipRecordFingerprint,
  type PublicOwnershipEstablished,
  type PublicPathRole,
} from './public-dto';

/**
 * Runtime-only cleanup-authority snapshot (ADR 0011 R2).
 *
 * The snapshot is produced from the exact private ownership record that passed
 * ownership and live-process verification, *before* any scratch deletion. It is
 * a companion runtime value, not a field added to the private cleanup domain
 * contract, and it is never durable evidence by itself.
 *
 * It carries the exact verified record (private) plus enough allowlisted data
 * to construct the public ownership projection and the complete sensitive-root
 * registry. The ownership fingerprint is correlation provenance only; it is
 * never cleanup authority.
 */

export interface SensitiveRootEntry {
  role: PublicPathRole;
  absolutePath: string;
}

export interface CleanupAuthoritySnapshot {
  runId: string;
  capturedAt: string;
  ownershipStateBeforeCleanup: RunOwnershipState;
  ownershipFingerprint: string;
  /** Exact verified private record; retained privately for recovery. */
  exactVerifiedPrivateRecord: RunOwnershipRecord;
  publicOwnership: PublicOwnershipEstablished;
  sensitiveRoots: readonly SensitiveRootEntry[];
}

export function captureCleanupAuthoritySnapshot(
  record: RunOwnershipRecord,
): CleanupAuthoritySnapshot {
  // The public `skill-root` role is repo-relative to the *toolkit* repository
  // that owns `agents/verify-artwork-editor`, not to the application root the
  // run owns. Historical `.pi` values remain readable without becoming active
  // authority. `record.repoRoot` is the app checkout for an explicit app-root
  // run, so deriving this from `record.repoRoot` would leak a traversal and fail
  // the closed public projection. Evidence/skill identity stays toolkit-owned
  // regardless of which application was verified.
  const skillRootRelativePath = toolkitRelativeSkillRoot(record.skillRoot);
  const publicOwnership = buildEstablishedOwnership(
    record,
    record.state,
    record.repoRelativeDistDir,
    skillRootRelativePath,
  );
  return {
    runId: record.runId,
    capturedAt: new Date().toISOString(),
    ownershipStateBeforeCleanup: record.state,
    ownershipFingerprint: ownershipRecordFingerprint(record),
    exactVerifiedPrivateRecord: record,
    publicOwnership,
    sensitiveRoots: [
      { role: 'repository', absolutePath: record.repoRoot },
      { role: 'skill-root', absolutePath: record.skillRoot },
      { role: 'next-dist-dir', absolutePath: record.distDir },
      { role: 'scratch-root', absolutePath: record.scratchRoot },
      { role: 'evidence-root', absolutePath: record.evidenceRoot },
      { role: 'server-log', absolutePath: record.serverLogPath },
      ...(record.repoConfigSnapshot?.files ?? []).flatMap((file) =>
        file.snapshotPath === null
          ? []
          : [{ role: 'snapshot' as const, absolutePath: file.snapshotPath }],
      ),
    ],
  };
}

/** Every sensitive absolute path the recursive guard must reject if leaked. */
export function sensitiveGuardPaths(snapshot: CleanupAuthoritySnapshot): string[] {
  return snapshot.sensitiveRoots.map((entry) => entry.absolutePath);
}
