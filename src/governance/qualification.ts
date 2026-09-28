import {
  deriveGovernanceIdentity,
  GOVERNANCE_IDENTITY_DOMAINS,
} from '../canonical/governance-identity';
import {
  QUALIFICATION_INSTANCES_PER_CELL,
  QUALIFICATION_OUTCOMES,
  QUALIFICATION_SCHEMA_VERSION,
  type QualificationBatch,
  type QualificationBatchCreation,
  type QualificationEvaluation,
  type QualificationInstance,
  type QualificationIssueCode,
} from '../contracts/qualification';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,179}$/;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null ? (value as RecordValue) : undefined;
}

function closed(value: RecordValue, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function safe(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REFERENCE.test(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function fail(issues: readonly QualificationIssueCode[]): QualificationBatchCreation {
  return { valid: false, batch: null, issues: unique(issues), releaseCredit: false };
}

/** Ordered expected instances: cells in canonical order, instances in frozen order. */
function expectedInstances(batch: QualificationBatch): readonly QualificationInstance[] {
  return batch.cells.flatMap((cell) => cell.instances);
}

/** Structural and identity validation of an already-created batch. */
function validateBatch(batch: unknown): QualificationIssueCode[] {
  const issues: QualificationIssueCode[] = [];
  const record_ = record(batch);
  if (
    !record_ ||
    !closed(record_, [
      'schemaVersion',
      'candidateManifestId',
      'candidateFingerprint',
      'cells',
      'batchFingerprint',
    ])
  ) {
    return ['QUALIFICATION_SHAPE'];
  }
  if (record_.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) issues.push('QUALIFICATION_SCHEMA');
  if (!safe(record_.candidateManifestId)) issues.push('QUALIFICATION_CANDIDATE');
  if (
    typeof record_.candidateFingerprint !== 'string' ||
    !HEX_256.test(record_.candidateFingerprint)
  ) {
    issues.push('QUALIFICATION_CANDIDATE');
  }
  if (!Array.isArray(record_.cells) || !record_.cells.length) {
    return unique([...issues, 'QUALIFICATION_CELLS']);
  }
  const cellIds = new Set<string>();
  const instanceIds = new Set<string>();
  for (const value of record_.cells) {
    const cell = record(value);
    if (!cell || !closed(cell, ['cellId', 'instances']) || !safe(cell.cellId)) {
      issues.push('QUALIFICATION_CELLS');
      continue;
    }
    if (cellIds.has(cell.cellId)) issues.push('QUALIFICATION_ALLOCATION');
    cellIds.add(cell.cellId);
    if (
      !Array.isArray(cell.instances) ||
      cell.instances.length !== QUALIFICATION_INSTANCES_PER_CELL
    ) {
      issues.push('QUALIFICATION_ALLOCATION');
      continue;
    }
    for (const [position, item] of cell.instances.entries()) {
      const instance = record(item);
      if (
        !instance ||
        !closed(instance, ['instanceId', 'cellId', 'order']) ||
        !safe(instance.instanceId) ||
        instance.cellId !== cell.cellId ||
        instance.order !== position
      ) {
        issues.push('QUALIFICATION_ALLOCATION');
        continue;
      }
      if (instanceIds.has(instance.instanceId)) issues.push('QUALIFICATION_ALLOCATION');
      instanceIds.add(instance.instanceId);
    }
  }
  if (issues.length) return unique(issues);
  if (typeof record_.batchFingerprint !== 'string' || !HEX_256.test(record_.batchFingerprint)) {
    issues.push('QUALIFICATION_BATCH_IDENTITY');
  } else if (
    deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.qualificationBatch, {
      schemaVersion: record_.schemaVersion,
      candidateManifestId: record_.candidateManifestId,
      candidateFingerprint: record_.candidateFingerprint,
      cells: record_.cells,
    }) !== record_.batchFingerprint
  ) {
    issues.push('QUALIFICATION_BATCH_IDENTITY');
  }
  return unique(issues);
}

/**
 * Freezes a fixed three-instance batch per required cell before any result
 * exists. Set-like cell membership is normalized to canonical order; the
 * instance order inside each cell is fixed and significant.
 */
export function createQualificationBatch(
  candidate: unknown,
  requiredCells: unknown,
): QualificationBatchCreation {
  const issues: QualificationIssueCode[] = [];
  const candidateRecord = record(candidate);
  if (
    !candidateRecord ||
    !closed(candidateRecord, ['manifestId', 'contentFingerprint']) ||
    !safe(candidateRecord.manifestId) ||
    typeof candidateRecord.contentFingerprint !== 'string' ||
    !HEX_256.test(candidateRecord.contentFingerprint)
  ) {
    return fail(['QUALIFICATION_CANDIDATE']);
  }
  if (!Array.isArray(requiredCells)) return fail(['QUALIFICATION_CELLS']);
  const cellIds: string[] = [];
  for (const value of requiredCells) {
    if (!safe(value) || cellIds.includes(value)) {
      issues.push('QUALIFICATION_CELLS');
      continue;
    }
    cellIds.push(value);
  }
  if (!cellIds.length) issues.push('QUALIFICATION_CELLS');
  if (issues.length) return fail(issues);

  const manifestId = candidateRecord.manifestId;
  const candidateFingerprint = candidateRecord.contentFingerprint;
  const cells = [...cellIds]
    .sort((a, b) => a.localeCompare(b))
    .map((cellId) =>
      Object.freeze({
        cellId,
        instances: Object.freeze(
          Array.from({ length: QUALIFICATION_INSTANCES_PER_CELL }, (_, order) =>
            Object.freeze({
              instanceId: deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.qualificationBatch, {
                candidateManifestId: manifestId,
                candidateFingerprint,
                cellId,
                order,
              }),
              cellId,
              order,
            }),
          ),
        ),
      }),
    );
  const batchFingerprint = deriveGovernanceIdentity(
    GOVERNANCE_IDENTITY_DOMAINS.qualificationBatch,
    {
      schemaVersion: QUALIFICATION_SCHEMA_VERSION,
      candidateManifestId: manifestId,
      candidateFingerprint,
      cells,
    },
  );
  const batch: QualificationBatch = Object.freeze({
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    candidateManifestId: manifestId,
    candidateFingerprint,
    cells: Object.freeze(cells),
    batchFingerprint,
  });
  return { valid: true, batch, issues: [], releaseCredit: false };
}

/**
 * Adjudicates a fixed batch against observed results. Results must be complete,
 * unique, an exact set in the frozen canonical order, and all `PASS`; missing,
 * duplicate, extra, reordered, or non-`PASS` input fails closed. There is no
 * append, filter, or retry-to-green path.
 */
export function evaluateQualificationBatch(
  batch: unknown,
  results: unknown,
): QualificationEvaluation {
  const batchIssues = validateBatch(batch);
  if (batchIssues.length) {
    return { admitted: false, issues: batchIssues, releaseCredit: false };
  }
  const frozen = batch as QualificationBatch;
  if (!Array.isArray(results)) {
    return { admitted: false, issues: ['QUALIFICATION_RESULTS_SHAPE'], releaseCredit: false };
  }

  const issues: QualificationIssueCode[] = [];
  const expected = expectedInstances(frozen);
  const expectedById = new Map(expected.map((instance) => [instance.instanceId, instance]));
  const counts = new Map<string, number>();
  const sequence: string[] = [];

  for (const value of results) {
    const item = record(value);
    if (
      !item ||
      !closed(item, ['instanceId', 'cellId', 'order', 'outcome']) ||
      !safe(item.instanceId) ||
      !safe(item.cellId) ||
      !Number.isSafeInteger(item.order) ||
      !QUALIFICATION_OUTCOMES.includes(item.outcome as never)
    ) {
      issues.push('QUALIFICATION_RESULTS_SHAPE');
      continue;
    }
    counts.set(item.instanceId, (counts.get(item.instanceId) ?? 0) + 1);
    sequence.push(item.instanceId);
    const match = expectedById.get(item.instanceId);
    if (!match || match.cellId !== item.cellId || match.order !== item.order) {
      issues.push('QUALIFICATION_EXTRA');
      continue;
    }
    if (item.outcome !== 'PASS') issues.push('QUALIFICATION_RESULT');
  }

  for (const instance of expected) {
    const count = counts.get(instance.instanceId) ?? 0;
    if (count === 0) issues.push('QUALIFICATION_MISSING');
    else if (count > 1) issues.push('QUALIFICATION_DUPLICATE');
  }
  if (sequence.length > expected.length) issues.push('QUALIFICATION_EXTRA');
  if (
    sequence.length === expected.length &&
    sequence.some((instanceId, position) => instanceId !== expected[position]!.instanceId)
  ) {
    issues.push('QUALIFICATION_ORDER');
  }

  const deduped = unique(issues);
  return { admitted: deduped.length === 0, issues: deduped, releaseCredit: false };
}
