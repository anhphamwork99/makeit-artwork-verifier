import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allocateRun, allocationFailureCliStatus } from '../allocation/allocate';
import { admitCase, evidenceRootFor, releaseCase } from '../allocation/lease';
import { resolveAdapterImplementation } from '../adapters/registry';
import { loadCatalogueBundle, type CatalogueBundle } from '../catalogue/load';
import {
  findResource,
  loadResourceManifest,
  RESOURCE_FILES_RELATIVE_PATH,
} from '../catalogue/resources';
import { deriveCaseId } from '../canonical/identity';
import { resolveBindingFixture } from '../catalogue/fixtures';
import { resolveAllResources, type ResolvedResource } from '../resources/resolve';
import {
  deriveResourceManifestFingerprint,
  deriveWorkflowStepCatalogueFingerprint,
} from '../catalogue/fingerprint';
import { cleanupRun, noOwnedLeaseCleanup } from '../cleanup/cleanup';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import { assessHostCompatibility } from '../contracts/host-compatibility';
import type {
  AllocationFailureReason,
  Capability,
  CliStatus,
  CoverageStatus,
  Outcome,
} from '../contracts/discriminants';
import type { OracleEvaluatorKind } from '../contracts/correctness';
import type {
  CliResult,
  CleanupResult,
  EnvironmentCell,
  EnvironmentCatalogue,
  RunAllocation,
} from '../contracts/runtime';
import type { WakeSource } from '../contracts/observation';
import type { PublicSuiteLineageV1 } from '../contracts/suite';
import {
  buildCleanupProjection,
  buildNotEstablishedOwnership,
  buildPublicLaunchFacts,
  redactDiagnostics,
  redactRecordText,
  sensitiveRootsOf,
  type PublicCleanupProjection,
  type PublicOwnershipProjection,
  type RunRecordFingerprints,
} from '../evidence/public-dto';
import { sensitiveGuardPaths, type CleanupAuthoritySnapshot } from '../evidence/cleanup-authority';
import {
  planFinalActivePathCase,
  runFinalDiagnosticActivePath,
  type FinalActivePathDurableOutcome,
  type FinalActivePathDurableSink,
  type FinalActivePathRunOperationals,
  type FinalDiagnosticActivePathOutcome,
} from '../orchestration/final-active-path';
import type { DiagnosticPrelaunchFacts } from '../orchestration/diagnostic-execution';
import type { PlanForExecutionResult } from '../planner/plan-case';
import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import { validateMaterializedExecutionEnvelope } from '../planner/execution-materialization';
import { resolveExecutionSupport } from '../planner/execution-support';
import {
  executePlan,
  type ExecutePlanBehavior,
  type FinalExecutionObservation,
} from '../runtime/execute-plan';
import { launchOwnedServer } from '../runtime/launch';
import { generateRunId } from '../runtime/run-id';
import { collectAppRevision, lockfileDigest } from '../runtime/environment-facts';
import {
  DEFAULT_ENVIRONMENT_CELL_ID,
  loadEnvironmentCatalogue,
  resolveEnvironmentCell,
} from '../runtime/environment';
import { resolveRepoRoot, resolveSkillRoot } from '../runtime/paths';
import { evidenceBaseDir, resolveEvidenceRoot } from '../runtime/evidence-root';
import {
  loadProductMeaningProvider,
  type ProductMeaningProviderFailureCode,
  type ProductMeaningProviderRef,
} from '../runtime/product-meaning-provider';
import { resolveWorkflowSteps } from '../workflows/steps';
import { buildCliResult } from './output';
import { setActiveRun } from './termination';

/**
 * `pnpm verify:artwork diagnostic --case <request.json>` (TS-2/TS-4/TS-5; WP5
 * Slice 5-A; post-cutover current path, ADR 0032 §E3-S2, ADR 0033 §Diagnostic
 * flow).
 *
 * One closed drive: plan the exact compile-once envelope, allocate exclusive
 * resources, launch exactly one owned Next.js server, seal the fixture, perform
 * one real native pointer drag, hand the executor-produced atomic final
 * observation to the current final façade, and preserve the strict-v4 public
 * record. `--port` is a diagnostic-only override that mirrors
 * `allocateRun.requestedPort` so the allocation-fault proof can occupy the port
 * before launch.
 *
 * This entry owns operational facts only — allocation, launch, ownership,
 * cleanup, repository identity, timing, and the explicit durable sink. It never
 * classifies a result, never rebuilds a correctness payload, never reads a
 * legacy boolean/`harnessInvalid` authority, and never writes a v2/v3 record:
 * every correctness decision and every durable write happens inside the final
 * façade.
 */

/** The drive report a diagnostic run binds for a generated-Crossword case. */
export type CrosswordDriveReportView = NonNullable<ExecutePlanBehavior['crossword']>;

export interface CrosswordRecordFacts {
  /** True only when a Crossword drive report is actually bound. */
  bound: boolean;
  /** Observed target-aware stable frames; `null` when no Crossword drive ran. */
  observedStableFrames: number | null;
  /** Aggregate target-aware idle result, credited only for a bound drive. */
  idle: CrosswordDriveReportView['readiness']['idle'];
  /** The first accepted child observation id, or `null`; never fabricated. */
  firstChildObservationId: string | null;
}

/**
 * The Crossword-derived operational record facts, captured from the one bound
 * drive report. A missing or explicitly null report is handled once, fabricating
 * nothing: no idle credit and no child execution or evidence id. These are
 * operational readiness facts, never correctness authority.
 */
export function crosswordRecordFacts(
  crossword: ExecutePlanBehavior['crossword'],
): CrosswordRecordFacts {
  if (crossword === null || crossword === undefined) {
    return {
      bound: false,
      observedStableFrames: null,
      idle: null,
      firstChildObservationId: null,
    };
  }
  return {
    bound: true,
    observedStableFrames: crossword.readiness.observedStableFrames,
    idle: crossword.readiness.idle,
    firstChildObservationId: crossword.children[0]?.observationId ?? null,
  };
}

/** One owned launch fact block; `null` until the owned server reports one. */
export interface DiagnosticLaunchFacts {
  pid: number;
  processGroupId: number;
  readinessMs: number | null;
  serverLogPath: string;
}

export interface DiagnosticAllocationProjection {
  runId: string;
  port: number;
  baseUrl: string;
  repoRelativeDistDir: string;
  environmentCellId: string;
  routeNamespace: string;
  storageNamespace: string;
}

export interface DiagnosticDurableDetails {
  required: boolean;
  attempted: boolean;
  wrote: boolean;
  /** Logical artifact id, never an absolute/private path. */
  path: string | null;
  serialized: string | null;
  error: string | null;
  failureClass: FinalActivePathDurableOutcome['failureClass'];
}

export interface DiagnosticCandidateIdentity {
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
}

/** Source facts safe to expose outside the owned runtime. */
export interface DiagnosticSourceIdentity {
  fingerprint: string | null;
  registryFingerprint: string | null;
  applicationInventoryFingerprint: string | null;
  repository: {
    commit: string | null;
    dirty: boolean | null;
    lockfileDigest: string | null;
  };
}

export interface DiagnosticScope {
  subjectId: string | null;
  capability: Capability | null;
  scenario: string | null;
  variant: string | null;
}

export interface DiagnosticEvidenceReferences {
  /** Logical artifact ids only; absolute/private paths are never returned. */
  references: readonly string[];
  runRecord: string | null;
}

export interface DiagnosticCliDetails {
  /** The required correctness profile for this command. */
  profile: 'diagnostic';
  /** Coverage is independent from the terminal outcome. */
  coverageStatus: CoverageStatus | null;
  candidate: DiagnosticCandidateIdentity | null;
  source: DiagnosticSourceIdentity | null;
  environmentCellId: string | null;
  scope: DiagnosticScope;
  evidence: DiagnosticEvidenceReferences;
  runId: string;
  caseId: string | null;
  materializationFingerprint: string | null;
  planFingerprint: string | null;
  allocation: DiagnosticAllocationProjection | null;
  launch: DiagnosticLaunchFacts | null;
  /** The evaluator discriminant selected by the compiled envelope, when known. */
  evaluatorKind: OracleEvaluatorKind | null;
  compatibilityVersion: number | null;
  behaviorOutcome: Outcome | null;
  finalOutcome: Outcome | null;
  /** Three-state required-check statuses; never a legacy boolean `passed`. */
  requiredChecks: readonly { checkId: string; status: string }[];
  /** Closed orchestration refusal codes; empty on a trustworthy evaluated case. */
  issues: readonly string[];
  cleanup: PublicCleanupProjection | null;
  /** Logical evidence namespace, never an absolute/private path. */
  evidenceRoot: string | null;
  runRecordPath: string | null;
  observationId: string | null;
  wakeSource: WakeSource | null;
  fallbackPollCount: number | null;
  durable: DiagnosticDurableDetails;
}

export interface RunDiagnosticCommandInput {
  casePath?: string;
  /**
   * Explicit, validated application root (ADR 0118). Diagnostic preflight
   * resolves it, loads the narrow FE-owned product-meaning provider from it, and
   * refuses before allocation on any missing, malformed or incompatible input.
   * It is never inferred from the toolkit or skill location.
   */
  appRoot?: string;
  /** Test seam: an already-parsed case request. */
  request?: unknown;
  /** Internal seam: a freshly compiled plan/envelope and its exact source catalogues. */
  preparedCandidate?: PreparedExecutionCandidate;
  /** Optional frozen tuple check for an internal governed caller. */
  expectedIdentity?: Partial<PreparedExecutionIdentity>;
  runId?: string;
  /** Diagnostic-only allocation override; occupied port must fail before launch. */
  port?: number;
  keepDistDir?: boolean;
  /**
   * Suite-child lineage (ADR 0019 R11). Present only when this run is executed
   * as a representative-suite member; it is carried into the record before the
   * exclusive write and can never be appended afterwards.
   */
  suiteLineage?: PublicSuiteLineageV1;
  /** Test seam: the real owned server launcher. */
  launchServer?: typeof launchOwnedServer;
  /** Test seam: the real drive executor. */
  execute?: typeof executePlan;
}

/** Immutable identity a future governed caller compares with its frozen entry. */
export interface PreparedExecutionIdentity {
  readonly caseId: string;
  readonly materializationFingerprint: string;
  readonly planFingerprint: string;
  readonly cellId: string;
}

/** Internal compile-once input to the existing Diagnostic operational path. */
export interface PreparedExecutionCandidate {
  readonly planning: Extract<PlanForExecutionResult, { status: 'PLANNED' }>;
  readonly bundle: CatalogueBundle;
  readonly environmentCatalogue: EnvironmentCatalogue;
  readonly environmentCell: EnvironmentCell;
  readonly requestDigest: string;
  readonly identity: PreparedExecutionIdentity;
}

export type PreparedExecutionCandidateResult =
  | { readonly ok: true; readonly candidate: PreparedExecutionCandidate }
  | {
      readonly ok: false;
      readonly planning: Exclude<PlanForExecutionResult, { status: 'PLANNED' }>;
    };

const preparedCandidateSnapshots = new WeakMap<PreparedExecutionCandidate, string>();

function preparedCandidateSnapshot(candidate: PreparedExecutionCandidate): string {
  return sha256Hex(
    canonicalize({
      planning: candidate.planning,
      bundle: candidate.bundle,
      environmentCatalogue: candidate.environmentCatalogue,
      environmentCell: candidate.environmentCell,
      requestDigest: candidate.requestDigest,
      identity: candidate.identity,
    }),
  );
}

/** Load and compile one candidate exactly once for later reuse by a runner. */
export function compilePreparedExecutionCandidate(
  request: unknown,
  appRoot?: string,
): PreparedExecutionCandidateResult {
  const bundle = loadCatalogueBundle();
  const planning = planFinalActivePathCase(request, bundle, appRoot);
  if (planning.status !== 'PLANNED') return { ok: false, planning };
  const environmentCatalogue = loadEnvironmentCatalogue();
  const environmentCell = resolveEnvironmentCell(environmentCatalogue);
  const identity = Object.freeze({
    caseId: planning.caseId,
    materializationFingerprint: planning.materializationFingerprint,
    planFingerprint: planning.planFingerprint,
    cellId: environmentCell.cellId,
  });
  const candidate: PreparedExecutionCandidate = Object.freeze({
    planning,
    bundle,
    environmentCatalogue,
    environmentCell,
    requestDigest: sha256Hex(canonicalize(planning.request)),
    identity,
  });
  preparedCandidateSnapshots.set(candidate, preparedCandidateSnapshot(candidate));
  return {
    ok: true,
    candidate,
  };
}

function validatePreparedCandidate(
  candidate: PreparedExecutionCandidate,
  expectedIdentity?: Partial<PreparedExecutionIdentity>,
): string | null {
  const initialSnapshot = preparedCandidateSnapshots.get(candidate);
  if (initialSnapshot === undefined)
    return 'Prepared candidate was not created by the compile-once seam.';
  try {
    if (preparedCandidateSnapshot(candidate) !== initialSnapshot) {
      return 'Prepared candidate content changed after compilation.';
    }
  } catch {
    return 'Prepared candidate content is not canonically fingerprintable.';
  }
  const { planning, identity } = candidate;
  if (planning.status !== 'PLANNED') return 'Prepared candidate is not in PLANNED status.';
  const envelope = planning.envelope;
  if (envelope === null) return 'Prepared candidate has no compile-once correctness envelope.';
  if (
    identity.caseId !== planning.caseId ||
    identity.materializationFingerprint !== planning.materializationFingerprint ||
    identity.planFingerprint !== planning.planFingerprint ||
    envelope.caseId !== planning.caseId ||
    envelope.materializationFingerprint !== planning.materializationFingerprint ||
    envelope.planFingerprint !== planning.planFingerprint ||
    envelope.plan.correctness.profileId !== planning.plan.correctness.profileId ||
    envelope.plan.correctness.resolvedFingerprint !==
      planning.plan.correctness.resolvedFingerprint ||
    envelope.correctnessProfile.profileId !== planning.plan.correctness.profileId ||
    envelope.correctnessProfile.resolvedFingerprint !==
      planning.plan.correctness.resolvedFingerprint ||
    planning.materializedCase.contracts.correctnessProfileFingerprint !==
      planning.plan.correctness.resolvedFingerprint
  ) {
    return 'Prepared candidate plan, envelope, or correctness-profile identities disagree.';
  }
  try {
    if (sha256Hex(canonicalize(planning.request)) !== candidate.requestDigest) {
      return 'Prepared candidate request digest does not match its planned request.';
    }
    if (
      canonicalize(planning.request.intent) !== canonicalize(planning.materializedCase.intent) ||
      deriveCaseId(planning.request.intent, planning.materializedCase.fixture) !== planning.caseId
    ) {
      return 'Prepared candidate request intent does not match its materialized case identity.';
    }
  } catch {
    return 'Prepared candidate request is not canonically fingerprintable.';
  }
  let resolvedCell: EnvironmentCell;
  try {
    resolvedCell = resolveEnvironmentCell(candidate.environmentCatalogue, identity.cellId);
  } catch {
    return 'Prepared candidate environment cell is not declared in its catalogue.';
  }
  if (
    resolvedCell.cellId !== candidate.environmentCell.cellId ||
    canonicalize(resolvedCell) !== canonicalize(candidate.environmentCell)
  ) {
    return 'Prepared candidate environment cell does not match its environment catalogue.';
  }
  if (expectedIdentity !== undefined) {
    for (const key of [
      'caseId',
      'materializationFingerprint',
      'planFingerprint',
      'cellId',
    ] as const) {
      const expected = expectedIdentity[key];
      if (expected !== undefined && expected !== identity[key]) {
        return `Prepared candidate ${key} does not match the expected identity.`;
      }
    }
  }
  const validation = validateMaterializedExecutionEnvelope({
    envelope,
    materializedCase: planning.materializedCase,
  });
  if (!validation.ok) return validation.diagnostic.detail;
  return null;
}

const EMPTY_DURABLE: FinalActivePathDurableOutcome = Object.freeze({
  required: false,
  attempted: false,
  wrote: false,
  path: null,
  serialized: null,
  error: null,
  failureClass: null,
});

type PlannedDiagnosticCase = Extract<PlanForExecutionResult, { status: 'PLANNED' }>;

function candidateIdentity(planning: PlannedDiagnosticCase): DiagnosticCandidateIdentity {
  return {
    caseId: planning.caseId,
    materializationFingerprint: planning.materializationFingerprint,
    planFingerprint: planning.planFingerprint,
  };
}

function diagnosticScope(planning: PlannedDiagnosticCase | null): DiagnosticScope {
  if (planning === null) {
    return { subjectId: null, capability: null, scenario: null, variant: null };
  }
  return {
    subjectId: planning.materializedCase.intent.subjectId,
    capability: planning.materializedCase.intent.capability,
    scenario: planning.materializedCase.intent.scenario,
    variant: planning.materializedCase.intent.variant,
  };
}

function diagnosticSource(
  planning: PlannedDiagnosticCase,
  repository?: { commit: string | null; dirty: boolean | null; lockfileDigest: string },
): DiagnosticSourceIdentity {
  const contracts = planning.materializedCase.contracts;
  return {
    // The application-inventory identity is the source fingerprint selected by
    // the planner; it is content-addressed and contains no local path.
    fingerprint: contracts.applicationInventoryFingerprint,
    registryFingerprint: contracts.registryFingerprint,
    applicationInventoryFingerprint: contracts.applicationInventoryFingerprint,
    repository: {
      commit: repository?.commit ?? null,
      dirty: repository?.dirty ?? null,
      lockfileDigest: repository?.lockfileDigest ?? null,
    },
  };
}

function evidenceReferences(durable: FinalActivePathDurableOutcome): DiagnosticEvidenceReferences {
  if (!durable.wrote) return { references: [], runRecord: null };
  return { references: ['run-record.json'], runRecord: 'run-record.json' };
}

function allocationProjection(
  allocation: RunAllocation | null,
): DiagnosticAllocationProjection | null {
  if (allocation === null) return null;
  return {
    runId: allocation.runId,
    port: allocation.port,
    baseUrl: allocation.baseUrl,
    repoRelativeDistDir: allocation.repoRelativeDistDir,
    environmentCellId: allocation.environmentCellId,
    routeNamespace: allocation.routeNamespace,
    storageNamespace: allocation.storageNamespace,
  };
}

function cleanupProjection(cleanup: CleanupResult | null): PublicCleanupProjection | null {
  return cleanup === null ? null : buildCleanupProjection(cleanup);
}

function launchProjection(launch: DiagnosticLaunchFacts | null): DiagnosticLaunchFacts | null {
  if (launch === null) return null;
  return { ...launch, serverLogPath: 'server.log' };
}

function durableProjection(durable: FinalActivePathDurableOutcome): DiagnosticDurableDetails {
  return {
    required: durable.required,
    attempted: durable.attempted,
    wrote: durable.wrote,
    path: durable.wrote ? 'run-record.json' : null,
    serialized: durable.serialized,
    // The internal writer error can contain an absolute path or a raw system
    // message. The public envelope exposes only a stable failure marker; the
    // classified `failureClass` and top-level sanitized diagnostics retain the
    // actionable failure surface without publishing private runtime detail.
    error: durable.error === null ? null : 'DURABLE_FINALIZATION_FAILED',
    failureClass: durable.failureClass,
  };
}

function detailsForPlanning(
  runId: string,
  planning: PlannedDiagnosticCase,
  input: Partial<DiagnosticCliDetails> = {},
): DiagnosticCliDetails {
  return details({
    ...input,
    runId,
    caseId: planning.caseId,
    materializationFingerprint: planning.materializationFingerprint,
    planFingerprint: planning.planFingerprint,
    coverageStatus: planning.coverageStatus,
    candidate: candidateIdentity(planning),
    source: diagnosticSource(planning),
    scope: diagnosticScope(planning),
  });
}

function details(input: Partial<DiagnosticCliDetails>): DiagnosticCliDetails {
  return {
    profile: 'diagnostic',
    coverageStatus: input.coverageStatus ?? null,
    candidate: input.candidate ?? null,
    source: input.source ?? null,
    environmentCellId: input.environmentCellId ?? null,
    scope: input.scope ?? diagnosticScope(null),
    evidence: input.evidence ?? { references: [], runRecord: null },
    runId: input.runId ?? '',
    caseId: input.caseId ?? null,
    materializationFingerprint: input.materializationFingerprint ?? null,
    planFingerprint: input.planFingerprint ?? null,
    allocation: input.allocation ?? null,
    launch: launchProjection(input.launch ?? null),
    evaluatorKind: input.evaluatorKind ?? null,
    compatibilityVersion: input.compatibilityVersion ?? null,
    behaviorOutcome: input.behaviorOutcome ?? null,
    finalOutcome: input.finalOutcome ?? null,
    requiredChecks: input.requiredChecks ?? [],
    issues: input.issues ?? [],
    cleanup: input.cleanup ?? null,
    evidenceRoot: input.evidenceRoot ?? null,
    runRecordPath: input.runRecordPath ?? null,
    observationId: input.observationId ?? null,
    wakeSource: input.wakeSource ?? null,
    fallbackPollCount: input.fallbackPollCount ?? null,
    durable: durableProjection(input.durable ?? EMPTY_DURABLE),
  };
}

function publicDiagnosticForbiddenPaths(extra: readonly string[] = []): string[] {
  return [resolveRepoRoot(), resolveSkillRoot(), os.tmpdir(), evidenceBaseDir(), ...extra];
}

/** The operational facts one prepared Diagnostic run hands to the final façade. */
export interface DiagnosticRunFacts {
  readonly planning: Extract<PlanForExecutionResult, { status: 'PLANNED' }>;
  readonly prelaunch: DiagnosticPrelaunchFacts;
  readonly observation: FinalExecutionObservation | null;
  readonly runId: string;
  readonly cleanupSucceeded: boolean;
  readonly externalFailure: boolean;
  readonly operational: FinalActivePathRunOperationals;
  readonly durable: FinalActivePathDurableSink;
  /** Operational CLI projection facts. */
  readonly allocation: RunAllocation | null;
  readonly launch: DiagnosticLaunchFacts | null;
  readonly cleanup: CleanupResult | null;
  readonly evidenceRoot: string | null;
  readonly diagnostics: readonly DiagnosticRecord[];
}

/**
 * The outcome of one execution attempt. A `refused` result is a harness-level
 * refusal raised before any executable run (bad invocation, unavailable
 * catalogue, an unplanned case, an undelivered binding, an unavailable fixture
 * or workflow, or an undelivered runtime); it produces no durable record and no
 * product verdict.
 */
export type DiagnosticPreparation =
  | { readonly ok: true; readonly facts: DiagnosticRunFacts }
  | {
      readonly ok: false;
      readonly status: CliStatus;
      readonly detail: string;
      readonly diagnostics: readonly DiagnosticRecord[];
      readonly details: DiagnosticCliDetails;
    };

function refused(input: {
  readonly status: CliStatus;
  readonly detail: string;
  readonly diagnostics: readonly DiagnosticRecord[];
  readonly details: DiagnosticCliDetails;
  /**
   * Additional private roots (for example the explicit app root) whose exact
   * value must never appear verbatim in the refusal detail or diagnostics.
   */
  readonly forbiddenPaths?: readonly string[];
}): DiagnosticPreparation {
  const forbiddenPaths = publicDiagnosticForbiddenPaths(input.forbiddenPaths ?? []);
  return {
    ok: false,
    status: input.status,
    detail: redactRecordText(input.detail, forbiddenPaths) ?? 'private value redacted',
    diagnostics: redactDiagnostics(input.diagnostics, forbiddenPaths),
    details: input.details,
  };
}

/**
 * Maps a scoped provider-loader failure onto the closed Diagnostic vocabulary.
 * A missing/incompatible provider is an integration/harness refusal, never a
 * product `BUG` and never `ENVIRONMENT_FAILURE` (ADR 0118).
 */
function productMeaningProviderDiagnosticCode(
  code: ProductMeaningProviderFailureCode,
): DiagnosticRecord['code'] {
  if (code === 'PROVIDER_INCOMPATIBLE') return 'PRODUCT_MEANING_PROVIDER_INCOMPATIBLE';
  return 'PRODUCT_MEANING_PROVIDER_UNAVAILABLE';
}

/**
 * Maps a same-run admission refusal onto its exact diagnostic code. An unknown
 * or malformed ownership record is a distinct refusal from a genuinely active
 * same-run case, so the two are never collapsed into one misleading code.
 */
function admissionFailureDiagnosticCode(
  reason: AllocationFailureReason,
): DiagnosticRecord['code'] {
  switch (reason) {
    case 'SAME_RUN_CASE_ACTIVE':
      return 'SAME_RUN_CASE_ACTIVE';
    case 'OWNERSHIP_RECORD_INVALID':
      return 'RUN_OWNERSHIP_RECORD_INVALID';
    default:
      return 'RUN_OWNERSHIP_UNKNOWN';
  }
}

function loadRequest(
  input: RunDiagnosticCommandInput,
): { ok: true; request: unknown } | { ok: false; detail: string } {
  if (input.request !== undefined) return { ok: true, request: input.request };
  if (input.casePath === undefined) {
    return { ok: false, detail: 'diagnostic requires `--case <request.json>`. ' };
  }
  try {
    return { ok: true, request: JSON.parse(readFileSync(input.casePath, 'utf8')) as unknown };
  } catch (error) {
    return {
      ok: false,
      detail: `Case request could not be read as JSON: ${(error as Error).message}`,
    };
  }
}

/**
 * The executor/probe seam one prepared run drives. It is `executePlan` in
 * production; the suite and focused tests may substitute their own.
 */
export interface DiagnosticExecutionSeams {
  readonly launchServer?: typeof launchOwnedServer;
  readonly execute?: typeof executePlan;
}

/**
 * Executes the operational half of one Diagnostic case — plan, allocate, admit,
 * resolve resources, launch, drive, and clean up — and returns the exact facts
 * the final façade needs. It classifies nothing and writes nothing: the atomic
 * executor observation and the operational projections are handed on untouched.
 */
export async function prepareDiagnosticRun(
  input: RunDiagnosticCommandInput = {},
): Promise<DiagnosticPreparation> {
  const runId = input.runId ?? generateRunId();
  const diagnostics: DiagnosticRecord[] = [];

  // The optional adapter-owned evidence root is validated before any plan,
  // allocation, launch, or evidence write. An invalid/relative/symlink value is
  // a harness refusal with `launchAttempted: false` and no artifact; an unset
  // variable preserves the toolkit default.
  const evidenceResolution = resolveEvidenceRoot();
  if (!evidenceResolution.ok) {
    const detail = `Diagnostic evidence root is not usable: ${evidenceResolution.problem}`;
    return refused({
      status: 'HARNESS_BLOCKED',
      detail,
      diagnostics: [createDiagnostic('EVIDENCE_ROOT_ENV_INVALID', detail)],
      details: details({ runId }),
    });
  }

  // The app root is a mandatory, explicit CLI input for the Diagnostic surface
  // (ADR 0118). It is never inferred from the toolkit/skill location, so an
  // absent value fails as a usage error before any plan, allocation, process,
  // browser or evidence work. The internal compile-once `preparedCandidate`
  // seam is validated against the same rule below, before allocation.
  const appRoot = input.appRoot;
  const hasAppRoot = typeof appRoot === 'string' && appRoot.trim().length > 0;
  if (input.preparedCandidate === undefined && !hasAppRoot) {
    const detail =
      'diagnostic requires an explicit `--app-root <path>` naming the application checkout that owns the product-meaning provider.';
    return refused({
      status: 'USAGE',
      detail,
      diagnostics: [createDiagnostic('CLI_USAGE_INVALID', detail)],
      details: details({ runId }),
    });
  }

  let candidate: PreparedExecutionCandidate;
  if (input.preparedCandidate !== undefined) {
    if (input.request !== undefined || input.casePath !== undefined) {
      const detail = 'A prepared candidate cannot be paired with a separate Diagnostic request.';
      return refused({
        status: 'USAGE',
        detail,
        diagnostics: [createDiagnostic('CLI_USAGE_INVALID', detail)],
        details: details({ runId }),
      });
    }
    candidate = input.preparedCandidate;
  } else {
    const loaded = loadRequest(input);
    if (!loaded.ok) {
      return refused({
        status: 'USAGE',
        detail: loaded.detail,
        diagnostics: [createDiagnostic('CLI_USAGE_INVALID', loaded.detail)],
        details: details({ runId }),
      });
    }
    let compiled: PreparedExecutionCandidateResult;
    try {
      compiled = compilePreparedExecutionCandidate(loaded.request, appRoot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return refused({
        status: 'HARNESS_BLOCKED',
        detail,
        diagnostics: [createDiagnostic('CATALOGUE_UNAVAILABLE', detail)],
        details: details({ runId }),
      });
    }
    if (!compiled.ok) {
      const planning = compiled.planning;
      if (planning.status === 'ENVIRONMENT_FAILURE') {
        const detail = planning.report.rejectionReasons.join('; ') || planning.reason;
        return refused({
          status: 'ENVIRONMENT_FAILURE',
          detail,
          diagnostics: planning.findings.length > 0 ? planning.findings : [],
          details: details({ runId }),
        });
      }
      return refused({
        status: 'HARNESS_BLOCKED',
        detail: planning.diagnostic.detail,
        diagnostics: planning.findings.length > 0 ? planning.findings : [planning.diagnostic],
        details: details({ runId }),
      });
    }
    candidate = compiled.candidate;
  }

  // Preserve the ordinary Diagnostic request's specific fixture diagnostic
  // when its current plan has no compile-once envelope. A supplied prepared
  // candidate still goes through the strict whole-candidate refusal below.
  if (input.preparedCandidate === undefined && candidate.planning.envelope === null) {
    const route = candidate.planning.materializedCase.route;
    const adapterResolution = resolveAdapterImplementation({
      catalogue: candidate.bundle.adapterCatalogue,
      declaration: {
        adapterId: route.adapterId,
        compatibilityVersion: route.adapterCompatibilityVersion,
      },
    });
    if (!adapterResolution.ok) {
      return refused({
        status: 'HARNESS_BLOCKED',
        detail: adapterResolution.finding.detail,
        diagnostics: [adapterResolution.finding],
        details: detailsForPlanning(runId, candidate.planning, {
          environmentCellId: candidate.environmentCell.cellId,
        }),
      });
    }
    const intent = candidate.planning.materializedCase.intent;
    const fixture = resolveBindingFixture(candidate.bundle.fixtureCatalogue, {
      subjectId: intent.subjectId,
      capability: intent.capability,
      scenarioId: intent.scenario,
    });
    if (fixture === null) {
      const detail = `No delivered fixture binds ${intent.subjectId} × ${intent.capability} × ${intent.scenario}.`;
      return refused({
        status: 'HARNESS_BLOCKED',
        detail,
        diagnostics: [createDiagnostic('FIXTURE_UNAVAILABLE', detail)],
        details: detailsForPlanning(runId, candidate.planning, {
          environmentCellId: candidate.environmentCell.cellId,
        }),
      });
    }
  }

  const candidateIssue = validatePreparedCandidate(candidate, input.expectedIdentity);
  if (candidateIssue !== null) {
    return refused({
      status: 'HARNESS_BLOCKED',
      detail: candidateIssue,
      diagnostics: [createDiagnostic('CORRECTNESS_COMPATIBILITY_DIVERGENCE', candidateIssue)],
      details: detailsForPlanning(runId, candidate.planning, {
        environmentCellId: candidate.environmentCell.cellId,
      }),
    });
  }
  const { planning, bundle } = candidate;

  const route = planning.materializedCase.route;
  const adapterResolution = resolveAdapterImplementation({
    catalogue: bundle.adapterCatalogue,
    declaration: {
      adapterId: route.adapterId,
      compatibilityVersion: route.adapterCompatibilityVersion,
    },
  });
  if (!adapterResolution.ok) {
    return refused({
      status: 'HARNESS_BLOCKED',
      detail: adapterResolution.finding.detail,
      diagnostics: [adapterResolution.finding],
      details: detailsForPlanning(runId, planning, {
        environmentCellId: candidate.environmentCell.cellId,
      }),
    });
  }

  const fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
    subjectId: planning.materializedCase.intent.subjectId,
    capability: planning.materializedCase.intent.capability,
    scenarioId: planning.materializedCase.intent.scenario,
  });
  if (fixture === null) {
    const detail = `No delivered fixture binds ${planning.materializedCase.intent.subjectId} × ${planning.materializedCase.intent.capability} × ${planning.materializedCase.intent.scenario}.`;
    return refused({
      status: 'HARNESS_BLOCKED',
      detail,
      diagnostics: [createDiagnostic('FIXTURE_UNAVAILABLE', detail)],
      details: detailsForPlanning(runId, planning, {
        environmentCellId: candidate.environmentCell.cellId,
      }),
    });
  }

  const stepEntry = resolveWorkflowSteps(bundle.workflowStepCatalogue, route.workflowId);
  if (stepEntry === null || stepEntry.steps.length === 0) {
    const detail = `Workflow "${route.workflowId}" declares no delivered declarative step.`;
    return refused({
      status: 'HARNESS_BLOCKED',
      detail,
      diagnostics: [createDiagnostic('WORKFLOW_STEPS_UNAVAILABLE', detail)],
      details: detailsForPlanning(runId, planning, {
        environmentCellId: candidate.environmentCell.cellId,
      }),
    });
  }

  // ── Explicit execution-support gate (before any allocation or launch) ─────
  // The plan is fully contract-complete and launchable for a delivered binding,
  // but the diagnostic runtime orchestration is only delivered for a closed set
  // of adapters. An adapter with no delivered runtime must fail closed here with
  // an honest `NOT_IMPLEMENTED` preflight gate instead of launching a partially
  // wired drive. This is a deliberate deferral, not a harness failure.
  const executionSupport = resolveExecutionSupport(route.adapterId, route.workflowId);
  if (!executionSupport.supported) {
    return refused({
      status: 'NOT_IMPLEMENTED',
      detail: executionSupport.detail,
      diagnostics: [
        createDiagnostic('EXECUTION_NOT_YET_SUPPORTED', executionSupport.detail, {
          context: { adapterId: route.adapterId, workflowId: route.workflowId },
        }),
      ],
      details: detailsForPlanning(runId, planning, {
        environmentCellId: candidate.environmentCell.cellId,
      }),
    });
  }

  const envelope = planning.envelope;
  if (envelope === null) {
    const detail =
      'The binding compiled no correctness profile; the case fails closed before allocation with the trustworthy planned identities and no record.';
    return refused({
      status: 'HARNESS_BLOCKED',
      detail,
      diagnostics: [createDiagnostic('CORRECTNESS_PROFILE_MISSING', detail)],
      details: detailsForPlanning(runId, planning, {
        environmentCellId: candidate.environmentCell.cellId,
      }),
    });
  }

  const fingerprints: RunRecordFingerprints = {
    registry: planning.materializedCase.contracts.registryFingerprint,
    applicationInventory: planning.materializedCase.contracts.applicationInventoryFingerprint,
    operationCatalogue: planning.materializedCase.contracts.operationCatalogueFingerprint,
    adapterCatalogue: planning.materializedCase.contracts.adapterCatalogueFingerprint,
    workflowCatalogue: planning.materializedCase.contracts.workflowCatalogueFingerprint,
    workflowSteps: deriveWorkflowStepCatalogueFingerprint(bundle.workflowStepCatalogue),
    coverageModel: planning.materializedCase.contracts.coverageModelFingerprint,
    readinessProfile: `${envelope.correctnessProfile.readiness.profileId}@${envelope.correctnessProfile.readiness.schemaVersion}`,
    oracleProfile: `${envelope.correctnessProfile.oracle.oracleProfileId}@${envelope.correctnessProfile.oracle.schemaVersion}`,
  };

  const operationalBase = {
    provenance: planning.request.provenance,
    evidenceDepth: planning.request.evidenceDepth,
    fingerprints,
    adapter: {
      adapterId: route.adapterId,
      compatibilityVersion: route.adapterCompatibilityVersion,
    },
    workflow: {
      workflowId: route.workflowId,
      version: planning.materializedCase.contracts.workflowVersion,
    },
    fixture: {
      fixtureId: fixture.fixtureId,
      constructorId: fixture.constructorId,
      constructorVersion: fixture.constructorVersion,
    },
    readinessProfileId: envelope.correctnessProfile.readiness.profileId,
    readinessTimingCategory: envelope.correctnessProfile.readiness.deadlineCategory,
    readinessDeadlineMs: envelope.correctnessProfile.readiness.deadlineMs,
    stableFrames: envelope.correctnessProfile.readiness.stableFrames,
  };

  // ── Product-meaning provider preflight (ADR 0118) ────────────────────────
  // Everything below this point may allocate, launch a process/browser, or
  // write evidence. The narrow FE-owned provider is therefore resolved and
  // validated here, before any of that, from the explicit app root only. A
  // missing, unavailable, malformed or incompatible provider refuses as an
  // integration/harness fault with `launchAttempted:false` and no evidence.
  let meaningProviderRef: ProductMeaningProviderRef;
  if (hasAppRoot) {
    const providerResult = await loadProductMeaningProvider(appRoot);
    if (!providerResult.ok) {
      const code = productMeaningProviderDiagnosticCode(providerResult.code);
      return refused({
        status: 'HARNESS_BLOCKED',
        detail: providerResult.detail,
        diagnostics: [
          createDiagnostic(code, providerResult.detail, {
            context: { appRootCode: providerResult.code },
          }),
        ],
        // A provider-load failure detail names the exact app root; it must never
        // be echoed verbatim outside the private boundary.
        forbiddenPaths: [path.resolve((appRoot as string).trim())],
        details: detailsForPlanning(runId, planning, {
          environmentCellId: candidate.environmentCell.cellId,
        }),
      });
      }
      meaningProviderRef = providerResult.ref;

      const hostCompatibility = assessHostCompatibility(
        meaningProviderRef.provider.hostCompatibility,
        [route.workflowId],
      );
      if (!hostCompatibility.ok) {
        return refused({
          status: 'HARNESS_BLOCKED',
          detail: hostCompatibility.detail,
          diagnostics: [
            createDiagnostic(hostCompatibility.code, hostCompatibility.detail, {
              context: hostCompatibility.context,
            }),
          ],
          details: detailsForPlanning(runId, planning, {
            environmentCellId: candidate.environmentCell.cellId,
          }),
        });
      }
    } else {
    // Internal compile-once seam without an app root. The current runtime has no
    // provider authority, so it fails closed rather than fabricating one.
    const detail =
      'The Diagnostic runtime requires an explicit app root providing the FE-owned product meaning provider; none was supplied.';
    return refused({
      status: 'HARNESS_BLOCKED',
      detail,
      diagnostics: [createDiagnostic('PRODUCT_MEANING_PROVIDER_REQUIRED', detail)],
      details: detailsForPlanning(runId, planning, {
        environmentCellId: candidate.environmentCell.cellId,
      }),
    });
  }

  const allocationResult = await allocateRun({
    runId,
    appRoot: meaningProviderRef.appRoot,
    requestedPort: input.port,
    environmentCellId: candidate.identity.cellId,
  });
  if (!allocationResult.ok) {
    // ADR 0119: a failed allocation never established this invocation's own
    // lease (allocation rolls back its port reservation and scratch directory),
    // and the run id may be occupied by another invocation. Automatic cleanup
    // after an allocation failure could therefore destroy a foreign owner's
    // resources, so recovery is only the explicit
    // `cleanup --run-id <id> --app-root <trusted root>` command.
    const cleanup = noOwnedLeaseCleanup(
      runId,
      'OWNERSHIP_UNKNOWN',
      `Allocation failed (${allocationResult.reason}) before this invocation owned a lease; no cleanup was attempted. ${allocationResult.detail}`,
    );
    const status = allocationFailureCliStatus(allocationResult.reason);
    // The run's owned repository is the validated application root, so the
    // reported revision/lockfile identity is the application's, never the
    // toolkit's. Evidence and the skill root remain toolkit-owned.
    const repoRoot = meaningProviderRef.appRoot;
    const appRevision = collectAppRevision(repoRoot);
    const forbiddenPaths = [repoRoot, resolveSkillRoot(), os.tmpdir()];
    const ownership = buildNotEstablishedOwnership({
      runId,
      allocationFailureCode: allocationResult.reason,
      requestedPort: input.port ?? null,
    });
    return {
      ok: true,
      facts: {
        planning,
        prelaunch: {
          kind: 'allocation-failed',
          reason: allocationResult.reason,
          detail: allocationResult.detail,
        },
        observation: null,
        runId,
        cleanupSucceeded: cleanup.complete,
        externalFailure: true,
        operational: {
          provenance: operationalBase.provenance,
          evidenceDepth: operationalBase.evidenceDepth,
          environmentCellId: DEFAULT_ENVIRONMENT_CELL_ID,
          repository: {
            commit: appRevision.commit,
            dirty: appRevision.dirty,
            lockfileDigest: lockfileDigest(repoRoot),
          },
          fingerprints,
          adapter: operationalBase.adapter,
          workflow: operationalBase.workflow,
          fixture: operationalBase.fixture,
          targets: [],
          readiness: {
            profileId: operationalBase.readinessProfileId,
            timingCategory: operationalBase.readinessTimingCategory,
            deadlineMs: operationalBase.readinessDeadlineMs,
            wakeSource: 'none',
            fallbackPollCount: 0,
            watchdogWaits: 0,
            rendererStableFrames: 0,
            timings: {},
          },
          launch: buildPublicLaunchFacts({
            attempted: false,
            pid: null,
            processGroupId: null,
            readinessMs: null,
            serverLogPath: null,
          }),
          ownership,
          cleanup: buildCleanupProjection(cleanup),
          diagnostics: redactDiagnostics(diagnostics, forbiddenPaths),
          runError: null,
          ...(input.suiteLineage === undefined ? {} : { suiteLineage: input.suiteLineage }),
        },
        durable: { evidenceRoot: evidenceRootFor(runId), forbiddenPaths },
        allocation: null,
        launch: null,
        cleanup,
        evidenceRoot: evidenceRootFor(runId),
        diagnostics,
      },
    };
  }

  const allocation = allocationResult.allocation;
  const admission = admitCase(runId, planning.caseId, meaningProviderRef.appRoot);
  if (!admission.ok) {
    const cleanup = await cleanupRun(runId, { expectedAppRoot: meaningProviderRef.appRoot });
    diagnostics.push(...cleanup.diagnostics);
    return refused({
      status: 'HARNESS_BLOCKED',
      detail: admission.detail,
      diagnostics: [
        createDiagnostic(admissionFailureDiagnosticCode(admission.reason), admission.detail, {
          context: { runId, reason: admission.reason },
        }),
      ],
      details: detailsForPlanning(runId, planning, {
        allocation: allocationProjection(allocation),
        cleanup: cleanupProjection(cleanup),
      }),
    });
  }

  let launch: DiagnosticLaunchFacts | null = null;
  let behavior: ExecutePlanBehavior | null = null;
  let observation: FinalExecutionObservation | null = null;
  let environmentInvalid = false;
  let browserCleanup: { closed: boolean; detail: string | null } | undefined;
  let runError: string | null = null;
  let resolvedResources: readonly ResolvedResource[] = [];
  let resourceManifestFingerprint = '';

  // Slice 5-C: resolve the fixture's declared resources before launch so an
  // undeclared or unreadable resource fails closed with no browser opened.
  const resourceRefs = fixture.resourceRefs ?? [];
  if (resourceRefs.length > 0) {
    let manifest: ReturnType<typeof loadResourceManifest>;
    try {
      manifest = loadResourceManifest();
    } catch (error) {
      const detail = `Resource manifest is invalid: ${(error as Error).message}`;
      releaseCase(runId);
      const cleanup = await cleanupRun(runId, { expectedAppRoot: meaningProviderRef.appRoot });
      return refused({
        status: 'HARNESS_BLOCKED',
        detail,
        diagnostics: [
          createDiagnostic('RESOURCE_MANIFEST_INVALID', detail),
          ...cleanup.diagnostics,
        ],
        details: detailsForPlanning(runId, planning, {
          allocation: allocationProjection(allocation),
          cleanup: cleanupProjection(cleanup),
        }),
      });
    }
    for (const ref of resourceRefs) {
      if (findResource(manifest, ref.logicalId, ref.version) === null) {
        const detail = `Fixture declares resource role "${ref.role}" → "${ref.logicalId}@${ref.version}" which the manifest does not declare.`;
        releaseCase(runId);
        const cleanup = await cleanupRun(runId, { expectedAppRoot: meaningProviderRef.appRoot });
        return refused({
          status: 'HARNESS_BLOCKED',
          detail,
          diagnostics: [createDiagnostic('RESOURCE_UNDECLARED', detail), ...cleanup.diagnostics],
          details: detailsForPlanning(runId, planning, {
            allocation: allocationProjection(allocation),
            cleanup: cleanupProjection(cleanup),
          }),
        });
      }
    }
    resolvedResources = resolveAllResources({
      manifest,
      filesRoot: path.join(allocation.skillRoot, RESOURCE_FILES_RELATIVE_PATH),
      origin: new URL(allocation.baseUrl).origin,
      runId,
      executionInstanceId: runId,
    });
    resourceManifestFingerprint = deriveResourceManifestFingerprint(manifest);
  }

  setActiveRun(runId);

  try {
    const launchResult = await (input.launchServer ?? launchOwnedServer)({ allocation });
    if (
      launchResult.pid !== null &&
      launchResult.processGroupId !== null &&
      launchResult.serverLogPath !== null
    ) {
      launch = {
        pid: launchResult.pid,
        processGroupId: launchResult.processGroupId,
        readinessMs: launchResult.ok ? launchResult.readinessMs : null,
        serverLogPath: launchResult.serverLogPath,
      };
    }
    if (!launchResult.ok) {
      environmentInvalid = true;
      runError = launchResult.detail;
      diagnostics.push(createDiagnostic(launchResult.reason, launchResult.detail));
    } else {
      const executed = await (input.execute ?? executePlan)({
        allocation,
        caseId: planning.caseId,
        intent: planning.materializedCase.intent,
        plan: planning.plan,
        envelope,
        adapter: adapterResolution.adapter,
        fixture,
        workflowSteps: stepEntry.steps,
        environment: candidate.environmentCell,
        meaningProvider: meaningProviderRef.provider,
        ...(resolvedResources.length === 0
          ? {}
          : { resources: resolvedResources, resourceManifestFingerprint }),
      });
      behavior = executed.behavior;
      observation = executed.finalObservation;
      environmentInvalid = executed.environmentInvalid;
      browserCleanup = {
        closed: executed.browserClose.closed,
        detail: executed.browserClose.detail,
      };
      diagnostics.push(...executed.behavior.diagnostics);
    }
  } catch (error) {
    environmentInvalid = true;
    runError = `Diagnostic runtime failed: ${(error as Error).message}`;
    diagnostics.push(createDiagnostic('RUNTIME_LAUNCH_FAILED', runError));
  } finally {
    releaseCase(runId);
  }

  const authorityRef: { current: CleanupAuthoritySnapshot | null } = { current: null };
  let cleanup: CleanupResult;
  try {
    cleanup = await cleanupRun(runId, {
      expectedAppRoot: meaningProviderRef.appRoot,
      removeDistDir: input.keepDistDir !== true,
      browserCleanup,
      onAuthoritySnapshot: (snapshot) => {
        authorityRef.current = snapshot;
      },
    });
  } finally {
    setActiveRun(null);
  }
  const authoritySnapshot = authorityRef.current;
  // Cleanup diagnostics carry absolute paths; the durable record represents
  // them through the allowlisted public cleanup projection instead.
  const harnessDiagnostics = diagnostics.slice();
  diagnostics.push(...cleanup.diagnostics);

  const forbiddenPaths = [
    ...sensitiveRootsOf(allocation),
    path.join(allocation.skillRoot, RESOURCE_FILES_RELATIVE_PATH),
    ...resolvedResources.map((resource) => resource.absoluteFilePath),
    ...(authoritySnapshot === null ? [] : sensitiveGuardPaths(authoritySnapshot)),
    os.tmpdir(),
  ];

  const ownership: PublicOwnershipProjection =
    authoritySnapshot !== null
      ? authoritySnapshot.publicOwnership
      : buildNotEstablishedOwnership({
          runId,
          allocationFailureCode: cleanup.refusedReason ?? 'OWNERSHIP_UNKNOWN',
          requestedPort: null,
        });

  const appRevision = collectAppRevision(allocation.repoRoot);
  const crosswordFacts = crosswordRecordFacts(behavior?.crossword ?? null);

  return {
    ok: true,
    facts: {
      planning,
      prelaunch: {
        kind: 'reserved',
        allocationId: allocation.runId,
        executionInstanceId: allocation.runId,
      },
      observation,
      runId,
      cleanupSucceeded: cleanup.complete,
      // Only a run that never entered the family executor (a launch failure or a
      // thrown runtime error) is an external pre-authority failure. A reached
      // executor that returned no observation (a genuine pre-behavior setup
      // refusal) is not. A post-launch environment failure (for example an
      // unavailable browser) is deliberately left on this path too: the
      // orchestration external-pre-authority branch is reserved for failures
      // decided before the owned server launch and would otherwise report
      // `launchAttempted: false` for a run whose server was demonstrably ready.
      externalFailure: behavior === null,
      operational: {
        provenance: operationalBase.provenance,
        evidenceDepth: operationalBase.evidenceDepth,
        environmentCellId: allocation.environmentCellId,
        repository: {
          commit: appRevision.commit,
          dirty: appRevision.dirty,
          lockfileDigest: lockfileDigest(allocation.repoRoot),
        },
        fingerprints,
        adapter: operationalBase.adapter,
        workflow: operationalBase.workflow,
        fixture: operationalBase.fixture,
        targets: (behavior?.targetIds ?? []).map((elementId) => ({
          role: 'target',
          elementId,
        })),
        readiness: {
          profileId: operationalBase.readinessProfileId,
          timingCategory: operationalBase.readinessTimingCategory,
          deadlineMs: operationalBase.readinessDeadlineMs,
          wakeSource: (behavior?.wakeSource ?? 'none') as WakeSource,
          fallbackPollCount: behavior?.fallbackPollCount ?? 0,
          watchdogWaits: behavior?.cycle?.gate?.watchdogWaits ?? 0,
          // Only the actual target-aware Crossword idle result is credited; a
          // blocked drive that never idled records 0, never the configured 3.
          rendererStableFrames:
            crosswordFacts.observedStableFrames !== null
              ? crosswordFacts.observedStableFrames
              : behavior?.image !== null && behavior?.image !== undefined
                ? operationalBase.stableFrames
                : behavior?.history !== null && behavior?.history !== undefined
                  ? behavior.history.readiness.observedStableFrames
                  : behavior?.restore !== null && behavior?.restore !== undefined
                    ? behavior.restore.readiness.observedStableFrames
                    : behavior?.cycle?.gate?.status === 'transition'
                      ? operationalBase.stableFrames
                      : 0,
          ...(crosswordFacts.bound ? { idle: crosswordFacts.idle } : {}),
          timings: behavior?.timings ?? {},
        },
        launch: buildPublicLaunchFacts({
          attempted: launch !== null,
          pid: launch?.pid ?? null,
          processGroupId: launch?.processGroupId ?? null,
          readinessMs: launch?.readinessMs ?? null,
          serverLogPath: launch?.serverLogPath ?? null,
        }),
        ownership,
        cleanup: buildCleanupProjection(cleanup),
        diagnostics: redactDiagnostics(harnessDiagnostics, forbiddenPaths),
        runError: redactRecordText(runError, forbiddenPaths),
        ...(input.suiteLineage === undefined ? {} : { suiteLineage: input.suiteLineage }),
      },
      durable: { evidenceRoot: allocation.evidenceRoot, forbiddenPaths },
      allocation,
      launch,
      cleanup,
      evidenceRoot: allocation.evidenceRoot,
      diagnostics,
    },
  };
}

export async function runDiagnosticCommand(
  input: RunDiagnosticCommandInput = {},
): Promise<CliResult<DiagnosticCliDetails>> {
  const preparation = await prepareDiagnosticRun(input);
  if (!preparation.ok) {
    return buildCliResult<DiagnosticCliDetails>({
      command: 'diagnostic',
      status: preparation.status,
      detail: preparation.detail,
      launchAttempted: false,
      ...(preparation.status === 'ENVIRONMENT_FAILURE'
        ? { outcome: 'ENVIRONMENT_FAILURE' as const }
        : {}),
      details: preparation.details,
      diagnostics: preparation.diagnostics,
    });
  }

  const facts = preparation.facts;
  const finalized: FinalDiagnosticActivePathOutcome = runFinalDiagnosticActivePath({
    planning: facts.planning,
    prelaunch: facts.prelaunch,
    observation: facts.observation,
    runId: facts.runId,
    cleanupSucceeded: facts.cleanupSucceeded,
    externalFailure: facts.externalFailure,
    operational: facts.operational,
    durable: facts.durable,
  });

  const emitted = finalized.cli;
  const diagnostics = [...facts.diagnostics, ...emitted.diagnostics];
  const forbiddenPaths = facts.durable.forbiddenPaths ?? publicDiagnosticForbiddenPaths();

  return buildCliResult<DiagnosticCliDetails>({
    command: 'diagnostic',
    status: emitted.status,
    detail: redactRecordText(emitted.detail, forbiddenPaths) ?? 'private value redacted',
    launchAttempted: emitted.launchAttempted,
    outcome: emitted.outcome,
    details: details({
      coverageStatus: facts.planning.coverageStatus,
      candidate: candidateIdentity(facts.planning),
      source: diagnosticSource(facts.planning, facts.operational.repository),
      environmentCellId: facts.operational.environmentCellId,
      scope: diagnosticScope(facts.planning),
      evidence: evidenceReferences(finalized.durable),
      runId: facts.runId,
      caseId: finalized.execution.caseId,
      materializationFingerprint: finalized.execution.materializationFingerprint,
      planFingerprint: finalized.execution.planFingerprint,
      allocation: allocationProjection(facts.allocation),
      launch: launchProjection(facts.launch),
      evaluatorKind: finalized.execution.evaluatorKind,
      compatibilityVersion: finalized.execution.compatibilityVersion,
      behaviorOutcome: finalized.execution.behaviorOutcome,
      finalOutcome: finalized.finalOutcome,
      requiredChecks: finalized.execution.requiredChecks.map((check) => ({
        checkId: check.checkId,
        status: String(check.status),
      })),
      issues: finalized.execution.issues.map((entry) => entry.code),
      cleanup: cleanupProjection(facts.cleanup),
      evidenceRoot: facts.evidenceRoot === null ? null : `runs/${facts.runId}`,
      runRecordPath: finalized.durable.wrote ? 'run-record.json' : null,
      observationId:
        finalized.execution.record === null ? null : (facts.observation?.observationId ?? null),
      wakeSource: facts.operational.readiness.wakeSource,
      fallbackPollCount: facts.operational.readiness.fallbackPollCount,
      durable: durableProjection(finalized.durable),
    }),
    diagnostics: redactDiagnostics(diagnostics, forbiddenPaths),
  });
}
