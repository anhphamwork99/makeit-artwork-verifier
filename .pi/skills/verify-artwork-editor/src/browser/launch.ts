import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { EnvironmentCell } from '../contracts/runtime';
import { validateWallClockBaseline } from '../contracts/wall-clock';

// The honest fixed-wall-clock contract lives in `contracts/wall-clock` so the
// launcher and the generated-Crossword clock profile share one interpretation.
// Re-exported here to keep the established launcher import surface stable.
export {
  validateWallClockBaseline,
  WALL_CLOCK_NAMESPACE,
  WALL_CLOCK_PROVIDER_ID,
  WALL_CLOCK_PROVIDER_IMPLEMENTATION,
} from '../contracts/wall-clock';
export type { WallClockBaselineValidation } from '../contracts/wall-clock';

/**
 * Fresh, non-persistent Playwright browser context (specification 9.3, 10).
 *
 * Every context starts from the declared environment cell with no reused
 * `storageState`, so no cookie, storage, service worker, or draft from another
 * case can leak in. The context and browser are always closed by the caller.
 */

export interface FailedRequestRecord {
  url: string;
  error: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  consoleErrors: string[];
  failedRequests: FailedRequestRecord[];
  responseStatus: number | null;
}

export interface OpenPageOptions {
  baseUrl: string;
  route: string;
  environment: EnvironmentCell;
  navigationTimeoutMs?: number;
  /**
   * Runs after the fresh context is created and before the page exists, so a
   * case can install its owned context-level routes before any request. It never
   * receives the page and never navigates (ADR 0017 R3 installation order).
   */
  beforeNavigate?: (context: BrowserContext) => Promise<void>;
  /**
   * Governed fixed wall-clock baseline (ADR 0017 R3). When present, the exact
   * canonical UTC value is validated before launch and installed through
   * `page.clock.setFixedTime()` immediately after `newPage()` and before any
   * navigation, so product code only ever observes the declared epoch. Absent
   * for every non-clock case.
   */
  wallClockBaselineUtc?: string;
}

export async function openFreshPage(options: OpenPageOptions): Promise<BrowserSession> {
  const { environment } = options;
  const baseline =
    options.wallClockBaselineUtc === undefined
      ? null
      : validateWallClockBaseline(options.wallClockBaselineUtc);
  if (baseline !== null && !baseline.ok) {
    throw new Error(`Invalid wall-clock baseline: ${baseline.detail}`);
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { ...environment.viewport },
    deviceScaleFactor: environment.deviceScaleFactor,
    locale: environment.locale,
    timezoneId: environment.timezoneId,
    colorScheme: environment.colorScheme,
    reducedMotion: environment.reducedMotion,
    permissions: [...environment.permissions],
    ...(environment.geolocation
      ? {
          geolocation: {
            latitude: environment.geolocation.latitude,
            longitude: environment.geolocation.longitude,
          },
        }
      : {}),
  });

  if (options.beforeNavigate) {
    await options.beforeNavigate(context);
  }
  const page = await context.newPage();
  // ADR 0017 R3: install the honest fixed wall clock after the context/page
  // exist and before any navigation or product/application script can run.
  // `setFixedTime` pins wall-calendar reads while scheduling (timers, RAF,
  // `performance.now`) continues to advance against real monotonic time.
  if (baseline?.ok) {
    await page.clock.setFixedTime(new Date(baseline.epochMs));
  }
  const consoleErrors: string[] = [];
  const failedRequests: FailedRequestRecord[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? 'unknown',
    });
  });

  const response = await page.goto(`${options.baseUrl}${options.route}`, {
    waitUntil: 'domcontentloaded',
    timeout: options.navigationTimeoutMs ?? 60_000,
  });

  return {
    browser,
    context,
    page,
    consoleErrors,
    failedRequests,
    responseStatus: response?.status() ?? null,
  };
}
