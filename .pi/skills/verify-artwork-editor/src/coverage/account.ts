import type {
  CoverageSelection,
  CoverageTupleCoverage,
  SelectedCoverageCase,
} from '../contracts/coverage';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import {
  COMPLETENESS_DIMENSIONS,
  COMPLETENESS_STATUSES,
  type CompletenessDimension,
  type CompletenessStatus,
  type CoverageStatus,
} from '../contracts/discriminants';
import type { CoverageCompletenessEntry } from '../contracts/planner-outputs';

/**
 * Coverage accounting (decision 0004 "Completeness", specification 7).
 *
 * Completeness is never emitted unqualified. Every record names exactly one of
 * the five accepted dimensions, and no dimension may claim that every possible
 * value, state, or combination was tested. `PASS`, binding model completeness,
 * binding execution completeness, selected-suite completeness, registry
 * coverage, and project/scope completeness remain independent facts.
 */

export interface ModelCompleteness {
  complete: boolean;
  qualification: string;
}

export function buildModelCompleteness(selection: CoverageSelection): ModelCompleteness {
  const uncoveredObligations = selection.uncoveredObligations.length;
  const levels = [selection.tupleCoverage.pairwise, ...selection.tupleCoverage.submodels];
  const uncoveredTupleCount = levels.reduce((total, level) => total + level.uncovered.length, 0);
  const everyLevelCovered = levels.every((level) => level.covered === level.required);
  const complete = uncoveredObligations === 0 && uncoveredTupleCount === 0 && everyLevelCovered;
  const levelSummary = levels
    .map(
      (level) =>
        `${level.submodelId ?? 'default'}(t=${level.strength}) ${level.covered}/${level.required}`,
    )
    .join(', ');
  const qualification = complete
    ? `Every mandatory Coverage Obligation and every reported residual tuple level of the validated ${selection.profile} Coverage Model has a selected case under policy "${selection.policyVersion}" (${selection.cases.length} selected case(s); levels ${levelSummary}); this is model completeness for one binding only.`
    : `Binding model completeness is not established: ${uncoveredObligations} mandatory obligation(s) and ${uncoveredTupleCount} required residual tuple(s) have no selected case under policy "${selection.policyVersion}" (levels ${levelSummary}).`;
  return { complete, qualification };
}

export interface CoverageCompletenessInput {
  bindingModelPresent: boolean;
  bindingModelComplete: boolean;
  bindingModelQualification: string;
  registryCoverageStatus: CoverageStatus;
  registryQualification: string;
  projectScopeComplete: boolean;
  projectScopeQualification: string;
}

export function deriveCoverageCompleteness(
  input: CoverageCompletenessInput,
): CoverageCompletenessEntry[] {
  const bindingModelStatus: CompletenessStatus =
    input.bindingModelPresent && input.bindingModelComplete ? 'complete' : 'incomplete';

  const entries: Record<CompletenessDimension, CoverageCompletenessEntry> = {
    'binding-model': {
      dimension: 'binding-model',
      status: bindingModelStatus,
      qualification: input.bindingModelQualification,
    },
    'binding-execution': {
      dimension: 'binding-execution',
      status: 'incomplete',
      qualification:
        'No conclusive execution result is recorded before launch; binding execution completeness requires every required selected case to have a terminal result.',
    },
    'project-scope': {
      dimension: 'project-scope',
      status: input.projectScopeComplete ? 'complete' : 'incomplete',
      qualification: input.projectScopeQualification,
    },
    'registry-coverage': {
      dimension: 'registry-coverage',
      status: input.registryCoverageStatus,
      qualification: input.registryQualification,
    },
    'selected-suite': {
      dimension: 'selected-suite',
      status: 'deferred',
      qualification:
        'Selected-suite completeness is owned by the governed Selection Manifest Work Package; this record accounts one binding and grants no suite-level claim.',
    },
  };

  return COMPLETENESS_DIMENSIONS.map((dimension) => entries[dimension]);
}

/**
 * Fails closed on an unqualified completeness claim: a missing dimension, an
 * unknown dimension, an unsupported status, or an empty qualification is a
 * blocking harness defect, never a warning.
 */
export function validateCoverageCompleteness(
  entries: readonly CoverageCompletenessEntry[],
): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    if (!COMPLETENESS_DIMENSIONS.includes(entry.dimension)) {
      findings.push(
        createDiagnostic(
          'COVERAGE_UNQUALIFIED_COMPLETENESS',
          `Completeness entry ${index} names an unknown dimension "${String(entry.dimension)}"`,
        ),
      );
      continue;
    }
    seen.add(entry.dimension);
    if (!COMPLETENESS_STATUSES.includes(entry.status)) {
      findings.push(
        createDiagnostic(
          'COVERAGE_UNQUALIFIED_COMPLETENESS',
          `Completeness dimension "${entry.dimension}" declares an unsupported status "${String(entry.status)}"`,
          { context: { dimension: entry.dimension } },
        ),
      );
    }
    if (typeof entry.qualification !== 'string' || entry.qualification.trim().length === 0) {
      findings.push(
        createDiagnostic(
          'COVERAGE_UNQUALIFIED_COMPLETENESS',
          `Completeness dimension "${entry.dimension}" is unqualified: no scope qualification was provided`,
          { context: { dimension: entry.dimension } },
        ),
      );
    }
  }

  const missing = COMPLETENESS_DIMENSIONS.filter((dimension) => !seen.has(dimension));
  if (missing.length > 0) {
    findings.push(
      createDiagnostic(
        'COVERAGE_UNQUALIFIED_COMPLETENESS',
        `Completeness is unqualified: missing dimension(s) ${missing.join(', ')}`,
      ),
    );
  }

  return findings;
}

export function unqualifiedCompletenessIsBlocking(
  entries: readonly CoverageCompletenessEntry[],
): boolean {
  return validateCoverageCompleteness(entries).some((finding) => finding.severity === 'blocking');
}

/** Convenience projection of a selection's tuple accounting for a record. */
export function selectionTupleCoverage(
  selection: CoverageSelection | null,
): CoverageTupleCoverage | null {
  return selection ? selection.tupleCoverage : null;
}

export function selectedCaseKeys(selection: CoverageSelection | null): string[] {
  return selection ? selection.cases.map((entry: SelectedCoverageCase) => entry.caseKey) : [];
}
