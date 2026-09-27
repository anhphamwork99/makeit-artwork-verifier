/**
 * Explicit historical run-record legacy reader surface (ADR 0011 R11;
 * ADR 0019 R11; ADR 0031 §"Public export closure"; ADR 0032 §E3-S2).
 *
 * E3-S2 removes the boolean/v3 current reader authority. The current run record
 * is the strict v4 public child/command record read through
 * `contracts/final-record-reader.ts`/`evidence/final-reader.ts`, and the only
 * accepted current label is `current-v4`.
 *
 * This module is the *explicitly named historical/legacy* surface that survives:
 * it is read-only, labels v1/v2/v3 as legacy, preserves every recorded value
 * exactly, and never converts a historical `passed:false` into a current
 * three-state meaning. It can never satisfy current acceptance, produces no
 * current label, and writes nothing.
 */

/** Historical schema-v1 label: an immutable unredacted prior-slice projection. */
export const LEGACY_V1_LABEL = 'legacy-unredacted-v1';
/** Historical schema-v2 label: an accepted pre-5F public projection. */
export const ACCEPTED_PRE_5F_V2_LABEL = 'accepted-pre-5F-public-projection';
/** Historical schema-v3 label: the former current projection, now legacy. */
export const LEGACY_V3_LABEL = 'legacy-v3';

interface ClassifiedLegacyRunRecordBase {
  /** Always true: no legacy record can be current. */
  legacy: true;
  current: false;
  /** Historical booleans are ambiguous under three-state semantics. */
  ambiguous: true;
  schemaVersion: number;
  record: Readonly<Record<string, unknown>>;
}

export interface ClassifiedLegacyRunRecordV1 extends ClassifiedLegacyRunRecordBase {
  kind: 'legacy-v1';
  label: typeof LEGACY_V1_LABEL;
  schemaVersion: 1;
}

export interface ClassifiedLegacyRunRecordV2 extends ClassifiedLegacyRunRecordBase {
  kind: 'legacy-v2';
  label: typeof ACCEPTED_PRE_5F_V2_LABEL;
  schemaVersion: 2;
}

export interface ClassifiedLegacyRunRecordV3 extends ClassifiedLegacyRunRecordBase {
  kind: 'legacy-v3';
  label: typeof LEGACY_V3_LABEL;
  schemaVersion: 3;
}

export interface ClassifiedLegacyRunRecordUnknown {
  kind: 'unknown';
  label: 'unknown-schema';
  legacy: false;
  current: false;
  ambiguous: false;
  schemaVersion: unknown;
  record: null;
}

export type LegacyRunRecordClassification =
  | ClassifiedLegacyRunRecordV1
  | ClassifiedLegacyRunRecordV2
  | ClassifiedLegacyRunRecordV3
  | ClassifiedLegacyRunRecordUnknown;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function legacy(
  version: 1 | 2 | 3,
  record: Record<string, unknown>,
): ClassifiedLegacyRunRecordV1 | ClassifiedLegacyRunRecordV2 | ClassifiedLegacyRunRecordV3 {
  if (version === 1) {
    return {
      kind: 'legacy-v1',
      label: LEGACY_V1_LABEL,
      legacy: true,
      current: false,
      ambiguous: true,
      schemaVersion: 1,
      record,
    };
  }
  if (version === 2) {
    return {
      kind: 'legacy-v2',
      label: ACCEPTED_PRE_5F_V2_LABEL,
      legacy: true,
      current: false,
      ambiguous: true,
      schemaVersion: 2,
      record,
    };
  }
  return {
    kind: 'legacy-v3',
    label: LEGACY_V3_LABEL,
    legacy: true,
    current: false,
    ambiguous: true,
    schemaVersion: 3,
    record,
  };
}

/**
 * Discriminates an already-parsed historical v1/v2/v3 record without coercing
 * it. Any other schema version, including the current strict v4 record, is
 * reported as unknown here: this surface never reads a current record and never
 * claims currentness.
 */
export function classifyLegacyRunRecord(value: unknown): LegacyRunRecordClassification {
  const record = asRecord(value);
  if (record === null) {
    return {
      kind: 'unknown',
      label: 'unknown-schema',
      legacy: false,
      current: false,
      ambiguous: false,
      schemaVersion: undefined,
      record: null,
    };
  }
  const schemaVersion = record.schemaVersion;
  if (schemaVersion === 1 || schemaVersion === 2 || schemaVersion === 3) {
    return legacy(schemaVersion, record);
  }
  return {
    kind: 'unknown',
    label: 'unknown-schema',
    legacy: false,
    current: false,
    ambiguous: false,
    schemaVersion,
    record: null,
  };
}

/**
 * Fail-closed parse: an unknown or current schema version is rejected rather
 * than coerced. Only a historical v1/v2/v3 record is returned, always labelled
 * legacy and ambiguous, and never as current evidence.
 */
export function parseLegacyRunRecordOrThrow(
  value: unknown,
): ClassifiedLegacyRunRecordV1 | ClassifiedLegacyRunRecordV2 | ClassifiedLegacyRunRecordV3 {
  const classification = classifyLegacyRunRecord(value);
  if (classification.kind === 'unknown') {
    throw new Error(
      `Unsupported historical run-record schema ${String(classification.schemaVersion)}; refusing to coerce it.`,
    );
  }
  return classification;
}
