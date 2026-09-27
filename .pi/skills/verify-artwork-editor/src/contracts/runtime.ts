import type { AllocationFailureReason, CliStatus, Outcome } from './discriminants';
import type { CheckResult } from './execution';
import type { DiagnosticRecord } from './diagnostics';

/**
 * Owned-runtime, Doctor, cleanup, and CLI contracts (specification 9.3, 10;
 * Gate D; TS-2 / TS-5).
 *
 * A run exclusively owns one loopback port, one process group, one namespaced
 * Next `distDir` under `.next/verify-runs/<run-id>`, one scratch root, one
 * route-handler/storage namespace, and one append-only evidence root. Every
 * field here is an attempt-specific resource: none of it enters `caseId`,
 * `materializationFingerprint`, or `planFingerprint`.
 */

// ── Environment cell (specification 9.3) ─────────────────────────────────────

export const ENVIRONMENT_CELL_CLASSIFICATIONS = [
  'diagnostic-only',
  'excluded-with-reason',
  'required-credit',
] as const;
export type EnvironmentCellClassification = (typeof ENVIRONMENT_CELL_CLASSIFICATIONS)[number];

export const BROWSER_KINDS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];

export interface ViewportSize {
  width: number;
  height: number;
}

/** One versioned environment cell; a change to any field is a new fingerprint. */
export interface EnvironmentCell {
  cellId: string;
  classification: EnvironmentCellClassification;
  browserKind: BrowserKind;
  browserChannel: string;
  playwrightVersion: string;
  viewport: ViewportSize;
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  colorScheme: 'dark' | 'light';
  reducedMotion: 'no-preference' | 'reduce';
  permissions: readonly string[];
  geolocation: { latitude: number; longitude: number } | null;
  /** Fresh non-persistent context; a reused storage state is never declared. */
  storageState: null;
}

export interface EnvironmentCatalogue {
  schemaVersion: number;
  cells: readonly EnvironmentCell[];
}

/** Runtime platform/process facts recorded with each Doctor result. */
export interface EnvironmentFacts {
  cellId: string;
  classification: EnvironmentCellClassification;
  browserKind: BrowserKind;
  browserChannel: string;
  playwrightVersion: string;
  /** Playwright version resolved from the installed package; may drift. */
  installedPlaywrightVersion: string;
  chromiumRevision: string | null;
  viewport: ViewportSize;
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

/**
 * Environment facts observed from the live browser page (specification 9.3, 10).
 *
 * Every value here is reported by the running browser and is never copied from
 * the governed `EnvironmentCell`, so the Doctor can compare what actually ran
 * against what was declared. A `null` value means the page did not expose that
 * fact (for example an unsupported media query) and is recorded as unobserved
 * rather than assumed to match.
 */
export interface ObservedEnvironmentFacts {
  /** Live `window.innerWidth`/`innerHeight` layout viewport. */
  viewport: ViewportSize;
  devicePixelRatio: number;
  language: string | null;
  timezoneId: string | null;
  colorScheme: 'dark' | 'light' | null;
  reducedMotion: 'no-preference' | 'reduce' | null;
}

/** Closed vocabulary of governed environment facts the Doctor compares. */
export const OBSERVED_ENVIRONMENT_FACTS = [
  'viewport',
  'devicePixelRatio',
  'locale',
  'timezoneId',
  'colorScheme',
  'reducedMotion',
] as const;
export type ObservedEnvironmentFact = (typeof OBSERVED_ENVIRONMENT_FACTS)[number];

/** One declared-versus-observed environment discrepancy. */
export interface EnvironmentFactMismatch {
  fact: ObservedEnvironmentFact;
  declared: string;
  observed: string;
}

// ── Owned run allocation ─────────────────────────────────────────────────────

export interface RunAllocation {
  runId: string;
  /**
   * Absolute root of the repository the run owns: the explicit, validated
   * application checkout (`--app-root`) for an app-root run, or this toolkit's
   * own repository for a legacy caller. The owned launch cwd, the Next
   * `distDir`, the shared-config snapshot, and the recorded app revision all
   * bind to this root. It is never inferred from the toolkit location.
   */
  repoRoot: string;
  /** Absolute toolkit skill root; owns catalogues, fixtures and evidence. */
  skillRoot: string;
  /** Repo-relative owned Next output path: `.next/verify-runs/<run-id>`. */
  repoRelativeDistDir: string;
  /** Absolute owned Next output path, derived from `repoRoot`. */
  distDir: string;
  /** Absolute owned scratch root; the cross-process allocation lease. */
  scratchRoot: string;
  /** Absolute append-only evidence root; preserved by every cleanup. */
  evidenceRoot: string;
  /** Case-local route-handler namespace bound to the run id. */
  routeNamespace: string;
  /** Case-local browser storage namespace bound to the run id. */
  storageNamespace: string;
  port: number;
  baseUrl: string;
  environmentCellId: string;
}

export const RUN_OWNERSHIP_STATES = ['allocated', 'cleaned', 'launched', 'stopped'] as const;
export type RunOwnershipState = (typeof RUN_OWNERSHIP_STATES)[number];

/** Durable ownership record written to `<scratchRoot>/ownership.json`. */
export interface RunOwnershipRecord extends RunAllocation {
  schemaVersion: number;
  owner: 'verify-artwork-editor';
  state: RunOwnershipState;
  createdAt: string;
  updatedAt: string;
  processPid: number | null;
  processGroupId: number | null;
  ownedCommand: readonly string[] | null;
  serverLogPath: string;
  /**
   * Versioned snapshot of the shared repository config files the dev server may
   * rewrite (`tsconfig.json` and `next-env.d.ts`). Cleanup restores the exact
   * bytes of a file that existed before the run and removes one the run created.
   */
  repoConfigSnapshot: RepoConfigSnapshot | null;
  /** Only ever set by this toolkit; cleanup refuses records it cannot verify. */
  activeCase: string | null;
}

export interface RunAllocationFailure {
  ok: false;
  reason: AllocationFailureReason;
  detail: string;
}

export type RunAllocationResult = { ok: true; allocation: RunAllocation } | RunAllocationFailure;

// ── Shared repository config snapshot ────────────────────────────────────────

/**
 * One shared repository config file owned by a verification run.
 *
 * `existedBefore` distinguishes the two restore obligations: byte-exact
 * restoration of a file that was already present, and removal of a file the
 * owned run created where none existed before. `digestBefore`/`snapshotPath` are
 * null exactly when `existedBefore` is false.
 */
export interface RepoConfigFileSnapshot {
  relativePath: string;
  path: string;
  existedBefore: boolean;
  digestBefore: string | null;
  snapshotPath: string | null;
}

/**
 * Versioned multi-file snapshot of the shared repository config files an owned
 * Next.js dev server may rewrite (`tsconfig.json` and `next-env.d.ts`). The
 * schema version identifies one stable shape; an unknown version fails closed
 * instead of being coerced.
 */
export interface RepoConfigSnapshot {
  schemaVersion: number;
  files: readonly RepoConfigFileSnapshot[];
}

// ── Cleanup / recovery ───────────────────────────────────────────────────────

export interface CleanupVerification {
  processSignalled: number | null;
  processEscalated: boolean;
  processDead: boolean;
  portClosed: boolean;
  distDirRemoved: boolean;
  scratchRemoved: boolean;
  /** A shared config file rewritten by the dev server was restored byte-exactly. */
  configRestored: boolean;
  /** Every fresh browser context/browser this run opened was closed. */
  browserClosed: boolean;
  /** Evidence is never removed by cleanup. */
  evidencePreserved: boolean;
}

export interface CleanupResult {
  schemaVersion: number;
  runId: string;
  attempted: boolean;
  complete: boolean;
  alreadyClean: boolean;
  /** Null when ownership could not be established; cleanup then does nothing. */
  refusedReason: AllocationFailureReason | null;
  detail: string;
  verification: CleanupVerification;
  /** Structured filesystem/ownership diagnostics; never a thrown error. */
  diagnostics: readonly DiagnosticRecord[];
}

// ── Doctor ───────────────────────────────────────────────────────────────────

/**
 * Doctor bridge facts (v3). The v3 fields are independently inspected from the
 * live bridge object in the page realm: the frozen method surface, the
 * document-correlated observation cursor, and the bridge generation. A bridge's
 * own `doctor().methods` claim is evidence only and never self-authenticating.
 */
export interface DoctorBridgeFacts {
  available: boolean;
  expectedVersion: number;
  observedVersion: number | null;
  /** Bridge document identity; null when the bridge did not report it. */
  documentId: string | null;
  /** Bridge document/currentness epoch anchor; null when not reported. */
  documentEpoch: number | null;
  /** Independent inspection: the bridge object is frozen. */
  frozen: boolean | null;
  /** Independent inspection: callable own method names observed on the bridge. */
  methods: readonly string[];
  /** Bridge generation from the independently read cursor; >= 1 when valid. */
  bridgeGeneration: number | null;
  /** Monotonic observation revision from the independently read cursor. */
  revision: number | null;
  /** Cursor schema version reported by the bridge. */
  cursorSchemaVersion: number | null;
  /** Two no-change cursor reads returned an identical revision. */
  cursorStable: boolean | null;
  /** A zero-timeout waiter was bounded and resolved as a timeout. */
  waiterBounded: boolean | null;
}

export interface DoctorStageFacts {
  mounted: boolean;
  width: number | null;
  height: number | null;
  layerNames: readonly string[];
}

export interface DoctorStateFacts {
  /** Authoritative content root count derived from `layoutItems`. */
  rootCount: number | null;
  /** Reported stale-prone mirror root count; never the rendered truth. */
  scenegraphRootCount: number | null;
  nodeCount: number | null;
  layoutCount: number | null;
  layerCount: number | null;
  /**
   * Reported `layoutItems` versus `nodes/rootIds` fact. Recorded and surfaced as
   * a warning when false; never repaired and never treated as rendered truth
   * (specification 17). Null when the bridge did not report it.
   */
  scenegraphInSync: boolean | null;
}

export interface DoctorRegistryFacts {
  schemaVersion: number | null;
  fingerprint: string | null;
  resolvedSubjects: number | null;
}

export interface DoctorAppRevisionFacts {
  commit: string | null;
  dirty: boolean | null;
}

export interface DoctorOwnershipFacts {
  runId: string;
  port: number;
  repoRelativeDistDir: string;
  scratchRoot: string;
  evidenceRoot: string;
  routeNamespace: string;
  storageNamespace: string;
}

/**
 * Legacy Doctor runtime result.
 *
 * E3-S2 makes the explicit command-context status authority
 * (`contracts/command-check.ts`, carried by the strict v4 command record read
 * through `contracts/final-record-reader.ts`/`evidence/final-reader.ts`) the sole
 * current Doctor authority. The active E3 path must not consume this record's
 * boolean `requiredChecks`, `harnessInvalid`, or preclassified `behaviorOutcome`;
 * the raw Doctor facts and their live-fact adapter are the current producer
 * surface.
 *
 * This shape is retained only for read-only consumers that have not yet been
 * rewired and for retained test support.
 *
 * @deprecated Legacy Doctor result authority; not current authority
 * (ADR 0031 §"Public export closure").
 */
export interface DoctorResult {
  schemaVersion: number;
  runId: string;
  launchAttempted: true;
  outcome: Outcome;
  route: string;
  finalUrl: string;
  title: string;
  httpStatus: number | null;
  bridge: DoctorBridgeFacts;
  stage: DoctorStageFacts;
  state: DoctorStateFacts;
  environment: EnvironmentFacts;
  /** Facts read from the live page; null when they could not be observed. */
  environmentObserved: ObservedEnvironmentFacts | null;
  /** Declared-versus-observed discrepancies; empty only when every fact matches. */
  environmentMismatches: readonly EnvironmentFactMismatch[];
  registry: DoctorRegistryFacts;
  appRevision: DoctorAppRevisionFacts;
  ownership: DoctorOwnershipFacts;
  requiredChecks: readonly CheckResult[];
  /** Doctor never performs a tested seller action. */
  testedSellerAction: false;
  diagnostics: readonly DiagnosticRecord[];
  consoleErrors: readonly string[];
  failedRequests: readonly { url: string; error: string }[];
  evidence: { doctorJson: string; doctorPng: string; serverLog: string };
}

// ── Stable CLI envelope (TS-2) ───────────────────────────────────────────────

export interface CliResult<TDetails = unknown> {
  schemaVersion: number;
  command: string;
  subcommand: string | null;
  status: CliStatus;
  exitCode: number;
  launchAttempted: boolean;
  outcome: Outcome | null;
  detail: string;
  details: TDetails | null;
  diagnostics: readonly DiagnosticRecord[];
}

// ── Static launchability projection ──────────────────────────────────────────

export interface LaunchabilityProjection {
  schemaVersion: number;
  /** True only when every pre-launch stage, including P5/P7, resolved. */
  launchable: boolean;
  blockers: readonly string[];
  deferredStages: readonly string[];
  detail: string;
}
