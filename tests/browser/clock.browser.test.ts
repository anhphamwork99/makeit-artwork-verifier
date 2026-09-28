import { describe, expect, it } from 'vitest';

import type { BrowserSession } from '../../src/browser/launch';
import {
  WALL_CLOCK_NAMESPACE,
  WALL_CLOCK_PROVIDER_ID,
  openFreshPage,
  validateWallClockBaseline,
} from '../../src/browser/launch';
import { closeBrowserSession } from '../../src/browser/doctor';
import type { EnvironmentCell } from '../../src/contracts/runtime';

/**
 * Honest fixed wall-clock contract (ADR 0017 R3).
 *
 * Proves that Playwright 1.59.1 `page.clock.setFixedTime()` pins only
 * wall-calendar reads before any document/application script runs, while real
 * scheduling (`performance.now`, zero/positive-delay timers, RAF) keeps
 * advancing without manual clock advancement. A paused fake clock or a global
 * `Date` monkey patch would fail every scheduling assertion here.
 */

const BASELINE_UTC = '2026-01-02T03:04:05.000Z';
const BASELINE_EPOCH_MS = 1_767_323_045_000;

const ENVIRONMENT: EnvironmentCell = {
  cellId: 'chromium-desktop-clock-honesty',
  classification: 'required-credit',
  browserKind: 'chromium',
  browserChannel: 'bundled',
  playwrightVersion: '1.59.1',
  viewport: { width: 640, height: 480 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'no-preference',
  permissions: [],
  geolocation: null,
  storageState: null,
};

const DOCUMENT_URL =
  'data:text/html,<html><body><div id="probe">clock</div><script>window.__firstAppScriptDateNow = Date.now();</script></body></html>';

describe('[ADR 0017 R3] honest Playwright fixed wall clock', () => {
  it('validates exact canonical UTC baselines and rejects every lossy form', () => {
    expect(validateWallClockBaseline(BASELINE_UTC)).toEqual({
      ok: true,
      utc: BASELINE_UTC,
      epochMs: BASELINE_EPOCH_MS,
    });
    const rejected: unknown[] = [
      '2026-01-02T03:04:05Z',
      '2026-01-02T03:04:05.00Z',
      '2026-01-02T03:04:05.000+00:00',
      '2026-01-02 03:04:05.000Z',
      'not-a-date',
      '',
      123456789,
      null,
      undefined,
      '9999-99-99T99:99:99.999Z',
    ];
    for (const value of rejected) {
      expect(validateWallClockBaseline(value).ok, String(value)).toBe(false);
    }
  });

  it('keeps Date fixed at the declared epoch while scheduling advances honestly', async () => {
    let session: BrowserSession | null = null;
    try {
      session = await openFreshPage({
        baseUrl: '',
        route: DOCUMENT_URL,
        environment: ENVIRONMENT,
        wallClockBaselineUtc: BASELINE_UTC,
      });
      const { page } = session;

      expect(WALL_CLOCK_PROVIDER_ID).toBe('playwright-clock-fixed-wall-v1');
      expect(WALL_CLOCK_NAMESPACE).toBe('crossword.create.date-now.v1');

      // The toolkit's outer deadline is measured with Node-side monotonic time,
      // never the page wall clock.
      const nodeStart = performance.now();

      const facts = await page.evaluate(async () => {
        const firstAppScript = (window as unknown as Record<string, unknown>)
          .__firstAppScriptDateNow as number | undefined;
        const t0 = Date.now();
        const p0 = performance.now();

        const rafTimestamps: number[] = [];
        const rafProgressed = new Promise<number[]>((resolve) => {
          requestAnimationFrame((first) => {
            rafTimestamps.push(first);
            requestAnimationFrame((second) => {
              rafTimestamps.push(second);
              resolve(rafTimestamps);
            });
          });
        });
        let zeroDelayExecuted = false;
        const zeroDelayDone = new Promise<number>((resolve) => {
          setTimeout(() => {
            zeroDelayExecuted = true;
            resolve(performance.now());
          }, 0);
        });
        let positiveDelayExecuted = false;
        const positiveDelayDone = new Promise<number>((resolve) => {
          setTimeout(() => {
            positiveDelayExecuted = true;
            resolve(performance.now());
          }, 25);
        });

        await new Promise((resolve) => setTimeout(resolve, 10));
        const p1 = performance.now();
        const [raf, zeroDelayAt, positiveDelayAt] = await Promise.all([
          rafProgressed,
          zeroDelayDone,
          positiveDelayDone,
        ]);
        const t1 = Date.now();
        return {
          firstAppScript,
          t0,
          t1,
          p0,
          p1,
          raf,
          zeroDelayExecuted,
          positiveDelayExecuted,
          zeroDelayAt,
          positiveDelayAt,
        };
      });

      // Wall-calendar reads never move off the declared epoch. The inline
      // application script ran at document parse time, i.e. after the clock was
      // installed and before any product code, and already saw the epoch.
      expect(facts.firstAppScript).toBe(BASELINE_EPOCH_MS);
      expect(facts.t0).toBe(BASELINE_EPOCH_MS);
      expect(facts.t1).toBe(BASELINE_EPOCH_MS);

      // Real execution advances monotonic time and both timers fire. A
      // zero-delay timer may complete inside the same performance tick, so
      // execution (not sub-millisecond ordering) is the honest assertion.
      expect(facts.p1).toBeGreaterThan(facts.p0);
      expect(facts.zeroDelayExecuted).toBe(true);
      expect(facts.positiveDelayExecuted).toBe(true);
      expect(facts.zeroDelayAt).toBeGreaterThanOrEqual(facts.p0);
      expect(facts.positiveDelayAt).toBeGreaterThanOrEqual(facts.p0 + 20);

      // At least two RAF callbacks execute with strictly increasing timestamps.
      expect(facts.raf.length).toBe(2);
      expect(facts.raf[1]).toBeGreaterThan(facts.raf[0]);

      // Node-side monotonic deadline actually elapses while the page clock is
      // frozen.
      const nodeElapsed = performance.now() - nodeStart;
      expect(nodeElapsed).toBeGreaterThan(0);
      expect(await page.evaluate(() => Date.now())).toBe(BASELINE_EPOCH_MS);
    } finally {
      if (session !== null) {
        await closeBrowserSession(session);
      }
    }
  });
});
