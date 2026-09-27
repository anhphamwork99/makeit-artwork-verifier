import { describe, expect, it } from 'vitest';

import { createGovernanceTiming, isGovernanceTiming } from '../../src/contracts/governance-timing';

describe('governance timing', () => {
  it('binds a monotonic elapsed duration independently from wall chronology', () => {
    const measured = createGovernanceTiming({
      monotonicStart: 5,
      monotonicEnd: 17.5,
      wallStart: '2026-09-26T10:00:00.000Z',
      wallEnd: '2026-09-26T09:00:00.000Z',
    });

    expect(measured?.elapsedMs).toBe(12.5);
    expect(measured?.startedAt).toBe('2026-09-26T10:00:00.000Z');
    expect(measured?.endedAt).toBe('2026-09-26T09:00:00.000Z');
    expect(isGovernanceTiming(measured)).toBe(true);
  });

  it.each([
    { monotonicStart: 2, monotonicEnd: 1 },
    { monotonicStart: 0, monotonicEnd: -0 },
    { monotonicStart: Number.NaN, monotonicEnd: 1 },
    { monotonicStart: 0, monotonicEnd: Number.POSITIVE_INFINITY },
  ])('refuses invalid or reset monotonic clocks: %o', (clock) => {
    expect(
      createGovernanceTiming({
        ...clock,
        wallStart: '2026-09-26T10:00:00.000Z',
        wallEnd: '2026-09-26T10:00:01.000Z',
      }),
    ).toBeNull();
  });

  it('refuses missing, altered, or unknown measurement fields', () => {
    const measured = createGovernanceTiming({
      monotonicStart: 0,
      monotonicEnd: 4,
      wallStart: '2026-09-26T10:00:00.000Z',
      wallEnd: '2026-09-26T10:00:04.000Z',
    });
    expect(isGovernanceTiming({ ...measured, elapsedMs: 5 })).toBe(false);
    expect(isGovernanceTiming({ ...measured, unknown: true })).toBe(false);
    expect(isGovernanceTiming(null)).toBe(false);
  });
});
