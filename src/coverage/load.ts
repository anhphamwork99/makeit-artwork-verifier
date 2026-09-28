import type {
  BindingCoverageModel,
  CoverageCombinationClassification,
  CoverageConstraint,
  CoverageFactor,
  CoverageFactorValue,
  CoverageModelCatalogue,
  CoverageObligation,
  CoverageObligationMatch,
  CoveragePartition,
  CoverageResidualPolicy,
  CoverageResidualSubmodel,
  CoverageScenario,
  CoverageUnsupportedCombination,
} from '../contracts/coverage';
import {
  COVERAGE_COMBINATION_CLASSIFICATIONS,
  COVERAGE_DEFAULT_RESIDUAL_STRENGTH,
  COVERAGE_MAX_RESIDUAL_STRENGTH,
  COVERAGE_OBLIGATION_KINDS,
  COVERAGE_PARTITION_VALIDITIES,
  COVERAGE_RESIDUAL_POLICY_KINDS,
  COVERAGE_SCENARIO_ELIGIBILITIES,
} from '../contracts/coverage';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import { isCapability, isExecutionProfile, isSubjectId } from '../contracts/discriminants';
import { COVERAGE_MODEL_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Strict Coverage Model catalogue loading (specification 7).
 *
 * The loader validates the closed structural contract and normalizes authoring
 * order that carries no meaning, so two equivalent authored catalogues produce
 * the same resolved models and fingerprints. Semantic references, partition
 * consistency, constraint satisfiability, and obligation satisfiability are
 * validated by `coverage/validate.ts`; structural malformation and duplicate
 * identifiers fail closed here with a structured diagnostic.
 */

export class CoverageCatalogueError extends Error {
  readonly diagnostic: DiagnosticRecord;

  constructor(diagnostic: DiagnosticRecord) {
    super(diagnostic.detail);
    this.name = 'CoverageCatalogueError';
    this.diagnostic = diagnostic;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: DiagnosticRecord['code'], detail: string): never {
  throw new CoverageCatalogueError(createDiagnostic(code, detail));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    fail('COVERAGE_CATALOGUE_INVALID', `${label} must be a boolean`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label} must be an array`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  return requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function requireScalar(value: unknown, label: string): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  fail('COVERAGE_CATALOGUE_INVALID', `${label} must be a finite string, number, or boolean`);
}

function requireAssignmentMap(value: unknown, label: string): Record<string, string> {
  const record = requireRecord(value, label);
  const entries = Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1));
  if (entries.length === 0) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label} must declare at least one factor assignment`);
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    result[key] = requireString(rawValue, `${label}.${key}`);
  }
  return result;
}

function assertUnique(kind: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    fail('COVERAGE_CATALOGUE_DUPLICATE', `Coverage catalogue declares a duplicate ${kind}`);
  }
}

function parseFactorValue(value: unknown, label: string): CoverageFactorValue {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    value: requireScalar(record.value, `${label}.value`),
    partition: requireString(record.partition, `${label}.partition`),
    boundary: requireBoolean(record.boundary, `${label}.boundary`),
  };
}

function parsePartition(value: unknown, label: string): CoveragePartition {
  const record = requireRecord(value, label);
  if (
    typeof record.validity !== 'string' ||
    !(COVERAGE_PARTITION_VALIDITIES as readonly string[]).includes(record.validity)
  ) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.validity is not a declared partition validity`);
  }
  return {
    id: requireString(record.id, `${label}.id`),
    values: sortedUnique(requireStringArray(record.values, `${label}.values`)),
    representative: requireString(record.representative, `${label}.representative`),
    boundaries: sortedUnique(requireStringArray(record.boundaries, `${label}.boundaries`)),
    validity: record.validity as CoveragePartition['validity'],
    rationale: requireString(record.rationale, `${label}.rationale`),
  };
}

function parseFactor(value: unknown, label: string): CoverageFactor {
  const record = requireRecord(value, label);
  const path = record.path;
  if (path !== null && (typeof path !== 'string' || !path.startsWith('/'))) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `${label}.path must be null or a JSON Pointer beginning with "/"`,
    );
  }
  const values = requireArray(record.values, `${label}.values`).map((entry, index) =>
    parseFactorValue(entry, `${label}.values[${index}]`),
  );
  if (values.length === 0) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.values must declare at least one value`);
  }
  assertUnique(
    `${label}.values.id`,
    values.map((entry) => entry.id),
  );
  const partitions = requireArray(record.partitions, `${label}.partitions`).map((entry, index) =>
    parsePartition(entry, `${label}.partitions[${index}]`),
  );
  if (partitions.length === 0) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.partitions must declare at least one partition`);
  }
  assertUnique(
    `${label}.partitions.id`,
    partitions.map((entry) => entry.id),
  );

  return {
    id: requireString(record.id, `${label}.id`),
    label: requireString(record.label, `${label}.label`),
    path: path === null ? null : path,
    allowsConcreteValues: requireBoolean(
      record.allowsConcreteValues,
      `${label}.allowsConcreteValues`,
    ),
    residual: requireBoolean(record.residual, `${label}.residual`),
    values: values.sort((left, right) => (left.id < right.id ? -1 : 1)),
    partitions: partitions.sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
}

function parseScenario(value: unknown, label: string): CoverageScenario {
  const record = requireRecord(value, label);
  if (
    typeof record.eligibility !== 'string' ||
    !(COVERAGE_SCENARIO_ELIGIBILITIES as readonly string[]).includes(record.eligibility)
  ) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `${label}.eligibility is not a declared scenario eligibility`,
    );
  }
  return {
    id: requireString(record.id, `${label}.id`),
    label: requireString(record.label, `${label}.label`),
    description: requireString(record.description, `${label}.description`),
    assignments: requireAssignmentMap(record.assignments, `${label}.assignments`),
    eligibility: record.eligibility as CoverageScenario['eligibility'],
  };
}

function parseConstraint(value: unknown, label: string): CoverageConstraint {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    exclude: requireAssignmentMap(record.exclude, `${label}.exclude`),
    rationale: requireString(record.rationale, `${label}.rationale`),
  };
}

function parseUnsupported(value: unknown, label: string): CoverageUnsupportedCombination {
  const record = requireRecord(value, label);
  if (
    typeof record.classification !== 'string' ||
    !(COVERAGE_COMBINATION_CLASSIFICATIONS as readonly string[]).includes(record.classification)
  ) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `${label}.classification is not a declared combination classification`,
    );
  }
  return {
    id: requireString(record.id, `${label}.id`),
    combination: requireAssignmentMap(record.combination, `${label}.combination`),
    classification: record.classification as CoverageCombinationClassification,
    rationale: requireString(record.rationale, `${label}.rationale`),
  };
}

function parseObligationMatch(value: unknown, label: string): CoverageObligationMatch {
  const record = requireRecord(value, label);
  switch (record.kind) {
    case 'scenario':
      return {
        kind: 'scenario',
        scenarioId: requireString(record.scenarioId, `${label}.scenarioId`),
      };
    case 'partition':
      return {
        kind: 'partition',
        factorId: requireString(record.factorId, `${label}.factorId`),
        partitionId: requireString(record.partitionId, `${label}.partitionId`),
      };
    case 'value':
      return {
        kind: 'value',
        factorId: requireString(record.factorId, `${label}.factorId`),
        valueId: requireString(record.valueId, `${label}.valueId`),
      };
    case 'tuple': {
      const values = requireArray(record.values, `${label}.values`).map((entry, index) => {
        const member = requireRecord(entry, `${label}.values[${index}]`);
        return {
          factorId: requireString(member.factorId, `${label}.values[${index}].factorId`),
          valueId: requireString(member.valueId, `${label}.values[${index}].valueId`),
        };
      });
      return { kind: 'tuple', values };
    }
    default:
      fail('COVERAGE_CATALOGUE_INVALID', `${label}.kind is not a declared obligation-match kind`);
  }
}

function parseObligation(value: unknown, label: string): CoverageObligation {
  const record = requireRecord(value, label);
  if (
    typeof record.kind !== 'string' ||
    !(COVERAGE_OBLIGATION_KINDS as readonly string[]).includes(record.kind)
  ) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.kind is not a declared obligation kind`);
  }
  if (!isExecutionProfile(record.requiredFor)) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.requiredFor is not a declared execution profile`);
  }
  return {
    id: requireString(record.id, `${label}.id`),
    kind: record.kind as CoverageObligation['kind'],
    description: requireString(record.description, `${label}.description`),
    requiredFor: record.requiredFor,
    match: parseObligationMatch(record.match, `${label}.match`),
  };
}

function parseSubmodel(value: unknown, label: string): CoverageResidualSubmodel {
  const record = requireRecord(value, label);
  const strength = record.strength;
  if (
    typeof strength !== 'number' ||
    !Number.isInteger(strength) ||
    strength < 2 ||
    strength > COVERAGE_MAX_RESIDUAL_STRENGTH
  ) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `${label}.strength must be an integer between 2 and ${COVERAGE_MAX_RESIDUAL_STRENGTH}`,
    );
  }
  return {
    id: requireString(record.id, `${label}.id`),
    strength,
    factors: sortedUnique(requireStringArray(record.factors, `${label}.factors`)),
    rationale: requireString(record.rationale, `${label}.rationale`),
  };
}

function parseResidual(value: unknown, label: string): CoverageResidualPolicy {
  const record = requireRecord(value, label);
  const rawPolicy = record.policy ?? 'constrained';
  if (
    typeof rawPolicy !== 'string' ||
    !(COVERAGE_RESIDUAL_POLICY_KINDS as readonly string[]).includes(rawPolicy)
  ) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.policy is not a declared residual policy kind`);
  }
  let rationale = '';
  if (record.rationale !== undefined) {
    if (typeof record.rationale !== 'string') {
      fail('COVERAGE_CATALOGUE_INVALID', `${label}.rationale must be a string`);
    }
    rationale = record.rationale;
  }
  if (rawPolicy === 'not-applicable' && rationale.trim().length === 0) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `${label} declares residual policy "not-applicable" without a non-empty rationale`,
    );
  }
  if (record.defaultStrength !== COVERAGE_DEFAULT_RESIDUAL_STRENGTH) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `${label}.defaultStrength must be the supported pairwise default ${COVERAGE_DEFAULT_RESIDUAL_STRENGTH}`,
    );
  }
  const submodels = requireArray(record.submodels, `${label}.submodels`).map((entry, index) =>
    parseSubmodel(entry, `${label}.submodels[${index}]`),
  );
  assertUnique(
    `${label}.submodels.id`,
    submodels.map((entry) => entry.id),
  );
  return {
    policy: rawPolicy as CoverageResidualPolicy['policy'],
    defaultStrength: COVERAGE_DEFAULT_RESIDUAL_STRENGTH,
    submodels: submodels.sort((left, right) => (left.id < right.id ? -1 : 1)),
    rationale,
  };
}

function parseModel(value: unknown, index: number): BindingCoverageModel {
  const label = `models[${index}]`;
  const record = requireRecord(value, label);
  const subjectId = requireString(record.subjectId, `${label}.subjectId`);
  if (!isSubjectId(subjectId)) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `${label}.subjectId must be an immutable lowercase slash-namespaced identity: "${subjectId}"`,
    );
  }
  if (!isCapability(record.capability)) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.capability is not a declared Capability`);
  }

  const factors = requireArray(record.factors, `${label}.factors`).map((entry, factorIndex) =>
    parseFactor(entry, `${label}.factors[${factorIndex}]`),
  );
  if (factors.length === 0) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.factors must declare at least one factor`);
  }
  assertUnique(
    `${label}.factors.id`,
    factors.map((entry) => entry.id),
  );

  const scenarios = requireArray(record.scenarios, `${label}.scenarios`).map(
    (entry, scenarioIndex) => parseScenario(entry, `${label}.scenarios[${scenarioIndex}]`),
  );
  if (scenarios.length === 0) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.scenarios must declare at least one scenario`);
  }
  assertUnique(
    `${label}.scenarios.id`,
    scenarios.map((entry) => entry.id),
  );

  const constraints = requireArray(record.constraints, `${label}.constraints`).map(
    (entry, constraintIndex) => parseConstraint(entry, `${label}.constraints[${constraintIndex}]`),
  );
  assertUnique(
    `${label}.constraints.id`,
    constraints.map((entry) => entry.id),
  );

  const unsupported = requireArray(record.unsupported, `${label}.unsupported`).map(
    (entry, unsupportedIndex) =>
      parseUnsupported(entry, `${label}.unsupported[${unsupportedIndex}]`),
  );
  assertUnique(
    `${label}.unsupported.id`,
    unsupported.map((entry) => entry.id),
  );

  const obligations = requireArray(record.obligations, `${label}.obligations`).map(
    (entry, obligationIndex) => parseObligation(entry, `${label}.obligations[${obligationIndex}]`),
  );
  if (obligations.length === 0) {
    fail('COVERAGE_CATALOGUE_INVALID', `${label}.obligations must declare at least one obligation`);
  }
  assertUnique(
    `${label}.obligations.id`,
    obligations.map((entry) => entry.id),
  );

  return {
    subjectId,
    capability: record.capability,
    baselineScenarioId: requireString(record.baselineScenarioId, `${label}.baselineScenarioId`),
    factors: [...factors].sort((left, right) => (left.id < right.id ? -1 : 1)),
    scenarios: [...scenarios].sort((left, right) => (left.id < right.id ? -1 : 1)),
    constraints: [...constraints].sort((left, right) => (left.id < right.id ? -1 : 1)),
    unsupported: [...unsupported].sort((left, right) => (left.id < right.id ? -1 : 1)),
    obligations: [...obligations].sort((left, right) => (left.id < right.id ? -1 : 1)),
    residual: parseResidual(record.residual, `${label}.residual`),
  };
}

export function parseCoverageModelCatalogue(raw: unknown): CoverageModelCatalogue {
  const record = requireRecord(raw, 'Coverage Model catalogue');
  if (record.schemaVersion !== COVERAGE_MODEL_SCHEMA_VERSION) {
    fail(
      'COVERAGE_CATALOGUE_INVALID',
      `Unsupported Coverage Model catalogue schema version: ${String(record.schemaVersion)}`,
    );
  }
  const models = requireArray(record.models, 'models').map(parseModel);
  assertUnique(
    'binding model (subjectId × capability)',
    models.map((model) => `${model.subjectId}\u0000${model.capability}`),
  );
  return {
    schemaVersion: record.schemaVersion,
    models: [...models].sort((left, right) =>
      left.subjectId === right.subjectId
        ? left.capability < right.capability
          ? -1
          : 1
        : left.subjectId < right.subjectId
          ? -1
          : 1,
    ),
  };
}
