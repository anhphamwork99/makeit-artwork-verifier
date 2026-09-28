import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { IDENTITY_DOMAINS, domainSeparatedDigest } from '../canonical/canonicalize';
import type { CatalogueBundle } from '../catalogue/load';
import type { RegistryReconciliation } from '../contracts/catalogues';
import {
  ACCEPTED_REPRESENTATIVE_SUITE_EXECUTION_ID,
  ACCEPTED_REPRESENTATIVE_SUITE_ID,
  EVIDENCE_RUNS_DIR_NAME,
  EVIDENCE_SUITES_DIR_NAME,
  PACKAGE7_COMPLETENESS_LEDGER_ARTIFACT_ID,
  PACKAGE7_COMPLETENESS_LEDGER_BRANCH,
  PACKAGE7_COMPLETENESS_LEDGER_LABEL,
  PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH,
  PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION,
  PACKAGE7_COMPLETENESS_NON_CLAIMS,
  RUN_RECORD_FILE_NAME,
  SUITE_RECORD_FILE_NAME,
  type Package7AcceptedSuiteChildProjection,
  type Package7AcceptedSuiteProjection,
  type Package7AcceptedSuiteState,
  type Package7BindingLedgerEntry,
  type Package7CompletenessBuildResult,
  type Package7CompletenessDimension,
  type Package7CompletenessLedger,
  type Package7CoverageModelLedgerEntry,
  type Package7CompiledProfileEntry,
} from '../contracts/completeness';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { Capability } from '../contracts/discriminants';
import { readFinalPublicRecord } from '../contracts/final-public-record';
import { readFinalSuiteRecord } from '../contracts/final-suite-record';
import type { BindingCorrectnessState } from '../contracts/correctness';
import { selectCoverage } from '../coverage/select';
import { loadDiagnosticSuite, resolveSuiteRequests } from './suite';
import { resolveExecutionSupport } from '../planner/execution-support';
import { reconcileRegistry } from '../registry/reconcile';
import { resolveRoute } from '../routing/resolve';
import { isSafeRunId, resolveToolkitRoot } from '../runtime/paths';
import {
  buildBindingCorrectnessLedger,
  compileDeliveredRouteProfiles,
  deriveCorrectnessCatalogueFingerprint,
} from './correctness';
import { deriveCoverageModelFingerprint } from './fingerprint';

/**
 * Package 7 Slice C completeness ledger builder (gap-plan §5 P7-C; ADR 0039).
 *
 * The builder is deterministic and derives every count from the existing
 * authoritative surfaces:
 *
 * - bindings and Coverage Models from the loaded catalogues;
 * - compiled profiles from `compileDeliveredRouteProfiles`;
 * - Release/Diagnostic assignment splits from the deterministic Coverage
 *   `selectCoverage` selector (never a hardcoded literal);
 * - runtime availability from the existing `resolveRoute`/`resolveExecutionSupport`
 *   delivered-runtime boundary;
 * - accepted representative cases from the read-only accepted suite record and
 *   its strict current-v4 children.
 *
 * It writes nothing except through {@link persistCompletenessLedgerFile}. The
 * accepted evidence is read-only and this slice performs no Package-8 integrity
 * verification: observed digests are recorded, never checked against an ADR or
 * child hash.
 */

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function bindingKey(subjectId: string, capability: Capability): string {
  return `${subjectId}\u0000${capability}`;
}

function compareByKey<T>(key: (entry: T) => string): (left: T, right: T) => number {
  return (left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  };
}

function runtimeKey(subjectId: string, capability: Capability): string {
  return bindingKey(subjectId, capability);
}

interface DeclaredRepresentativeMember {
  order: number;
  caseId: string;
  request: string;
  subjectId: string | null;
  capability: Capability | null;
}

function loadDeclaredRepresentativeMembers(): {
  members: readonly DeclaredRepresentativeMember[];
  findings: readonly DiagnosticRecord[];
} {
  try {
    const loaded = loadDiagnosticSuite(ACCEPTED_REPRESENTATIVE_SUITE_ID);
    const resolved = resolveSuiteRequests(loaded);
    const members = resolved.map((entry) => {
      const request = entry.request as
        | { intent?: { subjectId?: unknown; capability?: unknown } }
        | null
        | undefined;
      const intent = request?.intent;
      return {
        order: entry.declaration.order,
        caseId: entry.declaration.caseId,
        request: entry.declaration.request,
        subjectId: typeof intent?.subjectId === 'string' ? intent.subjectId : null,
        capability: (intent?.capability as Capability | undefined) ?? null,
      } satisfies DeclaredRepresentativeMember;
    });
    return { members, findings: [] };
  } catch (error) {
    return {
      members: [],
      findings: [
        createDiagnostic(
          'COMPLETENESS_REPRESENTATIVE_DECLARATION_INVALID',
          `The declared representative suite could not be loaded for completeness accounting: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

export interface ProjectAcceptedSuiteOptions {
  /** Absolute evidence root; defaults to `<skill root>/evidence`. */
  evidenceRootDir?: string;
  /** Absolute skill root used for relative artifact paths; defaults to the toolkit root. */
  skillRootDir?: string;
  /** Accepted suite execution id; defaults to the ADR-0039 accepted identity. */
  suiteExecutionId?: string;
  /** Declared representative members used to cross-validate accepted children. */
  declaredMembers?: readonly { order: number; caseId: string; request: string }[];
}

export interface ProjectAcceptedSuiteResult {
  projection: Package7AcceptedSuiteProjection;
  findings: readonly DiagnosticRecord[];
}

function emptyProjection(
  suiteExecutionId: string,
  suiteRecordPath: string,
  state: Package7AcceptedSuiteState,
  qualification: string,
  observed?: { sha256: string; bytes: number },
): Package7AcceptedSuiteProjection {
  return {
    suiteExecutionId,
    suiteId: null,
    suiteVersion: null,
    suiteFingerprint: null,
    suiteRecordPath,
    suiteRecordObservedSha256: observed?.sha256 ?? null,
    suiteRecordObservedBytes: observed?.bytes ?? null,
    declaredCaseCount: 0,
    acceptedCaseCount: 0,
    state,
    children: [],
    releaseCredit: false,
    integrityVerified: false,
    integrityOwner: 'package-8',
    qualification,
  };
}

/**
 * Reads the accepted representative suite and its strict current-v4 children
 * read-only. Every producing path yields exactly one closed projection state:
 * `accepted`, `absent`, `unavailable`, or `invalid`. A non-`accepted` state is a
 * blocking finding because Gate P7 requires the accepted eight-case suite.
 */
export function projectAcceptedRepresentativeSuite(
  options: ProjectAcceptedSuiteOptions = {},
): ProjectAcceptedSuiteResult {
  const skillRoot = options.skillRootDir ?? resolveToolkitRoot();
  const evidenceRoot = options.evidenceRootDir ?? path.join(skillRoot, 'evidence');
  const suiteExecutionId = options.suiteExecutionId ?? ACCEPTED_REPRESENTATIVE_SUITE_EXECUTION_ID;
  const suiteRelativeDir = `evidence/${EVIDENCE_SUITES_DIR_NAME}/${suiteExecutionId}`;
  const suiteRecordPath = `${suiteRelativeDir}/${SUITE_RECORD_FILE_NAME}`;

  const invalidFinding = (detail: string): DiagnosticRecord =>
    createDiagnostic('COMPLETENESS_ACCEPTED_SUITE_INVALID', detail, {
      context: { suiteExecutionId },
    });

  if (!isSafeRunId(suiteExecutionId)) {
    const projection = emptyProjection(
      suiteExecutionId,
      suiteRecordPath,
      'invalid',
      `Accepted suite execution id "${suiteExecutionId}" is not a safe evidence identity.`,
    );
    return {
      projection,
      findings: [invalidFinding(projection.qualification)],
    };
  }

  const suiteAbsolutePath = path.join(
    evidenceRoot,
    EVIDENCE_SUITES_DIR_NAME,
    suiteExecutionId,
    SUITE_RECORD_FILE_NAME,
  );

  let suiteBytes: Buffer;
  try {
    suiteBytes = readFileSync(suiteAbsolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const state: Package7AcceptedSuiteState = code === 'ENOENT' ? 'absent' : 'unavailable';
    const qualification =
      state === 'absent'
        ? `Accepted representative suite record "${suiteRecordPath}" is absent; no accepted representative case can be credited.`
        : `Accepted representative suite record "${suiteRecordPath}" is unreadable (${code ?? 'unknown error'}); no accepted representative case can be credited.`;
    const projection = emptyProjection(suiteExecutionId, suiteRecordPath, state, qualification);
    return {
      projection,
      findings: [
        state === 'absent'
          ? createDiagnostic('COMPLETENESS_ACCEPTED_SUITE_ABSENT', qualification, {
              context: { suiteExecutionId },
            })
          : createDiagnostic('COMPLETENESS_ACCEPTED_SUITE_UNAVAILABLE', qualification, {
              context: { suiteExecutionId },
            }),
      ],
    };
  }

  const suiteSha = sha256Buffer(suiteBytes);
  let suiteParsed: unknown;
  try {
    suiteParsed = JSON.parse(suiteBytes.toString('utf8'));
  } catch {
    const projection = emptyProjection(
      suiteExecutionId,
      suiteRecordPath,
      'invalid',
      `Accepted representative suite record "${suiteRecordPath}" is not valid JSON.`,
      { sha256: suiteSha, bytes: suiteBytes.length },
    );
    return { projection, findings: [invalidFinding(projection.qualification)] };
  }

  const suiteRead = readFinalSuiteRecord(suiteParsed);
  if (suiteRead.kind !== 'suite-v2' || !suiteRead.current) {
    const detail =
      suiteRead.kind === 'invalid'
        ? suiteRead.issues.map((entry) => entry.detail).join(' ')
        : `Accepted representative suite record is labelled "${suiteRead.label}", not the strict current suite-v2 aggregate.`;
    const projection = emptyProjection(
      suiteExecutionId,
      suiteRecordPath,
      'invalid',
      `Accepted representative suite record "${suiteRecordPath}" is not a strict current suite-v2 aggregate: ${detail}`,
      { sha256: suiteSha, bytes: suiteBytes.length },
    );
    return { projection, findings: [invalidFinding(projection.qualification)] };
  }

  const suite = suiteRead.record;
  const problems: string[] = [];
  if (suite.suiteId !== ACCEPTED_REPRESENTATIVE_SUITE_ID) {
    problems.push(`suiteId "${suite.suiteId}" is not "${ACCEPTED_REPRESENTATIVE_SUITE_ID}"`);
  }
  if (suite.aggregateStatus !== 'PASS') {
    problems.push(`aggregateStatus "${suite.aggregateStatus}" is not PASS`);
  }
  if (suite.complete !== true || suite.stoppedEarly !== false || suite.interrupted !== false) {
    problems.push('the aggregate is not complete, uninterrupted, and unstopped');
  }
  if (
    suite.children.length !== suite.executedCount ||
    suite.executedCount !== suite.declaredCaseCount
  ) {
    problems.push(
      `declared/executed/child counts disagree (${suite.declaredCaseCount}/${suite.executedCount}/${suite.children.length})`,
    );
  }
  const expectedOrder = suite.children.map((_entry, index) => index + 1);
  if (suite.canonicalOrder.join(',') !== expectedOrder.join(',')) {
    problems.push('canonicalOrder is not the contiguous 1..N child order');
  }

  const declaredMembers = options.declaredMembers ?? [];

  const children: Package7AcceptedSuiteChildProjection[] = [];
  const childFindings: string[] = [];

  for (const child of suite.children) {
    const recordRelativePath = `evidence/${EVIDENCE_RUNS_DIR_NAME}/${child.runId}/${RUN_RECORD_FILE_NAME}`;
    let observedSha256: string | null = null;
    let observedBytes: number | null = null;
    let identitySatisfied = false;

    if (!isSafeRunId(child.runId)) {
      childFindings.push(`child order ${child.order} has unsafe runId "${child.runId}"`);
    } else if (!child.recordPresent || child.childRecordLabel !== 'current-v4') {
      childFindings.push(
        `child order ${child.order} is not a record-bearing strict-v4 child (recordPresent=${String(child.recordPresent)})`,
      );
    } else {
      const recordAbsolutePath = path.join(
        evidenceRoot,
        EVIDENCE_RUNS_DIR_NAME,
        child.runId,
        RUN_RECORD_FILE_NAME,
      );
      try {
        const bytes = readFileSync(recordAbsolutePath);
        observedSha256 = sha256Buffer(bytes);
        observedBytes = bytes.length;
        const recordRead = readFinalPublicRecord(JSON.parse(bytes.toString('utf8')) as unknown);
        if (recordRead.kind !== 'current-v4') {
          childFindings.push(
            `child order ${child.order} run record "${recordRelativePath}" is not a strict current-v4 run record`,
          );
        } else {
          const record = recordRead.record;
          identitySatisfied =
            record.runId === child.runId &&
            record.caseId === child.caseId &&
            record.materializationFingerprint === child.materializationFingerprint &&
            record.planFingerprint === child.planFingerprint &&
            record.profile === child.childProfile &&
            record.behaviorOutcome === child.behaviorOutcome &&
            record.finalOutcome === child.finalOutcome;
          if (!identitySatisfied) {
            childFindings.push(
              `child order ${child.order} run record identity disagrees with the suite aggregate`,
            );
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        childFindings.push(
          `child order ${child.order} run record "${recordRelativePath}" could not be read as a strict current record (${code ?? 'invalid JSON'})`,
        );
      }
    }

    if (child.finalOutcome !== 'PASS' || child.cleanupComplete !== true) {
      childFindings.push(
        `child order ${child.order} finalOutcome=${child.finalOutcome} cleanupComplete=${String(child.cleanupComplete)} is not an accepted PASS with complete cleanup`,
      );
    }

    if (declaredMembers.length > 0) {
      const declared = declaredMembers[child.order - 1];
      if (!declared || declared.caseId !== child.caseId || declared.request !== child.request) {
        childFindings.push(
          `child order ${child.order} does not match the declared representative member at that canonical position`,
        );
      }
    }

    children.push({
      order: child.order,
      caseId: child.caseId,
      request: child.request,
      runId: child.runId,
      executionId: child.executionId,
      profile: child.childProfile,
      materializationFingerprint: child.materializationFingerprint,
      planFingerprint: child.planFingerprint,
      behaviorOutcome: child.behaviorOutcome,
      finalOutcome: child.finalOutcome,
      cleanupComplete: child.cleanupComplete,
      recordPath: recordRelativePath,
      observedSha256,
      observedBytes,
      recordIdentitySatisfied: identitySatisfied,
    });
  }

  problems.push(...childFindings);

  const accepted = problems.length === 0;
  const state: Package7AcceptedSuiteState = accepted ? 'accepted' : 'invalid';
  const qualification = accepted
    ? `The accepted representative Diagnostic suite "${suiteExecutionId}" is a strict current suite-v2 aggregate of ${children.length} strict current-v4 children, every child PASS with complete cleanup; observed digests are recorded read-only and no integrity verification is performed (Package 8 owns integrity).`
    : `The accepted representative suite "${suiteExecutionId}" is not fully acceptable: ${problems.join('; ')}.`;

  const projection: Package7AcceptedSuiteProjection = {
    suiteExecutionId,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    suiteFingerprint: suite.suiteFingerprint,
    suiteRecordPath,
    suiteRecordObservedSha256: suiteSha,
    suiteRecordObservedBytes: suiteBytes.length,
    declaredCaseCount: suite.declaredCaseCount,
    acceptedCaseCount: accepted ? children.length : 0,
    state,
    children,
    releaseCredit: false,
    integrityVerified: false,
    integrityOwner: 'package-8',
    qualification,
  };

  return {
    projection,
    findings: accepted ? [] : [invalidFinding(qualification)],
  };
}

export interface BuildCompletenessLedgerInput {
  bundle: CatalogueBundle;
  /** Precomputed registry reconciliation; recomputed when omitted. */
  reconciliation?: RegistryReconciliation;
  /** Accepted-suite read override (test seam only). */
  acceptedSuite?: ProjectAcceptedSuiteOptions;
}

interface RuntimeAvailability {
  adapterId: string;
  workflowId: string;
  supported: boolean;
}

function buildRuntimeAvailability(
  reconciliation: RegistryReconciliation,
): Map<string, RuntimeAvailability> {
  const map = new Map<string, RuntimeAvailability>();
  for (const subject of reconciliation.resolvedSubjects) {
    for (const binding of subject.capabilityBindings) {
      const route = resolveRoute(subject, binding.capability);
      if (route.ok) {
        const support = resolveExecutionSupport(route.route.adapterId, route.route.workflowId);
        map.set(runtimeKey(subject.subjectId, binding.capability), {
          adapterId: route.route.adapterId,
          workflowId: route.route.workflowId,
          supported: support.supported,
        });
      }
    }
  }
  return map;
}

function dimension(
  name: Package7CompletenessDimension['dimension'],
  status: Package7CompletenessDimension['status'],
  count: number | null,
  qualification: string,
): Package7CompletenessDimension {
  return { dimension: name, status, count, releaseCredit: false, qualification };
}

function buildDimensions(input: {
  declaredBindings: number;
  coverageModels: number;
  bindingsWithoutModels: number;
  compiledProfiles: number;
  selectableSelections: number;
  selectedReleaseAssignments: number;
  releaseAssignmentsExecuted: number;
  acceptedRepresentativeCases: number;
  acceptedState: Package7AcceptedSuiteState;
  diagnosticOnlyScenarios: number;
  runtimeAvailableSelections: number;
}): Package7CompletenessDimension[] {
  const releaseAssignmentsQualification = `Deterministic Coverage selection over the ${input.selectableSelections} delivered route selection(s) yields ${input.selectedReleaseAssignments} Release assignment(s); ${input.releaseAssignmentsExecuted} have been executed. Selection is not execution: Release execution and qualification remain deferred to Gate G, so no selected assignment is Release-creditable.`;
  const acceptedQualification =
    input.acceptedState === 'accepted'
      ? `The accepted representative Diagnostic suite contributes ${input.acceptedRepresentativeCases} accepted case(s). Diagnostic acceptance is not Release execution and earns no Release credit.`
      : `The accepted representative Diagnostic suite is ${input.acceptedState}; no representative case is credited and Gate P7 is not satisfied.`;

  return [
    dimension(
      'binding-model',
      input.bindingsWithoutModels === 0 ? 'complete' : 'incomplete',
      input.declaredBindings,
      `${input.declaredBindings} declared Subject × Capability binding(s); ${input.coverageModels} have a Coverage Model and ${input.bindingsWithoutModels} do not. Registry/model completeness is not binding-execution completeness.`,
    ),
    dimension(
      'correctness-profile',
      'complete',
      input.compiledProfiles,
      `${input.compiledProfiles} delivered route selection(s) compile to one immutable reference-closed correctness profile each. A compiled profile is not an executed route.`,
    ),
    dimension(
      'runtime-availability',
      input.runtimeAvailableSelections === input.compiledProfiles ? 'complete' : 'incomplete',
      input.runtimeAvailableSelections,
      `${input.runtimeAvailableSelections} of ${input.compiledProfiles} compiled profile(s) resolve to a delivered Diagnostic runtime route. Runtime availability is a capability, not an executed result.`,
    ),
    dimension(
      'release-assignment',
      'incomplete',
      input.selectedReleaseAssignments,
      releaseAssignmentsQualification,
    ),
    dimension(
      'diagnostic-scenario',
      'deferred',
      input.diagnosticOnlyScenarios,
      `${input.diagnosticOnlyScenarios} diagnostic-only scenario(s) are declared. ${acceptedQualification} Diagnostic-only scenarios can never satisfy a Release obligation.`,
    ),
    dimension(
      'release-credit',
      'deferred',
      0,
      'Release credit is never granted by Package 7. Zero Release assignments are qualified, promoted, or Release-credited; Gate G owns Release qualification and execution parity.',
    ),
  ];
}

/**
 * Builds the deterministically ordered, closed Package-7 completeness ledger.
 * Every producing path returns a ledger plus the exact blocking/non-blocking
 * findings; the caller decides command status.
 */
export function buildPackage7CompletenessLedger(
  input: BuildCompletenessLedgerInput,
): Package7CompletenessBuildResult {
  const { bundle } = input;
  const catalogue = bundle.correctnessCatalogue;
  const findings: DiagnosticRecord[] = [];

  const reconciliation =
    input.reconciliation ??
    reconcileRegistry({
      subjectCatalogue: bundle.subjectCatalogue,
      applicationInventory: bundle.applicationInventory,
      operationCatalogue: bundle.operationCatalogue,
      adapterCatalogue: bundle.adapterCatalogue,
      workflowCatalogue: bundle.workflowCatalogue,
    });

  const declaredBindings: { subjectId: string; capability: Capability }[] = [];
  const declaredChecksByBinding = new Map<string, readonly string[]>();
  for (const declaration of bundle.subjectCatalogue.declarations) {
    for (const binding of declaration.capabilityBindings) {
      declaredBindings.push({ subjectId: declaration.subjectId, capability: binding.capability });
      declaredChecksByBinding.set(
        bindingKey(declaration.subjectId, binding.capability),
        binding.checks,
      );
    }
  }
  const coverageModelKeys = new Set(
    bundle.coverageCatalogue.models.map((model) => bindingKey(model.subjectId, model.capability)),
  );

  const compiled = compileDeliveredRouteProfiles(catalogue, declaredChecksByBinding);
  findings.push(...compiled.findings);
  if (compiled.profiles.length !== catalogue.routeSelections.length) {
    findings.push(
      createDiagnostic(
        'COMPLETENESS_COMPILED_PROFILE_GAP',
        `${compiled.profiles.length} of ${catalogue.routeSelections.length} delivered route selection(s) compiled a correctness profile.`,
      ),
    );
  }

  const bindingEntries = buildBindingCorrectnessLedger(
    catalogue,
    declaredBindings,
    coverageModelKeys,
  );
  const bindingStateByKey = new Map<string, BindingCorrectnessState>(
    bindingEntries.map((entry) => [bindingKey(entry.subjectId, entry.capability), entry.state]),
  );

  const runtimeAvailability = buildRuntimeAvailability(reconciliation);

  const representative = loadDeclaredRepresentativeMembers();
  findings.push(...representative.findings);

  const acceptedProjection = projectAcceptedRepresentativeSuite({
    ...(input.acceptedSuite ?? {}),
    declaredMembers: representative.members.map((member) => ({
      order: member.order,
      caseId: member.caseId,
      request: member.request,
    })),
  });
  findings.push(...acceptedProjection.findings);
  const acceptedCaseIds = new Set(
    acceptedProjection.projection.state === 'accepted'
      ? acceptedProjection.projection.children.map((child) => child.caseId)
      : [],
  );

  const representativeBindingCounts = new Map<string, number>();
  for (const member of representative.members) {
    if (member.subjectId === null || member.capability === null) continue;
    if (!acceptedCaseIds.has(member.caseId)) continue;
    const key = bindingKey(member.subjectId, member.capability);
    representativeBindingCounts.set(key, (representativeBindingCounts.get(key) ?? 0) + 1);
  }

  // ── Coverage Models: deterministic Release/Diagnostic splits ─────────────
  let selectedReleaseAssignments = 0;
  let diagnosticOnlyScenarios = 0;
  const coverageModelEntries: Package7CoverageModelLedgerEntry[] = bundle.coverageCatalogue.models
    .map((model) => {
      const modelFingerprint = deriveCoverageModelFingerprint(model);
      const releaseSelection = selectCoverage({
        model,
        modelFingerprint,
        profile: 'release',
        seed: null,
      });
      const diagnosticSelection = selectCoverage({
        model,
        modelFingerprint,
        profile: 'diagnostic',
        seed: null,
      });
      const modelDiagnosticOnlyScenarios = model.scenarios.filter(
        (scenario) => scenario.eligibility === 'diagnostic-only',
      ).length;
      const key = bindingKey(model.subjectId, model.capability);
      const state = bindingStateByKey.get(key) ?? 'profile-unavailable';
      const runtime = runtimeAvailability.get(key);
      const representativeCases = representativeBindingCounts.get(key) ?? 0;

      selectedReleaseAssignments += releaseSelection.cases.length;
      diagnosticOnlyScenarios += modelDiagnosticOnlyScenarios;

      const qualification =
        state === 'compiled-profile'
          ? `${releaseSelection.cases.length} Release assignment(s) and ${diagnosticSelection.cases.length} Diagnostic case(s) are deterministically selected; ${representativeCases} are accepted representative Diagnostic case(s). Selection is not execution.`
          : `No delivered route profile is compiled for this Coverage Model; its ${releaseSelection.cases.length} selected Release assignment(s) are not executable and earn no credit.`;

      return {
        subjectId: model.subjectId,
        capability: model.capability,
        modelFingerprint,
        selectedReleaseAssignments: releaseSelection.cases.length,
        selectedDiagnosticCases: diagnosticSelection.cases.length,
        diagnosticOnlyScenarios: modelDiagnosticOnlyScenarios,
        representativeCases,
        bindingState: state,
        // Runtime availability requires both a compiled delivered route profile
        // and a delivered adapter/workflow runtime; a Coverage Model alone is not
        // an executable route.
        runtimeAvailable: state === 'compiled-profile' && (runtime?.supported ?? false),
        releaseCredit: false,
        qualification,
      } satisfies Package7CoverageModelLedgerEntry;
    })
    .sort(compareByKey((entry) => bindingKey(entry.subjectId, entry.capability)));

  // ── Compiled profiles with their delivered-runtime availability ──────────
  const compiledProfileEntries: Package7CompiledProfileEntry[] = compiled.profiles
    .map((profile) => {
      const runtime = runtimeAvailability.get(bindingKey(profile.subjectId, profile.capability));
      return {
        subjectId: profile.subjectId,
        capability: profile.capability,
        variant: profile.variant,
        profileId: profile.profileId,
        resolvedFingerprint: profile.resolvedFingerprint,
        adapterId: runtime?.adapterId ?? null,
        workflowId: runtime?.workflowId ?? null,
        runtimeAvailable: runtime?.supported ?? false,
        releaseCredit: false,
      } satisfies Package7CompiledProfileEntry;
    })
    .sort(
      compareByKey(
        (entry) =>
          `${entry.subjectId}\u0000${entry.capability}\u0000${entry.variant === null ? '\u0000null' : entry.variant}`,
      ),
    );

  const runtimeAvailableSelections = compiledProfileEntries.filter(
    (entry) => entry.runtimeAvailable,
  ).length;

  // ── Declared bindings with runtime and representative projection ─────────
  const bindingLedger: Package7BindingLedgerEntry[] = bindingEntries
    .map((entry) => {
      const key = bindingKey(entry.subjectId, entry.capability);
      const runtime = runtimeAvailability.get(key);
      const representativeCaseAccepted = (representativeBindingCounts.get(key) ?? 0) > 0;
      const runtimeAvailable = entry.routeSelectionPresent && (runtime?.supported ?? false);
      const detail =
        entry.state === 'compiled-profile'
          ? `${entry.detail} Runtime available: ${String(runtimeAvailable)}; accepted representative cases: ${representativeBindingCounts.get(key) ?? 0}. No Release credit is granted.`
          : `${entry.detail} No delivered runtime and no accepted representative case; no Release credit is granted.`;
      return {
        subjectId: entry.subjectId,
        capability: entry.capability,
        state: entry.state,
        coverageModelPresent: entry.coverageModelPresent,
        routeSelectionPresent: entry.routeSelectionPresent,
        runtimeAvailable,
        representativeCaseAccepted,
        releaseCredit: false,
        detail,
      } satisfies Package7BindingLedgerEntry;
    })
    .sort(compareByKey((entry) => bindingKey(entry.subjectId, entry.capability)));

  const bindingsWithoutModels = declaredBindings.filter(
    (binding) => !coverageModelKeys.has(bindingKey(binding.subjectId, binding.capability)),
  ).length;

  const counts = {
    declaredBindings: declaredBindings.length,
    coverageModels: bundle.coverageCatalogue.models.length,
    bindingsWithoutModels,
    compiledProfiles: compiled.profiles.length,
    selectedReleaseAssignments,
    releaseAssignmentsExecuted: 0,
    acceptedRepresentativeCases: acceptedProjection.projection.acceptedCaseCount,
    diagnosticOnlyScenarios,
    runtimeAvailableSelections,
  } satisfies Package7CompletenessLedger['counts'];

  const dimensions = buildDimensions({
    declaredBindings: counts.declaredBindings,
    coverageModels: counts.coverageModels,
    bindingsWithoutModels: counts.bindingsWithoutModels,
    compiledProfiles: counts.compiledProfiles,
    selectableSelections: catalogue.routeSelections.length,
    selectedReleaseAssignments: counts.selectedReleaseAssignments,
    releaseAssignmentsExecuted: counts.releaseAssignmentsExecuted,
    acceptedRepresentativeCases: counts.acceptedRepresentativeCases,
    acceptedState: acceptedProjection.projection.state,
    diagnosticOnlyScenarios: counts.diagnosticOnlyScenarios,
    runtimeAvailableSelections: counts.runtimeAvailableSelections,
  });

  const withoutFingerprint = {
    schemaVersion: PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION,
    artifactId: PACKAGE7_COMPLETENESS_LEDGER_ARTIFACT_ID,
    label: PACKAGE7_COMPLETENESS_LEDGER_LABEL,
    branch: PACKAGE7_COMPLETENESS_LEDGER_BRANCH,
    catalogueSchemaVersion: catalogue.schemaVersion,
    catalogueFingerprint: deriveCorrectnessCatalogueFingerprint(catalogue),
    counts,
    dimensions,
    bindings: bindingLedger,
    coverageModels: coverageModelEntries,
    compiledProfiles: compiledProfileEntries,
    acceptedRepresentativeSuite: acceptedProjection.projection,
    releaseCreditGranted: false as const,
    integrityVerificationPerformed: false as const,
    nonClaims: PACKAGE7_COMPLETENESS_NON_CLAIMS,
  } satisfies Omit<Package7CompletenessLedger, 'fingerprint'>;

  const ledger: Package7CompletenessLedger = {
    ...withoutFingerprint,
    fingerprint: domainSeparatedDigest(
      IDENTITY_DOMAINS.package7CompletenessLedger,
      PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION,
      withoutFingerprint,
    ),
  };

  return { ledger, findings };
}

/** Canonical, byte-stable serialization of one completeness ledger. */
export function serializeCompletenessLedger(ledger: Package7CompletenessLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/** Absolute durable artifact path for the completeness ledger. */
export function completenessLedgerArtifactPath(skillRoot: string = resolveToolkitRoot()): string {
  return path.join(skillRoot, PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH);
}

export interface PersistCompletenessLedgerResult {
  /** Skill-relative durable path. */
  relativePath: typeof PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH;
  absolutePath: string;
  sha256: string;
  bytes: number;
}

/**
 * Atomically persists the ledger: the deterministic bytes are written to a
 * sibling temporary file and moved into place with one rename, so a reader ever
 * observes either the previous or the next complete artifact, never a partial
 * one. The artifact content carries no timestamp and is byte-identical across
 * repeated runs.
 */
export function persistCompletenessLedgerFile(
  ledger: Package7CompletenessLedger,
  absoluteTarget: string = completenessLedgerArtifactPath(),
): PersistCompletenessLedgerResult {
  const serialized = serializeCompletenessLedger(ledger);
  mkdirSync(path.dirname(absoluteTarget), { recursive: true });
  const temporary = `${absoluteTarget}.tmp-${process.pid}`;
  writeFileSync(temporary, serialized, 'utf8');
  renameSync(temporary, absoluteTarget);
  return {
    relativePath: PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH,
    absolutePath: absoluteTarget,
    sha256: sha256Buffer(Buffer.from(serialized, 'utf8')),
    bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}
