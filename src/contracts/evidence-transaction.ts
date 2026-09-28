import { type EvidenceRole, type Outcome, isEvidenceRole, isOutcome } from './discriminants';

/**
 * Package-8 evidence transaction contracts (ADR 0041).
 *
 * Every run or suite is a two-phase evidence transaction: an immutable
 * *intended inventory* (schema `intended-inventory.v1`) is exclusively created
 * first, and a *final manifest* (schema `final-manifest.v1`) is exclusively
 * created last as the sole commit point. Strict current-v4 run records and the
 * suite-v2 aggregate remain unchanged correctness records; these sibling
 * documents are a separate, additional Package-8 transaction layer.
 *
 * The contracts are dormant authoring data: nothing in an active runtime, CLI,
 * browser, or producer path imports them. They are closed — every document
 * rejects unknown keys and versions — and they compose only from the accepted
 * discriminant vocabulary. Absolute and private paths are structurally
 * prohibited: every declared location is a safe repository-relative path.
 */

/** Intended-inventory schema version (ADR 0041 P8-A1). */
export const EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION = 1;
/** Final-manifest schema version (ADR 0041 P8-A1). */
export const EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION = 1;
/** Provenance policy/schema version (ADR 0041 P8-A1). */
export const EVIDENCE_PROVENANCE_SCHEMA_VERSION = 1;

export const EVIDENCE_INTENDED_INVENTORY_LABEL = 'intended-inventory.v1';
export const EVIDENCE_FINAL_MANIFEST_LABEL = 'final-manifest.v1';

/** Durable Package-8 sibling file names inside one run/suite evidence root. */
export const EVIDENCE_INTENDED_INVENTORY_FILE_NAME = 'intended-inventory.json';
export const EVIDENCE_FINAL_MANIFEST_FILE_NAME = 'final-manifest.json';

/**
 * The sealed strict correctness schemas Package-8 must never widen. These are
 * deliberate literals, not imports: the contract cannot drift with an accidental
 * edit of the strict-v4/suite-v2 constants, and a test proves they still match
 * `FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION` / `FINAL_SUITE_RECORD_SCHEMA_VERSION`.
 */
export const EVIDENCE_SEALED_STRICT_SCHEMAS = Object.freeze({
  runRecordSchemaVersion: 4,
  suiteRecordSchemaVersion: 2,
  currentChildRecordLabel: 'current-v4',
  suiteRecordLabel: 'suite-v2',
} as const);

export type EvidenceSealedStrictSchemas = typeof EVIDENCE_SEALED_STRICT_SCHEMAS;

/** Closed transaction kinds. */
export const EVIDENCE_TRANSACTION_KINDS = ['run', 'suite'] as const;
export type EvidenceTransactionKind = (typeof EVIDENCE_TRANSACTION_KINDS)[number];

/** Closed producer phases in which an artifact can be produced. */
export const EVIDENCE_PRODUCER_PHASES = [
  'precondition',
  'setup',
  'action',
  'observation',
  'evaluation',
  'finalization',
  'cleanup',
] as const;
export type EvidenceProducerPhase = (typeof EVIDENCE_PRODUCER_PHASES)[number];

/** Closed sanitization policies a declared artifact is published under. */
export const EVIDENCE_SANITIZATION_POLICIES = [
  'public-json-guard-v1',
  'opaque-bytes-guard-v1',
] as const;
export type EvidenceSanitizationPolicy = (typeof EVIDENCE_SANITIZATION_POLICIES)[number];

/** Closed retention status metadata. This package performs no governed deletion. */
export const EVIDENCE_RETENTION_STATUSES = [
  'required-preserve',
  'eligible-later',
  'transient-scratch',
] as const;
export type EvidenceRetentionStatus = (typeof EVIDENCE_RETENTION_STATUSES)[number];

/** Closed reference relationship kinds. */
export const EVIDENCE_REFERENCE_KINDS = ['consumes', 'derives', 'child-manifest'] as const;
export type EvidenceReferenceKind = (typeof EVIDENCE_REFERENCE_KINDS)[number];

/** Closed semantic-digest kinds. */
export const EVIDENCE_SEMANTIC_DIGEST_KINDS = [
  'canonical-json',
  'ordered-list',
  'record-set',
  'byte-stream',
] as const;
export type EvidenceSemanticDigestKind = (typeof EVIDENCE_SEMANTIC_DIGEST_KINDS)[number];

export const EVIDENCE_PROVENANCE_DIRTY_POLICIES = ['clean', 'dirty-governed'] as const;
export type EvidenceProvenanceDirtyPolicy = (typeof EVIDENCE_PROVENANCE_DIRTY_POLICIES)[number];

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isEvidenceTransactionKind(value: unknown): value is EvidenceTransactionKind {
  return isMember(EVIDENCE_TRANSACTION_KINDS, value);
}

export function isEvidenceProducerPhase(value: unknown): value is EvidenceProducerPhase {
  return isMember(EVIDENCE_PRODUCER_PHASES, value);
}

export function isEvidenceSanitizationPolicy(value: unknown): value is EvidenceSanitizationPolicy {
  return isMember(EVIDENCE_SANITIZATION_POLICIES, value);
}

export function isEvidenceRetentionStatus(value: unknown): value is EvidenceRetentionStatus {
  return isMember(EVIDENCE_RETENTION_STATUSES, value);
}

export function isEvidenceReferenceKind(value: unknown): value is EvidenceReferenceKind {
  return isMember(EVIDENCE_REFERENCE_KINDS, value);
}

export function isEvidenceSemanticDigestKind(value: unknown): value is EvidenceSemanticDigestKind {
  return isMember(EVIDENCE_SEMANTIC_DIGEST_KINDS, value);
}

export function isEvidenceProvenanceDirtyPolicy(
  value: unknown,
): value is EvidenceProvenanceDirtyPolicy {
  return isMember(EVIDENCE_PROVENANCE_DIRTY_POLICIES, value);
}

// ── Path, id, digest and media predicates ─────────────────────────────────────

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$|^\.[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX_256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPE = /^[a-z]+\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

/**
 * A safe repository-relative POSIX path. Rejects absolute forms (leading `/`,
 * drive letters, UNC), `file:`/`blob:` schemes, traversal, backslashes, NUL,
 * empty/`.`/`..` segments, and unsafe characters.
 */
export function isEvidenceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || value.startsWith('//')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.toLowerCase().includes('file:') || value.toLowerCase().includes('blob:')) return false;
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
    if (!SAFE_SEGMENT.test(segment)) return false;
  }
  return true;
}

export function isEvidenceLogicalId(value: unknown): value is string {
  return typeof value === 'string' && LOGICAL_ID.test(value);
}

export function isEvidenceSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && HEX_256.test(value);
}

export function isEvidenceMediaType(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_TYPE.test(value);
}

/**
 * Cross-realm byte-sequence predicate. `instanceof Uint8Array` is unreliable
 * when a TextEncoder/typed array from another realm (for example a jsdom test
 * realm) is inspected, so the tag is checked as well.
 */
export function isEvidenceByteSequence(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (typeof value === 'object' &&
      value !== null &&
      ArrayBuffer.isView(value) &&
      Object.prototype.toString.call(value) === '[object Uint8Array]')
  );
}

// ── Closed key inventories ────────────────────────────────────────────────────

export const EVIDENCE_PROVENANCE_IDENTITY_KEYS: readonly string[] = Object.freeze(['id', 'digest']);

export const EVIDENCE_PROVENANCE_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'policyVersion',
  'repositoryRevision',
  'dirtyPolicy',
  'dirtyTreeDigest',
  'lockfileDigest',
  'cliBootstrapDigest',
  'runnerDigest',
  'evidenceWriterDigest',
  'verifierDigest',
  'runtimeEngineDigest',
  'catalogueIdentities',
  'profileIdentities',
]);

export const EVIDENCE_ARTIFACT_ENTRY_KEYS: readonly string[] = Object.freeze([
  'artifactId',
  'role',
  'mediaType',
  'schema',
  'relativePath',
  'byteLength',
  'sha256',
  'semanticDigest',
  'semanticDigestKind',
  'producerPhase',
  'consumedBy',
  'sanitizationPolicy',
  'retentionStatus',
]);

export const EVIDENCE_INTENDED_INVENTORY_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'label',
  'transactionKind',
  'transactionId',
  'provenance',
  'sealedStrictSchemas',
  'artifacts',
  'createdAtUtc',
]);

export const EVIDENCE_FINALIZED_ARTIFACT_KEYS: readonly string[] = Object.freeze([
  'artifactId',
  'relativePath',
  'byteLength',
  'sha256',
  'semanticDigest',
]);

export const EVIDENCE_REFERENCE_KEYS: readonly string[] = Object.freeze([
  'fromArtifactId',
  'toArtifactId',
  'kind',
  'order',
]);

export const EVIDENCE_FINAL_MANIFEST_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'label',
  'transactionKind',
  'transactionId',
  'inventoryIdentity',
  'provenanceIdentity',
  'sealedStrictSchemas',
  'behaviorOutcome',
  'transactionResult',
  'committedArtifacts',
  'references',
  'committedAtUtc',
]);

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface EvidenceProvenanceIdentity {
  readonly id: string;
  readonly digest: string;
}

export interface EvidenceProvenance {
  readonly schemaVersion: number;
  readonly policyVersion: number;
  readonly repositoryRevision: string;
  readonly dirtyPolicy: EvidenceProvenanceDirtyPolicy;
  readonly dirtyTreeDigest: string;
  readonly lockfileDigest: string;
  readonly cliBootstrapDigest: string;
  readonly runnerDigest: string;
  readonly evidenceWriterDigest: string;
  readonly verifierDigest: string;
  readonly runtimeEngineDigest: string;
  readonly catalogueIdentities: readonly EvidenceProvenanceIdentity[];
  readonly profileIdentities: readonly EvidenceProvenanceIdentity[];
}

export interface EvidenceArtifactEntry {
  readonly artifactId: string;
  readonly role: EvidenceRole;
  readonly mediaType: string;
  readonly schema: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly semanticDigest: string | null;
  readonly semanticDigestKind: EvidenceSemanticDigestKind | null;
  readonly producerPhase: EvidenceProducerPhase;
  readonly consumedBy: readonly string[];
  readonly sanitizationPolicy: EvidenceSanitizationPolicy;
  readonly retentionStatus: EvidenceRetentionStatus;
}

export interface EvidenceIntendedInventory {
  readonly schemaVersion: number;
  readonly label: string;
  readonly transactionKind: EvidenceTransactionKind;
  readonly transactionId: string;
  readonly provenance: EvidenceProvenance;
  readonly sealedStrictSchemas: EvidenceSealedStrictSchemas;
  readonly artifacts: readonly EvidenceArtifactEntry[];
  readonly createdAtUtc: string;
}

export interface EvidenceReference {
  readonly fromArtifactId: string;
  readonly toArtifactId: string;
  readonly kind: EvidenceReferenceKind;
  readonly order: number | null;
}

export interface EvidenceFinalizedArtifact {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly semanticDigest: string | null;
}

export interface EvidenceFinalManifest {
  readonly schemaVersion: number;
  readonly label: string;
  readonly transactionKind: EvidenceTransactionKind;
  readonly transactionId: string;
  readonly inventoryIdentity: string;
  readonly provenanceIdentity: string;
  readonly sealedStrictSchemas: EvidenceSealedStrictSchemas;
  readonly behaviorOutcome: Outcome;
  readonly transactionResult: 'committed';
  readonly committedArtifacts: readonly EvidenceFinalizedArtifact[];
  readonly references: readonly EvidenceReference[];
  readonly committedAtUtc: string;
}

/** The only transaction result a durable final manifest may carry. */
export const EVIDENCE_COMMITTED_TRANSACTION_RESULT = 'committed';

// ── Issue vocabulary ──────────────────────────────────────────────────────────

export const EVIDENCE_CONTRACT_ISSUE_CODES = [
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
] as const;
export type EvidenceContractIssueCode = (typeof EVIDENCE_CONTRACT_ISSUE_CODES)[number];

export interface EvidenceContractIssue {
  readonly code: EvidenceContractIssueCode;
  readonly path: string;
  readonly detail: string;
}

function issue(
  code: EvidenceContractIssueCode,
  path: string,
  detail: string,
): EvidenceContractIssue {
  return { code, path, detail };
}

export function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function closedKeys(
  value: Record<string, unknown>,
  path: string,
  keys: readonly string[],
): EvidenceContractIssue[] {
  const issues: EvidenceContractIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      issues.push(issue('EVIDENCE_UNKNOWN_KEY', `${path}.<key>`, 'Unknown closed-contract key.'));
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      issues.push(issue('EVIDENCE_MISSING_KEY', `${path}.${key}`, 'Required closed key missing.'));
    }
  }
  return issues;
}

function checkLogicalId(value: unknown, path: string): EvidenceContractIssue[] {
  if (!isEvidenceLogicalId(value)) {
    return [issue('EVIDENCE_ID_INVALID', path, 'Not a safe logical id.')];
  }
  return [];
}

function checkDigest(value: unknown, path: string): EvidenceContractIssue[] {
  if (!isEvidenceSha256Digest(value)) {
    return [issue('EVIDENCE_DIGEST_INVALID', path, 'Not a lowercase SHA-256 hex digest.')];
  }
  return [];
}

function checkRelativePath(value: unknown, path: string): EvidenceContractIssue[] {
  if (!isEvidenceRelativePath(value)) {
    return [
      issue(
        'EVIDENCE_RELATIVE_PATH_INVALID',
        path,
        'Not a safe repository-relative path (absolute/private paths are prohibited).',
      ),
    ];
  }
  return [];
}

function checkByteLength(value: unknown, path: string): EvidenceContractIssue[] {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return [
      issue(
        'EVIDENCE_BYTE_LENGTH_INVALID',
        path,
        'byteLength must be a non-negative safe integer.',
      ),
    ];
  }
  return [];
}

function checkSealedStrictSchemas(value: unknown, path: string): EvidenceContractIssue[] {
  if (!isPlainDataObject(value)) {
    return [
      issue('EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH', path, 'Sealed strict schemas missing.'),
    ];
  }
  const keys = Object.keys(EVIDENCE_SEALED_STRICT_SCHEMAS);
  const issues = closedKeys(value, path, keys);
  for (const key of keys) {
    const expected = (EVIDENCE_SEALED_STRICT_SCHEMAS as Record<string, unknown>)[key];
    if ((value as Record<string, unknown>)[key] !== expected) {
      issues.push(
        issue(
          'EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH',
          `${path}.${key}`,
          'Sealed strict schema identity must not change.',
        ),
      );
    }
  }
  return issues;
}

// ── Provenance validation ─────────────────────────────────────────────────────

export function validateEvidenceProvenance(value: unknown): readonly EvidenceContractIssue[] {
  if (!isPlainDataObject(value)) {
    return [
      issue('EVIDENCE_VALUE_NOT_PLAIN_OBJECT', 'provenance', 'Provenance must be a plain object.'),
    ];
  }
  const issues: EvidenceContractIssue[] = closedKeys(value, 'provenance', EVIDENCE_PROVENANCE_KEYS);
  if (value.schemaVersion !== EVIDENCE_PROVENANCE_SCHEMA_VERSION) {
    issues.push(
      issue(
        'EVIDENCE_SCHEMA_VERSION_UNSUPPORTED',
        'provenance.schemaVersion',
        'Unsupported provenance schema version.',
      ),
    );
  }
  if (!Number.isSafeInteger(value.policyVersion) || (value.policyVersion as number) < 1) {
    issues.push(
      issue(
        'EVIDENCE_SCHEMA_VERSION_UNSUPPORTED',
        'provenance.policyVersion',
        'Invalid policy version.',
      ),
    );
  }
  if (!isEvidenceProvenanceDirtyPolicy(value.dirtyPolicy)) {
    issues.push(
      issue('EVIDENCE_TRANSACTION_KIND_UNKNOWN', 'provenance.dirtyPolicy', 'Unknown dirty policy.'),
    );
  }
  for (const [field, current] of [
    ['dirtyTreeDigest', value.dirtyTreeDigest],
    ['lockfileDigest', value.lockfileDigest],
    ['cliBootstrapDigest', value.cliBootstrapDigest],
    ['runnerDigest', value.runnerDigest],
    ['evidenceWriterDigest', value.evidenceWriterDigest],
    ['verifierDigest', value.verifierDigest],
    ['runtimeEngineDigest', value.runtimeEngineDigest],
  ] as const) {
    issues.push(...checkDigest(current, `provenance.${field}`));
  }
  if (
    typeof value.repositoryRevision !== 'string' ||
    !/^[a-f0-9]{7,64}$/.test(value.repositoryRevision)
  ) {
    issues.push(
      issue(
        'EVIDENCE_DIGEST_INVALID',
        'provenance.repositoryRevision',
        'Repository revision must be a lowercase git revision or SHA-256 digest.',
      ),
    );
  }
  issues.push(
    ...validateProvenanceIdentities(value.catalogueIdentities, 'provenance.catalogueIdentities'),
  );
  issues.push(
    ...validateProvenanceIdentities(value.profileIdentities, 'provenance.profileIdentities'),
  );
  return issues;
}

function validateProvenanceIdentities(value: unknown, path: string): EvidenceContractIssue[] {
  if (!Array.isArray(value)) {
    return [
      issue('EVIDENCE_PROVENANCE_INVALID', path, 'Provenance identities must be a sorted array.'),
    ];
  }
  const issues: EvidenceContractIssue[] = [];
  let previous: string | null = null;
  for (const entry of value) {
    if (!isPlainDataObject(entry)) {
      issues.push(
        issue('EVIDENCE_PROVENANCE_INVALID', path, 'Identity entry must be a plain object.'),
      );
      continue;
    }
    issues.push(...closedKeys(entry, `${path}[<entry>]`, EVIDENCE_PROVENANCE_IDENTITY_KEYS));
    if (!isEvidenceLogicalId(entry.id)) {
      issues.push(issue('EVIDENCE_ID_INVALID', `${path}[<entry>].id`, 'Invalid identity id.'));
    }
    issues.push(...checkDigest(entry.digest, `${path}[<entry>].digest`));
    if (typeof entry.id === 'string') {
      if (previous !== null && entry.id <= previous) {
        issues.push(
          issue(
            'EVIDENCE_ARTIFACT_ORDER_INVALID',
            path,
            'Provenance identities must be uniquely sorted by id.',
          ),
        );
      }
      previous = entry.id;
    }
  }
  return issues;
}

// ── Artifact entry validation ─────────────────────────────────────────────────

export function validateEvidenceArtifactEntry(
  value: unknown,
  path = 'artifacts[<entry>]',
): readonly EvidenceContractIssue[] {
  if (!isPlainDataObject(value)) {
    return [
      issue('EVIDENCE_VALUE_NOT_PLAIN_OBJECT', path, 'Artifact entry must be a plain object.'),
    ];
  }
  const issues: EvidenceContractIssue[] = closedKeys(value, path, EVIDENCE_ARTIFACT_ENTRY_KEYS);
  issues.push(...checkLogicalId(value.artifactId, `${path}.artifactId`));
  if (!isEvidenceRole(value.role)) {
    issues.push(issue('EVIDENCE_ARTIFACT_ROLE_UNKNOWN', `${path}.role`, 'Unknown artifact role.'));
  }
  if (!isEvidenceMediaType(value.mediaType)) {
    issues.push(issue('EVIDENCE_MEDIA_TYPE_INVALID', `${path}.mediaType`, 'Invalid media type.'));
  }
  if (!isEvidenceLogicalId(value.schema)) {
    issues.push(issue('EVIDENCE_ID_INVALID', `${path}.schema`, 'Invalid schema label.'));
  }
  issues.push(...checkRelativePath(value.relativePath, `${path}.relativePath`));
  issues.push(...checkByteLength(value.byteLength, `${path}.byteLength`));
  issues.push(...checkDigest(value.sha256, `${path}.sha256`));
  if (value.semanticDigest !== null) {
    issues.push(...checkDigest(value.semanticDigest, `${path}.semanticDigest`));
    if (!isEvidenceSemanticDigestKind(value.semanticDigestKind)) {
      issues.push(
        issue(
          'EVIDENCE_SEMANTIC_DIGEST_KIND_UNKNOWN',
          `${path}.semanticDigestKind`,
          'A declared semantic digest requires a known semantic-digest kind.',
        ),
      );
    }
  } else if (value.semanticDigestKind !== null) {
    issues.push(
      issue(
        'EVIDENCE_SEMANTIC_DIGEST_KIND_UNKNOWN',
        `${path}.semanticDigestKind`,
        'A null semantic digest requires a null semantic-digest kind.',
      ),
    );
  }
  if (!isEvidenceProducerPhase(value.producerPhase)) {
    issues.push(
      issue('EVIDENCE_PRODUCER_PHASE_UNKNOWN', `${path}.producerPhase`, 'Unknown producer phase.'),
    );
  }
  if (!isEvidenceSanitizationPolicy(value.sanitizationPolicy)) {
    issues.push(
      issue(
        'EVIDENCE_SANITIZATION_POLICY_UNKNOWN',
        `${path}.sanitizationPolicy`,
        'Unknown sanitization policy.',
      ),
    );
  }
  if (!isEvidenceRetentionStatus(value.retentionStatus)) {
    issues.push(
      issue(
        'EVIDENCE_RETENTION_STATUS_UNKNOWN',
        `${path}.retentionStatus`,
        'Unknown retention status.',
      ),
    );
  }
  if (!Array.isArray(value.consumedBy)) {
    issues.push(
      issue('EVIDENCE_REFERENCE_DANGLING', `${path}.consumedBy`, 'consumedBy must be an array.'),
    );
  } else {
    let previous: string | null = null;
    for (const consumer of value.consumedBy) {
      if (!isEvidenceLogicalId(consumer)) {
        issues.push(issue('EVIDENCE_ID_INVALID', `${path}.consumedBy`, 'Invalid consumed-by id.'));
        continue;
      }
      if (previous !== null && consumer <= previous) {
        issues.push(
          issue(
            'EVIDENCE_REFERENCE_ORDER_INVALID',
            `${path}.consumedBy`,
            'consumedBy must be uniquely sorted by id.',
          ),
        );
      }
      previous = consumer;
    }
  }
  return issues;
}

function validateArtifactList(value: unknown, path: string): EvidenceContractIssue[] {
  if (!Array.isArray(value)) {
    return [issue('EVIDENCE_ARTIFACT_EMPTY', path, 'artifacts must be an array.')];
  }
  if (value.length === 0) {
    return [issue('EVIDENCE_ARTIFACT_EMPTY', path, 'An inventory declares at least one artifact.')];
  }
  const issues: EvidenceContractIssue[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  value.forEach((entry, index) => {
    issues.push(...validateEvidenceArtifactEntry(entry, `${path}[${index}]`));
    if (isPlainDataObject(entry) && typeof entry.artifactId === 'string') {
      if (seen.has(entry.artifactId)) {
        issues.push(
          issue(
            'EVIDENCE_ARTIFACT_DUPLICATE_ID',
            `${path}[${index}].artifactId`,
            'Duplicate artifact id.',
          ),
        );
      }
      seen.add(entry.artifactId);
      if (previous !== null && entry.artifactId <= previous) {
        issues.push(
          issue(
            'EVIDENCE_ARTIFACT_ORDER_INVALID',
            path,
            'Artifacts must be uniquely sorted by artifactId.',
          ),
        );
      }
      previous = entry.artifactId;
    }
  });
  return issues;
}

// ── Intended-inventory validation ─────────────────────────────────────────────

export function validateEvidenceIntendedInventory(
  value: unknown,
): readonly EvidenceContractIssue[] {
  if (!isPlainDataObject(value)) {
    return [
      issue(
        'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
        'inventory',
        'Intended inventory must be a plain object.',
      ),
    ];
  }
  const issues: EvidenceContractIssue[] = closedKeys(
    value,
    'inventory',
    EVIDENCE_INTENDED_INVENTORY_KEYS,
  );
  if (value.schemaVersion !== EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION) {
    issues.push(
      issue(
        'EVIDENCE_SCHEMA_VERSION_UNSUPPORTED',
        'inventory.schemaVersion',
        'Unsupported intended-inventory schema version.',
      ),
    );
  }
  if (value.label !== EVIDENCE_INTENDED_INVENTORY_LABEL) {
    issues.push(
      issue(
        'EVIDENCE_LABEL_UNSUPPORTED',
        'inventory.label',
        'Unsupported intended-inventory label.',
      ),
    );
  }
  if (!isEvidenceTransactionKind(value.transactionKind)) {
    issues.push(
      issue(
        'EVIDENCE_TRANSACTION_KIND_UNKNOWN',
        'inventory.transactionKind',
        'Unknown transaction kind.',
      ),
    );
  }
  issues.push(...checkLogicalId(value.transactionId, 'inventory.transactionId'));
  issues.push(
    ...checkSealedStrictSchemas(value.sealedStrictSchemas, 'inventory.sealedStrictSchemas'),
  );
  issues.push(...validateEvidenceProvenance(value.provenance).map((entry) => ({ ...entry })));
  issues.push(...validateArtifactList(value.artifacts, 'inventory.artifacts'));
  if (typeof value.createdAtUtc !== 'string' || value.createdAtUtc.length === 0) {
    issues.push(
      issue('EVIDENCE_ID_INVALID', 'inventory.createdAtUtc', 'createdAtUtc is required.'),
    );
  }
  return issues;
}

// ── Final-manifest validation ─────────────────────────────────────────────────

function validateFinalizedArtifacts(value: unknown): EvidenceContractIssue[] {
  if (!Array.isArray(value)) {
    return [
      issue(
        'EVIDENCE_COMMITTED_ARTIFACT_MISMATCH',
        'manifest.committedArtifacts',
        'Must be an array.',
      ),
    ];
  }
  const issues: EvidenceContractIssue[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  value.forEach((entry, index) => {
    const path = `manifest.committedArtifacts[${index}]`;
    if (!isPlainDataObject(entry)) {
      issues.push(
        issue(
          'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
          path,
          'Finalized artifact must be a plain object.',
        ),
      );
      return;
    }
    issues.push(...closedKeys(entry, path, EVIDENCE_FINALIZED_ARTIFACT_KEYS));
    issues.push(...checkLogicalId(entry.artifactId, `${path}.artifactId`));
    issues.push(...checkRelativePath(entry.relativePath, `${path}.relativePath`));
    issues.push(...checkByteLength(entry.byteLength, `${path}.byteLength`));
    issues.push(...checkDigest(entry.sha256, `${path}.sha256`));
    if (entry.semanticDigest !== null) {
      issues.push(...checkDigest(entry.semanticDigest, `${path}.semanticDigest`));
    }
    if (typeof entry.artifactId === 'string') {
      if (seen.has(entry.artifactId)) {
        issues.push(
          issue('EVIDENCE_COMMITTED_ARTIFACT_MISMATCH', path, 'Duplicate committed artifact id.'),
        );
      }
      seen.add(entry.artifactId);
      if (previous !== null && entry.artifactId <= previous) {
        issues.push(
          issue(
            'EVIDENCE_ARTIFACT_ORDER_INVALID',
            'manifest.committedArtifacts',
            'Committed artifacts must be uniquely sorted by artifactId.',
          ),
        );
      }
      previous = entry.artifactId;
    }
  });
  return issues;
}

function validateReferenceList(value: unknown): EvidenceContractIssue[] {
  if (!Array.isArray(value)) {
    return [
      issue('EVIDENCE_REFERENCE_DANGLING', 'manifest.references', 'references must be an array.'),
    ];
  }
  const issues: EvidenceContractIssue[] = [];
  value.forEach((entry, index) => {
    const path = `manifest.references[${index}]`;
    if (!isPlainDataObject(entry)) {
      issues.push(
        issue('EVIDENCE_VALUE_NOT_PLAIN_OBJECT', path, 'Reference must be a plain object.'),
      );
      return;
    }
    issues.push(...closedKeys(entry, path, EVIDENCE_REFERENCE_KEYS));
    issues.push(...checkLogicalId(entry.fromArtifactId, `${path}.fromArtifactId`));
    issues.push(...checkLogicalId(entry.toArtifactId, `${path}.toArtifactId`));
    if (!isEvidenceReferenceKind(entry.kind)) {
      issues.push(
        issue('EVIDENCE_REFERENCE_KIND_UNKNOWN', `${path}.kind`, 'Unknown reference kind.'),
      );
    }
    if (
      entry.order !== null &&
      (!Number.isSafeInteger(entry.order) || (entry.order as number) < 0)
    ) {
      issues.push(
        issue(
          'EVIDENCE_REFERENCE_ORDER_INVALID',
          `${path}.order`,
          'Reference order must be a non-negative integer or null.',
        ),
      );
    }
  });
  return issues;
}

export function validateEvidenceFinalManifest(value: unknown): readonly EvidenceContractIssue[] {
  if (!isPlainDataObject(value)) {
    return [
      issue(
        'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
        'manifest',
        'Final manifest must be a plain object.',
      ),
    ];
  }
  const issues: EvidenceContractIssue[] = closedKeys(
    value,
    'manifest',
    EVIDENCE_FINAL_MANIFEST_KEYS,
  );
  if (value.schemaVersion !== EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION) {
    issues.push(
      issue(
        'EVIDENCE_SCHEMA_VERSION_UNSUPPORTED',
        'manifest.schemaVersion',
        'Unsupported final-manifest schema version.',
      ),
    );
  }
  if (value.label !== EVIDENCE_FINAL_MANIFEST_LABEL) {
    issues.push(
      issue('EVIDENCE_LABEL_UNSUPPORTED', 'manifest.label', 'Unsupported final-manifest label.'),
    );
  }
  if (!isEvidenceTransactionKind(value.transactionKind)) {
    issues.push(
      issue(
        'EVIDENCE_TRANSACTION_KIND_UNKNOWN',
        'manifest.transactionKind',
        'Unknown transaction kind.',
      ),
    );
  }
  issues.push(...checkLogicalId(value.transactionId, 'manifest.transactionId'));
  issues.push(...checkDigest(value.inventoryIdentity, 'manifest.inventoryIdentity'));
  issues.push(...checkDigest(value.provenanceIdentity, 'manifest.provenanceIdentity'));
  issues.push(
    ...checkSealedStrictSchemas(value.sealedStrictSchemas, 'manifest.sealedStrictSchemas'),
  );
  if (!isOutcome(value.behaviorOutcome)) {
    issues.push(
      issue('EVIDENCE_OUTCOME_UNKNOWN', 'manifest.behaviorOutcome', 'Unknown terminal outcome.'),
    );
  }
  if (value.transactionResult !== EVIDENCE_COMMITTED_TRANSACTION_RESULT) {
    issues.push(
      issue(
        'EVIDENCE_TRANSACTION_RESULT_UNSUPPORTED',
        'manifest.transactionResult',
        'A durable final manifest is always the committed transaction result.',
      ),
    );
  }
  issues.push(...validateFinalizedArtifacts(value.committedArtifacts));
  issues.push(...validateReferenceList(value.references));
  if (typeof value.committedAtUtc !== 'string' || value.committedAtUtc.length === 0) {
    issues.push(
      issue('EVIDENCE_ID_INVALID', 'manifest.committedAtUtc', 'committedAtUtc is required.'),
    );
  }
  return issues;
}
