import { canonicalize, sha256Hex } from '../canonical/canonicalize';

export const GOVERNANCE_TIMING_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_TIMING_METHOD = 'node-performance-now-v1' as const;

export interface GovernanceTimingV1 {
  readonly schemaVersion: typeof GOVERNANCE_TIMING_SCHEMA_VERSION;
  readonly method: typeof GOVERNANCE_TIMING_METHOD;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly elapsedMs: number;
  readonly measurementDigest: string;
}

type UnsignedGovernanceTiming = Omit<GovernanceTimingV1, 'measurementDigest'>;

function digest(unsigned: UnsignedGovernanceTiming): string {
  return sha256Hex(`makeit.verify-artwork-editor/governance-timing/v1\n${canonicalize(unsigned)}`);
}

/** Creates a closed measurement; a decreasing/reset monotonic clock is unavailable. */
export function createGovernanceTiming(input: {
  readonly monotonicStart: number;
  readonly monotonicEnd: number;
  readonly wallStart: string;
  readonly wallEnd: string;
}): GovernanceTimingV1 | null {
  const elapsedMs = input.monotonicEnd - input.monotonicStart;
  const unsigned: UnsignedGovernanceTiming = {
    schemaVersion: GOVERNANCE_TIMING_SCHEMA_VERSION,
    method: GOVERNANCE_TIMING_METHOD,
    startedAt: input.wallStart,
    endedAt: input.wallEnd,
    elapsedMs,
  };
  if (
    !Number.isFinite(input.monotonicStart) ||
    !Number.isFinite(input.monotonicEnd) ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    Object.is(elapsedMs, -0) ||
    !isIsoTimestamp(input.wallStart) ||
    !isIsoTimestamp(input.wallEnd)
  )
    return null;
  return { ...unsigned, measurementDigest: digest(unsigned) };
}

export function isGovernanceTiming(value: unknown): value is GovernanceTimingV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== 6 ||
    !keys.every(
      (key) =>
        typeof key === 'string' &&
        [
          'schemaVersion',
          'method',
          'startedAt',
          'endedAt',
          'elapsedMs',
          'measurementDigest',
        ].includes(key),
    ) ||
    record.schemaVersion !== GOVERNANCE_TIMING_SCHEMA_VERSION ||
    record.method !== GOVERNANCE_TIMING_METHOD ||
    typeof record.startedAt !== 'string' ||
    !isIsoTimestamp(record.startedAt) ||
    typeof record.endedAt !== 'string' ||
    !isIsoTimestamp(record.endedAt) ||
    typeof record.elapsedMs !== 'number' ||
    !Number.isFinite(record.elapsedMs) ||
    record.elapsedMs < 0 ||
    Object.is(record.elapsedMs, -0) ||
    typeof record.measurementDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.measurementDigest)
  )
    return false;
  const unsigned: UnsignedGovernanceTiming = {
    schemaVersion: GOVERNANCE_TIMING_SCHEMA_VERSION,
    method: GOVERNANCE_TIMING_METHOD,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    elapsedMs: record.elapsedMs,
  };
  return digest(unsigned) === record.measurementDigest;
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
