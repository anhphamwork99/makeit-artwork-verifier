import { type Outcome, isOutcome } from './discriminants';
import { isEvidenceLogicalId, isEvidenceRelativePath } from './evidence-transaction';

/**
 * Closed ephemeral `evidence-verify.v1` report contract (ADR 0048 WP-B0).
 *
 * This module is the deterministic, read-only contract surface shared by the
 * P8-B verifier core (WP-B1) and the `evidence verify` CLI (WP-B2). It is never
 * persisted into an evidence root and is never an inventory/manifest extension.
 * Everything below is closed: unknown keys, unknown codes, unknown
 * discriminants, and unmapped source issues are rejected rather than coerced.
 *
 * The contract is a deliberate literal source of truth, not an import of the
 * accepted validators/readers. The foundation test imports the actual source
 * arrays (`FINAL_RECORD_ASSEMBLY_ISSUE_CODES`, `RESULT_CONTRACT_ISSUE_CODES`,
 * `FINAL_SUITE_RECORD_ISSUE_CODES`, and the validator failure-code arrays) and
 * proves exact set equality, so a future source-union member is a loud test
 * failure — a stop condition — rather than a silent fallback.
 *
 * Governing references: ADR 0048; plan `p8b-integrity-verifier.md` §7.2/§7.3.
 */

/** Ephemeral verifier report schema version. */
export const EVIDENCE_VERIFY_SCHEMA_VERSION = 1;
/** Ephemeral verifier report label. */
export const EVIDENCE_VERIFY_REPORT_LABEL = 'evidence-verify.v1';

// ── Verifier code vocabulary (40 codes: 2 advisory, 38 blocking) ──────────────

/**
 * The complete, closed `evidence-verify.v1` code set. No other code, source
 * validator code, reader issue, OS message, or raw exception may be emitted.
 * The order is the plan's canonical §7.2 listing.
 */
export const EVIDENCE_VERIFY_CODES = Object.freeze([
  'VERIFY_ROOT_NOT_FOUND',
  'VERIFY_ROOT_UNREADABLE',
  'VERIFY_ID_AMBIGUOUS',
  'VERIFY_NOT_A_ROOT',
  'VERIFY_JSON_INVALID',
  'VERIFY_UNKNOWN_SCHEMA',
  'VERIFY_UNKNOWN_LABEL',
  'VERIFY_UNKNOWN_KEY',
  'VERIFY_UNKNOWN_DISCRIMINANT',
  'VERIFY_SEALED_SCHEMA_MISMATCH',
  'VERIFY_TRANSACTION_INVALID',
  'VERIFY_PARTIAL_NO_MANIFEST',
  'VERIFY_LEGACY_UNVERIFIABLE',
  'VERIFY_ARTIFACT_MISSING',
  'VERIFY_ARTIFACT_EXTRA',
  'VERIFY_ARTIFACT_PATH_INVALID',
  'VERIFY_ARTIFACT_SYMLINK',
  'VERIFY_ARTIFACT_LENGTH_MISMATCH',
  'VERIFY_ARTIFACT_SHA256_MISMATCH',
  'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
  'VERIFY_REFERENCE_DANGLING',
  'VERIFY_REFERENCE_UNKNOWN_ID',
  'VERIFY_REFERENCE_ORDER_INVALID',
  'VERIFY_REQUIRED_AUTHORITY_MISSING',
  'VERIFY_REQUIRED_AUTHORITY_WEAKENED',
  'VERIFY_REQUIRED_AUTHORITY_REDACTED',
  'VERIFY_PROVENANCE_INVALID',
  'VERIFY_PROVENANCE_IDENTITY_MISMATCH',
  'VERIFY_PROVENANCE_CURRENT_DRIFT',
  'VERIFY_PROVENANCE_CURRENT_UNAVAILABLE',
  'VERIFY_SANITIZATION_PROHIBITED_VALUE',
  'VERIFY_SECRET_OR_AUTHORIZATION_MARKER',
  'VERIFY_PRIVATE_OR_ABSOLUTE_PATH',
  'VERIFY_PRODUCTION_CUSTOMER_MARKER',
  'VERIFY_POST_FINALIZATION_MUTATION',
  'VERIFY_SUITE_TRANSACTION_ACTIVATED',
  'VERIFY_SUITE_CHILD_NOT_COMMITTED',
  'VERIFY_SUITE_CHILD_IDENTITY_MISMATCH',
  'VERIFY_EXTERNAL_READ_FAILURE',
  'VERIFY_UNKNOWN_FAILURE',
] as const);
export type EvidenceVerifyCode = (typeof EVIDENCE_VERIFY_CODES)[number];

/**
 * The only two advisory verifier codes. Both are current-tree compatibility
 * diagnostics: they withhold only current-tree claim credit, never persisted
 * integrity, and can never become primary.
 */
export const ADVISORY_VERIFIER_CODES = Object.freeze([
  'VERIFY_PROVENANCE_CURRENT_DRIFT',
  'VERIFY_PROVENANCE_CURRENT_UNAVAILABLE',
] as const);
export type AdvisoryVerifierCode = (typeof ADVISORY_VERIFIER_CODES)[number];

/** The exact 38-code blocking complement of the two advisory codes. */
export type BlockingVerifierCode = Exclude<EvidenceVerifyCode, AdvisoryVerifierCode>;

/**
 * The single canonical primary-code precedence constant. Zero-based array
 * position plus one is the only `precedenceIndex`; no index is duplicated,
 * persisted, or copied into a second manually maintained list. Advisory codes
 * are excluded before class/code selection and have no precedence index.
 */
export const PRIMARY_BLOCKING_VERIFIER_CODES = Object.freeze([
  'VERIFY_ID_AMBIGUOUS',
  'VERIFY_ROOT_NOT_FOUND',
  'VERIFY_ROOT_UNREADABLE',
  'VERIFY_NOT_A_ROOT',
  'VERIFY_SUITE_TRANSACTION_ACTIVATED',
  'VERIFY_SUITE_CHILD_NOT_COMMITTED',
  'VERIFY_SUITE_CHILD_IDENTITY_MISMATCH',
  'VERIFY_POST_FINALIZATION_MUTATION',
  'VERIFY_ARTIFACT_MISSING',
  'VERIFY_ARTIFACT_EXTRA',
  'VERIFY_ARTIFACT_SYMLINK',
  'VERIFY_ARTIFACT_PATH_INVALID',
  'VERIFY_ARTIFACT_LENGTH_MISMATCH',
  'VERIFY_ARTIFACT_SHA256_MISMATCH',
  'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
  'VERIFY_REFERENCE_DANGLING',
  'VERIFY_REFERENCE_UNKNOWN_ID',
  'VERIFY_REFERENCE_ORDER_INVALID',
  'VERIFY_REQUIRED_AUTHORITY_MISSING',
  'VERIFY_REQUIRED_AUTHORITY_WEAKENED',
  'VERIFY_REQUIRED_AUTHORITY_REDACTED',
  'VERIFY_PROVENANCE_INVALID',
  'VERIFY_PROVENANCE_IDENTITY_MISMATCH',
  'VERIFY_SANITIZATION_PROHIBITED_VALUE',
  'VERIFY_SECRET_OR_AUTHORIZATION_MARKER',
  'VERIFY_PRIVATE_OR_ABSOLUTE_PATH',
  'VERIFY_PRODUCTION_CUSTOMER_MARKER',
  'VERIFY_UNKNOWN_SCHEMA',
  'VERIFY_UNKNOWN_LABEL',
  'VERIFY_UNKNOWN_KEY',
  'VERIFY_UNKNOWN_DISCRIMINANT',
  'VERIFY_SEALED_SCHEMA_MISMATCH',
  'VERIFY_TRANSACTION_INVALID',
  'VERIFY_PARTIAL_NO_MANIFEST',
  'VERIFY_LEGACY_UNVERIFIABLE',
  'VERIFY_JSON_INVALID',
  'VERIFY_EXTERNAL_READ_FAILURE',
  'VERIFY_UNKNOWN_FAILURE',
] as const satisfies readonly BlockingVerifierCode[]);

const PRIMARY_PRECEDENCE_BY_CODE: ReadonlyMap<string, number> = new Map(
  PRIMARY_BLOCKING_VERIFIER_CODES.map((code, index) => [code, index + 1] as const),
);

/** One-based `precedenceIndex` for a blocking code, or `null` for advisory codes. */
export function primaryPrecedenceIndex(code: EvidenceVerifyCode): number | null {
  return PRIMARY_PRECEDENCE_BY_CODE.get(code) ?? null;
}

export function isAdvisoryVerifierCode(value: unknown): value is AdvisoryVerifierCode {
  return (
    typeof value === 'string' && (ADVISORY_VERIFIER_CODES as readonly string[]).includes(value)
  );
}

export function isEvidenceVerifyCode(value: unknown): value is EvidenceVerifyCode {
  return typeof value === 'string' && (EVIDENCE_VERIFY_CODES as readonly string[]).includes(value);
}

export function isBlockingVerifierCode(value: unknown): value is BlockingVerifierCode {
  return isEvidenceVerifyCode(value) && !isAdvisoryVerifierCode(value);
}

// ── Closed value vocabularies ─────────────────────────────────────────────────

export const EVIDENCE_VERIFY_SCOPES = ['run', 'suite'] as const;
export type EvidenceVerifyScope = (typeof EVIDENCE_VERIFY_SCOPES)[number];

export const EVIDENCE_VERIFY_ROOT_KINDS = ['run', 'suite'] as const;
export type EvidenceVerifyRootKind = (typeof EVIDENCE_VERIFY_ROOT_KINDS)[number];

export const EVIDENCE_VERIFY_CHECK_RESULTS = ['PASS', 'FAIL'] as const;
export type EvidenceVerifyCheckResult = (typeof EVIDENCE_VERIFY_CHECK_RESULTS)[number];

export const EVIDENCE_VERIFY_TRANSACTION_STATES = [
  'committed',
  'partial-transaction',
  'legacy-unverifiable',
  'no-transaction',
  'invalid-transaction',
] as const;
export type EvidenceVerifyTransactionState = (typeof EVIDENCE_VERIFY_TRANSACTION_STATES)[number];

export const EVIDENCE_VERIFY_FAILURE_CLASSES = ['HARNESS_BLOCKED', 'ENVIRONMENT_FAILURE'] as const;
export type EvidenceVerifyFailureClass = (typeof EVIDENCE_VERIFY_FAILURE_CLASSES)[number];

export const EVIDENCE_VERIFY_COMMIT_POINTS = [
  'committed',
  'not-committed',
  'not-applicable',
] as const;
export type EvidenceVerifyCommitPoint = (typeof EVIDENCE_VERIFY_COMMIT_POINTS)[number];

export const EVIDENCE_VERIFY_CHECK_CATEGORIES = [
  'root',
  'schema',
  'transaction',
  'bytes',
  'semantic-digest',
  'reference',
  'extra-file',
  'authority',
  'provenance',
  'sanitization',
  'privacy',
  'legacy',
  'suite',
] as const;
export type EvidenceVerifyCheckCategory = (typeof EVIDENCE_VERIFY_CHECK_CATEGORIES)[number];

export const EVIDENCE_VERIFY_CHECK_IDS = [
  'ROOT_RESOLUTION',
  'STRICT_RECORD',
  'INVENTORY_CONTRACT',
  'MANIFEST_CONTRACT',
  'SEALED_SCHEMA_AGREEMENT',
  'TRANSACTION_STATE',
  'ARTIFACT_SET',
  'ARTIFACT_BYTES',
  'ARTIFACT_SHA256',
  'ARTIFACT_SEMANTIC_DIGEST',
  'REFERENCE_GRAPH',
  'REQUIRED_AUTHORITY',
  'PROVENANCE_CONTRACT',
  'PROVENANCE_IDENTITY',
  'SANITIZATION_GUARD',
  'SECRET_SCAN',
  'PATH_SCAN',
  'CUSTOMER_MARKER_SCAN',
  'EXTRA_FILE_SCAN',
  'FINALIZATION_IMMUTABILITY',
  'SUITE_RECORD',
  'SUITE_CHILD_MANIFESTS',
] as const;
export type EvidenceVerifyCheckId = (typeof EVIDENCE_VERIFY_CHECK_IDS)[number];

export const EVIDENCE_VERIFY_CURRENT_TREE_CHECKS = [
  'not-run',
  'PASS',
  'DRIFT',
  'UNAVAILABLE',
] as const;
export type EvidenceVerifyCurrentTreeCheck = (typeof EVIDENCE_VERIFY_CURRENT_TREE_CHECKS)[number];

export const EVIDENCE_VERIFY_SUITE_ACTIVATIONS = [
  'deferred-not-activated',
  'forbidden-activated',
] as const;
export type EvidenceVerifySuiteActivation = (typeof EVIDENCE_VERIFY_SUITE_ACTIVATIONS)[number];

export const EVIDENCE_VERIFY_SEVERITIES = ['blocking', 'diagnostic'] as const;
export type EvidenceVerifySeverity = (typeof EVIDENCE_VERIFY_SEVERITIES)[number];

/** Suite record labels a report may name. `suite-v1` is labelled legacy only. */
export const EVIDENCE_VERIFY_SUITE_RECORD_LABELS = ['suite-v1', 'suite-v2'] as const;
export type EvidenceVerifySuiteRecordLabel = (typeof EVIDENCE_VERIFY_SUITE_RECORD_LABELS)[number];

export const EVIDENCE_VERIFY_ROOT_RELATIVE_PATH_PREFIXES = [
  'evidence/runs/',
  'evidence/suites/',
] as const;

/**
 * A safe `evidence/runs/<safe-id>` or `evidence/suites/<safe-id>` relative path.
 * Absolute paths, `file:`/`blob:` forms, traversal, and backslashes are rejected.
 */
export function isEvidenceVerifyRootRelativePath(
  value: unknown,
  kind?: EvidenceVerifyRootKind,
): value is string {
  if (typeof value !== 'string') return false;
  const prefix =
    kind === 'run'
      ? 'evidence/runs/'
      : kind === 'suite'
        ? 'evidence/suites/'
        : EVIDENCE_VERIFY_ROOT_RELATIVE_PATH_PREFIXES.find((candidate) =>
            value.startsWith(candidate),
          );
  if (prefix === undefined) return false;
  const id = value.slice(prefix.length);
  return isEvidenceLogicalId(id) && !id.includes('/');
}

// ── Closed detail-code union ──────────────────────────────────────────────────

/** Fixed inspection/internal literals permitted as `detailCode` values. */
export const FIXED_INSPECTION_DETAIL_CODES = Object.freeze([
  'PROHIBITED_BYTES_NONE',
  'PROHIBITED_BYTES_FOUND',
  'PROHIBITED_BYTES_MALFORMED_PNG',
  'PROHIBITED_BYTES_INVALID_INPUT',
  'ARTIFACT_LENGTH',
  'ARTIFACT_SHA256',
  'ARTIFACT_SEMANTIC_DIGEST',
  'CURRENT_TREE_DRIFT',
  'CURRENT_TREE_UNAVAILABLE',
  'ROOT_RESOLUTION',
  'UNKNOWN_EXCEPTION',
] as const);

/** Reference-graph validator source literals (`EvidenceReferenceFailureCode`). */
export const EVIDENCE_REFERENCE_FAILURE_SOURCE_CODES = Object.freeze([
  'REFERENCE_DANGLING',
  'REFERENCE_SELF',
  'REFERENCE_DUPLICATE',
  'REFERENCE_CYCLE',
  'REFERENCE_ORDER_INVALID',
  'REFERENCE_KIND_MISMATCH',
  'REFERENCE_REQUIRED_MISSING',
  'REFERENCE_REQUIRED_MISMATCH',
  'REFERENCE_INVENTORY_MISMATCH',
  'REFERENCE_UNKNOWN_ARTIFACT',
  'REFERENCE_TRANSACTION_MISMATCH',
] as const);

/** Inventory/manifest contract source literals (`EvidenceContractIssueCode`). */
export const EVIDENCE_CONTRACT_ISSUE_SOURCE_CODES = Object.freeze([
  'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
  'EVIDENCE_UNKNOWN_KEY',
  'EVIDENCE_MISSING_KEY',
  'EVIDENCE_SCHEMA_VERSION_UNSUPPORTED',
  'EVIDENCE_LABEL_UNSUPPORTED',
  'EVIDENCE_TRANSACTION_KIND_UNKNOWN',
  'EVIDENCE_ID_INVALID',
  'EVIDENCE_DIGEST_INVALID',
  'EVIDENCE_BYTE_LENGTH_INVALID',
  'EVIDENCE_RELATIVE_PATH_INVALID',
  'EVIDENCE_ARTIFACT_ROLE_UNKNOWN',
  'EVIDENCE_ARTIFACT_DUPLICATE_ID',
  'EVIDENCE_ARTIFACT_ORDER_INVALID',
  'EVIDENCE_ARTIFACT_EMPTY',
  'EVIDENCE_MEDIA_TYPE_INVALID',
  'EVIDENCE_PRODUCER_PHASE_UNKNOWN',
  'EVIDENCE_SANITIZATION_POLICY_UNKNOWN',
  'EVIDENCE_RETENTION_STATUS_UNKNOWN',
  'EVIDENCE_REFERENCE_KIND_UNKNOWN',
  'EVIDENCE_REFERENCE_DANGLING',
  'EVIDENCE_REFERENCE_ORDER_INVALID',
  'EVIDENCE_SEMANTIC_DIGEST_KIND_UNKNOWN',
  'EVIDENCE_PROVENANCE_INVALID',
  'EVIDENCE_OUTCOME_UNKNOWN',
  'EVIDENCE_TRANSACTION_RESULT_UNSUPPORTED',
  'EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH',
  'EVIDENCE_COMMITTED_ARTIFACT_MISMATCH',
] as const);

/** Semantic-digest source literals (`EvidenceSemanticDigestFailureCode`). */
export const EVIDENCE_SEMANTIC_DIGEST_FAILURE_SOURCE_CODES = Object.freeze([
  'SEMANTIC_DIGEST_KIND_UNKNOWN',
  'SEMANTIC_DIGEST_VALUE_NOT_ORDERED_LIST',
  'SEMANTIC_DIGEST_VALUE_NOT_RECORD_SET',
  'SEMANTIC_DIGEST_RECORD_SET_ID_MISSING',
  'SEMANTIC_DIGEST_VALUE_NOT_BYTES',
] as const);

/** Sanitizer source literals (`EvidenceSanitizationFailureCode`). */
export const EVIDENCE_SANITIZATION_FAILURE_SOURCE_CODES = Object.freeze([
  'SANITIZATION_ROLE_UNKNOWN',
  'SANITIZATION_POLICY_UNKNOWN',
  'SANITIZATION_BYTES_INVALID',
  'SANITIZATION_PROHIBITED_VALUE',
  'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
  'SANITIZATION_REQUIRED_AUTHORITY_OMITTED',
  'SANITIZATION_ARTIFACT_ID_INVALID',
  'SANITIZATION_PATH_INVALID',
  'SANITIZATION_APPROVAL_FORGED',
] as const);

/** Provenance-policy source literals (`ProvenancePolicyFailureCode`). */
export const EVIDENCE_PROVENANCE_FAILURE_SOURCE_CODES = Object.freeze([
  'PROVENANCE_PATH_NOT_RELATIVE',
  'PROVENANCE_PATH_PROHIBITED',
  'PROVENANCE_DIGEST_INVALID',
  'PROVENANCE_IDENTITY_ORDER_INVALID',
  'PROVENANCE_POLICY_UNSUPPORTED',
] as const);

/** Redaction-guard source literals (`RedactionFailureCode`). */
export const EVIDENCE_REDACTION_FAILURE_SOURCE_CODES = Object.freeze([
  'REDACTION_NOT_PLAIN_JSON',
  'REDACTION_PROHIBITED_VALUE',
] as const);

/** Strict run/public reader source literals (24 `FINAL_RECORD_ASSEMBLY_ISSUE_CODES`). */
export const FINAL_RECORD_ASSEMBLY_ISSUE_SOURCE_CODES = Object.freeze([
  'FINAL_RECORD_NOT_OBJECT',
  'FINAL_RECORD_ENVELOPE_NOT_OBJECT',
  'FINAL_RECORD_ENVELOPE_SCHEMA_UNSUPPORTED',
  'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_INVALID',
  'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
  'FINAL_RECORD_ENVELOPE_PROFILE_MISSING',
  'FINAL_RECORD_ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
  'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_INVALID',
  'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
  'FINAL_RECORD_ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
  'FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT',
  'FINAL_RECORD_ACTION_CYCLE_MISSING',
  'FINAL_RECORD_ACTION_CYCLE_DUPLICATE',
  'FINAL_RECORD_ACTION_CYCLE_READINESS_MISMATCH',
  'FINAL_RECORD_CHECK_CONTEXT_INVALID',
  'FINAL_RECORD_NESTED_PROJECTION_INVALID',
  'FINAL_RECORD_NESTED_PROJECTION_DUPLICATE',
  'FINAL_RECORD_NESTED_PROJECTION_UNKNOWN_FAMILY',
  'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
  'FINAL_RECORD_LEGACY_BOOLEAN_PRESENT',
  'FINAL_RECORD_HARNESS_INVALID_PRESENT',
  'FINAL_RECORD_SCHEMA_UNSUPPORTED',
  'FINAL_RECORD_FIELD_INVALID',
  'FINAL_RECORD_SELF_CHECK_FAILED',
] as const);

/** Strict run/public reader source literals (33 `RESULT_CONTRACT_ISSUE_CODES`). */
export const RESULT_CONTRACT_ISSUE_SOURCE_CODES = Object.freeze([
  'RESULT_RECORD_NOT_OBJECT',
  'RESULT_SCHEMA_VERSION_UNSUPPORTED',
  'RESULT_PROFILE_IDENTITY_INVALID',
  'RESULT_COMPONENT_FINGERPRINTS_MISSING',
  'RESULT_FINGERPRINT_MISSING',
  'RESULT_FINGERPRINT_INVALID',
  'RESULT_ACTION_CYCLE_MISSING',
  'RESULT_ACTION_CYCLE_DUPLICATE',
  'RESULT_ACTION_CYCLE_REF_MISSING',
  'RESULT_ACTION_CYCLE_UNRESOLVED',
  'RESULT_ACTION_CYCLE_PROFILE_MISMATCH',
  'RESULT_READINESS_FINGERPRINT_MISMATCH',
  'RESULT_CONSUMED_COMPONENT_MISMATCH',
  'RESULT_REQUIRED_CHECK_MISSING',
  'RESULT_REQUIRED_CHECK_UNKNOWN',
  'RESULT_REQUIRED_CHECK_DUPLICATE',
  'RESULT_EMPTY_REQUIRED_CHECKS',
  'RESULT_CHECK_STATUS_MISSING',
  'RESULT_CHECK_STATUS_UNKNOWN',
  'RESULT_CHECK_SHAPE_MIXED',
  'RESULT_BOOLEAN_PASSED_PRESENT',
  'RESULT_HARNESS_INVALID_PRESENT',
  'RESULT_EXPECTED_INVALID',
  'RESULT_ACTUAL_INVALID',
  'RESULT_EVIDENCE_UNDECLARED',
  'RESULT_EVIDENCE_MISSING',
  'RESULT_TOLERANCE_REF_UNDECLARED',
  'RESULT_VISUAL_REF_UNDECLARED',
  'RESULT_NORMALIZATION_REF_INVALID',
  'RESULT_COMMAND_CONTEXT_REQUIRED',
  'RESULT_COMMAND_CONTEXT_FORBIDDEN',
  'RESULT_COMMAND_AUTHORITY_INVALID',
  'RESULT_LEGACY_BOOLEAN_AMBIGUOUS',
] as const);

/** Strict suite reader source literals (18 `FINAL_SUITE_RECORD_ISSUE_CODES`). */
export const FINAL_SUITE_RECORD_ISSUE_SOURCE_CODES = Object.freeze([
  'SUITE_RECORD_NOT_OBJECT',
  'SUITE_RECORD_SCHEMA_UNSUPPORTED',
  'SUITE_RECORD_LABEL_UNSUPPORTED',
  'SUITE_RECORD_COMMAND_UNSUPPORTED',
  'SUITE_RECORD_UNKNOWN_KEY',
  'SUITE_RECORD_MISSING_KEY',
  'SUITE_RECORD_FIELD_INVALID',
  'SUITE_RECORD_SUITE_ID_UNKNOWN',
  'SUITE_RECORD_FINGERPRINT_INVALID',
  'SUITE_RECORD_COUNT_MISMATCH',
  'SUITE_RECORD_ORDER_INVALID',
  'SUITE_RECORD_CHILD_INVALID',
  'SUITE_RECORD_CHILD_DUPLICATE',
  'SUITE_RECORD_CHILD_NOT_STRICT_V4',
  'SUITE_RECORD_CHILD_IDENTITY_MISMATCH',
  'SUITE_RECORD_CHILD_EXECUTION_ALIASED',
  'SUITE_RECORD_LINEAGE_MISMATCH',
  'SUITE_RECORD_LEGACY_AUTHORITY_PRESENT',
] as const);

/**
 * The complete, closed `detailCode` union: every source validator/reader issue
 * literal plus the fixed inspection/internal literals. This is the only legal
 * `detailCode` set; source `detail`/`path`/`checkId`/label/exception text is
 * never a legal value.
 */
export const EVIDENCE_VERIFY_DETAIL_CODES = Object.freeze([
  ...FIXED_INSPECTION_DETAIL_CODES,
  ...EVIDENCE_REFERENCE_FAILURE_SOURCE_CODES,
  ...EVIDENCE_CONTRACT_ISSUE_SOURCE_CODES,
  ...EVIDENCE_SEMANTIC_DIGEST_FAILURE_SOURCE_CODES,
  ...EVIDENCE_SANITIZATION_FAILURE_SOURCE_CODES,
  ...EVIDENCE_PROVENANCE_FAILURE_SOURCE_CODES,
  ...EVIDENCE_REDACTION_FAILURE_SOURCE_CODES,
  ...FINAL_RECORD_ASSEMBLY_ISSUE_SOURCE_CODES,
  ...RESULT_CONTRACT_ISSUE_SOURCE_CODES,
  ...FINAL_SUITE_RECORD_ISSUE_SOURCE_CODES,
] as const);
export type EvidenceVerifyDetailCode = (typeof EVIDENCE_VERIFY_DETAIL_CODES)[number];

const DETAIL_CODE_SET: ReadonlySet<string> = new Set(EVIDENCE_VERIFY_DETAIL_CODES);

export function isEvidenceVerifyDetailCode(value: unknown): value is EvidenceVerifyDetailCode {
  return typeof value === 'string' && DETAIL_CODE_SET.has(value);
}

// ── In-verifier subject identity detail codenames ─────────────────────────────

/** In-verifier governed subject detail codenames (B1 artifact inspectability). */
export const ARTIFACT_LENGTH_DETAIL_CODE = 'ARTIFACT_LENGTH' as const;
export const ARTIFACT_SHA256_DETAIL_CODE = 'ARTIFACT_SHA256' as const;
export const ARTIFACT_SEMANTIC_DIGEST_DETAIL_CODE = 'ARTIFACT_SEMANTIC_DIGEST' as const;

// ── Source-issue projection tables (complete, literal, no raw passthrough) ────

export interface EvidenceVerifyProjectionRow {
  readonly sourceCode: string;
  readonly verifierCode: BlockingVerifierCode;
  readonly severity: 'blocking';
  readonly detailCode: EvidenceVerifyDetailCode;
  readonly rawPassthrough: false;
}

/** Reference-graph validator projection (11 rows). */
export const EVIDENCE_REFERENCE_FAILURE_PROJECTION = Object.freeze([
  {
    sourceCode: 'REFERENCE_DANGLING',
    verifierCode: 'VERIFY_REFERENCE_DANGLING',
    severity: 'blocking',
    detailCode: 'REFERENCE_DANGLING',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_SELF',
    verifierCode: 'VERIFY_REFERENCE_DANGLING',
    severity: 'blocking',
    detailCode: 'REFERENCE_SELF',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_DUPLICATE',
    verifierCode: 'VERIFY_REFERENCE_ORDER_INVALID',
    severity: 'blocking',
    detailCode: 'REFERENCE_DUPLICATE',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_CYCLE',
    verifierCode: 'VERIFY_REFERENCE_ORDER_INVALID',
    severity: 'blocking',
    detailCode: 'REFERENCE_CYCLE',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_ORDER_INVALID',
    verifierCode: 'VERIFY_REFERENCE_ORDER_INVALID',
    severity: 'blocking',
    detailCode: 'REFERENCE_ORDER_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_KIND_MISMATCH',
    verifierCode: 'VERIFY_REFERENCE_ORDER_INVALID',
    severity: 'blocking',
    detailCode: 'REFERENCE_KIND_MISMATCH',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_REQUIRED_MISSING',
    verifierCode: 'VERIFY_REQUIRED_AUTHORITY_MISSING',
    severity: 'blocking',
    detailCode: 'REFERENCE_REQUIRED_MISSING',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_REQUIRED_MISMATCH',
    verifierCode: 'VERIFY_REQUIRED_AUTHORITY_WEAKENED',
    severity: 'blocking',
    detailCode: 'REFERENCE_REQUIRED_MISMATCH',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_INVENTORY_MISMATCH',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'REFERENCE_INVENTORY_MISMATCH',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_UNKNOWN_ARTIFACT',
    verifierCode: 'VERIFY_REFERENCE_UNKNOWN_ID',
    severity: 'blocking',
    detailCode: 'REFERENCE_UNKNOWN_ARTIFACT',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REFERENCE_TRANSACTION_MISMATCH',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'REFERENCE_TRANSACTION_MISMATCH',
    rawPassthrough: false,
  },
] as const satisfies readonly EvidenceVerifyProjectionRow[]);

/** Inventory/manifest contract validator projection (27 rows). */
export const EVIDENCE_CONTRACT_ISSUE_PROJECTION = Object.freeze([
  {
    sourceCode: 'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
    verifierCode: 'VERIFY_JSON_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_UNKNOWN_KEY',
    verifierCode: 'VERIFY_UNKNOWN_KEY',
    severity: 'blocking',
    detailCode: 'EVIDENCE_UNKNOWN_KEY',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_MISSING_KEY',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_MISSING_KEY',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_SCHEMA_VERSION_UNSUPPORTED',
    verifierCode: 'VERIFY_UNKNOWN_SCHEMA',
    severity: 'blocking',
    detailCode: 'EVIDENCE_SCHEMA_VERSION_UNSUPPORTED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_LABEL_UNSUPPORTED',
    verifierCode: 'VERIFY_UNKNOWN_LABEL',
    severity: 'blocking',
    detailCode: 'EVIDENCE_LABEL_UNSUPPORTED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_TRANSACTION_KIND_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_TRANSACTION_KIND_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_ID_INVALID',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_ID_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_DIGEST_INVALID',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_DIGEST_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_BYTE_LENGTH_INVALID',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_BYTE_LENGTH_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_RELATIVE_PATH_INVALID',
    verifierCode: 'VERIFY_ARTIFACT_PATH_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_RELATIVE_PATH_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_ARTIFACT_ROLE_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_ARTIFACT_ROLE_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_ARTIFACT_DUPLICATE_ID',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_ARTIFACT_DUPLICATE_ID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_ARTIFACT_ORDER_INVALID',
    verifierCode: 'VERIFY_REFERENCE_ORDER_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_ARTIFACT_ORDER_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_ARTIFACT_EMPTY',
    verifierCode: 'VERIFY_REQUIRED_AUTHORITY_MISSING',
    severity: 'blocking',
    detailCode: 'EVIDENCE_ARTIFACT_EMPTY',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_MEDIA_TYPE_INVALID',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_MEDIA_TYPE_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_PRODUCER_PHASE_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_PRODUCER_PHASE_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_SANITIZATION_POLICY_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_SANITIZATION_POLICY_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_RETENTION_STATUS_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_RETENTION_STATUS_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_REFERENCE_KIND_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_REFERENCE_KIND_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_REFERENCE_DANGLING',
    verifierCode: 'VERIFY_REFERENCE_DANGLING',
    severity: 'blocking',
    detailCode: 'EVIDENCE_REFERENCE_DANGLING',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_REFERENCE_ORDER_INVALID',
    verifierCode: 'VERIFY_REFERENCE_ORDER_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_REFERENCE_ORDER_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_SEMANTIC_DIGEST_KIND_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_SEMANTIC_DIGEST_KIND_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_PROVENANCE_INVALID',
    verifierCode: 'VERIFY_PROVENANCE_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_PROVENANCE_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_OUTCOME_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'EVIDENCE_OUTCOME_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_TRANSACTION_RESULT_UNSUPPORTED',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_TRANSACTION_RESULT_UNSUPPORTED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH',
    verifierCode: 'VERIFY_SEALED_SCHEMA_MISMATCH',
    severity: 'blocking',
    detailCode: 'EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH',
    rawPassthrough: false,
  },
  {
    sourceCode: 'EVIDENCE_COMMITTED_ARTIFACT_MISMATCH',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'EVIDENCE_COMMITTED_ARTIFACT_MISMATCH',
    rawPassthrough: false,
  },
] as const satisfies readonly EvidenceVerifyProjectionRow[]);

/** Semantic-digest, sanitization, provenance, and redaction projections (21 rows). */
export const EVIDENCE_AUXILIARY_FAILURE_PROJECTION = Object.freeze([
  {
    sourceCode: 'SEMANTIC_DIGEST_KIND_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'SEMANTIC_DIGEST_KIND_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SEMANTIC_DIGEST_VALUE_NOT_ORDERED_LIST',
    verifierCode: 'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
    severity: 'blocking',
    detailCode: 'SEMANTIC_DIGEST_VALUE_NOT_ORDERED_LIST',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SEMANTIC_DIGEST_VALUE_NOT_RECORD_SET',
    verifierCode: 'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
    severity: 'blocking',
    detailCode: 'SEMANTIC_DIGEST_VALUE_NOT_RECORD_SET',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SEMANTIC_DIGEST_RECORD_SET_ID_MISSING',
    verifierCode: 'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
    severity: 'blocking',
    detailCode: 'SEMANTIC_DIGEST_RECORD_SET_ID_MISSING',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SEMANTIC_DIGEST_VALUE_NOT_BYTES',
    verifierCode: 'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
    severity: 'blocking',
    detailCode: 'SEMANTIC_DIGEST_VALUE_NOT_BYTES',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_ROLE_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'SANITIZATION_ROLE_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_POLICY_UNKNOWN',
    verifierCode: 'VERIFY_UNKNOWN_DISCRIMINANT',
    severity: 'blocking',
    detailCode: 'SANITIZATION_POLICY_UNKNOWN',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_BYTES_INVALID',
    verifierCode: 'VERIFY_SANITIZATION_PROHIBITED_VALUE',
    severity: 'blocking',
    detailCode: 'SANITIZATION_BYTES_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_PROHIBITED_VALUE',
    verifierCode: 'VERIFY_SANITIZATION_PROHIBITED_VALUE',
    severity: 'blocking',
    detailCode: 'SANITIZATION_PROHIBITED_VALUE',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
    verifierCode: 'VERIFY_REQUIRED_AUTHORITY_REDACTED',
    severity: 'blocking',
    detailCode: 'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_REQUIRED_AUTHORITY_OMITTED',
    verifierCode: 'VERIFY_REQUIRED_AUTHORITY_REDACTED',
    severity: 'blocking',
    detailCode: 'SANITIZATION_REQUIRED_AUTHORITY_OMITTED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_ARTIFACT_ID_INVALID',
    verifierCode: 'VERIFY_TRANSACTION_INVALID',
    severity: 'blocking',
    detailCode: 'SANITIZATION_ARTIFACT_ID_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_PATH_INVALID',
    verifierCode: 'VERIFY_ARTIFACT_PATH_INVALID',
    severity: 'blocking',
    detailCode: 'SANITIZATION_PATH_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'SANITIZATION_APPROVAL_FORGED',
    verifierCode: 'VERIFY_SANITIZATION_PROHIBITED_VALUE',
    severity: 'blocking',
    detailCode: 'SANITIZATION_APPROVAL_FORGED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'PROVENANCE_PATH_NOT_RELATIVE',
    verifierCode: 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH',
    severity: 'blocking',
    detailCode: 'PROVENANCE_PATH_NOT_RELATIVE',
    rawPassthrough: false,
  },
  {
    sourceCode: 'PROVENANCE_PATH_PROHIBITED',
    verifierCode: 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH',
    severity: 'blocking',
    detailCode: 'PROVENANCE_PATH_PROHIBITED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'PROVENANCE_DIGEST_INVALID',
    verifierCode: 'VERIFY_PROVENANCE_INVALID',
    severity: 'blocking',
    detailCode: 'PROVENANCE_DIGEST_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'PROVENANCE_IDENTITY_ORDER_INVALID',
    verifierCode: 'VERIFY_PROVENANCE_INVALID',
    severity: 'blocking',
    detailCode: 'PROVENANCE_IDENTITY_ORDER_INVALID',
    rawPassthrough: false,
  },
  {
    sourceCode: 'PROVENANCE_POLICY_UNSUPPORTED',
    verifierCode: 'VERIFY_PROVENANCE_INVALID',
    severity: 'blocking',
    detailCode: 'PROVENANCE_POLICY_UNSUPPORTED',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REDACTION_NOT_PLAIN_JSON',
    verifierCode: 'VERIFY_JSON_INVALID',
    severity: 'blocking',
    detailCode: 'REDACTION_NOT_PLAIN_JSON',
    rawPassthrough: false,
  },
  {
    sourceCode: 'REDACTION_PROHIBITED_VALUE',
    verifierCode: 'VERIFY_SANITIZATION_PROHIBITED_VALUE',
    severity: 'blocking',
    detailCode: 'REDACTION_PROHIBITED_VALUE',
    rawPassthrough: false,
  },
] as const satisfies readonly EvidenceVerifyProjectionRow[]);

/** Strict run/public reader projection (57 rows: 24 assembly + 33 result). */
export const FINAL_RECORD_ISSUE_PROJECTION = Object.freeze([
  { source: 'FINAL_RECORD_NOT_OBJECT', to: 'VERIFY_JSON_INVALID' },
  { source: 'FINAL_RECORD_ENVELOPE_NOT_OBJECT', to: 'VERIFY_JSON_INVALID' },
  { source: 'FINAL_RECORD_ENVELOPE_SCHEMA_UNSUPPORTED', to: 'VERIFY_UNKNOWN_SCHEMA' },
  { source: 'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_INVALID', to: 'VERIFY_PROVENANCE_INVALID' },
  {
    source: 'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
    to: 'VERIFY_PROVENANCE_IDENTITY_MISMATCH',
  },
  { source: 'FINAL_RECORD_ENVELOPE_PROFILE_MISSING', to: 'VERIFY_REQUIRED_AUTHORITY_MISSING' },
  {
    source: 'FINAL_RECORD_ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
    to: 'VERIFY_UNKNOWN_SCHEMA',
  },
  { source: 'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_INVALID', to: 'VERIFY_PROVENANCE_INVALID' },
  {
    source: 'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
    to: 'VERIFY_PROVENANCE_IDENTITY_MISMATCH',
  },
  {
    source: 'FINAL_RECORD_ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
    to: 'VERIFY_PROVENANCE_INVALID',
  },
  {
    source: 'FINAL_RECORD_ENVELOPE_REQUIRED_CHECK_DRIFT',
    to: 'VERIFY_REQUIRED_AUTHORITY_WEAKENED',
  },
  { source: 'FINAL_RECORD_ACTION_CYCLE_MISSING', to: 'VERIFY_REFERENCE_DANGLING' },
  { source: 'FINAL_RECORD_ACTION_CYCLE_DUPLICATE', to: 'VERIFY_REFERENCE_ORDER_INVALID' },
  {
    source: 'FINAL_RECORD_ACTION_CYCLE_READINESS_MISMATCH',
    to: 'VERIFY_PROVENANCE_IDENTITY_MISMATCH',
  },
  { source: 'FINAL_RECORD_CHECK_CONTEXT_INVALID', to: 'VERIFY_UNKNOWN_DISCRIMINANT' },
  { source: 'FINAL_RECORD_NESTED_PROJECTION_INVALID', to: 'VERIFY_JSON_INVALID' },
  { source: 'FINAL_RECORD_NESTED_PROJECTION_DUPLICATE', to: 'VERIFY_REFERENCE_ORDER_INVALID' },
  {
    source: 'FINAL_RECORD_NESTED_PROJECTION_UNKNOWN_FAMILY',
    to: 'VERIFY_UNKNOWN_DISCRIMINANT',
  },
  {
    source: 'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
    to: 'VERIFY_REQUIRED_AUTHORITY_WEAKENED',
  },
  { source: 'FINAL_RECORD_LEGACY_BOOLEAN_PRESENT', to: 'VERIFY_SANITIZATION_PROHIBITED_VALUE' },
  { source: 'FINAL_RECORD_HARNESS_INVALID_PRESENT', to: 'VERIFY_SANITIZATION_PROHIBITED_VALUE' },
  { source: 'FINAL_RECORD_SCHEMA_UNSUPPORTED', to: 'VERIFY_UNKNOWN_SCHEMA' },
  { source: 'FINAL_RECORD_FIELD_INVALID', to: 'VERIFY_JSON_INVALID' },
  { source: 'FINAL_RECORD_SELF_CHECK_FAILED', to: 'VERIFY_TRANSACTION_INVALID' },
  { source: 'RESULT_RECORD_NOT_OBJECT', to: 'VERIFY_JSON_INVALID' },
  { source: 'RESULT_SCHEMA_VERSION_UNSUPPORTED', to: 'VERIFY_UNKNOWN_SCHEMA' },
  { source: 'RESULT_PROFILE_IDENTITY_INVALID', to: 'VERIFY_PROVENANCE_INVALID' },
  { source: 'RESULT_COMPONENT_FINGERPRINTS_MISSING', to: 'VERIFY_REQUIRED_AUTHORITY_MISSING' },
  { source: 'RESULT_FINGERPRINT_MISSING', to: 'VERIFY_REQUIRED_AUTHORITY_MISSING' },
  { source: 'RESULT_FINGERPRINT_INVALID', to: 'VERIFY_PROVENANCE_INVALID' },
  { source: 'RESULT_ACTION_CYCLE_MISSING', to: 'VERIFY_REFERENCE_DANGLING' },
  { source: 'RESULT_ACTION_CYCLE_DUPLICATE', to: 'VERIFY_REFERENCE_ORDER_INVALID' },
  { source: 'RESULT_ACTION_CYCLE_REF_MISSING', to: 'VERIFY_REFERENCE_DANGLING' },
  { source: 'RESULT_ACTION_CYCLE_UNRESOLVED', to: 'VERIFY_REFERENCE_UNKNOWN_ID' },
  { source: 'RESULT_ACTION_CYCLE_PROFILE_MISMATCH', to: 'VERIFY_PROVENANCE_IDENTITY_MISMATCH' },
  { source: 'RESULT_READINESS_FINGERPRINT_MISMATCH', to: 'VERIFY_PROVENANCE_IDENTITY_MISMATCH' },
  { source: 'RESULT_CONSUMED_COMPONENT_MISMATCH', to: 'VERIFY_PROVENANCE_IDENTITY_MISMATCH' },
  { source: 'RESULT_REQUIRED_CHECK_MISSING', to: 'VERIFY_REQUIRED_AUTHORITY_MISSING' },
  { source: 'RESULT_REQUIRED_CHECK_UNKNOWN', to: 'VERIFY_REFERENCE_UNKNOWN_ID' },
  { source: 'RESULT_REQUIRED_CHECK_DUPLICATE', to: 'VERIFY_REFERENCE_ORDER_INVALID' },
  { source: 'RESULT_EMPTY_REQUIRED_CHECKS', to: 'VERIFY_REQUIRED_AUTHORITY_MISSING' },
  { source: 'RESULT_CHECK_STATUS_MISSING', to: 'VERIFY_UNKNOWN_DISCRIMINANT' },
  { source: 'RESULT_CHECK_STATUS_UNKNOWN', to: 'VERIFY_UNKNOWN_DISCRIMINANT' },
  { source: 'RESULT_CHECK_SHAPE_MIXED', to: 'VERIFY_UNKNOWN_DISCRIMINANT' },
  { source: 'RESULT_BOOLEAN_PASSED_PRESENT', to: 'VERIFY_SANITIZATION_PROHIBITED_VALUE' },
  { source: 'RESULT_HARNESS_INVALID_PRESENT', to: 'VERIFY_SANITIZATION_PROHIBITED_VALUE' },
  { source: 'RESULT_EXPECTED_INVALID', to: 'VERIFY_JSON_INVALID' },
  { source: 'RESULT_ACTUAL_INVALID', to: 'VERIFY_JSON_INVALID' },
  { source: 'RESULT_EVIDENCE_UNDECLARED', to: 'VERIFY_REFERENCE_UNKNOWN_ID' },
  { source: 'RESULT_EVIDENCE_MISSING', to: 'VERIFY_REQUIRED_AUTHORITY_MISSING' },
  { source: 'RESULT_TOLERANCE_REF_UNDECLARED', to: 'VERIFY_REFERENCE_UNKNOWN_ID' },
  { source: 'RESULT_VISUAL_REF_UNDECLARED', to: 'VERIFY_REFERENCE_UNKNOWN_ID' },
  { source: 'RESULT_NORMALIZATION_REF_INVALID', to: 'VERIFY_REFERENCE_UNKNOWN_ID' },
  { source: 'RESULT_COMMAND_CONTEXT_REQUIRED', to: 'VERIFY_UNKNOWN_DISCRIMINANT' },
  { source: 'RESULT_COMMAND_CONTEXT_FORBIDDEN', to: 'VERIFY_UNKNOWN_DISCRIMINANT' },
  { source: 'RESULT_COMMAND_AUTHORITY_INVALID', to: 'VERIFY_REQUIRED_AUTHORITY_WEAKENED' },
  { source: 'RESULT_LEGACY_BOOLEAN_AMBIGUOUS', to: 'VERIFY_LEGACY_UNVERIFIABLE' },
] as const satisfies readonly EvidenceVerifyReaderProjectionRow[]);

/** Strict suite reader projection (18 rows). */
export const FINAL_SUITE_RECORD_ISSUE_PROJECTION = Object.freeze([
  { source: 'SUITE_RECORD_NOT_OBJECT', to: 'VERIFY_JSON_INVALID' },
  { source: 'SUITE_RECORD_SCHEMA_UNSUPPORTED', to: 'VERIFY_UNKNOWN_SCHEMA' },
  { source: 'SUITE_RECORD_LABEL_UNSUPPORTED', to: 'VERIFY_UNKNOWN_LABEL' },
  { source: 'SUITE_RECORD_COMMAND_UNSUPPORTED', to: 'VERIFY_UNKNOWN_DISCRIMINANT' },
  { source: 'SUITE_RECORD_UNKNOWN_KEY', to: 'VERIFY_UNKNOWN_KEY' },
  { source: 'SUITE_RECORD_MISSING_KEY', to: 'VERIFY_TRANSACTION_INVALID' },
  { source: 'SUITE_RECORD_FIELD_INVALID', to: 'VERIFY_JSON_INVALID' },
  { source: 'SUITE_RECORD_SUITE_ID_UNKNOWN', to: 'VERIFY_TRANSACTION_INVALID' },
  { source: 'SUITE_RECORD_FINGERPRINT_INVALID', to: 'VERIFY_PROVENANCE_INVALID' },
  { source: 'SUITE_RECORD_COUNT_MISMATCH', to: 'VERIFY_TRANSACTION_INVALID' },
  { source: 'SUITE_RECORD_ORDER_INVALID', to: 'VERIFY_REFERENCE_ORDER_INVALID' },
  { source: 'SUITE_RECORD_CHILD_INVALID', to: 'VERIFY_JSON_INVALID' },
  { source: 'SUITE_RECORD_CHILD_DUPLICATE', to: 'VERIFY_REFERENCE_ORDER_INVALID' },
  { source: 'SUITE_RECORD_CHILD_NOT_STRICT_V4', to: 'VERIFY_SEALED_SCHEMA_MISMATCH' },
  { source: 'SUITE_RECORD_CHILD_IDENTITY_MISMATCH', to: 'VERIFY_SUITE_CHILD_IDENTITY_MISMATCH' },
  { source: 'SUITE_RECORD_CHILD_EXECUTION_ALIASED', to: 'VERIFY_SUITE_CHILD_IDENTITY_MISMATCH' },
  { source: 'SUITE_RECORD_LINEAGE_MISMATCH', to: 'VERIFY_SUITE_CHILD_IDENTITY_MISMATCH' },
  { source: 'SUITE_RECORD_LEGACY_AUTHORITY_PRESENT', to: 'VERIFY_SANITIZATION_PROHIBITED_VALUE' },
] as const satisfies readonly EvidenceVerifyReaderProjectionRow[]);

/**
 * Reader projection rows are written as `{ source, to }` because their
 * `detailCode` is always the source literal itself.
 */
export interface EvidenceVerifyReaderProjectionRow {
  readonly source: string;
  readonly to: BlockingVerifierCode;
}

function readerRows(
  rows: readonly EvidenceVerifyReaderProjectionRow[],
): readonly EvidenceVerifyProjectionRow[] {
  return rows.map((row) => ({
    sourceCode: row.source,
    verifierCode: row.to,
    severity: 'blocking' as const,
    detailCode: row.source as EvidenceVerifyDetailCode,
    rawPassthrough: false as const,
  }));
}

/** The complete immutable source-issue projection contract (124 rows). */
export const EVIDENCE_VERIFY_SOURCE_PROJECTION: readonly EvidenceVerifyProjectionRow[] =
  Object.freeze([
    ...EVIDENCE_REFERENCE_FAILURE_PROJECTION,
    ...EVIDENCE_CONTRACT_ISSUE_PROJECTION,
    ...EVIDENCE_AUXILIARY_FAILURE_PROJECTION,
    ...readerRows(FINAL_RECORD_ISSUE_PROJECTION),
    ...readerRows(FINAL_SUITE_RECORD_ISSUE_PROJECTION),
  ]);

const SOURCE_PROJECTION_BY_CODE: ReadonlyMap<string, EvidenceVerifyProjectionRow> = new Map(
  EVIDENCE_VERIFY_SOURCE_PROJECTION.map((row) => [row.sourceCode, row] as const),
);

/** Closed error codes for internal contract/projection failures (never emitted). */
export const EVIDENCE_VERIFY_CONTRACT_ERROR_CODES = Object.freeze([
  'EVIDENCE_VERIFY_CONTRACT_UNMAPPED_SOURCE',
  'EVIDENCE_VERIFY_CONTRACT_INVALID_DETAILS',
] as const);
export type EvidenceVerifyContractErrorCode = (typeof EVIDENCE_VERIFY_CONTRACT_ERROR_CODES)[number];

/** Thrown for an unmapped source issue or an invalid parsed report. Never emitted. */
export class EvidenceVerifyContractError extends Error {
  readonly code: EvidenceVerifyContractErrorCode;
  readonly path: string;
  constructor(code: EvidenceVerifyContractErrorCode, path: string, message: string) {
    super(message);
    this.name = 'EvidenceVerifyContractError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Project one source validator/reader issue to its single closed verifier row.
 * An unmapped source literal is rejected (a stop condition), never coerced or
 * passed through raw.
 */
export function projectSourceIssue(sourceCode: string): EvidenceVerifyProjectionRow {
  const row = SOURCE_PROJECTION_BY_CODE.get(sourceCode);
  if (row === undefined) {
    throw new EvidenceVerifyContractError(
      'EVIDENCE_VERIFY_CONTRACT_UNMAPPED_SOURCE',
      'sourceCode',
      'Unmapped source issue code; the closed projection contract must be extended by authority.',
    );
  }
  return row;
}

// ── Closed report DTOs ────────────────────────────────────────────────────────

export interface EvidenceVerifyDiagnostic {
  readonly code: EvidenceVerifyCode;
  readonly severity: EvidenceVerifySeverity;
  readonly detailCode: EvidenceVerifyDetailCode;
  readonly subjectOrdinal: number | null;
}

export interface EvidenceVerifyTransaction {
  readonly state: EvidenceVerifyTransactionState;
  readonly failureClass: EvidenceVerifyFailureClass | null;
  readonly failureCode: BlockingVerifierCode | null;
  readonly commitPoint: EvidenceVerifyCommitPoint;
  readonly creditEligible: boolean;
  readonly immutable: boolean;
  readonly finalManifestPresent: boolean;
  readonly finalManifestValid: boolean;
  readonly strictRecordPresent: boolean;
  readonly behaviorOutcome: Outcome | null;
}

export interface EvidenceVerifyCheck {
  readonly id: EvidenceVerifyCheckId;
  readonly category: EvidenceVerifyCheckCategory;
  readonly result: EvidenceVerifyCheckResult;
  readonly code: EvidenceVerifyCode;
}

export interface EvidenceVerifyArtifacts {
  readonly declaredCount: number;
  readonly verifiedCount: number;
  readonly requiredCount: number;
  readonly diagnosticCount: number;
  readonly missingIds: readonly string[];
  readonly extraRelativePaths: readonly string[];
}

export interface EvidenceVerifyReferences {
  readonly declaredCount: number;
  readonly verifiedCount: number;
}

export interface EvidenceVerifyProvenance {
  readonly persistedIdentityValid: boolean;
  readonly currentTreeCheck: EvidenceVerifyCurrentTreeCheck;
  readonly currentTreeCreditEligible: boolean;
  readonly repositoryRevisionPresent: boolean;
  readonly dirtyPolicyPresent: boolean;
  readonly lockfileDigestPresent: boolean;
  readonly componentDigestsPresent: boolean;
  readonly catalogueIdentitiesPresent: boolean;
  readonly profileIdentitiesPresent: boolean;
}

export interface EvidenceVerifySanitization {
  readonly requiredApproved: boolean;
  readonly diagnosticApproved: boolean;
  readonly requiredAuthorityPreserved: boolean;
  readonly prohibitedValuesFound: boolean;
}

export interface EvidenceVerifySuite {
  readonly recordLabel: EvidenceVerifySuiteRecordLabel | null;
  readonly recordSchemaVersion: number | null;
  readonly childCount: number;
  readonly committedChildCount: number;
  readonly uncommittedChildIds: readonly string[];
  readonly suiteTransactionActivation: EvidenceVerifySuiteActivation;
}

export interface EvidenceVerifyDetails {
  readonly schemaVersion: typeof EVIDENCE_VERIFY_SCHEMA_VERSION;
  readonly reportLabel: typeof EVIDENCE_VERIFY_REPORT_LABEL;
  readonly scope: EvidenceVerifyScope;
  readonly requestedId: string;
  readonly rootKind: EvidenceVerifyRootKind;
  readonly rootRelativePath: string;
  readonly transaction: EvidenceVerifyTransaction;
  readonly checks: readonly EvidenceVerifyCheck[];
  readonly artifacts: EvidenceVerifyArtifacts;
  readonly references: EvidenceVerifyReferences;
  readonly provenance: EvidenceVerifyProvenance;
  readonly sanitization: EvidenceVerifySanitization;
  readonly suite: EvidenceVerifySuite | null;
  readonly diagnostics: readonly EvidenceVerifyDiagnostic[];
}

/** Exact closed top-level key inventory of `evidence-verify.v1`. */
export const EVIDENCE_VERIFY_DETAILS_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'reportLabel',
  'scope',
  'requestedId',
  'rootKind',
  'rootRelativePath',
  'transaction',
  'checks',
  'artifacts',
  'references',
  'provenance',
  'sanitization',
  'suite',
  'diagnostics',
]);

// ── Deterministic ordering + primary selection ────────────────────────────────

const CHECK_ID_ORDER: ReadonlyMap<string, number> = new Map(
  EVIDENCE_VERIFY_CHECK_IDS.map((id, index) => [id, index] as const),
);

const DETAIL_CODE_ORDER: ReadonlyMap<string, number> = new Map(
  EVIDENCE_VERIFY_DETAIL_CODES.map((code, index) => [code, index] as const),
);

function compareNullableOrdinal(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Canonical check order: the closed check-id order. */
export function compareEvidenceVerifyChecks(
  a: EvidenceVerifyCheck,
  b: EvidenceVerifyCheck,
): number {
  return (
    (CHECK_ID_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
    (CHECK_ID_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Canonical diagnostic order: `(code, subjectOrdinal, detailCode)`. The subject
 * ordinal (null ordered after numeric) is the deterministic safe surrogate for
 * the plan's `relativePathOrId`, and the closed detail-code order is the final
 * tie-break.
 */
export function compareEvidenceVerifyDiagnostics(
  a: EvidenceVerifyDiagnostic,
  b: EvidenceVerifyDiagnostic,
): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const ordinal = compareNullableOrdinal(a.subjectOrdinal, b.subjectOrdinal);
  if (ordinal !== 0) return ordinal;
  if (a.detailCode === b.detailCode) return 0;
  return (DETAIL_CODE_ORDER.get(a.detailCode) ?? Number.MAX_SAFE_INTEGER) <
    (DETAIL_CODE_ORDER.get(b.detailCode) ?? Number.MAX_SAFE_INTEGER)
    ? -1
    : 1;
}

/** Return a canonically sorted copy of the report details. */
export function canonicalizeEvidenceVerifyDetails(
  details: EvidenceVerifyDetails,
): EvidenceVerifyDetails {
  return {
    ...details,
    checks: [...details.checks].sort(compareEvidenceVerifyChecks),
    artifacts: {
      ...details.artifacts,
      missingIds: [...details.artifacts.missingIds].sort(),
      extraRelativePaths: [...details.artifacts.extraRelativePaths].sort(),
    },
    diagnostics: [...details.diagnostics].sort(compareEvidenceVerifyDiagnostics),
    suite:
      details.suite === null
        ? null
        : { ...details.suite, uncommittedChildIds: [...details.suite.uncommittedChildIds].sort() },
  };
}

/** The fixed `blockingClass` ranks used by primary selection. */
export const EVIDENCE_VERIFY_FINDING_CLASS_RANKS = Object.freeze({
  USAGE: 0,
  HARNESS_BLOCKED: 1,
  ENVIRONMENT_FAILURE: 2,
  PASS: 3,
} as const);
export type EvidenceVerifyFindingClass = keyof typeof EVIDENCE_VERIFY_FINDING_CLASS_RANKS;
export type EvidenceVerifyBlockingFindingClass = 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE';

/**
 * Codes whose default blocking class is `ENVIRONMENT_FAILURE`. `ENVIRONMENT_FAILURE`
 * is selectable only when it is the sole blocking class, so any harness finding
 * outranks it. B1 may classify a finding explicitly; this is the default.
 */
export const ENVIRONMENT_FAILURE_VERIFIER_CODES = Object.freeze([
  'VERIFY_ROOT_UNREADABLE',
  'VERIFY_EXTERNAL_READ_FAILURE',
] as const satisfies readonly BlockingVerifierCode[]);

export function defaultVerifierFindingClass(
  code: BlockingVerifierCode,
): EvidenceVerifyBlockingFindingClass {
  return (ENVIRONMENT_FAILURE_VERIFIER_CODES as readonly string[]).includes(code)
    ? 'ENVIRONMENT_FAILURE'
    : 'HARNESS_BLOCKED';
}

/** A blocking finding eligible for primary selection. */
export interface EvidenceVerifyPrimaryFinding {
  readonly code: BlockingVerifierCode;
  readonly detailCode: EvidenceVerifyDetailCode;
  readonly subjectOrdinal: number | null;
  readonly blockingClass: EvidenceVerifyBlockingFindingClass;
}

/**
 * Deterministic canonical run subject ordinals: `sort(artifactId)` zero-based
 * index, independent of any filesystem enumeration.
 */
export function canonicalRunSubjectOrdinals(
  artifactIds: readonly string[],
): ReadonlyMap<string, number> {
  const sorted = [...artifactIds].sort();
  return new Map(sorted.map((id, index) => [id, index] as const));
}

export interface EvidenceVerifySuiteChildOrdinalInput {
  readonly childKey: string;
  readonly order: number;
  readonly artifactIds: readonly string[];
}

export interface EvidenceVerifySuiteChildOrdinal {
  readonly childIndex: number;
  readonly firstOrdinal: number;
  readonly artifactOrdinals: ReadonlyMap<string, number>;
}

/**
 * Deterministic canonical suite subject ordinals. Children are ordered by
 * suite-v2 `order` (then `childKey` for stability); each child's artifact ids
 * are sorted lexicographically. Flattened `(childOrder, artifactId)` pairs get
 * zero-based ordinals. A child-level finding uses the child's first flattened
 * ordinal, or the child index when it declares no artifacts. Never derived from
 * filesystem enumeration.
 */
export function canonicalSuiteSubjectOrdinals(
  children: readonly EvidenceVerifySuiteChildOrdinalInput[],
): ReadonlyMap<string, EvidenceVerifySuiteChildOrdinal> {
  const ordered = [...children].sort((a, b) =>
    a.order === b.order
      ? a.childKey < b.childKey
        ? -1
        : a.childKey > b.childKey
          ? 1
          : 0
      : a.order - b.order,
  );
  const result = new Map<string, EvidenceVerifySuiteChildOrdinal>();
  let ordinal = 0;
  ordered.forEach((child, childIndex) => {
    const sortedIds = [...child.artifactIds].sort();
    const artifactOrdinals = new Map<string, number>();
    for (const id of sortedIds) {
      artifactOrdinals.set(id, ordinal);
      ordinal += 1;
    }
    result.set(child.childKey, {
      childIndex,
      firstOrdinal:
        sortedIds.length > 0
          ? (artifactOrdinals.get(sortedIds[0] as string) as number)
          : childIndex,
      artifactOrdinals,
    });
  });
  return result;
}

/**
 * Select the single primary finding by the exact tuple
 * `(blockingClass, precedenceIndex, subjectOrdinal)`, lexicographic, with
 * `precedenceIndex` from the one canonical constant and `null` ordinals after
 * numeric ones. Advisory codes have no precedence index and are never eligible.
 */
export function selectPrimaryVerifierFinding(
  findings: readonly EvidenceVerifyPrimaryFinding[],
): EvidenceVerifyPrimaryFinding | null {
  let best: EvidenceVerifyPrimaryFinding | null = null;
  let bestTuple: readonly [number, number, number] | null = null;
  for (const finding of findings) {
    const precedence = primaryPrecedenceIndex(finding.code);
    if (precedence === null) continue; // advisory never participates
    const ordinal =
      finding.subjectOrdinal === null ? Number.MAX_SAFE_INTEGER : finding.subjectOrdinal;
    const tuple = [
      EVIDENCE_VERIFY_FINDING_CLASS_RANKS[finding.blockingClass],
      precedence,
      ordinal,
    ] as const;
    if (
      bestTuple === null ||
      tuple[0] < bestTuple[0] ||
      (tuple[0] === bestTuple[0] &&
        (tuple[1] < bestTuple[1] || (tuple[1] === bestTuple[1] && tuple[2] < bestTuple[2])))
    ) {
      bestTuple = tuple;
      best = finding;
    }
  }
  return best;
}

// ── Closed argument-rejection contract (pure; no filesystem access) ───────────

/** The single accepted evidence-verify option. */
export const EVIDENCE_VERIFY_RUN_OPTION = '--run' as const;

/**
 * The prohibited scheme-shaped token (`file:`/`blob:`, case-insensitive) at a
 * token boundary. This is exactly the accepted prohibited-value guard's
 * scheme-form definition (`scanStringForProhibited`), so a requested id that the
 * guard would treat as a scheme form is rejected here as a usage error instead
 * of being resolved as a root. A slashless logical id that merely contains a
 * colon (`profile:diagnostic`, `artifact:run-record`) is not a scheme form and
 * remains accepted.
 */
const EVIDENCE_VERIFY_PROHIBITED_SCHEME_FORM = /(^|[^A-Za-z0-9])(file|blob):/i;

export const EVIDENCE_VERIFY_ARGUMENT_FAILURES = Object.freeze([
  'EVIDENCE_VERIFY_ARGUMENT_MISSING',
  'EVIDENCE_VERIFY_ARGUMENT_DUPLICATE',
  'EVIDENCE_VERIFY_ARGUMENT_UNKNOWN',
  'EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE',
  'EVIDENCE_VERIFY_ARGUMENT_POSITIONAL',
  'EVIDENCE_VERIFY_ARGUMENT_AMBIGUOUS',
  'EVIDENCE_VERIFY_ARGUMENT_UNSAFE_ID',
] as const);
export type EvidenceVerifyArgumentFailure = (typeof EVIDENCE_VERIFY_ARGUMENT_FAILURES)[number];

export type EvidenceVerifyArgumentsResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly failure: EvidenceVerifyArgumentFailure };

function argumentFailure(failure: EvidenceVerifyArgumentFailure): EvidenceVerifyArgumentsResult {
  return { ok: false, failure };
}

/**
 * Parse the evidence-verify argument vector (tokens after `evidence verify`).
 * Pure and filesystem-free: duplicate `--run` (including `--run=<v>` plus
 * `--run <v>`), unknown flags, missing values, unknown positionals, and
 * boolean/value ambiguity are rejected before any root resolution. A value that
 * is not a safe logical id, or that carries a prohibited `file:`/`blob:`
 * scheme form, is a usage rejection, so no root is ever resolved for it.
 * `--help` is handled by the existing CLI help surface and is never accepted here.
 */
export function parseEvidenceVerifyArguments(
  argv: readonly string[],
): EvidenceVerifyArgumentsResult {
  let value: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_POSITIONAL');
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    if (name !== EVIDENCE_VERIFY_RUN_OPTION) {
      return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_UNKNOWN');
    }
    if (value !== null) return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_DUPLICATE');
    if (equalsIndex >= 0) {
      const inline = token.slice(equalsIndex + 1);
      if (inline.length === 0) return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE');
      value = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE');
    }
    value = next;
    index += 1;
  }
  if (value === null) return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_MISSING');
  if (!isEvidenceLogicalId(value)) return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_UNSAFE_ID');
  if (EVIDENCE_VERIFY_PROHIBITED_SCHEME_FORM.test(value)) {
    return argumentFailure('EVIDENCE_VERIFY_ARGUMENT_UNSAFE_ID');
  }
  return { ok: true, runId: value };
}

// ── Closed details validator ──────────────────────────────────────────────────

export const EVIDENCE_VERIFY_DETAILS_ISSUE_CODES = Object.freeze([
  'VERIFY_DETAILS_NOT_PLAIN_OBJECT',
  'VERIFY_DETAILS_UNKNOWN_KEY',
  'VERIFY_DETAILS_MISSING_KEY',
  'VERIFY_DETAILS_INVALID_VALUE',
  'VERIFY_DETAILS_UNKNOWN_CODE',
  'VERIFY_DETAILS_UNKNOWN_DETAIL_CODE',
  'VERIFY_DETAILS_INCONSISTENT_SEVERITY',
  'VERIFY_DETAILS_UNSORTED',
  'VERIFY_DETAILS_DUPLICATE',
] as const);
export type EvidenceVerifyDetailsIssueCode = (typeof EVIDENCE_VERIFY_DETAILS_ISSUE_CODES)[number];

export interface EvidenceVerifyDetailsIssue {
  readonly code: EvidenceVerifyDetailsIssueCode;
  readonly path: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMember(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value);
}

function isSortedUniqueStrings(value: readonly string[]): boolean {
  for (let index = 1; index < value.length; index += 1) {
    if ((value[index - 1] as string) >= (value[index] as string)) return false;
  }
  return true;
}

function validateDetails(value: unknown): EvidenceVerifyDetailsIssue[] {
  if (!isPlainObject(value)) {
    return [{ code: 'VERIFY_DETAILS_NOT_PLAIN_OBJECT', path: 'details' }];
  }
  const issues: EvidenceVerifyDetailsIssue[] = [];
  const unknown = (path: string): void => {
    issues.push({ code: 'VERIFY_DETAILS_UNKNOWN_KEY', path });
  };
  const missing = (path: string): void => {
    issues.push({ code: 'VERIFY_DETAILS_MISSING_KEY', path });
  };
  const invalid = (path: string): void => {
    issues.push({ code: 'VERIFY_DETAILS_INVALID_VALUE', path });
  };
  const expectKeys = (
    record: Record<string, unknown>,
    path: string,
    keys: readonly string[],
  ): void => {
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) unknown(`${path}.${key}`);
    }
    for (const key of keys) {
      if (!(key in record)) missing(`${path}.${key}`);
    }
  };
  const expectBooleans = (
    record: Record<string, unknown>,
    path: string,
    keys: readonly string[],
  ): void => {
    for (const key of keys) {
      if (typeof record[key] !== 'boolean') invalid(`${path}.${key}`);
    }
  };
  const expectCounts = (
    record: Record<string, unknown>,
    path: string,
    keys: readonly string[],
  ): void => {
    for (const key of keys) {
      if (!isNonNegativeInteger(record[key])) invalid(`${path}.${key}`);
    }
  };

  expectKeys(value, 'details', EVIDENCE_VERIFY_DETAILS_KEYS);
  if (value.schemaVersion !== EVIDENCE_VERIFY_SCHEMA_VERSION) invalid('details.schemaVersion');
  if (value.reportLabel !== EVIDENCE_VERIFY_REPORT_LABEL) invalid('details.reportLabel');
  if (!isMember(EVIDENCE_VERIFY_SCOPES, value.scope)) invalid('details.scope');
  if (!isMember(EVIDENCE_VERIFY_ROOT_KINDS, value.rootKind)) invalid('details.rootKind');
  if (!isEvidenceLogicalId(value.requestedId)) invalid('details.requestedId');
  const scope = value.scope as EvidenceVerifyScope;
  const rootKind = value.rootKind as EvidenceVerifyRootKind;
  if (
    isMember(EVIDENCE_VERIFY_SCOPES, value.scope) &&
    isMember(EVIDENCE_VERIFY_ROOT_KINDS, value.rootKind) &&
    scope !== rootKind
  ) {
    invalid('details.rootKind');
  }
  if (
    isMember(EVIDENCE_VERIFY_ROOT_KINDS, value.rootKind) &&
    !isEvidenceVerifyRootRelativePath(value.rootRelativePath, rootKind)
  ) {
    invalid('details.rootRelativePath');
  }

  const transaction = value.transaction;
  if (!isPlainObject(transaction)) {
    invalid('details.transaction');
  } else {
    expectKeys(transaction, 'details.transaction', [
      'state',
      'failureClass',
      'failureCode',
      'commitPoint',
      'creditEligible',
      'immutable',
      'finalManifestPresent',
      'finalManifestValid',
      'strictRecordPresent',
      'behaviorOutcome',
    ]);
    if (!isMember(EVIDENCE_VERIFY_TRANSACTION_STATES, transaction.state)) {
      invalid('details.transaction.state');
    }
    if (
      transaction.failureClass !== null &&
      !isMember(EVIDENCE_VERIFY_FAILURE_CLASSES, transaction.failureClass)
    ) {
      invalid('details.transaction.failureClass');
    }
    if (transaction.failureCode !== null && !isBlockingVerifierCode(transaction.failureCode)) {
      invalid('details.transaction.failureCode');
    }
    if ((transaction.failureCode === null) !== (transaction.failureClass === null)) {
      invalid('details.transaction.failureCode');
    }
    if (!isMember(EVIDENCE_VERIFY_COMMIT_POINTS, transaction.commitPoint)) {
      invalid('details.transaction.commitPoint');
    }
    expectBooleans(transaction, 'details.transaction', [
      'creditEligible',
      'immutable',
      'finalManifestPresent',
      'finalManifestValid',
      'strictRecordPresent',
    ]);
    if (transaction.behaviorOutcome !== null && !isOutcome(transaction.behaviorOutcome)) {
      invalid('details.transaction.behaviorOutcome');
    }
  }

  const checks = value.checks;
  if (!Array.isArray(checks)) {
    invalid('details.checks');
  } else {
    const seen = new Set<string>();
    for (let index = 0; index < checks.length; index += 1) {
      const check = checks[index];
      const path = `details.checks[${index}]`;
      if (!isPlainObject(check)) {
        invalid(path);
        continue;
      }
      expectKeys(check, path, ['id', 'category', 'result', 'code']);
      if (!isMember(EVIDENCE_VERIFY_CHECK_IDS, check.id)) invalid(`${path}.id`);
      if (!isMember(EVIDENCE_VERIFY_CHECK_CATEGORIES, check.category)) invalid(`${path}.category`);
      if (!isMember(EVIDENCE_VERIFY_CHECK_RESULTS, check.result)) invalid(`${path}.result`);
      if (!isEvidenceVerifyCode(check.code)) invalid(`${path}.code`);
      if (typeof check.id === 'string') {
        if (seen.has(check.id))
          issues.push({ code: 'VERIFY_DETAILS_DUPLICATE', path: `${path}.id` });
        seen.add(check.id);
      }
      if (index > 0) {
        const previous = checks[index - 1];
        if (
          isPlainObject(previous) &&
          isMember(EVIDENCE_VERIFY_CHECK_IDS, previous.id) &&
          isMember(EVIDENCE_VERIFY_CHECK_IDS, check.id) &&
          (CHECK_ID_ORDER.get(previous.id as string) ?? 0) >=
            (CHECK_ID_ORDER.get(check.id as string) ?? 0)
        ) {
          issues.push({ code: 'VERIFY_DETAILS_UNSORTED', path: `${path}.id` });
        }
      }
    }
  }

  const artifacts = value.artifacts;
  if (!isPlainObject(artifacts)) {
    invalid('details.artifacts');
  } else {
    expectKeys(artifacts, 'details.artifacts', [
      'declaredCount',
      'verifiedCount',
      'requiredCount',
      'diagnosticCount',
      'missingIds',
      'extraRelativePaths',
    ]);
    expectCounts(artifacts, 'details.artifacts', [
      'declaredCount',
      'verifiedCount',
      'requiredCount',
      'diagnosticCount',
    ]);
    if (!Array.isArray(artifacts.missingIds) || !artifacts.missingIds.every(isEvidenceLogicalId)) {
      invalid('details.artifacts.missingIds');
    } else if (!isSortedUniqueStrings(artifacts.missingIds as string[])) {
      issues.push({ code: 'VERIFY_DETAILS_UNSORTED', path: 'details.artifacts.missingIds' });
    }
    if (
      !Array.isArray(artifacts.extraRelativePaths) ||
      !artifacts.extraRelativePaths.every(isEvidenceRelativePath)
    ) {
      invalid('details.artifacts.extraRelativePaths');
    } else if (!isSortedUniqueStrings(artifacts.extraRelativePaths as string[])) {
      issues.push({
        code: 'VERIFY_DETAILS_UNSORTED',
        path: 'details.artifacts.extraRelativePaths',
      });
    }
  }

  const references = value.references;
  if (!isPlainObject(references)) {
    invalid('details.references');
  } else {
    expectKeys(references, 'details.references', ['declaredCount', 'verifiedCount']);
    expectCounts(references, 'details.references', ['declaredCount', 'verifiedCount']);
  }

  const provenance = value.provenance;
  if (!isPlainObject(provenance)) {
    invalid('details.provenance');
  } else {
    expectKeys(provenance, 'details.provenance', [
      'persistedIdentityValid',
      'currentTreeCheck',
      'currentTreeCreditEligible',
      'repositoryRevisionPresent',
      'dirtyPolicyPresent',
      'lockfileDigestPresent',
      'componentDigestsPresent',
      'catalogueIdentitiesPresent',
      'profileIdentitiesPresent',
    ]);
    expectBooleans(provenance, 'details.provenance', [
      'persistedIdentityValid',
      'currentTreeCreditEligible',
      'repositoryRevisionPresent',
      'dirtyPolicyPresent',
      'lockfileDigestPresent',
      'componentDigestsPresent',
      'catalogueIdentitiesPresent',
      'profileIdentitiesPresent',
    ]);
    if (!isMember(EVIDENCE_VERIFY_CURRENT_TREE_CHECKS, provenance.currentTreeCheck)) {
      invalid('details.provenance.currentTreeCheck');
    }
    if (provenance.currentTreeCreditEligible === true && provenance.currentTreeCheck !== 'PASS') {
      invalid('details.provenance.currentTreeCreditEligible');
    }
  }

  const sanitization = value.sanitization;
  if (!isPlainObject(sanitization)) {
    invalid('details.sanitization');
  } else {
    expectKeys(sanitization, 'details.sanitization', [
      'requiredApproved',
      'diagnosticApproved',
      'requiredAuthorityPreserved',
      'prohibitedValuesFound',
    ]);
    expectBooleans(sanitization, 'details.sanitization', [
      'requiredApproved',
      'diagnosticApproved',
      'requiredAuthorityPreserved',
      'prohibitedValuesFound',
    ]);
  }

  const suite = value.suite;
  if (suite !== null) {
    if (!isPlainObject(suite)) {
      invalid('details.suite');
    } else {
      expectKeys(suite, 'details.suite', [
        'recordLabel',
        'recordSchemaVersion',
        'childCount',
        'committedChildCount',
        'uncommittedChildIds',
        'suiteTransactionActivation',
      ]);
      if (
        suite.recordLabel !== null &&
        !isMember(EVIDENCE_VERIFY_SUITE_RECORD_LABELS, suite.recordLabel)
      ) {
        invalid('details.suite.recordLabel');
      }
      if (suite.recordSchemaVersion !== null && !isNonNegativeInteger(suite.recordSchemaVersion)) {
        invalid('details.suite.recordSchemaVersion');
      }
      expectCounts(suite, 'details.suite', ['childCount', 'committedChildCount']);
      if (
        !Array.isArray(suite.uncommittedChildIds) ||
        !suite.uncommittedChildIds.every(isEvidenceLogicalId)
      ) {
        invalid('details.suite.uncommittedChildIds');
      } else if (!isSortedUniqueStrings(suite.uncommittedChildIds as string[])) {
        issues.push({ code: 'VERIFY_DETAILS_UNSORTED', path: 'details.suite.uncommittedChildIds' });
      }
      if (!isMember(EVIDENCE_VERIFY_SUITE_ACTIVATIONS, suite.suiteTransactionActivation)) {
        invalid('details.suite.suiteTransactionActivation');
      }
    }
  }
  if ((scope === 'run') !== (suite === null) && isMember(EVIDENCE_VERIFY_SCOPES, value.scope)) {
    invalid('details.suite');
  }

  const diagnostics = value.diagnostics;
  if (!Array.isArray(diagnostics)) {
    invalid('details.diagnostics');
  } else {
    let previous: EvidenceVerifyDiagnostic | null = null;
    for (let index = 0; index < diagnostics.length; index += 1) {
      const diagnostic = diagnostics[index];
      const path = `details.diagnostics[${index}]`;
      if (!isPlainObject(diagnostic)) {
        invalid(path);
        continue;
      }
      expectKeys(diagnostic, path, ['code', 'severity', 'detailCode', 'subjectOrdinal']);
      if (!isEvidenceVerifyCode(diagnostic.code)) {
        issues.push({ code: 'VERIFY_DETAILS_UNKNOWN_CODE', path: `${path}.code` });
      }
      if (!isMember(EVIDENCE_VERIFY_SEVERITIES, diagnostic.severity)) invalid(`${path}.severity`);
      if (!isEvidenceVerifyDetailCode(diagnostic.detailCode)) {
        issues.push({ code: 'VERIFY_DETAILS_UNKNOWN_DETAIL_CODE', path: `${path}.detailCode` });
      }
      if (diagnostic.subjectOrdinal !== null && !isNonNegativeInteger(diagnostic.subjectOrdinal)) {
        invalid(`${path}.subjectOrdinal`);
      }
      if (
        isEvidenceVerifyCode(diagnostic.code) &&
        isMember(EVIDENCE_VERIFY_SEVERITIES, diagnostic.severity)
      ) {
        const expectedSeverity = isAdvisoryVerifierCode(diagnostic.code)
          ? 'diagnostic'
          : 'blocking';
        if (diagnostic.severity !== expectedSeverity) {
          issues.push({ code: 'VERIFY_DETAILS_INCONSISTENT_SEVERITY', path: `${path}.severity` });
        }
      }
      if (
        isEvidenceVerifyCode(diagnostic.code) &&
        isMember(EVIDENCE_VERIFY_SEVERITIES, diagnostic.severity) &&
        isEvidenceVerifyDetailCode(diagnostic.detailCode) &&
        (diagnostic.subjectOrdinal === null || isNonNegativeInteger(diagnostic.subjectOrdinal))
      ) {
        const normalized = diagnostic as unknown as EvidenceVerifyDiagnostic;
        if (previous !== null && compareEvidenceVerifyDiagnostics(previous, normalized) >= 0) {
          issues.push({ code: 'VERIFY_DETAILS_UNSORTED', path });
        }
        previous = normalized;
      }
    }
  }

  return issues;
}

/** Non-throwing closure/locality validator for an `evidence-verify.v1` details object. */
export function validateEvidenceVerifyDetails(
  value: unknown,
): readonly EvidenceVerifyDetailsIssue[] {
  return validateDetails(value);
}

/** Parse and validate an `evidence-verify.v1` details object, failing closed. */
export function parseEvidenceVerifyDetails(value: unknown): EvidenceVerifyDetails {
  const issues = validateDetails(value);
  if (issues.length > 0) {
    const first = issues[0] as EvidenceVerifyDetailsIssue;
    throw new EvidenceVerifyContractError(
      'EVIDENCE_VERIFY_CONTRACT_INVALID_DETAILS',
      first.path,
      `Invalid evidence-verify.v1 details (${first.code}).`,
    );
  }
  return value as EvidenceVerifyDetails;
}

/** Exact closed diagnostic key inventory. */
export const EVIDENCE_VERIFY_DIAGNOSTIC_KEYS: readonly string[] = Object.freeze([
  'code',
  'severity',
  'detailCode',
  'subjectOrdinal',
]);
