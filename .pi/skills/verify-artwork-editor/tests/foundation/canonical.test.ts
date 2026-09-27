import { describe, expect, it } from 'vitest';

import {
  CanonicalizationError,
  IDENTITY_DOMAINS,
  buildIdentityPreimage,
  canonicalize,
  domainSeparatedDigest,
  sha256Hex,
} from '../../src/canonical/canonicalize';

class NonPlainValue {
  readonly label = 'not-canonical';
}

describe('[Gate A] canonical serialization (TS-1)', () => {
  it('is independent of object key authoring order', () => {
    const first = { b: 2, a: 1, nested: { d: 4, c: 3 } };
    const second = { nested: { c: 3, d: 4 }, a: 1, b: 2 };

    expect(canonicalize(first)).toBe(canonicalize(second));
    expect(domainSeparatedDigest(IDENTITY_DOMAINS.caseId, 1, first)).toBe(
      domainSeparatedDigest(IDENTITY_DOMAINS.caseId, 1, second),
    );
  });

  it('treats array order as meaningful', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('rejects values that have no unambiguous canonical form', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(CanonicalizationError);
    expect(() => canonicalize(undefined)).toThrow(CanonicalizationError);
    expect(() => canonicalize({ present: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalize([undefined])).toThrow(CanonicalizationError);
    // A genuine sparse array (a real hole, not an explicit undefined element).
    const sparse = new Array<unknown>(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(() => canonicalize(sparse)).toThrow(CanonicalizationError);
    expect(() => canonicalize({ fn: () => 1 })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ symbol: Symbol('x') })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ big: 1n })).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Date('2026-09-17T00:00:00.000Z'))).toThrow(CanonicalizationError);
    expect(() => canonicalize(new NonPlainValue())).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Map([['a', 1]]))).toThrow(CanonicalizationError);
  });

  it('does not silently collapse an explicit null into an absent value', () => {
    expect(canonicalize({ value: null })).not.toBe(canonicalize({}));
  });

  it('domain-separates the same value across artifact kinds and identity-schema versions', () => {
    const value = { same: 'value' };

    expect(domainSeparatedDigest(IDENTITY_DOMAINS.caseId, 1, value)).not.toBe(
      domainSeparatedDigest(IDENTITY_DOMAINS.plan, 1, value),
    );
    expect(domainSeparatedDigest(IDENTITY_DOMAINS.caseId, 1, value)).not.toBe(
      domainSeparatedDigest(IDENTITY_DOMAINS.caseId, 2, value),
    );
  });

  it('produces stable full SHA-256 hex digests', () => {
    const digest = domainSeparatedDigest(IDENTITY_DOMAINS.caseId, 1, { a: 1 });

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(domainSeparatedDigest(IDENTITY_DOMAINS.caseId, 1, { a: 1 }));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('keeps an auditable canonical preimage for every identity', () => {
    const preimage = buildIdentityPreimage(IDENTITY_DOMAINS.plan, 1, { a: 1 });

    expect(preimage).toContain(`makeit.verify-artwork-editor/${IDENTITY_DOMAINS.plan}/v1`);
    expect(preimage).toContain(canonicalize({ a: 1 }));
    expect(sha256Hex(preimage)).toBe(domainSeparatedDigest(IDENTITY_DOMAINS.plan, 1, { a: 1 }));
  });
});
