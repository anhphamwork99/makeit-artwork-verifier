import {
  RELEASE_CREDIT_SCHEMA_VERSION,
  RELEASE_GATE_F_INTEGRITY_VALUES,
  RELEASE_OUTCOMES,
  type ReleaseActiveManifest,
  type ReleaseCreditAssessment,
  type ReleaseCreditIssueCode,
  type ReleaseExpectedManifest,
  type ReleaseRequiredEntry,
} from '../contracts/release-credit';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,179}$/;

const INPUT_FIELDS = [
  'schemaVersion',
  'gateF',
  'expectedManifest',
  'activeManifest',
  'requiredEntries',
  'work',
  'cleanup',
  'diagnosticPass',
] as const;

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

function hex(value: unknown): value is string {
  return typeof value === 'string' && HEX_256.test(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function pairKey(entryId: string, cellId: string): string {
  return `${entryId}\u0000${cellId}`;
}

function result(issues: readonly ReleaseCreditIssueCode[]): ReleaseCreditAssessment {
  const deduped = unique(issues);
  return { eligible: deduped.length === 0, issues: deduped, releaseCredit: false };
}

function validateRequiredEntries(
  value: unknown,
  issues: ReleaseCreditIssueCode[],
): ReleaseRequiredEntry[] {
  if (!Array.isArray(value) || !value.length) {
    issues.push('RELEASE_EXECUTION_MISSING');
    return [];
  }
  const entries: ReleaseRequiredEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = record(item);
    if (
      !entry ||
      !closed(entry, ['entryId', 'cellId', 'order']) ||
      !safe(entry.entryId) ||
      !safe(entry.cellId) ||
      !Number.isSafeInteger(entry.order) ||
      (entry.order as number) < 0
    ) {
      issues.push('RELEASE_EXECUTION');
      continue;
    }
    const key = pairKey(entry.entryId, entry.cellId);
    if (seen.has(key)) {
      issues.push('RELEASE_EXECUTION_DUPLICATE');
      continue;
    }
    seen.add(key);
    entries.push({ entryId: entry.entryId, cellId: entry.cellId, order: entry.order as number });
  }
  return entries;
}

/** Compares the observed work sequence against the frozen required sequence. */
function compareWorkOrder(
  required: readonly ReleaseRequiredEntry[],
  observed: readonly ReleaseRequiredEntry[],
  issues: ReleaseCreditIssueCode[],
): void {
  // The required sequence is the manifest's canonical global execution order, so
  // each required entry's declared `order` must be its canonical position. The
  // observed work must then match that sequence in both entry/cell pair and
  // numeric order; matching pairs alone is not enough.
  const canonical = required.every((entry, position) => entry.order === position);
  const aligned =
    canonical &&
    required.length === observed.length &&
    observed.every((entry, position) => {
      const expected = required[position]!;
      return (
        pairKey(entry.entryId, entry.cellId) === pairKey(expected.entryId, expected.cellId) &&
        entry.order === expected.order
      );
    });
  if (!aligned) issues.push('RELEASE_EXECUTION_ORDER');
}

/**
 * Fail-closed static Release-credit predicate. Every condition that the
 * specification makes necessary for credit is checked; a missing, unknown, or
 * contradictory condition denies eligibility with a stable issue code. Even an
 * input in which every predicate happens to pass returns `releaseCredit: false`.
 */
export function assessReleaseCredit(input: unknown): ReleaseCreditAssessment {
  const issues: ReleaseCreditIssueCode[] = [];
  try {
    const envelope = record(input);
    if (!envelope || !closed(envelope, INPUT_FIELDS)) return result(['RELEASE_SHAPE']);
    if (envelope.schemaVersion !== RELEASE_CREDIT_SCHEMA_VERSION) issues.push('RELEASE_SCHEMA');

    // Gate F: untrusted, caller-supplied predicate input; never proof of acceptance.
    const gateF = record(envelope.gateF);
    if (
      !gateF ||
      !closed(gateF, ['accepted', 'integrity']) ||
      typeof gateF.accepted !== 'boolean' ||
      !RELEASE_GATE_F_INTEGRITY_VALUES.includes(gateF.integrity as never)
    ) {
      issues.push('RELEASE_GATE_F');
    } else {
      if (gateF.accepted !== true) issues.push('RELEASE_GATE_F');
      if (gateF.integrity !== 'complete') issues.push('RELEASE_GATE_F_INTEGRITY');
    }

    // Active frozen manifest must match the governance-pinned expected identity.
    const expected = record(envelope.expectedManifest);
    const active = record(envelope.activeManifest);
    if (
      !expected ||
      !closed(expected, ['manifestId', 'contentFingerprint']) ||
      !safe(expected.manifestId) ||
      !hex(expected.contentFingerprint) ||
      !active ||
      !closed(active, ['manifestId', 'contentFingerprint', 'state', 'revision']) ||
      !safe(active.manifestId) ||
      !hex(active.contentFingerprint) ||
      typeof active.state !== 'string' ||
      !Number.isSafeInteger(active.revision)
    ) {
      issues.push('RELEASE_MANIFEST');
    } else {
      const expectedManifest = expected as unknown as ReleaseExpectedManifest;
      const activeManifest = active as unknown as ReleaseActiveManifest;
      if (activeManifest.state !== 'ACTIVE') issues.push('RELEASE_MANIFEST_STATE');
      if (
        activeManifest.manifestId !== expectedManifest.manifestId ||
        activeManifest.contentFingerprint !== expectedManifest.contentFingerprint
      ) {
        issues.push('RELEASE_MANIFEST_DRIFT');
      }
    }

    const required = validateRequiredEntries(envelope.requiredEntries, issues);
    const requiredKeys = new Set(required.map((entry) => pairKey(entry.entryId, entry.cellId)));
    const observed: ReleaseRequiredEntry[] = [];
    const counts = new Map<string, number>();

    if (!Array.isArray(envelope.work)) {
      issues.push('RELEASE_EXECUTION');
    } else {
      for (const item of envelope.work) {
        const work = record(item);
        if (
          !work ||
          !closed(work, [
            'entryId',
            'cellId',
            'order',
            'attempt',
            'skipped',
            'replaced',
            'outcome',
            'evidence',
          ]) ||
          !safe(work.entryId) ||
          !safe(work.cellId) ||
          !Number.isSafeInteger(work.order) ||
          !Number.isSafeInteger(work.attempt) ||
          typeof work.skipped !== 'boolean' ||
          typeof work.replaced !== 'boolean' ||
          !RELEASE_OUTCOMES.includes(work.outcome as never)
        ) {
          issues.push('RELEASE_EXECUTION');
          continue;
        }
        const key = pairKey(work.entryId, work.cellId);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        observed.push({ entryId: work.entryId, cellId: work.cellId, order: work.order as number });
        if (!requiredKeys.has(key)) issues.push('RELEASE_EXECUTION_EXTRA');
        if (work.skipped) issues.push('RELEASE_EXECUTION_SKIPPED');
        if (work.attempt !== 1) issues.push('RELEASE_EXECUTION_RETRIED');
        if (work.replaced) issues.push('RELEASE_EXECUTION_REPLACED');
        if (work.outcome !== 'PASS') issues.push('RELEASE_RESULT');
        const evidence = record(work.evidence);
        if (
          !evidence ||
          !closed(evidence, ['evidenceId', 'digest', 'complete', 'valid']) ||
          !safe(evidence.evidenceId) ||
          !hex(evidence.digest) ||
          evidence.complete !== true ||
          evidence.valid !== true
        ) {
          issues.push('RELEASE_EVIDENCE');
        }
      }
    }

    for (const entry of required) {
      const count = counts.get(pairKey(entry.entryId, entry.cellId)) ?? 0;
      if (count === 0) issues.push('RELEASE_EXECUTION_MISSING');
      else if (count > 1) issues.push('RELEASE_EXECUTION_DUPLICATE');
    }
    if (required.length) compareWorkOrder(required, observed, issues);

    const cleanup = record(envelope.cleanup);
    if (
      !cleanup ||
      !closed(cleanup, ['succeeded']) ||
      typeof cleanup.succeeded !== 'boolean' ||
      cleanup.succeeded !== true
    ) {
      issues.push('RELEASE_CLEANUP');
    }

    // A later Diagnostic PASS is never admissible repair for a Release decision.
    if (envelope.diagnosticPass !== undefined) {
      const diagnostic = record(envelope.diagnosticPass);
      if (!diagnostic || !closed(diagnostic, ['runId']) || !safe(diagnostic.runId)) {
        issues.push('RELEASE_SHAPE');
      }
      issues.push('RELEASE_DIAGNOSTIC_PASS');
    }

    return result(issues);
  } catch {
    return result([...issues, 'RELEASE_SHAPE']);
  }
}
