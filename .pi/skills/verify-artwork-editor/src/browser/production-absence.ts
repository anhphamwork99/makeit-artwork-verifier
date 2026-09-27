import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  DOCUMENT_ANCHOR_SYMBOL_KEY,
  OBSERVATION_GLOBAL_MARKER,
  PRODUCTION_ABSENCE_ROUTE,
  PRODUCTION_BROWSER_ABSENCE_SCHEMA_VERSION,
  SETUP_ANCHOR_SYMBOL_KEY,
  SETUP_BROKER_SYMBOL_KEY,
  SETUP_GLOBAL_MARKER,
  SIGNAL_ANCHOR_SYMBOL_KEY,
  evaluateProductionBrowserAbsence,
  type ProductionArtifactScan,
  type ProductionBrowserObservation,
} from '../contracts/production-absence';
import type { EnvironmentCell } from '../contracts/runtime';

/**
 * Real-Chromium production absence proof (specification 16 Gate C; TS-3/TS-4).
 *
 * Opens one fresh non-persistent Chromium context against the owned *production*
 * server, then reads the absence facts from the live page: the two seam globals,
 * the three registered-Symbol slots, and every resource the browser requested.
 * The proof is taken twice — on first load and after a reload — so a seam that
 * only appears on a fresh Document can never pass.
 *
 * The page script is a self-contained string (see the same note in
 * `browser/seam.ts`): the toolkit runs through `tsx`, whose esbuild `keepNames`
 * transform would rewrite a serialized function body with page-absent helpers.
 */

export interface ProductionAbsenceAttemptRecord extends ProductionBrowserObservation {
  /** True when a hydration signal (the mounted canvas) appeared. */
  editorMounted: boolean;
  /** Number of same-document resources the browser requested for this attempt. */
  requestedResourceCount: number;
}

export interface ProductionAbsenceBrowserProof {
  schemaVersion: number;
  route: string;
  requests: {
    /** Every URL requested across both attempts. */
    all: readonly string[];
    /** The subset whose path is a Next static asset chunk. */
    staticChunks: readonly string[];
  };
  attempts: readonly ProductionAbsenceAttemptRecord[];
  screenshotPath: string | null;
  browserCloseError: string | null;
}

export interface ProveProductionAbsenceInput {
  baseUrl: string;
  environment: EnvironmentCell;
  route?: string;
  navigationTimeoutMs?: number;
  hydrationTimeoutMs?: number;
  settleMs?: number;
  screenshotPath?: string;
}

/**
 * Closed raw authority/currentness vocabulary for the additive
 * production-absence raw-fact API. It is local to the browser module so the raw
 * observations carry no command-status authority of their own.
 */
export const PRODUCTION_ABSENCE_RAW_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'incomplete',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
  'unsupported',
] as const;
export type ProductionAbsenceRawAuthorityState =
  (typeof PRODUCTION_ABSENCE_RAW_AUTHORITY_STATES)[number];

/** Closed raw evidence-availability vocabulary for the additive API. */
export const PRODUCTION_ABSENCE_RAW_EVIDENCE_AVAILABILITIES = [
  'ambiguous',
  'authoritative',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type ProductionAbsenceRawEvidenceAvailability =
  (typeof PRODUCTION_ABSENCE_RAW_EVIDENCE_AVAILABILITIES)[number];

/** One named raw production-absence check observation. */
export interface ProductionAbsenceRawCheckObservation {
  readonly checkId: string;
  readonly authority: ProductionAbsenceRawAuthorityState;
  readonly comparison: boolean | null;
  readonly observed: Readonly<Record<string, unknown>>;
}

/** One observed production-absence evidence role with its raw availability. */
export interface ProductionAbsenceRawEvidenceObservation {
  readonly evidenceId: string;
  readonly availability: ProductionAbsenceRawEvidenceAvailability;
}

/**
 * The additive raw production-absence command facts (ADR 0031 §3). It exposes
 * the named scan/browser/hydration/chunk-reconciliation observations and the
 * external build/start/browser failure facts; it carries no `passed`, no
 * `harnessInvalid`, and no status or outcome classification.
 */
export interface ProductionAbsenceRawCommandFacts {
  readonly command: 'production-absence';
  readonly checks: readonly ProductionAbsenceRawCheckObservation[];
  readonly evidence: readonly ProductionAbsenceRawEvidenceObservation[];
  readonly externalFailure: boolean;
  readonly cleanupSucceeded: boolean;
}

/** The explicitly reconciled chunk facts the raw projection consumes. */
export interface ProductionAbsenceChunkReconciliation {
  readonly resolved: number;
  readonly unresolved: readonly string[];
}

/** The raw observation inputs the additive production-absence projection consumes. */
export interface ProjectProductionAbsenceRawFactsInput {
  /** The emitted-artifact marker scan, or `null` when the scan never ran. */
  readonly scan: Pick<ProductionArtifactScan, 'clean' | 'hits' | 'scannedFiles'> | null;
  /** The two live browser attempts (initial and reload). */
  readonly attempts: readonly ProductionAbsenceAttemptRecord[];
  /** The requested-chunk reconciliation, or `null` when it never ran. */
  readonly chunkReconciliation: ProductionAbsenceChunkReconciliation | null;
  /** External owned-build/owned-server prerequisite failure. */
  readonly buildOrStartFailed: boolean;
  readonly browserCloseError: string | null;
  readonly cleanupSucceeded: boolean;
}

function rawCheck(
  checkId: string,
  authority: ProductionAbsenceRawAuthorityState,
  comparison: boolean | null,
  observed: Readonly<Record<string, unknown>>,
): ProductionAbsenceRawCheckObservation {
  return Object.freeze({
    checkId,
    authority,
    comparison: authority === 'current' ? comparison : null,
    observed: Object.freeze({ ...observed }),
  });
}

interface RawAttemptFacts {
  readonly authority: ProductionAbsenceRawAuthorityState;
  readonly seamAbsent: boolean;
  readonly observed: Readonly<Record<string, unknown>>;
}

function attemptFacts(attempt: ProductionAbsenceAttemptRecord | undefined): RawAttemptFacts {
  if (attempt === undefined) {
    return Object.freeze({
      authority: 'missing' as const,
      seamAbsent: false,
      observed: Object.freeze({ attempt: null, present: false, editorMounted: false }),
    });
  }
  const verdict = evaluateProductionBrowserAbsence(attempt);
  return Object.freeze({
    authority: attempt.editorMounted ? ('current' as const) : ('incomplete' as const),
    seamAbsent: verdict.clean,
    observed: Object.freeze({
      attempt: attempt.attempt,
      present: true,
      editorMounted: attempt.editorMounted,
      httpStatus: attempt.httpStatus,
      finalUrl: attempt.finalUrl,
      observationGlobalType: attempt.observationGlobalType,
      setupGlobalType: attempt.setupGlobalType,
      brokerSlotPresent: attempt.brokerSlotPresent,
      setupAnchorSlotPresent: attempt.setupAnchorSlotPresent,
      documentAnchorSlotPresent: attempt.documentAnchorSlotPresent,
      signalAnchorSlotPresent: attempt.signalAnchorSlotPresent,
      seamAbsent: verdict.clean,
      violationCount: verdict.violations.length,
    }),
  });
}

/**
 * Projects the raw production-absence producer closure (artifact scan, the two
 * live browser attempts, hydration/currentness authority, requested-chunk
 * reconciliation, and external build/start/browser failure facts) into the
 * additive raw command-fact API. It reads no legacy boolean check array and no
 * `harnessInvalid`; a missing or non-hydrated observation is never a fabricated
 * pass.
 */
export function projectProductionAbsenceRawCommandFacts(
  input: ProjectProductionAbsenceRawFactsInput,
): ProductionAbsenceRawCommandFacts {
  const scanAuthority: ProductionAbsenceRawAuthorityState =
    input.scan === null ? 'missing' : 'current';
  const scanClean = input.scan !== null && input.scan.clean;
  const initial = attemptFacts(input.attempts.find((entry) => entry.attempt === 'initial'));
  const reload = attemptFacts(input.attempts.find((entry) => entry.attempt === 'reload'));
  const reconciliationAuthority: ProductionAbsenceRawAuthorityState =
    input.chunkReconciliation === null ? 'missing' : 'current';
  const unresolved =
    input.chunkReconciliation === null ? [] : [...input.chunkReconciliation.unresolved];

  const checks: readonly ProductionAbsenceRawCheckObservation[] = Object.freeze([
    rawCheck('production.artifact-absence', scanAuthority, scanClean, {
      markerCount: input.scan === null ? null : input.scan.hits.length,
      scannedFiles: input.scan === null ? null : input.scan.scannedFiles,
      clean: scanClean,
    }),
    rawCheck('production.browser-absence.initial', initial.authority, initial.seamAbsent, {
      ...initial.observed,
    }),
    rawCheck('production.browser-absence.reload', reload.authority, reload.seamAbsent, {
      ...reload.observed,
    }),
    rawCheck('production.chunk-reconciliation', reconciliationAuthority, unresolved.length === 0, {
      resolved: input.chunkReconciliation === null ? null : input.chunkReconciliation.resolved,
      unresolvedCount: unresolved.length,
      unresolved,
    }),
  ]);

  const evidence: readonly ProductionAbsenceRawEvidenceObservation[] = Object.freeze([
    {
      evidenceId: 'production.artifact-scan',
      availability: input.scan === null ? 'missing' : 'authoritative',
    },
    {
      evidenceId: 'production.browser-observation.initial',
      availability:
        initial.authority === 'current'
          ? 'authoritative'
          : initial.authority === 'incomplete'
            ? 'ambiguous'
            : 'missing',
    },
    {
      evidenceId: 'production.browser-observation.reload',
      availability:
        reload.authority === 'current'
          ? 'authoritative'
          : reload.authority === 'incomplete'
            ? 'ambiguous'
            : 'missing',
    },
    {
      evidenceId: 'production.chunk-reconciliation',
      availability: input.chunkReconciliation === null ? 'missing' : 'authoritative',
    },
    { evidenceId: 'production.screenshot', availability: 'diagnostic-only' },
  ]);

  const hydrationFailure = initial.authority === 'incomplete' || reload.authority === 'incomplete';
  return Object.freeze({
    command: 'production-absence' as const,
    checks,
    evidence,
    externalFailure: input.buildOrStartFailed || hydrationFailure,
    cleanupSucceeded: input.cleanupSucceeded && input.browserCloseError === null,
  });
}

/** The one self-contained page probe; no nested function escapes into the page. */
export function buildProductionAbsenceProbeScript(): string {
  return `(() => {
  const hasSlot = (key) => {
    try {
      return Symbol.for(key) in window;
    } catch (error) {
      return false;
    }
  };
  return {
    url: location.href,
    title: document.title,
    observationGlobalType: typeof window[${JSON.stringify(OBSERVATION_GLOBAL_MARKER)}],
    setupGlobalType: typeof window[${JSON.stringify(SETUP_GLOBAL_MARKER)}],
    brokerSlotPresent: hasSlot(${JSON.stringify(SETUP_BROKER_SYMBOL_KEY)}),
    setupAnchorSlotPresent: hasSlot(${JSON.stringify(SETUP_ANCHOR_SYMBOL_KEY)}),
    documentAnchorSlotPresent: hasSlot(${JSON.stringify(DOCUMENT_ANCHOR_SYMBOL_KEY)}),
    signalAnchorSlotPresent: hasSlot(${JSON.stringify(SIGNAL_ANCHOR_SYMBOL_KEY)}),
  };
})()`;
}

interface RawProbeFacts {
  url: string;
  title: string;
  observationGlobalType: string;
  setupGlobalType: string;
  brokerSlotPresent: boolean;
  setupAnchorSlotPresent: boolean;
  documentAnchorSlotPresent: boolean;
  signalAnchorSlotPresent: boolean;
}

/**
 * Waits for the mounted editor canvas so absence is measured on a hydrated
 * document rather than on the pre-hydration shell. The bounded wait never
 * throws: an unhydrated document is recorded as `editorMounted: false` and the
 * caller treats that as a proof that could not be established.
 */
async function waitForHydration(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForSelector('canvas', { timeout: timeoutMs, state: 'attached' });
    return true;
  } catch {
    return false;
  }
}

function isStaticChunk(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return pathname.startsWith('/_next/static/') && pathname.endsWith('.js');
  } catch {
    return false;
  }
}

/**
 * Runs the two-attempt production absence proof. The browser and context are
 * always closed; a close failure is reported, never thrown, so the caller can
 * still preserve the observed facts.
 */
export async function proveProductionAbsenceInBrowser(
  input: ProveProductionAbsenceInput,
): Promise<ProductionAbsenceBrowserProof> {
  const route = input.route ?? PRODUCTION_ABSENCE_ROUTE;
  const navigationTimeoutMs = input.navigationTimeoutMs ?? 60_000;
  const hydrationTimeoutMs = input.hydrationTimeoutMs ?? 45_000;
  const settleMs = input.settleMs ?? 1_000;
  const url = `${input.baseUrl}${route}`;

  const requested: string[] = [];
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let browserCloseError: string | null = null;
  const attempts: ProductionAbsenceAttemptRecord[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { ...input.environment.viewport },
      deviceScaleFactor: input.environment.deviceScaleFactor,
      locale: input.environment.locale,
      timezoneId: input.environment.timezoneId,
      colorScheme: input.environment.colorScheme,
      reducedMotion: input.environment.reducedMotion,
      permissions: [...input.environment.permissions],
      ...(input.environment.geolocation
        ? {
            geolocation: {
              latitude: input.environment.geolocation.latitude,
              longitude: input.environment.geolocation.longitude,
            },
          }
        : {}),
    });
    const page = await context.newPage();
    // Attach the request listener before navigation so the document's own script
    // requests are observed, not just later dynamic imports.
    page.on('request', (request) => requested.push(request.url()));

    const initialResponse = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    });
    const initialMounted = await waitForHydration(page, hydrationTimeoutMs);
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    const initialFacts = (await page.evaluate(
      buildProductionAbsenceProbeScript(),
    )) as RawProbeFacts;

    attempts.push({
      attempt: 'initial',
      httpStatus: initialResponse?.status() ?? null,
      finalUrl: initialFacts.url,
      title: initialFacts.title,
      observationGlobalType: initialFacts.observationGlobalType,
      setupGlobalType: initialFacts.setupGlobalType,
      brokerSlotPresent: initialFacts.brokerSlotPresent,
      setupAnchorSlotPresent: initialFacts.setupAnchorSlotPresent,
      documentAnchorSlotPresent: initialFacts.documentAnchorSlotPresent,
      signalAnchorSlotPresent: initialFacts.signalAnchorSlotPresent,
      editorMounted: initialMounted,
      requestedPaths: [...requested],
      requestedResourceCount: requested.length,
    });

    if (input.screenshotPath !== undefined) {
      try {
        await page.screenshot({ path: input.screenshotPath, fullPage: false });
      } catch {
        // Bounded visual evidence is best-effort; the facts above are authoritative.
      }
    }

    const reloadResponse = await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    });
    const reloadMounted = await waitForHydration(page, hydrationTimeoutMs);
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    const reloadFacts = (await page.evaluate(buildProductionAbsenceProbeScript())) as RawProbeFacts;

    attempts.push({
      attempt: 'reload',
      httpStatus: reloadResponse?.status() ?? null,
      finalUrl: reloadFacts.url,
      title: reloadFacts.title,
      observationGlobalType: reloadFacts.observationGlobalType,
      setupGlobalType: reloadFacts.setupGlobalType,
      brokerSlotPresent: reloadFacts.brokerSlotPresent,
      setupAnchorSlotPresent: reloadFacts.setupAnchorSlotPresent,
      documentAnchorSlotPresent: reloadFacts.documentAnchorSlotPresent,
      signalAnchorSlotPresent: reloadFacts.signalAnchorSlotPresent,
      editorMounted: reloadMounted,
      requestedPaths: [...requested],
      requestedResourceCount: requested.length,
    });
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (error) {
        browserCloseError = error instanceof Error ? error.message : String(error);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        browserCloseError =
          browserCloseError ?? (error instanceof Error ? error.message : String(error));
      }
    }
  }

  return {
    schemaVersion: PRODUCTION_BROWSER_ABSENCE_SCHEMA_VERSION,
    route,
    requests: {
      all: requested,
      staticChunks: requested.filter(isStaticChunk),
    },
    attempts,
    screenshotPath: input.screenshotPath ?? null,
    browserCloseError,
  };
}
