import type {
  AdapterCatalogue,
  ApplicationInventory,
  ApprovedOperationCatalogue,
  ResolvedSubject,
  SubjectCatalogue,
  WorkflowCatalogue,
} from '../contracts/catalogues';
import type { BindingCoverageModel } from '../contracts/coverage';
import type { WorkflowStepCatalogue } from '../contracts/workflows';
import type { ResourceManifest } from '../contracts/resources';
import type { Capability } from '../contracts/discriminants';
import {
  ADAPTER_CATALOGUE_SCHEMA_VERSION,
  APPROVED_OPERATION_CATALOGUE_SCHEMA_VERSION,
  COVERAGE_MODEL_SCHEMA_VERSION,
  WORKFLOW_CATALOGUE_SCHEMA_VERSION,
} from '../contracts/schema-versions';
import { IDENTITY_DOMAINS, domainSeparatedDigest, identityDigest } from '../canonical/canonicalize';

/**
 * Catalogue and registry fingerprints (decision 0002 "Schema and
 * reproducibility").
 *
 * Every fingerprint is a full SHA-256 over a named, versioned,
 * domain-separated canonical serialization of already-resolved contracts, so
 * authoring order and other non-semantic serialization differences cannot move
 * a fingerprint while a semantic contract change always does.
 */

/** Fingerprint of the complete resolved Subject registry. */
export function deriveRegistryFingerprint(
  catalogue: SubjectCatalogue,
  resolvedSubjects: readonly ResolvedSubject[],
): string {
  return domainSeparatedDigest(IDENTITY_DOMAINS.subjectRegistry, catalogue.schemaVersion, {
    schemaVersion: catalogue.schemaVersion,
    familyDefaults: catalogue.familyDefaults,
    resolvedSubjects: [...resolvedSubjects],
  });
}

export function deriveApplicationInventoryFingerprint(inventory: ApplicationInventory): string {
  // Order carries no meaning for an inventory, so it is normalized here: any
  // caller path that reaches reconciliation produces the same fingerprint.
  return domainSeparatedDigest(IDENTITY_DOMAINS.applicationInventory, inventory.schemaVersion, {
    ...inventory,
    kinds: [...inventory.kinds].sort(),
  });
}

/**
 * Fingerprint of an approved-operation catalogue. Discriminant order carries no
 * meaning, so it is normalized before hashing.
 */
export function deriveOperationCatalogueFingerprint(catalogue: ApprovedOperationCatalogue): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.approvedOperationCatalogue,
    catalogue.schemaVersion,
    {
      ...catalogue,
      operations: [...catalogue.operations].sort((left, right) =>
        left.discriminant < right.discriminant ? -1 : 1,
      ),
    },
  );
}

/**
 * Fingerprint for a reconciliation that was not given an approved-operation
 * catalogue. It is explicit and domain-separated instead of being absent, so a
 * record never implies an operation vocabulary it did not check.
 */
export function deriveUndeclaredOperationCatalogueFingerprint(): string {
  return identityDigest(IDENTITY_DOMAINS.approvedOperationCatalogue, {
    declared: false,
    operationCatalogueSchemaVersion: APPROVED_OPERATION_CATALOGUE_SCHEMA_VERSION,
  });
}

/**
 * Fingerprint of the authoritative adapter catalogue. Adapter order carries no
 * meaning, so it is normalized before hashing; an adapter identity or
 * compatibility-version change always moves it.
 */
export function deriveAdapterCatalogueFingerprint(catalogue: AdapterCatalogue): string {
  return domainSeparatedDigest(IDENTITY_DOMAINS.adapterCatalogue, catalogue.schemaVersion, {
    ...catalogue,
    adapters: [...catalogue.adapters].sort((left, right) =>
      left.adapterId < right.adapterId ? -1 : 1,
    ),
  });
}

/**
 * Fingerprint of the authoritative workflow catalogue. Workflow order carries
 * no meaning, so it is normalized before hashing; a workflow identity, version,
 * or declared Capability change always moves it.
 */
export function deriveWorkflowCatalogueFingerprint(catalogue: WorkflowCatalogue): string {
  return domainSeparatedDigest(IDENTITY_DOMAINS.workflowCatalogue, catalogue.schemaVersion, {
    ...catalogue,
    workflows: [...catalogue.workflows].sort((left, right) =>
      left.workflowId < right.workflowId ? -1 : 1,
    ),
  });
}

/**
 * Fingerprints for a reconciliation that was not given an adapter/workflow
 * catalogue. They are explicit and domain-separated instead of being absent, so
 * a record never implies an executable vocabulary it did not check.
 */
export function deriveUndeclaredAdapterCatalogueFingerprint(): string {
  return identityDigest(IDENTITY_DOMAINS.adapterCatalogue, {
    declared: false,
    adapterCatalogueSchemaVersion: ADAPTER_CATALOGUE_SCHEMA_VERSION,
  });
}

export function deriveUndeclaredWorkflowCatalogueFingerprint(): string {
  return identityDigest(IDENTITY_DOMAINS.workflowCatalogue, {
    declared: false,
    workflowCatalogueSchemaVersion: WORKFLOW_CATALOGUE_SCHEMA_VERSION,
  });
}

/**
 * Fingerprint of one resolved binding Coverage Model. It is binding-scoped, so
 * a change to this binding's Factors, partitions, scenarios, constraints,
 * unsupported combinations, obligations, or residual policy always moves it
 * while an unrelated binding stays stable.
 */
export function deriveCoverageModelFingerprint(model: BindingCoverageModel): string {
  return identityDigest(IDENTITY_DOMAINS.coverageModel, model);
}

/**
 * Explicit fingerprint for a binding with no Coverage Model. It is
 * domain-separated and binding-scoped rather than absent: a missing model can
 * never be confused with a resolved one, and resolving a real model later
 * necessarily changes the fingerprint.
 */
export function deriveAbsentCoverageModelFingerprint(
  subjectId: string,
  capability: Capability,
): string {
  return identityDigest(IDENTITY_DOMAINS.coverageModel, {
    modelId: 'absent',
    subjectId,
    capability,
    coverageModelSchemaVersion: COVERAGE_MODEL_SCHEMA_VERSION,
  });
}

/**
 * Fingerprint of the resource manifest. Resource order carries no meaning, so it
 * is normalized before hashing; a logical id/version, filename, digest, byte
 * length, MIME, dimension, probe, provenance, or license change always moves it.
 */
export function deriveResourceManifestFingerprint(manifest: ResourceManifest): string {
  return domainSeparatedDigest(IDENTITY_DOMAINS.resourceManifest, manifest.schemaVersion, {
    ...manifest,
    resources: [...manifest.resources].sort((left, right) =>
      left.logicalId === right.logicalId
        ? left.version - right.version
        : left.logicalId < right.logicalId
          ? -1
          : 1,
    ),
  });
}

/**
 * Fingerprint of the declarative workflow-step catalogue (v2). Step order
 * within a workflow is execution order and therefore meaningful; workflow order
 * carries no meaning and is normalized. An added, removed, or reordered step, a
 * changed primitive, or a changed parameter binding always moves it.
 */
export function deriveWorkflowStepCatalogueFingerprint(catalogue: WorkflowStepCatalogue): string {
  return domainSeparatedDigest(IDENTITY_DOMAINS.workflowCatalogue, catalogue.schemaVersion, {
    ...catalogue,
    workflows: [...catalogue.workflows].sort((left, right) =>
      left.workflowId < right.workflowId ? -1 : 1,
    ),
  });
}
