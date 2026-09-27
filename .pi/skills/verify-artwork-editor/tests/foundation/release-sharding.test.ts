import { describe, expect, it } from 'vitest';

import {
  createLocalReleaseShardPlan,
  reconstructLocalReleaseShards,
  type LocalReleaseShardPlanV1,
  type LocalReleaseShardReceiptV1,
  type ReleaseShardWorkItemV1,
} from '../../src/governance/release-sharding';

const MANIFEST_FINGERPRINT = 'a'.repeat(64);

function workItems(count = 7): ReleaseShardWorkItemV1[] {
  return Array.from({ length: count }, (_, order) => ({
    order,
    entryId: `entry-${order}`,
    cellId: 'chromium-desktop',
    instanceId: `instance-${order}`,
    runId: `release-${order}`,
  }));
}

function createPlan(items = workItems(), shardCount = 3): LocalReleaseShardPlanV1 {
  const result = createLocalReleaseShardPlan({
    manifestFingerprint: MANIFEST_FINGERPRINT,
    items,
    shardCount,
  });
  if (!result.ok) throw new Error(`fixture plan rejected: ${result.code}`);
  return result.plan;
}

function receiptsFor(plan: LocalReleaseShardPlanV1): LocalReleaseShardReceiptV1[] {
  return plan.assignments.map((assignment) => ({
    schemaVersion: 1,
    planFingerprint: plan.fingerprint,
    shardIndex: assignment.shardIndex,
    status: 'complete',
    items: assignment.orders.map((order) => plan.items[order]),
  }));
}

describe('local Release sharding', () => {
  it('partitions exactly once and reconstructs the original global order', () => {
    const items = workItems();
    const plan = createPlan(items, 3);
    const receipts = receiptsFor(plan);

    expect(plan.assignments.map(({ orders }) => orders)).toEqual([
      [0, 3, 6],
      [1, 4],
      [2, 5],
    ]);
    expect(
      receipts
        .flatMap(({ items: shardItems }) => shardItems.map(({ order }) => order))
        .sort((a, b) => a - b),
    ).toEqual(items.map(({ order }) => order));
    expect(reconstructLocalReleaseShards(plan, receipts)).toEqual({
      ok: true,
      manifestFingerprint: MANIFEST_FINGERPRINT,
      planFingerprint: plan.fingerprint,
      items,
    });
  });

  it('is deterministic across repeated calls and object-key authoring order', () => {
    const reordered = workItems().map(({ order, entryId, cellId, instanceId, runId }) => ({
      runId,
      instanceId,
      cellId,
      entryId,
      order,
    }));
    const first = createLocalReleaseShardPlan({
      manifestFingerprint: MANIFEST_FINGERPRINT,
      items: workItems(),
      shardCount: 4,
    });
    const second = createLocalReleaseShardPlan({
      manifestFingerprint: MANIFEST_FINGERPRINT,
      items: reordered,
      shardCount: 4,
    });

    expect(first).toEqual(second);
  });

  it('rejects empty, noncanonical, duplicate, unsafe, and malformed inputs', () => {
    const base = workItems();
    const attempt = (items: ReleaseShardWorkItemV1[], shardCount = 3) =>
      createLocalReleaseShardPlan({ manifestFingerprint: MANIFEST_FINGERPRINT, items, shardCount });

    expect(attempt([])).toEqual({ ok: false, code: 'INPUT_INVALID' });
    expect(attempt([...base].reverse())).toEqual({ ok: false, code: 'INPUT_INVALID' });
    expect(attempt([base[0], { ...base[1], entryId: base[0].entryId }, ...base.slice(2)])).toEqual({
      ok: false,
      code: 'INPUT_INVALID',
    });
    expect(
      attempt([
        base[0],
        { ...base[1], cellId: base[0].cellId, entryId: base[0].entryId },
        ...base.slice(2),
      ]),
    ).toEqual({ ok: false, code: 'INPUT_INVALID' });
    expect(
      attempt([base[0], { ...base[1], instanceId: base[0].instanceId }, ...base.slice(2)]),
    ).toEqual({ ok: false, code: 'INPUT_INVALID' });
    expect(attempt([base[0], { ...base[1], runId: base[0].runId }, ...base.slice(2)])).toEqual({
      ok: false,
      code: 'INPUT_INVALID',
    });
    expect(attempt([base[0], { ...base[1], runId: '../escape' }, ...base.slice(2)])).toEqual({
      ok: false,
      code: 'INPUT_INVALID',
    });
    expect(attempt([base[0], { ...base[1], cellId: 'unsafe/cell' }, ...base.slice(2)])).toEqual({
      ok: false,
      code: 'INPUT_INVALID',
    });
    expect(attempt(base, 0)).toEqual({ ok: false, code: 'INPUT_INVALID' });
    expect(attempt(base, base.length + 1)).toEqual({ ok: false, code: 'INPUT_INVALID' });
    expect(
      createLocalReleaseShardPlan({
        manifestFingerprint: 'not-a-digest',
        items: base,
        shardCount: 3,
      }),
    ).toEqual({
      ok: false,
      code: 'INPUT_INVALID',
    });
    expect(
      createLocalReleaseShardPlan({
        manifestFingerprint: MANIFEST_FINGERPRINT,
        items: base,
        shardCount: 3,
        extra: true,
      } as never),
    ).toEqual({
      ok: false,
      code: 'INPUT_INVALID',
    });
  });

  it('rejects a plan whose identity or assignment was mutated', () => {
    const plan = createPlan();
    const changedFingerprint = { ...plan, manifestFingerprint: 'b'.repeat(64) };
    const changedAssignment = {
      ...plan,
      assignments: plan.assignments.map((assignment, index) => ({
        ...assignment,
        orders: index === 0 ? [1, ...assignment.orders.slice(1)] : [...assignment.orders],
      })),
    };
    const extraField = { ...plan, authority: 'approved' };
    const receipts = receiptsFor(plan);

    expect(reconstructLocalReleaseShards(changedFingerprint, receipts)).toEqual({
      ok: false,
      code: 'PLAN_INVALID',
    });
    expect(reconstructLocalReleaseShards(changedAssignment, receipts)).toEqual({
      ok: false,
      code: 'PLAN_INVALID',
    });
    expect(reconstructLocalReleaseShards(extraField as LocalReleaseShardPlanV1, receipts)).toEqual({
      ok: false,
      code: 'PLAN_INVALID',
    });
  });

  it('rejects missing, duplicate, cancelled, foreign, and out-of-range shard receipts', () => {
    const plan = createPlan();
    const receipts = receiptsFor(plan);

    expect(reconstructLocalReleaseShards(plan, receipts.slice(1))).toEqual({
      ok: false,
      code: 'SHARD_MISSING',
    });
    expect(reconstructLocalReleaseShards(plan, [...receipts, receipts[0]])).toEqual({
      ok: false,
      code: 'SHARD_DUPLICATE',
    });
    expect(
      reconstructLocalReleaseShards(plan, [
        { ...receipts[0], status: 'cancelled' },
        ...receipts.slice(1),
      ]),
    ).toEqual({
      ok: false,
      code: 'SHARD_CANCELLED',
    });
    expect(
      reconstructLocalReleaseShards(plan, [
        { ...receipts[0], planFingerprint: 'b'.repeat(64) },
        ...receipts.slice(1),
      ]),
    ).toEqual({
      ok: false,
      code: 'RECEIPTS_INVALID',
    });
    expect(
      reconstructLocalReleaseShards(plan, [
        { ...receipts[0], shardIndex: plan.shardCount },
        ...receipts.slice(1),
      ]),
    ).toEqual({
      ok: false,
      code: 'RECEIPTS_INVALID',
    });
  });

  it('rejects missing, extra, reordered, duplicate, or identity-tampered work in a shard', () => {
    const plan = createPlan();
    const receipts = receiptsFor(plan);
    const alterFirstReceipt = (
      mutate: (items: ReleaseShardWorkItemV1[]) => ReleaseShardWorkItemV1[],
    ) => {
      return receipts.map((receipt, index) => ({
        ...receipt,
        items: index === 0 ? mutate([...receipt.items]) : [...receipt.items],
      }));
    };

    expect(
      reconstructLocalReleaseShards(
        plan,
        alterFirstReceipt((items) => items.slice(1)),
      ),
    ).toEqual({
      ok: false,
      code: 'SHARD_CONTENT_MISMATCH',
    });
    expect(
      reconstructLocalReleaseShards(
        plan,
        alterFirstReceipt((items) => [...items, items[0]]),
      ),
    ).toEqual({
      ok: false,
      code: 'SHARD_CONTENT_MISMATCH',
    });
    expect(
      reconstructLocalReleaseShards(
        plan,
        alterFirstReceipt((items) => [...items].reverse()),
      ),
    ).toEqual({
      ok: false,
      code: 'SHARD_CONTENT_MISMATCH',
    });
    expect(
      reconstructLocalReleaseShards(
        plan,
        alterFirstReceipt((items) => [{ ...items[0], runId: 'different-run' }, ...items.slice(1)]),
      ),
    ).toEqual({ ok: false, code: 'SHARD_CONTENT_MISMATCH' });
  });

  it('rejects non-closed and malformed receipt values without claiming authority', () => {
    const plan = createPlan();
    const receipts = receiptsFor(plan);
    const extraField = { ...receipts[0], outcome: 'PASS' };

    expect(
      reconstructLocalReleaseShards(plan, [
        extraField as LocalReleaseShardReceiptV1,
        ...receipts.slice(1),
      ]),
    ).toEqual({
      ok: false,
      code: 'RECEIPTS_INVALID',
    });
    expect(reconstructLocalReleaseShards(plan, null as never)).toEqual({
      ok: false,
      code: 'RECEIPTS_INVALID',
    });
  });
});
