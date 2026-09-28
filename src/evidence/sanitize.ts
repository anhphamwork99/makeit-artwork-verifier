import { createHash } from 'node:crypto';
import { type EvidenceRole, isEvidenceRole } from '../contracts/discriminants';
import {
  type EvidenceSanitizationPolicy,
  type EvidenceSemanticDigestKind,
  isEvidenceByteSequence,
  isEvidenceLogicalId,
  isEvidenceRelativePath,
  isEvidenceSanitizationPolicy,
  isEvidenceSemanticDigestKind,
} from '../contracts/evidence-transaction';
import {
  RedactionRejectedError,
  assertPublicRecordSafe,
  textContainsProhibitedValue,
} from './guard';
import { deriveSemanticDigest } from './semantic-digest';

/**
 * Sanitizer-approved-byte boundary (ADR 0041 P8-A1, ADR 0011 R8/R9).
 *
 * Publication may only ever write *sanitizer-approved bytes*. This module is the
 * single boundary that decides, for one candidate artifact, whether its exact
 * bytes are safe to publish. It never rewrites the bytes of an approved artifact:
 * approval means "these exact bytes passed the complete public redaction guard",
 * so an approved SHA-256 always matches what is written.
 *
 * The authority invariant is non-negotiable. A `required-authoritative` artifact
 * can never be redacted, changed, or omitted into acceptability: if sanitization
 * would change required meaning, the call fails and finalization must fail. A
 * `diagnostic-only` artifact that fails the guard may be omitted (a recorded
 * downgrade) rather than published unsafe.
 *
 * This module is pure and imports no filesystem, CLI, runtime, or browser code.
 */

export const EVIDENCE_SANITIZATION_APPROVALS = ['approved', 'omitted'] as const;
export type EvidenceSanitizationApproval = (typeof EVIDENCE_SANITIZATION_APPROVALS)[number];

export const EVIDENCE_SANITIZATION_FAILURE_CODES = [
  'SANITIZATION_ROLE_UNKNOWN',
  'SANITIZATION_POLICY_UNKNOWN',
  'SANITIZATION_BYTES_INVALID',
  'SANITIZATION_PROHIBITED_VALUE',
  'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
  'SANITIZATION_REQUIRED_AUTHORITY_OMITTED',
  'SANITIZATION_ARTIFACT_ID_INVALID',
  'SANITIZATION_PATH_INVALID',
  'SANITIZATION_APPROVAL_FORGED',
] as const;
export type EvidenceSanitizationFailureCode = (typeof EVIDENCE_SANITIZATION_FAILURE_CODES)[number];

export class EvidenceSanitizationError extends Error {
  readonly code: EvidenceSanitizationFailureCode;
  constructor(code: EvidenceSanitizationFailureCode, message: string) {
    super(message);
    this.name = 'EvidenceSanitizationError';
    this.code = code;
  }
}

export function isEvidenceSanitizationError(error: unknown): error is EvidenceSanitizationError {
  return error instanceof EvidenceSanitizationError;
}

export interface SanitizeArtifactBytesInput {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly role: EvidenceRole;
  readonly policy: EvidenceSanitizationPolicy;
  readonly bytes: string | Uint8Array;
  readonly semanticDigestKind?: EvidenceSemanticDigestKind | null;
  /** Semantic value used only for the semantic digest; never for byte approval. */
  readonly semanticValue?: unknown;
  /** Registered private absolute paths the guard must reject if leaked. */
  readonly forbiddenPaths?: readonly string[];
}

export interface SanitizationApprovalDescription {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly role: EvidenceRole;
  readonly policy: EvidenceSanitizationPolicy;
  readonly approval: EvidenceSanitizationApproval;
  readonly byteLength: number;
  readonly sha256: string | null;
  readonly semanticDigest: string | null;
  readonly semanticDigestKind: EvidenceSemanticDigestKind | null;
  /** True when sanitization downgraded or removed the candidate. */
  readonly changed: boolean;
}

declare const SANITIZED_ARTIFACT_APPROVAL_BRAND: unique symbol;

/** Opaque runtime-authenticated sanitizer result. */
export interface SanitizedArtifactApproval {
  readonly [SANITIZED_ARTIFACT_APPROVAL_BRAND]: true;
}

interface SanitizationApprovalState extends SanitizationApprovalDescription {
  readonly bytes: Uint8Array | null;
}

const SANITIZATION_APPROVALS = new WeakMap<object, SanitizationApprovalState>();

function registerApproval(state: SanitizationApprovalState): SanitizedArtifactApproval {
  const handle = Object.freeze(Object.create(null)) as SanitizedArtifactApproval;
  SANITIZATION_APPROVALS.set(handle as object, state);
  return handle;
}

function requireApproval(handle: SanitizedArtifactApproval): SanitizationApprovalState {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_APPROVAL_FORGED',
      'Sanitization approval handle is not registered.',
    );
  }
  const state = SANITIZATION_APPROVALS.get(handle as object);
  if (state === undefined) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_APPROVAL_FORGED',
      'Sanitization approval handle is not registered.',
    );
  }
  return state;
}

function decode(bytes: string | Uint8Array): string {
  if (typeof bytes === 'string') return bytes;
  return new TextDecoder().decode(bytes);
}

function toBytes(bytes: string | Uint8Array): Uint8Array {
  return typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function pngMetadataContainsProhibitedValue(
  bytes: Uint8Array,
  forbiddenPaths: readonly string[],
): boolean | null {
  if (
    bytes.byteLength < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    return null;
  }
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) return true;
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type !== 'IDAT') {
      const metadata = new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length));
      if (textContainsProhibitedValue(metadata, forbiddenPaths)) return true;
    }
    offset = chunkEnd;
    if (type === 'IEND') return false;
  }
  return true;
}

function opaqueBytesContainProhibitedValue(
  bytes: string | Uint8Array,
  forbiddenPaths: readonly string[],
): boolean {
  if (typeof bytes === 'string') return textContainsProhibitedValue(bytes, forbiddenPaths);
  const pngResult = pngMetadataContainsProhibitedValue(bytes, forbiddenPaths);
  return pngResult ?? textContainsProhibitedValue(new TextDecoder().decode(bytes), forbiddenPaths);
}

/**
 * Decide whether one candidate artifact's exact bytes are approved for
 * publication. Throws {@link EvidenceSanitizationError} when required authority
 * would be changed or omitted, or when the candidate conflicts with its declared
 * policy.
 */
export function sanitizeArtifactBytes(
  input: SanitizeArtifactBytesInput,
): SanitizedArtifactApproval {
  if (!isEvidenceLogicalId(input.artifactId)) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_ARTIFACT_ID_INVALID',
      'Artifact id is not a safe logical id.',
    );
  }
  if (!isEvidenceRelativePath(input.relativePath)) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_PATH_INVALID',
      'Artifact path is not a safe repository-relative path.',
    );
  }
  if (!isEvidenceRole(input.role)) {
    throw new EvidenceSanitizationError('SANITIZATION_ROLE_UNKNOWN', 'Unknown evidence role.');
  }
  if (!isEvidenceSanitizationPolicy(input.policy)) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_POLICY_UNKNOWN',
      'Unknown sanitization policy.',
    );
  }
  if (typeof input.bytes !== 'string' && !isEvidenceByteSequence(input.bytes)) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_BYTES_INVALID',
      'Bytes must be a string or Uint8Array.',
    );
  }
  if (isEvidenceByteSequence(input.bytes) && input.bytes.byteLength === 0) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_BYTES_INVALID',
      'Empty byte candidates are not publishable.',
    );
  }
  const forbiddenPaths = input.forbiddenPaths ?? [];
  const text = decode(input.bytes);

  let rejected = false;
  if (input.policy === 'public-json-guard-v1') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new EvidenceSanitizationError(
        'SANITIZATION_BYTES_INVALID',
        'A public-json-guard-v1 candidate must be valid JSON.',
      );
    }
    try {
      assertPublicRecordSafe(parsed, { forbiddenPaths });
    } catch (error) {
      if (error instanceof RedactionRejectedError) rejected = true;
      else throw error;
    }
  } else if (opaqueBytesContainProhibitedValue(input.bytes, forbiddenPaths)) {
    rejected = true;
  }

  const semanticDigestKind = input.semanticDigestKind ?? null;
  if (semanticDigestKind !== null && !isEvidenceSemanticDigestKind(semanticDigestKind)) {
    throw new EvidenceSanitizationError(
      'SANITIZATION_POLICY_UNKNOWN',
      'Unknown semantic-digest kind.',
    );
  }

  if (rejected) {
    if (input.role === 'required-authoritative') {
      throw new EvidenceSanitizationError(
        'SANITIZATION_PROHIBITED_VALUE',
        'Required authority cannot be redacted or downgraded into acceptability.',
      );
    }
    return registerApproval({
      artifactId: input.artifactId,
      relativePath: input.relativePath,
      role: input.role,
      policy: input.policy,
      approval: 'omitted',
      bytes: null,
      byteLength: 0,
      sha256: null,
      semanticDigest: null,
      semanticDigestKind: null,
      changed: true,
    });
  }

  if (input.role === 'required-authoritative' && semanticDigestKind === null) {
    // A required-authoritative artifact must declare its semantic identity so a
    // changed required meaning can never pass unnoticed.
    throw new EvidenceSanitizationError(
      'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
      'Required authority requires a declared semantic digest.',
    );
  }

  const approvedBytes = new Uint8Array(toBytes(input.bytes));
  const semanticDigest =
    semanticDigestKind === null
      ? null
      : deriveSemanticDigest(
          semanticDigestKind,
          input.semanticValue === undefined ? text : input.semanticValue,
        );

  return registerApproval({
    artifactId: input.artifactId,
    relativePath: input.relativePath,
    role: input.role,
    policy: input.policy,
    approval: 'approved',
    bytes: approvedBytes,
    byteLength: approvedBytes.byteLength,
    sha256: sha256Bytes(approvedBytes),
    semanticDigest,
    semanticDigestKind,
    changed: false,
  });
}

/** Public metadata view; authoritative bytes remain in the private registry. */
export function inspectSanitizationApproval(
  approval: SanitizedArtifactApproval,
): SanitizationApprovalDescription {
  const { bytes: _bytes, ...description } = requireApproval(approval);
  return Object.freeze({ ...description });
}

/**
 * Internal planner bridge. It authenticates the handle and returns a defensive
 * byte snapshot; mutating the returned value cannot alter sanitizer authority.
 */
export function snapshotSanitizationApproval(
  approval: SanitizedArtifactApproval,
): SanitizationApprovalState {
  const state = requireApproval(approval);
  return {
    ...state,
    bytes: state.bytes === null ? null : new Uint8Array(state.bytes),
  };
}

/**
 * Guard one already-built sanitization state against the authority invariant.
 * This is a redundant, explicit check so a caller that receives a state from an
 * injected boundary cannot publish required authority as omitted.
 */
export function assertSanitizationAuthorityInvariant(approval: SanitizedArtifactApproval): void {
  const state = requireApproval(approval);
  if (state.role === 'required-authoritative' && state.approval !== 'approved') {
    throw new EvidenceSanitizationError(
      'SANITIZATION_REQUIRED_AUTHORITY_OMITTED',
      'Required authority can never be published as omitted.',
    );
  }
}

// ── Pure read-only prohibited-byte inspection API (ADR 0048 WP-B0, plan §6.2) ──
//
// Additive only: this boundary inspects exact bytes without creating an
// approval, without registering writer state, and without changing
// `sanitizeArtifactBytes` behavior. It returns a fixed code and a boolean; it
// never returns bytes, values, paths, keys, ordinals, an approval, or an
// approval handle.

export const EVIDENCE_PROHIBITED_BYTES_API_VERSION = 1 as const;

export const EVIDENCE_PROHIBITED_BYTES_CODES = [
  'PROHIBITED_BYTES_NONE',
  'PROHIBITED_BYTES_FOUND',
  'PROHIBITED_BYTES_MALFORMED_PNG',
  'PROHIBITED_BYTES_INVALID_INPUT',
] as const;
export type EvidenceProhibitedBytesCode = (typeof EVIDENCE_PROHIBITED_BYTES_CODES)[number];

export interface InspectProhibitedBytesInput {
  readonly apiVersion: typeof EVIDENCE_PROHIBITED_BYTES_API_VERSION;
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/png' | 'opaque';
  readonly format: 'png' | 'opaque';
  readonly forbiddenRoots: readonly string[];
}

export interface InspectProhibitedBytesResult {
  readonly apiVersion: typeof EVIDENCE_PROHIBITED_BYTES_API_VERSION;
  readonly code: EvidenceProhibitedBytesCode;
  readonly prohibited: boolean;
}

const INSPECT_PROHIBITED_BYTES_INPUT_KEYS: readonly string[] = Object.freeze([
  'apiVersion',
  'bytes',
  'mediaType',
  'format',
  'forbiddenRoots',
]);

function isInspectPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function prohibitedBytesResult(
  code: EvidenceProhibitedBytesCode,
  prohibited: boolean,
): InspectProhibitedBytesResult {
  return Object.freeze({
    apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
    code,
    prohibited,
  });
}

type PngInspection = 'clean' | 'found' | 'malformed';

/**
 * Structural PNG inspection: requires the PNG signature, in-bounds chunk
 * framing through a zero-length terminal `IEND`, and no trailing bytes after
 * that `IEND`. Non-IDAT chunk metadata is scanned with the existing
 * prohibited-value policy.
 *
 * A malformed/truncated PNG is `malformed`: a bad signature, a truncated chunk
 * header/data/CRC, a non-zero-length `IEND`, an `IEND` that is not the final
 * chunk (trailing bytes), or a missing `IEND`. In particular, a byte appended
 * after a valid PNG can never be silently accepted as clean.
 */
function inspectPngChunks(bytes: Uint8Array, forbiddenRoots: readonly string[]): PngInspection {
  if (
    bytes.byteLength < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    return 'malformed';
  }
  let offset: number = PNG_SIGNATURE.length;
  while (offset < bytes.byteLength) {
    // A complete chunk needs a 4-byte length, a 4-byte type, and a 4-byte CRC.
    if (offset + 12 > bytes.byteLength) return 'malformed';
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    const length = view.getUint32(0);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) return 'malformed';
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) return 'malformed';
    if (type === 'IEND') {
      // `IEND` is the terminal chunk: its data length must be exactly zero and
      // it must end exactly at the end of the byte sequence.
      return length === 0 && chunkEnd === bytes.byteLength ? 'clean' : 'malformed';
    }
    if (type !== 'IDAT') {
      const metadata = new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length));
      if (textContainsProhibitedValue(metadata, forbiddenRoots)) return 'found';
    }
    offset = chunkEnd;
  }
  return 'malformed';
}

/**
 * Pure, versioned, read-only prohibited-byte inspection. Never throws, never
 * mutates input, and never creates or reads an approval handle.
 */
export function inspectProhibitedBytes(
  input: InspectProhibitedBytesInput,
): InspectProhibitedBytesResult {
  if (!isInspectPlainObject(input)) {
    return prohibitedBytesResult('PROHIBITED_BYTES_INVALID_INPUT', true);
  }
  for (const key of Object.keys(input)) {
    if (!INSPECT_PROHIBITED_BYTES_INPUT_KEYS.includes(key)) {
      return prohibitedBytesResult('PROHIBITED_BYTES_INVALID_INPUT', true);
    }
  }
  if (input.apiVersion !== EVIDENCE_PROHIBITED_BYTES_API_VERSION) {
    return prohibitedBytesResult('PROHIBITED_BYTES_INVALID_INPUT', true);
  }
  if (!isEvidenceByteSequence(input.bytes)) {
    return prohibitedBytesResult('PROHIBITED_BYTES_INVALID_INPUT', true);
  }
  if (
    !Array.isArray(input.forbiddenRoots) ||
    !input.forbiddenRoots.every((root) => typeof root === 'string')
  ) {
    return prohibitedBytesResult('PROHIBITED_BYTES_INVALID_INPUT', true);
  }
  const isPngPair = input.mediaType === 'image/png' && input.format === 'png';
  const isOpaquePair = input.mediaType === 'opaque' && input.format === 'opaque';
  if (!isPngPair && !isOpaquePair) {
    // A PNG-signature payload is never silently reclassified as opaque.
    return prohibitedBytesResult('PROHIBITED_BYTES_INVALID_INPUT', true);
  }
  const forbiddenRoots = input.forbiddenRoots as readonly string[];
  if (isPngPair) {
    const result = inspectPngChunks(input.bytes, forbiddenRoots);
    if (result === 'malformed') {
      return prohibitedBytesResult('PROHIBITED_BYTES_MALFORMED_PNG', true);
    }
    return prohibitedBytesResult(
      result === 'found' ? 'PROHIBITED_BYTES_FOUND' : 'PROHIBITED_BYTES_NONE',
      result === 'found',
    );
  }
  const text = new TextDecoder().decode(input.bytes);
  const found = textContainsProhibitedValue(text, forbiddenRoots);
  return prohibitedBytesResult(found ? 'PROHIBITED_BYTES_FOUND' : 'PROHIBITED_BYTES_NONE', found);
}
