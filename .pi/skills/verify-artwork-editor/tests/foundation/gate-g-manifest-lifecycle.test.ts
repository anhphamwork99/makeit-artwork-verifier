import { describe, expect, it } from 'vitest';

import {
  deriveSelectionManifestFingerprint,
  validateManifestTransition,
  validateSelectionManifest,
} from '../../src/governance/manifest';
import {
  deriveGovernanceIdentity,
  GOVERNANCE_IDENTITY_DOMAINS,
} from '../../src/canonical/governance-identity';
import type {
  SelectionManifest,
  SelectionManifestContent,
} from '../../src/contracts/manifest-lifecycle';

const DIGEST = 'a'.repeat(64);
const content: SelectionManifestContent = {
  schemaVersion: 1,
  bindings: [
    { bindingId: 'layer/text#move', modelFingerprint: DIGEST },
    { bindingId: 'layer/image#change', modelFingerprint: 'b'.repeat(64) },
  ],
  requiredCells: [{ cellId: 'desktop', classification: 'required-credit' }],
  entries: [
    { entryId: 'one', bindingId: 'layer/text#move', cellId: 'desktop', order: 0 },
    { entryId: 'two', bindingId: 'layer/image#change', cellId: 'desktop', order: 1 },
  ],
};
function manifest(overrides: Partial<SelectionManifest> = {}): SelectionManifest {
  return {
    schemaVersion: 1,
    manifestId: 'manifest-1',
    revision: 1,
    state: 'GENERATED_DRAFT',
    content,
    contentFingerprint: deriveSelectionManifestFingerprint(content),
    ...overrides,
  };
}

describe('Gate-G static manifest preparation (never grants credit)', () => {
  it('normalizes object properties and set-like membership but preserves execution order', () => {
    const reorderedMembership: SelectionManifestContent = {
      entries: content.entries,
      requiredCells: [...content.requiredCells].reverse(),
      bindings: [...content.bindings].reverse(),
      schemaVersion: 1,
    };
    expect(deriveSelectionManifestFingerprint(reorderedMembership)).toBe(
      deriveSelectionManifestFingerprint(content),
    );
    const reorderedExecution: SelectionManifestContent = {
      ...content,
      entries: [content.entries[1]!, content.entries[0]!],
    };
    expect(deriveSelectionManifestFingerprint(reorderedExecution)).not.toBe(
      deriveSelectionManifestFingerprint(content),
    );
    expect(
      validateSelectionManifest(
        manifest({
          content: reorderedExecution,
          contentFingerprint: deriveSelectionManifestFingerprint(reorderedExecution),
        }),
      ).issues,
    ).toContain('MANIFEST_ORDER');
    expect(
      deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.qualificationBatch, content),
    ).not.toBe(deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, content));
  });

  it('validates closed shape, exact coverage mapping and fingerprint without trusting a state label', () => {
    expect(validateSelectionManifest(manifest())).toEqual({
      valid: true,
      issues: [],
      releaseCredit: false,
    });
    const bad = {
      ...manifest(),
      content: { ...content, entries: [{ ...content.entries[0], bindingId: 'unknown' }] },
      contentFingerprint: DIGEST,
    };
    expect(validateSelectionManifest(bad).issues).toContain('MANIFEST_COVERAGE');
    expect(validateSelectionManifest({ ...manifest(), surprising: true }).issues).toContain(
      'MANIFEST_SHAPE',
    );
    expect(
      validateSelectionManifest({ ...manifest(), contentFingerprint: DIGEST }).issues,
    ).toContain('MANIFEST_FINGERPRINT');
    expect(
      validateSelectionManifest({ ...manifest(), content: { ...content, requiredCells: [] } })
        .issues,
    ).toContain('MANIFEST_COVERAGE');
    expect(
      validateSelectionManifest({
        ...manifest(),
        content: { ...content, entries: [content.entries[0], content.entries[0]] },
      }).issues,
    ).toContain('MANIFEST_DUPLICATE');
    expect(validateSelectionManifest({ ...manifest(), state: 'ACTIVE' }).issues).toContain(
      'MANIFEST_APPROVAL_REFERENCE',
    );
    expect(validateSelectionManifest({ ...manifest(), state: 'BOGUS' }).issues).toContain(
      'MANIFEST_STATE',
    );
    expect(validateSelectionManifest(null).valid).toBe(false);
  });

  it('requires every selected binding × required-credit cell pair exactly once', () => {
    const twoByTwo: SelectionManifestContent = {
      schemaVersion: 1,
      bindings: [
        { bindingId: 'layer/text#move', modelFingerprint: DIGEST },
        { bindingId: 'layer/image#change', modelFingerprint: 'b'.repeat(64) },
      ],
      requiredCells: [
        { cellId: 'desktop', classification: 'required-credit' },
        { cellId: 'mobile', classification: 'required-credit' },
      ],
      entries: [
        { entryId: 'one', bindingId: 'layer/text#move', cellId: 'desktop', order: 0 },
        { entryId: 'two', bindingId: 'layer/text#move', cellId: 'mobile', order: 1 },
        { entryId: 'three', bindingId: 'layer/image#change', cellId: 'desktop', order: 2 },
        { entryId: 'four', bindingId: 'layer/image#change', cellId: 'mobile', order: 3 },
      ],
    };
    expect(
      validateSelectionManifest(
        manifest({
          content: twoByTwo,
          contentFingerprint: deriveSelectionManifestFingerprint(twoByTwo),
        }),
      ),
    ).toEqual({ valid: true, issues: [], releaseCredit: false });

    // Sparse cross-cell selection: both bindings and both cells still appear, but
    // (text, mobile) and (image, desktop) are absent, so the cross product is incomplete.
    const sparse: SelectionManifestContent = {
      ...twoByTwo,
      entries: [
        { entryId: 'one', bindingId: 'layer/text#move', cellId: 'desktop', order: 0 },
        { entryId: 'two', bindingId: 'layer/image#change', cellId: 'mobile', order: 1 },
      ],
    };
    const sparseResult = validateSelectionManifest(
      manifest({ content: sparse, contentFingerprint: deriveSelectionManifestFingerprint(sparse) }),
    );
    expect(sparseResult.issues).toContain('MANIFEST_COVERAGE');
    expect(sparseResult.valid).toBe(false);
    expect(sparseResult.releaseCredit).toBe(false);

    // A repeated pair is rejected as a duplicate, not accepted as extra coverage.
    const duplicatedPair: SelectionManifestContent = {
      ...twoByTwo,
      entries: [
        { entryId: 'one', bindingId: 'layer/text#move', cellId: 'desktop', order: 0 },
        { entryId: 'two', bindingId: 'layer/text#move', cellId: 'desktop', order: 1 },
        { entryId: 'three', bindingId: 'layer/image#change', cellId: 'desktop', order: 2 },
        { entryId: 'four', bindingId: 'layer/image#change', cellId: 'mobile', order: 3 },
      ],
    };
    const duplicateResult = validateSelectionManifest(
      manifest({
        content: duplicatedPair,
        contentFingerprint: deriveSelectionManifestFingerprint(duplicatedPair),
      }),
    );
    expect(duplicateResult.issues).toContain('MANIFEST_DUPLICATE');
    expect(duplicateResult.releaseCredit).toBe(false);

    // Invalid authoring data still returns findings rather than throwing.
    expect(() => validateSelectionManifest({ ...manifest(), content: sparse })).not.toThrow();
    expect(validateSelectionManifest({ ...manifest(), content: sparse }).valid).toBe(false);
  });

  it('only checks approval-reference structure, never authenticates its human source', () => {
    const hypothetical = manifest({
      state: 'APPROVED_FROZEN',
      approvalReference: {
        authority: 'synthetic-test-only',
        reference: 'fake-reference',
        digest: DIGEST,
      },
    });
    expect(validateSelectionManifest(hypothetical)).toEqual({
      valid: true,
      issues: [],
      releaseCredit: false,
    });
    expect(
      validateSelectionManifest({
        ...hypothetical,
        approvalReference: { ...hypothetical.approvalReference, digest: 'fake' },
      }).issues,
    ).toContain('MANIFEST_APPROVAL_REFERENCE');
  });

  it('describes legal transitions but never performs one or changes frozen content', () => {
    const draft = manifest();
    const candidate = manifest({ state: 'VALIDATED_CANDIDATE', revision: 2 });
    expect(validateManifestTransition(draft, candidate)).toEqual({
      valid: true,
      issues: [],
      releaseCredit: false,
    });
    expect(draft.state).toBe('GENERATED_DRAFT');
    expect(
      validateManifestTransition(draft, manifest({ state: 'ACTIVE', revision: 2 })).issues,
    ).toContain('MANIFEST_APPROVAL_REFERENCE');
    const frozen = manifest({
      state: 'APPROVED_FROZEN',
      revision: 3,
      approvalReference: { authority: 'test', reference: 'test', digest: DIGEST },
    });
    const changed: SelectionManifestContent = {
      ...content,
      entries: [{ ...content.entries[0]!, entryId: 'different' }, content.entries[1]!],
    };
    const changedActive = manifest({
      state: 'ACTIVE',
      revision: 4,
      approvalReference: frozen.approvalReference,
      content: changed,
      contentFingerprint: deriveSelectionManifestFingerprint(changed),
    });
    expect(validateManifestTransition(frozen, changedActive).issues).toContain(
      'MANIFEST_FROZEN_MUTATION',
    );
  });

  it('fails closed for unsupported authoring values rather than throwing', () => {
    const cyclic: Record<string, unknown> = { ...manifest() };
    cyclic.self = cyclic;
    expect(() => validateSelectionManifest(cyclic)).not.toThrow();
    expect(validateSelectionManifest(cyclic).valid).toBe(false);
    const hostile = Object.defineProperty({}, 'content', {
      get() {
        throw new Error('hostile');
      },
      enumerable: true,
    });
    expect(validateSelectionManifest(hostile).valid).toBe(false);
  });
});
