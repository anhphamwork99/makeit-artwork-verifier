import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import {
  expectedDistDirFor,
  ownershipRecordPathFor,
  scratchRootFor,
} from '../../src/allocation/lease';
import { cleanupRun } from '../../src/cleanup/cleanup';
import type { CleanupAuthoritySnapshot } from '../../src/evidence/cleanup-authority';
import { resolveRepoRoot } from '../../src/runtime/paths';
import { occupyPort, removeTestRunArtifacts, uniqueRunId } from './helpers';

/**
 * ADR 0011 R2/R3 — private cleanup authority retention and destruction.
 *
 * A complete cleanup destroys the private lease only after every other
 * mandatory result is verified. Every incomplete or refused cleanup preserves
 * (or recreates) the exact private record and config snapshots so recovery
 * stays possible.
 */

const created: string[] = [];

afterEach(() => {
  for (const runId of created.splice(0)) removeTestRunArtifacts(runId);
});

async function allocate(runId: string): Promise<void> {
  const allocation = await allocateRun({ runId });
  if (!allocation.ok) throw new Error(`fixture allocation failed: ${allocation.detail}`);
}

describe('ADR 0011 R2 — cleanup-authority snapshot capture', () => {
  it('captures an established snapshot before deletion and destroys the lease only after complete cleanup', async () => {
    const runId = uniqueRunId('vt-ca-complete');
    created.push(runId);
    await allocate(runId);
    mkdirSync(expectedDistDirFor(runId), { recursive: true });
    writeFileSync(path.join(expectedDistDirFor(runId), 'build.txt'), 'owned\n');

    const snapshots: CleanupAuthoritySnapshot[] = [];
    const cleanup = await cleanupRun(runId, {
      onAuthoritySnapshot: (snapshot) => snapshots.push(snapshot),
    });

    expect(cleanup.complete).toBe(true);
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0] as CleanupAuthoritySnapshot;
    expect(snapshot.publicOwnership.status).toBe('established');
    expect(snapshot.ownershipStateBeforeCleanup).toBe('allocated');
    expect(snapshot.ownershipFingerprint).toBe(snapshot.publicOwnership.ownershipFingerprint);
    expect(snapshot.sensitiveRoots.map((entry) => entry.role)).toContain('scratch-root');
    // Destruction happens only after complete cleanup.
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(false);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
  });

  it('does not capture an authority snapshot when ownership cannot be established', async () => {
    const runId = uniqueRunId('vt-ca-refused');
    created.push(runId);
    const snapshots: CleanupAuthoritySnapshot[] = [];
    const cleanup = await cleanupRun(runId, {
      onAuthoritySnapshot: (snapshot) => snapshots.push(snapshot),
    });
    expect(cleanup.attempted).toBe(false);
    expect(cleanup.refusedReason).toBe('OWNERSHIP_UNKNOWN');
    expect(snapshots).toHaveLength(0);
  });
});

describe('ADR 0011 R3 — recovery authority is preserved on incomplete cleanup', () => {
  it('preserves the lease and config snapshots when config restoration fails', async () => {
    const runId = uniqueRunId('vt-ca-config');
    created.push(runId);
    await allocate(runId);

    const cleanup = await cleanupRun(runId, {
      restoreConfig: () => ({
        restored: false,
        detail: 'injected config restore failure',
        files: [
          {
            relativePath: 'tsconfig.json',
            path: path.join(resolveRepoRoot(), 'tsconfig.json'),
            action: 'failed',
            detail: 'injected config restore failure',
          },
        ],
      }),
    });

    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.configRestored).toBe(false);
    expect(cleanup.verification.scratchRemoved).toBe(false);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(true);
  });

  it('preserves the lease when the owned port remains open', async () => {
    const runId = uniqueRunId('vt-ca-port');
    created.push(runId);
    await allocate(runId);
    const occupied = await occupyPort();
    try {
      const { updateOwnershipRecord } = await import('../../src/allocation/lease');
      updateOwnershipRecord(runId, { port: occupied.port });
      const cleanup = await cleanupRun(runId);
      expect(cleanup.complete).toBe(false);
      expect(cleanup.verification.portClosed).toBe(false);
      expect(cleanup.verification.scratchRemoved).toBe(false);
      expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
    } finally {
      await occupied.close();
    }
  }, 20_000);

  it('preserves the lease when an owned distDir cannot be removed', async () => {
    const runId = uniqueRunId('vt-ca-dist');
    created.push(runId);
    await allocate(runId);
    const distDir = expectedDistDirFor(runId);
    mkdirSync(distDir, { recursive: true });

    const cleanup = await cleanupRun(runId, {
      removePath: (target) => {
        if (target === distDir) throw new Error('injected distDir removal failure');
      },
    });

    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.distDirRemoved).toBe(false);
    expect(cleanup.verification.scratchRemoved).toBe(false);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
    expect(existsSync(distDir)).toBe(true);
  });

  it('preserves the lease when the browser cannot be closed', async () => {
    const runId = uniqueRunId('vt-ca-browser');
    created.push(runId);
    await allocate(runId);

    const cleanup = await cleanupRun(runId, {
      browserCleanup: { closed: false, detail: 'injected browser close failure' },
    });

    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.browserClosed).toBe(false);
    expect(cleanup.verification.scratchRemoved).toBe(false);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
  });

  it('preserves the lease and reports structured IO failure when a scratch child cannot be removed', async () => {
    const runId = uniqueRunId('vt-ca-child');
    created.push(runId);
    await allocate(runId);
    const scratchRoot = scratchRootFor(runId);
    writeFileSync(path.join(scratchRoot, 'extra-child.txt'), 'owned\n');

    const cleanup = await cleanupRun(runId, {
      removePath: (target) => {
        if (path.dirname(target) === scratchRoot && path.basename(target) !== 'ownership.json') {
          throw new Error('injected scratch child removal failure');
        }
        rmTarget(target);
      },
    });

    expect(cleanup.complete).toBe(false);
    expect(cleanup.verification.scratchRemoved).toBe(false);
    expect(cleanup.diagnostics.map((entry) => entry.code)).toContain('CLEANUP_IO_FAILED');
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
    expect(existsSync(scratchRoot)).toBe(true);
  });
});

function rmTarget(target: string): void {
  // Local recursive removal used by the injected seam.
  rmSync(target, { recursive: true, force: true });
}
