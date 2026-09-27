import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { IDENTITY_DOMAINS, domainSeparatedDigest, identityDigest } from '../canonical/canonicalize';
import type { Capability } from '../contracts/discriminants';
import { isCapability } from '../contracts/discriminants';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import {
  CAPTURE_SOURCE_ROLES,
  CHECK_EVALUATORS,
  CURRENTNESS_IDENTITIES,
  DEADLINE_CATEGORIES,
  NORMALIZATION_APPLICABILITIES,
  NORMALIZATION_COMBINATION,
  NORMALIZATION_EVALUATORS,
  NORMALIZATION_MEANING_REFS,
  ORACLE_EVALUATOR_KINDS,
  TOLERANCE_ALGORITHMS,
  VISUAL_ALGORITHMS,
  VISUAL_AUTHORITY_ROLES,
  VISUAL_BOUNDED_REGIONS,
  VISUAL_COMBINATIONS,
  VISUAL_EVIDENCE_SOURCES,
  VISUAL_MODES,
  type BindingCorrectnessLedgerEntry,
  type CapabilityBaselineDeclaration,
  type CaptureDeclaration,
  type CaptureSourceDeclaration,
  type CorrectnessCatalogue,
  type CorrectnessComponentFingerprints,
  type CorrectnessReferenceEntry,
  type NonWeakeningAssertion,
  type NormalizationDeclaration,
  type OracleCheckDeclaration,
  type OracleDeclaration,
  type ReadinessDeclaration,
  type ResolvedCheckContract,
  type ResolvedCorrectnessProfile,
  type ResolvedNormalization,
  type RouteProfileSelectionDeclaration,
  type SubjectAdditionDeclaration,
  type ToleranceDeclaration,
  type VisualAuthorityDeclaration,
  type VisualCombination,
} from '../contracts/correctness';
import {
  CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
  RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * Package 7 Slice A strict correctness-catalogue loader, reference-closure
 * resolver, composition compiler, and domain-separated fingerprints (ADR 0023).
 *
 * The catalogue is authored data. This module validates it, normalizes authoring
 * order that carries no meaning (semantically unordered collections only), and
 * fails closed on any unknown key/version/discriminant, duplicate identity,
 * dangling or multiply resolving reference, incompatible tolerance/units
 * pairing, and non-weakening violation.
 *
 * Ordered policy data — the readiness fallback cadence and capture bracketing
 * sequence — deliberately retains order and fingerprints differently when
 * reordered. Nothing here branches on Subject name, family, application kind,
 * scenario, or variant; a route is selected purely through catalogue data.
 */

export type CorrectnessCatalogueErrorCode =
  | 'CORRECTNESS_CATALOGUE_FILE_MISSING'
  | 'CORRECTNESS_CATALOGUE_FILE_UNREADABLE'
  | 'CORRECTNESS_CATALOGUE_JSON_INVALID'
  | 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED'
  | 'CORRECTNESS_CATALOGUE_SHAPE_INVALID'
  | 'CORRECTNESS_CATALOGUE_DUPLICATE';

export class CorrectnessCatalogueError extends Error {
  readonly code: CorrectnessCatalogueErrorCode;

  constructor(code: CorrectnessCatalogueErrorCode, message: string) {
    super(message);
    this.name = 'CorrectnessCatalogueError';
    this.code = code;
  }
}

export const CORRECTNESS_CATALOGUE_FILES = {
  readiness: 'catalogues/readiness/readiness-profiles.v1.json',
  capture: 'catalogues/capture/capture-profiles.v1.json',
  oracles: 'catalogues/oracles/oracle-profiles.v1.json',
  composition: 'catalogues/oracles/capability-baselines.v1.json',
  routeSelections: 'catalogues/oracles/route-selections.v1.json',
  tolerances: 'catalogues/tolerances/tolerances.v1.json',
  visuals: 'catalogues/visual/visual-authority.v1.json',
  normalization: 'catalogues/normalization/normalization.v1.json',
} as const;

const SKILL_ROOT_RELATIVE_PATH = path.join('.pi', 'skills', 'verify-artwork-editor');

function resolveSkillRoot(): string {
  const moduleUrl = import.meta.url;
  if (typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')) {
    return fileURLToPath(new URL('../../', moduleUrl));
  }
  return path.resolve(process.cwd(), SKILL_ROOT_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: CorrectnessCatalogueErrorCode, message: string): never {
  throw new CorrectnessCatalogueError(code, message);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(
        'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
        `${label} declares unknown key "${key}" (allowed: ${allowed.join(', ')})`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label} is missing required key "${key}"`);
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label} must be a boolean`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label} must be a positive integer`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label} must be a finite number`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label} must be an array`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  return requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`),
  );
}

/** Requires a closed vocabulary member; unknown discriminants fail closed. */
function requireMember<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    fail(
      'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
      `${label} must be one of: ${values.join(', ')} (received ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

/** Sorted-unique for an unordered collection, rejecting an exact duplicate. */
function sortedUnique(values: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail('CORRECTNESS_CATALOGUE_DUPLICATE', `${label} declares duplicate entry "${value}"`);
    }
    seen.add(value);
  }
  return [...values].sort();
}

function requireVersion(value: unknown, expected: number, label: string): number {
  if (value !== expected) {
    fail(
      'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
      `${label} declares unsupported schema version ${String(value)} (expected ${expected})`,
    );
  }
  return expected;
}

/** Requires a SHA-256-shaped value where the contract declares a fingerprint. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function variantKey(variant: string | null): string {
  return variant === null ? '\u0000null' : variant;
}

function routeKey(subjectId: string, capability: Capability, variant: string | null): string {
  return `${subjectId}\u0000${capability}\u0000${variantKey(variant)}`;
}

function compareByKey<T>(key: (entry: T) => string): (left: T, right: T) => number {
  return (left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  };
}

function rejectIdentityDuplicates(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      fail('CORRECTNESS_CATALOGUE_DUPLICATE', `${label} declares duplicate identity "${id}"`);
    }
    seen.add(id);
  }
}

// ── Parsers ─────────────────────────────────────────────────────────────────

const READINESS_KEYS = [
  'schemaVersion',
  'profileId',
  'version',
  'deadlineCategory',
  'deadlineMs',
  'signalWatchdogMs',
  'fallbackCadenceMs',
  'stableFrames',
  'quiescenceRequired',
  'stableFrameRequired',
  'currentnessIdentities',
  'captureProfileId',
  'oracleProfileId',
] as const;

function parseReadinessDeclaration(value: unknown, index: number): ReadinessDeclaration {
  const label = `readiness[${index}]`;
  const record = requireRecord(value, label);
  exactKeys(record, READINESS_KEYS, label);
  const fallbackCadenceMs = requireArray(
    record.fallbackCadenceMs,
    `${label}.fallbackCadenceMs`,
  ).map((entry, entryIndex) =>
    requirePositiveInteger(entry, `${label}.fallbackCadenceMs[${entryIndex}]`),
  );
  if (fallbackCadenceMs.length === 0) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label}.fallbackCadenceMs must not be empty`);
  }
  const currentnessIdentities = sortedUnique(
    requireStringArray(record.currentnessIdentities, `${label}.currentnessIdentities`).map(
      (entry, entryIndex) =>
        requireMember(
          entry,
          CURRENTNESS_IDENTITIES,
          `${label}.currentnessIdentities[${entryIndex}]`,
        ),
    ),
    `${label}.currentnessIdentities`,
  );
  return Object.freeze({
    schemaVersion: requireVersion(
      record.schemaVersion,
      CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
      label,
    ),
    profileId: requireString(record.profileId, `${label}.profileId`),
    version: requirePositiveInteger(record.version, `${label}.version`),
    deadlineCategory: requireMember(
      record.deadlineCategory,
      DEADLINE_CATEGORIES,
      `${label}.deadlineCategory`,
    ),
    deadlineMs: requirePositiveInteger(record.deadlineMs, `${label}.deadlineMs`),
    signalWatchdogMs: requirePositiveInteger(record.signalWatchdogMs, `${label}.signalWatchdogMs`),
    fallbackCadenceMs,
    stableFrames: requirePositiveInteger(record.stableFrames, `${label}.stableFrames`),
    quiescenceRequired: requireBoolean(record.quiescenceRequired, `${label}.quiescenceRequired`),
    stableFrameRequired: requireBoolean(record.stableFrameRequired, `${label}.stableFrameRequired`),
    currentnessIdentities,
    captureProfileId: requireString(record.captureProfileId, `${label}.captureProfileId`),
    oracleProfileId: requireString(record.oracleProfileId, `${label}.oracleProfileId`),
  });
}

const CAPTURE_KEYS = [
  'schemaVersion',
  'captureProfileId',
  'version',
  'requiredSources',
  'bracketing',
  'acceptedObservationRule',
  'tornCandidateHandling',
  'evidenceItemIds',
] as const;

const CAPTURE_SOURCE_KEYS = ['sourceId', 'role', 'currentness', 'required'] as const;

function parseCaptureSource(value: unknown, label: string): CaptureSourceDeclaration {
  const record = requireRecord(value, label);
  exactKeys(record, CAPTURE_SOURCE_KEYS, label);
  const currentness = sortedUnique(
    requireStringArray(record.currentness, `${label}.currentness`).map((entry, index) =>
      requireMember(entry, CURRENTNESS_IDENTITIES, `${label}.currentness[${index}]`),
    ),
    `${label}.currentness`,
  );
  return Object.freeze({
    sourceId: requireString(record.sourceId, `${label}.sourceId`),
    role: requireMember(record.role, CAPTURE_SOURCE_ROLES, `${label}.role`),
    currentness,
    required: requireBoolean(record.required, `${label}.required`),
  });
}

function parseCaptureDeclaration(value: unknown, index: number): CaptureDeclaration {
  const label = `captures[${index}]`;
  const record = requireRecord(value, label);
  exactKeys(record, CAPTURE_KEYS, label);
  const requiredSources = requireArray(record.requiredSources, `${label}.requiredSources`)
    .map((entry, entryIndex) =>
      parseCaptureSource(entry, `${label}.requiredSources[${entryIndex}]`),
    )
    .sort(compareByKey((entry) => entry.sourceId));
  rejectIdentityDuplicates(
    requiredSources.map((entry) => entry.sourceId),
    `${label}.requiredSources`,
  );
  const bracketing = requireStringArray(record.bracketing, `${label}.bracketing`);
  if (bracketing.length === 0) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label}.bracketing must not be empty`);
  }
  const evidenceItemIds = sortedUnique(
    requireStringArray(record.evidenceItemIds, `${label}.evidenceItemIds`),
    `${label}.evidenceItemIds`,
  );
  return Object.freeze({
    schemaVersion: requireVersion(
      record.schemaVersion,
      CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
      label,
    ),
    captureProfileId: requireString(record.captureProfileId, `${label}.captureProfileId`),
    version: requirePositiveInteger(record.version, `${label}.version`),
    requiredSources,
    bracketing,
    acceptedObservationRule: requireString(
      record.acceptedObservationRule,
      `${label}.acceptedObservationRule`,
    ),
    tornCandidateHandling: requireString(
      record.tornCandidateHandling,
      `${label}.tornCandidateHandling`,
    ),
    evidenceItemIds,
  });
}

const ORACLE_KEYS = [
  'schemaVersion',
  'oracleProfileId',
  'version',
  'evaluatorKind',
  'checks',
  'diagnosticOnlyEvidence',
] as const;

const CHECK_KEYS = [
  'checkId',
  'evaluator',
  'expectedSchema',
  'actualSchema',
  'requiredEvidence',
  'toleranceRefs',
  'visualRefs',
  'normalizationRef',
] as const;

function parseOracleCheck(value: unknown, label: string): OracleCheckDeclaration {
  const record = requireRecord(value, label);
  exactKeys(record, CHECK_KEYS, label);
  const normalizationRaw = record.normalizationRef;
  if (normalizationRaw !== null && typeof normalizationRaw !== 'string') {
    fail(
      'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
      `${label}.normalizationRef must be a string or null`,
    );
  }
  return Object.freeze({
    checkId: requireString(record.checkId, `${label}.checkId`),
    evaluator: requireMember(record.evaluator, CHECK_EVALUATORS, `${label}.evaluator`),
    expectedSchema: requireString(record.expectedSchema, `${label}.expectedSchema`),
    actualSchema: requireString(record.actualSchema, `${label}.actualSchema`),
    requiredEvidence: sortedUnique(
      requireStringArray(record.requiredEvidence, `${label}.requiredEvidence`),
      `${label}.requiredEvidence`,
    ),
    toleranceRefs: sortedUnique(
      requireStringArray(record.toleranceRefs, `${label}.toleranceRefs`),
      `${label}.toleranceRefs`,
    ),
    visualRefs: sortedUnique(
      requireStringArray(record.visualRefs, `${label}.visualRefs`),
      `${label}.visualRefs`,
    ),
    normalizationRef:
      normalizationRaw === null
        ? null
        : requireString(normalizationRaw, `${label}.normalizationRef`),
  });
}

function parseOracleDeclaration(value: unknown, index: number): OracleDeclaration {
  const label = `oracles[${index}]`;
  const record = requireRecord(value, label);
  exactKeys(record, ORACLE_KEYS, label);
  const checks = requireArray(record.checks, `${label}.checks`)
    .map((entry, entryIndex) => parseOracleCheck(entry, `${label}.checks[${entryIndex}]`))
    .sort(compareByKey((entry) => entry.checkId));
  if (checks.length === 0) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label}.checks must not be empty`);
  }
  rejectIdentityDuplicates(
    checks.map((entry) => entry.checkId),
    `${label}.checks`,
  );
  return Object.freeze({
    schemaVersion: requireVersion(
      record.schemaVersion,
      CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
      label,
    ),
    oracleProfileId: requireString(record.oracleProfileId, `${label}.oracleProfileId`),
    version: requirePositiveInteger(record.version, `${label}.version`),
    evaluatorKind: requireMember(
      record.evaluatorKind,
      ORACLE_EVALUATOR_KINDS,
      `${label}.evaluatorKind`,
    ),
    checks,
    diagnosticOnlyEvidence: sortedUnique(
      requireStringArray(record.diagnosticOnlyEvidence, `${label}.diagnosticOnlyEvidence`),
      `${label}.diagnosticOnlyEvidence`,
    ),
  });
}

function parseTolerance(value: unknown, index: number): ToleranceDeclaration {
  const label = `tolerances[${index}]`;
  const record = requireRecord(value, label);
  exactKeys(
    record,
    [
      'toleranceId',
      'version',
      'algorithm',
      'units',
      'value',
      'parameters',
      'rationale',
      'compatibilityDomain',
    ],
    label,
  );
  const valueRaw = record.value;
  if (valueRaw !== null && (typeof valueRaw !== 'number' || !Number.isFinite(valueRaw))) {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label}.value must be a finite number or null`);
  }
  const parametersRaw = record.parameters;
  let parameters: Readonly<Record<string, number>> | null = null;
  if (parametersRaw !== null) {
    const parameterRecord = requireRecord(parametersRaw, `${label}.parameters`);
    const parsed: Record<string, number> = {};
    for (const [key, entry] of Object.entries(parameterRecord)) {
      parsed[key] = requireNumber(entry, `${label}.parameters.${key}`);
    }
    parameters = Object.freeze(parsed);
  }
  if (valueRaw === null && parameters === null) {
    fail(
      'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
      `${label} must declare a value or a closed parameter set`,
    );
  }
  return Object.freeze({
    toleranceId: requireString(record.toleranceId, `${label}.toleranceId`),
    version: requirePositiveInteger(record.version, `${label}.version`),
    algorithm: requireMember(record.algorithm, TOLERANCE_ALGORITHMS, `${label}.algorithm`),
    units: requireString(record.units, `${label}.units`),
    value: valueRaw === null ? null : requireNumber(valueRaw, `${label}.value`),
    parameters,
    rationale: requireString(record.rationale, `${label}.rationale`),
    compatibilityDomain: requireString(record.compatibilityDomain, `${label}.compatibilityDomain`),
  });
}

function parseVisual(value: unknown, index: number): VisualAuthorityDeclaration {
  const label = `visuals[${index}]`;
  const record = requireRecord(value, label);
  exactKeys(
    record,
    [
      'visualId',
      'version',
      'mode',
      'algorithm',
      'evidenceSource',
      'authorityRole',
      'toleranceRef',
      'boundedRegion',
      'currentness',
    ],
    label,
  );
  const toleranceRef = record.toleranceRef;
  if (toleranceRef !== null && typeof toleranceRef !== 'string') {
    fail('CORRECTNESS_CATALOGUE_SHAPE_INVALID', `${label}.toleranceRef must be a string or null`);
  }
  const declaration: VisualAuthorityDeclaration = Object.freeze({
    visualId: requireString(record.visualId, `${label}.visualId`),
    version: requirePositiveInteger(record.version, `${label}.version`),
    mode: requireMember(record.mode, VISUAL_MODES, `${label}.mode`),
    algorithm: requireMember(record.algorithm, VISUAL_ALGORITHMS, `${label}.algorithm`),
    evidenceSource: requireMember(
      record.evidenceSource,
      VISUAL_EVIDENCE_SOURCES,
      `${label}.evidenceSource`,
    ),
    authorityRole: requireMember(
      record.authorityRole,
      VISUAL_AUTHORITY_ROLES,
      `${label}.authorityRole`,
    ),
    toleranceRef:
      toleranceRef === null ? null : requireString(toleranceRef, `${label}.toleranceRef`),
    boundedRegion: requireMember(
      record.boundedRegion,
      VISUAL_BOUNDED_REGIONS,
      `${label}.boundedRegion`,
    ),
    currentness: sortedUnique(
      requireStringArray(record.currentness, `${label}.currentness`).map((entry, entryIndex) =>
        requireMember(entry, CURRENTNESS_IDENTITIES, `${label}.currentness[${entryIndex}]`),
      ),
      `${label}.currentness`,
    ),
  });
  // Cross-field closure: the individual discriminants above may each be known
  // while the combination is not. ADR 0024 §5 rejects any tuple that is not an
  // approved combination, including a diagnostic screenshot carrying an
  // authoritative tolerance, a structural probe marked diagnostic-only, a
  // missing structural tolerance, and a bounded capture with a tolerance.
  assertApprovedVisualCombination(declaration, label);
  return declaration;
}

/**
 * Rejects any visual (mode, algorithm, evidenceSource, authorityRole, region)
 * tuple absent from {@link VISUAL_COMBINATIONS}, and enforces the declared
 * tolerance-presence rule (structural requires a tolerance; bounded capture
 * permits none). A known-individual / unknown-combination state fails closed.
 */
function assertApprovedVisualCombination(
  declaration: VisualAuthorityDeclaration,
  label: string,
): void {
  const matching = VISUAL_COMBINATIONS.filter(
    (combination) =>
      combination.mode === declaration.mode &&
      combination.algorithm === declaration.algorithm &&
      combination.evidenceSource === declaration.evidenceSource &&
      combination.authorityRole === declaration.authorityRole &&
      combination.boundedRegion === declaration.boundedRegion,
  );
  if (matching.length !== 1) {
    fail(
      'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
      `${label} declares an unapproved visual combination (mode ${declaration.mode}, algorithm ${declaration.algorithm}, evidenceSource ${declaration.evidenceSource}, authorityRole ${declaration.authorityRole}, region ${declaration.boundedRegion}).`,
    );
  }
  const combination = matching[0] as VisualCombination;
  const requiresTolerance = combination.toleranceAlgorithm !== null;
  if (requiresTolerance && declaration.toleranceRef === null) {
    fail(
      'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
      `${label} combination "${combination.mode}" requires a compatible ${combination.toleranceAlgorithm} tolerance, but toleranceRef is null`,
    );
  }
  if (!requiresTolerance && declaration.toleranceRef !== null) {
    fail(
      'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
      `${label} combination "${combination.mode}" must not declare a tolerance, but declares "${declaration.toleranceRef}"`,
    );
  }
}

function parseNormalization(value: unknown, index: number): NormalizationDeclaration {
  const label = `normalizations[${index}]`;
  const record = requireRecord(value, label);
  exactKeys(
    record,
    ['normalizationId', 'version', 'applicability', 'meaningRef', 'evaluator'],
    label,
  );
  const applicability = requireMember(
    record.applicability,
    NORMALIZATION_APPLICABILITIES,
    `${label}.applicability`,
  );
  const meaningRef = requireMember(
    record.meaningRef,
    NORMALIZATION_MEANING_REFS,
    `${label}.meaningRef`,
  );
  const evaluator = requireMember(record.evaluator, NORMALIZATION_EVALUATORS, `${label}.evaluator`);
  // Cross-field closure: only the single approved applicable triple is
  // permitted. Individually known values in a mismatched combination fail.
  if (
    applicability !== NORMALIZATION_COMBINATION.applicability ||
    meaningRef !== NORMALIZATION_COMBINATION.meaningRef ||
    evaluator !== NORMALIZATION_COMBINATION.evaluator
  ) {
    fail(
      'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
      `${label} declares an unapproved normalization combination (applicability ${applicability}, meaningRef ${meaningRef}, evaluator ${evaluator}); the only approved combination is ${NORMALIZATION_COMBINATION.applicability} → ${NORMALIZATION_COMBINATION.meaningRef} → ${NORMALIZATION_COMBINATION.evaluator}.`,
    );
  }
  return Object.freeze({
    normalizationId: requireString(record.normalizationId, `${label}.normalizationId`),
    version: requirePositiveInteger(record.version, `${label}.version`),
    applicability,
    meaningRef,
    evaluator,
  });
}

// ── Fingerprints ────────────────────────────────────────────────────────────

const CORRECTNESS_IDENTITY_VERSION = CORRECTNESS_CATALOGUE_SCHEMA_VERSION;

export function deriveReadinessFingerprint(declaration: ReadinessDeclaration): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.readinessDeclaration,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveCaptureFingerprint(declaration: CaptureDeclaration): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.captureDeclaration,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveOracleFingerprint(declaration: OracleDeclaration): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.oracleDeclaration,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveCapabilityBaselineFingerprint(
  declaration: CapabilityBaselineDeclaration,
): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.capabilityBaseline,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveSubjectAdditionFingerprint(declaration: SubjectAdditionDeclaration): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.subjectAddition,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveRouteSelectionFingerprint(
  declaration: RouteProfileSelectionDeclaration,
): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.routeProfileSelection,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveRequiredCheckSetFingerprint(
  checks: readonly ResolvedCheckContract[],
): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.requiredCheckSet,
    CORRECTNESS_IDENTITY_VERSION,
    [...checks].sort(compareByKey((entry) => entry.checkId)),
  );
}

export function deriveToleranceFingerprint(declaration: ToleranceDeclaration): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.toleranceDeclaration,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveVisualAuthorityFingerprint(declaration: VisualAuthorityDeclaration): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.visualAuthority,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

export function deriveNormalizationFingerprint(declaration: NormalizationDeclaration): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.normalizationDeclaration,
    CORRECTNESS_IDENTITY_VERSION,
    declaration,
  );
}

/**
 * Full canonical fingerprint of one resolved correctness profile. The preimage
 * never includes the fingerprint field itself, so an authoring reorder of any
 * semantically unordered collection cannot move it while any semantic field
 * mutation always does.
 */
export function deriveResolvedCorrectnessProfileFingerprint(
  profile: Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.resolvedCorrectnessProfile,
    RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
    profile,
  );
}

export function deriveCorrectnessCatalogueFingerprint(catalogue: CorrectnessCatalogue): string {
  return domainSeparatedDigest(
    IDENTITY_DOMAINS.resolvedCorrectnessProfile,
    CORRECTNESS_IDENTITY_VERSION,
    {
      readiness: catalogue.readiness,
      captures: catalogue.captures,
      oracles: catalogue.oracles,
      capabilityBaselines: catalogue.capabilityBaselines,
      subjectAdditions: catalogue.subjectAdditions,
      routeSelections: catalogue.routeSelections,
      tolerances: catalogue.tolerances,
      visuals: catalogue.visuals,
      normalizations: catalogue.normalizations,
    },
  );
}

/**
 * Explicit identity for a delivered binding with no compiled route profile. It
 * is domain-separated and binding-scoped rather than absent, so a missing
 * profile can never be confused with a resolved one.
 */
export function deriveAbsentCorrectnessProfileFingerprint(
  subjectId: string,
  capability: Capability,
  variant: string | null,
): string {
  return identityDigest(IDENTITY_DOMAINS.resolvedCorrectnessProfile, {
    profile: 'absent',
    subjectId,
    capability,
    variant,
    resolvedCorrectnessProfileSchemaVersion: RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
  });
}

// ── Catalogue assembly ──────────────────────────────────────────────────────

function parseReadinessCatalogue(raw: unknown): readonly ReadinessDeclaration[] {
  const record = requireRecord(raw, 'readiness catalogue');
  exactKeys(record, ['schemaVersion', 'readiness'], 'readiness catalogue');
  requireVersion(record.schemaVersion, CORRECTNESS_CATALOGUE_SCHEMA_VERSION, 'readiness catalogue');
  const declarations = requireArray(record.readiness, 'readiness').map(parseReadinessDeclaration);
  rejectIdentityDuplicates(
    declarations.map((entry) => entry.profileId),
    'readiness',
  );
  return Object.freeze(declarations.sort(compareByKey((entry) => entry.profileId)));
}

function parseCaptureCatalogue(raw: unknown): readonly CaptureDeclaration[] {
  const record = requireRecord(raw, 'capture catalogue');
  exactKeys(record, ['schemaVersion', 'captures'], 'capture catalogue');
  requireVersion(record.schemaVersion, CORRECTNESS_CATALOGUE_SCHEMA_VERSION, 'capture catalogue');
  const declarations = requireArray(record.captures, 'captures').map(parseCaptureDeclaration);
  rejectIdentityDuplicates(
    declarations.map((entry) => entry.captureProfileId),
    'captures',
  );
  return Object.freeze(declarations.sort(compareByKey((entry) => entry.captureProfileId)));
}

function parseOracleCatalogue(raw: unknown): readonly OracleDeclaration[] {
  const record = requireRecord(raw, 'oracle catalogue');
  exactKeys(record, ['schemaVersion', 'oracles'], 'oracle catalogue');
  requireVersion(record.schemaVersion, CORRECTNESS_CATALOGUE_SCHEMA_VERSION, 'oracle catalogue');
  const declarations = requireArray(record.oracles, 'oracles').map(parseOracleDeclaration);
  rejectIdentityDuplicates(
    declarations.map((entry) => entry.oracleProfileId),
    'oracles',
  );
  return Object.freeze(declarations.sort(compareByKey((entry) => entry.oracleProfileId)));
}

function parseCompositionCatalogue(raw: unknown): {
  baselines: readonly CapabilityBaselineDeclaration[];
  additions: readonly SubjectAdditionDeclaration[];
} {
  const record = requireRecord(raw, 'composition catalogue');
  exactKeys(
    record,
    ['schemaVersion', 'capabilityBaselines', 'subjectAdditions'],
    'composition catalogue',
  );
  requireVersion(
    record.schemaVersion,
    CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
    'composition catalogue',
  );

  const baselines = requireArray(record.capabilityBaselines, 'capabilityBaselines').map(
    (entry, index) => {
      const label = `capabilityBaselines[${index}]`;
      const entryRecord = requireRecord(entry, label);
      exactKeys(entryRecord, ['capability', 'checks'], label);
      if (!isCapability(entryRecord.capability)) {
        fail(
          'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
          `${label}.capability is not a declared Capability`,
        );
      }
      return Object.freeze({
        capability: entryRecord.capability,
        checks: sortedUnique(
          requireStringArray(entryRecord.checks, `${label}.checks`),
          `${label}.checks`,
        ),
      });
    },
  );
  rejectIdentityDuplicates(
    baselines.map((entry) => entry.capability),
    'capabilityBaselines',
  );

  const additions = requireArray(record.subjectAdditions, 'subjectAdditions').map(
    (entry, index) => {
      const label = `subjectAdditions[${index}]`;
      const entryRecord = requireRecord(entry, label);
      exactKeys(entryRecord, ['subjectId', 'capability', 'checks'], label);
      if (!isCapability(entryRecord.capability)) {
        fail(
          'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
          `${label}.capability is not a declared Capability`,
        );
      }
      return Object.freeze({
        subjectId: requireString(entryRecord.subjectId, `${label}.subjectId`),
        capability: entryRecord.capability,
        checks: sortedUnique(
          requireStringArray(entryRecord.checks, `${label}.checks`),
          `${label}.checks`,
        ),
      });
    },
  );
  rejectIdentityDuplicates(
    additions.map((entry) => routeKey(entry.subjectId, entry.capability, null)),
    'subjectAdditions',
  );

  return {
    baselines: Object.freeze(baselines.sort(compareByKey((entry) => entry.capability))),
    additions: Object.freeze(
      additions.sort(compareByKey((entry) => `${entry.subjectId}\u0000${entry.capability}`)),
    ),
  };
}

function parseRouteSelectionCatalogue(raw: unknown): readonly RouteProfileSelectionDeclaration[] {
  const record = requireRecord(raw, 'route-selection catalogue');
  exactKeys(record, ['schemaVersion', 'routeSelections'], 'route-selection catalogue');
  requireVersion(
    record.schemaVersion,
    CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
    'route-selection catalogue',
  );
  const selections = requireArray(record.routeSelections, 'routeSelections').map((entry, index) => {
    const label = `routeSelections[${index}]`;
    const entryRecord = requireRecord(entry, label);
    exactKeys(
      entryRecord,
      ['subjectId', 'capability', 'variant', 'readinessProfileId', 'oracleProfileId', 'checks'],
      label,
    );
    if (!isCapability(entryRecord.capability)) {
      fail(
        'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
        `${label}.capability is not a declared Capability`,
      );
    }
    const variantRaw = entryRecord.variant;
    if (variantRaw !== null && (typeof variantRaw !== 'string' || variantRaw.length === 0)) {
      fail(
        'CORRECTNESS_CATALOGUE_SHAPE_INVALID',
        `${label}.variant must be a non-empty string or null`,
      );
    }
    return Object.freeze({
      subjectId: requireString(entryRecord.subjectId, `${label}.subjectId`),
      capability: entryRecord.capability,
      variant: variantRaw as string | null,
      readinessProfileId: requireString(
        entryRecord.readinessProfileId,
        `${label}.readinessProfileId`,
      ),
      oracleProfileId: requireString(entryRecord.oracleProfileId, `${label}.oracleProfileId`),
      checks: sortedUnique(
        requireStringArray(entryRecord.checks, `${label}.checks`),
        `${label}.checks`,
      ),
    });
  });
  rejectIdentityDuplicates(
    selections.map((entry) => routeKey(entry.subjectId, entry.capability, entry.variant)),
    'routeSelections',
  );
  return Object.freeze(
    selections.sort(
      compareByKey((entry) => routeKey(entry.subjectId, entry.capability, entry.variant)),
    ),
  );
}

function parseToleranceCatalogue(raw: unknown): readonly ToleranceDeclaration[] {
  const record = requireRecord(raw, 'tolerance catalogue');
  exactKeys(record, ['schemaVersion', 'tolerances'], 'tolerance catalogue');
  requireVersion(record.schemaVersion, CORRECTNESS_CATALOGUE_SCHEMA_VERSION, 'tolerance catalogue');
  const declarations = requireArray(record.tolerances, 'tolerances').map(parseTolerance);
  rejectIdentityDuplicates(
    declarations.map((entry) => entry.toleranceId),
    'tolerances',
  );
  return Object.freeze(declarations.sort(compareByKey((entry) => entry.toleranceId)));
}

function parseVisualCatalogue(raw: unknown): readonly VisualAuthorityDeclaration[] {
  const record = requireRecord(raw, 'visual catalogue');
  exactKeys(record, ['schemaVersion', 'visuals'], 'visual catalogue');
  requireVersion(record.schemaVersion, CORRECTNESS_CATALOGUE_SCHEMA_VERSION, 'visual catalogue');
  const declarations = requireArray(record.visuals, 'visuals').map(parseVisual);
  rejectIdentityDuplicates(
    declarations.map((entry) => entry.visualId),
    'visuals',
  );
  return Object.freeze(declarations.sort(compareByKey((entry) => entry.visualId)));
}

function parseNormalizationCatalogue(raw: unknown): readonly NormalizationDeclaration[] {
  const record = requireRecord(raw, 'normalization catalogue');
  exactKeys(record, ['schemaVersion', 'normalizations'], 'normalization catalogue');
  requireVersion(
    record.schemaVersion,
    CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
    'normalization catalogue',
  );
  const declarations = requireArray(record.normalizations, 'normalizations').map(
    parseNormalization,
  );
  rejectIdentityDuplicates(
    declarations.map((entry) => entry.normalizationId),
    'normalizations',
  );
  return Object.freeze(declarations.sort(compareByKey((entry) => entry.normalizationId)));
}

function readCatalogueFile(rootDir: string, relativePath: string): unknown {
  const absolutePath = path.join(rootDir, relativePath);
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch {
    fail(
      'CORRECTNESS_CATALOGUE_FILE_MISSING',
      `Correctness catalogue file is unavailable: ${relativePath}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(
      'CORRECTNESS_CATALOGUE_JSON_INVALID',
      `Correctness catalogue is not valid JSON: ${relativePath}`,
    );
  }
}

export function assembleCorrectnessCatalogue(documents: {
  readiness: unknown;
  capture: unknown;
  oracles: unknown;
  composition: unknown;
  routeSelections: unknown;
  tolerances: unknown;
  visuals: unknown;
  normalization: unknown;
}): CorrectnessCatalogue {
  const composition = parseCompositionCatalogue(documents.composition);
  return Object.freeze({
    schemaVersion: CORRECTNESS_CATALOGUE_SCHEMA_VERSION,
    readiness: parseReadinessCatalogue(documents.readiness),
    captures: parseCaptureCatalogue(documents.capture),
    oracles: parseOracleCatalogue(documents.oracles),
    capabilityBaselines: composition.baselines,
    subjectAdditions: composition.additions,
    routeSelections: parseRouteSelectionCatalogue(documents.routeSelections),
    tolerances: parseToleranceCatalogue(documents.tolerances),
    visuals: parseVisualCatalogue(documents.visuals),
    normalizations: parseNormalizationCatalogue(documents.normalization),
  });
}

export interface LoadCorrectnessOptions {
  rootDir?: string;
}

export function loadCorrectnessCatalogue(
  options: LoadCorrectnessOptions = {},
): CorrectnessCatalogue {
  const rootDir = options.rootDir ?? resolveSkillRoot();
  return structuredClone(
    assembleCorrectnessCatalogue({
      readiness: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.readiness),
      capture: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.capture),
      oracles: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.oracles),
      composition: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.composition),
      routeSelections: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.routeSelections),
      tolerances: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.tolerances),
      visuals: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.visuals),
      normalization: readCatalogueFile(rootDir, CORRECTNESS_CATALOGUE_FILES.normalization),
    }),
  );
}

// ── Reference closure and catalogue-wide validation ─────────────────────────

function blockingCorrection(
  detail: string,
  context: Record<string, string> = {},
): DiagnosticRecord {
  return createDiagnostic('CORRECTNESS_REFERENCE_UNRESOLVED', detail, { context });
}

/**
 * Validates the whole correctness catalogue: every declaration reference
 * resolves exactly once, every discriminant is known, every tolerance/units
 * pairing is compatible, and every required-check evidence item is produced by
 * the selected capture. Findings are structured and blocking.
 */
export function validateCorrectnessCatalogue(catalogue: CorrectnessCatalogue): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];
  const readinessById = new Map(catalogue.readiness.map((entry) => [entry.profileId, entry]));
  const captureById = new Map(catalogue.captures.map((entry) => [entry.captureProfileId, entry]));
  const oracleById = new Map(catalogue.oracles.map((entry) => [entry.oracleProfileId, entry]));
  const toleranceById = new Map(catalogue.tolerances.map((entry) => [entry.toleranceId, entry]));
  const visualById = new Map(catalogue.visuals.map((entry) => [entry.visualId, entry]));
  const normalizationById = new Map(
    catalogue.normalizations.map((entry) => [entry.normalizationId, entry]),
  );

  // Tolerance algorithm/units pairing is closed: numeric comparison is valid
  // only within the same algorithm and units.
  const acceptedUnits: Readonly<Record<string, string>> = {
    'backing-pixel-edge': 'effective-backing-pixel',
    'css-pixel-absolute': 'css-px',
    'interaction-target-inset': 'css-px',
    'matrix-component-absolute': 'matrix-unit',
  };
  for (const tolerance of catalogue.tolerances) {
    if (acceptedUnits[tolerance.algorithm] !== tolerance.units) {
      findings.push(
        createDiagnostic(
          'CORRECTNESS_TOLERANCE_UNITS_MISMATCH',
          `Tolerance "${tolerance.toleranceId}" pairs algorithm "${tolerance.algorithm}" with units "${tolerance.units}" (expected "${acceptedUnits[tolerance.algorithm]}").`,
        ),
      );
    }
  }

  for (const visual of catalogue.visuals) {
    const combination = VISUAL_COMBINATIONS.find(
      (entry) =>
        entry.mode === visual.mode &&
        entry.algorithm === visual.algorithm &&
        entry.evidenceSource === visual.evidenceSource &&
        entry.authorityRole === visual.authorityRole &&
        entry.boundedRegion === visual.boundedRegion,
    );
    if (!combination) {
      findings.push(
        createDiagnostic(
          'CORRECTNESS_NON_WEAKENING_VIOLATION',
          `Visual authority "${visual.visualId}" declares an unapproved visual combination (mode ${visual.mode}, algorithm ${visual.algorithm}, evidenceSource ${visual.evidenceSource}, authorityRole ${visual.authorityRole}, region ${visual.boundedRegion}).`,
        ),
      );
      continue;
    }
    if (combination.toleranceAlgorithm === null && visual.toleranceRef !== null) {
      findings.push(
        createDiagnostic(
          'CORRECTNESS_NON_WEAKENING_VIOLATION',
          `Visual authority "${visual.visualId}" is diagnostic-only but declares authoritative tolerance "${visual.toleranceRef}".`,
        ),
      );
    }
    if (visual.toleranceRef === null) {
      if (combination.toleranceAlgorithm !== null) {
        findings.push(
          createDiagnostic(
            'CORRECTNESS_NON_WEAKENING_VIOLATION',
            `Visual authority "${visual.visualId}" requires a compatible ${combination.toleranceAlgorithm} tolerance but declares none.`,
          ),
        );
      }
    } else {
      const tolerance = toleranceById.get(visual.toleranceRef);
      if (!tolerance) {
        findings.push(
          blockingCorrection(
            `Visual authority "${visual.visualId}" references unknown tolerance "${visual.toleranceRef}".`,
          ),
        );
      } else if (tolerance.algorithm !== combination.toleranceAlgorithm) {
        findings.push(
          createDiagnostic(
            'CORRECTNESS_NON_WEAKENING_VIOLATION',
            `Visual authority "${visual.visualId}" requires a ${combination.toleranceAlgorithm} tolerance but "${visual.toleranceRef}" uses algorithm "${tolerance.algorithm}".`,
          ),
        );
      }
    }
  }

  for (const oracle of catalogue.oracles) {
    for (const check of oracle.checks) {
      for (const toleranceRef of check.toleranceRefs) {
        if (!toleranceById.has(toleranceRef)) {
          findings.push(
            blockingCorrection(
              `Oracle "${oracle.oracleProfileId}" check "${check.checkId}" references unknown tolerance "${toleranceRef}".`,
            ),
          );
        }
      }
      for (const visualRef of check.visualRefs) {
        const visual = visualById.get(visualRef);
        if (!visual) {
          findings.push(
            blockingCorrection(
              `Oracle "${oracle.oracleProfileId}" check "${check.checkId}" references unknown visual authority "${visualRef}".`,
            ),
          );
        } else if (visual.authorityRole === 'diagnostic-only') {
          findings.push(
            createDiagnostic(
              'CORRECTNESS_NON_WEAKENING_VIOLATION',
              `Oracle "${oracle.oracleProfileId}" check "${check.checkId}" references diagnostic-only visual authority "${visualRef}".`,
            ),
          );
        }
      }
      if (check.normalizationRef !== null && !normalizationById.has(check.normalizationRef)) {
        findings.push(
          blockingCorrection(
            `Oracle "${oracle.oracleProfileId}" check "${check.checkId}" references unknown normalization "${check.normalizationRef}".`,
          ),
        );
      }
    }
  }

  if (catalogue.routeSelections.length === 0) {
    findings.push(
      createDiagnostic(
        'CORRECTNESS_CATALOGUE_INVALID',
        'The route-selection catalogue declares no delivered route.',
      ),
    );
  }

  for (const selection of catalogue.routeSelections) {
    const readiness = readinessById.get(selection.readinessProfileId);
    if (!readiness) {
      findings.push(
        blockingCorrection(
          `Route selection ${selection.subjectId} × ${selection.capability} references unknown readiness profile "${selection.readinessProfileId}".`,
        ),
      );
      continue;
    }
    if (!oracleById.has(selection.oracleProfileId)) {
      findings.push(
        blockingCorrection(
          `Route selection ${selection.subjectId} × ${selection.capability} references unknown Oracle profile "${selection.oracleProfileId}".`,
        ),
      );
    }
    if (readiness.oracleProfileId !== selection.oracleProfileId) {
      findings.push(
        createDiagnostic(
          'CORRECTNESS_REFERENCE_AMBIGUOUS',
          `Readiness profile "${readiness.profileId}" resolves Oracle "${readiness.oracleProfileId}" but route selection ${selection.subjectId} × ${selection.capability} selects "${selection.oracleProfileId}".`,
        ),
      );
    }
    if (!captureById.has(readiness.captureProfileId)) {
      findings.push(
        blockingCorrection(
          `Readiness profile "${readiness.profileId}" references unknown capture profile "${readiness.captureProfileId}".`,
        ),
      );
    }
  }

  // Every declared readiness profile must have exactly one Oracle registration
  // and one capture, and every declared Oracle must be reachable.
  const referencedOracles = new Set(catalogue.readiness.map((entry) => entry.oracleProfileId));
  for (const oracle of catalogue.oracles) {
    if (!referencedOracles.has(oracle.oracleProfileId)) {
      findings.push(
        blockingCorrection(
          `Oracle profile "${oracle.oracleProfileId}" is declared but no readiness profile references it.`,
        ),
      );
    }
  }
  for (const readiness of catalogue.readiness) {
    if (!captureById.has(readiness.captureProfileId)) {
      findings.push(
        blockingCorrection(
          `Readiness profile "${readiness.profileId}" references unknown capture profile "${readiness.captureProfileId}".`,
        ),
      );
    }
    if (!oracleById.has(readiness.oracleProfileId)) {
      findings.push(
        blockingCorrection(
          `Readiness profile "${readiness.profileId}" references unknown Oracle profile "${readiness.oracleProfileId}".`,
        ),
      );
    }
  }

  return findings;
}

// ── Compilation ─────────────────────────────────────────────────────────────

export interface CompileCorrectnessInput {
  catalogue: CorrectnessCatalogue;
  selection: RouteProfileSelectionDeclaration;
  /** Required checks declared by the resolved Subject × Capability binding. */
  declaredChecks: readonly string[];
}

export type CompileCorrectnessResult =
  | { ok: true; profile: ResolvedCorrectnessProfile }
  | { ok: false; findings: readonly DiagnosticRecord[] };

function nonWeakeningFinding(requirement: string, detail: string): DiagnosticRecord {
  return createDiagnostic('CORRECTNESS_NON_WEAKENING_VIOLATION', `${requirement}: ${detail}`);
}

export function resolveRouteSelection(
  catalogue: CorrectnessCatalogue,
  key: { subjectId: string; capability: Capability; variant: string | null },
): RouteProfileSelectionDeclaration | null {
  return (
    catalogue.routeSelections.find(
      (entry) =>
        entry.subjectId === key.subjectId &&
        entry.capability === key.capability &&
        entry.variant === key.variant,
    ) ?? null
  );
}

export function compileResolvedCorrectnessProfile(
  input: CompileCorrectnessInput,
): CompileCorrectnessResult {
  const { catalogue, selection } = input;
  const findings: DiagnosticRecord[] = [];

  const readiness = catalogue.readiness.find(
    (entry) => entry.profileId === selection.readinessProfileId,
  );
  if (!readiness) {
    findings.push(
      blockingCorrection(
        `Unknown readiness profile "${selection.readinessProfileId}" for ${selection.subjectId} × ${selection.capability}.`,
      ),
    );
    return { ok: false, findings };
  }
  const capture = catalogue.captures.find(
    (entry) => entry.captureProfileId === readiness.captureProfileId,
  );
  if (!capture) {
    findings.push(
      blockingCorrection(
        `Unknown capture profile "${readiness.captureProfileId}" for readiness "${readiness.profileId}".`,
      ),
    );
    return { ok: false, findings };
  }
  const oracle = catalogue.oracles.find(
    (entry) => entry.oracleProfileId === selection.oracleProfileId,
  );
  if (!oracle) {
    findings.push(
      blockingCorrection(
        `Unknown Oracle profile "${selection.oracleProfileId}" for ${selection.subjectId} × ${selection.capability}.`,
      ),
    );
    return { ok: false, findings };
  }
  if (readiness.oracleProfileId !== oracle.oracleProfileId) {
    findings.push(
      createDiagnostic(
        'CORRECTNESS_REFERENCE_AMBIGUOUS',
        `Readiness profile "${readiness.profileId}" resolves Oracle "${readiness.oracleProfileId}" but selection resolves "${oracle.oracleProfileId}".`,
      ),
    );
    return { ok: false, findings };
  }

  const baseline = catalogue.capabilityBaselines.find(
    (entry) => entry.capability === selection.capability,
  );
  if (!baseline) {
    findings.push(
      blockingCorrection(
        `No Capability baseline is declared for delivered Capability "${selection.capability}".`,
      ),
    );
    return { ok: false, findings };
  }
  const addition = catalogue.subjectAdditions.find(
    (entry) => entry.subjectId === selection.subjectId && entry.capability === selection.capability,
  );
  if (!addition) {
    findings.push(
      blockingCorrection(
        `No Subject × Capability addition is declared for ${selection.subjectId} × ${selection.capability}.`,
      ),
    );
    return { ok: false, findings };
  }

  // Composition: Capability baseline ∪ Subject × Capability additions ∪ the
  // approved profile selection's own required checks. The Oracle declaration is
  // the single place a required-check contract is defined, and its definition
  // set must exactly cover the composed required-check set.
  const checkById = new Map(oracle.checks.map((entry) => [entry.checkId, entry]));
  const composedIds = new Set<string>([
    ...baseline.checks,
    ...addition.checks,
    ...selection.checks,
  ]);
  const requiredChecks: ResolvedCheckContract[] = [];
  for (const checkId of [...composedIds].sort()) {
    const declared = checkById.get(checkId);
    if (!declared) {
      findings.push(
        blockingCorrection(
          `Required check "${checkId}" is composed for ${selection.subjectId} × ${selection.capability} but Oracle "${oracle.oracleProfileId}" declares no definition for it.`,
        ),
      );
      continue;
    }
    requiredChecks.push({
      checkId,
      evaluator: declared.evaluator,
      expectedSchema: declared.expectedSchema,
      actualSchema: declared.actualSchema,
      requiredEvidence: [...declared.requiredEvidence],
      toleranceRefs: [...declared.toleranceRefs],
      visualRefs: [...declared.visualRefs],
      normalizationRef: declared.normalizationRef,
    });
  }
  for (const oracleCheck of oracle.checks) {
    if (!composedIds.has(oracleCheck.checkId)) {
      findings.push(
        nonWeakeningFinding(
          'selected Oracle profile definition is required by the route',
          `Oracle definition "${oracleCheck.checkId}" is not composed by the baseline/addition/selection for ${selection.subjectId} × ${selection.capability}`,
        ),
      );
    }
  }
  if (findings.length > 0) return { ok: false, findings };

  const captureEvidence = new Set(capture.evidenceItemIds);
  const requiredAuthoritativeEvidence = [
    ...new Set(requiredChecks.flatMap((entry) => entry.requiredEvidence)),
  ].sort();
  const diagnosticOnlyEvidence = [...oracle.diagnosticOnlyEvidence].sort();

  const nonWeakening: NonWeakeningAssertion[] = [];
  const assert = (requirement: string, satisfied: boolean, evidence: string): void => {
    nonWeakening.push({ requirement, satisfied, evidence });
    if (!satisfied) findings.push(nonWeakeningFinding(requirement, evidence));
  };

  for (const declaredCheck of input.declaredChecks) {
    assert(
      'declared Subject × Capability required check is retained',
      composedIds.has(declaredCheck),
      `declared check "${declaredCheck}" is retained by composition`,
    );
  }
  for (const baselineCheck of baseline.checks) {
    assert(
      'Capability baseline check is retained',
      composedIds.has(baselineCheck),
      `baseline check "${baselineCheck}" is retained`,
    );
  }
  for (const additionCheck of addition.checks) {
    assert(
      'Subject × Capability addition check is retained',
      composedIds.has(additionCheck),
      `addition check "${additionCheck}" is retained`,
    );
  }
  for (const oracleCheck of oracle.checks) {
    assert(
      'selected Oracle profile check is retained',
      composedIds.has(oracleCheck.checkId),
      `oracle check "${oracleCheck.checkId}" is retained`,
    );
  }
  // A declared readiness deadline may not be extended beyond the accepted
  // maximum for its timing category, and it may not omit a currentness identity
  // that a required capture source depends on.
  const acceptedDeadlineMaximumMs: Readonly<Record<string, number>> = {
    DERIVED_GENERATION_V1: 8_000,
    FRONTEND_RESTORE_V1: 15_000,
    INTERACTIVE_HISTORY_V1: 5_000,
    INTERACTIVE_RENDER_V1: 5_000,
    RESOURCE_RENDER_V1: 8_000,
  };
  assert(
    'readiness deadline is not extended beyond its timing category',
    readiness.deadlineMs <= acceptedDeadlineMaximumMs[readiness.deadlineCategory],
    `deadline ${readiness.deadlineMs}ms ≤ accepted maximum ${acceptedDeadlineMaximumMs[readiness.deadlineCategory]}ms for ${readiness.deadlineCategory}`,
  );
  const readinessCurrentness = new Set(readiness.currentnessIdentities);
  for (const source of capture.requiredSources) {
    if (!source.required) continue;
    assert(
      'required capture source currentness is declared by the readiness profile',
      source.currentness.every((identity) => readinessCurrentness.has(identity)),
      `capture source "${source.sourceId}" currentness [${source.currentness.join(', ')}] ⊆ readiness currentness`,
    );
  }
  for (const evidenceId of requiredAuthoritativeEvidence) {
    assert(
      'required-authoritative evidence is produced by the selected capture',
      captureEvidence.has(evidenceId),
      `evidence item "${evidenceId}" is declared by capture "${capture.captureProfileId}"`,
    );
  }
  for (const evidenceId of diagnosticOnlyEvidence) {
    assert(
      'diagnostic-only evidence cannot satisfy a required check',
      !requiredAuthoritativeEvidence.includes(evidenceId) && !composedIds.has(evidenceId),
      `diagnostic evidence "${evidenceId}" is disjoint from required-authoritative evidence and required check ids`,
    );
  }

  // Tolerance resolution and non-widening guard: a catalogue that declares a
  // numeric tolerance wider than the accepted maximum for its algorithm is a
  // weakening within the same policy and blocks before launch.
  const acceptedMaximum: Readonly<Record<string, number>> = {
    'backing-pixel-edge': 1,
    'css-pixel-absolute': 0.25,
    'matrix-component-absolute': 1e-6,
  };
  const toleranceIds = [...new Set(requiredChecks.flatMap((entry) => entry.toleranceRefs))].sort();
  const tolerances: ToleranceDeclaration[] = [];
  for (const toleranceId of toleranceIds) {
    const tolerance = catalogue.tolerances.find((entry) => entry.toleranceId === toleranceId);
    if (!tolerance) {
      findings.push(
        blockingCorrection(
          `Required check of ${selection.subjectId} × ${selection.capability} references unknown tolerance "${toleranceId}".`,
        ),
      );
      continue;
    }
    const maximum = acceptedMaximum[tolerance.algorithm];
    if (maximum !== undefined && tolerance.value !== null && tolerance.value > maximum) {
      findings.push(
        nonWeakeningFinding(
          'tolerance is not widened within its policy',
          `tolerance "${toleranceId}" declares ${tolerance.value} > accepted maximum ${maximum} for algorithm "${tolerance.algorithm}"`,
        ),
      );
    }
    tolerances.push(tolerance);
  }

  const visualIds = [...new Set(requiredChecks.flatMap((entry) => entry.visualRefs))].sort();
  const visuals: VisualAuthorityDeclaration[] = [];
  for (const visualId of visualIds) {
    const visual = catalogue.visuals.find((entry) => entry.visualId === visualId);
    if (!visual) {
      findings.push(
        blockingCorrection(
          `Required check of ${selection.subjectId} × ${selection.capability} references unknown visual authority "${visualId}".`,
        ),
      );
      continue;
    }
    visuals.push(visual);
  }

  const normalizationIds = [
    ...new Set(
      requiredChecks
        .map((entry) => entry.normalizationRef)
        .filter((entry): entry is string => entry !== null),
    ),
  ].sort();
  let normalization: ResolvedNormalization;
  if (normalizationIds.length === 0) {
    normalization = { applicable: false };
  } else if (normalizationIds.length > 1) {
    findings.push(
      createDiagnostic(
        'CORRECTNESS_REFERENCE_AMBIGUOUS',
        `Required checks of ${selection.subjectId} × ${selection.capability} resolve ${normalizationIds.length} normalizations (${normalizationIds.join(', ')}).`,
      ),
    );
    return { ok: false, findings };
  } else {
    const normalizationId = normalizationIds[0] as string;
    const declaration = catalogue.normalizations.find(
      (entry) => entry.normalizationId === normalizationId,
    );
    if (!declaration) {
      findings.push(
        blockingCorrection(
          `Required check of ${selection.subjectId} × ${selection.capability} references unknown normalization "${normalizationId}".`,
        ),
      );
      return { ok: false, findings };
    }
    normalization = {
      applicable: true,
      ...declaration,
      fingerprint: deriveNormalizationFingerprint(declaration),
    };
  }

  if (findings.length > 0) return { ok: false, findings };

  const referenceClosure: CorrectnessReferenceEntry[] = [
    { kind: 'readiness', id: readiness.profileId },
    { kind: 'capture', id: capture.captureProfileId },
    { kind: 'oracle', id: oracle.oracleProfileId },
    { kind: 'capability-baseline', id: baseline.capability },
    { kind: 'subject-addition', id: `${addition.subjectId}×${addition.capability}` },
    ...requiredChecks.map((entry) => ({ kind: 'required-check', id: entry.checkId })),
    ...requiredAuthoritativeEvidence.map((entry) => ({
      kind: 'required-authoritative-evidence',
      id: entry,
    })),
    ...diagnosticOnlyEvidence.map((entry) => ({ kind: 'diagnostic-only-evidence', id: entry })),
    ...tolerances.map((entry) => ({ kind: 'tolerance', id: entry.toleranceId })),
    ...visuals.map((entry) => ({ kind: 'visual-authority', id: entry.visualId })),
    ...(normalization.applicable
      ? [{ kind: 'normalization', id: normalization.normalizationId }]
      : [{ kind: 'normalization', id: 'not-applicable' }]),
  ];

  const componentFingerprints: CorrectnessComponentFingerprints = {
    readiness: deriveReadinessFingerprint(readiness),
    capture: deriveCaptureFingerprint(capture),
    oracle: deriveOracleFingerprint(oracle),
    capabilityBaseline: deriveCapabilityBaselineFingerprint(baseline),
    subjectAddition: deriveSubjectAdditionFingerprint(addition),
    requiredCheckSet: deriveRequiredCheckSetFingerprint(requiredChecks),
    tolerances: identityDigest(
      IDENTITY_DOMAINS.toleranceDeclaration,
      tolerances.map((entry) => deriveToleranceFingerprint(entry)),
    ),
    visuals: identityDigest(
      IDENTITY_DOMAINS.visualAuthority,
      visuals.map((entry) => deriveVisualAuthorityFingerprint(entry)),
    ),
    normalization: normalization.applicable
      ? normalization.fingerprint
      : identityDigest(IDENTITY_DOMAINS.normalizationDeclaration, { profile: 'not-applicable' }),
  };

  const withoutFingerprint: Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'> = {
    schemaVersion: RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
    profileId: readiness.profileId,
    subjectId: selection.subjectId,
    capability: selection.capability,
    variant: selection.variant,
    readiness,
    capture,
    oracle,
    capabilityBaseline: baseline,
    subjectAddition: addition,
    requiredChecks,
    requiredAuthoritativeEvidence,
    diagnosticOnlyEvidence,
    tolerances,
    visuals,
    normalization,
    referenceClosure,
    nonWeakening,
    componentFingerprints,
  };

  return {
    ok: true,
    profile: Object.freeze({
      ...withoutFingerprint,
      resolvedFingerprint: deriveResolvedCorrectnessProfileFingerprint(withoutFingerprint),
    }),
  };
}

/** Compiled profiles for every delivered route selection in the catalogue. */
export function compileDeliveredRouteProfiles(
  catalogue: CorrectnessCatalogue,
  declaredChecksByBinding: ReadonlyMap<string, readonly string[]>,
): {
  profiles: readonly ResolvedCorrectnessProfile[];
  findings: readonly DiagnosticRecord[];
} {
  const profiles: ResolvedCorrectnessProfile[] = [];
  const findings: DiagnosticRecord[] = [];
  for (const selection of catalogue.routeSelections) {
    const declaredChecks =
      declaredChecksByBinding.get(`${selection.subjectId}\u0000${selection.capability}`) ?? [];
    const compiled = compileResolvedCorrectnessProfile({ catalogue, selection, declaredChecks });
    if (compiled.ok) profiles.push(compiled.profile);
    else findings.push(...compiled.findings);
  }
  return { profiles, findings };
}

/** Reports every declared binding's compiled-coverage state without claiming execution. */
export function buildBindingCorrectnessLedger(
  catalogue: CorrectnessCatalogue,
  bindings: readonly { subjectId: string; capability: Capability }[],
  coverageModelKeys: ReadonlySet<string>,
): BindingCorrectnessLedgerEntry[] {
  const selectionKeys = new Set(
    catalogue.routeSelections.map((entry) =>
      routeKey(entry.subjectId, entry.capability, entry.variant),
    ),
  );
  const coverageBySubjectCapability = new Set(
    [...coverageModelKeys].map((key) => key.split('\u0000').slice(0, 2).join('\u0000')),
  );
  return bindings
    .map((binding) => {
      const subjectCapabilityKey = `${binding.subjectId}\u0000${binding.capability}`;
      const coverageModelPresent = coverageBySubjectCapability.has(subjectCapabilityKey);
      const routeSelectionPresent = [...selectionKeys].some((key) =>
        key.startsWith(`${subjectCapabilityKey}\u0000`),
      );
      const state = routeSelectionPresent
        ? 'compiled-profile'
        : coverageModelPresent
          ? 'coverage-model-only'
          : 'profile-unavailable';
      return {
        subjectId: binding.subjectId,
        capability: binding.capability,
        state,
        coverageModelPresent,
        routeSelectionPresent,
        detail:
          state === 'compiled-profile'
            ? 'A delivered route profile is compiled and reference-closed.'
            : state === 'coverage-model-only'
              ? 'A Coverage Model exists but no delivered route profile is compiled; execution completeness is not established.'
              : 'No Coverage Model and no delivered route profile; correctness profile unavailable.',
      } satisfies BindingCorrectnessLedgerEntry;
    })
    .sort(compareByKey((entry) => `${entry.subjectId}\u0000${entry.capability}`));
}
