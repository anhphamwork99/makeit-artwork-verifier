import { randomBytes, randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import {
  SETUP_AUTHORIZATION_TOKEN_PATTERN,
  SETUP_BROKER_KEY_DESCRIPTION,
  SETUP_FORBIDDEN_TRANSPORT_CHANNELS,
  SETUP_GLOBAL_NAME,
  SETUP_SEAM_SCHEMA_VERSION,
  type SetupAuthorization,
  type SetupConstructRequest,
  type SetupForbiddenTransportChannel,
  type SetupRefusal,
  type SetupSealRecord,
  type SetupStatusFacts,
} from '../contracts/seam';

/**
 * Harness-side capability delivery and seal read-back for the gated one-shot
 * setup boundary (specification 9.1; TS-3, Gate C).
 *
 * Delivery is exactly one `page.evaluate` on the already-loaded Document: it
 * installs a non-enumerable, registered-Symbol closure broker that holds the
 * expected authorization in a closure and hands it out once. The broker is not
 * an init script, so a reload or navigation never re-delivers it, and the raw
 * capability value never enters env, URL/query, cookies, browser storage,
 * IndexedDB, logs, evidence, or any setup/seal record.
 *
 * Every page interaction here is issued as a self-contained script string with
 * its arguments embedded as JSON. That is deliberate: the toolkit runs through
 * `tsx`/Vite, whose esbuild `keepNames` transform rewrites serialized function
 * bodies with `__name(...)` helpers that do not exist in the page (see the same
 * note in `browser/doctor.ts`). Script strings cannot drift that way, and the
 * generated scripts are themselves testable contracts.
 */

export interface SetupCapabilityDelivery {
  schemaVersion: number;
  authorizationId: string;
}

export interface CreateSetupAuthorizationInput {
  runId: string;
  caseId: string;
  origin: string;
  documentId: string;
  /** Test-only override; the raw value must still be 32 bytes of lowercase hex. */
  token?: string;
  authorizationId?: string;
}

/** Mints the per-run, per-case, per-document, unguessable authorization. */
export function createSetupAuthorization(input: CreateSetupAuthorizationInput): SetupAuthorization {
  const token = input.token ?? randomBytes(32).toString('hex');
  if (!SETUP_AUTHORIZATION_TOKEN_PATTERN.test(token)) {
    throw new Error('setup authorization token must be 32 lowercase hex-encoded bytes');
  }
  return {
    authorizationId: input.authorizationId ?? randomUUID(),
    token,
    scope: { runId: input.runId, caseId: input.caseId },
    origin: input.origin,
    documentId: input.documentId,
  };
}

/**
 * The one delivery script. It defines the closure broker on the current
 * Document without any nested function definition escaping into the page's
 * compiled module graph.
 */
export function buildSetupCapabilityDeliveryScript(authorization: SetupAuthorization): string {
  const payload = JSON.stringify(authorization);
  return `(() => {
  let pending = ${payload};
  const broker = Object.freeze({
    take: () => {
      const current = pending;
      pending = null;
      return current;
    },
  });
  Object.defineProperty(window, Symbol.for(${JSON.stringify(SETUP_BROKER_KEY_DESCRIPTION)}), {
    value: broker,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return { schemaVersion: ${SETUP_SEAM_SCHEMA_VERSION}, authorizationId: ${JSON.stringify(authorization.authorizationId)} };
})()`;
}

/** Reads whether a broker slot is still present, without consuming it. */
export function buildSetupBrokerPresenceScript(): string {
  return `(() => Symbol.for(${JSON.stringify(SETUP_BROKER_KEY_DESCRIPTION)}) in window)()`;
}

/** Reads the setup boundary's read-only status projection. */
export function buildSetupStatusScript(): string {
  return `(() => {
  const surface = window[${JSON.stringify(SETUP_GLOBAL_NAME)}];
  if (!surface || typeof surface.status !== 'function') return null;
  return surface.status();
})()`;
}

/** Reads the setup boundary's read-only seal record (null before a seal). */
export function buildSetupSealRecordScript(): string {
  return `(() => {
  const surface = window[${JSON.stringify(SETUP_GLOBAL_NAME)}];
  if (!surface || typeof surface.sealRecord !== 'function') return null;
  return surface.sealRecord();
})()`;
}

/** Reads the setup boundary's bounded refusal log. */
export function buildSetupRefusalsScript(): string {
  return `(() => {
  const surface = window[${JSON.stringify(SETUP_GLOBAL_NAME)}];
  if (!surface || typeof surface.refusals !== 'function') return [];
  return surface.refusals();
})()`;
}

/**
 * The single constructor invocation. Nothing else in this harness may call
 * `construct`, so a case cannot spend the one-shot opportunity twice.
 */
export function buildSetupConstructorInvocationScript(request: SetupConstructRequest): string {
  const payload = JSON.stringify(request);
  return `(() => {
  const surface = window[${JSON.stringify(SETUP_GLOBAL_NAME)}];
  if (!surface || typeof surface.construct !== 'function') {
    return { ok: false, outcome: 'absent', code: null, detail: 'setup boundary is not installed', context: {}, mutationApplied: false, authorizationConsumed: false, lifecycle: null, at: null };
  }
  return surface.construct(${payload});
})()`;
}

/**
 * Reads every channel the raw capability must never reach, plus the setup
 * global's own records, so one scan proves the non-persistence rule.
 */
export function buildSetupTransportScanScript(): string {
  return `(async () => {
  const readStore = (store) => {
    const entries = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      entries.push(String(key) + '=' + String(store.getItem(key)));
    }
    return entries.join('&');
  };
  let indexedDbNames = '';
  try {
    const databases = indexedDB && typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    indexedDbNames = JSON.stringify(databases);
  } catch (error) {
    indexedDbNames = 'unavailable';
  }
  const surface = window[${JSON.stringify(SETUP_GLOBAL_NAME)}];
  const boundaryRecords = surface
    ? JSON.stringify({ status: surface.status(), sealRecord: surface.sealRecord(), refusals: surface.refusals() })
    : '';
  return {
    url: window.location.href,
    query: window.location.search,
    cookie: document.cookie,
    localStorage: readStore(window.localStorage),
    sessionStorage: readStore(window.sessionStorage),
    indexedDb: indexedDbNames,
    setupRecord: boundaryRecords,
    sealRecord: boundaryRecords,
  };
})()`;
}

// ── Page-driving wrappers ────────────────────────────────────────────────────

/** Installs the closure broker once on the current Document. */
export async function deliverSetupAuthorization(
  page: Page,
  authorization: SetupAuthorization,
): Promise<SetupCapabilityDelivery> {
  return (await page.evaluate(
    buildSetupCapabilityDeliveryScript(authorization),
  )) as SetupCapabilityDelivery;
}

export async function setupBrokerIsPresent(page: Page): Promise<boolean> {
  return (await page.evaluate(buildSetupBrokerPresenceScript())) === true;
}

export async function readSetupStatus(page: Page): Promise<SetupStatusFacts | null> {
  return (await page.evaluate(buildSetupStatusScript())) as SetupStatusFacts | null;
}

export async function readSetupSealRecord(page: Page): Promise<SetupSealRecord | null> {
  return (await page.evaluate(buildSetupSealRecordScript())) as SetupSealRecord | null;
}

export async function readSetupRefusals(page: Page): Promise<SetupRefusal[]> {
  return (await page.evaluate(buildSetupRefusalsScript())) as SetupRefusal[];
}

/** One and only one constructor invocation per Document. */
export async function invokeSetupConstructor(
  page: Page,
  request: SetupConstructRequest,
): Promise<SetupConstructorOutcome> {
  return (await page.evaluate(
    buildSetupConstructorInvocationScript(request),
  )) as SetupConstructorOutcome;
}

/** The setup global's observable capability-leak channels. */
export async function readSetupPageChannels(
  page: Page,
): Promise<Partial<Record<SetupForbiddenTransportChannel, string>>> {
  return (await page.evaluate(buildSetupTransportScanScript())) as Partial<
    Record<SetupForbiddenTransportChannel, string>
  >;
}

export type SetupConstructorOutcome =
  | { ok: true; outcome: 'constructed'; lifecycle: 'SEALED'; sealRecord: SetupSealRecord }
  | ({
      ok: false;
      outcome: 'absent';
      code: null;
      detail: string;
      context: Record<string, string>;
      mutationApplied: false;
      authorizationConsumed: false;
      lifecycle: null;
      at: null;
    } & { sealRecord?: never })
  | SetupRefusal;

/** The channels a scan covers, in the order they are reported. */
export const SETUP_SCANNED_CHANNELS = SETUP_FORBIDDEN_TRANSPORT_CHANNELS;
