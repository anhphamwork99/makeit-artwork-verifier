import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/canonical/canonicalize';
import {
  buildSemanticDigestPreimage,
  deriveByteStreamDigest,
  deriveSemanticDigest,
  EVIDENCE_SEMANTIC_DIGEST_SCHEMA_VERSION,
  EvidenceSemanticDigestError,
} from '../../src/evidence/semantic-digest';
import {
  assertSanitizationAuthorityInvariant,
  EVIDENCE_SANITIZATION_FAILURE_CODES,
  EvidenceSanitizationError,
  inspectSanitizationApproval,
  sanitizeArtifactBytes,
  snapshotSanitizationApproval,
  type SanitizedArtifactApproval,
} from '../../src/evidence/sanitize';

/**
 * P8-A1 sanitizer-approved-byte boundary and semantic digests (ADR 0041;
 * ADR 0011 R8/R9).
 *
 * Proves the authority invariant (required authority is never redacted, changed,
 * or omitted into acceptability), exact-byte approval, policy/role failure
 * codes, and the order-stable/semantically-sensitive semantic digest contract.
 */

const HEX = (character: string): string => character.repeat(64);

function pngWithChunk(type: 'IDAT' | 'tEXt', payload: string): Uint8Array {
  const data = new TextEncoder().encode(payload);
  const chunk = new Uint8Array(12 + data.byteLength);
  new DataView(chunk.buffer).setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  const iend = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]);
  const result = new Uint8Array(8 + chunk.byteLength + iend.byteLength);
  result.set([137, 80, 78, 71, 13, 10, 26, 10]);
  result.set(chunk, 8);
  result.set(iend, 8 + chunk.byteLength);
  return result;
}

describe('[P8-A1] sanitizer-approved-byte boundary', () => {
  it('approves the exact bytes of a safe required-authoritative candidate', () => {
    const text = JSON.stringify({ outcome: 'PASS', count: 2 });
    const state = sanitizeArtifactBytes({
      artifactId: 'artifact:doctor-json',
      relativePath: 'files/doctor.json',
      role: 'required-authoritative',
      policy: 'public-json-guard-v1',
      bytes: text,
      semanticDigestKind: 'canonical-json',
      semanticValue: { outcome: 'PASS', count: 2 },
    });
    const view = inspectSanitizationApproval(state);
    const snapshot = snapshotSanitizationApproval(state);
    expect(view.approval).toBe('approved');
    expect(view.changed).toBe(false);
    expect(view.policy).toBe('public-json-guard-v1');
    expect(view.sha256).toBe(sha256Hex(text));
    expect(view.byteLength).toBe(new TextEncoder().encode(text).length);
    expect(new TextDecoder().decode(snapshot.bytes ?? new Uint8Array())).toBe(text);
    expect(view.semanticDigest).toBe(
      deriveSemanticDigest('canonical-json', { outcome: 'PASS', count: 2 }),
    );
  });

  it('approves safe diagnostic bytes without a semantic digest', () => {
    const text = JSON.stringify({ warning: 'stale mirror' });
    const state = sanitizeArtifactBytes({
      artifactId: 'artifact:warning',
      relativePath: 'files/warning.json',
      role: 'diagnostic-only',
      policy: 'public-json-guard-v1',
      bytes: text,
    });
    const view = inspectSanitizationApproval(state);
    expect(view.approval).toBe('approved');
    expect(view.semanticDigest).toBeNull();
    expect(view.semanticDigestKind).toBeNull();
  });

  it('returns a frozen data-free handle and snapshots caller-owned bytes', () => {
    const source = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const approval = sanitizeArtifactBytes({
      artifactId: 'artifact:opaque',
      relativePath: 'files/opaque.bin',
      role: 'diagnostic-only',
      policy: 'opaque-bytes-guard-v1',
      bytes: source,
    });
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Reflect.ownKeys(approval)).toEqual([]);
    source.fill(0);
    expect([...(snapshotSanitizationApproval(approval).bytes ?? [])]).toEqual([
      0xff, 0xfe, 0x00, 0x80,
    ]);
  });

  it('refuses a prohibited required-authoritative value instead of downgrading it', () => {
    const text = JSON.stringify({ leak: '/Users/secret/x' });
    try {
      sanitizeArtifactBytes({
        artifactId: 'artifact:doctor-json',
        relativePath: 'files/doctor.json',
        role: 'required-authoritative',
        policy: 'public-json-guard-v1',
        bytes: text,
        semanticDigestKind: 'canonical-json',
        semanticValue: { leak: 'redacted' },
      });
      throw new Error('expected sanitization failure');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceSanitizationError);
      expect((error as EvidenceSanitizationError).code).toBe('SANITIZATION_PROHIBITED_VALUE');
    }
  });

  it('omits a prohibited diagnostic-only candidate rather than publishing it', () => {
    const text = JSON.stringify({ leak: '/Users/secret/x' });
    const state = sanitizeArtifactBytes({
      artifactId: 'artifact:debug',
      relativePath: 'files/debug.json',
      role: 'diagnostic-only',
      policy: 'public-json-guard-v1',
      bytes: text,
    });
    const view = inspectSanitizationApproval(state);
    expect(view.approval).toBe('omitted');
    expect(view.changed).toBe(true);
    expect(snapshotSanitizationApproval(state).bytes).toBeNull();
    expect(view.sha256).toBeNull();
  });

  it('guards opaque bytes under the opaque policy', () => {
    expect(() =>
      sanitizeArtifactBytes({
        artifactId: 'artifact:png',
        relativePath: 'files/a.png',
        role: 'required-authoritative',
        policy: 'opaque-bytes-guard-v1',
        bytes: new TextEncoder().encode('PNG blob:http://127.0.0.1/x'),
        semanticDigestKind: 'byte-stream',
      }),
    ).toThrow(EvidenceSanitizationError);
    const omitted = sanitizeArtifactBytes({
      artifactId: 'artifact:png',
      relativePath: 'files/a.png',
      role: 'diagnostic-only',
      policy: 'opaque-bytes-guard-v1',
      bytes: new TextEncoder().encode('PNG blob:http://127.0.0.1/x'),
    });
    expect(inspectSanitizationApproval(omitted).approval).toBe('omitted');
  });

  it('ignores compressed PNG image data while still rejecting prohibited PNG metadata', () => {
    const imageData = sanitizeArtifactBytes({
      artifactId: 'artifact:png-idat',
      relativePath: 'files/idat.png',
      role: 'diagnostic-only',
      policy: 'opaque-bytes-guard-v1',
      bytes: pngWithChunk('IDAT', '/var/random-compressed-sequence/'),
    });
    expect(inspectSanitizationApproval(imageData).approval).toBe('approved');

    const metadata = sanitizeArtifactBytes({
      artifactId: 'artifact:png-text',
      relativePath: 'files/text.png',
      role: 'diagnostic-only',
      policy: 'opaque-bytes-guard-v1',
      bytes: pngWithChunk('tEXt', '/var/private/metadata'),
    });
    expect(inspectSanitizationApproval(metadata).approval).toBe('omitted');
  });

  it('fails closed on unknown roles, policies, invalid JSON, and empty bytes', () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [
        {
          artifactId: 'a',
          relativePath: 'files/a.json',
          role: 'nope',
          policy: 'public-json-guard-v1',
          bytes: '{}',
        },
        'SANITIZATION_ROLE_UNKNOWN',
      ],
      [
        {
          artifactId: 'a',
          relativePath: 'files/a.json',
          role: 'diagnostic-only',
          policy: 'nope',
          bytes: '{}',
        },
        'SANITIZATION_POLICY_UNKNOWN',
      ],
      [
        {
          artifactId: 'a',
          relativePath: 'files/a.json',
          role: 'diagnostic-only',
          policy: 'public-json-guard-v1',
          bytes: '{',
        },
        'SANITIZATION_BYTES_INVALID',
      ],
      [
        {
          artifactId: 'a',
          relativePath: 'files/a.bin',
          role: 'diagnostic-only',
          policy: 'opaque-bytes-guard-v1',
          bytes: new Uint8Array(0),
        },
        'SANITIZATION_BYTES_INVALID',
      ],
    ];
    for (const [input, code] of cases) {
      try {
        sanitizeArtifactBytes(input as never);
        throw new Error(`expected ${code}`);
      } catch (error) {
        expect((error as EvidenceSanitizationError).code, code).toBe(code);
      }
    }
  });

  it('requires a declared semantic digest for required authority', () => {
    try {
      sanitizeArtifactBytes({
        artifactId: 'a',
        relativePath: 'files/a.json',
        role: 'required-authoritative',
        policy: 'public-json-guard-v1',
        bytes: '{"ok":true}',
      });
      throw new Error('expected required semantic digest failure');
    } catch (error) {
      expect((error as EvidenceSanitizationError).code).toBe(
        'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
      );
    }
  });

  it('exposes the closed failure vocabulary and enforces the authority invariant redundantly', () => {
    expect(new Set(EVIDENCE_SANITIZATION_FAILURE_CODES).size).toBe(
      EVIDENCE_SANITIZATION_FAILURE_CODES.length,
    );
    const forged = Object.freeze(Object.create(null)) as SanitizedArtifactApproval;
    expect(() => assertSanitizationAuthorityInvariant(forged)).toThrow(EvidenceSanitizationError);
    expect(() => inspectSanitizationApproval(forged)).toThrow(EvidenceSanitizationError);
  });
});

describe('[P8-A1] semantic digests', () => {
  it('is order-stable for canonical JSON and sensitive to a semantic change', () => {
    const first = deriveSemanticDigest('canonical-json', { a: 1, b: { c: 2, d: 3 } });
    const reordered = deriveSemanticDigest('canonical-json', { b: { d: 3, c: 2 }, a: 1 });
    const changed = deriveSemanticDigest('canonical-json', { a: 1, b: { c: 2, d: 4 } });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('is order-sensitive for an explicitly ordered list', () => {
    const first = deriveSemanticDigest('ordered-list', ['a', 'b']);
    expect(deriveSemanticDigest('ordered-list', ['b', 'a'])).not.toBe(first);
  });

  it('is order-stable for a record set keyed by id', () => {
    const first = deriveSemanticDigest('record-set', [
      { id: 'b', value: 2 },
      { id: 'a', value: 1 },
    ]);
    const reordered = deriveSemanticDigest('record-set', [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ]);
    expect(reordered).toBe(first);
  });

  it('fails closed on a kind/value contradiction', () => {
    const failures: readonly [() => string, string][] = [
      [
        () => deriveSemanticDigest('ordered-list', { not: 'a list' }),
        'SEMANTIC_DIGEST_VALUE_NOT_ORDERED_LIST',
      ],
      [
        () => deriveSemanticDigest('record-set', { not: 'a list' }),
        'SEMANTIC_DIGEST_VALUE_NOT_RECORD_SET',
      ],
      [
        () => deriveSemanticDigest('record-set', [{ value: 1 }]),
        'SEMANTIC_DIGEST_RECORD_SET_ID_MISSING',
      ],
      [() => deriveSemanticDigest('byte-stream', 42), 'SEMANTIC_DIGEST_VALUE_NOT_BYTES'],
      [() => deriveSemanticDigest('nope' as never, 'x'), 'SEMANTIC_DIGEST_KIND_UNKNOWN'],
    ];
    for (const [run, code] of failures) {
      try {
        run();
        throw new Error(`expected ${code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceSemanticDigestError);
        expect((error as EvidenceSemanticDigestError).code, code).toBe(code);
      }
    }
  });

  it('treats string and byte streams with equal bytes as the same digest', () => {
    const text = 'same bytes';
    expect(deriveByteStreamDigest(new TextEncoder().encode(text))).toBe(
      deriveByteStreamDigest(text),
    );
  });

  it('separates kinds and keeps the preimage auditable', () => {
    const value = ['a', 'b'];
    expect(deriveSemanticDigest('ordered-list', value)).not.toBe(
      deriveSemanticDigest('canonical-json', value),
    );
    const preimage = buildSemanticDigestPreimage('ordered-list', value);
    expect(preimage).toContain('evidence-semantic-digest/ordered-list');
    expect(preimage).toContain(`/v${EVIDENCE_SEMANTIC_DIGEST_SCHEMA_VERSION}`);
    expect(sha256Hex(preimage)).toBe(deriveSemanticDigest('ordered-list', value));
    expect(HEX('a')).toHaveLength(64);
  });
});
