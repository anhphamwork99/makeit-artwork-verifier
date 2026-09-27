import {
  COVERAGE_DEFAULT_RESIDUAL_STRENGTH,
  COVERAGE_SELECTION_POLICY_VERSION,
  type BindingCoverageModel,
  type CoverageObligation,
  type CoverageSelection,
  type CoverageTupleCoverage,
  type CoverageTupleLevel,
  type CoverageTupleMember,
  type SelectedCoverageCase,
  type SelectedCoverageReleaseBasis,
} from '../contracts/coverage';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { ExecutionProfile } from '../contracts/discriminants';
import { IDENTITY_DOMAINS, domainSeparatedDigest } from '../canonical/canonicalize';
import { COVERAGE_SELECTION_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  assignmentHasSellerInvalidValue,
  assignmentMatches,
  enumerateUniverse,
  indexFactors,
  obligationSatisfiedByAssignment,
  type CoverageAssignment,
  type CoverageFactorIndex,
} from './validate';

/**
 * Central deterministic Coverage selector (decision 0004, specification 7).
 *
 * Selection mechanics — ordering, tie-breaking, seed handling, tuple cover and
 * obligation mapping — live here and nowhere else. The selector contains no
 * Subject-name branch and no executable hook: every case is derived from
 * declared Factors, partitions, scenarios, constraints, and unsupported
 * combinations. The default residual strategy is constrained pairwise; a
 * stronger local strength exists only where a model explicitly declares a
 * bounded submodel.
 */

export interface SelectCoverageOptions {
  model: BindingCoverageModel;
  modelFingerprint: string;
  profile: ExecutionProfile;
  /**
   * Accepted for forward compatibility only. This selector is deterministic and
   * exhaustive and performs no sampling, so the value cannot affect selection
   * or identity; the returned selection always records `seed: null`.
   */
  seed?: number | null;
  policyVersion?: string;
}

interface MutableCase {
  caseKey: string;
  origin: SelectedCoverageCase['origin'];
  scenarioId: string | null;
  assignments: CoverageAssignment;
  obligationIds: Set<string>;
  releaseEligible: boolean;
  releaseBasis: SelectedCoverageReleaseBasis;
}

function assignmentKey(assignment: CoverageAssignment): string {
  return Object.keys(assignment)
    .sort()
    .map((factorId) => `${factorId}=${assignment[factorId]}`)
    .join('|');
}

function tupleKey(members: readonly CoverageTupleMember[]): string {
  return members
    .map((member) => `${member.factorId}=${member.valueId}`)
    .sort()
    .join('|');
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0 || size > items.length) return [];
  const result: T[][] = [];
  const build = (start: number, current: T[]): void => {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      current.push(items[index]);
      build(index + 1, current);
      current.pop();
    }
  };
  build(0, []);
  return result;
}

function assignmentMembers(
  assignment: CoverageAssignment,
  factorIds: readonly string[],
): CoverageTupleMember[] {
  return factorIds.map((factorId) => ({ factorId, valueId: assignment[factorId] }));
}

function caseSatisfies(
  model: BindingCoverageModel,
  index: CoverageFactorIndex,
  assignment: CoverageAssignment,
  obligation: CoverageObligation,
): boolean {
  return obligationSatisfiedByAssignment(model, index, assignment, obligation);
}

function matchingScenarioId(
  model: BindingCoverageModel,
  assignment: CoverageAssignment,
): string | null {
  const matches = model.scenarios.filter((scenario) =>
    assignmentMatches(scenario.assignments, assignment),
  );
  const fallback = matches[0];
  if (fallback === undefined) return null;
  // ADR 0016 R8: a diagnostic-only scenario that shares a release scenario's
  // assignment must never take ownership of that assignment in a selection, or
  // it would displace the release-required scenario and deny its Release credit.
  // A release-required match therefore always wins over a diagnostic-only match.
  const releaseRequired = matches.find((scenario) => scenario.eligibility === 'release-required');
  return (releaseRequired ?? fallback).id;
}

export function selectCoverage(options: SelectCoverageOptions): CoverageSelection {
  const { model, modelFingerprint, profile } = options;
  const policyVersion = options.policyVersion ?? COVERAGE_SELECTION_POLICY_VERSION;
  const index = indexFactors(model);
  const universe = enumerateUniverse(model, index);

  const includedObligations = model.obligations.filter(
    (obligation) => obligation.requiredFor === 'release' || profile === 'diagnostic',
  );

  const validAssignments = [...universe.valid].sort((left, right) =>
    assignmentKey(left) < assignmentKey(right) ? -1 : 1,
  );
  const attemptableAssignments = [...universe.attemptable].sort((left, right) =>
    assignmentKey(left) < assignmentKey(right) ? -1 : 1,
  );

  const cases = new Map<string, MutableCase>();
  const warnings: DiagnosticRecord[] = [];

  const caseKeyFor = (assignment: CoverageAssignment): string =>
    domainSeparatedDigest(IDENTITY_DOMAINS.coverageSelection, COVERAGE_SELECTION_SCHEMA_VERSION, {
      modelFingerprint,
      assignment: Object.fromEntries(
        Object.entries(assignment).sort(([left], [right]) => (left < right ? -1 : 1)),
      ),
    });

  const ensureCase = (
    assignment: CoverageAssignment,
    origin: SelectedCoverageCase['origin'],
    pool: 'diagnostic' | 'release',
  ): MutableCase => {
    const key = assignmentKey(assignment);
    const existing = cases.get(key);
    if (existing) return existing;
    const matchedScenarioId = matchingScenarioId(model, assignment);
    const matchedScenario = matchedScenarioId
      ? (model.scenarios.find((scenario) => scenario.id === matchedScenarioId) ?? null)
      : null;
    const sellerInvalid = assignmentHasSellerInvalidValue(index, assignment);
    let releaseBasis: SelectedCoverageReleaseBasis;
    if (matchedScenario) {
      releaseBasis =
        matchedScenario.eligibility === 'release-required'
          ? 'declared-release-scenario'
          : 'declared-diagnostic-scenario';
    } else {
      releaseBasis =
        pool === 'release'
          ? 'non-scenario-release-assignment'
          : 'non-scenario-diagnostic-assignment';
    }
    const created: MutableCase = {
      caseKey: caseKeyFor(assignment),
      origin,
      scenarioId: matchedScenarioId,
      assignments: { ...assignment },
      obligationIds: new Set(),
      releaseEligible:
        !sellerInvalid &&
        (releaseBasis === 'declared-release-scenario' ||
          releaseBasis === 'non-scenario-release-assignment'),
      releaseBasis,
    };
    cases.set(key, created);
    return created;
  };

  const findAssignment = (
    candidates: readonly CoverageAssignment[],
    predicate: (assignment: CoverageAssignment) => boolean,
  ): CoverageAssignment | null => {
    for (const assignment of candidates) {
      if (predicate(assignment)) return assignment;
    }
    return null;
  };

  // 1. Canonical baseline first.
  const baseline =
    model.scenarios.find((scenario) => scenario.id === model.baselineScenarioId) ?? null;
  if (baseline) {
    const match = findAssignment(validAssignments, (assignment) =>
      assignmentMatches(baseline.assignments, assignment),
    );
    if (match) ensureCase(match, 'baseline', 'release');
  }

  // 2. Mandatory scenario obligations (baseline, risk, transition, interaction, negative).
  for (const obligation of includedObligations) {
    const obligationMatch = obligation.match;
    if (obligationMatch.kind !== 'scenario') continue;
    const scenario = model.scenarios.find((entry) => entry.id === obligationMatch.scenarioId);
    if (!scenario) continue;
    const candidates =
      scenario.eligibility === 'diagnostic-only' ? attemptableAssignments : validAssignments;
    const candidate = findAssignment(candidates, (assignment) =>
      assignmentMatches(scenario.assignments, assignment),
    );
    if (candidate) {
      ensureCase(
        candidate,
        'mandatory',
        scenario.eligibility === 'diagnostic-only' ? 'diagnostic' : 'release',
      );
    }
  }

  // 3. Required partition, boundary, and explicit tuple obligations.
  for (const obligation of includedObligations) {
    if (obligation.match.kind === 'scenario') continue;
    const candidates =
      obligation.requiredFor === 'diagnostic' ? attemptableAssignments : validAssignments;
    const match = findAssignment(candidates, (assignment) =>
      caseSatisfies(model, index, assignment, obligation),
    );
    if (!match) continue;
    const pool = obligation.requiredFor === 'diagnostic' ? 'diagnostic' : 'release';
    if (obligation.kind === 'boundary') {
      ensureCase(match, 'boundary', pool);
    } else if (obligation.kind === 'tuple') {
      ensureCase(match, 'residual', pool);
    } else {
      ensureCase(match, 'partition', pool);
    }
  }

  // 4. Residual constrained covering: the default pairwise level and every
  //    declared bounded stronger submodel are computed and reported separately,
  //    so 3-wise tuples are never aggregated under `strength: 2`.
  const residualFactors = model.factors
    .filter((factor) => factor.residual)
    .map((factor) => factor.id)
    .sort();

  interface TupleLevelState {
    submodelId: string | null;
    factors: string[];
    strength: number;
    combos: string[][];
    required: Set<string>;
    covered: Set<string>;
  }

  const levelStates: TupleLevelState[] = [
    {
      submodelId: null,
      factors: residualFactors,
      strength: COVERAGE_DEFAULT_RESIDUAL_STRENGTH,
      combos: combinations(residualFactors, COVERAGE_DEFAULT_RESIDUAL_STRENGTH),
      required: new Set<string>(),
      covered: new Set<string>(),
    },
  ];
  for (const submodel of model.residual.submodels) {
    const members = [...submodel.factors].sort();
    levelStates.push({
      submodelId: submodel.id,
      factors: members,
      strength: submodel.strength,
      combos: combinations(members, submodel.strength),
      required: new Set<string>(),
      covered: new Set<string>(),
    });
  }

  for (const assignment of validAssignments) {
    for (const state of levelStates) {
      for (const combo of state.combos) {
        state.required.add(tupleKey(assignmentMembers(assignment, combo)));
      }
    }
  }

  const markCovered = (assignment: CoverageAssignment): void => {
    for (const state of levelStates) {
      for (const combo of state.combos) {
        state.covered.add(tupleKey(assignmentMembers(assignment, combo)));
      }
    }
  };

  for (const selected of cases.values()) markCovered(selected.assignments);

  for (const state of levelStates) {
    for (const tuple of [...state.required].sort()) {
      if (state.covered.has(tuple)) continue;
      const members = tuple.split('|').map((entry) => {
        const [factorId, valueId] = entry.split('=');
        return { factorId, valueId };
      });
      const match = findAssignment(validAssignments, (assignment) =>
        members.every((member) => assignment[member.factorId] === member.valueId),
      );
      if (!match) continue;
      const created = ensureCase(match, 'residual', 'release');
      markCovered(created.assignments);
    }
  }

  // 5. Obligation mapping and accounting.
  const obligationMappings = includedObligations.map((obligation) => {
    const caseKeys = [...cases.values()]
      .filter((entry) => caseSatisfies(model, index, entry.assignments, obligation))
      .map((entry) => entry.caseKey)
      .sort();
    return {
      obligationId: obligation.id,
      kind: obligation.kind,
      requiredFor: obligation.requiredFor,
      caseKeys,
      satisfied: caseKeys.length > 0,
    };
  });

  const uncoveredObligations = obligationMappings
    .filter((mapping) => !mapping.satisfied)
    .map((mapping) => mapping.obligationId)
    .sort();

  const levelResults: CoverageTupleLevel[] = levelStates.map((state) => {
    const uncovered = [...state.required].filter((tuple) => !state.covered.has(tuple)).sort();
    return {
      submodelId: state.submodelId,
      factors: state.factors,
      strength: state.strength,
      required: state.required.size,
      covered: state.required.size - uncovered.length,
      uncovered,
    };
  });

  const pairwise: CoverageTupleLevel = levelResults.find((level) => level.submodelId === null) ?? {
    submodelId: null,
    factors: residualFactors,
    strength: COVERAGE_DEFAULT_RESIDUAL_STRENGTH,
    required: 0,
    covered: 0,
    uncovered: [],
  };
  const submodelLevels = levelResults.filter((level) => level.submodelId !== null);
  const tupleCoverage: CoverageTupleCoverage = { pairwise, submodels: submodelLevels };

  const uncoveredTupleCount = levelResults.reduce(
    (total, level) => total + level.uncovered.length,
    0,
  );

  if (uncoveredObligations.length > 0 || uncoveredTupleCount > 0) {
    warnings.push(
      createDiagnostic(
        'COVERAGE_SELECTION_INCOMPLETE',
        `Deterministic selection left ${uncoveredObligations.length} obligation(s) and ${uncoveredTupleCount} required residual tuple(s) uncovered`,
        { subjectId: model.subjectId, context: { capability: model.capability, profile } },
      ),
    );
  }

  // 6. For each case, record the obligations it satisfies.
  const orderedCases: SelectedCoverageCase[] = [...cases.values()]
    .map((entry) => {
      for (const obligation of includedObligations) {
        if (caseSatisfies(model, index, entry.assignments, obligation)) {
          entry.obligationIds.add(obligation.id);
        }
      }
      return {
        caseKey: entry.caseKey,
        origin: entry.origin,
        scenarioId: entry.scenarioId,
        assignments: entry.assignments,
        representativeIds: Object.entries(entry.assignments)
          .map(([factorId, valueId]) => `${factorId}=${valueId}`)
          .sort(),
        obligationIds: [...entry.obligationIds].sort(),
        releaseEligible: entry.releaseEligible,
        releaseBasis: entry.releaseBasis,
      };
    })
    .sort((left, right) => (left.caseKey < right.caseKey ? -1 : 1));

  const inputFingerprint = domainSeparatedDigest(
    IDENTITY_DOMAINS.coverageSelection,
    COVERAGE_SELECTION_SCHEMA_VERSION,
    { policyVersion, profile, modelFingerprint },
  );

  return {
    schemaVersion: COVERAGE_SELECTION_SCHEMA_VERSION,
    policyVersion,
    seed: null,
    profile,
    inputFingerprint,
    coverageModelFingerprint: modelFingerprint,
    cases: orderedCases,
    obligationMappings,
    tupleCoverage,
    uncoveredObligations,
    warnings,
  };
}
