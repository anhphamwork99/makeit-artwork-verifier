import { canonicalize } from '../canonical/canonicalize';
import { deriveCoverageModelFingerprint } from '../catalogue/fingerprint';
import type { CaseIntent } from '../contracts/case-model';
import type {
  BindingCoverageModel,
  CoverageFactor,
  CoverageModelCatalogue,
  CoverageScalar,
  CoverageScenario,
} from '../contracts/coverage';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { Capability, CaseProvenance, ExecutionProfile } from '../contracts/discriminants';
import type { ResolvedSubject } from '../contracts/catalogues';
import {
  assignmentMatches,
  indexFactors,
  obligationSatisfiedByAssignment,
  partitionOfValue,
  type CoverageAssignment,
} from './validate';
import { validateCoverageModel } from './validate';

/**
 * Binding coverage resolution and Diagnostic concrete-value validation
 * (specification 7 and 8.4).
 *
 * A supported binding either resolves a validated Coverage Model or records an
 * explicit missing-model warning with incomplete coverage. A declared model
 * resolves only when every reference, partition, constraint, and obligation
 * validates; otherwise the attempt is `HARNESS_BLOCKED` before selection.
 * Concrete Diagnostic values are proven against the Factor contract — domain
 * membership, partition membership, constraints, safety, and scenario
 * compatibility — and a concrete value that is not the scenario representative
 * never earns Release credit.
 */

export type BindingCoverageResolution =
  | {
      status: 'resolved';
      model: BindingCoverageModel;
      modelFingerprint: string;
      findings: readonly DiagnosticRecord[];
    }
  | { status: 'missing'; findings: readonly DiagnosticRecord[] }
  | { status: 'blocked'; findings: readonly DiagnosticRecord[] };

export interface ResolveBindingCoverageInput {
  catalogue: CoverageModelCatalogue;
  subjectId: string;
  capability: Capability;
}

export function resolveBindingCoverage(
  input: ResolveBindingCoverageInput,
): BindingCoverageResolution {
  const model = input.catalogue.models.find(
    (entry) => entry.subjectId === input.subjectId && entry.capability === input.capability,
  );

  if (!model) {
    return {
      status: 'missing',
      findings: [
        createDiagnostic(
          'COVERAGE_MODEL_MISSING',
          `Binding "${input.subjectId}" × "${input.capability}" has no Coverage Model; coverage is incomplete and no release credit may be claimed`,
          { subjectId: input.subjectId, context: { capability: input.capability } },
        ),
      ],
    };
  }

  const findings = validateCoverageModel(model);
  if (findings.some((finding) => finding.severity === 'blocking')) {
    return { status: 'blocked', findings };
  }

  return {
    status: 'resolved',
    model,
    modelFingerprint: deriveCoverageModelFingerprint(model),
    findings,
  };
}

// ── Concrete Diagnostic value validation (specification 8.4) ────────────────

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** RFC 6901 subset resolver rooted at the Case Intent. */
export function resolveIntentPointer(
  intent: CaseIntent,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: intent };
  if (!pointer.startsWith('/')) return { found: false };
  const segments = pointer.slice(1).split('/').map(unescapePointerSegment);
  let current: unknown = intent;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (typeof current !== 'object' || current === null) return { found: false };
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return { found: false };
    current = record[segment];
  }
  return { found: true, value: current };
}

function scalarKey(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  try {
    return canonicalize(value as CoverageScalar);
  } catch {
    return null;
  }
}

function matchDeclaredValue(factor: CoverageFactor, concrete: unknown): string | null {
  const key = scalarKey(concrete);
  if (key === null) return null;
  for (const value of factor.values) {
    if (canonicalize(value.value) === key) return value.id;
  }
  return null;
}

export interface ResolvedCaseCoverage {
  scenario: CoverageScenario;
  assignments: CoverageAssignment;
  representativeIds: readonly string[];
  obligations: readonly string[];
  /** True when a declared concrete value replaced the scenario representative. */
  diagnosticOverride: boolean;
  diagnosticOverrideIds: readonly string[];
}

export type CaseCoverageResolution =
  | { ok: true; coverage: ResolvedCaseCoverage }
  | { ok: false; finding: DiagnosticRecord };

export interface ResolveCaseCoverageInput {
  model: BindingCoverageModel;
  intent: CaseIntent;
  profile: ExecutionProfile;
  provenance: CaseProvenance;
}

function caseInvalid(
  code: DiagnosticRecord['code'],
  detail: string,
  model: BindingCoverageModel,
): CaseCoverageResolution {
  return {
    ok: false,
    finding: createDiagnostic(code, detail, {
      subjectId: model.subjectId,
      context: { capability: model.capability },
    }),
  };
}

export function resolveCaseCoverage(input: ResolveCaseCoverageInput): CaseCoverageResolution {
  const { model, intent, profile } = input;
  const index = indexFactors(model);

  const scenario = model.scenarios.find((entry) => entry.id === intent.scenario);
  if (!scenario) {
    return caseInvalid(
      'COVERAGE_SCENARIO_UNKNOWN',
      `Scenario "${intent.scenario}" is not declared by the binding Coverage Model`,
      model,
    );
  }

  if (scenario.eligibility === 'diagnostic-only' && profile === 'release') {
    return caseInvalid(
      'COVERAGE_SCENARIO_INELIGIBLE',
      `Scenario "${scenario.id}" is diagnostic-only and is excluded from Release selection`,
      model,
    );
  }

  const assignments: Record<string, string> = { ...scenario.assignments };
  const diagnosticOverrideIds: string[] = [];

  for (const factor of model.factors) {
    if (factor.path === null) continue;
    const resolved = resolveIntentPointer(intent, factor.path);
    if (!resolved.found) continue;

    const valueId = matchDeclaredValue(factor, resolved.value);
    if (valueId === null) {
      return caseInvalid(
        'COVERAGE_VALUE_INVALID',
        `Concrete value at ${factor.path} is not a declared value of Factor "${factor.id}"`,
        model,
      );
    }

    if (valueId === scenario.assignments[factor.id]) continue;

    if (profile === 'release') {
      return caseInvalid(
        'COVERAGE_VALUE_INVALID',
        `Release plan may not substitute concrete value "${valueId}" for Factor "${factor.id}"; only a Diagnostic request may name a non-representative value`,
        model,
      );
    }
    if (!factor.allowsConcreteValues) {
      return caseInvalid(
        'COVERAGE_VALUE_INVALID',
        `Factor "${factor.id}" does not permit a concrete value that is not its scenario representative`,
        model,
      );
    }

    const partition = partitionOfValue(index, factor.id, valueId);
    if (!partition) {
      return caseInvalid(
        'COVERAGE_REFERENCE_UNKNOWN',
        `Factor "${factor.id}" value "${valueId}" has no declared partition`,
        model,
      );
    }
    if (partition.validity === 'unsupported') {
      return caseInvalid(
        'COVERAGE_COMBINATION_UNSUPPORTED',
        `Concrete value "${factor.id}=${valueId}" belongs to an unsupported partition`,
        model,
      );
    }
    if (partition.validity === 'seller-invalid' && scenario.eligibility !== 'diagnostic-only') {
      return caseInvalid(
        'COVERAGE_VALUE_INVALID',
        `Seller-attemptable value "${factor.id}=${valueId}" requires a declared negative scenario`,
        model,
      );
    }

    assignments[factor.id] = valueId;
    diagnosticOverrideIds.push(`${factor.id}=${valueId}`);
  }

  for (const entry of model.unsupported) {
    if (assignmentMatches(entry.combination, assignments)) {
      return caseInvalid(
        'COVERAGE_COMBINATION_UNSUPPORTED',
        `Requested assignment matches unsupported combination "${entry.id}" (${entry.rationale})`,
        model,
      );
    }
  }

  for (const constraint of model.constraints) {
    if (assignmentMatches(constraint.exclude, assignments)) {
      return caseInvalid(
        'COVERAGE_CONSTRAINT_VIOLATED',
        `Requested assignment violates constraint "${constraint.id}" (${constraint.rationale})`,
        model,
      );
    }
  }

  for (const [factorId, valueId] of Object.entries(assignments)) {
    const partition = partitionOfValue(index, factorId, valueId);
    if (!partition) {
      return caseInvalid(
        'COVERAGE_REFERENCE_UNKNOWN',
        `Assignment "${factorId}=${valueId}" has no declared partition`,
        model,
      );
    }
    if (partition.validity === 'unsupported') {
      return caseInvalid(
        'COVERAGE_COMBINATION_UNSUPPORTED',
        `Assignment "${factorId}=${valueId}" belongs to an unsupported partition`,
        model,
      );
    }
  }

  const obligations = model.obligations
    .filter((obligation) => obligationSatisfiedByAssignment(model, index, assignments, obligation))
    .map((obligation) => obligation.id)
    .sort();

  const representativeIds = Object.entries(assignments)
    .map(([factorId, valueId]) => `${factorId}=${valueId}`)
    .sort();

  return {
    ok: true,
    coverage: {
      scenario,
      assignments,
      representativeIds,
      obligations,
      diagnosticOverride: diagnosticOverrideIds.length > 0,
      diagnosticOverrideIds: diagnosticOverrideIds.sort(),
    },
  };
}

// ── Project/scope presence ──────────────────────────────────────────────────

export interface ProjectScopeDescription {
  complete: boolean;
  qualification: string;
  missingBindings: readonly string[];
  resolvedBindingCount: number;
}

const PROJECT_SCOPE_EXECUTION_NOTE =
  'project/scope completeness additionally requires binding execution completeness, which no pre-launch plan establishes';

export function describeProjectScope(input: {
  resolvedSubjects: readonly ResolvedSubject[];
  catalogue: CoverageModelCatalogue;
}): ProjectScopeDescription {
  const present = new Set(
    input.catalogue.models.map((model) => `${model.subjectId}\u0000${model.capability}`),
  );
  const missingBindings: string[] = [];
  let resolvedBindingCount = 0;
  for (const subject of input.resolvedSubjects) {
    for (const binding of subject.capabilityBindings) {
      resolvedBindingCount += 1;
      if (!present.has(`${subject.subjectId}\u0000${binding.capability}`)) {
        missingBindings.push(`${subject.subjectId}×${binding.capability}`);
      }
    }
  }
  missingBindings.sort();

  const qualification =
    missingBindings.length === 0
      ? `Every resolved Subject × Capability binding has a Coverage Model, but ${PROJECT_SCOPE_EXECUTION_NOTE}.`
      : `${missingBindings.length} of ${resolvedBindingCount} resolved Subject × Capability binding(s) have no Coverage Model, and ${PROJECT_SCOPE_EXECUTION_NOTE}.`;

  return {
    complete: false,
    qualification,
    missingBindings,
    resolvedBindingCount,
  };
}
