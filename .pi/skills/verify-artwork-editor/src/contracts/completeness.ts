import type { BindingCorrectnessState } from './correctness';
import type { DiagnosticRecord } from './diagnostics';
import type { Capability } from './discriminants';

/**
 * Package 7 Slice C completeness ledger contract (gap-plan §5 P7-C; ADR 0039).
 *
 * The ledger is a closed, versioned, machine-readable accounting of Package 7
 * completeness. It keeps every dimension separate and never lets one dimension
 * stand in for another:
 *
 * - declared Subject × Capability bindings (the registry surface);
 * - Coverage Models (binding-model presence);
 * - compiled correctness profiles (delivered-route compilation);
 * - runtime availability (which compiled routes the Diagnostic runtime can
 *   actually execute);
 * - deterministically selected Release assignments (selection surface);
 * - accepted representative Diagnostic cases (the bounded eight-case accepted
 *   execution);
 * - diagnostic-only scenarios (which are never Release authority);
 * - Release credit, which is **never** granted by this slice.
 *
 * A `PASS`/binding-model/execution/selection/scope distinction is preserved:
 * the fifty-five selected Release assignments are not the eight accepted
 * representative Diagnostic cases, and the sixty-five declared bindings are not
 * sixty-five compiled or executed routes.
 *
 * This contract deliberately records observed SHA-256 values of the accepted,
 * historical, read-only suite evidence. It performs no tamper/integrity
 * verification and makes no Package-8 integrity claim: that authority belongs to
 * Package 8.
 */

/** Closed schema version of the completeness ledger artifact. */
export const PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION = 1;

/** Stable artifact discriminants. */
export const PACKAGE7_COMPLETENESS_LEDGER_ARTIFACT_ID = 'package7-completeness-ledger';
export const PACKAGE7_COMPLETENESS_LEDGER_LABEL = 'package7-completeness-ledger.v1';
export const PACKAGE7_COMPLETENESS_LEDGER_FILE_NAME = 'package7-completeness-ledger.v1.json';
export const PACKAGE7_COMPLETENESS_LEDGER_BRANCH = 'P7-C';

/** Skill-relative durable artifact path. */
export const PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH = `evidence/${PACKAGE7_COMPLETENESS_LEDGER_FILE_NAME}`;

/**
 * The accepted, historical, read-only representative suite execution identity
 * (ADR 0039). This names the accepted suite; it is not an integrity hash and no
 * ADR or child hash is hardcoded anywhere in this slice.
 */
export const ACCEPTED_REPRESENTATIVE_SUITE_EXECUTION_ID = 'b3-representative-20260921-attempt3';

/** The closed declared representative suite identity the accepted record binds. */
export const ACCEPTED_REPRESENTATIVE_SUITE_ID = 'representative';

/** Relative directory roles inside the toolkit evidence root. */
export const EVIDENCE_SUITES_DIR_NAME = 'suites';
export const EVIDENCE_RUNS_DIR_NAME = 'runs';
export const SUITE_RECORD_FILE_NAME = 'suite-record.json';
export const RUN_RECORD_FILE_NAME = 'run-record.json';

/** The six separate completeness dimensions; none may collapse into another. */
export const PACKAGE7_COMPLETENESS_DIMENSIONS = [
  'binding-model',
  'correctness-profile',
  'runtime-availability',
  'release-assignment',
  'diagnostic-scenario',
  'release-credit',
] as const;
export type Package7CompletenessDimensionName = (typeof PACKAGE7_COMPLETENESS_DIMENSIONS)[number];

export function isPackage7CompletenessDimension(
  value: unknown,
): value is Package7CompletenessDimensionName {
  return (
    typeof value === 'string' &&
    (PACKAGE7_COMPLETENESS_DIMENSIONS as readonly string[]).includes(value)
  );
}

/** Closed dimension status vocabulary. */
export const PACKAGE7_COMPLETENESS_STATUSES = [
  'complete',
  'incomplete',
  'unavailable',
  'deferred',
] as const;
export type Package7CompletenessStatus = (typeof PACKAGE7_COMPLETENESS_STATUSES)[number];

export function isPackage7CompletenessStatus(value: unknown): value is Package7CompletenessStatus {
  return (
    typeof value === 'string' &&
    (PACKAGE7_COMPLETENESS_STATUSES as readonly string[]).includes(value)
  );
}

/** One separately reported completeness dimension. */
export interface Package7CompletenessDimension {
  dimension: Package7CompletenessDimensionName;
  status: Package7CompletenessStatus;
  /** The dimension's own count; never another dimension's count. */
  count: number | null;
  /** Always false: this slice grants no Release credit on any dimension. */
  releaseCredit: false;
  qualification: string;
}

/** Top-level counts. Each is a distinct quantity; none is interchangeable. */
export interface Package7CompletenessCounts {
  declaredBindings: number;
  coverageModels: number;
  bindingsWithoutModels: number;
  compiledProfiles: number;
  selectedReleaseAssignments: number;
  releaseAssignmentsExecuted: number;
  acceptedRepresentativeCases: number;
  diagnosticOnlyScenarios: number;
  runtimeAvailableSelections: number;
}

/** One declared binding's completeness projection. */
export interface Package7BindingLedgerEntry {
  subjectId: string;
  capability: Capability;
  state: BindingCorrectnessState;
  coverageModelPresent: boolean;
  routeSelectionPresent: boolean;
  /** True only when a delivered compiled route for this binding has a runtime. */
  runtimeAvailable: boolean;
  /** True only when an accepted representative case binds this exact binding. */
  representativeCaseAccepted: boolean;
  releaseCredit: false;
  detail: string;
}

/** One Coverage Model's selection and execution projection. */
export interface Package7CoverageModelLedgerEntry {
  subjectId: string;
  capability: Capability;
  modelFingerprint: string;
  /** Deterministically selected Release assignments for this model. */
  selectedReleaseAssignments: number;
  /** Deterministically selected Diagnostic cases (superset of Release). */
  selectedDiagnosticCases: number;
  diagnosticOnlyScenarios: number;
  /** Accepted representative Diagnostic cases binding this model. */
  representativeCases: number;
  bindingState: BindingCorrectnessState;
  runtimeAvailable: boolean;
  releaseCredit: false;
  qualification: string;
}

/** One compiled correctness profile and its runtime availability. */
export interface Package7CompiledProfileEntry {
  subjectId: string;
  capability: Capability;
  variant: string | null;
  profileId: string;
  resolvedFingerprint: string;
  adapterId: string | null;
  workflowId: string | null;
  runtimeAvailable: boolean;
  releaseCredit: false;
}

/** Closed accepted-suite projection states. */
export const PACKAGE7_ACCEPTED_SUITE_STATES = [
  'accepted',
  'absent',
  'unavailable',
  'invalid',
] as const;
export type Package7AcceptedSuiteState = (typeof PACKAGE7_ACCEPTED_SUITE_STATES)[number];

export function isPackage7AcceptedSuiteState(value: unknown): value is Package7AcceptedSuiteState {
  return (
    typeof value === 'string' &&
    (PACKAGE7_ACCEPTED_SUITE_STATES as readonly string[]).includes(value)
  );
}

/** One read-only projection of an accepted representative child execution. */
export interface Package7AcceptedSuiteChildProjection {
  order: number;
  caseId: string;
  request: string;
  runId: string;
  executionId: string;
  profile: string | null;
  materializationFingerprint: string | null;
  planFingerprint: string | null;
  behaviorOutcome: string | null;
  finalOutcome: string;
  cleanupComplete: boolean;
  /** Skill-relative read-only run-record path; never an absolute private path. */
  recordPath: string;
  /** Observed byte digest; not compared against any ADR hash. */
  observedSha256: string | null;
  observedBytes: number | null;
  /** True when the strict current run record agrees with the aggregate child. */
  recordIdentitySatisfied: boolean;
}

/**
 * The read-only accepted representative Diagnostic suite projection.
 *
 * The projection records observed byte digests of the historical evidence but
 * performs no integrity/tamper verification: `integrityVerified` is always
 * false and the integrity owner is Package 8.
 */
export interface Package7AcceptedSuiteProjection {
  suiteExecutionId: string;
  suiteId: string | null;
  suiteVersion: number | null;
  suiteFingerprint: string | null;
  suiteRecordPath: string;
  suiteRecordObservedSha256: string | null;
  suiteRecordObservedBytes: number | null;
  declaredCaseCount: number;
  acceptedCaseCount: number;
  state: Package7AcceptedSuiteState;
  children: readonly Package7AcceptedSuiteChildProjection[];
  releaseCredit: false;
  integrityVerified: false;
  integrityOwner: 'package-8';
  qualification: string;
}

/** The complete closed completeness ledger. */
export interface Package7CompletenessLedger {
  schemaVersion: typeof PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION;
  artifactId: typeof PACKAGE7_COMPLETENESS_LEDGER_ARTIFACT_ID;
  label: typeof PACKAGE7_COMPLETENESS_LEDGER_LABEL;
  branch: typeof PACKAGE7_COMPLETENESS_LEDGER_BRANCH;
  catalogueSchemaVersion: number;
  catalogueFingerprint: string;
  counts: Package7CompletenessCounts;
  dimensions: readonly Package7CompletenessDimension[];
  bindings: readonly Package7BindingLedgerEntry[];
  coverageModels: readonly Package7CoverageModelLedgerEntry[];
  compiledProfiles: readonly Package7CompiledProfileEntry[];
  acceptedRepresentativeSuite: Package7AcceptedSuiteProjection;
  /** Always false. Never granted by P7-C. */
  releaseCreditGranted: false;
  /** Always false. Package-8-owned integrity verification is not performed here. */
  integrityVerificationPerformed: false;
  /** Explicit Gate F/G/H, Release, and production nonclaims. */
  nonClaims: readonly string[];
  /** Domain-separated full canonical SHA-256 identity of the ledger content. */
  fingerprint: string;
}

/** Explicit Package-7 nonclaims carried by every generated ledger. */
export const PACKAGE7_COMPLETENESS_NON_CLAIMS: readonly string[] = Object.freeze([
  'This ledger accounts registry, selection, compilation, runtime-support, and accepted-representative completeness only; it is not a production-verification claim.',
  'Release credit is never granted: every dimension, binding, Coverage Model, compiled profile, and representative case records releaseCredit=false.',
  'The selected Release assignments are a deterministic selection surface, not executed, passing, or Release-qualified results, and they are never conflated with the accepted representative Diagnostic cases.',
  'The accepted representative Diagnostic suite is diagnostic infrastructure and earns no Release credit; diagnostic-only scenarios can never satisfy a Release obligation.',
  'The sixty-five declared bindings are not sixty-five compiled or executed routes; bindings without models remain explicitly unavailable.',
  'Observed SHA-256 values are recorded read-only from the accepted historical evidence; no tamper, integrity, or provenance verification is performed here. Integrity remains Package 8 / Gate F authority.',
  'Gate F (evidence and integrity), Gate G (Release qualification and execution parity), and Gate H (cold-agent/feature completion) are not closed by this slice.',
  'No manifest approval, qualification, promotion, Release Run, backend change, product-defect repair, commit, push, or deployment is authorized or implied.',
]);

/** One build result: the ledger plus every blocking/non-blocking finding. */
export interface Package7CompletenessBuildResult {
  ledger: Package7CompletenessLedger;
  findings: readonly DiagnosticRecord[];
}
