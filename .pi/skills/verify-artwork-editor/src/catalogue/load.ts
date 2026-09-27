import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type {
  AdapterCatalogue,
  AdapterCatalogueEntry,
  AdapterDeclaration,
  ApplicationInventory,
  ApprovedOperation,
  ApprovedOperationCatalogue,
  CapabilityBinding,
  FamilyDefault,
  SubjectCatalogue,
  SubjectDeclaration,
  WorkflowCatalogue,
  WorkflowCatalogueEntry,
} from '../contracts/catalogues';
import {
  isCapability,
  isSubjectFamily,
  isSubjectId,
  isSubjectOrigin,
} from '../contracts/discriminants';
import type { CoverageModelCatalogue } from '../contracts/coverage';
import type { BindingFixtureCatalogue } from '../contracts/fixtures';
import type { CorrectnessCatalogue } from '../contracts/correctness';
import type { WorkflowStepCatalogue } from '../contracts/workflows';
import { parseBindingFixtureCatalogue } from './fixtures';
import { loadCorrectnessCatalogue } from './correctness';
import { parseWorkflowStepCatalogue } from '../workflows/steps';
import { parseCoverageModelCatalogue } from '../coverage/load';
import {
  ADAPTER_CATALOGUE_SCHEMA_VERSION,
  APPLICATION_INVENTORY_SCHEMA_VERSION,
  APPROVED_OPERATION_CATALOGUE_SCHEMA_VERSION,
  SUBJECT_CATALOGUE_SCHEMA_VERSION,
  WORKFLOW_CATALOGUE_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * Versioned catalogue loading and structural parsing (specification 6).
 *
 * The verification-owned catalogues are read data: this module validates them,
 * normalizes authoring order that carries no meaning, and fails closed on any
 * unsupported schema version, malformed declaration, duplicate executable
 * discriminant, or unknown Capability. Semantic reconciliation (relationships,
 * application bindings, adapter compatibility) belongs to `registry/`.
 */

export type CatalogueLoadErrorCode =
  | 'ADAPTER_CATALOGUE_DUPLICATE'
  | 'APPLICATION_INVENTORY_DUPLICATE'
  | 'CATALOGUE_FILE_MISSING'
  | 'CATALOGUE_FILE_UNREADABLE'
  | 'CATALOGUE_JSON_INVALID'
  | 'CATALOGUE_SCHEMA_UNSUPPORTED'
  | 'CATALOGUE_SHAPE_INVALID'
  | 'OPERATION_DISCRIMINANT_DUPLICATE'
  | 'OPERATION_UNKNOWN_CAPABILITY'
  | 'WORKFLOW_CATALOGUE_DUPLICATE'
  | 'WORKFLOW_UNKNOWN_CAPABILITY';

export class CatalogueLoadError extends Error {
  readonly code: CatalogueLoadErrorCode;

  constructor(code: CatalogueLoadErrorCode, message: string) {
    super(message);
    this.name = 'CatalogueLoadError';
    this.code = code;
  }
}

export interface CatalogueBundle {
  subjectCatalogue: SubjectCatalogue;
  applicationInventory: ApplicationInventory;
  operationCatalogue: ApprovedOperationCatalogue;
  adapterCatalogue: AdapterCatalogue;
  workflowCatalogue: WorkflowCatalogue;
  /** Declarative workflow steps (v2); the v1 executable identity catalogue stays intact. */
  workflowStepCatalogue: WorkflowStepCatalogue;
  coverageCatalogue: CoverageModelCatalogue;
  fixtureCatalogue: BindingFixtureCatalogue;
  /** Package 7 Slice A strict correctness catalogue (ADR 0023). */
  correctnessCatalogue: CorrectnessCatalogue;
}

export const CATALOGUE_FILES = {
  subjectCatalogue: 'catalogues/subjects/verification-subjects.v1.json',
  applicationInventory: 'catalogues/subjects/application-inventory.v1.json',
  operationCatalogue: 'catalogues/operations/approved-operations.v1.json',
  adapterCatalogue: 'catalogues/adapters/approved-adapters.v1.json',
  workflowCatalogue: 'catalogues/workflows/approved-workflows.v1.json',
  resourceManifest: 'fixtures/resources/manifest.json',
  workflowStepCatalogue: 'catalogues/workflows/approved-workflows.v4.json',
  coverageCatalogue: 'catalogues/coverage/binding-coverage-models.v1.json',
  fixtureCatalogue: 'catalogues/fixtures/binding-fixtures.v2.json',
} as const;

const SKILL_ROOT_RELATIVE_PATH = path.join('.pi', 'skills', 'verify-artwork-editor');

/**
 * Resolves the toolkit root independently of the test environment.
 *
 * Under Node ESM (the production CLI) the module URL is a file URL and the
 * toolkit is resolved relative to this module. Under a browser-like test
 * environment the module URL is not a file URL, so the repository-relative
 * toolkit path is used instead. `LoadCatalogueOptions.rootDir` overrides both.
 */
function resolveSkillRoot(): string {
  const moduleUrl = import.meta.url;
  if (typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')) {
    return fileURLToPath(new URL('../../', moduleUrl));
  }
  return path.resolve(process.cwd(), SKILL_ROOT_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: CatalogueLoadErrorCode, message: string): never {
  throw new CatalogueLoadError(code, message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('CATALOGUE_SHAPE_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    fail('CATALOGUE_SHAPE_INVALID', `${label} must be an array of strings`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function parseAdapter(value: unknown, label: string): AdapterDeclaration {
  if (!isRecord(value)) fail('CATALOGUE_SHAPE_INVALID', `${label} must be an adapter object`);
  const adapterId = requireString(value.adapterId, `${label}.adapterId`);
  const compatibilityVersion = value.compatibilityVersion;
  if (typeof compatibilityVersion !== 'number' || !Number.isInteger(compatibilityVersion)) {
    fail('CATALOGUE_SHAPE_INVALID', `${label}.compatibilityVersion must be an integer`);
  }
  return { adapterId, compatibilityVersion };
}

function parseBinding(value: unknown, label: string): CapabilityBinding {
  if (!isRecord(value)) fail('CATALOGUE_SHAPE_INVALID', `${label} must be a binding object`);
  if (!isCapability(value.capability)) {
    fail('CATALOGUE_SHAPE_INVALID', `${label}.capability is not a declared Capability`);
  }
  const workflowId = requireString(value.workflowId, `${label}.workflowId`);
  if (typeof value.variantIndependent !== 'boolean') {
    fail('CATALOGUE_SHAPE_INVALID', `${label}.variantIndependent must be a boolean`);
  }
  return {
    capability: value.capability,
    workflowId,
    variantIndependent: value.variantIndependent,
    checks: sortedUnique(requireStringArray(value.checks, `${label}.checks`)),
  };
}

function parseDeclaration(value: unknown, index: number): SubjectDeclaration {
  const label = `declarations[${index}]`;
  if (!isRecord(value)) fail('CATALOGUE_SHAPE_INVALID', `${label} must be a declaration object`);

  const subjectId = requireString(value.subjectId, `${label}.subjectId`);
  if (!isSubjectId(subjectId)) {
    fail(
      'CATALOGUE_SHAPE_INVALID',
      `${label}.subjectId must be an immutable lowercase slash-namespaced identity: "${subjectId}"`,
    );
  }
  if (!isSubjectFamily(value.family)) {
    fail('CATALOGUE_SHAPE_INVALID', `${label}.family is not a declared Subject family`);
  }
  if (!isSubjectOrigin(value.origin)) {
    fail('CATALOGUE_SHAPE_INVALID', `${label}.origin is not a declared Subject origin`);
  }

  const applicationKind = value.applicationKind;
  if (applicationKind !== null && typeof applicationKind !== 'string') {
    fail('CATALOGUE_SHAPE_INVALID', `${label}.applicationKind must be a string or null`);
  }

  const adapter = value.adapter === null ? null : parseAdapter(value.adapter, label);

  const relationships = (key: 'allowedParents' | 'allowedReferences' | 'allowedChildren') => {
    const entry = value[key];
    if (entry === null) return null;
    return sortedUnique(requireStringArray(entry, `${label}.${key}`));
  };

  if (!Array.isArray(value.capabilityBindings)) {
    fail('CATALOGUE_SHAPE_INVALID', `${label}.capabilityBindings must be an array`);
  }

  return {
    subjectId,
    label: requireString(value.label, `${label}.label`),
    family: value.family,
    origin: value.origin,
    applicationKind: applicationKind ?? null,
    variants: sortedUnique(requireStringArray(value.variants, `${label}.variants`)),
    adapter,
    allowedParents: relationships('allowedParents'),
    allowedReferences: relationships('allowedReferences'),
    allowedChildren: relationships('allowedChildren'),
    capabilityBindings: value.capabilityBindings
      .map((binding, bindingIndex) =>
        parseBinding(binding, `${label}.capabilityBindings[${bindingIndex}]`),
      )
      .sort((left, right) => (left.capability < right.capability ? -1 : 1)),
  };
}

function parseFamilyDefaults(value: unknown): SubjectCatalogue['familyDefaults'] {
  if (!isRecord(value)) {
    fail('CATALOGUE_SHAPE_INVALID', 'familyDefaults must be an object');
  }

  const defaults: SubjectCatalogue['familyDefaults'] = {};
  for (const [family, rawDefault] of Object.entries(value)) {
    if (!isSubjectFamily(family)) {
      fail('CATALOGUE_SHAPE_INVALID', `familyDefaults declares unknown family "${family}"`);
    }
    if (!isRecord(rawDefault)) {
      fail('CATALOGUE_SHAPE_INVALID', `familyDefaults.${family} must be an object`);
    }
    if (typeof rawDefault.version !== 'number' || !Number.isInteger(rawDefault.version)) {
      fail('CATALOGUE_SHAPE_INVALID', `familyDefaults.${family}.version must be an integer`);
    }
    const familyDefault: FamilyDefault = {
      version: rawDefault.version,
      adapter: parseAdapter(rawDefault.adapter, `familyDefaults.${family}`),
      allowedParents: sortedUnique(
        requireStringArray(rawDefault.allowedParents, `familyDefaults.${family}.allowedParents`),
      ),
      allowedReferences: sortedUnique(
        requireStringArray(
          rawDefault.allowedReferences,
          `familyDefaults.${family}.allowedReferences`,
        ),
      ),
      allowedChildren: sortedUnique(
        requireStringArray(rawDefault.allowedChildren, `familyDefaults.${family}.allowedChildren`),
      ),
    };
    defaults[family] = familyDefault;
  }
  return defaults;
}

export function parseSubjectCatalogue(raw: unknown): SubjectCatalogue {
  if (!isRecord(raw)) fail('CATALOGUE_SHAPE_INVALID', 'Subject catalogue must be an object');
  if (raw.schemaVersion !== SUBJECT_CATALOGUE_SCHEMA_VERSION) {
    fail(
      'CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported Subject catalogue schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.declarations)) {
    fail('CATALOGUE_SHAPE_INVALID', 'Subject catalogue declarations must be an array');
  }

  return {
    schemaVersion: raw.schemaVersion,
    familyDefaults: parseFamilyDefaults(raw.familyDefaults),
    declarations: raw.declarations.map(parseDeclaration),
  };
}

export function parseApplicationInventory(raw: unknown): ApplicationInventory {
  if (!isRecord(raw)) fail('CATALOGUE_SHAPE_INVALID', 'Application inventory must be an object');
  if (raw.schemaVersion !== APPLICATION_INVENTORY_SCHEMA_VERSION) {
    fail(
      'CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported application inventory schema version: ${String(raw.schemaVersion)}`,
    );
  }
  const source = requireString(raw.source, 'source');
  const kinds = requireStringArray(raw.kinds, 'kinds');
  if (kinds.length === 0) {
    fail('CATALOGUE_SHAPE_INVALID', 'Application inventory must declare at least one kind');
  }
  if (new Set(kinds).size !== kinds.length) {
    fail('APPLICATION_INVENTORY_DUPLICATE', 'Application inventory declares a duplicate kind');
  }

  return { schemaVersion: raw.schemaVersion, source, kinds: sortedUnique(kinds) };
}

export function parseOperationCatalogue(raw: unknown): ApprovedOperationCatalogue {
  if (!isRecord(raw)) {
    fail('CATALOGUE_SHAPE_INVALID', 'Approved-operation catalogue must be an object');
  }
  if (raw.schemaVersion !== APPROVED_OPERATION_CATALOGUE_SCHEMA_VERSION) {
    fail(
      'CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported approved-operation catalogue schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    fail('CATALOGUE_SHAPE_INVALID', 'Approved-operation catalogue must declare operations');
  }

  const operations: ApprovedOperation[] = raw.operations.map((entry, index) => {
    const label = `operations[${index}]`;
    if (!isRecord(entry)) fail('CATALOGUE_SHAPE_INVALID', `${label} must be an operation object`);
    const discriminant = requireString(entry.discriminant, `${label}.discriminant`);
    if (!isCapability(entry.capability)) {
      fail(
        'OPERATION_UNKNOWN_CAPABILITY',
        `${label}.capability "${String(entry.capability)}" is not a declared Capability`,
      );
    }
    return { discriminant, capability: entry.capability };
  });

  const discriminants = operations.map((operation) => operation.discriminant);
  if (new Set(discriminants).size !== discriminants.length) {
    fail(
      'OPERATION_DISCRIMINANT_DUPLICATE',
      'Approved-operation catalogue declares a duplicate discriminant',
    );
  }

  return {
    schemaVersion: raw.schemaVersion,
    operations: operations.sort((left, right) => (left.discriminant < right.discriminant ? -1 : 1)),
  };
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('CATALOGUE_SHAPE_INVALID', `${label} must be a positive integer`);
  }
  return value;
}

export function parseAdapterCatalogue(raw: unknown): AdapterCatalogue {
  if (!isRecord(raw)) fail('CATALOGUE_SHAPE_INVALID', 'Adapter catalogue must be an object');
  if (raw.schemaVersion !== ADAPTER_CATALOGUE_SCHEMA_VERSION) {
    fail(
      'CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported adapter catalogue schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.adapters) || raw.adapters.length === 0) {
    fail('CATALOGUE_SHAPE_INVALID', 'Adapter catalogue must declare at least one adapter');
  }

  const adapters: AdapterCatalogueEntry[] = raw.adapters.map((entry, index) => {
    const label = `adapters[${index}]`;
    if (!isRecord(entry)) fail('CATALOGUE_SHAPE_INVALID', `${label} must be an adapter object`);
    return {
      adapterId: requireString(entry.adapterId, `${label}.adapterId`),
      compatibilityVersion: requirePositiveInteger(
        entry.compatibilityVersion,
        `${label}.compatibilityVersion`,
      ),
    };
  });

  const adapterIds = adapters.map((entry) => entry.adapterId);
  if (new Set(adapterIds).size !== adapterIds.length) {
    fail('ADAPTER_CATALOGUE_DUPLICATE', 'Adapter catalogue declares a duplicate adapterId');
  }

  return {
    schemaVersion: raw.schemaVersion,
    adapters: adapters.sort((left, right) => (left.adapterId < right.adapterId ? -1 : 1)),
  };
}

export function parseWorkflowCatalogue(raw: unknown): WorkflowCatalogue {
  if (!isRecord(raw)) fail('CATALOGUE_SHAPE_INVALID', 'Workflow catalogue must be an object');
  if (raw.schemaVersion !== WORKFLOW_CATALOGUE_SCHEMA_VERSION) {
    fail(
      'CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported workflow catalogue schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.workflows) || raw.workflows.length === 0) {
    fail('CATALOGUE_SHAPE_INVALID', 'Workflow catalogue must declare at least one workflow');
  }

  const workflows: WorkflowCatalogueEntry[] = raw.workflows.map((entry, index) => {
    const label = `workflows[${index}]`;
    if (!isRecord(entry)) fail('CATALOGUE_SHAPE_INVALID', `${label} must be a workflow object`);
    if (!isCapability(entry.capability)) {
      fail(
        'WORKFLOW_UNKNOWN_CAPABILITY',
        `${label}.capability "${String(entry.capability)}" is not a declared Capability`,
      );
    }
    return {
      workflowId: requireString(entry.workflowId, `${label}.workflowId`),
      version: requirePositiveInteger(entry.version, `${label}.version`),
      capability: entry.capability,
    };
  });

  const workflowIds = workflows.map((entry) => entry.workflowId);
  if (new Set(workflowIds).size !== workflowIds.length) {
    fail('WORKFLOW_CATALOGUE_DUPLICATE', 'Workflow catalogue declares a duplicate workflowId');
  }

  return {
    schemaVersion: raw.schemaVersion,
    workflows: workflows.sort((left, right) => (left.workflowId < right.workflowId ? -1 : 1)),
  };
}

function readCatalogueFile(rootDir: string, relativePath: string): unknown {
  const absolutePath = path.join(rootDir, relativePath);
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch {
    fail('CATALOGUE_FILE_MISSING', `Catalogue file is unavailable: ${relativePath}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('CATALOGUE_JSON_INVALID', `Catalogue file is not valid JSON: ${relativePath}`);
  }
}

export interface LoadCatalogueOptions {
  /** Skill root containing `catalogues/`. Defaults to the verification toolkit root. */
  rootDir?: string;
}

/**
 * Loads, validates, and normalizes the three authoritative catalogues. The
 * result is a fresh deep copy, so a caller can never corrupt the parsed
 * defaults another attempt depends on.
 */
export function loadCatalogueBundle(options: LoadCatalogueOptions = {}): CatalogueBundle {
  const rootDir = options.rootDir ?? resolveSkillRoot();
  const bundle: CatalogueBundle = {
    subjectCatalogue: parseSubjectCatalogue(
      readCatalogueFile(rootDir, CATALOGUE_FILES.subjectCatalogue),
    ),
    applicationInventory: parseApplicationInventory(
      readCatalogueFile(rootDir, CATALOGUE_FILES.applicationInventory),
    ),
    operationCatalogue: parseOperationCatalogue(
      readCatalogueFile(rootDir, CATALOGUE_FILES.operationCatalogue),
    ),
    adapterCatalogue: parseAdapterCatalogue(
      readCatalogueFile(rootDir, CATALOGUE_FILES.adapterCatalogue),
    ),
    workflowCatalogue: parseWorkflowCatalogue(
      readCatalogueFile(rootDir, CATALOGUE_FILES.workflowCatalogue),
    ),
    workflowStepCatalogue: parseWorkflowStepCatalogue(
      readCatalogueFile(rootDir, CATALOGUE_FILES.workflowStepCatalogue),
    ),
    coverageCatalogue: parseCoverageModelCatalogue(
      readCatalogueFile(rootDir, CATALOGUE_FILES.coverageCatalogue),
    ),
    fixtureCatalogue: parseBindingFixtureCatalogue(
      readCatalogueFile(rootDir, CATALOGUE_FILES.fixtureCatalogue),
    ),
    correctnessCatalogue: loadCorrectnessCatalogue({ rootDir }),
  };
  return structuredClone(bundle);
}
