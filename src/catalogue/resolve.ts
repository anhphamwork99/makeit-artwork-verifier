import type {
  CapabilityBinding,
  ResolvedSubject,
  SubjectCatalogue,
  SubjectDeclaration,
} from '../contracts/catalogues';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import { isCapability } from '../contracts/discriminants';

/**
 * Declaration resolution (decision 0002 "Minimum resolved Subject contract").
 *
 * Family defaults may reduce authoring repetition, but every resolved Subject is
 * complete: adapter, relationships, variants, and bindings are all explicit.
 * The module reads declarations only — it contains no Subject-name, family, or
 * application-kind branch.
 */

export interface SubjectResolution {
  subject: ResolvedSubject | null;
  findings: DiagnosticRecord[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeBinding(binding: CapabilityBinding): CapabilityBinding {
  return { ...binding, checks: sortedUnique(binding.checks) };
}

export function resolveSubjectDeclaration(
  declaration: SubjectDeclaration,
  catalogue: SubjectCatalogue,
): SubjectResolution {
  const findings: DiagnosticRecord[] = [];
  const subjectId = declaration.subjectId;
  const familyDefault = catalogue.familyDefaults[declaration.family];

  if (!familyDefault) {
    findings.push(
      createDiagnostic(
        'SUBJECT_FAMILY_UNKNOWN',
        `Subject declares family "${declaration.family}" with no family defaults`,
        { subjectId },
      ),
    );
  }

  if (declaration.origin === 'application-backed' && declaration.applicationKind === null) {
    findings.push(
      createDiagnostic(
        'SUBJECT_SOURCE_MALFORMED',
        'Application-backed Subject declares no application source binding',
        { subjectId },
      ),
    );
  }

  if (declaration.origin === 'verification-native' && declaration.applicationKind !== null) {
    findings.push(
      createDiagnostic(
        'SUBJECT_SOURCE_MALFORMED',
        `Verification-native Subject must not declare an application source binding (declared "${declaration.applicationKind}")`,
        { subjectId, applicationKind: declaration.applicationKind },
      ),
    );
  }

  for (const binding of declaration.capabilityBindings) {
    if (!isCapability(binding.capability)) {
      findings.push(
        createDiagnostic(
          'SUBJECT_BINDING_INVALID',
          `Capability binding declares unknown Capability "${String(binding.capability)}"`,
          { subjectId },
        ),
      );
    } else if (binding.workflowId.trim().length === 0) {
      findings.push(
        createDiagnostic(
          'SUBJECT_BINDING_INVALID',
          'Capability binding declares an empty workflow',
          {
            subjectId,
            context: { capability: binding.capability },
          },
        ),
      );
    }
  }

  const adapter = declaration.adapter ?? familyDefault?.adapter ?? null;
  if (
    adapter &&
    (!Number.isInteger(adapter.compatibilityVersion) || adapter.compatibilityVersion <= 0)
  ) {
    findings.push(
      createDiagnostic(
        'SUBJECT_ADAPTER_INCOMPATIBLE',
        `Adapter "${adapter.adapterId}" declares an unusable compatibility version (${adapter.compatibilityVersion})`,
        { subjectId },
      ),
    );
  }

  if (findings.some((finding) => finding.severity === 'blocking')) {
    return { subject: null, findings };
  }

  const resolvedDefault = familyDefault as NonNullable<typeof familyDefault>;
  const resolvedAdapter = adapter as NonNullable<typeof adapter>;

  return {
    subject: {
      subjectId,
      label: declaration.label,
      family: declaration.family,
      origin: declaration.origin,
      applicationKind: declaration.applicationKind,
      variants: sortedUnique(declaration.variants),
      allowedParents: sortedUnique(declaration.allowedParents ?? resolvedDefault.allowedParents),
      allowedReferences: sortedUnique(
        declaration.allowedReferences ?? resolvedDefault.allowedReferences,
      ),
      allowedChildren: sortedUnique(declaration.allowedChildren ?? resolvedDefault.allowedChildren),
      adapter: { ...resolvedAdapter },
      adapterProvenance: declaration.adapter ? 'override' : 'family-default',
      familyDefaultVersion: resolvedDefault.version,
      capabilityBindings: declaration.capabilityBindings
        .map(normalizeBinding)
        .sort((left, right) => (left.capability < right.capability ? -1 : 1)),
    },
    findings,
  };
}
