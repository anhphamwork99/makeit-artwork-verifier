import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import { isSafeRunId } from '../runtime/paths';

const PLAN_VERSION = 1;
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface ReleaseShardWorkItemV1 {
  readonly order: number;
  readonly entryId: string;
  readonly cellId: string;
  readonly instanceId: string;
  readonly runId: string;
}

export interface ReleaseShardAssignmentV1 {
  readonly shardIndex: number;
  readonly orders: readonly number[];
}

export interface LocalReleaseShardPlanV1 {
  readonly schemaVersion: 1;
  readonly manifestFingerprint: string;
  readonly shardCount: number;
  readonly items: readonly ReleaseShardWorkItemV1[];
  readonly assignments: readonly ReleaseShardAssignmentV1[];
  readonly fingerprint: string;
}

export interface LocalReleaseShardReceiptV1 {
  readonly schemaVersion: 1;
  readonly planFingerprint: string;
  readonly shardIndex: number;
  readonly status: 'complete' | 'cancelled';
  readonly items: readonly ReleaseShardWorkItemV1[];
}

export type LocalReleaseShardRefusalCode =
  | 'INPUT_INVALID'
  | 'PLAN_INVALID'
  | 'RECEIPTS_INVALID'
  | 'SHARD_MISSING'
  | 'SHARD_DUPLICATE'
  | 'SHARD_CANCELLED'
  | 'SHARD_CONTENT_MISMATCH';

export type LocalReleaseShardPlanResult =
  | { readonly ok: true; readonly plan: LocalReleaseShardPlanV1 }
  | { readonly ok: false; readonly code: LocalReleaseShardRefusalCode };

export type LocalReleaseShardReconstructionResult =
  | {
      readonly ok: true;
      readonly manifestFingerprint: string;
      readonly planFingerprint: string;
      readonly items: readonly ReleaseShardWorkItemV1[];
    }
  | { readonly ok: false; readonly code: LocalReleaseShardRefusalCode };

/**
 * Deterministically partition a complete, already-authorized work list. This
 * helper proves schedule structure only; it does not verify authority or grant
 * Release credit.
 */
export function createLocalReleaseShardPlan(input: {
  readonly manifestFingerprint: string;
  readonly items: readonly ReleaseShardWorkItemV1[];
  readonly shardCount: number;
}): LocalReleaseShardPlanResult {
  if (!isValidInput(input)) return { ok: false, code: 'INPUT_INVALID' };

  const items = input.items.map((item) => ({ ...item }));
  const assignments = Array.from({ length: input.shardCount }, (_, shardIndex) => ({
    shardIndex,
    orders: items
      .filter((item) => item.order % input.shardCount === shardIndex)
      .map((item) => item.order),
  }));
  const identity = {
    schemaVersion: PLAN_VERSION,
    manifestFingerprint: input.manifestFingerprint,
    shardCount: input.shardCount,
    items,
    assignments,
  } as const;

  return {
    ok: true,
    plan: { ...identity, fingerprint: digest(identity) },
  };
}

/** Reconstruct the canonical global list from one complete receipt per shard. */
export function reconstructLocalReleaseShards(
  plan: LocalReleaseShardPlanV1,
  receipts: readonly LocalReleaseShardReceiptV1[],
): LocalReleaseShardReconstructionResult {
  if (!isValidPlan(plan)) return { ok: false, code: 'PLAN_INVALID' };
  if (!Array.isArray(receipts)) return { ok: false, code: 'RECEIPTS_INVALID' };

  const byShard = new Map<number, LocalReleaseShardReceiptV1>();
  for (const receipt of receipts) {
    if (!isValidReceiptShape(receipt) || receipt.planFingerprint !== plan.fingerprint) {
      return { ok: false, code: 'RECEIPTS_INVALID' };
    }
    if (receipt.shardIndex < 0 || receipt.shardIndex >= plan.shardCount) {
      return { ok: false, code: 'RECEIPTS_INVALID' };
    }
    if (byShard.has(receipt.shardIndex)) return { ok: false, code: 'SHARD_DUPLICATE' };
    byShard.set(receipt.shardIndex, receipt);
  }

  if (byShard.size !== plan.shardCount) return { ok: false, code: 'SHARD_MISSING' };

  const reconstructed = new Array<ReleaseShardWorkItemV1>(plan.items.length);
  for (const assignment of plan.assignments) {
    const receipt = byShard.get(assignment.shardIndex);
    if (!receipt) return { ok: false, code: 'SHARD_MISSING' };
    if (receipt.status !== 'complete') return { ok: false, code: 'SHARD_CANCELLED' };
    if (receipt.items.length !== assignment.orders.length) {
      return { ok: false, code: 'SHARD_CONTENT_MISMATCH' };
    }

    for (let index = 0; index < assignment.orders.length; index += 1) {
      const order = assignment.orders[index];
      const actual = receipt.items[index];
      const expected = plan.items[order];
      if (
        !actual ||
        !expected ||
        actual.order !== order ||
        canonicalize(actual) !== canonicalize(expected)
      ) {
        return { ok: false, code: 'SHARD_CONTENT_MISMATCH' };
      }
      reconstructed[order] = { ...actual };
    }
  }

  if (reconstructed.some((item) => item === undefined)) {
    return { ok: false, code: 'SHARD_CONTENT_MISMATCH' };
  }
  return {
    ok: true,
    manifestFingerprint: plan.manifestFingerprint,
    planFingerprint: plan.fingerprint,
    items: reconstructed,
  };
}

function isValidInput(value: unknown): value is {
  readonly manifestFingerprint: string;
  readonly items: readonly ReleaseShardWorkItemV1[];
  readonly shardCount: number;
} {
  if (!isRecordWithKeys(value, ['manifestFingerprint', 'items', 'shardCount'])) return false;
  if (typeof value.manifestFingerprint !== 'string' || !SHA256_HEX.test(value.manifestFingerprint))
    return false;
  if (
    typeof value.shardCount !== 'number' ||
    !Number.isSafeInteger(value.shardCount) ||
    value.shardCount < 1
  )
    return false;
  if (
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.shardCount > value.items.length
  )
    return false;

  const pairs = new Set<string>();
  const instances = new Set<string>();
  const runs = new Set<string>();
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    if (!isValidWorkItem(item) || item.order !== index) return false;
    const pair = `${item.entryId}\0${item.cellId}`;
    if (pairs.has(pair) || instances.has(item.instanceId) || runs.has(item.runId)) return false;
    pairs.add(pair);
    instances.add(item.instanceId);
    runs.add(item.runId);
  }
  return true;
}

function isValidPlan(value: unknown): value is LocalReleaseShardPlanV1 {
  if (
    !isRecordWithKeys(value, [
      'schemaVersion',
      'manifestFingerprint',
      'shardCount',
      'items',
      'assignments',
      'fingerprint',
    ])
  )
    return false;
  if (value.schemaVersion !== PLAN_VERSION || typeof value.fingerprint !== 'string') return false;
  const input = {
    manifestFingerprint: value.manifestFingerprint,
    items: value.items,
    shardCount: value.shardCount,
  };
  if (!isValidInput(input)) return false;
  const expected = createLocalReleaseShardPlan(input);
  return expected.ok && canonicalize(expected.plan) === canonicalize(value);
}

function isValidReceiptShape(value: unknown): value is LocalReleaseShardReceiptV1 {
  return (
    isRecordWithKeys(value, [
      'schemaVersion',
      'planFingerprint',
      'shardIndex',
      'status',
      'items',
    ]) &&
    value.schemaVersion === PLAN_VERSION &&
    typeof value.planFingerprint === 'string' &&
    SHA256_HEX.test(value.planFingerprint) &&
    Number.isSafeInteger(value.shardIndex) &&
    (value.status === 'complete' || value.status === 'cancelled') &&
    Array.isArray(value.items) &&
    value.items.every(isValidWorkItem)
  );
}

function isValidWorkItem(value: unknown): value is ReleaseShardWorkItemV1 {
  return (
    isRecordWithKeys(value, ['order', 'entryId', 'cellId', 'instanceId', 'runId']) &&
    typeof value.order === 'number' &&
    Number.isSafeInteger(value.order) &&
    value.order >= 0 &&
    isSafeLabel(value.entryId) &&
    isSafeLabel(value.cellId) &&
    typeof value.instanceId === 'string' &&
    SAFE_INSTANCE_ID.test(value.instanceId) &&
    isSafeRunId(value.runId)
  );
}

function isSafeLabel(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0/\\]/.test(value)
  );
}

function isRecordWithKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function digest(value: unknown): string {
  return sha256Hex(
    `makeit.verify-artwork-editor/local-release-shard-plan/v1\n${canonicalize(value)}`,
  );
}
