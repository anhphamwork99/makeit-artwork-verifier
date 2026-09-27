import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { allocateRun, allocationFailureCliStatus } from '../../src/allocation/allocate';
import { ALLOCATION_FAILURE_REASONS } from '../../src/contracts/discriminants';
import { DIAGNOSTIC_SEVERITY } from '../../src/contracts/diagnostics';
import {
  admitCase,
  evidenceRootFor,
  expectedDistDirFor,
  readOwnershipRecord,
  releaseCase,
  scratchRootFor,
  updateOwnershipRecord,
} from '../../src/allocation/lease';
import {
  hasRunPortReservation,
  releaseAllRunPortReservations,
  releaseRunPortReservation,
  reserveLoopbackPort,
  runPortReservationPort,
} from '../../src/allocation/port-reservation';
import { cleanupRun } from '../../src/cleanup/cleanup';
import { REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { classifyOutcome } from '../../src/runtime/outcomes';
import { occupyPort, removeTestRunArtifacts, uniqueRunId } from './helpers';

const activeRunIds: string[] = [];

function trackedRunId(prefix: string): string {
  const runId = uniqueRunId(prefix);
  activeRunIds.push(runId);
  return runId;
}

afterEach(async () => {
  await releaseAllRunPortReservations();
  for (const runId of activeRunIds.splice(0)) {
    removeTestRunArtifacts(runId);
  }
});

describe('[Gate D] enforceable exclusive run allocation (TS-2/TS-4)', () => {
  it('allocates two independent runs with disjoint exclusive resources', async () => {
    const first = await allocateRun({ runId: trackedRunId('vt-a') });
    const second = await allocateRun({ runId: trackedRunId('vt-b') });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('fixture allocation failed');

    const a = first.allocation;
    const b = second.allocation;
    expect(a.port).not.toBe(b.port);
    expect(a.distDir).not.toBe(b.distDir);
    expect(a.scratchRoot).not.toBe(b.scratchRoot);
    expect(a.evidenceRoot).not.toBe(b.evidenceRoot);
    expect(a.routeNamespace).not.toBe(b.routeNamespace);
    expect(a.storageNamespace).not.toBe(b.storageNamespace);
    expect(a.repoRelativeDistDir).toBe(`.next/verify-runs/${a.runId}`);
    expect(existsSync(a.scratchRoot)).toBe(true);
    expect(readOwnershipRecord(a.runId)?.owner).toBe('verify-artwork-editor');
  });

  it('refuses an invalid run id and a re-used run id without touching the owner', async () => {
    const invalid = await allocateRun({ runId: '../escape' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toBe('RUN_ID_INVALID');

    const runId = trackedRunId('vt-dup');
    const first = await allocateRun({ runId });
    expect(first.ok).toBe(true);
    const before = readOwnershipRecord(runId);

    const second = await allocateRun({ runId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('SCRATCH_ROOT_OCCUPIED');
    expect(readOwnershipRecord(runId)).toEqual(before);
  });

  it('classifies an unavailable app port as prelaunch ENVIRONMENT_FAILURE', async () => {
    const occupied = await occupyPort();
    try {
      const result = await allocateRun({
        runId: trackedRunId('vt-port'),
        requestedPort: occupied.port,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('PORT_UNAVAILABLE');
        expect(allocationFailureCliStatus(result.reason)).toBe('ENVIRONMENT_FAILURE');
      }
    } finally {
      await occupied.close();
    }
    expect(allocationFailureCliStatus('RUN_ID_INVALID')).toBe('HARNESS_BLOCKED');
    expect(allocationFailureCliStatus('SCRATCH_ROOT_OCCUPIED')).toBe('HARNESS_BLOCKED');
  });

  it('keeps the allocation-reason and diagnostic vocabularies separate (ADR 0027 §1.1)', () => {
    expect(ALLOCATION_FAILURE_REASONS).toContain('OWNERSHIP_RECORD_INVALID');
    expect(ALLOCATION_FAILURE_REASONS).not.toContain('RUN_OWNERSHIP_RECORD_INVALID');
    // The public diagnostic code is retained for the CLI boundary mapping.
    expect(DIAGNOSTIC_SEVERITY.RUN_OWNERSHIP_RECORD_INVALID).toBe('blocking');
  });

  it('refuses an unknown/non-empty distDir without deleting it', async () => {
    const runId = trackedRunId('vt-dist');
    const distDir = expectedDistDirFor(runId);
    mkdirSync(distDir, { recursive: true });
    const marker = path.join(distDir, 'unknown-owner.txt');
    writeFileSync(marker, 'not ours\n');

    const result = await allocateRun({ runId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('DIST_DIR_OCCUPIED');
    expect(existsSync(marker)).toBe(true);
  });

  it('refuses a live-owned collision without signalling or deleting the owner', async () => {
    const runId = trackedRunId('vt-live');
    const first = await allocateRun({ runId });
    expect(first.ok).toBe(true);

    // A detached child is its own process group: a genuine live owner.
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const ownerGroup = owner.pid;
    if (ownerGroup === undefined) throw new Error('owner process did not report a pid');
    owner.unref();

    try {
      updateOwnershipRecord(runId, {
        state: 'launched',
        processGroupId: ownerGroup,
        processPid: ownerGroup,
        ownedCommand: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
      });
      const liveRecord = readOwnershipRecord(runId);

      const second = await allocateRun({ runId });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe('SCRATCH_ROOT_OCCUPIED');
      expect(readOwnershipRecord(runId)).toEqual(liveRecord);
      // The owner's recorded process group is still alive: we never signalled it.
      expect(process.kill(-ownerGroup, 0)).toBe(true);
    } finally {
      process.kill(-ownerGroup, 'SIGKILL');
    }
  });

  it('refuses an occupied evidence root', async () => {
    const runId = trackedRunId('vt-evidence');
    mkdirSync(evidenceRootFor(runId), { recursive: true });
    const result = await allocateRun({ runId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EVIDENCE_ROOT_OCCUPIED');
  });

  it('rejects a second case in the same run until the active case releases', async () => {
    const runId = trackedRunId('vt-case');
    const allocation = await allocateRun({ runId });
    expect(allocation.ok).toBe(true);

    expect(admitCase(runId, 'case-one').ok).toBe(true);
    const parallel = admitCase(runId, 'case-two');
    expect(parallel.ok).toBe(false);
    if (!parallel.ok) expect(parallel.reason).toBe('SAME_RUN_CASE_ACTIVE');

    releaseCase(runId);
    expect(admitCase(runId, 'case-two').ok).toBe(true);
  });
});

describe('[Gate D] owned cleanup and recovery (TS-5)', () => {
  it('refuses unknown ownership without killing or deleting anything', async () => {
    const runId = trackedRunId('vt-unknown');
    const result = await cleanupRun(runId);
    expect(result.attempted).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.refusedReason).toBe('OWNERSHIP_UNKNOWN');
  });

  it('removes only owned scratch/distDir, verifies port closure, and preserves evidence', async () => {
    const runId = trackedRunId('vt-clean');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');
    const distDir = expectedDistDirFor(runId);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'build-output.txt'), 'owned\n');
    mkdirSync(evidenceRootFor(runId), { recursive: true });
    writeFileSync(path.join(evidenceRootFor(runId), 'doctor.json'), '{}\n');

    const result = await cleanupRun(runId);

    expect(result.attempted).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.verification.processDead).toBe(true);
    expect(result.verification.portClosed).toBe(true);
    expect(result.verification.distDirRemoved).toBe(true);
    expect(result.verification.scratchRemoved).toBe(true);
    expect(result.verification.evidencePreserved).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    expect(existsSync(distDir)).toBe(false);
    expect(existsSync(path.join(evidenceRootFor(runId), 'doctor.json'))).toBe(true);
  });

  it('refuses a tampered ownership record instead of destroying resources', async () => {
    const runId = trackedRunId('vt-tamper');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');
    const otherRunId = trackedRunId('vt-other');
    mkdirSync(expectedDistDirFor(otherRunId), { recursive: true });
    writeFileSync(path.join(expectedDistDirFor(otherRunId), 'keep.txt'), 'keep\n');

    // The durable record now claims resources derived from a different run id.
    updateOwnershipRecord(runId, { distDir: expectedDistDirFor(otherRunId) });

    const result = await cleanupRun(runId);
    expect(result.attempted).toBe(false);
    expect(result.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(existsSync(path.join(expectedDistDirFor(otherRunId), 'keep.txt'))).toBe(true);
    rmSync(expectedDistDirFor(otherRunId), { recursive: true, force: true });
  });

  it('recovers an interrupted run by terminating only its exact owned process group', async () => {
    const runId = trackedRunId('vt-recover');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const orphanGroup = orphan.pid;
    if (orphanGroup === undefined) throw new Error('orphan process did not report a pid');
    orphan.unref();

    updateOwnershipRecord(runId, {
      state: 'launched',
      processGroupId: orphanGroup,
      processPid: orphanGroup,
      ownedCommand: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    });
    mkdirSync(expectedDistDirFor(runId), { recursive: true });
    writeFileSync(path.join(expectedDistDirFor(runId), 'build.txt'), 'owned\n');
    mkdirSync(evidenceRootFor(runId), { recursive: true });
    writeFileSync(path.join(evidenceRootFor(runId), 'result.json'), '{}\n');

    const cleanup = await cleanupRun(runId);
    expect(cleanup.attempted).toBe(true);
    expect(cleanup.complete).toBe(true);
    expect(cleanup.verification.processSignalled).toBe(orphanGroup);
    expect(cleanup.verification.processDead).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    expect(existsSync(expectedDistDirFor(runId))).toBe(false);
    expect(existsSync(path.join(evidenceRootFor(runId), 'result.json'))).toBe(true);
    expect(() => process.kill(-orphanGroup, 0)).toThrow();
  }, 20_000);

  it('prevents PASS when mandatory cleanup fails while preserving the behavior result', async () => {
    const runId = trackedRunId('vt-cleanup-fail');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    // Simulate the owned server still holding its port when cleanup runs.
    // The record stays an allocated (unlaunched) run, so only port closure is
    // unmet and the run genuinely reports an incomplete cleanup.
    const occupied = await occupyPort();
    updateOwnershipRecord(runId, { port: occupied.port });
    try {
      const cleanup = await cleanupRun(runId);
      expect(cleanup.complete).toBe(false);
      expect(cleanup.verification.portClosed).toBe(false);

      const behaviorChecks = [
        { checkId: 'doctor.route', passed: true },
        { checkId: 'doctor.bridge.version', passed: true },
      ];
      const finalOutcome = classifyOutcome({
        requiredChecks: behaviorChecks,
        cleanupSucceeded: cleanup.complete,
      });

      expect(finalOutcome).toBe('ENVIRONMENT_FAILURE');
      // The behavior result itself is preserved diagnostically.
      expect(behaviorChecks.every((check) => check.passed)).toBe(true);
    } finally {
      await occupied.close();
    }
  }, 20_000);
});

interface OwnedChild {
  pid: number;
  kill: () => void;
}

function spawnOwnedChild(script: string): OwnedChild {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('owned child did not report a pid');
  child.unref();
  return {
    pid,
    kill: () => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    },
  };
}

describe('[Gate D] run-scoped port reservation (F2)', () => {
  it('holds a real loopback reservation until handoff/cleanup instead of releasing it during allocation', async () => {
    const runId = trackedRunId('vt-port-hold');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    // A real listener is held: the exact reserved port cannot be re-bound.
    expect(hasRunPortReservation(runId)).toBe(true);
    expect(runPortReservationPort(runId)).toBe(allocation.allocation.port);
    await expect(occupyPort(allocation.allocation.port)).rejects.toThrow();

    // Cleanup releases it and the same port becomes bindable again.
    const cleanup = await cleanupRun(runId);
    expect(cleanup.complete).toBe(true);
    expect(hasRunPortReservation(runId)).toBe(false);
    const relisten = await occupyPort(allocation.allocation.port);
    await relisten.close();
  }, 20_000);

  it('releases the reservation when the ownership record cannot be established', async () => {
    const runId = trackedRunId('vt-port-fail');
    let releasedPort: number | null = null;

    const result = await allocateRun(
      {
        runId,
        recordWriter: () => {
          throw new Error('injected ownership write failure');
        },
      },
      async (requestedPort) => {
        const reserved = await reserveLoopbackPort(requestedPort);
        if (reserved.ok) releasedPort = reserved.reservation.port;
        return reserved;
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an allocation refusal');
    // ADR 0027 §1.1: the allocation reason vocabulary is restored; the CLI
    // boundary maps it to the RUN_OWNERSHIP_RECORD_INVALID diagnostic.
    expect(result.reason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(allocationFailureCliStatus(result.reason)).toBe('HARNESS_BLOCKED');
    expect(releasedPort).not.toBeNull();
    expect(hasRunPortReservation(runId)).toBe(false);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    // The port released by the failed allocation is immediately reclaimable.
    const relisten = await occupyPort(releasedPort ?? 0);
    await relisten.close();
  }, 20_000);

  it('releases a held reservation even when cleanup refuses unknown ownership', async () => {
    const runId = trackedRunId('vt-port-refuse');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    expect(hasRunPortReservation(runId)).toBe(true);
    // Tamper the record so ownership is refused; the reservation is still freed.
    updateOwnershipRecord(runId, { distDir: '/tmp/not-ours' });
    const cleanup = await cleanupRun(runId);
    expect(cleanup.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(hasRunPortReservation(runId)).toBe(false);
    expect(await releaseRunPortReservation(runId)).toBe(false);
  }, 20_000);
});

describe('[Gate D] structured cleanup diagnostics (F3/F4)', () => {
  it('preserves config and owned paths when the process group remains alive after termination', async () => {
    const runId = trackedRunId('vt-still-live');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');
    const distDir = expectedDistDirFor(runId);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'build.txt'), 'owned\n');
    updateOwnershipRecord(runId, {
      state: 'launched',
      processPid: 424_242,
      processGroupId: 424_242,
      ownedCommand: [process.execPath, 'owned-next'],
    });

    const cleanup = await cleanupRun(runId, {
      verifyProcessIdentity: () => ({
        ok: true,
        live: {
          pid: 424_242,
          processGroupId: 424_242,
          command: `${process.execPath} owned-next`,
        },
      }),
      terminateGroup: async () => ({
        signalled: 424_242,
        escalated: true,
        dead: false,
        refused: null,
      }),
      processIsAlive: () => true,
      removePath: () => {
        throw new Error('owned paths must not be removed while process remains alive');
      },
      // Sharing the config snapshot is a write; it must never happen while the
      // owned dev server may still be rewriting those files.
      restoreConfig: () => {
        throw new Error('config must not be restored while the process remains alive');
      },
    });

    expect(cleanup.attempted).toBe(true);
    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.processDead).toBe(false);
    expect(cleanup.verification.distDirRemoved).toBe(false);
    expect(cleanup.verification.scratchRemoved).toBe(false);
    expect(cleanup.verification.configRestored).toBe(false);
    expect(cleanup.detail).toContain('preserved for recovery');
    expect(existsSync(distDir)).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(true);
  }, 20_000);

  it('refuses a tampered shared-config snapshot instead of writing outside the repository', async () => {
    const runId = trackedRunId('vt-config-tamper');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    // A tampered record points the snapshot at an unowned file. Restoring it
    // would overwrite an arbitrary path, so cleanup must refuse everything.
    const victimPath = path.join(scratchRootFor(runId), 'not-a-repo-file.txt');
    mkdirSync(scratchRootFor(runId), { recursive: true });
    writeFileSync(victimPath, 'must stay\n');
    updateOwnershipRecord(runId, {
      repoConfigSnapshot: {
        schemaVersion: REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION,
        files: [
          {
            relativePath: 'tsconfig.json',
            path: victimPath,
            existedBefore: true,
            digestBefore: 'f'.repeat(64),
            snapshotPath: path.join(allocation.allocation.scratchRoot, 'tsconfig.json.before'),
          },
        ],
      },
    });

    const cleanup = await cleanupRun(runId);

    expect(cleanup.attempted).toBe(false);
    expect(cleanup.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(cleanup.verification.configRestored).toBe(false);
    // The unowned victim file was never written to.
    expect(readFileSync(victimPath, 'utf8')).toBe('must stay\n');
  }, 20_000);

  it('returns structured diagnostics instead of throwing when an owned path cannot be removed', async () => {
    const runId = trackedRunId('vt-io');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');
    const distDir = expectedDistDirFor(runId);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'build.txt'), 'owned\n');

    const cleanup = await cleanupRun(runId, {
      removePath: (target) => {
        if (target === distDir) throw new Error('EACCES: injected removal failure');
        rmSync(target, { recursive: true, force: true });
      },
    });

    expect(cleanup.attempted).toBe(true);
    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.distDirRemoved).toBe(false);
    expect(cleanup.diagnostics.map((entry) => entry.code)).toContain('CLEANUP_IO_FAILED');
    const ioDiagnostic = cleanup.diagnostics.find((entry) => entry.code === 'CLEANUP_IO_FAILED');
    expect(ioDiagnostic?.detail).toContain('injected removal failure');
    expect(existsSync(distDir)).toBe(true);
  }, 20_000);

  it('never reports complete while --keep-dist-dir retains owned output', async () => {
    const runId = trackedRunId('vt-keep');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');
    const distDir = expectedDistDirFor(runId);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'build.txt'), 'owned\n');

    const cleanup = await cleanupRun(runId, { removeDistDir: false });

    expect(cleanup.attempted).toBe(true);
    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.distDirRemoved).toBe(false);
    expect(cleanup.diagnostics.map((entry) => entry.code)).toContain('CLEANUP_INCOMPLETE');
    expect(existsSync(distDir)).toBe(true);

    // A retained distDir can never yield a PASS even with perfect behavior.
    const finalOutcome = classifyOutcome({
      requiredChecks: [{ checkId: 'doctor.route', passed: true }],
      cleanupSucceeded: cleanup.complete,
    });
    expect(finalOutcome).toBe('ENVIRONMENT_FAILURE');
  }, 20_000);

  it('does not report complete when the browser context/browser could not be closed', async () => {
    const runId = trackedRunId('vt-browser-close');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    const cleanup = await cleanupRun(runId, {
      browserCleanup: { closed: false, detail: 'browser close failed: injected' },
    });

    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.browserClosed).toBe(false);
    expect(cleanup.diagnostics.map((entry) => entry.code)).toContain('BROWSER_CLEANUP_FAILED');
  }, 20_000);
});

describe('[Gate D] ownership identity verification before destructive cleanup (F5)', () => {
  it('refuses a live process whose recorded process group does not match its live group', async () => {
    const runId = trackedRunId('vt-pgid');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    const first = spawnOwnedChild('setInterval(() => {}, 1000)');
    const second = spawnOwnedChild('setInterval(() => {}, 1000)');
    try {
      updateOwnershipRecord(runId, {
        state: 'launched',
        processPid: first.pid,
        processGroupId: second.pid,
        ownedCommand: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      });

      const cleanup = await cleanupRun(runId);
      expect(cleanup.attempted).toBe(false);
      expect(cleanup.refusedReason).toBe('PROCESS_GROUP_UNVERIFIABLE');
      expect(cleanup.diagnostics.map((entry) => entry.code)).toContain(
        'CLEANUP_OWNERSHIP_AMBIGUOUS',
      );
      // Neither live process was signalled.
      expect(process.kill(first.pid, 0)).toBe(true);
      expect(process.kill(second.pid, 0)).toBe(true);
    } finally {
      first.kill();
      second.kill();
    }
  }, 20_000);

  it('refuses a tampered owned command that does not match the live process', async () => {
    const runId = trackedRunId('vt-cmd');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    const owner = spawnOwnedChild('setInterval(() => {}, 1000)');
    try {
      updateOwnershipRecord(runId, {
        state: 'launched',
        processPid: owner.pid,
        processGroupId: owner.pid,
        ownedCommand: ['/bin/echo', 'not', 'the', 'owned', 'command'],
      });

      const cleanup = await cleanupRun(runId);
      expect(cleanup.attempted).toBe(false);
      expect(cleanup.refusedReason).toBe('PROCESS_GROUP_UNVERIFIABLE');
      expect(process.kill(owner.pid, 0)).toBe(true);
    } finally {
      owner.kill();
    }
  }, 20_000);

  it('refuses structurally malformed process fields without touching anything', async () => {
    const runId = trackedRunId('vt-struct');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    updateOwnershipRecord(runId, { processPid: -5, processGroupId: -5 });

    const cleanup = await cleanupRun(runId);
    expect(cleanup.attempted).toBe(false);
    expect(cleanup.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(cleanup.diagnostics).toEqual([]);
  }, 20_000);
});
