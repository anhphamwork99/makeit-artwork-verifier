import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalize, sha256Hex } from '../../src/canonical/canonicalize';
import { createGovernanceTiming } from '../../src/contracts/governance-timing';
import type {
  ReleaseRunEventV1,
  ReleaseWorkSlotV1,
  VerifiedBudgetPreflightV1,
} from '../../src/contracts/release-runtime';
import {
  appendReleaseEvent,
  appendReleaseEventV2,
  createReleaseLedger,
  createReleaseLedgerV2,
  readReleaseLedger,
  ReleaseLedgerError,
} from '../../src/governance/release-ledger';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { resolveToolkitRoot } from '../../src/runtime/paths';

const roots: string[] = [];

function testRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), 'release-ledger-')));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testCell() {
  return resolveEnvironmentCell(loadEnvironmentCatalogue({ rootDir: resolveToolkitRoot() }));
}

function slots(): readonly ReleaseWorkSlotV1[] {
  return [
    {
      order: 0,
      entryId: 'entry-1',
      cell: testCell(),
      instanceId: 'instance-1',
      runId: 'run-1',
    },
  ];
}

const LIFECYCLE_ID = `manifest-${'1'.repeat(64)}`;
const ACTIVE_DIGEST = sha256Hex('active-lifecycle-event');

function v1Predeclaration(): ReleaseRunEventV1 {
  return {
    type: 'run-predeclared',
    lifecycleId: LIFECYCLE_ID,
    activeEventDigest: ACTIVE_DIGEST,
    slots: slots(),
    shardPlanFingerprint: sha256Hex('shard-plan'),
  };
}

function verifiedPreflight(): VerifiedBudgetPreflightV1 {
  return {
    releaseCredit: false,
    policyApprovalId: `budget-policy-${'b'.repeat(64)}`,
    policyDigest: sha256Hex('policy-bytes'),
    approvalDigest: sha256Hex('approval-bytes'),
    reviewDigest: sha256Hex('review-bytes'),
    measurementSetId: `bset-${'c'.repeat(64)}`,
    measurementSetContentDigest: sha256Hex('set-content'),
    method: 'full-scope-envelope-v1',
    methodVersion: 1,
    ceilings: {
      releaseDurationMs: 1,
      releaseEvidenceBytes: 1,
      qualificationDurationMs: 1,
      qualificationEvidenceBytes: 1,
      retainedEvidenceBytes: 1,
      imageTornRecaptures: null,
    },
    limitations: ['family:text:UNAVAILABLE'],
    manifestId: 'manifest-00000000000000000000000000000000',
    manifestFingerprint: sha256Hex('manifest-fingerprint'),
    requiredCellId: 'cell-1',
    sourceProvenanceDigest: sha256Hex('source-provenance'),
    basis: {
      measurementSetContentDigest: sha256Hex('set-content'),
      retentionAuditId: 'retention-1',
      retentionAuditDigest: sha256Hex('retention-audit'),
    },
  };
}

function eventFile(
  root: string,
  family: 'release-runs' | 'manifest-lifecycle',
  id: string,
  seq: number,
) {
  return path.join(
    root,
    `evidence/governance/${family}/${id}/events/event-${String(seq).padStart(6, '0')}.json`,
  );
}

function unsignedDigest(record: Record<string, unknown>): string {
  const { digest: _ignored, ...unsigned } = record;
  return sha256Hex(canonicalize(unsigned));
}

describe('closed Release governance ledger versions (WP5-A, ADR 0112)', () => {
  it('reads a V1 lifecycle and a V1 run chain unchanged with exact canonical digests', () => {
    const root = testRoot();
    const batchId = 'qbatch-00000000-0000-0000-0000-000000000000';
    createReleaseLedger(root, LIFECYCLE_ID, {
      type: 'APPROVED_FROZEN',
      manifest: {} as never,
      draftBytesDigest: sha256Hex('draft'),
      batchId,
      batchFingerprint: sha256Hex('batch'),
      qualificationLedgerDigest: sha256Hex('qualification'),
      approvalId: 'approval-1',
      approvalBytesDigest: sha256Hex('approval'),
      proposalBytesDigest: sha256Hex('proposal'),
      reviewBytesDigests: [sha256Hex('review')],
      work: [{ entryId: 'entry-1', cellId: testCell().cellId }],
    });
    appendReleaseEvent(root, LIFECYCLE_ID, {
      type: 'ACTIVE',
      frozenEventDigest: sha256Hex('frozen'),
    });
    const lifecycle = readReleaseLedger(root, LIFECYCLE_ID);
    expect(lifecycle.map((record) => record.schemaVersion)).toEqual([1, 1]);
    expect(lifecycle.map((record) => record.event.type)).toEqual(['APPROVED_FROZEN', 'ACTIVE']);
    expect(lifecycle[0]?.digest).toBe(
      unsignedDigest(lifecycle[0] as unknown as Record<string, unknown>),
    );

    const runId = 'release-run-1';
    createReleaseLedger(root, runId, v1Predeclaration());
    appendReleaseEvent(root, runId, { type: 'run-started', lifecycleDigest: ACTIVE_DIGEST });
    appendReleaseEvent(root, runId, {
      type: 'run-assessed',
      state: 'INTERRUPTED',
      unstartedOrders: [0],
      releaseCreditGranted: false,
    });
    const run = readReleaseLedger(root, runId);
    expect(run.map((record) => record.schemaVersion)).toEqual([1, 1, 1]);
    expect(run.map((record) => record.event.type)).toEqual([
      'run-predeclared',
      'run-started',
      'run-assessed',
    ]);
    for (const record of run)
      expect(record.digest).toBe(unsignedDigest(record as unknown as Record<string, unknown>));
  });

  it('round-trips a V2 budget-bound run chain with exact canonical digests', () => {
    const root = testRoot();
    const runId = 'release-run-2';
    const created = createReleaseLedgerV2(root, runId, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    expect(created.schemaVersion).toBe(2);
    expect(created.digest).toBe(unsignedDigest(created as unknown as Record<string, unknown>));
    const started = appendReleaseEventV2(root, runId, {
      type: 'run-started',
      lifecycleDigest: ACTIVE_DIGEST,
    });
    expect(started.schemaVersion).toBe(2);
    appendReleaseEventV2(root, runId, {
      type: 'run-assessed',
      state: 'BUDGET_TERMINATED',
      unstartedOrders: [0],
      releaseCreditGranted: false,
    });
    const records = readReleaseLedger(root, runId);
    expect(records.map((record) => record.schemaVersion)).toEqual([2, 2, 2]);
    expect(records.at(-1)?.event).toMatchObject({
      type: 'run-assessed',
      state: 'BUDGET_TERMINATED',
      releaseCreditGranted: false,
    });
    const first = records[0]?.event;
    if (!first || first.type !== 'run-predeclared' || !('budget' in first))
      throw new Error('missing bound V2 predeclaration');
    expect(first.budget).toEqual(verifiedPreflight());
    for (const record of records)
      expect(record.digest).toBe(unsignedDigest(record as unknown as Record<string, unknown>));
  });

  it('allows a complete V2 run to record no credit yet refuses credit on a non-complete state', () => {
    const root = testRoot();
    const runId = 'release-run-credit-direction';
    createReleaseLedgerV2(root, runId, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    appendReleaseEventV2(root, runId, {
      type: 'run-started',
      lifecycleDigest: ACTIVE_DIGEST,
    });
    // A structurally complete run is not automatically credit: terminal credit is
    // independently corroborated at readback, so a complete run may persist false.
    appendReleaseEventV2(root, runId, {
      type: 'run-assessed',
      state: 'COMPLETE_ALL_PASS',
      unstartedOrders: [],
      releaseCreditGranted: false,
    });
    expect(readReleaseLedger(root, runId).at(-1)?.event).toMatchObject({
      type: 'run-assessed',
      state: 'COMPLETE_ALL_PASS',
      releaseCreditGranted: false,
    });

    // Credit can never be recorded for a non-complete / terminated terminal state.
    const forgedRoot = testRoot();
    const forgedRun = 'release-run-credit-forged';
    createReleaseLedgerV2(forgedRoot, forgedRun, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    appendReleaseEventV2(forgedRoot, forgedRun, {
      type: 'run-started',
      lifecycleDigest: ACTIVE_DIGEST,
    });
    expect(() =>
      appendReleaseEventV2(forgedRoot, forgedRun, {
        type: 'run-assessed',
        state: 'BUDGET_TERMINATED',
        unstartedOrders: [0],
        releaseCreditGranted: true,
      }),
    ).toThrow(ReleaseLedgerError);
  });

  it('refuses a silent mixed-version append in either direction', () => {
    const root = testRoot();
    const v1Run = 'release-run-mixed-v1';
    createReleaseLedger(root, v1Run, v1Predeclaration());
    expect(() =>
      appendReleaseEventV2(root, v1Run, { type: 'run-started', lifecycleDigest: ACTIVE_DIGEST }),
    ).toThrow(ReleaseLedgerError);
    expect(readReleaseLedger(root, v1Run)).toHaveLength(1);

    const v2Run = 'release-run-mixed-v2';
    createReleaseLedgerV2(root, v2Run, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    expect(() =>
      appendReleaseEvent(root, v2Run, { type: 'run-started', lifecycleDigest: ACTIVE_DIGEST }),
    ).toThrow(ReleaseLedgerError);
    expect(readReleaseLedger(root, v2Run)).toHaveLength(1);
  });

  it('refuses an unknown ledger version', () => {
    const root = testRoot();
    const runId = 'release-run-unknown';
    createReleaseLedger(root, runId, v1Predeclaration());
    const file = eventFile(root, 'release-runs', runId, 1);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const unknown = {
      schemaVersion: 3,
      ledgerId: runId,
      sequence: 1,
      previousDigest: null,
      event: record.event,
    };
    writeFileSync(file, `${canonicalize({ ...unknown, digest: unsignedDigest(unknown) })}\n`);
    expect(() => readReleaseLedger(root, runId)).toThrow(ReleaseLedgerError);
  });

  it('refuses a V2 record whose bound budget or canonical digest was tampered', () => {
    const root = testRoot();
    const runId = 'release-run-tamper';
    createReleaseLedgerV2(root, runId, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    const file = eventFile(root, 'release-runs', runId, 1);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    // A changed policy digest with a stale record digest refuses.
    const staleDigest = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    (
      (staleDigest.event as Record<string, unknown>).budget as Record<string, unknown>
    ).policyDigest = '9'.repeat(64);
    writeFileSync(file, `${canonicalize(staleDigest)}\n`);
    expect(() => readReleaseLedger(root, runId)).toThrow(ReleaseLedgerError);
    // A recomputed digest still refuses an unsupported bound method.
    const recomputed = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    ((recomputed.event as Record<string, unknown>).budget as Record<string, unknown>).method =
      'unknown-method-v9';
    writeFileSync(file, `${canonicalize({ ...recomputed, digest: unsignedDigest(recomputed) })}\n`);
    expect(() => readReleaseLedger(root, runId)).toThrow(ReleaseLedgerError);
  });

  it('accepts a pending V2 provisional record and refuses non-pending, credit-granting or unordered ones (ADR 0113)', () => {
    function predeclared(root: string, runId: string): void {
      createReleaseLedgerV2(root, runId, {
        type: 'run-predeclared',
        lifecycleId: LIFECYCLE_ID,
        activeEventDigest: ACTIVE_DIGEST,
        slots: slots(),
        shardPlanFingerprint: sha256Hex('shard-plan'),
        budget: verifiedPreflight(),
      });
      appendReleaseEventV2(root, runId, {
        type: 'run-started',
        lifecycleDigest: ACTIVE_DIGEST,
      });
    }
    const root = testRoot();
    const runId = 'release-run-provisional';
    predeclared(root, runId);
    appendReleaseEventV2(root, runId, {
      type: 'run-provisional',
      completedOrders: [],
      unstartedOrders: [0],
      pending: true,
      releaseCreditGranted: false,
    });
    expect(readReleaseLedger(root, runId).at(-1)?.event).toMatchObject({
      type: 'run-provisional',
      completedOrders: [],
      unstartedOrders: [0],
      pending: true,
      releaseCreditGranted: false,
    });
    // A provisional that is not pending, claims credit, or carries a non-ascending
    // suffix can never be a closed V2 record.
    for (const [index, bad] of [
      { completedOrders: [], unstartedOrders: [0], pending: false, releaseCreditGranted: false },
      { completedOrders: [], unstartedOrders: [0], pending: true, releaseCreditGranted: true },
      { completedOrders: [1, 0], unstartedOrders: [0], pending: true, releaseCreditGranted: false },
    ].entries()) {
      const badRoot = testRoot();
      const badRun = `release-run-provisional-bad-${index}`;
      predeclared(badRoot, badRun);
      expect(() =>
        appendReleaseEventV2(badRoot, badRun, {
          type: 'run-provisional',
          ...bad,
        } as never),
      ).toThrow(ReleaseLedgerError);
    }
  });

  it('keeps every written event file as one canonical JSON record plus a single LF', () => {
    const root = testRoot();
    const runId = 'release-run-bytes';
    createReleaseLedgerV2(root, runId, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    const directory = path.join(root, 'evidence/governance/release-runs', runId, 'events');
    for (const name of readdirSync(directory).sort()) {
      const bytes = readFileSync(path.join(directory, name), 'utf8');
      expect(bytes.endsWith('\n')).toBe(true);
      expect(bytes.slice(0, -1).includes('\n')).toBe(false);
      expect(`${canonicalize(JSON.parse(bytes))}\n`).toBe(bytes);
    }
  });
});

describe('V2 terminal field and digest binding (WP5-C, C9/C10)', () => {
  function terminalChain(root: string, runId: string): void {
    createReleaseLedgerV2(root, runId, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    appendReleaseEventV2(root, runId, {
      type: 'run-started',
      lifecycleDigest: ACTIVE_DIGEST,
    });
    appendReleaseEventV2(root, runId, {
      type: 'run-provisional',
      completedOrders: [0],
      unstartedOrders: [],
      pending: true,
      releaseCreditGranted: false,
    });
    const timing = createGovernanceTiming({
      monotonicStart: 0,
      monotonicEnd: 10,
      wallStart: '2026-09-26T12:00:00.000Z',
      wallEnd: '2026-09-26T12:00:01.000Z',
    });
    if (!timing) throw new Error('fixture timing invalid');
    appendReleaseEventV2(root, runId, {
      type: 'run-assessed',
      state: 'COMPLETE_ALL_PASS',
      unstartedOrders: [],
      releaseCreditGranted: false,
      timing,
    });
  }

  it('binds every terminal field into the canonical record digest and refuses a raw tamper', () => {
    const root = testRoot();
    const runId = 'release-run-terminal-binding';
    terminalChain(root, runId);
    const file = eventFile(root, 'release-runs', runId, 4);
    const original = readFileSync(file, 'utf8');
    const mutations: ((event: Record<string, unknown>) => void)[] = [
      (event) => {
        event.state = 'BUDGET_TERMINATED';
      },
      (event) => {
        event.unstartedOrders = [0];
      },
      (event) => {
        event.releaseCreditGranted = true;
      },
      (event) => {
        delete event.timing;
      },
      (event) => {
        (event.timing as Record<string, unknown>).elapsedMs = 1;
      },
      (event) => {
        (event.timing as Record<string, unknown>).measurementDigest = '9'.repeat(64);
      },
    ];
    for (const mutate of mutations) {
      writeFileSync(file, original);
      const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      mutate(record.event as Record<string, unknown>);
      // Keep the stale record digest: the canonical chain digest must refuse.
      writeFileSync(file, `${canonicalize(record)}\n`);
      expect(() => readReleaseLedger(root, runId)).toThrow(ReleaseLedgerError);
    }
    writeFileSync(file, original);
    expect(readReleaseLedger(root, runId)).toHaveLength(4);
  });

  it('refuses a non-ascending terminal remainder while still reading a timing-less terminal shape', () => {
    const root = testRoot();
    const runId = 'release-run-terminal-suffix';
    terminalChain(root, runId);
    // A terminal remainder that is not strictly ascending is structurally refused.
    // (Joining the remainder to the predeclared ordered slots is the runtime
    // reader's responsibility, exercised in `release-runtime.test.ts`.)
    const file = eventFile(root, 'release-runs', runId, 4);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    (record.event as Record<string, unknown>).unstartedOrders = [2, 1];
    writeFileSync(file, `${canonicalize({ ...record, digest: unsignedDigest(record) })}\n`);
    expect(() => readReleaseLedger(root, runId)).toThrow(ReleaseLedgerError);

    // A terminal whose timing is absent is a retained invalid-clock shape and
    // remains structurally readable (it can never be a creditable durable run).
    const timingLessRoot = testRoot();
    const timingLessRun = 'release-run-terminal-no-timing';
    createReleaseLedgerV2(timingLessRoot, timingLessRun, {
      type: 'run-predeclared',
      lifecycleId: LIFECYCLE_ID,
      activeEventDigest: ACTIVE_DIGEST,
      slots: slots(),
      shardPlanFingerprint: sha256Hex('shard-plan'),
      budget: verifiedPreflight(),
    });
    appendReleaseEventV2(timingLessRoot, timingLessRun, {
      type: 'run-started',
      lifecycleDigest: ACTIVE_DIGEST,
    });
    appendReleaseEventV2(timingLessRoot, timingLessRun, {
      type: 'run-assessed',
      state: 'INTERRUPTED',
      unstartedOrders: [0],
      releaseCreditGranted: false,
      timingFailureCode: 'TIMING_INVALID',
    });
    expect(readReleaseLedger(timingLessRoot, timingLessRun).at(-1)?.event).toMatchObject({
      type: 'run-assessed',
      state: 'INTERRUPTED',
      timingFailureCode: 'TIMING_INVALID',
    });
  });
});
