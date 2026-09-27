import type {
  BindingCoverageModel,
  CoverageFactor,
  CoverageFactorValue,
  CoverageModelCatalogue,
  CoverageObligation,
  CoveragePartition,
} from '../contracts/coverage';
import { COVERAGE_MAX_UNIVERSE_ASSIGNMENTS } from '../contracts/coverage';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';

/**
 * Coverage Model semantic validation (specification 7).
 *
 * Every reference is resolved against the model's own declarations, partition
 * membership is proven, constraints are evaluated over the complete bounded
 * universe, and every obligation's satisfiability is proven. A contradiction, an
 * unknown reference, an invalid partition representative, or a constraint that
 * silently removes a mandatory obligation is `HARNESS_BLOCKED`; it is never
 * downgraded to a warning.
 */

export type CoverageAssignment = Readonly<Record<string, string>>;

export interface CoverageUniverse {
  /** Every assignment that may ever be generated, including seller-attemptable invalid values. */
  attemptable: readonly CoverageAssignment[];
  /** Assignments without any seller-invalid value; the release-claim universe. */
  valid: readonly CoverageAssignment[];
  /** Assignments removed by a structural constraint or unsupported combination. */
  excluded: number;
  /** Total Cartesian assignments before constraint filtering. */
  total: number;
}

export interface CoverageFactorIndex {
  factors: ReadonlyMap<string, CoverageFactor>;
  values: ReadonlyMap<string, CoverageFactorValue>;
  partitions: ReadonlyMap<string, CoveragePartition>;
}

function factorValueKey(factorId: string, valueId: string): string {
  return `${factorId}\u0000${valueId}`;
}

function partitionKey(factorId: string, partitionId: string): string {
  return `${factorId}\u0000${partitionId}`;
}

export function indexFactors(model: BindingCoverageModel): CoverageFactorIndex {
  const factors = new Map<string, CoverageFactor>();
  const values = new Map<string, CoverageFactorValue>();
  const partitions = new Map<string, CoveragePartition>();
  for (const factor of model.factors) {
    factors.set(factor.id, factor);
    for (const value of factor.values) values.set(factorValueKey(factor.id, value.id), value);
    for (const partition of factor.partitions) {
      partitions.set(partitionKey(factor.id, partition.id), partition);
    }
  }
  return { factors, values, partitions };
}

export function partitionOfValue(
  index: CoverageFactorIndex,
  factorId: string,
  valueId: string,
): CoveragePartition | null {
  const value = index.values.get(factorValueKey(factorId, valueId));
  if (!value) return null;
  return index.partitions.get(partitionKey(factorId, value.partition)) ?? null;
}

export function assignmentMatches(
  pattern: CoverageAssignment,
  assignment: CoverageAssignment,
): boolean {
  return Object.entries(pattern).every(([factorId, valueId]) => assignment[factorId] === valueId);
}

/** True when any assigned value belongs to a seller-attemptable invalid partition. */
export function assignmentHasSellerInvalidValue(
  index: CoverageFactorIndex,
  assignment: CoverageAssignment,
): boolean {
  return Object.entries(assignment).some(
    ([factorId, valueId]) =>
      partitionOfValue(index, factorId, valueId)?.validity === 'seller-invalid',
  );
}

/** Evaluates one obligation's closed declarative match against a full assignment. */
export function obligationSatisfiedByAssignment(
  model: BindingCoverageModel,
  index: CoverageFactorIndex,
  assignment: CoverageAssignment,
  obligation: CoverageObligation,
): boolean {
  const match = obligation.match;
  switch (match.kind) {
    case 'scenario': {
      const scenario = model.scenarios.find((entry) => entry.id === match.scenarioId);
      return scenario ? assignmentMatches(scenario.assignments, assignment) : false;
    }
    case 'value':
      return assignment[match.factorId] === match.valueId;
    case 'partition': {
      const partition = index.partitions.get(partitionKey(match.factorId, match.partitionId));
      return partition ? partition.values.includes(assignment[match.factorId]) : false;
    }
    case 'tuple':
      return match.values.every((member) => assignment[member.factorId] === member.valueId);
  }
}

function assignmentKey(assignment: CoverageAssignment): string {
  return Object.keys(assignment)
    .sort()
    .map((factorId) => `${factorId}=${assignment[factorId]}`)
    .join('|');
}

/**
 * Raised when a model's Cartesian universe exceeds the declared bound. It
 * carries the blocking diagnostic so callers fail closed with a structured
 * record instead of an out-of-memory enumeration.
 */
export class CoverageUniverseUnboundedError extends Error {
  readonly diagnostic: DiagnosticRecord;

  constructor(diagnostic: DiagnosticRecord) {
    super(diagnostic.detail);
    this.name = 'CoverageUniverseUnboundedError';
    this.diagnostic = diagnostic;
  }
}

/**
 * The number of attemptable Cartesian assignments a model declares, computed
 * from domain sizes alone. It never materializes an assignment, so it is safe
 * to evaluate for an adversarial declaration; an unrepresentable product
 * saturates to `Infinity` and is therefore always unbounded.
 */
export function computeUniverseSize(
  model: BindingCoverageModel,
  index: CoverageFactorIndex,
): number {
  let product = 1;
  for (const factor of model.factors) {
    const size = factor.values.filter((value) => {
      const partition = partitionOfValue(index, factor.id, value.id);
      return partition !== null && partition.validity !== 'unsupported';
    }).length;
    product *= size;
    if (!Number.isSafeInteger(product)) return Number.POSITIVE_INFINITY;
  }
  return product;
}

/** True when the model's attemptable universe is within the declared bound. */
export function isUniverseBounded(
  model: BindingCoverageModel,
  index: CoverageFactorIndex,
): boolean {
  return computeUniverseSize(model, index) <= COVERAGE_MAX_UNIVERSE_ASSIGNMENTS;
}

function enumerateRaw(
  model: BindingCoverageModel,
  index: CoverageFactorIndex,
  includeSellerInvalid: boolean,
): CoverageAssignment[] {
  const domains: string[][] = [];
  for (const factor of model.factors) {
    const allowed = factor.values
      .filter((value) => {
        const partition = partitionOfValue(index, factor.id, value.id);
        if (!partition || partition.validity === 'unsupported') return false;
        if (partition.validity === 'seller-invalid') return includeSellerInvalid;
        return true;
      })
      .map((value) => value.id)
      .sort();
    domains.push(allowed);
  }

  let partials: CoverageAssignment[] = [{}];
  for (const [factorIndex, factor] of model.factors.entries()) {
    const domain = domains[factorIndex];
    const next: CoverageAssignment[] = [];
    for (const partial of partials) {
      for (const valueId of domain) {
        next.push({ ...partial, [factor.id]: valueId });
      }
    }
    partials = next;
  }
  return partials;
}

export function enumerateUniverse(
  model: BindingCoverageModel,
  index: CoverageFactorIndex,
): CoverageUniverse {
  const size = computeUniverseSize(model, index);
  if (size > COVERAGE_MAX_UNIVERSE_ASSIGNMENTS) {
    throw new CoverageUniverseUnboundedError(
      createDiagnostic(
        'COVERAGE_UNIVERSE_UNBOUNDED',
        `Coverage Model "${model.subjectId}" × "${model.capability}" declares ${String(size)} Cartesian attemptable assignment(s), which exceeds the declared bound of ${COVERAGE_MAX_UNIVERSE_ASSIGNMENTS}; enumeration fails closed`,
        {
          subjectId: model.subjectId,
          context: {
            capability: model.capability,
            bound: String(COVERAGE_MAX_UNIVERSE_ASSIGNMENTS),
            universeSize: String(size),
          },
        },
      ),
    );
  }
  const raw = enumerateRaw(model, index, true);
  const attemptable: CoverageAssignment[] = [];
  let excluded = 0;
  for (const assignment of raw) {
    const blocked =
      model.constraints.some((constraint) => assignmentMatches(constraint.exclude, assignment)) ||
      model.unsupported.some((entry) => assignmentMatches(entry.combination, assignment));
    if (blocked) {
      excluded += 1;
      continue;
    }
    attemptable.push(assignment);
  }
  const valid = attemptable.filter(
    (assignment) =>
      !Object.entries(assignment).some(
        ([factorId, valueId]) =>
          partitionOfValue(index, factorId, valueId)?.validity === 'seller-invalid',
      ),
  );
  return { attemptable, valid, excluded, total: raw.length };
}

function scenarioSatisfiable(
  model: BindingCoverageModel,
  universe: readonly CoverageAssignment[],
  scenarioId: string,
): boolean {
  const scenario = model.scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario) return false;
  const key = assignmentKey(scenario.assignments);
  return universe.some((assignment) => assignmentKey(assignment) === key);
}

function obligationMatchSatisfiable(
  model: BindingCoverageModel,
  index: CoverageFactorIndex,
  universe: readonly CoverageAssignment[],
  obligation: CoverageObligation,
): boolean {
  const match = obligation.match;
  switch (match.kind) {
    case 'scenario':
      return scenarioSatisfiable(model, universe, match.scenarioId);
    case 'value':
      return universe.some((assignment) => assignment[match.factorId] === match.valueId);
    case 'partition': {
      const partition = index.partitions.get(partitionKey(match.factorId, match.partitionId));
      if (!partition) return false;
      const members = new Set(partition.values);
      return universe.some((assignment) => members.has(assignment[match.factorId]));
    }
    case 'tuple':
      return universe.some((assignment) =>
        match.values.every((member) => assignment[member.factorId] === member.valueId),
      );
  }
}

function validateFactor(
  factor: CoverageFactor,
  findings: DiagnosticRecord[],
  subjectId: string,
  capability: string,
): void {
  const valueIds = new Set(factor.values.map((value) => value.id));
  if (factor.values.length !== valueIds.size) {
    findings.push(
      createDiagnostic(
        'COVERAGE_CATALOGUE_DUPLICATE',
        `Factor "${factor.id}" declares a duplicate value id`,
        { subjectId, context: { capability, factorId: factor.id } },
      ),
    );
  }
  const partitionIds = new Set(factor.partitions.map((partition) => partition.id));
  if (partitionIds.size !== factor.partitions.length) {
    findings.push(
      createDiagnostic(
        'COVERAGE_CATALOGUE_DUPLICATE',
        `Factor "${factor.id}" declares a duplicate partition id`,
        { subjectId, context: { capability, factorId: factor.id } },
      ),
    );
  }

  for (const partition of factor.partitions) {
    const members = new Set(partition.values);
    if (partition.values.length !== members.size) {
      findings.push(
        createDiagnostic(
          'COVERAGE_CATALOGUE_DUPLICATE',
          `Partition "${factor.id}/${partition.id}" declares a duplicate value`,
          { subjectId, context: { capability, factorId: factor.id, partitionId: partition.id } },
        ),
      );
    }
    if (partition.values.length === 0) {
      findings.push(
        createDiagnostic(
          'COVERAGE_PARTITION_INVALID',
          `Partition "${factor.id}/${partition.id}" declares no values`,
          { subjectId, context: { capability, factorId: factor.id, partitionId: partition.id } },
        ),
      );
    }
    for (const valueId of partition.values) {
      if (!valueIds.has(valueId)) {
        findings.push(
          createDiagnostic(
            'COVERAGE_REFERENCE_UNKNOWN',
            `Partition "${factor.id}/${partition.id}" references unknown value "${valueId}"`,
            { subjectId, context: { capability, factorId: factor.id, partitionId: partition.id } },
          ),
        );
      }
    }
    if (!members.has(partition.representative)) {
      findings.push(
        createDiagnostic(
          'COVERAGE_PARTITION_INVALID',
          `Partition "${factor.id}/${partition.id}" declares a representative "${partition.representative}" that is not one of its values`,
          { subjectId, context: { capability, factorId: factor.id, partitionId: partition.id } },
        ),
      );
    }
    for (const boundary of partition.boundaries) {
      if (!members.has(boundary)) {
        findings.push(
          createDiagnostic(
            'COVERAGE_PARTITION_INVALID',
            `Partition "${factor.id}/${partition.id}" declares a boundary "${boundary}" that is not one of its values`,
            { subjectId, context: { capability, factorId: factor.id, partitionId: partition.id } },
          ),
        );
      }
    }
  }

  for (const value of factor.values) {
    if (!partitionIds.has(value.partition)) {
      findings.push(
        createDiagnostic(
          'COVERAGE_REFERENCE_UNKNOWN',
          `Value "${factor.id}/${value.id}" references unknown partition "${value.partition}"`,
          { subjectId, context: { capability, factorId: factor.id } },
        ),
      );
      continue;
    }
    const partition = factor.partitions.find((entry) => entry.id === value.partition);
    if (partition && !partition.values.includes(value.id)) {
      findings.push(
        createDiagnostic(
          'COVERAGE_PARTITION_INVALID',
          `Value "${factor.id}/${value.id}" declares partition "${value.partition}" but is not a member of it`,
          { subjectId, context: { capability, factorId: factor.id, partitionId: value.partition } },
        ),
      );
    }
    const boundary = factor.partitions.some((entry) => entry.boundaries.includes(value.id));
    if (value.boundary !== boundary) {
      findings.push(
        createDiagnostic(
          'COVERAGE_PARTITION_INVALID',
          `Value "${factor.id}/${value.id}" boundary flag ${String(value.boundary)} disagrees with its partition boundary declarations`,
          { subjectId, context: { capability, factorId: factor.id } },
        ),
      );
    }
  }

  if (!factor.partitions.some((partition) => partition.validity === 'valid')) {
    findings.push(
      createDiagnostic(
        'COVERAGE_PARTITION_INVALID',
        `Factor "${factor.id}" declares no valid partition`,
        { subjectId, context: { capability, factorId: factor.id } },
      ),
    );
  }
}

export function validateCoverageModel(model: BindingCoverageModel): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  const { subjectId, capability } = model;
  const index = indexFactors(model);

  const baselineScenario = model.scenarios.find(
    (scenario) => scenario.id === model.baselineScenarioId,
  );
  if (!baselineScenario) {
    findings.push(
      createDiagnostic(
        'COVERAGE_REFERENCE_UNKNOWN',
        `Baseline scenario "${model.baselineScenarioId}" is not declared`,
        { subjectId, context: { capability, baselineScenarioId: model.baselineScenarioId } },
      ),
    );
  } else if (baselineScenario.eligibility !== 'release-required') {
    findings.push(
      createDiagnostic(
        'COVERAGE_BASELINE_INVALID',
        `Baseline scenario "${baselineScenario.id}" must be release-required but declares eligibility "${baselineScenario.eligibility}"`,
        {
          subjectId,
          context: {
            capability,
            baselineScenarioId: baselineScenario.id,
            eligibility: baselineScenario.eligibility,
          },
        },
      ),
    );
  }

  for (const factor of model.factors) {
    validateFactor(factor, findings, subjectId, capability);
  }

  const factorIds = new Set(model.factors.map((factor) => factor.id));
  for (const scenario of model.scenarios) {
    for (const [factorId, valueId] of Object.entries(scenario.assignments)) {
      if (!index.values.has(factorValueKey(factorId, valueId))) {
        findings.push(
          createDiagnostic(
            'COVERAGE_REFERENCE_UNKNOWN',
            `Scenario "${scenario.id}" references unknown factor/value "${factorId}=${valueId}"`,
            { subjectId, context: { capability, scenarioId: scenario.id } },
          ),
        );
      }
    }
    // A scenario is a closed world: it must name exactly every Factor once. A
    // partial scenario would silently leave a Factor at the ambient intent
    // value instead of the declared canonical assignment.
    const missingFactors = model.factors
      .filter((factor) => !Object.hasOwn(scenario.assignments, factor.id))
      .map((factor) => factor.id)
      .sort();
    const unknownFactors = Object.keys(scenario.assignments)
      .filter((factorId) => !factorIds.has(factorId))
      .sort();
    if (missingFactors.length > 0 || unknownFactors.length > 0) {
      findings.push(
        createDiagnostic(
          'COVERAGE_SCENARIO_INCOMPLETE',
          `Scenario "${scenario.id}" must assign exactly every Factor once; missing [${missingFactors.join(', ')}], unknown [${unknownFactors.join(', ')}]`,
          { subjectId, context: { capability, scenarioId: scenario.id } },
        ),
      );
    }
  }

  for (const constraint of model.constraints) {
    for (const [factorId, valueId] of Object.entries(constraint.exclude)) {
      if (!index.values.has(factorValueKey(factorId, valueId))) {
        findings.push(
          createDiagnostic(
            'COVERAGE_REFERENCE_UNKNOWN',
            `Constraint "${constraint.id}" references unknown factor/value "${factorId}=${valueId}"`,
            { subjectId, context: { capability, constraintId: constraint.id } },
          ),
        );
      }
    }
  }

  for (const combination of model.unsupported) {
    for (const [factorId, valueId] of Object.entries(combination.combination)) {
      if (!index.values.has(factorValueKey(factorId, valueId))) {
        findings.push(
          createDiagnostic(
            'COVERAGE_REFERENCE_UNKNOWN',
            `Unsupported combination "${combination.id}" references unknown factor/value "${factorId}=${valueId}"`,
            { subjectId, context: { capability, combinationId: combination.id } },
          ),
        );
      }
    }
  }

  for (const obligation of model.obligations) {
    const match = obligation.match;
    if (
      match.kind === 'scenario' &&
      !model.scenarios.some((entry) => entry.id === match.scenarioId)
    ) {
      findings.push(
        createDiagnostic(
          'COVERAGE_REFERENCE_UNKNOWN',
          `Obligation "${obligation.id}" references unknown scenario "${match.scenarioId}"`,
          { subjectId, context: { capability, obligationId: obligation.id } },
        ),
      );
    }
    if (
      match.kind === 'value' &&
      !index.values.has(factorValueKey(match.factorId, match.valueId))
    ) {
      findings.push(
        createDiagnostic(
          'COVERAGE_REFERENCE_UNKNOWN',
          `Obligation "${obligation.id}" references unknown factor/value "${match.factorId}=${match.valueId}"`,
          { subjectId, context: { capability, obligationId: obligation.id } },
        ),
      );
    }
    if (
      match.kind === 'partition' &&
      !index.partitions.has(partitionKey(match.factorId, match.partitionId))
    ) {
      findings.push(
        createDiagnostic(
          'COVERAGE_REFERENCE_UNKNOWN',
          `Obligation "${obligation.id}" references unknown partition "${match.factorId}/${match.partitionId}"`,
          { subjectId, context: { capability, obligationId: obligation.id } },
        ),
      );
    }
    if (match.kind === 'tuple') {
      if (match.values.length < 2) {
        findings.push(
          createDiagnostic(
            'COVERAGE_CATALOGUE_INVALID',
            `Obligation "${obligation.id}" tuple must cover at least two factors`,
            { subjectId, context: { capability, obligationId: obligation.id } },
          ),
        );
      }
      const seen = new Set<string>();
      for (const member of match.values) {
        if (!index.values.has(factorValueKey(member.factorId, member.valueId))) {
          findings.push(
            createDiagnostic(
              'COVERAGE_REFERENCE_UNKNOWN',
              `Obligation "${obligation.id}" references unknown factor/value "${member.factorId}=${member.valueId}"`,
              { subjectId, context: { capability, obligationId: obligation.id } },
            ),
          );
        }
        if (seen.has(member.factorId)) {
          findings.push(
            createDiagnostic(
              'COVERAGE_CATALOGUE_INVALID',
              `Obligation "${obligation.id}" tuple names factor "${member.factorId}" more than once`,
              { subjectId, context: { capability, obligationId: obligation.id } },
            ),
          );
        }
        seen.add(member.factorId);
      }
    }
  }

  for (const submodel of model.residual.submodels) {
    for (const factorId of submodel.factors) {
      if (!index.factors.has(factorId)) {
        findings.push(
          createDiagnostic(
            'COVERAGE_REFERENCE_UNKNOWN',
            `Residual submodel "${submodel.id}" references unknown factor "${factorId}"`,
            { subjectId, context: { capability, submodelId: submodel.id } },
          ),
        );
      }
    }
    if (submodel.strength > submodel.factors.length) {
      findings.push(
        createDiagnostic(
          'COVERAGE_CATALOGUE_INVALID',
          `Residual submodel "${submodel.id}" strength ${submodel.strength} exceeds its ${submodel.factors.length} factor(s)`,
          { subjectId, context: { capability, submodelId: submodel.id } },
        ),
      );
    }
  }

  // Residual coverage cannot be silently opted out. A multi-factor model must
  // retain at least two residual Factors so pairwise interaction coverage is
  // possible, unless the versioned contract explicitly declares the residual
  // policy `not-applicable` with a non-empty rationale.
  const residualFactorIds = model.factors
    .filter((factor) => factor.residual)
    .map((factor) => factor.id)
    .sort();
  const residualNotApplicable =
    model.residual.policy === 'not-applicable' && model.residual.rationale.trim().length > 0;
  if (model.residual.policy === 'not-applicable' && model.residual.rationale.trim().length === 0) {
    findings.push(
      createDiagnostic(
        'COVERAGE_RESIDUAL_POLICY_INVALID',
        `Residual policy "not-applicable" requires a non-empty rationale`,
        { subjectId, context: { capability } },
      ),
    );
  }
  if (model.factors.length >= 2 && residualFactorIds.length < 2 && !residualNotApplicable) {
    findings.push(
      createDiagnostic(
        'COVERAGE_RESIDUAL_POLICY_INVALID',
        `Multi-factor Coverage Model declares only ${residualFactorIds.length} residual Factor(s); pairwise residual coverage requires at least two unless the residual policy is explicitly declared "not-applicable" with a rationale`,
        {
          subjectId,
          context: {
            capability,
            residualFactorCount: String(residualFactorIds.length),
            residualFactors: residualFactorIds.join(','),
          },
        },
      ),
    );
  }

  // The Cartesian universe is bounded analytically before enumeration. An
  // over-bound declaration is a blocking harness defect and is never enumerated.
  const universeSize = computeUniverseSize(model, index);
  if (universeSize > COVERAGE_MAX_UNIVERSE_ASSIGNMENTS) {
    findings.push(
      createDiagnostic(
        'COVERAGE_UNIVERSE_UNBOUNDED',
        `Coverage Model declares ${String(universeSize)} Cartesian attemptable assignment(s), which exceeds the declared bound of ${COVERAGE_MAX_UNIVERSE_ASSIGNMENTS}; the model fails closed before enumeration`,
        {
          subjectId,
          context: {
            capability,
            bound: String(COVERAGE_MAX_UNIVERSE_ASSIGNMENTS),
            universeSize: String(universeSize),
          },
        },
      ),
    );
    return findings;
  }

  const universe = enumerateUniverse(model, index);
  if (universe.attemptable.length === 0) {
    findings.push(
      createDiagnostic(
        'COVERAGE_CONSTRAINT_CONTRADICTORY',
        'Constraints and unsupported combinations exclude every assignment',
        { subjectId, context: { capability } },
      ),
    );
  } else if (universe.valid.length === 0) {
    findings.push(
      createDiagnostic(
        'COVERAGE_CONSTRAINT_CONTRADICTORY',
        'Constraints exclude every valid (non seller-invalid) assignment',
        { subjectId, context: { capability } },
      ),
    );
  }

  for (const scenario of model.scenarios) {
    const inValid = scenarioSatisfiable(model, universe.valid, scenario.id);
    const inAttemptable = scenarioSatisfiable(model, universe.attemptable, scenario.id);
    if (scenario.eligibility === 'release-required' && !inValid) {
      findings.push(
        createDiagnostic(
          'COVERAGE_CONSTRAINT_CONTRADICTORY',
          `Release-required scenario "${scenario.id}" has no valid assignment under the declared constraints`,
          { subjectId, context: { capability, scenarioId: scenario.id } },
        ),
      );
    } else if (!inAttemptable) {
      findings.push(
        createDiagnostic(
          'COVERAGE_CONSTRAINT_CONTRADICTORY',
          `Scenario "${scenario.id}" is excluded by constraints or unsupported combinations`,
          { subjectId, context: { capability, scenarioId: scenario.id } },
        ),
      );
    }
  }

  for (const obligation of model.obligations) {
    const universeForObligation =
      obligation.requiredFor === 'release' ? universe.valid : universe.attemptable;
    if (!obligationMatchSatisfiable(model, index, universeForObligation, obligation)) {
      findings.push(
        createDiagnostic(
          'COVERAGE_OBLIGATION_UNSATISFIABLE',
          `Mandatory obligation "${obligation.id}" has no satisfying case under the declared constraints and unsupported combinations`,
          { subjectId, context: { capability, obligationId: obligation.id } },
        ),
      );
    }
  }

  return findings;
}

export function validateCoverageCatalogue(catalogue: CoverageModelCatalogue): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  for (const model of catalogue.models) {
    findings.push(...validateCoverageModel(model));
  }
  return findings;
}
