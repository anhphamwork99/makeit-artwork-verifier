import type { CaseIntent, CaseRequest } from './case-model';
import type { CoverageSelection } from './coverage';
import type { EnvironmentCell } from './runtime';
import type { Capability } from './discriminants';
import type { DiagnosticCode } from './diagnostics';

export const EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION = 1 as const;

export type ValidatedEnvironmentCell = EnvironmentCell;

/** Repository-owned, stable scenario intent. Request policy fields are supplied by the generator. */
export interface ExecutableScenarioRequestTemplate {
  templateId: string;
  subjectId: string;
  capability: Capability;
  scenarioId: string;
  intent: CaseIntent;
}

export interface ExecutableManifestBindingSelection {
  subjectId: string;
  capability: string;
  modelFingerprint: string;
  selection: CoverageSelection;
}

export type ExecutableManifestExclusionCode =
  | 'MODEL_UNAVAILABLE'
  | 'NOT_RELEASE_ELIGIBLE'
  | 'SCENARIO_UNAVAILABLE'
  | 'NON_RELEASE_SCENARIO'
  | 'TEMPLATE_UNAVAILABLE'
  | 'SCENARIO_ASSIGNMENT_MISMATCH'
  | 'PLANNER_REFUSED'
  | 'ENVIRONMENT_OUT_OF_MATRIX';

export interface ExecutableManifestExclusion {
  subjectId: string;
  capability: string;
  caseKey: string | null;
  scenarioId: string | null;
  assignments: Readonly<Record<string, string>>;
  cellId: string;
  code: ExecutableManifestExclusionCode;
  plannerCodes: readonly string[];
}

export interface ExecutableManifestEntry {
  entryId: string;
  templateId: string;
  subjectId: string;
  capability: string;
  scenarioId: string;
  caseKey: string;
  obligationIds: readonly string[];
  cell: EnvironmentCell;
  request: CaseRequest;
  requestDigest: string;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  executionProfileIdentity: string;
}

export interface ExecutableManifestContentV1 {
  schemaVersion: typeof EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION;
  selectionPolicyVersion: string;
  coverageCatalogueFingerprint: string;
  requestTemplateCatalogueFingerprint: string;
  environmentCatalogueFingerprint: string;
  requiredCell: EnvironmentCell;
  registryGaps: readonly { code: DiagnosticCode; subjectId: string | null }[];
  bindings: readonly ExecutableManifestBindingSelection[];
  entries: readonly ExecutableManifestEntry[];
  exclusions: readonly ExecutableManifestExclusion[];
}

export interface ExecutableSelectionManifestDraftV1 {
  schemaVersion: typeof EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION;
  state: 'GENERATED_DRAFT';
  manifestId: string;
  contentFingerprint: string;
  content: ExecutableManifestContentV1;
}

export interface ExecutableManifestAccounting {
  selectedCaseCount: number;
  entryCount: number;
  exclusionCount: number;
  modelCount: number;
  requiredCellId: string | null;
  complete: boolean;
  bindings: readonly ExecutableManifestBindingSelection[];
  exclusions: readonly ExecutableManifestExclusion[];
  registryGaps: readonly { code: DiagnosticCode; subjectId: string | null }[];
}

export interface ExecutableManifestGeneratedResult {
  status: 'GENERATED_DRAFT';
  code: null;
  draft: ExecutableSelectionManifestDraftV1;
  accounting: ExecutableManifestAccounting;
  releaseCredit: false;
}

export interface ExecutableManifestBlockedResult {
  status: 'HARNESS_BLOCKED';
  code: 'NO_RUNNABLE_ENTRIES' | 'INVALID_INPUT';
  draft: null;
  accounting: ExecutableManifestAccounting;
  releaseCredit: false;
}

export type ExecutableManifestGenerationResult =
  | ExecutableManifestGeneratedResult
  | ExecutableManifestBlockedResult;

export interface ExecutableManifestValidationContext {
  catalogues: import('../catalogue/load').CatalogueBundle;
  requestTemplates: readonly ExecutableScenarioRequestTemplate[];
  environmentCatalogue: import('./runtime').EnvironmentCatalogue;
  requiredCell: ValidatedEnvironmentCell;
}

export interface ExecutableManifestValidationResult {
  status: 'VALID' | 'INVALID';
  valid: boolean;
  issues: readonly ('MALFORMED_INPUT' | 'CURRENT_SOURCE_DRIFT' | 'NO_RUNNABLE_ENTRIES')[];
  releaseCredit: false;
}
