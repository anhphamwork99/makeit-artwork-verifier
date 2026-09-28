import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { DiagnosticRecord } from '../contracts/diagnostics';
import { createDiagnostic } from '../contracts/diagnostics';
import { DOCTOR_RESULT_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  OBSERVATION_BRIDGE_READ_ONLY_METHODS,
  OBSERVATION_BRIDGE_VERSION,
  OBSERVATION_CURSOR_SCHEMA_VERSION,
  OBSERVATION_GLOBAL_NAME,
} from '../contracts/seam';
import { openFreshPage, type BrowserSession } from './launch';

/**
 * Private/deprecated compatibility mirrors for the pre-cutover Doctor return
 * path (ADR 0032 §E3-S1). Raw command facts below are authoritative for the
 * eventual command path and never read these mirrors, legacy checks, or the
 * legacy outcome helper.
 *
 * @deprecated E3-S2 removes the legacy Doctor result authority entirely.
 */
type LegacyOutcome = 'PASS' | 'BUG' | 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE';

interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}

interface LegacyViewportSize {
  width: number;
  height: number;
}

interface LegacyEnvironmentCell {
  cellId: string;
  classification: 'diagnostic-only' | 'excluded-with-reason' | 'required-credit';
  browserKind: 'chromium' | 'firefox' | 'webkit';
  browserChannel: string;
  playwrightVersion: string;
  viewport: LegacyViewportSize;
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  colorScheme: 'dark' | 'light';
  reducedMotion: 'no-preference' | 'reduce';
  permissions: readonly string[];
  geolocation: { latitude: number; longitude: number } | null;
  storageState: null;
}

interface LegacyEnvironmentFacts {
  cellId: string;
  classification: LegacyEnvironmentCell['classification'];
  browserKind: LegacyEnvironmentCell['browserKind'];
  browserChannel: string;
  playwrightVersion: string;
  installedPlaywrightVersion: string;
  chromiumRevision: string | null;
  viewport: LegacyViewportSize;
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  colorScheme: string;
  reducedMotion: string;
  permissions: readonly string[];
  nodeVersion: string;
  platform: string;
  arch: string;
  appOrigin: string;
  lockfileDigest: string;
}

interface LegacyObservedEnvironmentFacts {
  viewport: LegacyViewportSize;
  devicePixelRatio: number;
  language: string | null;
  timezoneId: string | null;
  colorScheme: 'dark' | 'light' | null;
  reducedMotion: 'no-preference' | 'reduce' | null;
}

interface LegacyEnvironmentFactMismatch {
  fact: 'viewport' | 'devicePixelRatio' | 'locale' | 'timezoneId' | 'colorScheme' | 'reducedMotion';
  declared: string;
  observed: string;
}

interface LegacyRunAllocation {
  runId: string;
  repoRoot: string;
  skillRoot: string;
  repoRelativeDistDir: string;
  distDir: string;
  scratchRoot: string;
  evidenceRoot: string;
  routeNamespace: string;
  storageNamespace: string;
  port: number;
  baseUrl: string;
  environmentCellId: string;
}

interface LegacyDoctorResult {
  schemaVersion: number;
  runId: string;
  launchAttempted: true;
  outcome: LegacyOutcome;
  route: string;
  finalUrl: string;
  title: string;
  httpStatus: number | null;
  bridge: {
    available: boolean;
    expectedVersion: number;
    observedVersion: number | null;
    documentId: string | null;
    documentEpoch: number | null;
    frozen: boolean | null;
    methods: readonly string[];
    bridgeGeneration: number | null;
    revision: number | null;
    cursorSchemaVersion: number | null;
    cursorStable: boolean | null;
    waiterBounded: boolean | null;
  };
  stage: {
    mounted: boolean;
    width: number | null;
    height: number | null;
    layerNames: readonly string[];
  };
  state: {
    rootCount: number | null;
    scenegraphRootCount: number | null;
    nodeCount: number | null;
    layoutCount: number | null;
    layerCount: number | null;
    scenegraphInSync: boolean | null;
  };
  environment: LegacyEnvironmentFacts;
  environmentObserved: LegacyObservedEnvironmentFacts | null;
  environmentMismatches: readonly LegacyEnvironmentFactMismatch[];
  registry: DoctorRegistryFactsInput;
  appRevision: DoctorAppRevisionFactsInput;
  ownership: {
    runId: string;
    port: number;
    repoRelativeDistDir: string;
    scratchRoot: string;
    evidenceRoot: string;
    routeNamespace: string;
    storageNamespace: string;
  };
  requiredChecks: readonly LegacyCompositeCheck[];
  testedSellerAction: false;
  diagnostics: readonly DiagnosticRecord[];
  consoleErrors: readonly string[];
  failedRequests: readonly { url: string; error: string }[];
  evidence: { doctorJson: string; doctorPng: string; serverLog: string };
}

function classifyLegacyOutcome(input: {
  requiredChecks: readonly LegacyCompositeCheck[];
  cleanupSucceeded: boolean;
  harnessInvalid?: boolean;
  environmentInvalid?: boolean;
}): LegacyOutcome {
  if (input.harnessInvalid === true) return 'HARNESS_BLOCKED';
  if (input.environmentInvalid === true) return 'ENVIRONMENT_FAILURE';
  if (input.requiredChecks.length === 0) return 'HARNESS_BLOCKED';
  if (!input.cleanupSucceeded) return 'ENVIRONMENT_FAILURE';
  return input.requiredChecks.every((check) => check.passed) ? 'PASS' : 'BUG';
}

/**
 * Read-only Doctor v3 (specification 10; WP5 Slice 5-A; TS-4 / TS-5).
 *
 * Doctor opens one fresh Chromium context, reaches `/artwork/editor`, and
 * validates instance identity, route/title, the live bridge object, and run
 * ownership. It independently inspects the bridge's own property names and
 * descriptors in the page realm — the closed eight-method surface, the frozen
 * object, the document-correlated observation cursor, and a no-change cursor
 * stability read — instead of trusting the bridge's `doctor().methods` claim.
 *
 * The environment cell is compared against facts read from the live page, so an
 * environment that drifted from the governed cell fails closed. Doctor performs
 * no tested seller action and never substitutes for a drive.
 */

export const DOCTOR_ROUTE = '/artwork/editor';
export const EXPECTED_BRIDGE_VERSION = OBSERVATION_BRIDGE_VERSION;
export const DOCTOR_TITLE = 'Editor - Artwork';
export const REQUIRED_STAGE_LAYERS = [
  'artwork-boards',
  'artwork-smart-guides',
  'artwork-warp-handles',
  'artwork-drag-overlay',
] as const;

interface BridgeCursorShape {
  schemaVersion?: unknown;
  documentId?: unknown;
  documentEpoch?: unknown;
  bridgeVersion?: unknown;
  bridgeGeneration?: unknown;
  revision?: unknown;
}

interface BridgeDoctorShape {
  version?: unknown;
  route?: unknown;
  methods?: unknown;
  observation?: BridgeCursorShape;
  document?: {
    documentId?: unknown;
    documentEpoch?: unknown;
    bridgeVersion?: unknown;
  };
  stage?: {
    mounted?: unknown;
    width?: unknown;
    height?: unknown;
    layerNames?: unknown;
  };
  state?: {
    rootCount?: unknown;
    scenegraphRootCount?: unknown;
    nodeCount?: unknown;
    layoutCount?: unknown;
    layerCount?: unknown;
    scenegraphInSync?: unknown;
  };
}

interface BridgeInspectionFacts {
  available?: boolean;
  frozen?: unknown;
  names?: unknown;
  methods?: unknown;
  version?: unknown;
  doctor?: BridgeDoctorShape | null;
  doctorError?: unknown;
  cursorA?: BridgeCursorShape | null;
  cursorB?: BridgeCursorShape | null;
  cursorError?: unknown;
  waiter?: { status?: unknown; reason?: unknown } | null;
  waiterError?: unknown;
  /** True when reading observation methods changed the authoritative digest. */
  mutationDetected?: unknown;
  /** Probe of the first live element's typed geometry, when one exists. */
  geometryProbe?: {
    id?: unknown;
    hasGeometryV2?: unknown;
    schemaVersion?: unknown;
    targetId?: unknown;
    layoutId?: unknown;
    mounted?: unknown;
  } | null;
  geometryError?: unknown;
  /** Safe read-only raster-contract probe on the first live element. */
  rasterProbe?: {
    id?: unknown;
    isPromise?: unknown;
    schemaVersion?: unknown;
    status?: unknown;
    hasObservation?: unknown;
  } | null;
  rasterError?: unknown;
}

export interface DoctorRegistryFactsInput {
  schemaVersion: number | null;
  fingerprint: string | null;
  resolvedSubjects: number | null;
}

export interface DoctorAppRevisionFactsInput {
  commit: string | null;
  dirty: boolean | null;
}

export interface RunDoctorInput {
  allocation: LegacyRunAllocation;
  environment: LegacyEnvironmentCell;
  environmentFacts: LegacyEnvironmentFacts;
  registry: DoctorRegistryFactsInput;
  appRevision: DoctorAppRevisionFactsInput;
  expectedBridgeVersion?: number;
  navigationTimeoutMs?: number;
  bridgeWaitTimeoutMs?: number;
  /** Test/diagnostic seam: open the fresh page (defaults to the real browser). */
  openPage?: typeof openFreshPage;
  /** Test/diagnostic seam: close the fresh browser session. */
  closeSession?: typeof closeBrowserSession;
  /** Test/diagnostic seam: observe live page environment facts. */
  observeEnvironment?: (page: BrowserSession['page']) => Promise<LegacyObservedEnvironmentFacts>;
}

export interface DoctorRunResult {
  result: LegacyDoctorResult;
  requiredChecks: readonly LegacyCompositeCheck[];
  harnessInvalid: boolean;
  environmentInvalid: boolean;
  behaviorOutcome: LegacyOutcome;
  /** Non-null when the fresh browser context/browser could not be closed. */
  browserCloseError: string | null;
  /**
   * Additive inactive raw command facts (ADR 0031 §E2R). Projects the Doctor's
   * own browser observations as named facts only: no `passed`, no
   * `harnessInvalid`, no status, no outcome, and no correctness profile. The
   * active Doctor CLI never reads it; it is consumed only by the inactive
   * command adapter handoff.
   */
  rawFacts: DoctorRawCommandFacts;
}

/**
 * Closed raw authority/currentness vocabulary for the additive Doctor raw-fact
 * API. It is deliberately local to the browser module so the raw observations
 * carry no command-status authority of their own; the inactive command adapter
 * maps these names onto the B1-G command vocabulary.
 */
export const DOCTOR_RAW_AUTHORITY_STATES = [
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
export type DoctorRawAuthorityState = (typeof DOCTOR_RAW_AUTHORITY_STATES)[number];

/** Closed raw evidence-availability vocabulary for the additive Doctor API. */
export const DOCTOR_RAW_EVIDENCE_AVAILABILITIES = [
  'ambiguous',
  'authoritative',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type DoctorRawEvidenceAvailability = (typeof DOCTOR_RAW_EVIDENCE_AVAILABILITIES)[number];

/**
 * One named raw Doctor check observation. `comparison` is the explicitly named
 * primitive predicate under a `current` authority (the check's own dimensions
 * agreeing with the declared expectation); it is `null` when the check could not
 * establish a current observation. `observed` carries the named observed values
 * only. No legacy composite check result is projected here.
 */
export interface DoctorRawCheckObservation {
  readonly checkId: string;
  readonly authority: DoctorRawAuthorityState;
  readonly comparison: boolean | null;
  readonly observed: Readonly<Record<string, unknown>>;
}

/** One observed Doctor evidence role with its raw availability. */
export interface DoctorRawEvidenceObservation {
  readonly evidenceId: string;
  readonly availability: DoctorRawEvidenceAvailability;
}

/**
 * The additive raw Doctor command facts (ADR 0031 §2). It exposes exactly the
 * named observations, explicit authority/currentness, evidence availability,
 * and external page/environment failure facts; it carries no `passed`, no
 * `harnessInvalid`, no status, no outcome, and no fabricated profile.
 */
export interface DoctorRawCommandFacts {
  readonly command: 'doctor';
  readonly checks: readonly DoctorRawCheckObservation[];
  readonly evidence: readonly DoctorRawEvidenceObservation[];
  /** External page/environment failure fact (unreachable page or governed-cell mismatch). */
  readonly externalFailure: boolean;
  readonly cleanupSucceeded: boolean;
}

export interface BrowserCloseOutcome {
  closed: boolean;
  detail: string | null;
}

/**
 * The self-contained bridge inspection script. It is a script string (never a
 * serialized function body) because the toolkit runs through `tsx`, whose
 * esbuild `keepNames` transform injects page-absent `__name(...)` helpers into
 * nested function bodies.
 *
 * It reads the bridge's own property descriptors, the callable own methods, the
 * two no-change cursor reads, and one bounded zero-timeout waiter. It performs
 * no seller action and no mutation.
 */
export function buildDoctorBridgeInspectionScript(): string {
  return `(async () => {
  const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
  if (!bridge || typeof bridge !== 'object') {
    return { available: false };
  }
  const names = Object.getOwnPropertyNames(bridge);
  const descriptors = {};
  const methods = [];
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(bridge, name);
    const valueType = descriptor ? typeof descriptor.value : 'undefined';
    descriptors[name] = {
      enumerable: descriptor ? descriptor.enumerable : null,
      configurable: descriptor ? descriptor.configurable : null,
      writable: descriptor ? descriptor.writable : null,
      accessor: descriptor ? (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') : null,
      valueType: valueType,
    };
    if (valueType === 'function') methods.push(name);
  }
  let doctor = null;
  let doctorError = null;
  let cursorA = null;
  let cursorB = null;
  let cursorError = null;
  let waiter = null;
  let waiterError = null;
  let beforeDigest = null;
  let mutationDetected = null;
  let geometryProbe = null;
  let geometryError = null;
  if (typeof bridge.snapshot === 'function') {
    try {
      const s0 = bridge.snapshot();
      beforeDigest = JSON.stringify({ layoutItems: s0.layoutItems, selectedLayerIds: s0.selectedLayerIds, camera: s0.camera });
    } catch (error) {
      beforeDigest = null;
    }
  }
  try {
    doctor = typeof bridge.doctor === 'function' ? bridge.doctor() : null;
    if (doctor === null) doctorError = 'doctor is not callable';
  } catch (error) {
    doctorError = String(error);
  }
  try {
    if (typeof bridge.cursor === 'function') {
      cursorA = bridge.cursor();
      cursorB = bridge.cursor();
    } else {
      cursorError = 'cursor is not callable';
    }
  } catch (error) {
    cursorError = String(error);
  }
  if (typeof bridge.waitForChange === 'function' && cursorA) {
    try {
      waiter = await bridge.waitForChange({ after: cursorA, timeoutMs: 0 });
    } catch (error) {
      waiterError = String(error);
    }
  }
  try {
    if (typeof bridge.elements === 'function' && typeof bridge.geometry === 'function') {
      const elements = bridge.elements();
      const first = elements && Array.isArray(elements.elements) ? elements.elements[0] : null;
      if (first) {
        const read = bridge.geometry(first.id);
        const typed = read && read.geometryV2 ? read.geometryV2 : null;
        const provenance = typed ? typed.typedProvenance : null;
        geometryProbe = {
          id: first.id,
          hasGeometryV2: Boolean(typed),
          schemaVersion: typed ? typed.schemaVersion : null,
          targetId: provenance && provenance.target ? provenance.target.id : null,
          layoutId: provenance && provenance.layout ? provenance.layout.id : null,
          mounted: read ? read.mounted === true : false,
        };
      }
    }
  } catch (error) {
    geometryError = String(error);
  }
  let rasterProbe = null;
  let rasterError = null;
  try {
    if (typeof bridge.raster === 'function' && typeof bridge.elements === 'function') {
      const rasterElements = bridge.elements();
      const rasterFirst = rasterElements && Array.isArray(rasterElements.elements) ? rasterElements.elements[0] : null;
      if (rasterFirst) {
        const returned = bridge.raster(rasterFirst.id);
        const isPromise = returned !== null && typeof returned === 'object' && typeof returned.then === 'function';
        const record = isPromise ? await returned : null;
        rasterProbe = {
          id: rasterFirst.id,
          isPromise: isPromise,
          schemaVersion: record ? record.rasterSchemaVersion : null,
          status: record ? record.status : null,
          hasObservation: Boolean(record && record.observation),
        };
      }
    }
  } catch (error) {
    rasterError = String(error);
  }
  if (typeof bridge.snapshot === 'function' && beforeDigest !== null) {
    try {
      const s1 = bridge.snapshot();
      mutationDetected = beforeDigest !== JSON.stringify({ layoutItems: s1.layoutItems, selectedLayerIds: s1.selectedLayerIds, camera: s1.camera });
    } catch (error) {
      mutationDetected = null;
    }
  }
  return {
    available: true,
    frozen: Object.isFrozen(bridge),
    names: names,
    descriptors: descriptors,
    methods: methods,
    version: bridge.version,
    doctor: doctor,
    doctorError: doctorError,
    cursorA: cursorA,
    cursorB: cursorB,
    cursorError: cursorError,
    waiter: waiter,
    waiterError: waiterError,
    mutationDetected: mutationDetected,
    geometryProbe: geometryProbe,
    geometryError: geometryError,
    rasterProbe: rasterProbe,
    rasterError: rasterError,
  };
})()`;
}

/**
 * Closes the fresh context and browser, collecting both failures instead of
 * swallowing them. A close failure is an environment cleanup failure: it must
 * never yield a PASS and must never silently leak a browser process.
 */
export async function closeBrowserSession(
  session: Pick<BrowserSession, 'context' | 'browser'>,
): Promise<BrowserCloseOutcome> {
  const failures: string[] = [];
  try {
    await session.context.close();
  } catch (error) {
    failures.push(`context close failed: ${(error as Error).message}`);
  }
  try {
    await session.browser.close();
  } catch (error) {
    failures.push(`browser close failed: ${(error as Error).message}`);
  }
  return failures.length === 0
    ? { closed: true, detail: null }
    : { closed: false, detail: failures.join('; ') };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function sameMembers(observed: readonly string[], expected: readonly string[]): boolean {
  if (observed.length !== expected.length) return false;
  const sortedObserved = [...observed].sort();
  const sortedExpected = [...expected].sort();
  return sortedObserved.every((entry, index) => entry === sortedExpected[index]);
}

/**
 * Reads the governed environment facts from the live page.
 *
 * Every value is a browser-reported observation (layout viewport, device pixel
 * ratio, `navigator.language`, resolved `Intl` time zone, and the
 * `prefers-color-scheme`/`prefers-reduced-motion` media queries). Nothing here
 * is derived from the governed `EnvironmentCell`, so comparing the two is a real
 * observation instead of a self-referential equality.
 */
export async function observeBrowserEnvironmentFacts(
  page: BrowserSession['page'],
): Promise<LegacyObservedEnvironmentFacts> {
  // The callback body stays flat (no nested function definitions) on purpose:
  // the CLI runs through `tsx`, whose esbuild `keepNames` transform injects
  // `__name(...)` calls into nested function bodies. Playwright serializes the
  // function source and that helper does not exist in the page, so a nested
  // function here fails at runtime with `ReferenceError: __name is not defined`.
  return page.evaluate(() => {
    const supportsMatchMedia = typeof window.matchMedia === 'function';
    const darkMatches = supportsMatchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : null;
    const reduceMatches = supportsMatchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : null;
    let timezoneId: string | null = null;
    try {
      timezoneId = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      timezoneId = null;
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      language: typeof navigator.language === 'string' ? navigator.language : null,
      timezoneId,
      colorScheme: darkMatches === null ? null : darkMatches ? 'dark' : 'light',
      reducedMotion: reduceMatches === null ? null : reduceMatches ? 'reduce' : 'no-preference',
    };
  });
}

/**
 * Compares the governed cell to the facts the live page reported. A fact the
 * page did not expose (null) is treated as unobserved and never as matching; an
 * unobserved media query is recorded without inventing a value. Every observed
 * discrepancy is reported so the run fails closed instead of vacuously passing.
 */
export function compareObservedEnvironmentToCell(
  cell: LegacyEnvironmentCell,
  observed: LegacyObservedEnvironmentFacts,
): LegacyEnvironmentFactMismatch[] {
  const mismatches: LegacyEnvironmentFactMismatch[] = [];
  const compare = (fact: LegacyEnvironmentFactMismatch['fact'], declared: string, seen: string) => {
    if (declared !== seen) mismatches.push({ fact, declared, observed: seen });
  };

  compare(
    'viewport',
    `${cell.viewport.width}x${cell.viewport.height}`,
    `${observed.viewport.width}x${observed.viewport.height}`,
  );
  compare('devicePixelRatio', String(cell.deviceScaleFactor), String(observed.devicePixelRatio));
  if (observed.language !== null) compare('locale', cell.locale, observed.language);
  if (observed.timezoneId !== null) compare('timezoneId', cell.timezoneId, observed.timezoneId);
  if (observed.colorScheme !== null) {
    compare('colorScheme', cell.colorScheme, observed.colorScheme);
  }
  if (observed.reducedMotion !== null) {
    compare('reducedMotion', cell.reducedMotion, observed.reducedMotion);
  }
  return mismatches;
}

/**
 * The named raw observation facts the additive Doctor projection consumes. Every
 * field is a browser/runtime observation or a declared expectation; none is a
 * legacy composite check result, a `passed` boolean, a status, or an outcome.
 */
export interface DoctorRawObservation {
  /** The owned page reached a document (navigation succeeded). */
  readonly pageReachable: boolean;
  readonly routeMatches: boolean;
  readonly titleMatches: boolean;
  readonly finalUrl: string;
  readonly title: string;
  readonly bridgePresent: boolean;
  readonly inspectionPresent: boolean;
  readonly documentIdentityPresent: boolean;
  readonly observedDocumentId: string | null;
  readonly observedDocumentEpoch: number | null;
  readonly observedVersion: number | null;
  readonly expectedVersion: number;
  readonly observedMethods: readonly string[];
  readonly methodsExact: boolean;
  readonly bridgeFrozen: boolean;
  readonly cursorWellFormed: boolean;
  readonly cursorCurrent: boolean;
  readonly cursorStable: boolean;
  readonly waiterPresent: boolean;
  readonly waiterBounded: boolean;
  readonly geometryOk: boolean;
  readonly rasterOk: boolean;
  readonly mutationDetected: boolean | null;
  readonly stageMounted: boolean;
  readonly missingLayers: readonly string[];
  readonly layoutCount: number | null;
  readonly minLayouts: number;
  readonly scenegraphPresent: boolean;
  readonly scenegraphInSync: boolean | null;
  readonly environmentObserved: boolean;
  readonly environmentMismatchCount: number;
  readonly environmentCellId: string;
  readonly browserCloseError: string | null;
}

function rawCheck(
  checkId: string,
  authority: DoctorRawAuthorityState,
  comparison: boolean | null,
  observed: Readonly<Record<string, unknown>>,
): DoctorRawCheckObservation {
  const current = authority === 'current';
  return Object.freeze({
    checkId,
    authority,
    comparison: current ? comparison : null,
    observed: Object.freeze({ ...observed }),
  });
}

/**
 * Projects the Doctor's own named browser observations into the additive raw
 * command-fact API. It reads no `passed` boolean, no `harnessInvalid`, no
 * `CheckResult`, no status, and no outcome. An observation that was not
 * established is `missing`/`malformed`/`incomplete` authority with a `null`
 * comparison, so a fabricated pass is impossible.
 */
export function projectDoctorRawCommandFacts(
  observation: DoctorRawObservation,
): DoctorRawCommandFacts {
  const pageAuthority: DoctorRawAuthorityState = observation.pageReachable ? 'current' : 'missing';
  const inspectionAuthority: DoctorRawAuthorityState = observation.inspectionPresent
    ? 'current'
    : 'missing';
  const bridgeAuthority: DoctorRawAuthorityState =
    observation.bridgePresent && observation.inspectionPresent ? 'current' : 'missing';
  const doctorPayloadAuthority: DoctorRawAuthorityState = observation.inspectionPresent
    ? 'current'
    : 'missing';
  const cursorAuthority: DoctorRawAuthorityState = !observation.inspectionPresent
    ? 'missing'
    : observation.cursorWellFormed
      ? 'current'
      : 'malformed';
  const waiterAuthority: DoctorRawAuthorityState = observation.waiterPresent
    ? 'current'
    : 'missing';
  const layoutAuthority: DoctorRawAuthorityState =
    observation.layoutCount === null ? 'missing' : 'current';
  const scenegraphAuthority: DoctorRawAuthorityState = observation.scenegraphPresent
    ? 'current'
    : 'missing';
  const environmentAuthority: DoctorRawAuthorityState = observation.environmentObserved
    ? 'current'
    : 'missing';

  const checks: readonly DoctorRawCheckObservation[] = Object.freeze([
    rawCheck('doctor.route', pageAuthority, observation.routeMatches, {
      expectedRoute: DOCTOR_ROUTE,
      finalUrl: observation.finalUrl,
      routeMatches: observation.routeMatches,
    }),
    rawCheck('doctor.title', pageAuthority, observation.titleMatches, {
      expectedTitle: DOCTOR_TITLE,
      title: observation.title,
      titleMatches: observation.titleMatches,
    }),
    rawCheck('doctor.bridge.available', bridgeAuthority, observation.bridgePresent, {
      globalName: OBSERVATION_GLOBAL_NAME,
      bridgePresent: observation.bridgePresent,
    }),
    rawCheck(
      'doctor.bridge.version',
      bridgeAuthority,
      observation.observedVersion === observation.expectedVersion,
      {
        expectedVersion: observation.expectedVersion,
        observedVersion: observation.observedVersion,
        versionMatches: observation.observedVersion === observation.expectedVersion,
      },
    ),
    rawCheck(
      'doctor.bridge.document',
      observation.documentIdentityPresent ? 'current' : 'missing',
      observation.documentIdentityPresent,
      {
        documentId: observation.observedDocumentId,
        documentEpoch: observation.observedDocumentEpoch,
        documentIdentityPresent: observation.documentIdentityPresent,
      },
    ),
    rawCheck('doctor.bridge.methods', doctorPayloadAuthority, observation.methodsExact, {
      expectedMethods: OBSERVATION_BRIDGE_READ_ONLY_METHODS,
      observedMethods: observation.observedMethods,
      methodsExact: observation.methodsExact,
    }),
    rawCheck('doctor.bridge.frozen', inspectionAuthority, observation.bridgeFrozen, {
      frozen: observation.bridgeFrozen,
    }),
    rawCheck('doctor.bridge.cursor', cursorAuthority, observation.cursorCurrent, {
      cursorWellFormed: observation.cursorWellFormed,
      cursorCurrent: observation.cursorCurrent,
    }),
    rawCheck('doctor.bridge.cursor-stable', inspectionAuthority, observation.cursorStable, {
      cursorStable: observation.cursorStable,
    }),
    rawCheck('doctor.bridge.waiter', waiterAuthority, observation.waiterBounded, {
      waiterBounded: observation.waiterBounded,
    }),
    rawCheck('doctor.bridge.geometry', inspectionAuthority, observation.geometryOk, {
      geometryOk: observation.geometryOk,
    }),
    rawCheck('doctor.bridge.raster', inspectionAuthority, observation.rasterOk, {
      rasterOk: observation.rasterOk,
    }),
    rawCheck(
      'doctor.bridge.no-mutation',
      observation.mutationDetected === null ? 'missing' : 'current',
      observation.mutationDetected !== true,
      { mutationDetected: observation.mutationDetected },
    ),
    rawCheck('doctor.stage.mounted', doctorPayloadAuthority, observation.stageMounted, {
      mounted: observation.stageMounted,
    }),
    rawCheck(
      'doctor.stage.layers',
      doctorPayloadAuthority,
      observation.missingLayers.length === 0,
      {
        requiredLayers: REQUIRED_STAGE_LAYERS,
        missingLayers: observation.missingLayers,
        layersPresent: observation.missingLayers.length === 0,
      },
    ),
    rawCheck(
      'doctor.state.layouts',
      layoutAuthority,
      observation.layoutCount !== null && observation.layoutCount >= observation.minLayouts,
      {
        minLayouts: observation.minLayouts,
        layoutCount: observation.layoutCount,
        layoutsSufficient:
          observation.layoutCount !== null && observation.layoutCount >= observation.minLayouts,
      },
    ),
    rawCheck('doctor.state.scenegraph', scenegraphAuthority, observation.scenegraphPresent, {
      scenegraphInSync: observation.scenegraphInSync,
      scenegraphFactPresent: observation.scenegraphPresent,
    }),
    rawCheck(
      'doctor.environment.cell',
      environmentAuthority,
      observation.environmentMismatchCount === 0,
      {
        cellId: observation.environmentCellId,
        mismatchCount: observation.environmentMismatchCount,
        environmentMatches: observation.environmentMismatchCount === 0,
      },
    ),
  ]);

  const evidence: readonly DoctorRawEvidenceObservation[] = Object.freeze([
    {
      evidenceId: 'doctor.browser-environment',
      availability: observation.environmentObserved ? 'authoritative' : 'missing',
    },
    {
      evidenceId: 'doctor.bridge-inspection',
      availability: observation.inspectionPresent ? 'authoritative' : 'missing',
    },
    {
      evidenceId: 'doctor.instance-observation',
      availability: observation.pageReachable ? 'authoritative' : 'missing',
    },
    { evidenceId: 'doctor.console-errors', availability: 'diagnostic-only' },
    { evidenceId: 'doctor.failed-requests', availability: 'diagnostic-only' },
    { evidenceId: 'doctor.screenshot', availability: 'diagnostic-only' },
  ]);

  const environmentCellMismatch = observation.environmentMismatchCount > 0;
  return Object.freeze({
    command: 'doctor' as const,
    checks,
    evidence,
    externalFailure: !observation.pageReachable || environmentCellMismatch,
    cleanupSucceeded: observation.browserCloseError === null,
  });
}

export async function runDoctor(input: RunDoctorInput): Promise<DoctorRunResult> {
  const { allocation } = input;
  const expectedVersion = input.expectedBridgeVersion ?? EXPECTED_BRIDGE_VERSION;
  const openPage = input.openPage ?? openFreshPage;
  const closeSession = input.closeSession ?? closeBrowserSession;
  const observeEnvironment = input.observeEnvironment ?? observeBrowserEnvironmentFacts;
  const diagnostics: DiagnosticRecord[] = [];
  const requiredChecks: LegacyCompositeCheck[] = [];

  const candidateRoot = path.join(allocation.scratchRoot, 'candidates');
  mkdirSync(candidateRoot, { recursive: true });
  const doctorJsonPath = path.join(candidateRoot, 'doctor.json');
  const doctorPngPath = path.join(candidateRoot, 'doctor.png');

  let session: BrowserSession | null = null;
  let inspection: BridgeInspectionFacts | null = null;
  let title = '';
  let finalUrl = '';
  let httpStatus: number | null = null;
  let harnessInvalid = false;
  let environmentInvalid = false;
  let bridgeAvailable = false;
  let browserCloseError: string | null = null;
  let observedEnvironment: LegacyObservedEnvironmentFacts | null = null;

  try {
    session = await openPage({
      baseUrl: allocation.baseUrl,
      route: DOCTOR_ROUTE,
      environment: input.environment,
      navigationTimeoutMs: input.navigationTimeoutMs,
    });
    httpStatus = session.responseStatus;

    await session.page.waitForFunction(
      (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
      OBSERVATION_GLOBAL_NAME,
      { timeout: input.bridgeWaitTimeoutMs ?? 30_000 },
    );
    bridgeAvailable = true;

    inspection = (await session.page.evaluate(
      buildDoctorBridgeInspectionScript(),
    )) as BridgeInspectionFacts;

    title = await session.page.title();
    finalUrl = session.page.url();
    observedEnvironment = await observeEnvironment(session.page);
    await session.page.screenshot({ path: doctorPngPath });
  } catch (error) {
    if (bridgeAvailable) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'DOCTOR_INSTANCE_MISMATCH',
          `Doctor could not inspect the observation bridge: ${(error as Error).message}`,
        ),
      );
    } else {
      // The page never exposed the bridge. Decide bridge-unavailable vs external
      // failure from whether navigation itself succeeded.
      if (session === null || httpStatus === null) {
        environmentInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'RUNTIME_READINESS_FAILED',
            `Doctor could not open the owned Artwork Editor page: ${(error as Error).message}`,
          ),
        );
      } else {
        harnessInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'BRIDGE_UNAVAILABLE',
            `Observation bridge was not available on ${DOCTOR_ROUTE}: ${(error as Error).message}`,
          ),
        );
      }
    }
  } finally {
    if (session) {
      const closeOutcome = await closeSession(session);
      if (!closeOutcome.closed) {
        browserCloseError = closeOutcome.detail;
        environmentInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'BROWSER_CLEANUP_FAILED',
            `Owned browser could not be closed: ${closeOutcome.detail}.`,
          ),
        );
      }
    }
  }

  const doctorPayload = inspection?.doctor ?? null;
  const cursorA = inspection?.cursorA ?? null;
  const cursorB = inspection?.cursorB ?? null;
  const observedVersion = asNumber(doctorPayload?.version) ?? asNumber(inspection?.version);
  const observedMethods = asStringArray(inspection?.methods);
  const methodsExact = sameMembers(observedMethods, OBSERVATION_BRIDGE_READ_ONLY_METHODS);
  const bridgeFrozen = inspection?.frozen === true;
  const layerNames = asStringArray(doctorPayload?.stage?.layerNames);
  const mounted = doctorPayload?.stage?.mounted === true;
  const stateLayouts = doctorPayload?.state?.layoutCount;

  const observedDocumentId =
    typeof doctorPayload?.document?.documentId === 'string' &&
    doctorPayload.document.documentId.length > 0
      ? doctorPayload.document.documentId
      : null;
  const observedDocumentEpoch = asNumber(doctorPayload?.document?.documentEpoch);
  const documentIdentityOk = observedDocumentId !== null && observedDocumentEpoch !== null;

  const cursorSchemaVersion = asNumber(cursorA?.schemaVersion);
  const cursorRevision = asNumber(cursorA?.revision);
  const cursorGeneration = asNumber(cursorA?.bridgeGeneration);
  const cursorBridgeVersion = asNumber(cursorA?.bridgeVersion);
  const cursorDocumentId = typeof cursorA?.documentId === 'string' ? cursorA.documentId : null;
  const cursorDocumentEpoch = asNumber(cursorA?.documentEpoch);
  const cursorWellFormed =
    cursorSchemaVersion === OBSERVATION_CURSOR_SCHEMA_VERSION &&
    cursorDocumentId !== null &&
    typeof cursorDocumentEpoch === 'number' &&
    Number.isSafeInteger(cursorDocumentEpoch) &&
    cursorDocumentEpoch >= 1 &&
    Number.isSafeInteger(cursorRevision) &&
    (cursorRevision ?? -1) >= 0 &&
    Number.isSafeInteger(cursorGeneration) &&
    (cursorGeneration ?? 0) >= 1;
  const cursorMatchesDoctor =
    cursorDocumentId === observedDocumentId &&
    cursorDocumentEpoch === observedDocumentEpoch &&
    cursorBridgeVersion === expectedVersion;
  const cursorOk = cursorWellFormed && cursorMatchesDoctor;
  const cursorStable =
    cursorA !== null &&
    cursorB !== null &&
    asNumber(cursorA.revision) === asNumber(cursorB.revision) &&
    cursorA.documentId === cursorB.documentId &&
    cursorA.bridgeGeneration === cursorB.bridgeGeneration;
  const waiterBounded = inspection?.waiter?.status === 'timeout';

  const observedScenegraphInSync =
    typeof doctorPayload?.state?.scenegraphInSync === 'boolean'
      ? doctorPayload.state.scenegraphInSync
      : null;
  const observedScenegraphRootCount = asNumber(doctorPayload?.state?.scenegraphRootCount);
  const observedRootCount = asNumber(doctorPayload?.state?.rootCount);

  const missingLayers = REQUIRED_STAGE_LAYERS.filter((layer) => !layerNames.includes(layer));
  const routeOk = (() => {
    try {
      return new URL(finalUrl).pathname === DOCTOR_ROUTE;
    } catch {
      return false;
    }
  })();

  const observedEnvironmentValue = observedEnvironment;
  const environmentMismatches =
    observedEnvironmentValue === null
      ? []
      : compareObservedEnvironmentToCell(input.environment, observedEnvironmentValue);

  const geometryProbe = inspection?.geometryProbe ?? null;
  const geometryOk =
    geometryProbe === null ||
    geometryProbe.hasGeometryV2 !== true ||
    (asNumber(geometryProbe.schemaVersion) === 2 && geometryProbe.mounted === true);
  const rasterProbe = inspection?.rasterProbe ?? null;
  const rasterOk =
    rasterProbe === null ||
    (rasterProbe.isPromise === true &&
      asNumber(rasterProbe.schemaVersion) === 3 &&
      rasterProbe.hasObservation === true);

  const checks: LegacyCompositeCheck[] = [
    { checkId: 'doctor.route', passed: routeOk },
    { checkId: 'doctor.title', passed: title === DOCTOR_TITLE },
    {
      checkId: 'doctor.bridge.available',
      passed: bridgeAvailable && inspection !== null && doctorPayload !== null,
    },
    { checkId: 'doctor.bridge.version', passed: observedVersion === expectedVersion },
    { checkId: 'doctor.bridge.document', passed: documentIdentityOk },
    { checkId: 'doctor.bridge.methods', passed: methodsExact },
    { checkId: 'doctor.bridge.frozen', passed: bridgeFrozen },
    { checkId: 'doctor.bridge.cursor', passed: cursorOk },
    { checkId: 'doctor.bridge.cursor-stable', passed: cursorStable },
    { checkId: 'doctor.bridge.waiter', passed: waiterBounded },
    {
      checkId: 'doctor.bridge.geometry',
      passed: geometryOk,
    },
    {
      checkId: 'doctor.bridge.raster',
      passed: rasterOk,
    },
    { checkId: 'doctor.bridge.no-mutation', passed: inspection?.mutationDetected !== true },
    { checkId: 'doctor.stage.mounted', passed: mounted },
    { checkId: 'doctor.stage.layers', passed: missingLayers.length === 0 },
    {
      checkId: 'doctor.state.layouts',
      passed: typeof stateLayouts === 'number' && stateLayouts >= 2,
    },
    // The known `layoutItems` versus `nodes/rootIds` discrepancy stays reported
    // (specification 17). Doctor requires the fact, never a particular value.
    { checkId: 'doctor.state.scenegraph', passed: observedScenegraphInSync !== null },
    // The governed cell is compared to facts read from the live page, so a
    // viewport/DPR/locale/time-zone/media drift fails instead of passing
    // because both sides came from the same catalogue object.
    {
      checkId: 'doctor.environment.cell',
      passed: observedEnvironmentValue !== null && environmentMismatches.length === 0,
    },
  ];
  requiredChecks.push(...checks);

  if (environmentMismatches.length > 0) {
    environmentInvalid = true;
    diagnostics.push(
      createDiagnostic(
        'ENVIRONMENT_CELL_MISMATCH',
        `Live browser environment does not match governed cell ${input.environment.cellId}: ${environmentMismatches
          .map((entry) => `${entry.fact} declared "${entry.declared}" observed "${entry.observed}"`)
          .join('; ')}.`,
        { context: { cellId: input.environment.cellId } },
      ),
    );
  }

  if (!bridgeAvailable) {
    harnessInvalid = true;
    diagnostics.push(
      createDiagnostic(
        'BRIDGE_UNAVAILABLE',
        `Observation bridge was not installed on ${DOCTOR_ROUTE}.`,
      ),
    );
  } else if (observedVersion !== expectedVersion) {
    harnessInvalid = true;
    diagnostics.push(
      createDiagnostic(
        'BRIDGE_VERSION_MISMATCH',
        `Observation bridge version ${String(observedVersion)} does not match expected ${expectedVersion}.`,
      ),
    );
  } else {
    const surfaceFailures: string[] = [];
    if (!documentIdentityOk) {
      harnessInvalid = true;
      surfaceFailures.push('document-identity');
      diagnostics.push(
        createDiagnostic(
          'BRIDGE_CURSOR_INVALID',
          'Observation bridge document/currentness identity is missing or malformed.',
        ),
      );
    }
    if (!methodsExact) {
      harnessInvalid = true;
      surfaceFailures.push('surface');
      diagnostics.push(
        createDiagnostic(
          'BRIDGE_SURFACE_MISMATCH',
          `Observation bridge exposes ${observedMethods.join(', ') || 'no callable methods'}, not the exact eight-method read-only surface.`,
          { context: { observed: observedMethods.join(',') } },
        ),
      );
    }
    if (!bridgeFrozen) {
      harnessInvalid = true;
      surfaceFailures.push('frozen');
      diagnostics.push(
        createDiagnostic(
          'BRIDGE_NOT_FROZEN',
          'Observation bridge object is not frozen, so its read-only surface could drift at runtime.',
        ),
      );
    }
    if (!cursorOk) {
      harnessInvalid = true;
      surfaceFailures.push('cursor');
      diagnostics.push(
        createDiagnostic(
          'BRIDGE_CURSOR_INVALID',
          `Observation cursor is malformed or does not match the live document (schema=${String(
            cursorSchemaVersion,
          )}, document=${String(cursorDocumentId)}, revision=${String(cursorRevision)}).`,
        ),
      );
    }
    if (!cursorStable) {
      harnessInvalid = true;
      surfaceFailures.push('cursor-stable');
      diagnostics.push(
        createDiagnostic(
          'BRIDGE_CURSOR_INVALID',
          'Two consecutive observation cursor reads did not agree on document/generation/revision.',
        ),
      );
    }
    if (!waiterBounded) {
      harnessInvalid = true;
      surfaceFailures.push('waiter');
      diagnostics.push(
        createDiagnostic(
          'BRIDGE_WAITER_UNBOUNDED',
          `The bounded zero-timeout waiter did not report a timeout (status=${String(
            inspection?.waiter?.status,
          )}).`,
        ),
      );
    }
    const probe = inspection?.geometryProbe ?? null;
    if (probe !== null && probe.hasGeometryV2 === true) {
      if (asNumber(probe.schemaVersion) !== 2) {
        harnessInvalid = true;
        surfaceFailures.push('geometry-schema');
        diagnostics.push(
          createDiagnostic(
            'GEOMETRY_REPRESENTATION_UNSUPPORTED',
            `Live geometry publishes schema ${String(probe.schemaVersion)} instead of the required geometry schema 2.`,
          ),
        );
      }
      if (probe.mounted !== true) {
        harnessInvalid = true;
        surfaceFailures.push('geometry-target');
        diagnostics.push(
          createDiagnostic(
            'GEOMETRY_TARGET_ID_MISMATCH',
            'The typed geometry probe target is not mounted.',
          ),
        );
      }
    }
    const rasterProbe = inspection?.rasterProbe ?? null;
    if (rasterProbe !== null && rasterProbe.isPromise !== true) {
      harnessInvalid = true;
      surfaceFailures.push('raster-promise');
      diagnostics.push(
        createDiagnostic(
          'RASTER_SCHEMA_UNSUPPORTED',
          'bridge.raster did not return a Promise, contrary to the bridge v7 raster contract.',
        ),
      );
    } else if (rasterProbe !== null && asNumber(rasterProbe.schemaVersion) !== 3) {
      harnessInvalid = true;
      surfaceFailures.push('raster-schema');
      diagnostics.push(
        createDiagnostic(
          'RASTER_SCHEMA_UNSUPPORTED',
          `bridge.raster resolved to schema ${String(rasterProbe.schemaVersion)} instead of the required raster schema 3.`,
        ),
      );
    }
    if (inspection?.mutationDetected === true) {
      harnessInvalid = true;
      surfaceFailures.push('mutation');
      diagnostics.push(
        createDiagnostic(
          'BRIDGE_MUTATION_DETECTED',
          'Reading observation methods changed the authoritative layout/selection/camera digest; the bridge is not read-only.',
        ),
      );
    }
    if (observedScenegraphInSync === null) {
      harnessInvalid = true;
      surfaceFailures.push('scenegraph');
      diagnostics.push(
        createDiagnostic(
          'DOCTOR_INSTANCE_MISMATCH',
          'The live Doctor payload omitted the scenegraph discrepancy fact.',
        ),
      );
    }
    if (surfaceFailures.length > 0) harnessInvalid = true;
  }
  if (observedScenegraphInSync === false) {
    diagnostics.push(
      createDiagnostic(
        'ARTWORK_SCENEGRAPH_MIRROR_STALE',
        `Authoritative layoutItems report ${String(observedRootCount)} content root(s) while the flattened nodes/rootIds mirror reports ${String(
          observedScenegraphRootCount,
        )}; the mirror is stale and is reported without repair.`,
      ),
    );
  }
  if (!routeOk || title !== DOCTOR_TITLE) {
    harnessInvalid = true;
    diagnostics.push(
      createDiagnostic(
        'DOCTOR_INSTANCE_MISMATCH',
        `Owned instance identity mismatch: route "${finalUrl}", title "${title}".`,
      ),
    );
  }
  if (missingLayers.length > 0) {
    harnessInvalid = true;
    diagnostics.push(
      createDiagnostic(
        'DOCTOR_INSTANCE_MISMATCH',
        `Missing mounted Konva Stage layers: ${missingLayers.join(', ')}.`,
      ),
    );
  }

  const result: LegacyDoctorResult = {
    schemaVersion: DOCTOR_RESULT_SCHEMA_VERSION,
    runId: allocation.runId,
    launchAttempted: true,
    outcome: 'HARNESS_BLOCKED',
    route: DOCTOR_ROUTE,
    finalUrl,
    title,
    httpStatus,
    bridge: {
      available: bridgeAvailable && inspection !== null && doctorPayload !== null,
      expectedVersion,
      observedVersion,
      documentId: observedDocumentId,
      documentEpoch: observedDocumentEpoch,
      frozen: inspection?.frozen === true ? true : inspection ? false : null,
      methods: observedMethods,
      bridgeGeneration: cursorGeneration,
      revision: cursorRevision,
      cursorSchemaVersion,
      cursorStable,
      waiterBounded,
    },
    stage: {
      mounted,
      width: asNumber(doctorPayload?.stage?.width),
      height: asNumber(doctorPayload?.stage?.height),
      layerNames,
    },
    state: {
      rootCount: observedRootCount,
      scenegraphRootCount: observedScenegraphRootCount,
      nodeCount: asNumber(doctorPayload?.state?.nodeCount),
      layoutCount: asNumber(doctorPayload?.state?.layoutCount),
      layerCount: asNumber(doctorPayload?.state?.layerCount),
      scenegraphInSync: observedScenegraphInSync,
    },
    environment: input.environmentFacts,
    environmentObserved: observedEnvironmentValue,
    environmentMismatches,
    registry: { ...input.registry },
    appRevision: { ...input.appRevision },
    ownership: {
      runId: allocation.runId,
      port: allocation.port,
      repoRelativeDistDir: allocation.repoRelativeDistDir,
      scratchRoot: allocation.scratchRoot,
      evidenceRoot: allocation.evidenceRoot,
      routeNamespace: allocation.routeNamespace,
      storageNamespace: allocation.storageNamespace,
    },
    requiredChecks,
    testedSellerAction: false,
    diagnostics,
    consoleErrors: session?.consoleErrors ?? [],
    failedRequests: session?.failedRequests ?? [],
    evidence: {
      doctorJson: doctorJsonPath,
      doctorPng: doctorPngPath,
      serverLog: path.join(allocation.evidenceRoot, 'server.log'),
    },
  };

  const behaviorOutcome = classifyLegacyOutcome({
    requiredChecks,
    cleanupSucceeded: true,
    harnessInvalid,
    environmentInvalid,
  });
  result.outcome = behaviorOutcome;

  writeFileSync(doctorJsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  // Additive inactive raw facts (ADR 0031 §2). Derived directly from the same
  // named browser observations above, never from the legacy `requiredChecks`
  // array or the `harnessInvalid` side channel.
  const rawFacts = projectDoctorRawCommandFacts({
    pageReachable: session !== null && httpStatus !== null,
    routeMatches: routeOk,
    titleMatches: title === DOCTOR_TITLE,
    finalUrl,
    title,
    bridgePresent: bridgeAvailable,
    inspectionPresent: inspection !== null,
    documentIdentityPresent: documentIdentityOk,
    observedDocumentId,
    observedDocumentEpoch,
    observedVersion,
    expectedVersion,
    observedMethods,
    methodsExact,
    bridgeFrozen,
    cursorWellFormed,
    cursorCurrent: cursorOk,
    cursorStable,
    waiterPresent: inspection?.waiter !== null && inspection?.waiter !== undefined,
    waiterBounded,
    geometryOk,
    rasterOk,
    mutationDetected:
      typeof inspection?.mutationDetected === 'boolean' ? inspection.mutationDetected : null,
    stageMounted: mounted,
    missingLayers,
    layoutCount: typeof stateLayouts === 'number' ? stateLayouts : null,
    minLayouts: 2,
    scenegraphPresent: observedScenegraphInSync !== null,
    scenegraphInSync: observedScenegraphInSync,
    environmentObserved: observedEnvironmentValue !== null,
    environmentMismatchCount: environmentMismatches.length,
    environmentCellId: input.environment.cellId,
    browserCloseError,
  });

  return {
    result,
    requiredChecks,
    harnessInvalid,
    environmentInvalid,
    behaviorOutcome,
    browserCloseError,
    rawFacts,
  };
}
