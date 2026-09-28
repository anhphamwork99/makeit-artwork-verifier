/**
 * WP5 Slice 5-F — single non-extending history settlement deadline
 * (ADR 0019 R4/R10; F2 remediation).
 *
 * `settleHistory` must arm exactly one monotonic timestamp/deadline and pass the
 * remaining budget to every phase (change waiter, renderer idle, quiescence
 * watchdog). No later phase may extend the armed deadline: a watchdog/capture
 * that would run past the deadline is refused instead. These pure tests drive
 * the settlement with a deterministic fake clock and a fake runtime so the
 * budget arithmetic and the zero/near-expiry boundaries are provable without a
 * browser.
 */

import { describe, expect, it } from 'vitest';

import type { ObservationCursor, WaitForChangeOutcome } from '../../src/contracts/observation';
import {
  HISTORY_SETTLE_WATCHDOG_ATTEMPTS,
  HISTORY_SETTLE_WATCHDOG_STEP_MS,
  type HistorySettleRuntime,
  settleHistory,
} from '../../src/runtime/execute-history-plan';

function cursor(revision: number): ObservationCursor {
  return {
    schemaVersion: 3,
    documentId: 'doc-1',
    documentEpoch: 1,
    bridgeVersion: 7,
    bridgeGeneration: 1,
    revision,
  };
}

interface ChangeCall {
  revision: number;
  timeoutMs: number;
}

interface IdleCall {
  stableFrames: number;
  timeoutMs: number;
}

/**
 * A fake settlement runtime that records the exact timeout each phase received
 * and advances a deterministic clock by a caller-controlled amount per call.
 */
function fakeRuntime(input: {
  clock: { now: number };
  /** Time advanced per bridge call, in call order; last value repeats. */
  advance: number[];
  /** Scripted results; last value repeats. */
  change: Array<Partial<WaitForChangeOutcome> & { status: WaitForChangeOutcome['status'] }>;
  state: ObservationCursor | null;
}): {
  runtime: HistorySettleRuntime;
  changeCalls: ChangeCall[];
  idleCalls: IdleCall[];
} {
  const changeCalls: ChangeCall[] = [];
  const idleCalls: IdleCall[] = [];
  let changeIndex = 0;
  let advanceIndex = 0;
  const advance = (): void => {
    const step = input.advance[Math.min(advanceIndex, input.advance.length - 1)] ?? 0;
    advanceIndex += 1;
    input.clock.now += step;
  };
  const runtime: HistorySettleRuntime = {
    async waitForChange(after, timeoutMs) {
      changeCalls.push({ revision: after.revision, timeoutMs });
      advance();
      const scripted = input.change[Math.min(changeIndex, input.change.length - 1)];
      changeIndex += 1;
      return {
        status: scripted?.status ?? 'timeout',
        cursor: input.state,
        wakeSource: scripted?.wakeSource ?? 'store-signal',
        waitedMs: 0,
      } as WaitForChangeOutcome;
    },
    async waitForIdle(stableFrames, timeoutMs) {
      idleCalls.push({ stableFrames, timeoutMs });
      advance();
      return { stableFrames };
    },
    async readState() {
      return input.state === null ? null : { snapshot: {} as never, cursor: input.state };
    },
  };
  return { runtime, changeCalls, idleCalls };
}

describe('[WP5 Slice 5-F F2] single non-extending settlement deadline', () => {
  it('passes the one armed remaining budget to the waiter, idle, and watchdog', async () => {
    const clock = { now: 10_000 };
    const { runtime, changeCalls, idleCalls } = fakeRuntime({
      clock,
      // waiter consumes 900 ms; idle consumes 100 ms; each watchdog consumes 50 ms.
      advance: [900, 100, 50, 50],
      change: [
        { status: 'changed', wakeSource: 'store-signal' },
        // First watchdog proves quiescence with a timeout.
        { status: 'timeout' },
      ],
      state: cursor(2),
    });
    const result = await settleHistory(runtime, cursor(1), 5_000, () => clock.now);
    expect(result.ok).toBe(true);
    expect(result.watchdogWaits).toBe(1);

    // The waiter is armed with the full budget from the single arm timestamp.
    expect(changeCalls[0]).toEqual({ revision: 1, timeoutMs: 5_000 });
    // Renderer idle receives the budget *remaining after* the waiter, not a
    // fresh 5,000 ms.
    expect(idleCalls).toHaveLength(1);
    expect(idleCalls[0]).toEqual({ stableFrames: 3, timeoutMs: 4_100 });
    // The watchdog is capped at the remaining budget and its own step.
    expect(changeCalls[1]).toEqual({
      revision: 2,
      timeoutMs: Math.min(HISTORY_SETTLE_WATCHDOG_STEP_MS, 4_000),
    });
  });

  it('refuses a zero-budget settlement before any phase runs', async () => {
    const clock = { now: 5_000 };
    const { runtime, changeCalls, idleCalls } = fakeRuntime({
      clock,
      advance: [0],
      change: [{ status: 'changed' }],
      state: cursor(2),
    });
    const result = await settleHistory(runtime, cursor(1), 0, () => clock.now);
    expect(result.ok).toBe(false);
    expect(result.watchdogWaits).toBe(0);
    expect(result.detail).toMatch(/deadline/i);
    expect(changeCalls).toHaveLength(0);
    expect(idleCalls).toHaveLength(0);
  });

  it('does not let a slow change waiter leave budget for a fresh full idle wait', async () => {
    const clock = { now: 0 };
    const { runtime, changeCalls, idleCalls } = fakeRuntime({
      clock,
      // The waiter consumes 4,950 of the 5,000 ms budget.
      advance: [4_950, 0, 0],
      change: [{ status: 'changed', wakeSource: 'already-advanced' }, { status: 'timeout' }],
      state: cursor(2),
    });
    const result = await settleHistory(runtime, cursor(1), 5_000, () => clock.now);
    expect(changeCalls[0]?.timeoutMs).toBe(5_000);
    // Only 50 ms remains; idle must receive that remainder, never 5,000.
    expect(idleCalls[0]?.timeoutMs).toBe(50);
    expect(idleCalls[0]?.timeoutMs).toBeLessThan(5_000);
    expect(result.ok).toBe(true);
  });

  it('refuses the idle/watchdog phase once the single deadline is exhausted', async () => {
    const clock = { now: 0 };
    const { runtime, changeCalls, idleCalls } = fakeRuntime({
      clock,
      // The waiter alone burns the whole budget.
      advance: [5_000, 0],
      change: [{ status: 'changed', wakeSource: 'store-signal' }],
      state: cursor(2),
    });
    const result = await settleHistory(runtime, cursor(1), 5_000, () => clock.now);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/deadline|budget/i);
    expect(changeCalls).toHaveLength(1);
    expect(idleCalls).toHaveLength(0);
  });

  it('bounds a continuously changing watchdog to the remaining budget', async () => {
    const clock = { now: 0 };
    const { runtime, changeCalls } = fakeRuntime({
      clock,
      // The waiter and idle are free; the first watchdog consumes the whole
      // remaining budget, so the remaining attempts are refused.
      advance: [0, 0, 5_000],
      change: [
        { status: 'changed', wakeSource: 'store-signal' },
        { status: 'changed', wakeSource: 'store-signal' },
      ],
      state: cursor(2),
    });
    const result = await settleHistory(runtime, cursor(1), 5_000, () => clock.now);
    expect(result.ok).toBe(false);
    // Only the initial waiter and the first (budget-capped) watchdog ran; the
    // deadline blocked the remaining attempts.
    expect(changeCalls).toHaveLength(2);
    expect(result.watchdogWaits).toBe(1);
    // The bounded watchdog is capped at the remaining budget, not 4x400 fresh.
    expect(changeCalls[1]?.timeoutMs).toBeLessThanOrEqual(HISTORY_SETTLE_WATCHDOG_STEP_MS);
    expect(changeCalls[1]?.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(HISTORY_SETTLE_WATCHDOG_ATTEMPTS).toBe(4);
  });
});
