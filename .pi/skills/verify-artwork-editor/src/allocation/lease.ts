import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  RunAllocationFailure,
  RunOwnershipRecord,
  RunOwnershipState,
} from '../contracts/runtime';
import {
  RUN_OWNERSHIP_RECORD_SCHEMA_VERSION,
  REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION,
} from '../contracts/schema-versions';
import { OWNED_CONFIG_FILES } from '../runtime/config-snapshot';
import {
  isSafeRunId,
  isVerifiableRepositoryRoot,
  repoRelativeDistDir,
  resolveRepoRoot,
  resolveSkillRoot,
} from '../runtime/paths';
import { evidenceBaseDir, evidenceRunRoot } from '../runtime/evidence-root';
import { ownershipProcessFieldsProblem } from './process-identity';

/**
 * Cross-process run ownership lease (specification 10, Gate D).
 *
 * The scratch directory is created without `recursive` so the filesystem itself
 * is the exclusive lease: a second allocation of the same run id fails with
 * `EEXIST` instead of attaching to the owner. The durable ownership record is
 * the only authority cleanup may act on, and it is only ever acted on when every
 * derived path matches exactly.
 */

export const SCRATCH_PREFIX = 'makeit-artwork-verification-';
export const OWNERSHIP_FILE = 'ownership.json';

export function scratchRootFor(runId: string): string {
  return path.join(os.tmpdir(), `${SCRATCH_PREFIX}${runId}`);
}

export function ownershipRecordPathFor(runId: string): string {
  return path.join(scratchRootFor(runId), OWNERSHIP_FILE);
}

export function evidenceRootFor(runId: string): string {
  return evidenceRunRoot(evidenceBaseDir(), runId);
}

export function expectedDistDirFor(
  runId: string,
  repositoryRoot: string = resolveRepoRoot(),
): string {
  return path.join(repositoryRoot, repoRelativeDistDir(runId));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isProcessGroupAlive(processGroupId: number): boolean {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readOwnershipRecord(runId: string): RunOwnershipRecord | null {
  const recordPath = ownershipRecordPathFor(runId);
  if (!existsSync(recordPath)) return null;
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8')) as RunOwnershipRecord;
  } catch {
    return null;
  }
}

export function writeOwnershipRecord(record: RunOwnershipRecord): void {
  mkdirSync(record.scratchRoot, { recursive: true });
  writeFileSync(
    path.join(record.scratchRoot, OWNERSHIP_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

export function updateOwnershipRecord(
  runId: string,
  patch: Partial<RunOwnershipRecord> & { state?: RunOwnershipState },
): RunOwnershipRecord | null {
  const current = readOwnershipRecord(runId);
  if (!current) return null;
  const next: RunOwnershipRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeOwnershipRecord(next);
  return next;
}

/**
 * Structural verification of the recorded shared-config snapshot.
 *
 * The snapshot lives in attacker-writable scratch state and cleanup writes it
 * back, so every recorded path must be one this toolkit derives for this
 * repository and run id: an owned relative path, its exact absolute repository
 * location, and a snapshot copy at the exact scratch location. A malformed or
 * unowned entry refuses cleanup instead of redirecting a file write.
 */
export function repoConfigSnapshotProblem(record: {
  repoRoot: string;
  scratchRoot: string;
  repoConfigSnapshot: RunOwnershipRecord['repoConfigSnapshot'];
}): string | null {
  const snapshot = record.repoConfigSnapshot;
  if (snapshot === null) return null;
  if (snapshot.schemaVersion !== REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION) {
    return `unsupported shared config snapshot schema version ${String(snapshot.schemaVersion)}`;
  }

  const seen = new Set<string>();
  for (const file of snapshot.files) {
    if (!(OWNED_CONFIG_FILES as readonly string[]).includes(file.relativePath)) {
      return `recorded shared config path "${file.relativePath}" is not owned by this toolkit`;
    }
    if (seen.has(file.relativePath)) {
      return `recorded shared config path "${file.relativePath}" is duplicated`;
    }
    seen.add(file.relativePath);
    if (file.path !== path.join(record.repoRoot, file.relativePath)) {
      return `recorded shared config path for "${file.relativePath}" is outside this repository`;
    }
    if (!file.existedBefore) {
      if (file.snapshotPath !== null || file.digestBefore !== null) {
        return `recorded shared config entry for "${file.relativePath}" claims no pre-run file but records snapshot bytes`;
      }
      continue;
    }
    if (file.snapshotPath !== path.join(record.scratchRoot, `${file.relativePath}.before`)) {
      return `recorded shared config snapshot for "${file.relativePath}" is outside this run's scratch root`;
    }
    if (typeof file.digestBefore !== 'string' || file.digestBefore.length === 0) {
      return `recorded shared config snapshot for "${file.relativePath}" has no pre-run digest`;
    }
  }
  return null;
}

/**
 * Structural verification of the recorded owned-repository (application) root
 * and its derived Next output path (ADR 0119).
 *
 * `record.repoRoot` is read back from attacker-influenceable scratch state, so
 * it is accepted only when:
 *
 *  - it is an absolute, normalized, existing directory (`isVerifiableRepositoryRoot`);
 *  - it is exactly the independently supplied `expectedAppRoot` (the validated,
 *    canonical application checkout the operator selected for this run, or the
 *    toolkit repository root for a legacy internal caller); and
 *  - the recorded `distDir` is exactly derived from that root and the run id.
 *
 * A product-meaning provider is a preflight compatibility test, not cleanup
 * authority: a provider-bearing foreign checkout that the record was edited to
 * name must still be refused because it is not the expected root. Evidence and
 * the skill remain toolkit-owned and are verified independently.
 */
export function repositoryRootProblem(
  record: {
    runId: string;
    repoRoot: string;
    distDir: string;
  },
  expectedAppRoot: string,
): string | null {
  if (!isVerifiableRepositoryRoot(record.repoRoot)) {
    return 'recorded repository root is not a verifiable absolute application directory';
  }
  if (record.repoRoot !== expectedAppRoot) {
    return 'recorded repository root is not the expected application root supplied for this run';
  }
  if (record.distDir !== expectedDistDirFor(record.runId, record.repoRoot)) {
    return 'recorded distDir is not derived from the recorded repository root';
  }
  return null;
}

/**
 * Verifies that a persisted record only ever describes resources this toolkit
 * derived for the same run and the independently supplied application root.
 * Cleanup refuses anything else.
 *
 * `expectedAppRoot` is the validated, canonical root supplied by the caller
 * boundary (the explicit `--app-root` for Diagnostic/public recovery, or the
 * toolkit repository root for a legacy internal caller). It is never inferred
 * from the record or from a mutable global.
 */
export function ownershipRecordIsVerifiable(
  record: RunOwnershipRecord | null,
  expectedAppRoot: string = resolveRepoRoot(),
): boolean {
  if (!record) return false;
  if (record.owner !== 'verify-artwork-editor') return false;
  if (!isSafeRunId(record.runId)) return false;
  if (record.schemaVersion !== RUN_OWNERSHIP_RECORD_SCHEMA_VERSION) return false;
  if (record.skillRoot !== resolveSkillRoot()) return false;
  if (record.scratchRoot !== scratchRootFor(record.runId)) return false;
  if (record.evidenceRoot !== evidenceRootFor(record.runId)) return false;
  if (record.repoRelativeDistDir !== repoRelativeDistDir(record.runId)) return false;
  if (repositoryRootProblem(record, expectedAppRoot) !== null) return false;
  // The process fields are attacker-writable scratch state: a record whose
  // pid/process group/owned command is malformed can never authorize cleanup.
  if (ownershipProcessFieldsProblem(record) !== null) return false;
  // So is the shared-config snapshot, which cleanup writes back to disk.
  if (repoConfigSnapshotProblem(record) !== null) return false;
  return true;
}

/**
 * Same-run parallel case admission. The run owns exactly one active case until
 * the case reaches a terminal state and releases its slot.
 */
export function admitCase(
  runId: string,
  caseId: string,
  expectedAppRoot: string = resolveRepoRoot(),
): { ok: true; record: RunOwnershipRecord } | RunAllocationFailure {
  const record = readOwnershipRecord(runId);
  if (!ownershipRecordIsVerifiable(record, expectedAppRoot)) {
    return {
      ok: false,
      reason: 'OWNERSHIP_UNKNOWN',
      detail: `No verifiable owned run state exists for run id ${runId}.`,
    };
  }
  if (record?.activeCase !== null) {
    return {
      ok: false,
      reason: 'SAME_RUN_CASE_ACTIVE',
      detail: `Run ${runId} already has an active case "${record?.activeCase}". Same-run parallel cases are rejected.`,
    };
  }
  const updated = updateOwnershipRecord(runId, { activeCase: caseId });
  return { ok: true, record: updated as RunOwnershipRecord };
}

export function releaseCase(runId: string): void {
  updateOwnershipRecord(runId, { activeCase: null });
}

/** True when a persisted record claims this run and its process group is alive. */
export function runIsLiveOwned(
  runId: string,
  expectedAppRoot: string = resolveRepoRoot(),
): boolean {
  const record = readOwnershipRecord(runId);
  if (!ownershipRecordIsVerifiable(record, expectedAppRoot)) return false;
  if (record?.state !== 'launched') return false;
  return record.processGroupId !== null && isProcessGroupAlive(record.processGroupId);
}
