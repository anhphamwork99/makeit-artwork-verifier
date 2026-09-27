import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

import {
  deriveIntendedInventoryIdentity,
  deriveProvenanceIdentity,
} from '../canonical/package8-identity';
import { type Outcome, isOutcome } from '../contracts/discriminants';
import {
  type EvidenceArtifactEntry,
  type EvidenceFinalManifest,
  type EvidenceIntendedInventory,
  type EvidenceProvenance,
  isEvidenceLogicalId,
  isEvidenceRelativePath,
  isEvidenceSemanticDigestKind,
  isEvidenceSha256Digest,
  isPlainDataObject,
  validateEvidenceFinalManifest,
  validateEvidenceIntendedInventory,
  validateEvidenceProvenance,
} from '../contracts/evidence-transaction';
import {
  type EvidenceVerifyCheck,
  type EvidenceVerifyCheckCategory,
  type EvidenceVerifyCheckId,
  type EvidenceVerifyCode,
  type EvidenceVerifyDetailCode,
  type EvidenceVerifyDetails,
  type EvidenceVerifyDiagnostic,
  type EvidenceVerifyPrimaryFinding,
  type EvidenceVerifySuite,
  type EvidenceVerifySuiteChildOrdinalInput,
  EVIDENCE_VERIFY_REPORT_LABEL,
  EVIDENCE_VERIFY_SCHEMA_VERSION,
  type EvidenceVerifyTransaction,
  canonicalSuiteSubjectOrdinals,
  canonicalizeEvidenceVerifyDetails,
  defaultVerifierFindingClass,
  isAdvisoryVerifierCode,
  isBlockingVerifierCode,
  parseEvidenceVerifyDetails,
  projectSourceIssue,
  selectPrimaryVerifierFinding,
} from '../contracts/evidence-verify';
import { readFinalPublicRecord } from '../contracts/final-public-record';
import {
  type FinalSuiteChildRecordV2,
  type FinalSuiteRecordV2,
  readFinalSuiteRecord,
} from '../contracts/final-suite-record';
import { textContainsProhibitedValue } from './guard';
import { validateInventoryManifestAgreement, validateReferenceGraph } from './reference-graph';
import { EvidenceSemanticDigestError, deriveSemanticDigest } from './semantic-digest';
import { EVIDENCE_PROHIBITED_BYTES_API_VERSION, inspectProhibitedBytes } from './sanitize';
import {
  collectRepositoryProvenanceInputs,
  governedTreeDigestFromCollectedInputs,
  type RepositoryProvenanceInputs,
} from './provenance-collector';
import { componentDigestFromEntries, type ProvenanceFlow } from './provenance-component-policy';
import { runtimeEngineDigest } from '../runtime/environment-facts';
import { resolveRepoRoot } from '../runtime/paths';

/**
 * P8-B WP-B1 — read-only run integrity verifier core (ADR 0048; plan
 * `p8b-integrity-verifier.md` §8–§12).
 *
 * This module is the pure/testable verifier orchestration boundary around an
 * injected, no-follow, read-only filesystem seam. It never writes, renames,
 * deletes, repairs, adopts, publishes, or mutates an evidence root: it
 * enumerates with `lstat`/`readdir`, reads each JSON input exactly once with a
 * no-follow exact-byte open, parses it exactly once, and calls only pure
 * parsed-value readers/validators. Findings are projected onto the closed
 * `evidence-verify.v1` vocabulary; absolute paths live only in local variables
 * and never enter a report.
 *
 * The core is intentionally dormant: it is not wired into the CLI here (WP-B2)
 * and exposes no write, cleanup, publication, approval, or evidence-mutation
 * edge.
 */

// ── Read-only filesystem seam ─────────────────────────────────────────────────

export type EvidenceVerifyEntryKind = 'directory' | 'file' | 'other' | 'symlink';

export interface EvidenceVerifyStat {
  readonly kind: EvidenceVerifyEntryKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
  readonly dev: number;
}

export interface EvidenceVerifyDirent {
  readonly name: string;
  readonly kind: EvidenceVerifyEntryKind;
}

/**
 * The only filesystem surface the verifier may use: `lstat`, `readdir`, and an
 * exact-byte, no-follow `readFile`. It deliberately has no
 * write/rename/delete/mkdir capability, and implementers must not wrap a
 * path-following read.
 */
export interface EvidenceVerifyFsAdapter {
  /** `lstat` without following symlinks; `null` when the path is absent. */
  lstat(absolutePath: string): EvidenceVerifyStat | null;
  /** `readdir` names + entry kinds; never follows a symlink. */
  readdir(absolutePath: string): readonly EvidenceVerifyDirent[];
  /** Exact bytes of an already-resolved regular file, opened no-follow. */
  readFile(absolutePath: string): Uint8Array;
}

/**
 * A proven external filesystem/resource failure (EIO/EACCES/...). Only these
 * may map to `ENVIRONMENT_FAILURE`.
 */
export class EvidenceVerifyExternalFsError extends Error {
  readonly osCode: string;
  constructor(osCode: string, message: string) {
    super(message);
    this.name = 'EvidenceVerifyExternalFsError';
    this.osCode = osCode;
  }
}

export function isEvidenceVerifyExternalFsError(
  error: unknown,
): error is EvidenceVerifyExternalFsError {
  return error instanceof EvidenceVerifyExternalFsError;
}

/**
 * A declared no-follow read guarantee. The production adapter can only be
 * constructed when the platform exposes a real `O_NOFOLLOW`, and the verifier
 * refuses to touch the filesystem at all unless the capability is explicit.
 */
export type EvidenceVerifyNoFollowSupport = 'supported' | 'unsupported';

export interface EvidenceVerifyNoFollowCapability {
  readonly support: EvidenceVerifyNoFollowSupport;
}

/**
 * Typed capability failure. Raised by the production adapter factory before it
 * creates any read capability, so an unsafe platform can never fall back to a
 * path-following open (`O_RDONLY | undefined`).
 */
export class EvidenceVerifyNoFollowUnsupportedError extends EvidenceVerifyExternalFsError {
  constructor() {
    super('ENOTSUP', 'A trustworthy no-follow read guarantee is unavailable.');
    this.name = 'EvidenceVerifyNoFollowUnsupportedError';
  }
}

/**
 * Explicit platform feature-detection for a trustworthy no-follow open. A
 * missing or zero `O_NOFOLLOW` (for example on Windows) can never be silently
 * coerced into a path-following read.
 */
export function detectNodeNoFollowCapability(): EvidenceVerifyNoFollowCapability {
  const flag = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  return typeof flag === 'number' && Number.isInteger(flag) && flag !== 0
    ? { support: 'supported' }
    : { support: 'unsupported' };
}

const EXTERNAL_OS_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EAGAIN',
  'EBUSY',
  'EINTR',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'ENXIO',
  'EPERM',
  'EROFS',
  'ESTALE',
  'ETIMEDOUT',
  'EWOULDBLOCK',
]);

function osErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toExternalFsError(error: unknown): unknown {
  if (error instanceof EvidenceVerifyExternalFsError) return error;
  const code = osErrorCode(error);
  if (code !== null && EXTERNAL_OS_CODES.has(code)) {
    return new EvidenceVerifyExternalFsError(code, 'External filesystem read failure.');
  }
  return error;
}

function sha256ExactBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function entryKind(stat: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): EvidenceVerifyEntryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

/**
 * Production read-only adapter. `readFile` opens with `O_NOFOLLOW` so a file
 * swapped for a symlink after `lstat` can never be followed, and reads the exact
 * byte length it observed. Construction fails closed with a typed error when the
 * platform cannot honour the no-follow guarantee.
 */
export function createNodeEvidenceVerifyFsAdapter(
  capability: EvidenceVerifyNoFollowCapability = detectNodeNoFollowCapability(),
): EvidenceVerifyFsAdapter {
  if (capability.support !== 'supported') {
    throw new EvidenceVerifyNoFollowUnsupportedError();
  }
  return {
    lstat(absolutePath: string): EvidenceVerifyStat | null {
      try {
        const stat = lstatSync(absolutePath);
        return {
          kind: entryKind(stat),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          ino: stat.ino,
          dev: stat.dev,
        };
      } catch (error) {
        const code = osErrorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw toExternalFsError(error);
      }
    },
    readdir(absolutePath: string): readonly EvidenceVerifyDirent[] {
      try {
        return readdirSync(absolutePath, { withFileTypes: true }).map((dirent) => ({
          name: dirent.name,
          kind: entryKind(dirent),
        }));
      } catch (error) {
        throw toExternalFsError(error);
      }
    },
    readFile(absolutePath: string): Uint8Array {
      let descriptor: number;
      try {
        descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        throw toExternalFsError(error);
      }
      try {
        const size = fstatSync(descriptor).size;
        const buffer = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
          const read = readSync(descriptor, buffer, offset, size - offset, offset);
          if (read <= 0) break;
          offset += read;
        }
        return offset === size ? buffer : buffer.subarray(0, offset);
      } catch (error) {
        throw toExternalFsError(error);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

// ── Current-tree compatibility seam (advisory only) ───────────────────────────

export interface EvidenceVerifyCurrentTreeSignals {
  /** Persisted-tree compatibility with the current repository; advisory only. */
  readonly currentTreeCheck: 'DRIFT' | 'PASS';
}

/**
 * Read-only context handed to an optional current-tree provider. It carries the
 * already-recomputed persisted provenance of the verified committed root as an
 * in-memory value only: never a path, write handle, or report field.
 */
export interface EvidenceVerifyCurrentTreeContext {
  readonly persistedProvenance: EvidenceProvenance;
}

export interface EvidenceVerifyEnvironment {
  /** Absolute evidence base directory. Local only; never enters a report. */
  readonly evidenceBaseDir: string;
  readonly fs: EvidenceVerifyFsAdapter;
  /**
   * Explicit declaration of the adapter's no-follow guarantee. When it is
   * `unsupported` the verifier fails closed before any filesystem access. The
   * default is `supported` because the only production adapter is already
   * capability-checked at construction.
   */
  readonly noFollowCapability?: EvidenceVerifyNoFollowCapability;
  /** Registered private roots rejected by inspection; never emitted. */
  readonly forbiddenRoots?: readonly string[];
  /**
   * Optional read-only current-tree compatibility provider. Absent ⇒ `not-run`.
   * It receives the recomputed persisted provenance of the verified committed
   * root and returns only `PASS`/`DRIFT`; a throw is an optional
   * collector/resource failure mapped to the advisory `UNAVAILABLE`, never to
   * `ENVIRONMENT_FAILURE`.
   */
  readonly currentTree?: (
    context: EvidenceVerifyCurrentTreeContext,
  ) => EvidenceVerifyCurrentTreeSignals;
}

export interface EvidenceVerifyRequest {
  readonly requestedId: string;
}

/** A caller-supplied id that is not a safe logical id can never be resolved. */
export class EvidenceVerifyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceVerifyRequestError';
  }
}

// ── Internal finding accumulator ──────────────────────────────────────────────

interface Finding {
  readonly code: EvidenceVerifyCode;
  readonly severity: 'blocking' | 'diagnostic';
  readonly detailCode: EvidenceVerifyDetailCode;
  readonly subjectOrdinal: number | null;
  readonly checkId: EvidenceVerifyCheckId;
}

interface RootEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: EvidenceVerifyEntryKind;
  readonly stat: EvidenceVerifyStat;
}

type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

interface VerificationState {
  readonly env: EvidenceVerifyEnvironment;
  readonly entries: Map<string, RootEntry>;
  findings: Finding[];
  readonly bytesCache: Map<string, Uint8Array | null>;
  readonly parsedCache: Map<string, ParsedJson>;
}

// ── Prohibited-value policy (secrets, paths, customer markers) ────────────────

const SECRET_KEYS: ReadonlySet<string> = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authorizationtoken',
  'bearer',
  'capability',
  'capabilitytoken',
  'clientsecret',
  'credential',
  'password',
  'rawauthorization',
  'refreshtoken',
  'secret',
  'setupauthorization',
  'token',
]);

const CUSTOMER_KEYS: ReadonlySet<string> = new Set([
  'buyer',
  'buyerid',
  'customer',
  'customeremail',
  'customerid',
  'orderid',
  'productioncustomer',
  'productiondata',
  'shopifycustomerid',
]);

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+\S+/i,
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const CUSTOMER_VALUE_PATTERNS: readonly RegExp[] = [
  /customer@example\.com/i,
  /customer-data/i,
  /production-data/i,
  /live-customer/i,
  /customer_[A-Za-z0-9_-]+/,
];

interface ScanFlags {
  secrets: boolean;
  paths: boolean;
  customers: boolean;
}

function newScanFlags(): ScanFlags {
  return { secrets: false, paths: false, customers: false };
}

function scanStringForProhibited(
  text: string,
  flags: ScanFlags,
  forbiddenRoots: readonly string[],
): void {
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text))) flags.secrets = true;
  if (CUSTOMER_VALUE_PATTERNS.some((pattern) => pattern.test(text))) flags.customers = true;
  // The accepted guard treats any `file:`/`blob:` substring as prohibited, which
  // would false-positive on a legitimate slashless logical id such as
  // `profile:diagnostic` (a valid Package-8 identity). A logical id is exempt
  // only when it does not itself carry a scheme-shaped `file:`/`blob:` token at
  // a token boundary; every secret/customer pattern above still applies.
  const schemeForm = /(^|[^A-Za-z0-9])(file|blob):/i.test(text);
  if (!(isEvidenceLogicalId(text) && !schemeForm)) {
    if (textContainsProhibitedValue(text, forbiddenRoots)) flags.paths = true;
  }
}

function scanParsedValue(
  value: unknown,
  flags: ScanFlags,
  forbiddenRoots: readonly string[],
  seen: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    scanStringForProhibited(value, flags, forbiddenRoots);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) scanParsedValue(entry, flags, forbiddenRoots, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const lower = key.toLowerCase();
    const child = record[key];
    if (SECRET_KEYS.has(lower) && typeof child === 'string' && child.length > 0) {
      flags.secrets = true;
    }
    if (CUSTOMER_KEYS.has(lower)) flags.customers = true;
    scanParsedValue(child, flags, forbiddenRoots, seen);
  }
}

// ── Check assembly ────────────────────────────────────────────────────────────

interface CheckSpec {
  readonly id: EvidenceVerifyCheckId;
  readonly category: EvidenceVerifyCheckCategory;
  readonly defaultCode: EvidenceVerifyCode;
}

const RUN_CHECK_SPECS: readonly CheckSpec[] = Object.freeze([
  { id: 'ROOT_RESOLUTION', category: 'root', defaultCode: 'VERIFY_ROOT_NOT_FOUND' },
  { id: 'STRICT_RECORD', category: 'schema', defaultCode: 'VERIFY_JSON_INVALID' },
  { id: 'INVENTORY_CONTRACT', category: 'schema', defaultCode: 'VERIFY_JSON_INVALID' },
  { id: 'MANIFEST_CONTRACT', category: 'schema', defaultCode: 'VERIFY_JSON_INVALID' },
  {
    id: 'SEALED_SCHEMA_AGREEMENT',
    category: 'schema',
    defaultCode: 'VERIFY_SEALED_SCHEMA_MISMATCH',
  },
  { id: 'TRANSACTION_STATE', category: 'transaction', defaultCode: 'VERIFY_TRANSACTION_INVALID' },
  { id: 'ARTIFACT_SET', category: 'bytes', defaultCode: 'VERIFY_ARTIFACT_MISSING' },
  { id: 'ARTIFACT_BYTES', category: 'bytes', defaultCode: 'VERIFY_ARTIFACT_LENGTH_MISMATCH' },
  { id: 'ARTIFACT_SHA256', category: 'bytes', defaultCode: 'VERIFY_ARTIFACT_SHA256_MISMATCH' },
  {
    id: 'ARTIFACT_SEMANTIC_DIGEST',
    category: 'semantic-digest',
    defaultCode: 'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
  },
  { id: 'REFERENCE_GRAPH', category: 'reference', defaultCode: 'VERIFY_REFERENCE_DANGLING' },
  {
    id: 'REQUIRED_AUTHORITY',
    category: 'authority',
    defaultCode: 'VERIFY_REQUIRED_AUTHORITY_MISSING',
  },
  { id: 'PROVENANCE_CONTRACT', category: 'provenance', defaultCode: 'VERIFY_PROVENANCE_INVALID' },
  {
    id: 'PROVENANCE_IDENTITY',
    category: 'provenance',
    defaultCode: 'VERIFY_PROVENANCE_IDENTITY_MISMATCH',
  },
  {
    id: 'SANITIZATION_GUARD',
    category: 'sanitization',
    defaultCode: 'VERIFY_SANITIZATION_PROHIBITED_VALUE',
  },
  { id: 'SECRET_SCAN', category: 'privacy', defaultCode: 'VERIFY_SECRET_OR_AUTHORIZATION_MARKER' },
  { id: 'PATH_SCAN', category: 'privacy', defaultCode: 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH' },
  {
    id: 'CUSTOMER_MARKER_SCAN',
    category: 'privacy',
    defaultCode: 'VERIFY_PRODUCTION_CUSTOMER_MARKER',
  },
  { id: 'EXTRA_FILE_SCAN', category: 'extra-file', defaultCode: 'VERIFY_ARTIFACT_EXTRA' },
  {
    id: 'FINALIZATION_IMMUTABILITY',
    category: 'transaction',
    defaultCode: 'VERIFY_POST_FINALIZATION_MUTATION',
  },
]);

/**
 * The narrow suite-v2 report check set. A suite root has no Package-8 artifact,
 * provenance, or sanitization surface of its own, so only the closed suite
 * check ids are reported: root resolution, the suite-level transaction
 * boundary, the strict suite record, every independently committed child
 * manifest, and the exact suite-root file set. All ids belong to the shared
 * `EVIDENCE_VERIFY_CHECK_IDS` order, keeping report ordering canonical.
 */
const SUITE_CHECK_SPECS: readonly CheckSpec[] = Object.freeze([
  { id: 'ROOT_RESOLUTION', category: 'root', defaultCode: 'VERIFY_ROOT_NOT_FOUND' },
  { id: 'TRANSACTION_STATE', category: 'transaction', defaultCode: 'VERIFY_TRANSACTION_INVALID' },
  { id: 'EXTRA_FILE_SCAN', category: 'extra-file', defaultCode: 'VERIFY_ARTIFACT_EXTRA' },
  { id: 'SUITE_RECORD', category: 'suite', defaultCode: 'VERIFY_UNKNOWN_SCHEMA' },
  {
    id: 'SUITE_CHILD_MANIFESTS',
    category: 'suite',
    defaultCode: 'VERIFY_SUITE_CHILD_NOT_COMMITTED',
  },
]);

/**
 * The shared spec index. A suite-scope failure report resolves its suite check
 * ids here; the run specs keep their exact 20-check identity. `RUN_CHECK_SPECS`
 * and `SUITE_CHECK_SPECS` share only `ROOT_RESOLUTION`, which maps to the same
 * spec object identity either way.
 */
const CHECK_SPEC_BY_ID: ReadonlyMap<string, CheckSpec> = new Map(
  [...RUN_CHECK_SPECS, ...SUITE_CHECK_SPECS].map((spec) => [spec.id, spec] as const),
);

function toPrimaryFinding(finding: Finding): EvidenceVerifyPrimaryFinding | null {
  if (finding.severity !== 'blocking' || !isBlockingVerifierCode(finding.code)) return null;
  return {
    code: finding.code,
    detailCode: finding.detailCode,
    subjectOrdinal: finding.subjectOrdinal,
    blockingClass: defaultVerifierFindingClass(finding.code),
  };
}

function primaryOf(findings: readonly Finding[]): EvidenceVerifyPrimaryFinding | null {
  return selectPrimaryVerifierFinding(
    findings
      .map(toPrimaryFinding)
      .filter((entry): entry is EvidenceVerifyPrimaryFinding => entry !== null),
  );
}

function buildChecks(
  findings: readonly Finding[],
  specs: readonly CheckSpec[] = RUN_CHECK_SPECS,
): EvidenceVerifyCheck[] {
  const byId = new Map<EvidenceVerifyCheckId, Finding[]>();
  for (const finding of findings) {
    const list = byId.get(finding.checkId) ?? [];
    list.push(finding);
    byId.set(finding.checkId, list);
  }
  return specs.map((spec) => {
    const domain = byId.get(spec.id) ?? [];
    if (domain.length === 0) {
      return { id: spec.id, category: spec.category, result: 'PASS', code: spec.defaultCode };
    }
    const primary = primaryOf(domain);
    return {
      id: spec.id,
      category: spec.category,
      result: 'FAIL',
      code: primary?.code ?? domain[0]?.code ?? spec.defaultCode,
    };
  });
}

function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.code}|${finding.severity}|${finding.detailCode}|${String(finding.subjectOrdinal)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

// ── Report assembly ───────────────────────────────────────────────────────────

function emptySuite(): EvidenceVerifySuite {
  return {
    recordLabel: null,
    recordSchemaVersion: null,
    childCount: 0,
    committedChildCount: 0,
    uncommittedChildIds: [],
    suiteTransactionActivation: 'deferred-not-activated',
  };
}

function emptyArtifacts(): EvidenceVerifyDetails['artifacts'] {
  return {
    declaredCount: 0,
    verifiedCount: 0,
    requiredCount: 0,
    diagnosticCount: 0,
    missingIds: [],
    extraRelativePaths: [],
  };
}

function emptyProvenance(): EvidenceVerifyDetails['provenance'] {
  return {
    persistedIdentityValid: false,
    currentTreeCheck: 'not-run',
    currentTreeCreditEligible: false,
    repositoryRevisionPresent: false,
    dirtyPolicyPresent: false,
    lockfileDigestPresent: false,
    componentDigestsPresent: false,
    catalogueIdentitiesPresent: false,
    profileIdentitiesPresent: false,
  };
}

function emptySanitization(): EvidenceVerifyDetails['sanitization'] {
  return {
    requiredApproved: false,
    diagnosticApproved: false,
    requiredAuthorityPreserved: false,
    prohibitedValuesFound: false,
  };
}

function emptyTransaction(
  state: EvidenceVerifyTransaction['state'],
  primary: EvidenceVerifyPrimaryFinding | null,
): EvidenceVerifyTransaction {
  return {
    state,
    failureClass: primary === null ? null : primary.blockingClass,
    failureCode: primary === null ? null : primary.code,
    commitPoint: state === 'committed' ? 'committed' : 'not-committed',
    creditEligible: false,
    immutable: true,
    finalManifestPresent: false,
    finalManifestValid: false,
    strictRecordPresent: false,
    behaviorOutcome: null,
  };
}

function assembleReport(
  scope: 'run' | 'suite',
  requestedId: string,
  findings: readonly Finding[],
  core: {
    transaction: EvidenceVerifyTransaction;
    checks: readonly EvidenceVerifyCheck[];
    artifacts: EvidenceVerifyDetails['artifacts'];
    references: EvidenceVerifyDetails['references'];
    provenance: EvidenceVerifyDetails['provenance'];
    sanitization: EvidenceVerifyDetails['sanitization'];
    suite: EvidenceVerifySuite | null;
  },
): EvidenceVerifyDetails {
  const diagnostics: EvidenceVerifyDiagnostic[] = dedupeFindings(findings).map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    detailCode: finding.detailCode,
    subjectOrdinal: finding.subjectOrdinal,
  }));
  const details: EvidenceVerifyDetails = {
    schemaVersion: EVIDENCE_VERIFY_SCHEMA_VERSION,
    reportLabel: EVIDENCE_VERIFY_REPORT_LABEL,
    scope,
    requestedId,
    rootKind: scope,
    rootRelativePath:
      scope === 'run' ? `evidence/runs/${requestedId}` : `evidence/suites/${requestedId}`,
    transaction: core.transaction,
    checks: core.checks,
    artifacts: core.artifacts,
    references: core.references,
    provenance: core.provenance,
    sanitization: core.sanitization,
    suite: scope === 'suite' ? (core.suite ?? emptySuite()) : null,
    diagnostics,
  };
  return parseEvidenceVerifyDetails(canonicalizeEvidenceVerifyDetails(details));
}

function failureReport(
  scope: 'run' | 'suite',
  requestedId: string,
  code: EvidenceVerifyCode,
  detailCode: EvidenceVerifyDetailCode,
  checkId: EvidenceVerifyCheckId,
  state: EvidenceVerifyTransaction['state'],
): EvidenceVerifyDetails {
  const finding: Finding = {
    code,
    severity: 'blocking',
    detailCode,
    subjectOrdinal: null,
    checkId,
  };
  const spec = CHECK_SPEC_BY_ID.get(checkId);
  const checks: EvidenceVerifyCheck[] = spec
    ? [{ id: spec.id, category: spec.category, result: 'FAIL', code }]
    : [];
  return assembleReport(scope, requestedId, [finding], {
    transaction: emptyTransaction(state, primaryOf([finding])),
    checks,
    artifacts: emptyArtifacts(),
    references: { declaredCount: 0, verifiedCount: 0 },
    provenance: emptyProvenance(),
    sanitization: emptySanitization(),
    suite: scope === 'suite' ? emptySuite() : null,
  });
}

// ── Enumeration + cached single-read/single-parse ─────────────────────────────

/** Maximum descendant directory depth below the resolved root. */
export const EVIDENCE_VERIFY_MAX_TRAVERSAL_DEPTH = 8;
/**
 * Maximum enumerated entries. Exceeding either bound is a blocking overflow,
 * never a silent truncation that could hide an extra, special, or symlinked
 * entry.
 */
export const EVIDENCE_VERIFY_MAX_ENUMERATED_ENTRIES = 2048;

function addTraversalOverflow(state: VerificationState): void {
  addFinding(state, 'VERIFY_ARTIFACT_EXTRA', 'ARTIFACT_LENGTH', 'EXTRA_FILE_SCAN');
}

function enumerateRoot(
  state: VerificationState,
  directory: string,
  prefix: string,
  depth: number,
): void {
  if (depth > EVIDENCE_VERIFY_MAX_TRAVERSAL_DEPTH) {
    // A deeper tree than the bound must surface as a finding, not be dropped.
    addTraversalOverflow(state);
    return;
  }
  const dirents = state.env.fs.readdir(directory);
  const ordered = [...dirents].sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const dirent of ordered) {
    if (state.entries.size >= EVIDENCE_VERIFY_MAX_ENUMERATED_ENTRIES) {
      addTraversalOverflow(state);
      return;
    }
    const relativePath = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    const absolutePath = path.join(directory, dirent.name);
    const stat = state.env.fs.lstat(absolutePath);
    if (stat === null) {
      // Vanished between `readdir` and `lstat`: a mutation, never ignored.
      addFinding(
        state,
        'VERIFY_POST_FINALIZATION_MUTATION',
        'ARTIFACT_LENGTH',
        'FINALIZATION_IMMUTABILITY',
      );
      continue;
    }
    // A kind change between `readdir` and `lstat` is an enumeration mutation.
    // `other` from `readdir` means DT_UNKNOWN, which is not a contradiction.
    if (dirent.kind !== 'other' && stat.kind !== dirent.kind) {
      addFinding(
        state,
        'VERIFY_POST_FINALIZATION_MUTATION',
        'ARTIFACT_LENGTH',
        'FINALIZATION_IMMUTABILITY',
      );
    }
    state.entries.set(relativePath, { relativePath, absolutePath, kind: stat.kind, stat });
    if (stat.kind === 'directory') enumerateRoot(state, absolutePath, relativePath, depth + 1);
  }
}

function statDiffers(before: EvidenceVerifyStat, after: EvidenceVerifyStat): boolean {
  return (
    before.kind !== after.kind ||
    before.size !== after.size ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  );
}

function addFinding(
  state: VerificationState,
  code: EvidenceVerifyCode,
  detailCode: EvidenceVerifyDetailCode,
  checkId: EvidenceVerifyCheckId,
  subjectOrdinal: number | null = null,
): void {
  state.findings.push({
    code,
    severity: isAdvisoryVerifierCode(code) ? 'diagnostic' : 'blocking',
    detailCode,
    subjectOrdinal,
    checkId,
  });
}

/**
 * Project one validator/reader source literal through the closed mapping. An
 * unmapped literal is classified as an unknown failure rather than passed
 * through raw.
 */
function addProjectedIssue(
  state: VerificationState,
  sourceCode: string,
  checkId: EvidenceVerifyCheckId,
  subjectOrdinal: number | null = null,
): void {
  try {
    const row = projectSourceIssue(sourceCode);
    state.findings.push({
      code: row.verifierCode,
      severity: row.severity,
      detailCode: row.detailCode,
      subjectOrdinal,
      checkId,
    });
  } catch {
    addFinding(state, 'VERIFY_UNKNOWN_FAILURE', 'UNKNOWN_EXCEPTION', checkId);
  }
}

function inventoryCheckIdForSource(sourceCode: string): EvidenceVerifyCheckId {
  const row = (() => {
    try {
      return projectSourceIssue(sourceCode);
    } catch {
      return null;
    }
  })();
  if (row !== null && row.verifierCode === 'VERIFY_PROVENANCE_INVALID')
    return 'PROVENANCE_CONTRACT';
  if (row !== null && row.verifierCode === 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH') return 'PATH_SCAN';
  return 'INVENTORY_CONTRACT';
}

function readRootFile(
  state: VerificationState,
  relativePath: string,
  checkId: EvidenceVerifyCheckId,
): Uint8Array | null {
  if (state.bytesCache.has(relativePath)) return state.bytesCache.get(relativePath) ?? null;
  const entry = state.entries.get(relativePath);
  let bytes: Uint8Array | null = null;
  if (entry !== undefined && entry.kind === 'file') {
    try {
      bytes = state.env.fs.readFile(entry.absolutePath);
    } catch (error) {
      if (osErrorCode(error) === 'ENOENT') {
        // Enumerated but gone at read time: a disappearance/mutation, never a
        // silent miss and never a retry.
        addFinding(
          state,
          'VERIFY_POST_FINALIZATION_MUTATION',
          'ARTIFACT_LENGTH',
          'FINALIZATION_IMMUTABILITY',
        );
        bytes = null;
      } else if (isEvidenceVerifyExternalFsError(error)) {
        addFinding(state, 'VERIFY_EXTERNAL_READ_FAILURE', 'ROOT_RESOLUTION', checkId);
        bytes = null;
      } else {
        throw error;
      }
    }
    if (bytes !== null) {
      try {
        const post = state.env.fs.lstat(entry.absolutePath);
        if (post === null) {
          // Disappeared after the read: a blocking mutation, never a retry.
          addFinding(
            state,
            'VERIFY_POST_FINALIZATION_MUTATION',
            'ARTIFACT_LENGTH',
            'FINALIZATION_IMMUTABILITY',
          );
        } else if (statDiffers(entry.stat, post)) {
          addFinding(
            state,
            'VERIFY_POST_FINALIZATION_MUTATION',
            'ARTIFACT_LENGTH',
            'FINALIZATION_IMMUTABILITY',
          );
        }
      } catch (error) {
        if (isEvidenceVerifyExternalFsError(error)) {
          addFinding(state, 'VERIFY_EXTERNAL_READ_FAILURE', 'ROOT_RESOLUTION', checkId);
        } else {
          throw error;
        }
      }
    }
  }
  state.bytesCache.set(relativePath, bytes);
  return bytes;
}

/** Read (once) and parse (once) a JSON input. */
function parseRootJson(
  state: VerificationState,
  relativePath: string,
  checkId: EvidenceVerifyCheckId,
): ParsedJson {
  const cached = state.parsedCache.get(relativePath);
  if (cached !== undefined) return cached;
  const bytes = readRootFile(state, relativePath, checkId);
  let parsed: ParsedJson = { ok: false };
  if (bytes !== null) {
    try {
      parsed = { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
    } catch {
      parsed = { ok: false };
    }
  }
  state.parsedCache.set(relativePath, parsed);
  return parsed;
}

// ── Document / artifact scans ─────────────────────────────────────────────────

function emitScanFindings(state: VerificationState, flags: ScanFlags): void {
  if (flags.secrets) {
    addFinding(
      state,
      'VERIFY_SECRET_OR_AUTHORIZATION_MARKER',
      'PROHIBITED_BYTES_FOUND',
      'SECRET_SCAN',
    );
  }
  if (flags.paths) {
    addFinding(state, 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH', 'REDACTION_PROHIBITED_VALUE', 'PATH_SCAN');
  }
  if (flags.customers) {
    addFinding(
      state,
      'VERIFY_PRODUCTION_CUSTOMER_MARKER',
      'PROHIBITED_BYTES_FOUND',
      'CUSTOMER_MARKER_SCAN',
    );
  }
}

function scanDocumentValue(state: VerificationState, value: unknown): void {
  const flags = newScanFlags();
  const forbiddenRoots = state.env.forbiddenRoots ?? [];
  scanParsedValue(value, flags, forbiddenRoots, new WeakSet<object>());
  emitScanFindings(state, flags);
}

// ── Reference / authority / artifact checks ───────────────────────────────────

function runReferenceChecks(
  state: VerificationState,
  inventory: EvidenceIntendedInventory,
  manifest: EvidenceFinalManifest,
): void {
  const artifactIds = new Set(inventory.artifacts.map((artifact) => artifact.artifactId));

  for (const artifact of inventory.artifacts) {
    for (const consumer of artifact.consumedBy) {
      if (!artifactIds.has(consumer)) {
        addFinding(state, 'VERIFY_REFERENCE_DANGLING', 'REFERENCE_DANGLING', 'REFERENCE_GRAPH');
      }
    }
  }

  for (const reference of manifest.references) {
    if (!artifactIds.has(reference.fromArtifactId) || !artifactIds.has(reference.toArtifactId)) {
      addFinding(
        state,
        'VERIFY_REFERENCE_UNKNOWN_ID',
        'REFERENCE_UNKNOWN_ARTIFACT',
        'REFERENCE_GRAPH',
      );
    }
  }

  // Unknown-endpoint dangling is classified precisely above, so the validator's
  // REFERENCE_DANGLING rows are not re-emitted.
  for (const issue of validateReferenceGraph({
    artifacts: inventory.artifacts,
    references: manifest.references,
    transactionKind: inventory.transactionKind,
  })) {
    if (issue.code === 'REFERENCE_DANGLING') continue;
    addProjectedIssue(state, issue.code, 'REFERENCE_GRAPH');
  }

  for (const issue of validateInventoryManifestAgreement(inventory, manifest, {
    derivedInventoryIdentity: deriveIntendedInventoryIdentity(inventory),
  })) {
    if (issue.code === 'REFERENCE_DANGLING') continue;
    const checkId =
      issue.code === 'REFERENCE_REQUIRED_MISSING' || issue.code === 'REFERENCE_REQUIRED_MISMATCH'
        ? 'REQUIRED_AUTHORITY'
        : 'REFERENCE_GRAPH';
    addProjectedIssue(state, issue.code, checkId);
  }
}

function runRequiredAuthorityChecks(
  state: VerificationState,
  inventory: EvidenceIntendedInventory,
  manifest: EvidenceFinalManifest | null,
  manifestValid: boolean,
): void {
  const artifacts = inventory.artifacts;
  const atRecordPath = artifacts.filter((artifact) => artifact.relativePath === 'run-record.json');
  if (atRecordPath.length === 0) {
    addFinding(
      state,
      'VERIFY_REQUIRED_AUTHORITY_MISSING',
      'EVIDENCE_ARTIFACT_EMPTY',
      'REQUIRED_AUTHORITY',
    );
    return;
  }
  const required = artifacts.filter((artifact) => artifact.role === 'required-authoritative');
  const requiredAtRecordPath = atRecordPath.filter(
    (artifact) => artifact.role === 'required-authoritative',
  );
  if (requiredAtRecordPath.length === 0 || required.length !== 1) {
    addFinding(
      state,
      'VERIFY_REQUIRED_AUTHORITY_WEAKENED',
      'REFERENCE_REQUIRED_MISMATCH',
      'REQUIRED_AUTHORITY',
    );
    return;
  }
  const authority = requiredAtRecordPath[0] as EvidenceArtifactEntry;
  if (authority.semanticDigest === null || authority.semanticDigestKind === null) {
    addFinding(
      state,
      'VERIFY_REQUIRED_AUTHORITY_REDACTED',
      'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
      'REQUIRED_AUTHORITY',
    );
  }
  if (
    manifestValid &&
    manifest !== null &&
    !manifest.committedArtifacts.some((committed) => committed.artifactId === authority.artifactId)
  ) {
    addFinding(
      state,
      'VERIFY_REQUIRED_AUTHORITY_MISSING',
      'EVIDENCE_ARTIFACT_EMPTY',
      'REQUIRED_AUTHORITY',
    );
  }
}

interface ArtifactScanOutcome {
  readonly verified: number;
  readonly requiredProhibited: boolean;
  readonly diagnosticProhibited: boolean;
}

function parseArtifactJson(
  state: VerificationState,
  relativePath: string,
  bytes: Uint8Array,
): ParsedJson {
  const cached = state.parsedCache.get(relativePath);
  if (cached !== undefined) return cached;
  let parsed: ParsedJson = { ok: false };
  try {
    parsed = { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    parsed = { ok: false };
  }
  state.parsedCache.set(relativePath, parsed);
  return parsed;
}

/**
 * The PNG privacy-scan surface (ADR 0051C): exactly the data payloads of
 * non-`IDAT` chunks of a PNG that `inspectProhibitedBytes` has already
 * classified structurally valid.
 *
 * Validated-PNG precondition: `bytes` must have passed `inspectProhibitedBytes`
 * — the only structural validity authority for a declared PNG — with one of
 * its structurally accepted PNG results (`PROHIBITED_BYTES_NONE` /
 * `PROHIBITED_BYTES_FOUND`). This extractor performs no structural validation
 * of its own and never classifies validity: the framing checks below are
 * non-authoritative defensive bounds guards only. A PNG the authority
 * classified with its malformed-PNG structural result never reaches this
 * function (the call site invokes it strictly after the authority's accepted
 * result), so this walk's weaker termination semantics can never produce a
 * divergent privacy scan. PNG signature bytes, chunk length/type framing,
 * CRC bytes, and compressed `IDAT` payload bytes are never returned, decoded,
 * or privacy-scanned.
 */
function pngNonIdatPayloads(bytes: Uint8Array): Uint8Array[] {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength < signature.length ||
    signature.some((value, index) => bytes[index] !== value)
  ) {
    return [];
  }
  const payloads: Uint8Array[] = [];
  let offset: number = signature.length;
  while (offset < bytes.byteLength) {
    // A complete chunk needs a 4-byte length, a 4-byte type, and a 4-byte CRC.
    if (offset + 12 > bytes.byteLength) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    const length = view.getUint32(0);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) break;
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) break;
    if (type !== 'IDAT') {
      payloads.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    if (type === 'IEND') break;
    offset = chunkEnd;
  }
  return payloads;
}

function runArtifactChecks(
  state: VerificationState,
  inventory: EvidenceIntendedInventory,
  artifactOrdinals: ReadonlyMap<string, number>,
  missingIds: string[],
): ArtifactScanOutcome {
  let verified = 0;
  let requiredProhibited = false;
  let diagnosticProhibited = false;
  const forbiddenRoots = state.env.forbiddenRoots ?? [];

  for (const artifact of inventory.artifacts) {
    const ordinal = artifactOrdinals.get(artifact.artifactId) ?? null;
    if (!isEvidenceRelativePath(artifact.relativePath)) {
      addFinding(
        state,
        'VERIFY_ARTIFACT_PATH_INVALID',
        'EVIDENCE_RELATIVE_PATH_INVALID',
        'ARTIFACT_SET',
        ordinal,
      );
      continue;
    }
    const entry = state.entries.get(artifact.relativePath);
    if (entry === undefined) {
      addFinding(state, 'VERIFY_ARTIFACT_MISSING', 'ARTIFACT_LENGTH', 'ARTIFACT_SET', ordinal);
      missingIds.push(artifact.artifactId);
      continue;
    }
    if (entry.kind !== 'file') {
      // A symlink or any non-regular path is never converted into missing
      // evidence, and is never followed or deleted.
      addFinding(state, 'VERIFY_ARTIFACT_SYMLINK', 'ARTIFACT_LENGTH', 'ARTIFACT_SET', ordinal);
      continue;
    }

    const bytes = readRootFile(state, artifact.relativePath, 'ARTIFACT_BYTES');
    if (bytes === null) continue;

    let clean = true;
    if (bytes.byteLength !== artifact.byteLength) {
      addFinding(
        state,
        'VERIFY_ARTIFACT_LENGTH_MISMATCH',
        'ARTIFACT_LENGTH',
        'ARTIFACT_BYTES',
        ordinal,
      );
      clean = false;
    }
    if (sha256ExactBytes(bytes) !== artifact.sha256) {
      addFinding(
        state,
        'VERIFY_ARTIFACT_SHA256_MISMATCH',
        'ARTIFACT_SHA256',
        'ARTIFACT_SHA256',
        ordinal,
      );
      clean = false;
    }

    const parsed = parseArtifactJson(state, artifact.relativePath, bytes);

    if (artifact.semanticDigestKind === 'byte-stream') {
      addFinding(
        state,
        'VERIFY_UNKNOWN_DISCRIMINANT',
        'SEMANTIC_DIGEST_KIND_UNKNOWN',
        'ARTIFACT_SEMANTIC_DIGEST',
        ordinal,
      );
      clean = false;
    } else if (artifact.semanticDigest !== null && artifact.semanticDigestKind !== null) {
      if (!isEvidenceSemanticDigestKind(artifact.semanticDigestKind)) {
        addFinding(
          state,
          'VERIFY_UNKNOWN_DISCRIMINANT',
          'SEMANTIC_DIGEST_KIND_UNKNOWN',
          'ARTIFACT_SEMANTIC_DIGEST',
          ordinal,
        );
        clean = false;
      } else if (!parsed.ok) {
        addFinding(
          state,
          'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
          'ARTIFACT_SEMANTIC_DIGEST',
          'ARTIFACT_SEMANTIC_DIGEST',
          ordinal,
        );
        clean = false;
      } else {
        try {
          if (
            deriveSemanticDigest(artifact.semanticDigestKind, parsed.value) !==
            artifact.semanticDigest
          ) {
            addFinding(
              state,
              'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH',
              'ARTIFACT_SEMANTIC_DIGEST',
              'ARTIFACT_SEMANTIC_DIGEST',
              ordinal,
            );
            clean = false;
          }
        } catch (error) {
          if (error instanceof EvidenceSemanticDigestError) {
            addProjectedIssue(state, error.code, 'ARTIFACT_SEMANTIC_DIGEST', ordinal);
          } else {
            throw error;
          }
          clean = false;
        }
      }
    }

    const flags = newScanFlags();
    if (parsed.ok) {
      scanParsedValue(parsed.value, flags, forbiddenRoots, new WeakSet<object>());
    } else {
      const imagePng = artifact.mediaType === 'image/png';
      const inspection = inspectProhibitedBytes({
        apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
        bytes,
        mediaType: imagePng ? 'image/png' : 'opaque',
        format: imagePng ? 'png' : 'opaque',
        forbiddenRoots,
      });
      if (inspection.code === 'PROHIBITED_BYTES_MALFORMED_PNG') {
        addFinding(
          state,
          'VERIFY_SANITIZATION_PROHIBITED_VALUE',
          'PROHIBITED_BYTES_MALFORMED_PNG',
          'SANITIZATION_GUARD',
          ordinal,
        );
        clean = false;
      } else if (inspection.code === 'PROHIBITED_BYTES_FOUND') {
        addFinding(
          state,
          'VERIFY_SANITIZATION_PROHIBITED_VALUE',
          'PROHIBITED_BYTES_FOUND',
          'SANITIZATION_GUARD',
          ordinal,
        );
        clean = false;
      }
      if (imagePng) {
        // ADR 0051C (amendment v2): `inspectProhibitedBytes` is the only
        // structural-validity authority for a declared PNG. The non-IDAT
        // payload extractor runs strictly after that authority returned one of
        // its structurally accepted PNG results (`PROHIBITED_BYTES_NONE` /
        // `PROHIBITED_BYTES_FOUND`); when the authority returns its
        // malformed-PNG structural result the extractor never runs, so a
        // malformed PNG is governed solely by that authoritative result and no
        // secondary privacy scan is performed on it.
        const pngStructurallyAccepted =
          inspection.code === 'PROHIBITED_BYTES_NONE' ||
          inspection.code === 'PROHIBITED_BYTES_FOUND';
        if (pngStructurallyAccepted) {
          // Privacy scans cover only the data payloads of non-`IDAT` chunks.
          // PNG signature bytes, chunk length/type framing, CRC bytes, and
          // compressed `IDAT` payload bytes are never decoded or scanned.
          for (const payload of pngNonIdatPayloads(bytes)) {
            scanStringForProhibited(new TextDecoder().decode(payload), flags, forbiddenRoots);
          }
        }
      } else {
        scanStringForProhibited(new TextDecoder().decode(bytes), flags, forbiddenRoots);
      }
    }

    emitScanFindings(state, flags);

    const prohibited = flags.secrets || flags.paths || flags.customers;
    if (prohibited) {
      if (artifact.role === 'required-authoritative') requiredProhibited = true;
      else diagnosticProhibited = true;
    }
    if (clean) verified += 1;
  }

  return { verified, requiredProhibited, diagnosticProhibited };
}

function allowedAncestorDirectories(fileRelativePaths: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const filePath of fileRelativePaths) {
    const segments = filePath.split('/');
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      directories.add(prefix);
    }
  }
  return directories;
}

function runExtraFileScan(
  state: VerificationState,
  inventory: EvidenceIntendedInventory | null,
): string[] {
  const extraRelativePaths: string[] = [];
  // Only an inventory-bearing root applies the committed allowed-file set. A
  // legacy/no-inventory root preserves every historical path without
  // classifying it as extra.
  const allowedFiles =
    inventory === null
      ? null
      : new Set<string>([
          'intended-inventory.json',
          'final-manifest.json',
          ...inventory.artifacts.map((artifact) => artifact.relativePath),
        ]);
  const allowedDirectories =
    allowedFiles === null ? null : allowedAncestorDirectories([...allowedFiles]);
  for (const entry of state.entries.values()) {
    if (entry.kind === 'symlink') {
      addFinding(state, 'VERIFY_ARTIFACT_SYMLINK', 'ARTIFACT_LENGTH', 'ARTIFACT_SET');
      continue;
    }
    if (allowedFiles === null || allowedDirectories === null) continue;
    // A declared path is never reclassified as extra: an unexpected kind at a
    // declared path is already classified by the artifact/kind checks.
    if (allowedFiles.has(entry.relativePath)) continue;
    const isAllowedAncestorDirectory =
      entry.kind === 'directory' && allowedDirectories.has(entry.relativePath);
    if (isAllowedAncestorDirectory) continue;
    // Unexpected directories and special/non-regular entries are rejected
    // exactly like an extra regular file, and never silently ignored.
    addFinding(state, 'VERIFY_ARTIFACT_EXTRA', 'ARTIFACT_LENGTH', 'EXTRA_FILE_SCAN');
    extraRelativePaths.push(entry.relativePath);
  }
  return extraRelativePaths;
}

// ── Provenance helpers ────────────────────────────────────────────────────────

function provenancePresence(provenance: EvidenceProvenance): EvidenceVerifyDetails['provenance'] {
  const digestFields = [
    provenance.dirtyTreeDigest,
    provenance.lockfileDigest,
    provenance.cliBootstrapDigest,
    provenance.runnerDigest,
    provenance.evidenceWriterDigest,
    provenance.verifierDigest,
    provenance.runtimeEngineDigest,
  ];
  return {
    persistedIdentityValid: false,
    currentTreeCheck: 'not-run',
    currentTreeCreditEligible: false,
    repositoryRevisionPresent:
      typeof provenance.repositoryRevision === 'string' &&
      /^[a-f0-9]{7,64}$/.test(provenance.repositoryRevision),
    dirtyPolicyPresent:
      provenance.dirtyPolicy === 'clean' || provenance.dirtyPolicy === 'dirty-governed',
    lockfileDigestPresent: isEvidenceSha256Digest(provenance.lockfileDigest),
    componentDigestsPresent: digestFields.every((digest) => isEvidenceSha256Digest(digest)),
    catalogueIdentitiesPresent: Array.isArray(provenance.catalogueIdentities),
    profileIdentitiesPresent: Array.isArray(provenance.profileIdentities),
  };
}

// ── Root resolution ───────────────────────────────────────────────────────────

function asInventory(value: unknown): EvidenceIntendedInventory | null {
  return isPlainDataObject(value) ? (value as unknown as EvidenceIntendedInventory) : null;
}

function asManifest(value: unknown): EvidenceFinalManifest | null {
  return isPlainDataObject(value) ? (value as unknown as EvidenceFinalManifest) : null;
}

function canonicalArtifactOrdinals(
  inventory: EvidenceIntendedInventory | null,
): ReadonlyMap<string, number> {
  const ids = inventory === null ? [] : inventory.artifacts.map((artifact) => artifact.artifactId);
  const sorted = [...ids].sort();
  return new Map(sorted.map((id, index) => [id, index] as const));
}

function isPathContainedWithin(baseDirectory: string, candidate: string): boolean {
  const base = path.resolve(baseDirectory);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

/**
 * Read-only verification of one run evidence root (WP-B1). A suite root is not
 * activated by this core and is reported as `VERIFY_NOT_A_ROOT`; WP-B2 owns the
 * narrow suite-v2 child-manifest check.
 */
export function verifyEvidenceRoot(
  request: EvidenceVerifyRequest,
  env: EvidenceVerifyEnvironment,
): EvidenceVerifyDetails {
  const requestedId = request.requestedId;
  if (
    typeof requestedId !== 'string' ||
    !isEvidenceLogicalId(requestedId) ||
    requestedId.includes('/')
  ) {
    throw new EvidenceVerifyRequestError(
      'evidence verify requires a safe logical run or suite execution id.',
    );
  }

  // F4 — feature-detect the no-follow guarantee. Without it there is no safe
  // read, so fail closed before touching the filesystem at all.
  const capability = env.noFollowCapability ?? { support: 'supported' as const };
  if (capability.support !== 'supported') {
    return failureReport(
      'run',
      requestedId,
      'VERIFY_ROOT_UNREADABLE',
      'ROOT_RESOLUTION',
      'ROOT_RESOLUTION',
      'no-transaction',
    );
  }

  try {
    // F1 — validate every ancestry component from the configured evidence base
    // through `runs|suites` and the requested root with lstat/no-follow
    // semantics before reading any transaction bytes. A symlinked or
    // non-directory ancestor is a containment escape and is rejected, never
    // followed.
    const baseDir = env.evidenceBaseDir;
    const runsDir = path.join(baseDir, 'runs');
    const suitesDir = path.join(baseDir, 'suites');
    const baseStat = env.fs.lstat(baseDir);
    if (baseStat === null) {
      return failureReport(
        'run',
        requestedId,
        'VERIFY_ROOT_NOT_FOUND',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    if (baseStat.kind !== 'directory') {
      return failureReport(
        'run',
        requestedId,
        'VERIFY_NOT_A_ROOT',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    const runsAncestor = env.fs.lstat(runsDir);
    const suitesAncestor = env.fs.lstat(suitesDir);
    if (
      (runsAncestor !== null && runsAncestor.kind !== 'directory') ||
      (suitesAncestor !== null && suitesAncestor.kind !== 'directory')
    ) {
      return failureReport(
        'run',
        requestedId,
        'VERIFY_NOT_A_ROOT',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    const runsRoot = path.join(runsDir, requestedId);
    const suitesRoot = path.join(suitesDir, requestedId);
    if (
      !isPathContainedWithin(runsDir, runsRoot) ||
      !isPathContainedWithin(suitesDir, suitesRoot)
    ) {
      return failureReport(
        'run',
        requestedId,
        'VERIFY_NOT_A_ROOT',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    const runsStat = runsAncestor === null ? null : env.fs.lstat(runsRoot);
    const suitesStat = suitesAncestor === null ? null : env.fs.lstat(suitesRoot);
    const runPresent = runsStat !== null;
    const suitePresent = suitesStat !== null;

    if (runPresent && suitePresent) {
      return failureReport(
        'run',
        requestedId,
        'VERIFY_ID_AMBIGUOUS',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    if (!runPresent && !suitePresent) {
      return failureReport(
        'run',
        requestedId,
        'VERIFY_ROOT_NOT_FOUND',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    const scope: 'run' | 'suite' = runPresent ? 'run' : 'suite';
    const rootStat = runPresent
      ? (runsStat as EvidenceVerifyStat)
      : (suitesStat as EvidenceVerifyStat);
    // A symlink or non-directory root is rejected, never followed.
    if (rootStat.kind !== 'directory') {
      return failureReport(
        scope,
        requestedId,
        'VERIFY_NOT_A_ROOT',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    if (scope === 'suite') {
      // WP-B2: the narrow suite-v2 plus independently committed child-manifest
      // check. It never consumes, activates, or deletes a suite transaction
      // document and only ever reads suite/child roots.
      const suitesRootPath = path.join(env.evidenceBaseDir, 'suites', requestedId);
      return verifySuiteRoot(requestedId, suitesRootPath, env);
    }
    const rootPath = path.join(env.evidenceBaseDir, 'runs', requestedId);
    return verifyRunRoot(requestedId, rootPath, env);
  } catch (error) {
    if (isEvidenceVerifyExternalFsError(error)) {
      return failureReport(
        'run',
        requestedId,
        'VERIFY_ROOT_UNREADABLE',
        'ROOT_RESOLUTION',
        'ROOT_RESOLUTION',
        'no-transaction',
      );
    }
    return failureReport(
      'run',
      requestedId,
      'VERIFY_UNKNOWN_FAILURE',
      'UNKNOWN_EXCEPTION',
      'ROOT_RESOLUTION',
      'no-transaction',
    );
  }
}

// ── Run verification ──────────────────────────────────────────────────────────

interface RunRootVerification {
  readonly details: EvidenceVerifyDetails;
  /** Parsed public run/command record, `null` when the record is rejected. */
  readonly recordValue: Record<string, unknown> | null;
  /** The reader branch label (`current-v4`, `command-v4`, legacy, invalid). */
  readonly recordLabel: string | null;
  readonly recordSchemaVersion: number | null;
  /** The verified inventory's artifact ids in declaration order. */
  readonly artifactIds: readonly string[];
}

function verifyRunRoot(
  requestedId: string,
  rootPath: string,
  env: EvidenceVerifyEnvironment,
): EvidenceVerifyDetails {
  return verifyRunRootInternal(requestedId, rootPath, env).details;
}

function verifyRunRootInternal(
  requestedId: string,
  rootPath: string,
  env: EvidenceVerifyEnvironment,
): RunRootVerification {
  const state: VerificationState = {
    env,
    entries: new Map(),
    findings: [],
    bytesCache: new Map(),
    parsedCache: new Map(),
  };

  enumerateRoot(state, rootPath, '', 0);

  const inventoryPresent = state.entries.has('intended-inventory.json');
  const manifestPresent = state.entries.has('final-manifest.json');
  const runRecordPresent = state.entries.has('run-record.json');

  // Phase 2 — transaction documents (one read + one parse each).
  const inventoryParsed = inventoryPresent
    ? parseRootJson(state, 'intended-inventory.json', 'INVENTORY_CONTRACT')
    : null;
  const manifestParsed = manifestPresent
    ? parseRootJson(state, 'final-manifest.json', 'MANIFEST_CONTRACT')
    : null;

  const inventory =
    inventoryParsed !== null && inventoryParsed.ok ? asInventory(inventoryParsed.value) : null;
  const manifest =
    manifestParsed !== null && manifestParsed.ok ? asManifest(manifestParsed.value) : null;

  const inventoryIssues = inventory !== null ? validateEvidenceIntendedInventory(inventory) : [];
  const manifestIssues = manifest !== null ? validateEvidenceFinalManifest(manifest) : [];
  // A document that could not be read (external/absent) is not relabelled as a
  // JSON-contract fault: missing/symlink evidence keeps its own classification.
  if (
    inventoryParsed !== null &&
    !inventoryParsed.ok &&
    state.bytesCache.get('intended-inventory.json') != null
  ) {
    addFinding(
      state,
      'VERIFY_JSON_INVALID',
      'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
      'INVENTORY_CONTRACT',
    );
  }
  if (
    manifestParsed !== null &&
    !manifestParsed.ok &&
    state.bytesCache.get('final-manifest.json') != null
  ) {
    addFinding(
      state,
      'VERIFY_JSON_INVALID',
      'EVIDENCE_VALUE_NOT_PLAIN_OBJECT',
      'MANIFEST_CONTRACT',
    );
  }
  for (const issue of inventoryIssues) {
    addProjectedIssue(state, issue.code, inventoryCheckIdForSource(issue.code));
  }
  for (const issue of manifestIssues) {
    addProjectedIssue(state, issue.code, 'MANIFEST_CONTRACT');
  }
  const inventoryValid = inventory !== null && inventoryIssues.length === 0;
  const manifestValid = manifest !== null && manifestIssues.length === 0;

  // Sealed-schema agreement (enforced by the closed validators + literals).
  if (
    inventoryIssues.some((issue) => issue.code === 'EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH') ||
    manifestIssues.some((issue) => issue.code === 'EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH')
  ) {
    addFinding(
      state,
      'VERIFY_SEALED_SCHEMA_MISMATCH',
      'EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH',
      'SEALED_SCHEMA_AGREEMENT',
    );
  }

  // Phase 2 — strict run record via the pure parsed-value reader only.
  let strictRecordPresent = false;
  let recordBehaviorOutcome: Outcome | null = null;
  let recordValue: Record<string, unknown> | null = null;
  let recordLabel: string | null = null;
  let recordSchemaVersion: number | null = null;
  if (runRecordPresent) {
    const recordParsed = parseRootJson(state, 'run-record.json', 'STRICT_RECORD');
    if (recordParsed.ok) {
      const read = readFinalPublicRecord(recordParsed.value);
      strictRecordPresent =
        read.kind === 'current-v4' ||
        read.kind === 'command-v4' ||
        read.kind === 'legacy-v1' ||
        read.kind === 'legacy-v2' ||
        read.kind === 'legacy-v3';
      recordLabel = read.label;
      recordSchemaVersion = typeof read.schemaVersion === 'number' ? read.schemaVersion : null;
      if (read.record !== null && isPlainDataObject(read.record)) {
        recordValue = read.record as Record<string, unknown>;
      }
      const parsedRecordValue = read.record as Record<string, unknown> | null;
      if (parsedRecordValue !== null && isOutcome(parsedRecordValue.behaviorOutcome)) {
        recordBehaviorOutcome = parsedRecordValue.behaviorOutcome;
      } else if (parsedRecordValue !== null && isOutcome(parsedRecordValue.finalOutcome)) {
        recordBehaviorOutcome = parsedRecordValue.finalOutcome;
      }
    } else if (state.bytesCache.get('run-record.json') != null) {
      addFinding(state, 'VERIFY_JSON_INVALID', 'EVIDENCE_VALUE_NOT_PLAIN_OBJECT', 'STRICT_RECORD');
    }
  }

  // Phase 3 — document-level transaction classification.
  let transactionState: EvidenceVerifyTransaction['state'];
  let classification: {
    code: EvidenceVerifyCode;
    detailCode: EvidenceVerifyDetailCode;
    checkId: EvidenceVerifyCheckId;
  } | null = null;
  if (inventoryPresent && manifestPresent) {
    transactionState = inventoryValid && manifestValid ? 'committed' : 'invalid-transaction';
  } else if (inventoryPresent) {
    transactionState = inventoryValid ? 'partial-transaction' : 'invalid-transaction';
    classification = {
      code: 'VERIFY_PARTIAL_NO_MANIFEST',
      detailCode: 'ROOT_RESOLUTION',
      checkId: 'TRANSACTION_STATE',
    };
  } else if (manifestPresent) {
    transactionState = 'invalid-transaction';
    classification = {
      code: 'VERIFY_TRANSACTION_INVALID',
      detailCode: 'EVIDENCE_MISSING_KEY',
      checkId: 'TRANSACTION_STATE',
    };
  } else if (strictRecordPresent) {
    transactionState = 'legacy-unverifiable';
    classification = {
      code: 'VERIFY_LEGACY_UNVERIFIABLE',
      detailCode: 'ROOT_RESOLUTION',
      checkId: 'TRANSACTION_STATE',
    };
  } else {
    transactionState = 'no-transaction';
    classification = {
      code: 'VERIFY_TRANSACTION_INVALID',
      detailCode: 'ROOT_RESOLUTION',
      checkId: 'TRANSACTION_STATE',
    };
  }
  if (classification !== null) {
    addFinding(state, classification.code, classification.detailCode, classification.checkId);
  }

  // Phase 7 — document-level prohibited-value inspection.
  for (const parsed of [inventoryParsed, manifestParsed]) {
    if (parsed !== null && parsed.ok) scanDocumentValue(state, parsed.value);
  }
  if (runRecordPresent) {
    const recordParsed = state.parsedCache.get('run-record.json');
    if (recordParsed !== undefined && recordParsed.ok) scanDocumentValue(state, recordParsed.value);
  }

  // Phase 3/4/6 — identity, references, authority, artifacts, provenance.
  const artifactOrdinals = canonicalArtifactOrdinals(inventory);
  const missingIds: string[] = [];
  let verifiedCount = 0;
  let requiredProhibited = false;
  let diagnosticProhibited = false;

  if (inventoryValid && inventory !== null) {
    if (manifestValid && manifest !== null) {
      runReferenceChecks(state, inventory, manifest);
    }
    runRequiredAuthorityChecks(state, inventory, manifest, manifestValid);
    const outcome = runArtifactChecks(state, inventory, artifactOrdinals, missingIds);
    verifiedCount = outcome.verified;
    requiredProhibited = outcome.requiredProhibited;
    diagnosticProhibited = outcome.diagnosticProhibited;
  }

  let provenancePresent = emptyProvenance();
  if (inventoryValid && inventory !== null) {
    provenancePresent = provenancePresence(inventory.provenance);
    for (const issue of validateEvidenceProvenance(inventory.provenance)) {
      addProjectedIssue(state, issue.code, 'PROVENANCE_CONTRACT');
    }
  }
  let provenanceIdentityMatches = false;
  if (inventoryValid && inventory !== null && manifestValid && manifest !== null) {
    provenanceIdentityMatches =
      deriveProvenanceIdentity(inventory.provenance) === manifest.provenanceIdentity;
    if (!provenanceIdentityMatches) {
      addFinding(
        state,
        'VERIFY_PROVENANCE_IDENTITY_MISMATCH',
        'EVIDENCE_PROVENANCE_INVALID',
        'PROVENANCE_IDENTITY',
      );
    }
  }

  // Phase 5 — extra/symlink scan.
  const extraRelativePaths = runExtraFileScan(state, inventoryValid ? inventory : null);

  // Phase 6 — optional current-tree compatibility, advisory only.
  const persistedPrimary = primaryOf(
    state.findings.filter((finding) => finding.severity === 'blocking'),
  );
  let currentTreeCheck: EvidenceVerifyDetails['provenance']['currentTreeCheck'] = 'not-run';
  let currentTreeCreditEligible = false;
  if (
    transactionState === 'committed' &&
    persistedPrimary === null &&
    env.currentTree !== undefined &&
    inventory !== null &&
    inventoryValid
  ) {
    try {
      const signals = env.currentTree({ persistedProvenance: inventory.provenance });
      currentTreeCheck = signals.currentTreeCheck;
      currentTreeCreditEligible = signals.currentTreeCheck === 'PASS';
      if (signals.currentTreeCheck === 'DRIFT') {
        addFinding(
          state,
          'VERIFY_PROVENANCE_CURRENT_DRIFT',
          'CURRENT_TREE_DRIFT',
          'PROVENANCE_IDENTITY',
        );
      }
    } catch {
      currentTreeCheck = 'UNAVAILABLE';
      currentTreeCreditEligible = false;
      addFinding(
        state,
        'VERIFY_PROVENANCE_CURRENT_UNAVAILABLE',
        'CURRENT_TREE_UNAVAILABLE',
        'PROVENANCE_IDENTITY',
      );
    }
  }

  // Phase 8 — deterministic primary selection and report assembly.
  const blockingFindings = state.findings.filter((finding) => finding.severity === 'blocking');
  const primary = primaryOf(blockingFindings);
  const manifestBehaviorOutcome =
    manifestValid && manifest !== null && isOutcome(manifest.behaviorOutcome)
      ? manifest.behaviorOutcome
      : null;

  const transaction: EvidenceVerifyTransaction = {
    state: transactionState,
    failureClass: primary === null ? null : primary.blockingClass,
    failureCode: primary === null ? null : primary.code,
    commitPoint: transactionState === 'committed' ? 'committed' : 'not-committed',
    creditEligible: transactionState === 'committed' && primary === null,
    immutable: true,
    finalManifestPresent: manifestPresent,
    finalManifestValid: manifestValid,
    strictRecordPresent,
    behaviorOutcome: manifestBehaviorOutcome ?? recordBehaviorOutcome,
  };

  const referenceFindings = state.findings.filter(
    (finding) => finding.checkId === 'REFERENCE_GRAPH' && finding.severity === 'blocking',
  );
  const declaredReferences = manifestValid && manifest !== null ? manifest.references.length : 0;
  const prohibitedValuesFound = state.findings.some(
    (finding) =>
      finding.severity === 'blocking' &&
      (finding.checkId === 'SECRET_SCAN' ||
        finding.checkId === 'PATH_SCAN' ||
        finding.checkId === 'CUSTOMER_MARKER_SCAN' ||
        finding.checkId === 'SANITIZATION_GUARD'),
  );

  const details = assembleReport('run', requestedId, state.findings, {
    transaction,
    checks: buildChecks(state.findings),
    artifacts: {
      declaredCount: inventoryValid && inventory !== null ? inventory.artifacts.length : 0,
      verifiedCount,
      requiredCount:
        inventoryValid && inventory !== null
          ? inventory.artifacts.filter((artifact) => artifact.role === 'required-authoritative')
              .length
          : 0,
      diagnosticCount:
        inventoryValid && inventory !== null
          ? inventory.artifacts.filter((artifact) => artifact.role === 'diagnostic-only').length
          : 0,
      missingIds: [...missingIds].sort(),
      extraRelativePaths: [...extraRelativePaths].sort(),
    },
    references: {
      declaredCount: declaredReferences,
      verifiedCount: Math.max(0, declaredReferences - referenceFindings.length),
    },
    provenance: {
      ...provenancePresent,
      persistedIdentityValid:
        transactionState === 'committed' && provenanceIdentityMatches && inventoryValid,
      currentTreeCheck,
      currentTreeCreditEligible,
    },
    sanitization: {
      requiredApproved: !requiredProhibited,
      diagnosticApproved: !diagnosticProhibited,
      requiredAuthorityPreserved: !state.findings.some(
        (finding) => finding.checkId === 'REQUIRED_AUTHORITY' && finding.severity === 'blocking',
      ),
      prohibitedValuesFound,
    },
    suite: null,
  });

  return {
    details,
    recordValue,
    recordLabel,
    recordSchemaVersion,
    artifactIds:
      inventoryValid && inventory !== null
        ? inventory.artifacts.map((artifact) => artifact.artifactId)
        : [],
  };
}

// ── Suite verification (WP-B2) ────────────────────────────────────────────────

/**
 * The exact committed suite-root file set: the suite-v2 aggregate record only.
 * A suite root owns no Package-8 inventory, final manifest, or artifact set, so
 * a suite-level `intended-inventory.json`/`final-manifest.json` is activation
 * (classified, never consumed, never deleted), and every other entry is extra.
 */
const SUITE_ALLOWED_FILES: ReadonlySet<string> = new Set(['suite-record.json']);

/**
 * Cross-check only the child fields actually present in the parsed child run
 * record. `suite-v2` is the lineage authority, so absent `suiteLineageId`,
 * `parentSuiteExecutionId`, and `executionId` are never required or compared,
 * and an `order` field is never inferred from the run record.
 */
function suiteChildFieldsMismatch(
  child: FinalSuiteChildRecordV2,
  verification: RunRootVerification,
): boolean {
  const record = verification.recordValue;
  if (record !== null) {
    const present = (key: string): boolean => Object.hasOwn(record, key);
    if (present('runId') && record.runId !== child.runId) return true;
    if (present('caseId') && record.caseId !== child.caseId) return true;
    if (present('planFingerprint') && record.planFingerprint !== child.planFingerprint) return true;
    if (
      present('materializationFingerprint') &&
      record.materializationFingerprint !== child.materializationFingerprint
    ) {
      return true;
    }
    if (present('behaviorOutcome') && record.behaviorOutcome !== child.behaviorOutcome) return true;
    if (present('finalOutcome') && record.finalOutcome !== child.finalOutcome) return true;
  }
  // Label/schema: the suite-v2 child entry names a strict current child
  // (`current-v4`, schema 4) and the parsed record must agree on the schema.
  if (
    child.childRecordSchemaVersion !== null &&
    verification.recordSchemaVersion !== null &&
    child.childRecordSchemaVersion !== verification.recordSchemaVersion
  ) {
    return true;
  }
  return false;
}

/**
 * Narrow read-only verification of one suite-v2 root (WP-B2). It reads only the
 * suite aggregate and each independently committed child run root; it never
 * activates, consumes, creates, repairs, or deletes a suite Package-8
 * transaction, and never re-enters the optional current-tree provider for a
 * child.
 */
function verifySuiteRoot(
  requestedId: string,
  rootPath: string,
  env: EvidenceVerifyEnvironment,
): EvidenceVerifyDetails {
  const state: VerificationState = {
    env,
    entries: new Map(),
    findings: [],
    bytesCache: new Map(),
    parsedCache: new Map(),
  };
  enumerateRoot(state, rootPath, '', 0);

  const suiteRecordPresent = state.entries.has('suite-record.json');
  const inventoryPresent = state.entries.has('intended-inventory.json');
  const manifestPresent = state.entries.has('final-manifest.json');

  // A suite-level Package-8 transaction document is forbidden activation: it is
  // classified, never read as a consumed transaction, and never deleted.
  if (inventoryPresent || manifestPresent) {
    addFinding(state, 'VERIFY_SUITE_TRANSACTION_ACTIVATED', 'ROOT_RESOLUTION', 'TRANSACTION_STATE');
  }

  let recordLabel: EvidenceVerifySuite['recordLabel'] = null;
  let recordSchemaVersion: number | null = null;
  let suiteRecord: FinalSuiteRecordV2 | null = null;

  if (suiteRecordPresent) {
    const parsed = parseRootJson(state, 'suite-record.json', 'SUITE_RECORD');
    if (parsed.ok) {
      const read = readFinalSuiteRecord(parsed.value);
      if (read.kind === 'suite-v2') {
        suiteRecord = read.record;
        recordLabel = 'suite-v2';
        recordSchemaVersion = read.schemaVersion;
        scanDocumentValue(state, parsed.value);
      } else if (read.kind === 'legacy-suite-v1') {
        recordLabel = 'suite-v1';
        recordSchemaVersion = read.schemaVersion;
        addFinding(state, 'VERIFY_LEGACY_UNVERIFIABLE', 'ROOT_RESOLUTION', 'SUITE_RECORD');
      } else {
        for (const issue of read.issues) {
          addProjectedIssue(state, issue.code, 'SUITE_RECORD');
        }
      }
    } else if (state.bytesCache.get('suite-record.json') != null) {
      addFinding(state, 'VERIFY_JSON_INVALID', 'EVIDENCE_VALUE_NOT_PLAIN_OBJECT', 'SUITE_RECORD');
    }
  } else {
    addFinding(state, 'VERIFY_UNKNOWN_SCHEMA', 'EVIDENCE_MISSING_KEY', 'SUITE_RECORD');
  }

  for (const entry of state.entries.values()) {
    if (
      entry.relativePath === 'intended-inventory.json' ||
      entry.relativePath === 'final-manifest.json'
    ) {
      continue;
    }
    if (entry.kind === 'symlink') {
      addFinding(state, 'VERIFY_ARTIFACT_SYMLINK', 'ARTIFACT_LENGTH', 'SUITE_RECORD');
      continue;
    }
    if (SUITE_ALLOWED_FILES.has(entry.relativePath)) continue;
    addFinding(state, 'VERIFY_ARTIFACT_EXTRA', 'ARTIFACT_LENGTH', 'EXTRA_FILE_SCAN');
  }

  const children = suiteRecord === null ? [] : suiteRecord.children;
  const childVerifications: (RunRootVerification | null)[] = [];
  const uncommittedChildIds: string[] = [];
  let committedChildCount = 0;

  for (const child of children) {
    if (!child.recordPresent) {
      childVerifications.push(null);
      uncommittedChildIds.push(child.runId);
      continue;
    }
    // A record-bearing child is resolved beneath the already resolved evidence
    // base and verified as an independent run root. The child environment drops
    // the optional current-tree provider so a child cannot recursively run it.
    const childEnv: EvidenceVerifyEnvironment = { ...env, currentTree: undefined };
    let verification: RunRootVerification | null = null;
    try {
      verification = verifyRunRootInternal(
        child.runId,
        path.join(env.evidenceBaseDir, 'runs', child.runId),
        childEnv,
      );
    } catch {
      verification = null;
    }
    childVerifications.push(verification);
    if (
      verification === null ||
      verification.details.transaction.state !== 'committed' ||
      verification.details.transaction.failureCode !== null
    ) {
      uncommittedChildIds.push(child.runId);
      continue;
    }
    committedChildCount += 1;
  }

  const ordinals = canonicalSuiteSubjectOrdinals(
    children.map((child, index) => ({
      childKey: child.runId,
      order: child.order,
      artifactIds: childVerifications[index]?.artifactIds ?? [],
    })),
  );

  children.forEach((child, index) => {
    const ordinal = ordinals.get(child.runId)?.firstOrdinal ?? null;
    const verification = childVerifications[index] ?? null;
    if (
      !child.recordPresent ||
      verification === null ||
      verification.details.transaction.state !== 'committed' ||
      verification.details.transaction.failureCode !== null
    ) {
      addFinding(
        state,
        'VERIFY_SUITE_CHILD_NOT_COMMITTED',
        'ROOT_RESOLUTION',
        'SUITE_CHILD_MANIFESTS',
        ordinal,
      );
      return;
    }
    if (suiteChildFieldsMismatch(child, verification)) {
      addFinding(
        state,
        'VERIFY_SUITE_CHILD_IDENTITY_MISMATCH',
        'SUITE_RECORD_CHILD_IDENTITY_MISMATCH',
        'SUITE_CHILD_MANIFESTS',
        ordinal,
      );
    }
  });

  const blockingFindings = state.findings.filter((finding) => finding.severity === 'blocking');
  const primary = primaryOf(blockingFindings);
  const suiteValid = suiteRecord !== null;
  const transactionState: EvidenceVerifyTransaction['state'] = suiteValid
    ? 'committed'
    : recordLabel === 'suite-v1'
      ? 'legacy-unverifiable'
      : 'invalid-transaction';
  const prohibitedValuesFound = state.findings.some(
    (finding) =>
      finding.severity === 'blocking' &&
      (finding.checkId === 'SECRET_SCAN' ||
        finding.checkId === 'PATH_SCAN' ||
        finding.checkId === 'CUSTOMER_MARKER_SCAN' ||
        finding.checkId === 'SANITIZATION_GUARD'),
  );
  const transaction: EvidenceVerifyTransaction = {
    state: transactionState,
    failureClass: primary === null ? null : primary.blockingClass,
    failureCode: primary === null ? null : primary.code,
    commitPoint: 'not-applicable',
    creditEligible: suiteValid && primary === null,
    immutable: true,
    finalManifestPresent: false,
    finalManifestValid: false,
    strictRecordPresent: suiteValid,
    behaviorOutcome: null,
  };

  return assembleReport('suite', requestedId, state.findings, {
    transaction,
    checks: buildChecks(state.findings, SUITE_CHECK_SPECS),
    artifacts: emptyArtifacts(),
    references: { declaredCount: 0, verifiedCount: 0 },
    provenance: emptyProvenance(),
    sanitization: {
      requiredApproved: !prohibitedValuesFound,
      diagnosticApproved: true,
      requiredAuthorityPreserved: !state.findings.some(
        (finding) => finding.checkId === 'REQUIRED_AUTHORITY' && finding.severity === 'blocking',
      ),
      prohibitedValuesFound,
    },
    suite: {
      recordLabel,
      recordSchemaVersion,
      childCount: children.length,
      committedChildCount,
      uncommittedChildIds: uncommittedChildIds.filter((id) => isEvidenceLogicalId(id)),
      suiteTransactionActivation:
        inventoryPresent || manifestPresent ? 'forbidden-activated' : 'deferred-not-activated',
    },
  });
}

// ── Production current-tree compatibility provider (WP-B2) ────────────────────

export interface CurrentTreeProvenanceProviderOptions {
  /** Repository root; defaults to the resolved repository root. */
  readonly repoRoot?: string;
}

const CURRENT_TREE_PROVENANCE_FLOWS: readonly ProvenanceFlow[] = [
  'diagnostic',
  'doctor',
  'production-absence',
  'suite-child',
];

function currentTreeComponentsMatch(
  governedEntries: RepositoryProvenanceInputs['governedEntries'],
  flow: ProvenanceFlow,
  persisted: EvidenceProvenance,
  engineDigest: string,
): boolean {
  try {
    return (
      componentDigestFromEntries(governedEntries, 'cliBootstrapDigest', flow) ===
        persisted.cliBootstrapDigest &&
      componentDigestFromEntries(governedEntries, 'runnerDigest', flow) ===
        persisted.runnerDigest &&
      componentDigestFromEntries(governedEntries, 'evidenceWriterDigest', flow) ===
        persisted.evidenceWriterDigest &&
      componentDigestFromEntries(governedEntries, 'verifierDigest', flow) ===
        persisted.verifierDigest &&
      engineDigest === persisted.runtimeEngineDigest
    );
  } catch {
    return false;
  }
}

/**
 * The production read-only current-tree compatibility provider (WP-B2, plan
 * §9 Phase 6). It recomputes the governed dirty-tree and component identities
 * from the current repository through the accepted read-only collector and
 * frozen component policy. Agreement is `PASS`; any legitimate repository
 * change is advisory `DRIFT`. It never writes, stages, repairs, or mutates
 * repository state, and it never emits a path, digest, or value.
 *
 * A collector/resource failure propagates as a thrown error so the verifier
 * maps it to the advisory `UNAVAILABLE`, never `ENVIRONMENT_FAILURE`.
 */
export function createCurrentTreeProvenanceProvider(
  options: CurrentTreeProvenanceProviderOptions = {},
): (context: EvidenceVerifyCurrentTreeContext) => EvidenceVerifyCurrentTreeSignals {
  return (context) => {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    const collected = collectRepositoryProvenanceInputs({ repoRoot });
    const governedTreeDigest = governedTreeDigestFromCollectedInputs(collected);
    const engineDigest = runtimeEngineDigest(repoRoot);
    const persisted = context.persistedProvenance;
    const repositoryMatches =
      governedTreeDigest === persisted.dirtyTreeDigest &&
      collected.repositoryRevision.toLowerCase() === persisted.repositoryRevision.toLowerCase() &&
      collected.lockfileDigest === persisted.lockfileDigest &&
      collected.dirtyPolicy === persisted.dirtyPolicy;
    const componentsMatch = CURRENT_TREE_PROVENANCE_FLOWS.some((flow) =>
      currentTreeComponentsMatch(collected.governedEntries, flow, persisted, engineDigest),
    );
    return { currentTreeCheck: repositoryMatches && componentsMatch ? 'PASS' : 'DRIFT' };
  };
}
