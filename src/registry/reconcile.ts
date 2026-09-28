import {
  deriveAdapterCatalogueFingerprint,
  deriveApplicationInventoryFingerprint,
  deriveOperationCatalogueFingerprint,
  deriveRegistryFingerprint,
  deriveUndeclaredAdapterCatalogueFingerprint,
  deriveUndeclaredOperationCatalogueFingerprint,
  deriveUndeclaredWorkflowCatalogueFingerprint,
  deriveWorkflowCatalogueFingerprint,
} from '../catalogue/fingerprint';
import { resolveSubjectDeclaration } from '../catalogue/resolve';
import type {
  AdapterCatalogue,
  ApplicationInventory,
  ApprovedOperationCatalogue,
  RegistryReconciliation,
  ResolvedSubject,
  SubjectCatalogue,
  WorkflowCatalogue,
} from '../contracts/catalogues';
import { hasBlockingDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import {
  duplicateSubjectIds,
  validateApplicationReconciliation,
  validateExecutableCatalogueReconciliation,
  validateResolvedRelationships,
  validateSubjectDeclarations,
} from './validate';

/**
 * Application-backed registry reconciliation (decision 0002, specification 6.1).
 *
 * Every decision is made from declarative declaration data. There is no
 * Subject-name, Subject-kind, family, or application-kind branch anywhere in
 * this module: adding a Subject, a family, or an application binding is a
 * catalogue data change only.
 */

export interface ReconcileRegistryInput {
  subjectCatalogue: SubjectCatalogue;
  applicationInventory: ApplicationInventory;
  /** When omitted, the returned fingerprint says so explicitly. */
  operationCatalogue?: ApprovedOperationCatalogue;
  /** Authoritative adapter catalogue; when omitted, adapters are not checked. */
  adapterCatalogue?: AdapterCatalogue;
  /** Authoritative workflow catalogue; when omitted, workflows are not checked. */
  workflowCatalogue?: WorkflowCatalogue;
}

export function reconcileRegistry(input: ReconcileRegistryInput): RegistryReconciliation {
  const {
    subjectCatalogue,
    applicationInventory,
    operationCatalogue,
    adapterCatalogue,
    workflowCatalogue,
  } = input;
  const findings: DiagnosticRecord[] = [];

  findings.push(...validateSubjectDeclarations(subjectCatalogue));
  findings.push(...validateApplicationReconciliation(subjectCatalogue, applicationInventory));

  const duplicateIds = duplicateSubjectIds(subjectCatalogue);
  const resolvedSubjects: ResolvedSubject[] = [];

  for (const declaration of subjectCatalogue.declarations) {
    if (duplicateIds.has(declaration.subjectId)) continue;
    const resolution = resolveSubjectDeclaration(declaration, subjectCatalogue);
    findings.push(...resolution.findings);
    if (resolution.subject) resolvedSubjects.push(resolution.subject);
  }

  resolvedSubjects.sort((left, right) => (left.subjectId < right.subjectId ? -1 : 1));
  findings.push(...validateResolvedRelationships(resolvedSubjects, subjectCatalogue));
  findings.push(
    ...validateExecutableCatalogueReconciliation(
      resolvedSubjects,
      adapterCatalogue,
      workflowCatalogue,
    ),
  );

  const coverageStatus = findings.some((finding) => finding.code === 'SUBJECT_REGISTRATION_MISSING')
    ? 'incomplete'
    : 'complete';

  return {
    schemaVersion: subjectCatalogue.schemaVersion,
    resolvedSubjects,
    findings,
    coverageStatus,
    status: hasBlockingDiagnostic(findings) ? 'HARNESS_BLOCKED' : 'READY',
    registryFingerprint: deriveRegistryFingerprint(subjectCatalogue, resolvedSubjects),
    applicationInventoryFingerprint: deriveApplicationInventoryFingerprint(applicationInventory),
    operationCatalogueFingerprint: operationCatalogue
      ? deriveOperationCatalogueFingerprint(operationCatalogue)
      : deriveUndeclaredOperationCatalogueFingerprint(),
    adapterCatalogueFingerprint: adapterCatalogue
      ? deriveAdapterCatalogueFingerprint(adapterCatalogue)
      : deriveUndeclaredAdapterCatalogueFingerprint(),
    workflowCatalogueFingerprint: workflowCatalogue
      ? deriveWorkflowCatalogueFingerprint(workflowCatalogue)
      : deriveUndeclaredWorkflowCatalogueFingerprint(),
  };
}
