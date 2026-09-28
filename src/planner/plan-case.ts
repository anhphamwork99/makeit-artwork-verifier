import { buildOwnershipCleanupManifest } from '../allocation/ownership';
import { reserveAllocation } from '../allocation/reserve';
import { deriveAbsentCoverageModelFingerprint } from '../catalogue/fingerprint';
import { loadCatalogueBundle, type CatalogueBundle } from '../catalogue/load';
import {
  compileResolvedCorrectnessProfile,
  deriveAbsentCorrectnessProfileFingerprint,
  resolveRouteSelection,
  validateCorrectnessCatalogue,
} from '../catalogue/correctness';
import { auditCorrectnessCompatibility } from '../catalogue/correctness-compatibility';
import type { ResolvedCorrectnessProfile } from '../contracts/correctness';
import {
  buildModelCompleteness,
  deriveCoverageCompleteness,
  validateCoverageCompleteness,
} from '../coverage/account';
import {
  describeProjectScope,
  resolveBindingCoverage,
  resolveCaseCoverage,
} from '../coverage/resolve';
import { selectCoverage } from '../coverage/select';
import { validateCoverageCatalogue } from '../coverage/validate';
import type { CoverageSelection } from '../contracts/coverage';
import {
  deriveCaseId,
  deriveFixtureInputsFingerprint,
  deriveMaterializationFingerprint,
  derivePlanFingerprint,
  deriveTargetRoleContractFingerprint,
} from '../canonical/identity';
import type {
  BlockedPlan,
  CaseRequest,
  CorrectnessProjection,
  EnvironmentBlockedPlan,
  ExecutionPlan,
  MaterializedCase,
  PlanCorrectnessIdentity,
  PlanResult,
  PlannedPlan,
  ReservedPlanResult,
  ResolvedFixtureBinding,
  ResolvedRoute,
} from '../contracts/case-model';
import type { DiagnosticRecord } from '../contracts/diagnostics';
import { createDiagnostic } from '../contracts/diagnostics';
import type { CoverageStatus, PlanStatus } from '../contracts/discriminants';
import type { EphemeralResources } from '../contracts/execution';
import type {
  CoverageAttributionInput,
  PlannerOutputs,
  PreflightFingerprints,
  PreflightReport,
  PreflightScope,
  PreflightStageId,
} from '../contracts/planner-outputs';
import { CASE_REQUEST_SCHEMA_VERSION } from '../contracts/schema-versions';
import { CROSSWORD_SEMANTIC_PROFILE } from '../contracts/crossword-observation';
import {
  readCrosswordSourceContract,
  readLegacyCrosswordSourceContractFromCwd,
} from '../runtime/crossword-source';
import { reconcileRegistry } from '../registry/reconcile';
import { evaluateVariantPolicy, resolveRoute } from '../routing/resolve';
import { compilePlan } from './compile-plan';
import {
  createMaterializedExecutionEnvelope,
  type MaterializedExecutionEnvelopeV1,
} from './execution-materialization';
import { resolveBindingDelivery } from './launchability';
import { buildContractVersions, materializeCase, resolveWorkflowVersion } from './materialize';
import { normalizeCaseRequest } from './normalize-intent';
import {
  PreflightTracker,
  buildPlannerOutputs,
  buildPreflightReport,
  rejectPreflightReport,
  resolvePreflightStage,
} from './preflight';

/**
 * Closed declarative execution planner (decision 0007, specification 8).
 *
 * Every statically knowable stage completes before launch. Any malformed,
 * unknown, stale, duplicate, ambiguous, unsupported, or variant-unsafe contract
 * fails closed with `HARNESS_BLOCKED` and `launchAttempted: false`. A valid plan
 * that an external allocation mechanism cannot reserve is
 * `ENVIRONMENT_FAILURE` with `launchAttempted: false`, also before launch.
 *
 * `planCase` performs static planning only. `planAndReserve` completes the
 * pre-launch contract by reserving exclusive launch resources, as decision 0007
 * N9 requires.
 */

export interface PlannerContext {
  catalogues?: CatalogueBundle;
  workflowVersions?: Readonly<Record<string, number>>;
  /**
   * Explicit application root that owns the generated-Crossword product source
   * (ADR 0118). When supplied it binds the source-currentness read to that
   * root's absolute files rather than `process.cwd()`. When omitted, the
   * explicit legacy cwd-relative seam is used; the public Diagnostic path always
   * supplies it.
   */
  appRoot?: string;
  /**
   * Accepted for forward compatibility. Coverage selection is deterministic and
   * exhaustive and performs no sampling, so this seed is not recorded and does
   * not affect selection identity.
   */
  coverageSeed?: number | null;
}

export interface PlanAndReserveContext extends PlannerContext {
  allocation: {
    executionInstanceId: string;
    ephemeral: EphemeralResources;
  };
}

/**
 * Registry-coverage qualification that reflects the actual complete/incomplete
 * state instead of reusing one generic sentence. Variant observations and
 * registration gaps are named explicitly so an incomplete record cannot imply
 * variant coverage the run did not establish.
 */
function describeRegistryCoverageQualification(input: {
  status: CoverageStatus;
  registrationGaps: number;
  variant: string | null;
  variantUnknown: boolean;
}): string {
  if (input.status === 'complete') {
    return 'Registry coverage is complete: every current application-kind declaration reconciled to a Verification Subject and every observed runtime variant is declared for the resolved binding.';
  }
  const reasons: string[] = [];
  if (input.variantUnknown) {
    reasons.push(
      `undeclared runtime variant ${input.variant === null ? '(none)' : `"${input.variant}"`} may execute on a variant-independent binding but establishes no coverage for that variant and earns no Release credit`,
    );
  }
  if (input.registrationGaps > 0) {
    reasons.push(
      `${input.registrationGaps} application kind(s) have no registered Verification Subject`,
    );
  }
  return `Registry coverage is incomplete: ${reasons.join('; ') || 'registration or variant coverage is not established'}.`;
}

function emptyFingerprints(): PreflightFingerprints {
  return {
    caseId: null,
    materializationFingerprint: null,
    planFingerprint: null,
    registryFingerprint: null,
    applicationInventoryFingerprint: null,
    operationCatalogueFingerprint: null,
    adapterCatalogueFingerprint: null,
    workflowCatalogueFingerprint: null,
    correctnessProfileFingerprint: null,
  };
}

interface CorrectnessProfileCapture {
  /** The exact profile compiled by the shared planning operation, if any. */
  profile: ResolvedCorrectnessProfile | null;
}

/**
 * The one shared internal planning operation (ADR 0029 §2). Both public
 * projections call it exactly once; it compiles the resolved correctness
 * profile at most once and reports it back through `capture` so no projection
 * ever reloads a catalogue or recompiles a profile.
 */
function planCaseInternal(
  rawRequest: unknown,
  context: PlannerContext,
  capture: CorrectnessProfileCapture,
): PlanResult {
  const tracker = new PreflightTracker();
  const warnings: DiagnosticRecord[] = [];
  const scope: PreflightScope = {
    frontendOnly: true,
    subjectId: null,
    capability: null,
    scenario: null,
    variant: null,
  };

  const fingerprints = emptyFingerprints();
  let resolvedContracts: MaterializedCase['contracts'] | null = null;
  let route: ResolvedRoute | null = null;

  const report = (status: PlanStatus): PreflightReport =>
    buildPreflightReport({
      tracker,
      status,
      scope,
      warnings,
      caseId: fingerprints.caseId,
      materializationFingerprint: fingerprints.materializationFingerprint,
      planFingerprint: fingerprints.planFingerprint,
      fingerprints,
      resolvedContracts,
      route,
    });

  const rejectAt = (
    stageId: PreflightStageId,
    diagnostic: DiagnosticRecord,
    findings: readonly DiagnosticRecord[] = [],
  ): BlockedPlan => {
    tracker.record(stageId, 'rejected', diagnostic.detail);
    tracker.reject(diagnostic);
    return {
      status: 'HARNESS_BLOCKED',
      launchAttempted: false,
      code: diagnostic.code,
      diagnostic,
      findings,
      report: report('HARNESS_BLOCKED'),
    };
  };

  // ── P0 — parse input: closed request envelope ─────────────────────────────
  const normalized = normalizeCaseRequest(rawRequest);
  if (!normalized.ok) {
    const stage: PreflightStageId =
      normalized.finding.code === 'MALFORMED_CASE_INTENT' ? 'P2' : 'P0';
    if (stage === 'P2') {
      tracker.record(
        'P0',
        'resolved',
        'Case Request envelope validated: closed keys, schema version, profile, provenance, evidence depth.',
      );
    }
    return rejectAt(stage, normalized.finding);
  }

  const request: CaseRequest = normalized.request;
  tracker.record(
    'P0',
    'resolved',
    `Case Request schema v${CASE_REQUEST_SCHEMA_VERSION} validated: closed keys, profile "${request.profile}", provenance "${request.provenance}", evidence depth "${request.evidenceDepth}".`,
  );

  // ── P2 — normalize Case Intent ────────────────────────────────────────────
  tracker.record(
    'P2',
    'resolved',
    'Case Intent normalized: closed keys, canonical values, deterministic resource ordering.',
  );

  // ── P1 — authoritative catalogues, executable vocabulary, reconciliation ──
  let bundle: CatalogueBundle;
  try {
    bundle = context.catalogues ?? loadCatalogueBundle();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof Error && error.name === 'CatalogueLoadError'
        ? 'CATALOGUE_INVALID'
        : 'CATALOGUE_UNAVAILABLE';
    return rejectAt('P1', createDiagnostic(code, detail));
  }

  // The authoritative Coverage Model catalogue is validated semantically in
  // full before any binding resolves. An invalid model that no request names
  // can therefore never coexist with a launchable plan.
  const coverageCatalogueFindings = validateCoverageCatalogue(bundle.coverageCatalogue);
  const blockingCoverageCatalogueFinding = coverageCatalogueFindings.find(
    (finding) => finding.severity === 'blocking',
  );
  if (blockingCoverageCatalogueFinding) {
    return rejectAt('P1', blockingCoverageCatalogueFinding, coverageCatalogueFindings);
  }

  // The Package 7 correctness catalogue and its registry compatibility
  // projections are validated in full before any binding resolves, so a
  // malformed, dangling, divergent, or weakening declaration can never coexist
  // with a launchable plan (ADR 0023 §5/§9).
  const correctnessFindings = [
    ...validateCorrectnessCatalogue(bundle.correctnessCatalogue),
    ...auditCorrectnessCompatibility(bundle.correctnessCatalogue),
  ];
  const blockingCorrectnessFinding = correctnessFindings.find(
    (finding) => finding.severity === 'blocking',
  );
  if (blockingCorrectnessFinding) {
    return rejectAt('P1', blockingCorrectnessFinding, correctnessFindings);
  }

  const approvedOperations = new Map(
    bundle.operationCatalogue.operations.map((operation) => [operation.discriminant, operation]),
  );
  for (const operation of request.intent.operations) {
    const declared = approvedOperations.get(operation.discriminant);
    if (!declared) {
      return rejectAt(
        'P1',
        createDiagnostic(
          'UNKNOWN_OPERATION_DISCRIMINANT',
          `Operation discriminant "${operation.discriminant}" is not in the approved-operation catalogue`,
        ),
      );
    }
    if (declared.capability !== request.intent.capability) {
      return rejectAt(
        'P1',
        createDiagnostic(
          'OPERATION_CAPABILITY_MISMATCH',
          `Operation "${operation.discriminant}" is declared for Capability "${declared.capability}" but the request declares "${request.intent.capability}"`,
        ),
      );
    }
  }

  const reconciliation = reconcileRegistry({
    subjectCatalogue: bundle.subjectCatalogue,
    applicationInventory: bundle.applicationInventory,
    operationCatalogue: bundle.operationCatalogue,
    adapterCatalogue: bundle.adapterCatalogue,
    workflowCatalogue: bundle.workflowCatalogue,
  });
  fingerprints.registryFingerprint = reconciliation.registryFingerprint;
  fingerprints.applicationInventoryFingerprint = reconciliation.applicationInventoryFingerprint;
  fingerprints.operationCatalogueFingerprint = reconciliation.operationCatalogueFingerprint;
  fingerprints.adapterCatalogueFingerprint = reconciliation.adapterCatalogueFingerprint;
  fingerprints.workflowCatalogueFingerprint = reconciliation.workflowCatalogueFingerprint;

  if (reconciliation.status === 'HARNESS_BLOCKED') {
    return rejectAt(
      'P1',
      createDiagnostic(
        'REGISTRY_HARNESS_BLOCKED',
        'Verification Subject registry reconciliation failed closed',
      ),
      reconciliation.findings,
    );
  }
  warnings.push(...reconciliation.findings);
  tracker.record(
    'P1',
    'resolved',
    `Registry reconciled against the application-kind inventory: ${reconciliation.resolvedSubjects.length} resolved Subjects, fingerprint ${reconciliation.registryFingerprint}.`,
  );

  // ── P3 — resolve Subject, Capability binding and variant policy ───────────
  const subject = reconciliation.resolvedSubjects.find(
    (entry) => entry.subjectId === request.intent.subjectId,
  );
  if (!subject) {
    return rejectAt(
      'P3',
      createDiagnostic(
        'SUBJECT_UNRESOLVED',
        `No resolved Verification Subject matches "${request.intent.subjectId}"`,
      ),
      reconciliation.findings,
    );
  }

  scope.subjectId = subject.subjectId;
  scope.capability = request.intent.capability;
  scope.scenario = request.intent.scenario;
  scope.variant = request.intent.variant;

  const routeResolution = resolveRoute(subject, request.intent.capability);
  if (!routeResolution.ok) {
    return rejectAt('P3', routeResolution.finding, [
      ...reconciliation.findings,
      routeResolution.finding,
    ]);
  }
  const binding = subject.capabilityBindings.find(
    (entry) => entry.capability === request.intent.capability,
  );
  if (!binding) {
    return rejectAt(
      'P3',
      createDiagnostic(
        'CAPABILITY_UNSUPPORTED',
        `Subject declares no binding for Capability "${request.intent.capability}"`,
      ),
      reconciliation.findings,
    );
  }

  // A binding that declares no required authoritative check can never prove a
  // user-observable result, so it is rejected before planning rather than
  // silently producing an unverifiable plan.
  if (binding.checks.length === 0) {
    return rejectAt(
      'P3',
      createDiagnostic(
        'CAPABILITY_BINDING_NO_CHECKS',
        `Binding "${subject.subjectId}" × "${request.intent.capability}" declares no required authoritative check`,
        { subjectId: subject.subjectId, context: { capability: request.intent.capability } },
      ),
      reconciliation.findings,
    );
  }

  const variantPolicy = evaluateVariantPolicy(subject, binding, request.intent.variant);
  if (variantPolicy.finding) {
    if (variantPolicy.blocked) {
      return rejectAt('P3', variantPolicy.finding, [
        ...reconciliation.findings,
        variantPolicy.finding,
      ]);
    }
    warnings.push(variantPolicy.finding);
  }

  const coverageStatus: CoverageStatus = variantPolicy.coverageIncomplete
    ? 'incomplete'
    : reconciliation.coverageStatus;

  tracker.record(
    'P3',
    'resolved',
    `Binding resolved from declarations: Subject "${subject.subjectId}", Capability "${request.intent.capability}", variant ${request.intent.variant === null ? '(none)' : `"${request.intent.variant}"`}.`,
  );

  // ── P4 — materialize Factors, partitions, constraints, obligations, attribution ──
  const projectScope = describeProjectScope({
    resolvedSubjects: reconciliation.resolvedSubjects,
    catalogue: bundle.coverageCatalogue,
  });
  let coverageModelFingerprint: string;
  let coverageSelection: CoverageSelection | null = null;
  let caseObligationIds: readonly string[] = [];
  let caseRepresentativeIds: readonly string[] = [];
  let caseDiagnosticOverride = false;
  let caseReleaseScenario = false;
  let coverageModelPresent = false;
  let coverageModelComplete = false;
  let coverageModelQualification = '';

  const bindingCoverage = resolveBindingCoverage({
    catalogue: bundle.coverageCatalogue,
    subjectId: subject.subjectId,
    capability: request.intent.capability,
  });

  if (bindingCoverage.status === 'blocked') {
    return rejectAt('P4', bindingCoverage.findings[0], [
      ...reconciliation.findings,
      ...bindingCoverage.findings,
    ]);
  }

  if (bindingCoverage.status === 'missing') {
    coverageModelPresent = false;
    coverageModelFingerprint = deriveAbsentCoverageModelFingerprint(
      subject.subjectId,
      request.intent.capability,
    );
    coverageModelQualification = `Binding "${subject.subjectId}" × "${request.intent.capability}" has no Coverage Model; binding model completeness is not established and no release credit may be claimed.`;
    warnings.push(...bindingCoverage.findings);
    tracker.record(
      'P4',
      'resolved',
      'No Coverage Model is declared for the resolved binding; coverage is reported incomplete and no release credit is claimed.',
    );
  } else {
    coverageModelPresent = true;
    coverageModelFingerprint = bindingCoverage.modelFingerprint;

    const caseCoverage = resolveCaseCoverage({
      model: bindingCoverage.model,
      intent: request.intent,
      profile: request.profile,
      provenance: request.provenance,
    });
    if (!caseCoverage.ok) {
      return rejectAt('P4', caseCoverage.finding, [
        ...reconciliation.findings,
        caseCoverage.finding,
      ]);
    }

    caseObligationIds = caseCoverage.coverage.obligations;
    caseRepresentativeIds = caseCoverage.coverage.representativeIds;
    caseDiagnosticOverride = caseCoverage.coverage.diagnosticOverride;
    caseReleaseScenario = caseCoverage.coverage.scenario.eligibility === 'release-required';

    coverageSelection = selectCoverage({
      model: bindingCoverage.model,
      modelFingerprint: bindingCoverage.modelFingerprint,
      profile: request.profile,
      seed: context.coverageSeed ?? null,
    });
    const modelCompleteness = buildModelCompleteness(coverageSelection);
    coverageModelComplete = modelCompleteness.complete;
    coverageModelQualification = modelCompleteness.qualification;
    warnings.push(...coverageSelection.warnings);

    tracker.record(
      'P4',
      'resolved',
      `Binding Coverage Model resolved (fingerprint ${bindingCoverage.modelFingerprint}): ${bindingCoverage.model.factors.length} factor(s), ${bindingCoverage.model.obligations.length} obligation(s), ${coverageSelection.cases.length} selected case(s) under policy "${coverageSelection.policyVersion}".`,
    );
  }

  const registrationGaps = reconciliation.findings.filter(
    (finding) => finding.code === 'SUBJECT_REGISTRATION_MISSING',
  ).length;
  const registryQualification = describeRegistryCoverageQualification({
    status: coverageStatus,
    registrationGaps,
    variant: request.intent.variant,
    variantUnknown: variantPolicy.status === 'unknown',
  });

  // Release credit is denied by explicit, named blockers. An undeclared runtime
  // variant that may still execute never earns credit and never implies variant
  // coverage.
  const releaseCreditBlockers: string[] = [];
  if (request.profile !== 'release') releaseCreditBlockers.push('profile-not-release');
  if (request.provenance !== 'manifest') releaseCreditBlockers.push('provenance-not-manifest');
  if (!coverageModelPresent) {
    releaseCreditBlockers.push('coverage-model-missing');
  } else if (!coverageModelComplete) {
    releaseCreditBlockers.push('coverage-model-incomplete');
  }
  if (!caseReleaseScenario) releaseCreditBlockers.push('scenario-not-release-required');
  if (caseDiagnosticOverride) releaseCreditBlockers.push('diagnostic-concrete-override');
  if (coverageStatus !== 'complete') releaseCreditBlockers.push('registry-coverage-incomplete');
  if (variantPolicy.status === 'unknown') releaseCreditBlockers.push('variant-undeclared');
  const releaseCreditEligible = releaseCreditBlockers.length === 0;
  const releaseCreditBasis = releaseCreditEligible
    ? 'Release profile with manifest provenance, a complete validated Coverage Model, a release-required declared scenario, a declared variant, and no diagnostic concrete override.'
    : `Release credit is not established: ${releaseCreditBlockers.join(', ')}.`;

  const completenessEntries = deriveCoverageCompleteness({
    bindingModelPresent: coverageModelPresent,
    bindingModelComplete: coverageModelComplete,
    bindingModelQualification: coverageModelQualification,
    registryCoverageStatus: coverageStatus,
    registryQualification,
    projectScopeComplete: projectScope.complete,
    projectScopeQualification: projectScope.qualification,
  });
  const completenessFindings = validateCoverageCompleteness(completenessEntries);
  const blockingCompletenessFinding = completenessFindings.find(
    (finding) => finding.severity === 'blocking',
  );
  if (blockingCompletenessFinding) {
    return rejectAt('P4', blockingCompletenessFinding, [
      ...reconciliation.findings,
      ...completenessFindings,
    ]);
  }

  const coverage: CoverageAttributionInput = {
    coverageModelFingerprint,
    selectionPolicyVersion: coverageSelection?.policyVersion ?? null,
    selectionInputFingerprint: coverageSelection?.inputFingerprint ?? null,
    selectedCaseKeys: coverageSelection
      ? coverageSelection.cases.map((entry) => entry.caseKey)
      : [],
    obligations: caseObligationIds,
    representatives: caseRepresentativeIds,
    obligationMappings: coverageSelection?.obligationMappings ?? [],
    tupleCoverage: coverageSelection?.tupleCoverage ?? null,
    releaseCreditEligible,
    releaseCreditBasis,
    releaseCreditBlockers,
    completeness: completenessEntries,
  };

  route = routeResolution.route;
  // caseId is derived after P5 fixture resolution: the resolved fixture binding
  // is semantic pre-state (ADR 0015 B16).

  // ── P5/P7 — stage-accurate delivery resolution for this binding ──────────
  // A binding earns resolved fixture/resource/environment and readiness/Oracle/
  // evidence roles only when every role is delivered: a fixture for its
  // subjectId × capability × scenarioId, an implemented adapter at the declared
  // compatibility version, and delivered declarative workflow steps. Every
  // undelivered binding stays deferred and therefore non-launchable.
  const delivery = resolveBindingDelivery({
    subjectId: subject.subjectId,
    capability: request.intent.capability,
    scenarioId: request.intent.scenario,
    adapterDeclaration: subject.adapter,
    adapterId: route.adapterId,
    adapterCompatibilityVersion: route.adapterCompatibilityVersion,
    workflowId: route.workflowId,
    adapterCatalogue: bundle.adapterCatalogue,
    workflowStepCatalogue: bundle.workflowStepCatalogue,
    fixtureCatalogue: bundle.fixtureCatalogue,
  });
  if (delivery.delivered && delivery.fixture !== null) {
    tracker.record(
      'P5',
      'resolved',
      `Fixture "${delivery.fixture.fixtureId}" resolved for ${subject.subjectId} × ${request.intent.capability} × ${request.intent.scenario}: constructor ${delivery.fixture.constructorId} v${delivery.fixture.constructorVersion} with ${delivery.fixture.semanticTargetRoles.length} semantic target role(s); environment/resources are the owned run allocation.`,
    );
  }
  // Undelivered roles are expressed by P5/P7 staying deferred — and therefore by
  // a non-launchable binding — not by a blocking planner warning. The blocking
  // `ADAPTER_IMPLEMENTATION_UNAVAILABLE` is raised by the diagnostic command
  // immediately before launch, so planning stays usable for undelivered
  // bindings while execution fails closed.
  // ── Generated-Crossword source-currentness binding (ADR 0017 R4) ────────
  // A resolved role contract that declares the generated Crossword semantic
  // profile binds the accepted product source contract into materialization and
  // the plan itself. A source that no longer proves the exact initial seed path
  // fails closed here, before any launch; the runtime then re-checks the live
  // source against this immutable fingerprint and fails drift instead of
  // re-baselining on a changed product revision.
  const crosswordSourceFingerprint = (():
    | { ok: true; fingerprint: string }
    | { ok: false; detail: string }
    | null => {
    if (
      !delivery.delivered ||
      delivery.fixture === null ||
      !delivery.fixture.semanticTargetRoles.some(
        (role) => role.semanticProfile === CROSSWORD_SEMANTIC_PROFILE,
      )
    ) {
      return null;
    }
    // The explicit app root owns the product source; without one the legacy
    // cwd-relative seam is used deliberately and only for pre-app-root callers.
    const read =
      context.appRoot === undefined
        ? readLegacyCrosswordSourceContractFromCwd()
        : readCrosswordSourceContract(context.appRoot);
    return read.ok
      ? { ok: true, fingerprint: read.fingerprint }
      : { ok: false, detail: read.detail };
  })();
  if (crosswordSourceFingerprint !== null && !crosswordSourceFingerprint.ok) {
    return rejectAt(
      'P7',
      createDiagnostic(
        'CROSSWORD_SOURCE_DRIFT',
        `The accepted generated-Crossword source contract no longer matches ADR 0017 R4: ${crosswordSourceFingerprint.detail}`,
      ),
    );
  }

  const fixtureBinding: ResolvedFixtureBinding | undefined =
    delivery.delivered && delivery.fixture !== null
      ? {
          fixtureId: delivery.fixture.fixtureId,
          constructorId: delivery.fixture.constructorId,
          constructorVersion: delivery.fixture.constructorVersion,
          inputsFingerprint: deriveFixtureInputsFingerprint(delivery.fixture.inputs),
          targetRoleContractFingerprint: deriveTargetRoleContractFingerprint(
            delivery.fixture.semanticTargetRoles,
          ),
          semanticTargetRoles: delivery.fixture.semanticTargetRoles,
          ...(crosswordSourceFingerprint !== null && crosswordSourceFingerprint.ok
            ? { crosswordSourceFingerprint: crosswordSourceFingerprint.fingerprint }
            : {}),
        }
      : undefined;
  const caseId = deriveCaseId(request.intent, fixtureBinding);
  fingerprints.caseId = caseId;

  // ── P7 — resolve the compiled correctness projection ─────────────────────
  // A delivered route resolves exactly one approved correctness profile through
  // the closed route-selection catalogue. Composition, reference closure, and
  // non-weakening are enforced by the compiler before any launch; a missing or
  // invalid delivered-route profile fails closed (`HARNESS_BLOCKED`). An
  // undelivered binding resolves no profile and stays deferred.
  let correctnessProfile: ResolvedCorrectnessProfile | null = null;
  if (delivery.delivered && delivery.fixture !== null) {
    const selection = resolveRouteSelection(bundle.correctnessCatalogue, {
      subjectId: subject.subjectId,
      capability: request.intent.capability,
      variant: request.intent.variant,
    });
    if (selection !== null) {
      const compiled = compileResolvedCorrectnessProfile({
        catalogue: bundle.correctnessCatalogue,
        selection,
        declaredChecks: binding.checks,
      });
      if (!compiled.ok) {
        return rejectAt('P7', compiled.findings[0], compiled.findings);
      }
      correctnessProfile = compiled.profile;
      capture.profile = compiled.profile;
    }
  }
  if (correctnessProfile !== null) {
    tracker.record(
      'P7',
      'resolved',
      `Readiness/Oracle/evidence roles resolved: adapter "${route.adapterId}" v${route.adapterCompatibilityVersion} delivered, workflow "${route.workflowId}" declares ${delivery.workflowSteps?.length ?? 0} declarative step(s), readiness profile "${correctnessProfile.profileId}", Oracle profile "${correctnessProfile.oracle.oracleProfileId}", ${correctnessProfile.requiredChecks.length} composed required authoritative check(s), resolved correctness fingerprint ${correctnessProfile.resolvedFingerprint}.`,
    );
  }
  const correctnessIdentity: PlanCorrectnessIdentity =
    correctnessProfile !== null
      ? {
          profileId: correctnessProfile.profileId,
          resolvedFingerprint: correctnessProfile.resolvedFingerprint,
        }
      : {
          profileId: null,
          resolvedFingerprint: deriveAbsentCorrectnessProfileFingerprint(
            subject.subjectId,
            request.intent.capability,
            request.intent.variant,
          ),
        };
  fingerprints.correctnessProfileFingerprint = correctnessIdentity.resolvedFingerprint;

  // ── P6 — route through the Subject's one adapter ──────────────────────────
  tracker.record(
    'P6',
    'resolved',
    `Routed through the Subject's single adapter "${route.adapterId}" (compatibility v${route.adapterCompatibilityVersion}) and workflow "${route.workflowId}".`,
  );

  // ── P8 — compile the closed phase graph ──────────────────────────────────
  const plan: ExecutionPlan = compilePlan({
    caseId,
    intent: request.intent,
    route,
    fixture: fixtureBinding,
    correctness: correctnessIdentity,
    ...(correctnessProfile === null
      ? {}
      : { requiredChecks: correctnessProfile.requiredChecks.map((check) => check.checkId) }),
  });
  tracker.record(
    'P8',
    'resolved',
    `Closed phase graph compiled: ${plan.phases.length} phases, ${plan.requiredChecks.length} required authoritative check(s), mandatory cleanup "${plan.cleanup.join(', ')}".`,
  );

  // ── P9 — derive domain-separated identities ──────────────────────────────
  const workflowEntry = bundle.workflowCatalogue.workflows.find(
    (entry) => entry.workflowId === route.workflowId,
  );
  const contracts = buildContractVersions({
    subjectCatalogueSchemaVersion: bundle.subjectCatalogue.schemaVersion,
    registryFingerprint: reconciliation.registryFingerprint,
    applicationInventoryFingerprint: reconciliation.applicationInventoryFingerprint,
    operationCatalogueFingerprint: reconciliation.operationCatalogueFingerprint,
    adapterCatalogueFingerprint: reconciliation.adapterCatalogueFingerprint,
    workflowCatalogueFingerprint: reconciliation.workflowCatalogueFingerprint,
    familyDefaultVersion: subject.familyDefaultVersion,
    adapterCompatibilityVersion: route.adapterCompatibilityVersion,
    workflowVersion: resolveWorkflowVersion(
      context.workflowVersions ?? {},
      route.workflowId,
      workflowEntry?.version ?? 1,
    ),
    coverageModelFingerprint,
    correctnessProfileFingerprint: correctnessIdentity.resolvedFingerprint,
  });

  const materializedCase: MaterializedCase = materializeCase({
    caseId,
    intent: request.intent,
    subject,
    route,
    contracts,
    fixture: fixtureBinding,
  });

  fingerprints.materializationFingerprint = deriveMaterializationFingerprint(materializedCase);
  fingerprints.planFingerprint = derivePlanFingerprint(plan);
  resolvedContracts = contracts;

  tracker.record(
    'P9',
    'resolved',
    'case, materialization and plan identities derived with domain-separated SHA-256; ephemeral allocation excluded from the plan fingerprint.',
  );

  const fingerprintsForOutput = {
    registryFingerprint: reconciliation.registryFingerprint,
    applicationInventoryFingerprint: reconciliation.applicationInventoryFingerprint,
    operationCatalogueFingerprint: reconciliation.operationCatalogueFingerprint,
    adapterCatalogueFingerprint: reconciliation.adapterCatalogueFingerprint,
    workflowCatalogueFingerprint: reconciliation.workflowCatalogueFingerprint,
    correctnessProfileFingerprint: correctnessIdentity.resolvedFingerprint,
  };

  const outputs: PlannerOutputs = buildPlannerOutputs({
    tracker,
    status: 'PLANNED',
    scope,
    warnings,
    coverageStatus,
    provenance: request.provenance,
    profile: request.profile,
    caseId,
    route,
    resolvedContracts: contracts,
    materializationFingerprint: fingerprints.materializationFingerprint,
    planFingerprint: fingerprints.planFingerprint,
    fingerprints: fingerprintsForOutput,
    requiredChecks: plan.requiredChecks,
    correctnessProfile,
    coverage,
    ownershipCleanup: buildOwnershipCleanupManifest({
      identity: {
        caseId,
        materializationFingerprint: fingerprints.materializationFingerprint,
        planFingerprint: fingerprints.planFingerprint,
      },
      executionInstanceId: null,
      allocation: null,
    }),
  });

  return {
    status: 'PLANNED',
    launchAttempted: false,
    caseId,
    materializationFingerprint: fingerprints.materializationFingerprint,
    planFingerprint: fingerprints.planFingerprint,
    request,
    materializedCase,
    plan,
    outputs,
    coverageStatus,
    findings: warnings,
  };
}

/**
 * Public planning projection (decision 0007). Its result is byte-for-byte
 * unchanged by the internal execution materialization: it discards the
 * compile-once profile and returns exactly the accepted `PlanResult`.
 */
export function planCase(rawRequest: unknown, context: PlannerContext = {}): PlanResult {
  return planCaseInternal(rawRequest, context, { profile: null });
}

/**
 * The internal planning projection for execution (ADR 0029 §2).
 *
 * It calls the same shared internal operation as {@link planCase} exactly once
 * and returns the identical public result plus the exact compile-once
 * materialization envelope. It never calls `planCase()` and then recompiles,
 * never reloads a catalogue, and never resolves a profile by id. A planned but
 * undelivered binding compiled no profile, so its envelope is explicitly `null`
 * and execution must fail closed before allocation.
 *
 * This projection is deliberately **not** exported from `src/index.ts`.
 */
export type PlanForExecutionResult =
  | (PlannedPlan & {
      envelope: MaterializedExecutionEnvelopeV1 | null;
    })
  | BlockedPlan
  | EnvironmentBlockedPlan;

export function planCaseForExecution(
  rawRequest: unknown,
  context: PlannerContext = {},
): PlanForExecutionResult {
  const capture: CorrectnessProfileCapture = { profile: null };
  const result = planCaseInternal(rawRequest, context, capture);
  if (result.status !== 'PLANNED') return result;
  const envelope =
    capture.profile === null
      ? null
      : createMaterializedExecutionEnvelope({
          caseId: result.caseId,
          materializationFingerprint: result.materializationFingerprint,
          planFingerprint: result.planFingerprint,
          plan: result.plan,
          correctnessProfile: capture.profile,
        });
  return { ...result, envelope };
}

/**
 * Completes the pre-launch contract: a valid plan must hold an exclusive
 * reservation before launch (decision 0007 N9). A reservation the external
 * allocation mechanism refuses is `ENVIRONMENT_FAILURE`, never `BUG`.
 */
export function planAndReserve(
  rawRequest: unknown,
  context: PlanAndReserveContext,
): ReservedPlanResult {
  const result: PlanResult = planCase(rawRequest, context);
  if (result.status !== 'PLANNED') return result;

  const identity = {
    caseId: result.caseId,
    materializationFingerprint: result.materializationFingerprint,
    planFingerprint: result.planFingerprint,
  };

  const reservation = reserveAllocation(
    identity,
    context.allocation.executionInstanceId,
    context.allocation.ephemeral,
  );

  if (reservation.status === 'ENVIRONMENT_FAILURE') {
    const blocked: EnvironmentBlockedPlan = {
      status: 'ENVIRONMENT_FAILURE',
      launchAttempted: false,
      reason: reservation.reason,
      findings: [],
      report: rejectPreflightReport(
        result.outputs.preflightReport,
        'P10',
        reservation.reason,
        reservation.detail,
        'ENVIRONMENT_FAILURE',
      ),
    };
    return blocked;
  }

  return {
    ...result,
    allocation: reservation.allocation,
    outputs: {
      ...result.outputs,
      preflightReport: resolvePreflightStage(
        result.outputs.preflightReport,
        'P10',
        `Exclusive launch resources reserved before launch: port ${reservation.allocation.ephemeral.port}, process group ${reservation.allocation.ephemeral.processGroupId}, allocation ${reservation.allocation.allocationId}.`,
      ),
      ownershipCleanup: buildOwnershipCleanupManifest({
        identity,
        executionInstanceId: context.allocation.executionInstanceId,
        allocation: reservation.allocation,
      }),
    },
  };
}

/**
 * The correctness projection is profile-independent: Diagnostic and Release
 * share it exactly. Profile changes provenance, release credit, and evidence
 * depth only.
 */
export function correctnessProjection(result: PlanResult): CorrectnessProjection | null {
  if (result.status !== 'PLANNED') return null;
  return {
    caseId: result.caseId,
    intent: result.materializedCase.intent,
    route: result.materializedCase.route,
    requiredChecks: result.plan.requiredChecks,
  };
}
