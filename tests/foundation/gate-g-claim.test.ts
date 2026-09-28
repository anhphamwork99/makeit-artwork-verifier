import { describe, expect, it } from 'vitest';

import * as claimContract from '../../src/contracts/production-claim';
import type {
  ClaimApprovalReference,
  ClaimEnvironmentCell,
  ProductionClaimInput,
} from '../../src/contracts/production-claim';
import type {
  ReleaseAssessmentInput,
  ReleaseRequiredEntry,
  ReleaseWorkRecord,
} from '../../src/contracts/release-credit';
import type { SelectionManifestContent } from '../../src/contracts/manifest-lifecycle';
import { deriveSelectionManifestFingerprint } from '../../src/governance/manifest';
import { assessReleaseCredit } from '../../src/governance/release-credit';
import * as claimGovernance from '../../src/governance/claim';
import { assessProductionClaimCompleteness } from '../../src/governance/claim';

const DIGEST = 'a'.repeat(64);
const MODEL_FINGERPRINT = 'b'.repeat(64);
const CORRECTNESS_FINGERPRINT = 'c'.repeat(64);

/**
 * Hypothetical caller-supplied approval: well formed, deliberately unverified,
 * and never authenticated by any pure function (production specification §13.10).
 */
const HYPOTHETICAL_APPROVAL: ClaimApprovalReference = {
  role: 'product-owner',
  authority: 'product-owner',
  reference: 'hypothetical-approval-2026-09-24',
  digest: DIGEST,
};

const HYPOTHETICAL_GATE_F = { accepted: true, integrity: 'complete' } as const;

const CELL: ClaimEnvironmentCell = {
  cellId: 'chromium-desktop-1440x1000',
  classification: 'required-credit',
  browser: 'chromium',
  operatingSystem: 'macos-arm64',
  viewportWidth: 1440,
  viewportHeight: 1000,
  devicePixelRatio: 1,
  locale: 'en-US',
  timezone: 'UTC',
};

function cell(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...CELL, ...overrides };
}

/** Fully synthetic hypothetical: every structural dimension happens to be present. */
function positiveInput(): ProductionClaimInput {
  return {
    schemaVersion: 1,
    scope: {
      frontendOnly: true,
      bindings: [
        {
          subjectId: 'artwork/editor',
          capability: 'frontendSerializeRestore',
          coverageModelFingerprint: MODEL_FINGERPRINT,
          correctnessPolicyFingerprint: CORRECTNESS_FINGERPRINT,
        },
      ],
    },
    coverage: {
      scenarios: ['artwork-editor-serialize-restore-normalized'],
      variants: [],
      partitions: [],
      transitions: [],
      obligations: ['obligation-raw-semantic-payload'],
    },
    manifest: { manifestId: 'manifest-1', contentFingerprint: DIGEST },
    environment: { cells: [CELL] },
    run: { runId: 'release-run-2026-09-24', executedAtUtc: '2026-09-24T00:00:00.000Z' },
    exclusions: { exclusions: [], knownGaps: [], status: 'current' },
    approvals: [HYPOTHETICAL_APPROVAL],
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('Gate-G static Production Claim completeness (never authenticates or credits)', () => {
  it('treats a fully synthetic hypothetical claim as structurally complete and nothing more', () => {
    expect(assessProductionClaimCompleteness(positiveInput())).toEqual({
      structurallyComplete: true,
      issues: [],
      approvalAuthenticated: false,
      rendered: false,
      published: false,
      releaseCredit: false,
    });
    // The untrusted approval reference and the completeness label never leak authority.
    const serialized = JSON.stringify(assessProductionClaimCompleteness(positiveInput()));
    expect(serialized).toContain('"approvalAuthenticated":false');
    expect(serialized).toContain('"rendered":false');
    expect(serialized).toContain('"published":false');
    expect(serialized).toContain('"releaseCredit":false');
  });

  it('requires every dimension independently with a stable issue code', () => {
    const dimensions: Array<[keyof ProductionClaimInput, string]> = [
      ['scope', 'CLAIM_SCOPE'],
      ['coverage', 'CLAIM_COVERAGE'],
      ['manifest', 'CLAIM_MANIFEST'],
      ['environment', 'CLAIM_ENVIRONMENT'],
      ['run', 'CLAIM_RUN_REFERENCE'],
      ['exclusions', 'CLAIM_EXCLUSIONS'],
      ['approvals', 'CLAIM_APPROVAL_REFERENCE'],
    ];
    for (const [field, code] of dimensions) {
      const assessment = assessProductionClaimCompleteness({
        ...positiveInput(),
        [field]: undefined,
      });
      expect(assessment.issues).toEqual([code]);
      expect(assessment.structurallyComplete).toBe(false);
      expect(assessment.releaseCredit).toBe(false);
    }
  });

  it('requires an explicit frontend-only scope with exact well-formed bindings', () => {
    const { scope } = positiveInput();
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        scope: { ...scope, frontendOnly: false },
      }).issues,
    ).toEqual(['CLAIM_SCOPE']);
    expect(
      assessProductionClaimCompleteness({ ...positiveInput(), scope: { ...scope, extra: 1 } })
        .issues,
    ).toEqual(['CLAIM_SCOPE']);
    expect(
      assessProductionClaimCompleteness({ ...positiveInput(), scope: { ...scope, bindings: [] } })
        .issues,
    ).toEqual(['CLAIM_BINDING']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        scope: { ...scope, bindings: [{ ...scope!.bindings[0]!, capability: 'has a space' }] },
      }).issues,
    ).toEqual(['CLAIM_BINDING']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        scope: {
          ...scope,
          bindings: [{ ...scope!.bindings[0]!, correctnessPolicyFingerprint: 'not-a-digest' }],
        },
      }).issues,
    ).toEqual(['CLAIM_FINGERPRINT']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        scope: { ...scope, bindings: [...scope!.bindings, { ...scope!.bindings[0]! }] },
      }).issues,
    ).toEqual(['CLAIM_BINDING_DUPLICATE']);
  });

  it('requires every declared coverage dimension and a non-vacuous coverage declaration', () => {
    const { coverage } = positiveInput();
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        coverage: { ...coverage, transitions: undefined },
      }).issues,
    ).toEqual(['CLAIM_COVERAGE']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        coverage: { scenarios: [], variants: [], partitions: [], transitions: [], obligations: [] },
      }).issues,
    ).toEqual(['CLAIM_COVERAGE']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        coverage: { ...coverage, scenarios: ['not a reference'] },
      }).issues,
    ).toEqual(['CLAIM_COVERAGE']);
  });

  it('requires a manifest id and fingerprint and accepts a WP1-derived fingerprint', () => {
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        manifest: { manifestId: 'manifest-1', contentFingerprint: 'short' },
      }).issues,
    ).toEqual(['CLAIM_MANIFEST']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        manifest: { manifestId: 'not a reference', contentFingerprint: DIGEST },
      }).issues,
    ).toEqual(['CLAIM_MANIFEST']);

    const content: SelectionManifestContent = {
      schemaVersion: 1,
      bindings: [{ bindingId: 'layer/text#move', modelFingerprint: MODEL_FINGERPRINT }],
      requiredCells: [{ cellId: 'desktop', classification: 'required-credit' }],
      entries: [{ entryId: 'one', bindingId: 'layer/text#move', cellId: 'desktop', order: 0 }],
    };
    const contentFingerprint = deriveSelectionManifestFingerprint(content);
    expect(contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        manifest: { manifestId: 'manifest-1', contentFingerprint },
      }).structurallyComplete,
    ).toBe(true);
  });

  it('requires nonempty required-credit environment cells and never implies unlisted coverage', () => {
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        environment: { cells: [] },
      }).issues,
    ).toEqual(['CLAIM_ENVIRONMENT']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        environment: { cells: [cell({ classification: 'diagnostic-only' })] },
      }).issues,
    ).toEqual(['CLAIM_ENVIRONMENT']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        environment: { cells: [cell({ timezone: undefined })] },
      }).issues,
    ).toEqual(['CLAIM_ENVIRONMENT']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        environment: { cells: [cell({ devicePixelRatio: 0 })] },
      }).issues,
    ).toEqual(['CLAIM_ENVIRONMENT']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        environment: { cells: [CELL, { ...CELL }] },
      }).issues,
    ).toEqual(['CLAIM_ENVIRONMENT']);
  });

  it('requires a well-formed Release Run identity and UTC execution time', () => {
    expect(
      assessProductionClaimCompleteness({ ...positiveInput(), run: undefined }).issues,
    ).toEqual(['CLAIM_RUN_REFERENCE']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        run: { runId: 'release-run-2026-09-24', executedAtUtc: '2026-09-24 00:00:00' },
      }).issues,
    ).toEqual(['CLAIM_RUN_REFERENCE']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        run: { runId: 'release-run-2026-09-24', executedAtUtc: '2026-09-24T00:00:00Z' },
      }).structurallyComplete,
    ).toBe(true);
  });

  it('rejects a syntactically valid but impossible UTC instant', () => {
    const impossible = [
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2025-02-29T00:00:00.000Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T23:60:00Z',
      '2026-01-01T23:59:60Z',
    ];
    for (const executedAtUtc of impossible) {
      const assessment = assessProductionClaimCompleteness({
        ...positiveInput(),
        run: { runId: 'release-run-2026-09-24', executedAtUtc },
      });
      expect(assessment.issues).toEqual(['CLAIM_RUN_REFERENCE']);
      expect(assessment.structurallyComplete).toBe(false);
      expect(assessment.releaseCredit).toBe(false);
    }
    // A real leap-year instant and a nine-digit fractional second remain valid.
    for (const executedAtUtc of ['2024-02-29T00:00:00Z', '2026-12-31T23:59:59.123456789Z']) {
      expect(
        assessProductionClaimCompleteness({
          ...positiveInput(),
          run: { runId: 'release-run-2026-09-24', executedAtUtc },
        }).structurallyComplete,
      ).toBe(true);
    }
  });

  it('requires explicit exclusions, known gaps, and a closed held/stale status', () => {
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        exclusions: { exclusions: [], knownGaps: [], status: 'pending' },
      }).issues,
    ).toEqual(['CLAIM_EXCLUSIONS']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        exclusions: { exclusions: [], knownGaps: undefined, status: 'current' },
      }).issues,
    ).toEqual(['CLAIM_EXCLUSIONS']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        exclusions: {
          exclusions: ['excluded: safari'],
          knownGaps: ['no mobile cell'],
          status: 'held',
        },
      }).structurallyComplete,
    ).toBe(true);
  });

  it('refuses a malformed or duplicated external approval reference and never authenticates one', () => {
    expect(assessProductionClaimCompleteness({ ...positiveInput(), approvals: [] }).issues).toEqual(
      ['CLAIM_APPROVAL_REFERENCE'],
    );
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        approvals: [{ ...HYPOTHETICAL_APPROVAL, digest: 'pending' }],
      }).issues,
    ).toEqual(['CLAIM_APPROVAL_REFERENCE']);
    expect(
      assessProductionClaimCompleteness({
        ...positiveInput(),
        approvals: [HYPOTHETICAL_APPROVAL, { ...HYPOTHETICAL_APPROVAL, reference: 'second' }],
      }).issues,
    ).toEqual(['CLAIM_APPROVAL_REFERENCE']);

    // Two distinct well-formed untrusted references are structurally complete but never approval.
    const assessment = assessProductionClaimCompleteness({
      ...positiveInput(),
      approvals: [
        HYPOTHETICAL_APPROVAL,
        { ...HYPOTHETICAL_APPROVAL, role: 'tester-verification-owner', reference: 'second' },
      ],
    });
    expect(assessment.structurallyComplete).toBe(true);
    expect(assessment.approvalAuthenticated).toBe(false);
  });

  it('closes the shape, fails safe on hostile input, and mutates nothing', () => {
    expect(assessProductionClaimCompleteness({ ...positiveInput(), releaseCredit: true })).toEqual({
      structurallyComplete: false,
      issues: ['CLAIM_SHAPE'],
      approvalAuthenticated: false,
      rendered: false,
      published: false,
      releaseCredit: false,
    });
    expect(assessProductionClaimCompleteness({ ...positiveInput(), unexpected: 1 }).issues).toEqual(
      ['CLAIM_SHAPE'],
    );
    expect(assessProductionClaimCompleteness(null).issues).toEqual(['CLAIM_SHAPE']);
    expect(assessProductionClaimCompleteness(null).structurallyComplete).toBe(false);

    const cyclic: Record<string, unknown> = { ...positiveInput() };
    cyclic.self = cyclic;
    expect(() => assessProductionClaimCompleteness(cyclic)).not.toThrow();
    expect(assessProductionClaimCompleteness(cyclic).structurallyComplete).toBe(false);

    const hostile = Object.defineProperty({}, 'schemaVersion', {
      get() {
        throw new Error('hostile');
      },
      enumerable: true,
    });
    expect(() => assessProductionClaimCompleteness(hostile)).not.toThrow();
    expect(assessProductionClaimCompleteness(hostile).issues).toEqual(['CLAIM_SHAPE']);

    // Frozen input: a write attempt would throw in strict mode; nothing changes.
    const frozen = deepFreeze(positiveInput());
    const before = JSON.stringify(frozen);
    const first = assessProductionClaimCompleteness(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(first).toEqual(assessProductionClaimCompleteness(positiveInput()));

    const frozenInvalid = deepFreeze({
      ...positiveInput(),
      environment: { cells: [cell({ classification: 'excluded-with-reason' })] },
    });
    const invalidBefore = JSON.stringify(frozenInvalid);
    expect(assessProductionClaimCompleteness(frozenInvalid).structurallyComplete).toBe(false);
    expect(JSON.stringify(frozenInvalid)).toBe(invalidBefore);
  });

  it('exposes no renderer, publisher, authenticator, or credit surface', () => {
    expect(Object.keys(claimGovernance).sort()).toEqual(['assessProductionClaimCompleteness']);
    expect(Object.keys(claimContract).sort()).toEqual([
      'CLAIM_STATUSES',
      'PRODUCTION_CLAIM_ISSUE_CODES',
      'PRODUCTION_CLAIM_SCHEMA_VERSION',
    ]);
  });

  it('consumes WP1 identity and WP2 hypothetical Gate-F input without conferring credit anywhere', () => {
    const content: SelectionManifestContent = {
      schemaVersion: 1,
      bindings: [{ bindingId: 'layer/text#move', modelFingerprint: MODEL_FINGERPRINT }],
      requiredCells: [{ cellId: 'desktop', classification: 'required-credit' }],
      entries: [{ entryId: 'one', bindingId: 'layer/text#move', cellId: 'desktop', order: 0 }],
    };
    const contentFingerprint = deriveSelectionManifestFingerprint(content);

    const requiredEntries: ReleaseRequiredEntry[] = [
      { entryId: 'one', cellId: 'desktop', order: 0 },
    ];
    const work: ReleaseWorkRecord[] = requiredEntries.map((entry) => ({
      ...entry,
      attempt: 1,
      skipped: false,
      replaced: false,
      outcome: 'PASS' as const,
      evidence: {
        evidenceId: `evidence-${entry.entryId}`,
        digest: DIGEST,
        complete: true,
        valid: true,
      },
    }));
    const releaseInput: ReleaseAssessmentInput = {
      schemaVersion: 1,
      gateF: HYPOTHETICAL_GATE_F,
      expectedManifest: { manifestId: 'manifest-1', contentFingerprint },
      activeManifest: {
        manifestId: 'manifest-1',
        contentFingerprint,
        state: 'ACTIVE',
        revision: 4,
      },
      requiredEntries,
      work,
      cleanup: { succeeded: true },
    };

    const release = assessReleaseCredit(releaseInput);
    expect(release.eligible).toBe(true);
    expect(release.releaseCredit).toBe(false);

    const claim = assessProductionClaimCompleteness({
      ...positiveInput(),
      manifest: { manifestId: 'manifest-1', contentFingerprint },
    });
    expect(claim.structurallyComplete).toBe(true);
    expect(claim.approvalAuthenticated).toBe(false);
    expect(claim.rendered).toBe(false);
    expect(claim.published).toBe(false);
    expect(claim.releaseCredit).toBe(false);
  });
});
