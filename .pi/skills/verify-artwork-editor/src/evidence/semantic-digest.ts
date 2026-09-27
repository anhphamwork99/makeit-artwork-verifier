import { CANONICAL_NAMESPACE, canonicalize, sha256Hex } from '../canonical/canonicalize';
import {
  EVIDENCE_SEMANTIC_DIGEST_KINDS,
  type EvidenceSemanticDigestKind,
  isEvidenceByteSequence,
  isEvidenceSemanticDigestKind,
  isPlainDataObject,
} from '../contracts/evidence-transaction';

/**
 * Package-8 semantic digests (ADR 0041 P8-A1).
 *
 * A semantic digest is a domain-separated SHA-256 over the *meaning* of a
 * candidate artifact value, not over its byte serialization. It is order-stable
 * for object authoring order and for record-set order, and order-sensitive for
 * an explicitly ordered list, so two semantically different contracts can never
 * collapse onto one digest and an irrelevant reordering can never move one.
 *
 * The four kinds are closed: `canonical-json`, `ordered-list`, `record-set`, and
 * `byte-stream`. The module is pure and imports no filesystem/CLI/runtime code.
 */

export const EVIDENCE_SEMANTIC_DIGEST_SCHEMA_VERSION = 1;

export const EVIDENCE_SEMANTIC_DIGEST_FAILURE_CODES = [
  'SEMANTIC_DIGEST_KIND_UNKNOWN',
  'SEMANTIC_DIGEST_VALUE_NOT_ORDERED_LIST',
  'SEMANTIC_DIGEST_VALUE_NOT_RECORD_SET',
  'SEMANTIC_DIGEST_RECORD_SET_ID_MISSING',
  'SEMANTIC_DIGEST_VALUE_NOT_BYTES',
] as const;
export type EvidenceSemanticDigestFailureCode =
  (typeof EVIDENCE_SEMANTIC_DIGEST_FAILURE_CODES)[number];

export class EvidenceSemanticDigestError extends Error {
  readonly code: EvidenceSemanticDigestFailureCode;
  constructor(code: EvidenceSemanticDigestFailureCode, message: string) {
    super(message);
    this.name = 'EvidenceSemanticDigestError';
    this.code = code;
  }
}

function fail(code: EvidenceSemanticDigestFailureCode, message: string): never {
  throw new EvidenceSemanticDigestError(code, message);
}

function decodeBytes(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isEvidenceByteSequence(value)) return new TextDecoder().decode(value);
  return fail(
    'SEMANTIC_DIGEST_VALUE_NOT_BYTES',
    'byte-stream requires a string or Uint8Array value.',
  );
}

/**
 * Normalize a value into the exact string that participates in the semantic
 * digest. Non-canonicalizable values fail closed through `CanonicalizationError`;
 * a value that contradicts its declared kind fails through
 * `EvidenceSemanticDigestError`.
 */
function normalizeSemanticValue(kind: EvidenceSemanticDigestKind, value: unknown): string {
  switch (kind) {
    case 'canonical-json':
      return canonicalize(value);
    case 'ordered-list':
      if (!Array.isArray(value)) {
        fail('SEMANTIC_DIGEST_VALUE_NOT_ORDERED_LIST', 'ordered-list requires an array value.');
      }
      return canonicalize(value);
    case 'record-set': {
      if (!Array.isArray(value)) {
        fail('SEMANTIC_DIGEST_VALUE_NOT_RECORD_SET', 'record-set requires an array value.');
      }
      const records = value.map((entry) => {
        if (!isPlainDataObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
          return fail(
            'SEMANTIC_DIGEST_RECORD_SET_ID_MISSING',
            'Every record-set entry must be a plain object with a non-empty string id.',
          );
        }
        return entry;
      });
      const sorted = [...records].sort((left, right) =>
        (left.id as string) < (right.id as string) ? -1 : 1,
      );
      return canonicalize(sorted);
    }
    case 'byte-stream':
      return decodeBytes(value);
    default:
      return fail('SEMANTIC_DIGEST_KIND_UNKNOWN', 'Unknown semantic-digest kind.');
  }
}

/** The full canonical preimage, kept auditable so a digest is never the only diagnosis. */
export function buildSemanticDigestPreimage(
  kind: EvidenceSemanticDigestKind,
  value: unknown,
): string {
  if (!isEvidenceSemanticDigestKind(kind)) {
    fail('SEMANTIC_DIGEST_KIND_UNKNOWN', 'Unknown semantic-digest kind.');
  }
  return `${CANONICAL_NAMESPACE}/evidence-semantic-digest/${kind}/v${EVIDENCE_SEMANTIC_DIGEST_SCHEMA_VERSION}\n${normalizeSemanticValue(kind, value)}`;
}

export function deriveSemanticDigest(kind: EvidenceSemanticDigestKind, value: unknown): string {
  return sha256Hex(buildSemanticDigestPreimage(kind, value));
}

/** Content digest over exact bytes (the `byte-stream` semantic digest). */
export function deriveByteStreamDigest(bytes: Uint8Array | string): string {
  return deriveSemanticDigest('byte-stream', bytes);
}

/**
 * The declared semantic-digest kinds paired with the projection that produced
 * them. Exposed so a caller can never record a semantic digest without its kind.
 */
export interface DerivedSemanticDigest {
  readonly kind: EvidenceSemanticDigestKind;
  readonly digest: string;
}

export function deriveDeclaredSemanticDigest(
  kind: EvidenceSemanticDigestKind,
  value: unknown,
): DerivedSemanticDigest {
  return { kind, digest: deriveSemanticDigest(kind, value) };
}

/** True when every member of the closed kind vocabulary is known. */
export function semanticDigestKinds(): readonly EvidenceSemanticDigestKind[] {
  return EVIDENCE_SEMANTIC_DIGEST_KINDS;
}
