import { runBranchCheck } from '../../scripts/verify-engine-branching.mjs';
import { deriveCoverageModelFingerprint } from '../catalogue/fingerprint';
import {
  buildBindingCorrectnessLedger,
  compileDeliveredRouteProfiles,
  deriveCorrectnessCatalogueFingerprint,
  validateCorrectnessCatalogue,
} from '../catalogue/correctness';
import {
  buildPackage7CompletenessLedger,
  completenessLedgerArtifactPath,
  persistCompletenessLedgerFile,
} from '../catalogue/completeness';
import { auditCorrectnessCompatibility } from '../catalogue/correctness-compatibility';
import { CatalogueLoadError, type CatalogueBundle, loadCatalogueBundle } from '../catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../catalogue/suite';
import { DiagnosticSuiteValidationError, REPRESENTATIVE_SUITE_ID } from '../contracts/suite';
import {
  createDiagnostic,
  hasBlockingDiagnostic,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { Capability } from '../contracts/discriminants';
import type { BindingCorrectnessLedgerEntry } from '../contracts/correctness';
import {
  PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH,
  type Package7AcceptedSuiteState,
  type Package7CompletenessCounts,
  type Package7CompletenessDimension,
} from '../contracts/completeness';
import type { CliResult } from '../contracts/runtime';
import { validateCoverageModel } from '../coverage/validate';
import { planCase } from '../planner/plan-case';
import { reconcileRegistry } from '../registry/reconcile';
import { EnvironmentCatalogueError, loadEnvironmentCatalogue } from '../runtime/environment';
import { buildCliResult } from './output';

/**
 * `pnpm verify:artwork validate --all` (TS-2, Gates A/B).
 *
 * Applies exactly the same authoritative catalogues and the same AST branch
 * audit the planner relies on, without launching the application. The result is
 * machine-readable and the exit code reflects the real validation outcome.
 */

export interface ValidatedCoverageModel {
  subjectId: string;
  capability: string;
  fingerprint: string;
  status: 'invalid' | 'valid';
  blockingCodes: string[];
  findingCount: number;
}

export interface ValidatedRepresentativeSuite {
  suiteId: string;
  status: 'invalid' | 'valid';
  suiteFingerprint: string | null;
  memberCount: number;
  requestPaths: readonly string[];
  blockingCodes: readonly string[];
}

export interface ValidatedCorrectnessProfile {
  profileId: string;
  subjectId: string;
  capability: string;
  variant: string | null;
  resolvedFingerprint: string;
  requiredChecks: readonly string[];
  componentFingerprints: {
    readiness: string;
    capture: string;
    oracle: string;
    capabilityBaseline: string;
    subjectAddition: string;
    requiredCheckSet: string;
    tolerances: string;
    visuals: string;
    normalization: string;
  };
}

export interface ValidatePackage7Details {
  catalogueSchemaVersion: number;
  catalogueFingerprint: string;
  counts: {
    readinessDeclarations: number;
    captureDeclarations: number;
    oracleDeclarations: number;
    capabilityBaselines: number;
    subjectAdditions: number;
    routeSelections: number;
    tolerances: number;
    visualAuthorities: number;
    normalizations: number;
    declaredBindings: number;
    coverageModels: number;
    bindingsWithoutModels: number;
    selectedReleaseAssignments: number;
    representativeCases: number;
    compiledProfiles: number;
  };
  profiles: readonly ValidatedCorrectnessProfile[];
  referenceClosure: { resolved: boolean; findings: readonly DiagnosticRecord[] };
  composition: { satisfied: boolean; findings: readonly DiagnosticRecord[] };
  compatibility: { satisfied: boolean; findings: readonly DiagnosticRecord[] };
  deliveredRouteCoverage: {
    selections: number;
    compiled: number;
    missingProfiles: readonly string[];
  };
  /** Explicit unavailable/incomplete bindings; never claimed as executed. */
  unavailableBindings: readonly BindingCorrectnessLedgerEntry[];
  ledgerCounts: {
    compiledProfile: number;
    coverageModelOnly: number;
    profileUnavailable: number;
  };
  /**
   * P7-C completeness ledger accounting (gap-plan §5 P7-C). Every dimension is
   * separate; the durable artifact is deterministic and contains no timestamp.
   */
  completeness: {
    artifactPath: typeof PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH;
    artifactSha256: string | null;
    artifactBytes: number | null;
    persisted: boolean;
    ledgerFingerprint: string;
    acceptedRepresentativeState: Package7AcceptedSuiteState;
    counts: Package7CompletenessCounts;
    dimensions: readonly Package7CompletenessDimension[];
    releaseCreditGranted: false;
    findings: readonly DiagnosticRecord[];
  };
}

export interface ValidateAllDetails {
  launchAttempted: false;
  catalogues: {
    subjectCatalogueSchemaVersion: number;
    applicationInventoryFingerprint: string;
    operationCatalogueFingerprint: string;
    adapterCatalogueFingerprint: string;
    workflowCatalogueFingerprint: string;
  };
  counts: {
    declarations: number;
    resolvedSubjects: number;
    applicationKinds: number;
    operations: number;
    adapters: number;
    workflows: number;
    coverageModels: number;
    environmentCells: number;
    suiteMembers: number;
  };
  suites: {
    representative: ValidatedRepresentativeSuite;
  };
  registry: {
    status: string;
    coverageStatus: string;
    registryFingerprint: string;
    findings: readonly DiagnosticRecord[];
  };
  coverage: {
    models: readonly ValidatedCoverageModel[];
    findings: readonly DiagnosticRecord[];
  };
  environments: {
    cells: readonly { cellId: string; classification: string }[];
  };
  branchAudit: {
    passed: boolean;
    engineFiles: number;
    tokenCount: number;
    violations: readonly unknown[];
  };
  /** Package 7 Slice A structured reporting (ADR 0023 §9). */
  correctness: ValidatePackage7Details;
  blockingDiagnostics: readonly DiagnosticRecord[];
}

function catalogueLoadDiagnostic(error: unknown): DiagnosticRecord {
  if (error instanceof CatalogueLoadError) {
    const unavailable =
      error.code === 'CATALOGUE_FILE_MISSING' || error.code === 'CATALOGUE_FILE_UNREADABLE';
    return createDiagnostic(
      unavailable ? 'CATALOGUE_UNAVAILABLE' : 'CATALOGUE_INVALID',
      `[${error.code}] ${error.message}`,
    );
  }
  return createDiagnostic('CATALOGUE_UNAVAILABLE', String(error));
}

/**
 * Whole-suite authoring validation (ADR 0019 R12; design §7.2).
 *
 * `validate --all` proves the representative declaration parses, every stable
 * request copy is readable, each request still plans to the declared semantic
 * case identity, and every member is a Diagnostic request. It never allocates or
 * launches: the per-child runtime boundary belongs to the suite coordinator.
 */
function validateRepresentativeSuite(bundle: CatalogueBundle): {
  entry: ValidatedRepresentativeSuite;
  findings: DiagnosticRecord[];
} {
  const findings: DiagnosticRecord[] = [];
  try {
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    const requests = resolveSuiteRequests(loaded);
    for (const member of requests) {
      const plan = planCase(member.request, { catalogues: bundle });
      if (plan.status !== 'PLANNED') {
        findings.push(
          plan.status === 'HARNESS_BLOCKED'
            ? plan.diagnostic
            : createDiagnostic(
                'DIAGNOSTIC_SUITE_INVALID',
                `Representative member order ${member.declaration.order} could not be planned: ${plan.reason}`,
              ),
        );
        continue;
      }
      if (plan.request.profile !== 'diagnostic') {
        findings.push(
          createDiagnostic(
            'DIAGNOSTIC_SUITE_INVALID',
            `Representative member order ${member.declaration.order} is not a Diagnostic request.`,
          ),
        );
      }
      if (plan.caseId !== member.declaration.caseId) {
        findings.push(
          createDiagnostic(
            'DIAGNOSTIC_SUITE_INVALID',
            `Representative member order ${member.declaration.order} planned case identity does not match the declaration.`,
          ),
        );
      }
    }
    const blockingCodes = findings
      .filter((finding) => finding.severity === 'blocking')
      .map((finding) => finding.code);
    return {
      entry: {
        suiteId: loaded.suite.suiteId,
        status: blockingCodes.length === 0 ? 'valid' : 'invalid',
        suiteFingerprint: loaded.fingerprint,
        memberCount: loaded.suite.cases.length,
        requestPaths: loaded.suite.cases.map((entry) => entry.request),
        blockingCodes,
      },
      findings,
    };
  } catch (error) {
    const code =
      error instanceof DiagnosticSuiteValidationError ? error.code : 'DIAGNOSTIC_SUITE_INVALID';
    const detail = error instanceof Error ? error.message : String(error);
    const diagnostic = createDiagnostic(code, detail);
    return {
      entry: {
        suiteId: REPRESENTATIVE_SUITE_ID,
        status: 'invalid',
        suiteFingerprint: null,
        memberCount: 0,
        requestPaths: [],
        blockingCodes: [diagnostic.code],
      },
      findings: [diagnostic],
    };
  }
}

export function runValidateAll(): CliResult<ValidateAllDetails> {
  let bundle: CatalogueBundle;
  try {
    bundle = loadCatalogueBundle();
  } catch (error) {
    const diagnostic = catalogueLoadDiagnostic(error);
    return buildCliResult<ValidateAllDetails>({
      command: 'validate',
      subcommand: 'all',
      status: 'HARNESS_BLOCKED',
      detail: `Authoritative catalogues could not be loaded: ${diagnostic.detail}`,
      diagnostics: [diagnostic],
    });
  }

  const diagnostics: DiagnosticRecord[] = [];
  let environmentCells: { cellId: string; classification: string }[] = [];
  try {
    const catalogue = loadEnvironmentCatalogue();
    environmentCells = catalogue.cells.map((cell) => ({
      cellId: cell.cellId,
      classification: cell.classification,
    }));
  } catch (error) {
    if (error instanceof EnvironmentCatalogueError) {
      diagnostics.push(createDiagnostic('ENVIRONMENT_CATALOGUE_INVALID', error.message));
    } else {
      throw error;
    }
  }

  const coverageFindings: DiagnosticRecord[] = [];
  const models: ValidatedCoverageModel[] = bundle.coverageCatalogue.models.map((model) => {
    const findings = validateCoverageModel(model);
    coverageFindings.push(...findings);
    const blockingCodes = findings
      .filter((finding) => finding.severity === 'blocking')
      .map((finding) => finding.code);
    return {
      subjectId: model.subjectId,
      capability: model.capability,
      fingerprint: deriveCoverageModelFingerprint(model),
      status: blockingCodes.length === 0 ? 'valid' : 'invalid',
      blockingCodes,
      findingCount: findings.length,
    };
  });

  const reconciliation = reconcileRegistry({
    subjectCatalogue: bundle.subjectCatalogue,
    applicationInventory: bundle.applicationInventory,
    operationCatalogue: bundle.operationCatalogue,
    adapterCatalogue: bundle.adapterCatalogue,
    workflowCatalogue: bundle.workflowCatalogue,
  });

  const branchCheck = runBranchCheck();

  const suiteValidation = validateRepresentativeSuite(bundle);

  // ── Package 7 correctness catalogue reporting (ADR 0023 §9) ──────────────
  const correctnessCatalogue = bundle.correctnessCatalogue;
  const declaredBindings: { subjectId: string; capability: Capability }[] = [];
  const declaredChecksByBinding = new Map<string, readonly string[]>();
  for (const declaration of bundle.subjectCatalogue.declarations) {
    for (const binding of declaration.capabilityBindings) {
      declaredBindings.push({ subjectId: declaration.subjectId, capability: binding.capability });
      declaredChecksByBinding.set(
        `${declaration.subjectId}\u0000${binding.capability}`,
        binding.checks,
      );
    }
  }
  const coverageModelKeys = new Set(
    bundle.coverageCatalogue.models.map((model) => `${model.subjectId}\u0000${model.capability}`),
  );
  const bindingsWithoutModels = declaredBindings.filter(
    (binding) => !coverageModelKeys.has(`${binding.subjectId}\u0000${binding.capability}`),
  ).length;

  // P7-C completeness ledger (gap-plan §5 P7-C). It owns the deterministic
  // Release-selection accounting, the runtime-support projection, and the
  // read-only accepted representative-suite projection, and it persists the
  // durable, timestamp-free artifact atomically. The 55 selected Release
  // assignments are never conflated with the 8 accepted representative cases.
  const completenessResult = buildPackage7CompletenessLedger({ bundle, reconciliation });
  const completenessFindings = [...completenessResult.findings];
  let completenessArtifactSha256: string | null = null;
  let completenessArtifactBytes: number | null = null;
  let completenessPersisted = false;
  try {
    const written = persistCompletenessLedgerFile(completenessResult.ledger);
    completenessPersisted = true;
    completenessArtifactSha256 = written.sha256;
    completenessArtifactBytes = written.bytes;
  } catch (error) {
    completenessFindings.push(
      createDiagnostic(
        'COMPLETENESS_LEDGER_PERSIST_FAILED',
        `The Package-7 completeness ledger could not be persisted atomically at ${completenessLedgerArtifactPath()}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const selectedReleaseAssignments = completenessResult.ledger.counts.selectedReleaseAssignments;

  const referenceFindings = validateCorrectnessCatalogue(correctnessCatalogue);
  const compatibilityFindings = auditCorrectnessCompatibility(correctnessCatalogue);
  const compiledProfiles = compileDeliveredRouteProfiles(
    correctnessCatalogue,
    declaredChecksByBinding,
  );
  const compiledProfileKeys = new Set(
    compiledProfiles.profiles.map(
      (profile) =>
        `${profile.subjectId}\u0000${profile.capability}\u0000${profile.variant === null ? '\u0000null' : profile.variant}`,
    ),
  );
  const missingProfiles = correctnessCatalogue.routeSelections
    .filter(
      (selection) =>
        !compiledProfileKeys.has(
          `${selection.subjectId}\u0000${selection.capability}\u0000${selection.variant === null ? '\u0000null' : selection.variant}`,
        ),
    )
    .map(
      (selection) => `${selection.subjectId}×${selection.capability}@${selection.variant ?? '∅'}`,
    );

  const ledger = buildBindingCorrectnessLedger(
    correctnessCatalogue,
    declaredBindings,
    coverageModelKeys,
  );

  const correctnessDetails: ValidatePackage7Details = {
    catalogueSchemaVersion: correctnessCatalogue.schemaVersion,
    catalogueFingerprint: deriveCorrectnessCatalogueFingerprint(correctnessCatalogue),
    counts: {
      readinessDeclarations: correctnessCatalogue.readiness.length,
      captureDeclarations: correctnessCatalogue.captures.length,
      oracleDeclarations: correctnessCatalogue.oracles.length,
      capabilityBaselines: correctnessCatalogue.capabilityBaselines.length,
      subjectAdditions: correctnessCatalogue.subjectAdditions.length,
      routeSelections: correctnessCatalogue.routeSelections.length,
      tolerances: correctnessCatalogue.tolerances.length,
      visualAuthorities: correctnessCatalogue.visuals.length,
      normalizations: correctnessCatalogue.normalizations.length,
      declaredBindings: declaredBindings.length,
      coverageModels: bundle.coverageCatalogue.models.length,
      bindingsWithoutModels,
      selectedReleaseAssignments,
      representativeCases: suiteValidation.entry.memberCount,
      compiledProfiles: compiledProfiles.profiles.length,
    },
    profiles: compiledProfiles.profiles.map((profile) => ({
      profileId: profile.profileId,
      subjectId: profile.subjectId,
      capability: profile.capability,
      variant: profile.variant,
      resolvedFingerprint: profile.resolvedFingerprint,
      requiredChecks: profile.requiredChecks.map((check) => check.checkId),
      componentFingerprints: profile.componentFingerprints,
    })),
    referenceClosure: {
      resolved: !hasBlockingDiagnostic(referenceFindings),
      findings: referenceFindings,
    },
    composition: {
      satisfied: !hasBlockingDiagnostic(compiledProfiles.findings),
      findings: compiledProfiles.findings,
    },
    compatibility: {
      satisfied: !hasBlockingDiagnostic(compatibilityFindings),
      findings: compatibilityFindings,
    },
    deliveredRouteCoverage: {
      selections: correctnessCatalogue.routeSelections.length,
      compiled: compiledProfiles.profiles.length,
      missingProfiles,
    },
    unavailableBindings: ledger.filter((entry) => entry.state !== 'compiled-profile'),
    ledgerCounts: {
      compiledProfile: ledger.filter((entry) => entry.state === 'compiled-profile').length,
      coverageModelOnly: ledger.filter((entry) => entry.state === 'coverage-model-only').length,
      profileUnavailable: ledger.filter((entry) => entry.state === 'profile-unavailable').length,
    },
    completeness: {
      artifactPath: PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH,
      artifactSha256: completenessArtifactSha256,
      artifactBytes: completenessArtifactBytes,
      persisted: completenessPersisted,
      ledgerFingerprint: completenessResult.ledger.fingerprint,
      acceptedRepresentativeState: completenessResult.ledger.acceptedRepresentativeSuite.state,
      counts: completenessResult.ledger.counts,
      dimensions: completenessResult.ledger.dimensions,
      releaseCreditGranted: false,
      findings: completenessFindings,
    },
  };

  const correctnessBlocking = [
    ...referenceFindings.filter((finding) => finding.severity === 'blocking'),
    ...compatibilityFindings.filter((finding) => finding.severity === 'blocking'),
    ...compiledProfiles.findings.filter((finding) => finding.severity === 'blocking'),
    ...completenessFindings.filter((finding) => finding.severity === 'blocking'),
  ];

  const blockingDiagnostics = [
    ...coverageFindings.filter((finding) => finding.severity === 'blocking'),
    ...reconciliation.findings.filter((finding) => finding.severity === 'blocking'),
    ...diagnostics,
    ...suiteValidation.findings.filter((finding) => finding.severity === 'blocking'),
    ...correctnessBlocking,
  ];

  const passed =
    !hasBlockingDiagnostic(coverageFindings) &&
    reconciliation.status === 'READY' &&
    branchCheck.passed &&
    environmentCells.length > 0 &&
    suiteValidation.entry.status === 'valid' &&
    !hasBlockingDiagnostic(diagnostics) &&
    correctnessBlocking.length === 0 &&
    correctnessDetails.deliveredRouteCoverage.missingProfiles.length === 0;

  const details: ValidateAllDetails = {
    launchAttempted: false,
    catalogues: {
      subjectCatalogueSchemaVersion: bundle.subjectCatalogue.schemaVersion,
      applicationInventoryFingerprint: reconciliation.applicationInventoryFingerprint,
      operationCatalogueFingerprint: reconciliation.operationCatalogueFingerprint,
      adapterCatalogueFingerprint: reconciliation.adapterCatalogueFingerprint,
      workflowCatalogueFingerprint: reconciliation.workflowCatalogueFingerprint,
    },
    counts: {
      declarations: bundle.subjectCatalogue.declarations.length,
      resolvedSubjects: reconciliation.resolvedSubjects.length,
      applicationKinds: bundle.applicationInventory.kinds.length,
      operations: bundle.operationCatalogue.operations.length,
      adapters: bundle.adapterCatalogue.adapters.length,
      workflows: bundle.workflowCatalogue.workflows.length,
      coverageModels: bundle.coverageCatalogue.models.length,
      environmentCells: environmentCells.length,
      suiteMembers: suiteValidation.entry.memberCount,
    },
    suites: { representative: suiteValidation.entry },
    registry: {
      status: reconciliation.status,
      coverageStatus: reconciliation.coverageStatus,
      registryFingerprint: reconciliation.registryFingerprint,
      findings: reconciliation.findings,
    },
    coverage: { models, findings: coverageFindings },
    environments: { cells: environmentCells },
    branchAudit: {
      passed: branchCheck.passed,
      engineFiles: branchCheck.engineFiles.length,
      tokenCount: branchCheck.tokenCount,
      violations: branchCheck.violations,
    },
    correctness: correctnessDetails,
    blockingDiagnostics,
  };

  return buildCliResult<ValidateAllDetails>({
    command: 'validate',
    subcommand: 'all',
    status: passed ? 'PASS' : 'HARNESS_BLOCKED',
    detail: passed
      ? `Validated ${details.counts.declarations} declarations, ${details.correctness.counts.declaredBindings} declared binding(s) (${details.correctness.counts.coverageModels} Coverage Model(s), ${details.correctness.counts.bindingsWithoutModels} without models, ${details.correctness.counts.selectedReleaseAssignments} selected Release assignment(s)), ${details.correctness.counts.compiledProfiles} compiled correctness profile(s), and the ${details.suites.representative.memberCount}-member representative suite; branch audit passed over ${details.branchAudit.engineFiles} engine files.`
      : `Validation failed with ${blockingDiagnostics.length} blocking diagnostic(s).`,
    details,
    diagnostics: blockingDiagnostics,
  });
}
