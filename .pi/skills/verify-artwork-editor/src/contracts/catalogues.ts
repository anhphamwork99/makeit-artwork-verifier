import type { DiagnosticRecord } from './diagnostics';
import type {
  Capability,
  CoverageStatus,
  RegistryStatus,
  SubjectFamily,
  SubjectOrigin,
} from './discriminants';

/**
 * Authoring catalogue contracts (decision 0002 / 0003).
 *
 * Documents are authored data and therefore structurally mutable; every
 * *resolved* contract is immutable and complete, because no runtime behaviour
 * may depend on an omitted field meaning an implicit default.
 */

export interface AdapterDeclaration {
  adapterId: string;
  compatibilityVersion: number;
}

export interface CapabilityBinding {
  capability: Capability;
  workflowId: string;
  /**
   * True only when the Subject's selected adapter declares this binding
   * variant-independent (decision 0003). When false, an undeclared runtime
   * variant blocks execution instead of warning.
   */
  variantIndependent: boolean;
  /** Required authoritative checks compiled into the plan for this binding. */
  checks: string[];
}

export interface SubjectDeclaration {
  subjectId: string;
  label: string;
  family: SubjectFamily;
  origin: SubjectOrigin;
  /** Exact application registry key, or `null` for verification-native Subjects. */
  applicationKind: string | null;
  variants: string[];
  /** Explicit adapter override, or `null` to inherit the family default. */
  adapter: AdapterDeclaration | null;
  /** Explicit relationship override, or `null` to inherit the family default. */
  allowedParents: string[] | null;
  allowedReferences: string[] | null;
  allowedChildren: string[] | null;
  capabilityBindings: CapabilityBinding[];
}

export interface FamilyDefault {
  version: number;
  adapter: AdapterDeclaration;
  allowedParents: string[];
  allowedReferences: string[];
  allowedChildren: string[];
}

export interface SubjectCatalogue {
  schemaVersion: number;
  familyDefaults: Partial<Record<SubjectFamily, FamilyDefault>>;
  declarations: SubjectDeclaration[];
}

/**
 * Declared application-kind inventory. `source` names the authoritative
 * application module the inventory was taken from
 * (`ARTWORK_LAYER_REGISTRY`); the foundation suite asserts equality with that
 * module so a newly shipped kind cannot silently stay invisible.
 */
export interface ApplicationInventory {
  schemaVersion: number;
  source: string;
  kinds: string[];
}

export interface ApprovedOperation {
  discriminant: string;
  capability: Capability;
}

export interface ApprovedOperationCatalogue {
  schemaVersion: number;
  operations: ApprovedOperation[];
}

/**
 * Authoritative executable adapter identity. A Subject's resolved adapter
 * declaration must reference a declared adapter id at exactly its declared
 * compatibility version; unknown ids or version disagreements fail closed
 * before launch (decision 0003, specification 6.3).
 */
export interface AdapterCatalogueEntry {
  adapterId: string;
  compatibilityVersion: number;
}

export interface AdapterCatalogue {
  schemaVersion: number;
  adapters: AdapterCatalogueEntry[];
}

/**
 * Authoritative executable workflow identity. A Capability binding must
 * reference a declared workflow whose declared Capability matches the binding
 * (decision 0003, specification 6.4). The declared version participates in
 * materialization so an executable-contract revision is detectable.
 */
export interface WorkflowCatalogueEntry {
  workflowId: string;
  version: number;
  capability: Capability;
}

export interface WorkflowCatalogue {
  schemaVersion: number;
  workflows: WorkflowCatalogueEntry[];
}

/** Complete resolved Subject contract. */
export interface ResolvedSubject {
  subjectId: string;
  label: string;
  family: SubjectFamily;
  origin: SubjectOrigin;
  applicationKind: string | null;
  variants: readonly string[];
  allowedParents: readonly string[];
  allowedReferences: readonly string[];
  allowedChildren: readonly string[];
  adapter: AdapterDeclaration;
  adapterProvenance: 'family-default' | 'override';
  familyDefaultVersion: number;
  capabilityBindings: readonly CapabilityBinding[];
}

export interface RegistryReconciliation {
  schemaVersion: number;
  resolvedSubjects: readonly ResolvedSubject[];
  findings: readonly DiagnosticRecord[];
  coverageStatus: CoverageStatus;
  status: RegistryStatus;
  registryFingerprint: string;
  applicationInventoryFingerprint: string;
  operationCatalogueFingerprint: string;
  adapterCatalogueFingerprint: string;
  workflowCatalogueFingerprint: string;
}
