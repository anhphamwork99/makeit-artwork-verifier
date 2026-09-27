import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import { deriveCoverageModelFingerprint } from '../catalogue/fingerprint';
import { parseCoverageModelCatalogue } from '../coverage/load';
import { validateCoverageCatalogue } from '../coverage/validate';
import {
  EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION,
  type ExecutableManifestAccounting,
  type ExecutableManifestBindingSelection,
  type ExecutableManifestContentV1,
  type ExecutableManifestEntry,
  type ExecutableManifestExclusion,
  type ExecutableManifestGenerationResult,
  type ExecutableManifestValidationContext,
  type ExecutableManifestValidationResult,
  type ExecutableScenarioRequestTemplate,
  type ExecutableSelectionManifestDraftV1,
} from '../contracts/executable-selection-manifest';
import type { CaseRequest } from '../contracts/case-model';
import type { BindingCoverageModel } from '../contracts/coverage';
import type { EnvironmentCatalogue, EnvironmentCell } from '../contracts/runtime';
import { resolveBindingCoverage, resolveCaseCoverage } from '../coverage/resolve';
import { COVERAGE_SELECTION_POLICY_VERSION } from '../contracts/coverage';
import { selectCoverage } from '../coverage/select';
import { CASE_REQUEST_SCHEMA_VERSION } from '../contracts/schema-versions';
import { isCapability, isSubjectId } from '../contracts/discriminants';
import {
  deriveGovernanceIdentity,
  GOVERNANCE_IDENTITY_DOMAINS,
} from '../canonical/governance-identity';
import { planCaseForExecution } from '../planner/plan-case';
import { reconcileRegistry } from '../registry/reconcile';
import { DEFAULT_ENVIRONMENT_CELL_ID, parseEnvironmentCatalogue } from '../runtime/environment';
import { ENVIRONMENT_CELL_CATALOGUE_SCHEMA_VERSION } from '../contracts/schema-versions';

const REQUIRED_POLICY = 'release' as const;
const REQUIRED_PROVENANCE = 'manifest' as const;
const REQUIRED_EVIDENCE_DEPTH = 'standard' as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b))) as T;
}

function cellFingerprint(cell: EnvironmentCell): string {
  return deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, {
    kind: 'environment-cell/v1',
    cell,
  });
}

function environmentCatalogueFingerprint(catalogue: EnvironmentCatalogue): string {
  return deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, {
    kind: 'environment-catalogue/v1',
    schemaVersion: catalogue.schemaVersion,
    cells: [...catalogue.cells].sort((a, b) => compareText(a.cellId, b.cellId)),
  });
}

function coverageCatalogueFingerprint(models: readonly BindingCoverageModel[]): string {
  const identities = models
    .map((model) => ({
      subjectId: model.subjectId,
      capability: model.capability,
      modelFingerprint: deriveCoverageModelFingerprint(model),
    }))
    .sort((a, b) =>
      compareText(`${a.subjectId}\0${a.capability}`, `${b.subjectId}\0${b.capability}`),
    );
  return deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, {
    kind: 'coverage-catalogue/v1',
    identities,
  });
}

function exactEnvironment(context: ExecutableManifestValidationContext): boolean {
  const rawCatalogue = context.environmentCatalogue as unknown;
  if (
    !isDataOnly(rawCatalogue, new Set()) ||
    !hasExactKeys(rawCatalogue, ['schemaVersion', 'cells'])
  )
    return false;
  const rawCells = (rawCatalogue as { cells?: unknown }).cells;
  if (
    !Array.isArray(rawCells) ||
    rawCells.some(
      (cell) =>
        !hasExactKeys(cell, [
          'cellId',
          'classification',
          'browserKind',
          'browserChannel',
          'playwrightVersion',
          'viewport',
          'deviceScaleFactor',
          'locale',
          'timezoneId',
          'colorScheme',
          'reducedMotion',
          'permissions',
          'geolocation',
          'storageState',
        ]),
    )
  )
    return false;
  if (
    rawCells.some((cell) => {
      const record = cell as Record<string, unknown>;
      return (
        !hasExactKeys(record.viewport, ['width', 'height']) ||
        (record.geolocation !== null &&
          !hasExactKeys(record.geolocation, ['latitude', 'longitude']))
      );
    })
  )
    return false;
  if (
    (rawCatalogue as { schemaVersion: number }).schemaVersion !==
    ENVIRONMENT_CELL_CATALOGUE_SCHEMA_VERSION
  )
    return false;
  let catalogue: EnvironmentCatalogue;
  try {
    catalogue = parseEnvironmentCatalogue(rawCatalogue);
  } catch {
    return false;
  }
  const rawRequired = context.requiredCell as unknown;
  if (
    !isDataOnly(rawRequired, new Set()) ||
    !hasExactKeys(rawRequired, [
      'cellId',
      'classification',
      'browserKind',
      'browserChannel',
      'playwrightVersion',
      'viewport',
      'deviceScaleFactor',
      'locale',
      'timezoneId',
      'colorScheme',
      'reducedMotion',
      'permissions',
      'geolocation',
      'storageState',
    ])
  )
    return false;
  if (
    !hasExactKeys((rawRequired as EnvironmentCell).viewport, ['width', 'height']) ||
    ((rawRequired as EnvironmentCell).geolocation !== null &&
      !hasExactKeys((rawRequired as EnvironmentCell).geolocation, ['latitude', 'longitude']))
  )
    return false;
  const matches = catalogue.cells.filter((cell) => cell.cellId === context.requiredCell.cellId);
  const required = catalogue.cells.filter((cell) => cell.classification === 'required-credit');
  if (
    catalogue.schemaVersion !== ENVIRONMENT_CELL_CATALOGUE_SCHEMA_VERSION ||
    matches.length !== 1 ||
    required.length !== 1 ||
    context.requiredCell.cellId !== DEFAULT_ENVIRONMENT_CELL_ID ||
    context.requiredCell.browserKind !== 'chromium' ||
    required[0]?.cellId !== context.requiredCell.cellId ||
    context.requiredCell.classification !== 'required-credit'
  )
    return false;
  return canonicalize(matches[0]) === canonicalize(context.requiredCell);
}

function validateTemplates(templates: readonly ExecutableScenarioRequestTemplate[]): boolean {
  if (!Array.isArray(templates)) return false;
  if (!isDataOnly(templates, new Set())) return false;
  const ids = new Set<string>();
  const triples = new Set<string>();
  for (const template of templates) {
    if (
      !template ||
      typeof template !== 'object' ||
      typeof template.templateId !== 'string' ||
      typeof template.subjectId !== 'string' ||
      typeof template.capability !== 'string' ||
      typeof template.scenarioId !== 'string' ||
      !template.intent ||
      typeof template.intent !== 'object'
    )
      return false;
    if (!hasExactKeys(template, ['templateId', 'subjectId', 'capability', 'scenarioId', 'intent']))
      return false;
    const triple = `${template.subjectId}\0${template.capability}\0${template.scenarioId}`;
    if (
      !template.templateId ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(template.templateId) ||
      !isSubjectId(template.subjectId) ||
      !isCapability(template.capability) ||
      !template.scenarioId ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(template.scenarioId) ||
      ids.has(template.templateId) ||
      triples.has(triple)
    )
      return false;
    const intent = template.intent as unknown;
    if (
      !hasExactKeys(intent, [
        'subjectId',
        'capability',
        'variant',
        'scenario',
        'preState',
        'operations',
        'expected',
        'resources',
      ]) ||
      !Array.isArray((intent as Record<string, unknown>).operations) ||
      !Array.isArray((intent as Record<string, unknown>).resources) ||
      (intent as Record<string, unknown>).subjectId !== template.subjectId ||
      (intent as Record<string, unknown>).capability !== template.capability ||
      (intent as Record<string, unknown>).scenario !== template.scenarioId
    )
      return false;
    if (
      ((intent as Record<string, unknown>).operations as unknown[]).some(
        (operation) => !hasExactKeys(operation, ['discriminant', 'parameters']),
      ) ||
      ((intent as Record<string, unknown>).resources as unknown[]).some(
        (resource) => !hasExactKeys(resource, ['resourceId', 'contentDigest']),
      )
    )
      return false;
    ids.add(template.templateId);
    triples.add(triple);
  }
  return true;
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function templateCatalogueFingerprint(
  templates: readonly ExecutableScenarioRequestTemplate[],
): string {
  const ordered = [...templates].sort((left, right) =>
    compareText(left.templateId, right.templateId),
  );
  return deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, {
    kind: 'request-template-catalogue/v1',
    templates: ordered,
  });
}

function emptyAccounting(): ExecutableManifestAccounting {
  return {
    selectedCaseCount: 0,
    entryCount: 0,
    exclusionCount: 0,
    modelCount: 0,
    requiredCellId: null,
    complete: false,
    bindings: [],
    exclusions: [],
    registryGaps: [],
  };
}

function exclusion(
  input: Omit<ExecutableManifestExclusion, 'plannerCodes'> & { plannerCodes?: readonly string[] },
): ExecutableManifestExclusion {
  return { ...input, plannerCodes: [...(input.plannerCodes ?? [])].sort(compareText) };
}

function buildDraft(context: ExecutableManifestValidationContext): {
  draft: ExecutableSelectionManifestDraftV1 | null;
  accounting: ExecutableManifestAccounting;
} {
  const { catalogues, requestTemplates, requiredCell } = context;
  if (!exactEnvironment(context) || !validateTemplates(requestTemplates)) {
    return {
      draft: null,
      accounting: emptyAccounting(),
    };
  }
  const parsedCoverage = parseCoverageModelCatalogue(catalogues.coverageCatalogue);
  if (
    validateCoverageCatalogue(parsedCoverage).some((finding) => finding.severity === 'blocking')
  ) {
    return { draft: null, accounting: emptyAccounting() };
  }
  const currentCatalogues = { ...catalogues, coverageCatalogue: parsedCoverage };
  const models = [...parsedCoverage.models].sort((a, b) =>
    compareText(`${a.subjectId}\0${a.capability}`, `${b.subjectId}\0${b.capability}`),
  );
  const entries: ExecutableManifestEntry[] = [];
  const exclusions: ExecutableManifestExclusion[] = [];
  const bindings: ExecutableManifestBindingSelection[] = [];
  const registry = reconcileRegistry({
    subjectCatalogue: currentCatalogues.subjectCatalogue,
    applicationInventory: currentCatalogues.applicationInventory,
    operationCatalogue: currentCatalogues.operationCatalogue,
    adapterCatalogue: currentCatalogues.adapterCatalogue,
    workflowCatalogue: currentCatalogues.workflowCatalogue,
  });
  const registryGaps = registry.findings
    .map((finding) => ({ code: finding.code, subjectId: finding.subjectId ?? null }))
    .sort((a, b) =>
      compareText(`${a.code}\0${a.subjectId ?? ''}`, `${b.code}\0${b.subjectId ?? ''}`),
    );
  let selectedCaseCount = 0;

  for (const model of models) {
    const resolved = resolveBindingCoverage({
      catalogue: currentCatalogues.coverageCatalogue,
      subjectId: model.subjectId,
      capability: model.capability,
    });
    if (resolved.status !== 'resolved') {
      exclusions.push(
        exclusion({
          subjectId: model.subjectId,
          capability: model.capability,
          caseKey: null,
          scenarioId: null,
          assignments: {},
          cellId: requiredCell.cellId,
          code: 'MODEL_UNAVAILABLE',
        }),
      );
      continue;
    }
    const selection = selectCoverage({
      model: resolved.model,
      modelFingerprint: resolved.modelFingerprint,
      profile: REQUIRED_POLICY,
    });
    bindings.push({
      subjectId: model.subjectId,
      capability: model.capability,
      modelFingerprint: resolved.modelFingerprint,
      selection,
    });
    selectedCaseCount += selection.cases.length;
    for (const selected of selection.cases) {
      const shared = {
        subjectId: model.subjectId,
        capability: model.capability,
        caseKey: selected.caseKey,
        scenarioId: selected.scenarioId,
        assignments: stableObject({ ...selected.assignments }),
        cellId: requiredCell.cellId,
      };
      if (!selected.releaseEligible) {
        exclusions.push(exclusion({ ...shared, code: 'NOT_RELEASE_ELIGIBLE' }));
        continue;
      }
      if (selected.scenarioId === null) {
        exclusions.push(exclusion({ ...shared, code: 'SCENARIO_UNAVAILABLE' }));
        continue;
      }
      const scenario = resolved.model.scenarios.find(
        (candidate) => candidate.id === selected.scenarioId,
      );
      if (!scenario) {
        exclusions.push(exclusion({ ...shared, code: 'SCENARIO_UNAVAILABLE' }));
        continue;
      }
      if (scenario.eligibility !== 'release-required') {
        exclusions.push(exclusion({ ...shared, code: 'NON_RELEASE_SCENARIO' }));
        continue;
      }
      const template = requestTemplates.find(
        (candidate) =>
          candidate.subjectId === model.subjectId &&
          candidate.capability === model.capability &&
          candidate.scenarioId === scenario.id,
      );
      if (!template) {
        exclusions.push(exclusion({ ...shared, code: 'TEMPLATE_UNAVAILABLE' }));
        continue;
      }
      if (
        template.intent.subjectId !== model.subjectId ||
        template.intent.capability !== model.capability
      ) {
        exclusions.push(exclusion({ ...shared, code: 'SCENARIO_ASSIGNMENT_MISMATCH' }));
        continue;
      }
      const coverage = resolveCaseCoverage({
        model: resolved.model,
        intent: template.intent,
        profile: REQUIRED_POLICY,
        provenance: REQUIRED_PROVENANCE,
      });
      if (
        !coverage.ok ||
        coverage.coverage.scenario.id !== scenario.id ||
        coverage.coverage.diagnosticOverride ||
        canonicalize(stableObject({ ...coverage.coverage.assignments })) !==
          canonicalize(stableObject({ ...selected.assignments }))
      ) {
        exclusions.push(exclusion({ ...shared, code: 'SCENARIO_ASSIGNMENT_MISMATCH' }));
        continue;
      }
      const request: CaseRequest = {
        schemaVersion: CASE_REQUEST_SCHEMA_VERSION,
        profile: REQUIRED_POLICY,
        provenance: REQUIRED_PROVENANCE,
        evidenceDepth: REQUIRED_EVIDENCE_DEPTH,
        intent: template.intent,
      };
      let planned: ReturnType<typeof planCaseForExecution>;
      try {
        planned = planCaseForExecution(request, { catalogues: currentCatalogues });
      } catch {
        exclusions.push(exclusion({ ...shared, code: 'PLANNER_REFUSED' }));
        continue;
      }
      if (planned.status !== 'PLANNED' || planned.envelope === null) {
        const plannerCodes = 'findings' in planned ? planned.findings.map((item) => item.code) : [];
        exclusions.push(exclusion({ ...shared, code: 'PLANNER_REFUSED', plannerCodes }));
        continue;
      }
      const requestDigest = sha256Hex(canonicalize(request));
      const entryId = deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, {
        kind: 'entry/v1',
        subjectId: model.subjectId,
        capability: model.capability,
        scenarioId: scenario.id,
        caseKey: selected.caseKey,
        cellId: requiredCell.cellId,
        requestDigest,
      });
      entries.push({
        entryId,
        templateId: template.templateId,
        subjectId: model.subjectId,
        capability: model.capability,
        scenarioId: scenario.id,
        caseKey: selected.caseKey,
        obligationIds: [...selected.obligationIds].sort(compareText),
        cell: requiredCell,
        request,
        requestDigest,
        caseId: planned.caseId,
        materializationFingerprint: planned.materializationFingerprint,
        planFingerprint: planned.planFingerprint,
        executionProfileIdentity: deriveGovernanceIdentity(
          GOVERNANCE_IDENTITY_DOMAINS.selectionManifest,
          {
            kind: 'execution-profile/v1',
            profile: request.profile,
            provenance: request.provenance,
            evidenceDepth: request.evidenceDepth,
            cellFingerprint: cellFingerprint(requiredCell),
          },
        ),
      });
    }
  }

  const outOfMatrixCells = context.environmentCatalogue.cells
    .filter((candidate) => candidate.cellId !== requiredCell.cellId)
    .sort((left, right) => compareText(left.cellId, right.cellId));
  for (const cell of outOfMatrixCells) {
    exclusions.push(
      exclusion({
        subjectId: '*',
        capability: '*',
        caseKey: null,
        scenarioId: null,
        assignments: {},
        cellId: cell.cellId,
        code: 'ENVIRONMENT_OUT_OF_MATRIX',
      }),
    );
  }
  const content: ExecutableManifestContentV1 = {
    schemaVersion: EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION,
    selectionPolicyVersion: COVERAGE_SELECTION_POLICY_VERSION,
    coverageCatalogueFingerprint: coverageCatalogueFingerprint(models),
    requestTemplateCatalogueFingerprint: templateCatalogueFingerprint(requestTemplates),
    environmentCatalogueFingerprint: environmentCatalogueFingerprint(context.environmentCatalogue),
    requiredCell,
    registryGaps,
    bindings,
    entries,
    exclusions,
  };
  const contentFingerprint = deriveGovernanceIdentity(
    GOVERNANCE_IDENTITY_DOMAINS.selectionManifest,
    {
      kind: 'executable-selection-manifest-content/v1',
      content,
    },
  );
  const manifestId = deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, {
    kind: 'executable-selection-manifest-id/v1',
    contentFingerprint,
  });
  const draft =
    entries.length === 0
      ? null
      : {
          schemaVersion: EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION,
          state: 'GENERATED_DRAFT' as const,
          manifestId,
          contentFingerprint,
          content,
        };
  const exclusionCount = exclusions.length;
  const accountedKeys = new Set<string>();
  for (const entry of entries) {
    accountedKeys.add(
      `${entry.subjectId}\0${entry.capability}\0${entry.caseKey}\0${entry.cell.cellId}`,
    );
  }
  for (const row of exclusions) {
    if (row.caseKey !== null)
      accountedKeys.add(`${row.subjectId}\0${row.capability}\0${row.caseKey}\0${row.cellId}`);
  }
  const complete =
    accountedKeys.size === selectedCaseCount &&
    entries.length + exclusions.filter((item) => item.caseKey !== null).length ===
      selectedCaseCount &&
    new Set(entries.map((entry) => entry.entryId)).size === entries.length;
  const accounting: ExecutableManifestAccounting = {
    selectedCaseCount,
    entryCount: entries.length,
    exclusionCount,
    modelCount: models.length,
    requiredCellId: requiredCell.cellId,
    complete,
    bindings,
    exclusions,
    registryGaps,
  };
  return { draft, accounting };
}

export function generateExecutableSelectionManifest(
  input: ExecutableManifestValidationContext,
): ExecutableManifestGenerationResult {
  try {
    const built = buildDraft(input);
    if (!built.accounting.complete || built.draft === null) {
      return {
        status: 'HARNESS_BLOCKED',
        code: built.accounting.complete ? 'NO_RUNNABLE_ENTRIES' : 'INVALID_INPUT',
        draft: null,
        accounting: built.accounting,
        releaseCredit: false,
      };
    }
    return {
      status: 'GENERATED_DRAFT',
      code: null,
      draft: built.draft,
      accounting: built.accounting,
      releaseCredit: false,
    };
  } catch {
    return {
      status: 'HARNESS_BLOCKED',
      code: 'INVALID_INPUT',
      draft: null,
      accounting: {
        ...emptyAccounting(),
      },
      releaseCredit: false,
    };
  }
}

function isDataOnly(value: unknown, seen: Set<object>): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return true;
  if (typeof value !== 'object' || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return false;
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const ok =
      keys.every((key) => {
        if (key === 'length') return true;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor?.enumerable &&
          descriptor.get === undefined &&
          descriptor.set === undefined &&
          isDataOnly(descriptor.value, seen)
        );
      }) && Object.keys(value).length === (value as unknown[]).length;
    seen.delete(value);
    return ok;
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const ok = Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable &&
      descriptor.get === undefined &&
      descriptor.set === undefined &&
      isDataOnly(descriptor.value, seen)
    );
  });
  seen.delete(value);
  return ok;
}

export function validateExecutableSelectionManifest(
  input: unknown,
  current: ExecutableManifestValidationContext,
): ExecutableManifestValidationResult {
  const invalid = (
    issue: ExecutableManifestValidationResult['issues'][number],
  ): ExecutableManifestValidationResult => ({
    status: 'INVALID',
    valid: false,
    issues: [issue],
    releaseCredit: false,
  });
  try {
    if (!isDataOnly(input, new Set())) return invalid('MALFORMED_INPUT');
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return invalid('MALFORMED_INPUT');
    const candidate = input as Partial<ExecutableSelectionManifestDraftV1>;
    if (
      candidate.schemaVersion !== EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION ||
      candidate.state !== 'GENERATED_DRAFT' ||
      typeof candidate.manifestId !== 'string' ||
      typeof candidate.contentFingerprint !== 'string' ||
      !candidate.content
    ) {
      return invalid('MALFORMED_INPUT');
    }
    const rebuilt = buildDraft(current);
    if (!rebuilt.accounting.complete || !rebuilt.draft) return invalid('NO_RUNNABLE_ENTRIES');
    if (canonicalize(candidate) !== canonicalize(rebuilt.draft))
      return invalid('CURRENT_SOURCE_DRIFT');
    return { status: 'VALID', valid: true, issues: [], releaseCredit: false };
  } catch {
    return invalid('MALFORMED_INPUT');
  }
}
