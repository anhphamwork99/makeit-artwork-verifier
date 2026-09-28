import type {
  AdapterCatalogue,
  ApplicationInventory,
  ResolvedSubject,
  SubjectCatalogue,
  WorkflowCatalogue,
} from '../contracts/catalogues';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';

/**
 * Blocking registry validation (decision 0002).
 *
 * The asymmetry is intentional and must not be weakened:
 *
 * - an application kind with no Verification Subject is a coverage omission and
 *   only ever produces a structured warning;
 * - a Subject pointing at a nonexistent application kind, a duplicated Subject
 *   identity, an ambiguous application binding, or a relationship naming an
 *   unknown Subject is an internally contradictory harness contract and is
 *   `HARNESS_BLOCKED`.
 */

export function validateSubjectDeclarations(catalogue: SubjectCatalogue): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  const declarationsBySubjectId = new Map<string, number>();

  for (const declaration of catalogue.declarations) {
    declarationsBySubjectId.set(
      declaration.subjectId,
      (declarationsBySubjectId.get(declaration.subjectId) ?? 0) + 1,
    );
  }

  for (const [subjectId, count] of declarationsBySubjectId) {
    if (count > 1) {
      findings.push(
        createDiagnostic('SUBJECT_DUPLICATE', `Subject identity is declared ${count} times`, {
          subjectId,
        }),
      );
    }
  }

  return findings;
}

export function duplicateSubjectIds(catalogue: SubjectCatalogue): Set<string> {
  const counts = new Map<string, number>();
  for (const declaration of catalogue.declarations) {
    counts.set(declaration.subjectId, (counts.get(declaration.subjectId) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([subjectId]) => subjectId),
  );
}

export function validateApplicationReconciliation(
  catalogue: SubjectCatalogue,
  inventory: ApplicationInventory,
): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  const declaredKinds = new Set(inventory.kinds);
  const declarationsByApplicationKind = new Map<string, string[]>();

  for (const declaration of catalogue.declarations) {
    if (declaration.origin !== 'application-backed' || declaration.applicationKind === null)
      continue;
    const bound = declarationsByApplicationKind.get(declaration.applicationKind) ?? [];
    bound.push(declaration.subjectId);
    declarationsByApplicationKind.set(declaration.applicationKind, bound);
  }

  for (const applicationKind of declaredKinds) {
    const bound = declarationsByApplicationKind.get(applicationKind) ?? [];
    if (bound.length === 0) {
      findings.push(
        createDiagnostic(
          'SUBJECT_REGISTRATION_MISSING',
          `Application kind has no Verification Subject registration`,
          { applicationKind },
        ),
      );
    } else if (bound.length > 1) {
      findings.push(
        createDiagnostic(
          'SUBJECT_REGISTRATION_AMBIGUOUS',
          `Application kind is bound by ${bound.length} Verification Subjects: ${[...bound].sort().join(', ')}`,
          { applicationKind },
        ),
      );
    }
  }

  for (const [applicationKind, subjectIds] of declarationsByApplicationKind) {
    if (declaredKinds.has(applicationKind)) continue;
    for (const subjectId of subjectIds) {
      findings.push(
        createDiagnostic(
          'SUBJECT_SOURCE_STALE',
          `Source binding "${applicationKind}" does not resolve to an application kind`,
          { subjectId, applicationKind },
        ),
      );
    }
  }

  return findings;
}

export function validateResolvedRelationships(
  resolvedSubjects: readonly ResolvedSubject[],
  catalogue: SubjectCatalogue,
): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  const knownSubjectIds = new Set(catalogue.declarations.map((entry) => entry.subjectId));

  for (const subject of resolvedSubjects) {
    const relationships = [
      ...subject.allowedParents,
      ...subject.allowedReferences,
      ...subject.allowedChildren,
    ];
    for (const relationship of relationships) {
      if (knownSubjectIds.has(relationship)) continue;
      findings.push(
        createDiagnostic(
          'SUBJECT_RELATIONSHIP_UNKNOWN',
          `Relationship references unknown Subject "${relationship}"`,
          { subjectId: subject.subjectId },
        ),
      );
    }
  }

  return findings;
}

/**
 * Reconciles every resolved Subject adapter and every Capability-binding
 * workflow against the authoritative executable catalogues (specification 6.3,
 * 6.4). An adapter id the catalogue does not declare, an adapter compatibility
 * version that disagrees with the catalogue, an undeclared workflow, or a
 * workflow whose declared Capability contradicts the binding are all internally
 * invalid harness contracts and fail closed before launch.
 */
export function validateExecutableCatalogueReconciliation(
  resolvedSubjects: readonly ResolvedSubject[],
  adapterCatalogue?: AdapterCatalogue,
  workflowCatalogue?: WorkflowCatalogue,
): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  const adaptersById = new Map(
    (adapterCatalogue?.adapters ?? []).map((entry) => [entry.adapterId, entry]),
  );
  const workflowsById = new Map(
    (workflowCatalogue?.workflows ?? []).map((entry) => [entry.workflowId, entry]),
  );

  for (const subject of resolvedSubjects) {
    if (adapterCatalogue) {
      const declaredAdapter = adaptersById.get(subject.adapter.adapterId);
      if (!declaredAdapter) {
        findings.push(
          createDiagnostic(
            'SUBJECT_ADAPTER_UNKNOWN',
            `Adapter "${subject.adapter.adapterId}" is not declared by the adapter catalogue`,
            { subjectId: subject.subjectId, context: { adapterId: subject.adapter.adapterId } },
          ),
        );
      } else if (declaredAdapter.compatibilityVersion !== subject.adapter.compatibilityVersion) {
        findings.push(
          createDiagnostic(
            'SUBJECT_ADAPTER_INCOMPATIBLE',
            `Adapter "${subject.adapter.adapterId}" declares compatibility v${subject.adapter.compatibilityVersion} but the adapter catalogue declares v${declaredAdapter.compatibilityVersion}`,
            { subjectId: subject.subjectId, context: { adapterId: subject.adapter.adapterId } },
          ),
        );
      }
    }

    if (!workflowCatalogue) continue;
    for (const binding of subject.capabilityBindings) {
      const declaredWorkflow = workflowsById.get(binding.workflowId);
      if (!declaredWorkflow) {
        findings.push(
          createDiagnostic(
            'SUBJECT_WORKFLOW_UNKNOWN',
            `Workflow "${binding.workflowId}" is not declared by the workflow catalogue`,
            {
              subjectId: subject.subjectId,
              context: { capability: binding.capability, workflowId: binding.workflowId },
            },
          ),
        );
      } else if (declaredWorkflow.capability !== binding.capability) {
        findings.push(
          createDiagnostic(
            'SUBJECT_WORKFLOW_CAPABILITY_MISMATCH',
            `Workflow "${binding.workflowId}" is declared for Capability "${declaredWorkflow.capability}" but is bound to "${binding.capability}"`,
            {
              subjectId: subject.subjectId,
              context: { capability: binding.capability, workflowId: binding.workflowId },
            },
          ),
        );
      }
    }
  }

  return findings;
}
