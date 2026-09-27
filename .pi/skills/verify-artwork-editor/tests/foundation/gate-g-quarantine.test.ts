import { describe, expect, it } from 'vitest';

import * as quarantineContract from '../../src/contracts/quarantine';
import { QUARANTINE_FINAL_APPROVAL_AUTHORITY } from '../../src/contracts/quarantine';
import type { ObligationRef } from '../../src/contracts/quarantine';
import * as quarantineGovernance from '../../src/governance/quarantine';
import {
  assessReinstatementProposal,
  assessReplacementProposal,
  createQuarantineProposal,
} from '../../src/governance/quarantine';

/**
 * Gate-G static quarantine/replacement/reinstatement assessment (ADR 0055,
 * production specification §13.5, §13.8, §13.10, §16).
 *
 * These tests prove the seam is pure, immutable, non-mutating, no-throw, and
 * no-credit: even a fully positive-shaped proposal leaves its obligation
 * unresolved with `releaseCredit: false`, and it never quarantines, admits,
 * reinstates, approves, narrows scope, mutates history, or repairs a run.
 */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const F = 'f'.repeat(64);

const OBLIGATION: ObligationRef = {
  obligationId: 'obl-1',
  manifestId: 'manifest-1',
  contentFingerprint: A,
};

const LOST_A: ObligationRef = {
  obligationId: 'lost-a',
  manifestId: 'manifest-1',
  contentFingerprint: A,
};
const LOST_B: ObligationRef = {
  obligationId: 'lost-b',
  manifestId: 'manifest-1',
  contentFingerprint: A,
};
const REPL_A: ObligationRef = {
  obligationId: 'repl-a',
  manifestId: 'manifest-2',
  contentFingerprint: D,
};
const REPL_B: ObligationRef = {
  obligationId: 'repl-b',
  manifestId: 'manifest-2',
  contentFingerprint: D,
};

function quarantineInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-1',
    manifest: { manifestId: 'manifest-1', contentFingerprint: A },
    fingerprint: A,
    affectedObligation: OBLIGATION,
    evidence: [
      {
        evidenceId: 'ev-1',
        executionInstanceId: 'instance-1',
        digest: B,
        outcome: 'BUG',
        obligation: OBLIGATION,
      },
      {
        evidenceId: 'ev-2',
        executionInstanceId: 'instance-2',
        digest: C,
        outcome: 'PASS',
        obligation: OBLIGATION,
      },
    ],
    proposedAtUtc: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function replacementInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-2',
    quarantineReference: 'quarantine-1',
    lostObligations: [LOST_A, LOST_B],
    replacementManifest: { manifestId: 'manifest-2', contentFingerprint: D },
    qualification: {
      batchId: 'batch-1',
      manifestId: 'manifest-2',
      contentFingerprint: D,
      admitted: true,
    },
    mapping: [
      { lostObligation: LOST_A, replacementObligation: REPL_A },
      { lostObligation: LOST_B, replacementObligation: REPL_B },
    ],
    approvals: [{ authority: 'PRODUCT_OWNER', reference: 'approval-1', digest: E }],
    ...overrides,
  };
}

function reinstatementInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-3',
    quarantineReference: 'quarantine-1',
    affectedObligation: OBLIGATION,
    cause: 'observed contradictory comparable outcomes',
    correction: 'fixed the race in the shared serialize step',
    nonWeakeningProof: [{ evidenceId: 'proof-1', digest: F, complete: true, valid: true }],
    qualification: {
      batchId: 'batch-2',
      manifestId: 'manifest-2',
      contentFingerprint: D,
      admitted: true,
    },
    manifest: { manifestId: 'manifest-2', contentFingerprint: D },
    releaseRun: {
      runId: 'run-1',
      executedAtUtc: '2026-02-01T00:00:00Z',
      outcome: 'PASS',
      complete: true,
      manifest: { manifestId: 'manifest-2', contentFingerprint: D },
    },
    approvals: [{ authority: 'PRODUCT_OWNER', reference: 'approval-2', digest: E }],
    proposedAtUtc: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Gate-G quarantine static assessment (never grants credit)', () => {
  it('accepts a positive-shaped contradictory instability pair but keeps the obligation unresolved', () => {
    const assessment = createQuarantineProposal(quarantineInput());
    expect(assessment.valid).toBe(true);
    expect(assessment.decision).toBe('QUARANTINE_PROPOSED');
    expect(assessment.issues).toEqual([]);
    expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
    expect(assessment.releaseCredit).toBe(false);
  });

  it('fails closed on repeated, same-outcome, duplicate-execution, and noncomparable evidence', () => {
    const sameOutcome = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-2',
          executionInstanceId: 'instance-2',
          digest: C,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
      ],
    });
    expect(createQuarantineProposal(sameOutcome).issues).toContain('QUARANTINE_INSTABILITY');

    const duplicateExecution = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-2',
          executionInstanceId: 'instance-1',
          digest: C,
          outcome: 'PASS',
          obligation: OBLIGATION,
        },
      ],
    });
    expect(createQuarantineProposal(duplicateExecution).issues).toContain('QUARANTINE_INSTABILITY');

    const crossObligation = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-2',
          executionInstanceId: 'instance-2',
          digest: C,
          outcome: 'PASS',
          obligation: { obligationId: 'other', manifestId: 'manifest-1', contentFingerprint: A },
        },
      ],
    });
    expect(createQuarantineProposal(crossObligation).issues).toContain('QUARANTINE_INSTABILITY');

    const crossFingerprint = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-2',
          executionInstanceId: 'instance-2',
          digest: C,
          outcome: 'PASS',
          obligation: { obligationId: 'obl-1', manifestId: 'manifest-1', contentFingerprint: D },
        },
      ],
    });
    expect(createQuarantineProposal(crossFingerprint).issues).toContain('QUARANTINE_INSTABILITY');

    const single = quarantineInput({ evidence: [quarantineInput().evidence[0]] });
    expect(createQuarantineProposal(single).issues).toContain('QUARANTINE_EVIDENCE');

    const badOutcome = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BOGUS',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-2',
          executionInstanceId: 'instance-2',
          digest: C,
          outcome: 'PASS',
          obligation: OBLIGATION,
        },
      ],
    });
    expect(createQuarantineProposal(badOutcome).issues).toContain('QUARANTINE_EVIDENCE');

    for (const input of [
      sameOutcome,
      duplicateExecution,
      crossObligation,
      crossFingerprint,
      single,
      badOutcome,
    ]) {
      const assessment = createQuarantineProposal(input);
      expect(assessment.valid).toBe(false);
      expect(assessment.releaseCredit).toBe(false);
      expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
    }
  });

  it('fails closed on reused evidence identity, digest, or both even with distinct executions', () => {
    const reusedEvidenceId = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-2',
          digest: C,
          outcome: 'PASS',
          obligation: OBLIGATION,
        },
      ],
    });
    const reusedDigest = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-2',
          executionInstanceId: 'instance-2',
          digest: B,
          outcome: 'PASS',
          obligation: OBLIGATION,
        },
      ],
    });
    const reusedEvidenceIdAndDigest = quarantineInput({
      evidence: [
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-1',
          digest: B,
          outcome: 'BUG',
          obligation: OBLIGATION,
        },
        {
          evidenceId: 'ev-1',
          executionInstanceId: 'instance-2',
          digest: B,
          outcome: 'PASS',
          obligation: OBLIGATION,
        },
      ],
    });

    for (const input of [reusedEvidenceId, reusedDigest, reusedEvidenceIdAndDigest]) {
      const assessment = createQuarantineProposal(input);
      expect(assessment.issues).toContain('QUARANTINE_INSTABILITY');
      expect(assessment.valid).toBe(false);
      expect(assessment.decision).toBe('QUARANTINE_REJECTED');
      expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
      expect(assessment.releaseCredit).toBe(false);
    }
  });

  it('retains the parseable affected obligation when the root envelope has an unknown key', () => {
    const input = quarantineInput({ extra: 'surprise' });
    expect(() => createQuarantineProposal(input)).not.toThrow();
    const assessment = createQuarantineProposal(input);
    expect(assessment.issues).toContain('QUARANTINE_SHAPE');
    expect(assessment.valid).toBe(false);
    expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
    expect(assessment.releaseCredit).toBe(false);
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.unresolvedObligations)).toBe(true);
  });

  it('fails closed on bad shape, version, reference identity, fingerprint, obligation, and timing', () => {
    expect(createQuarantineProposal(quarantineInput({ extra: 'surprise' })).issues).toContain(
      'QUARANTINE_SHAPE',
    );
    expect(createQuarantineProposal(quarantineInput({ schemaVersion: 2 })).issues).toContain(
      'QUARANTINE_SCHEMA',
    );
    for (const proposalId of ['', 42, 'x'.repeat(257)]) {
      expect(createQuarantineProposal(quarantineInput({ proposalId })).issues).toContain(
        'QUARANTINE_IDENTITY',
      );
    }
    expect(createQuarantineProposal(quarantineInput({ fingerprint: B })).issues).toContain(
      'QUARANTINE_FINGERPRINT',
    );
    expect(
      createQuarantineProposal(
        quarantineInput({ affectedObligation: { ...OBLIGATION, contentFingerprint: D } }),
      ).issues,
    ).toContain('QUARANTINE_OBLIGATION');
    expect(
      createQuarantineProposal(quarantineInput({ proposedAtUtc: '2026-02-30T00:00:00Z' })).issues,
    ).toContain('QUARANTINE_TIMING');

    for (const value of [null, undefined, 7, 'text', []]) {
      expect(() => createQuarantineProposal(value)).not.toThrow();
      const assessment = createQuarantineProposal(value);
      expect(assessment.valid).toBe(false);
      expect(assessment.issues).toContain('QUARANTINE_SHAPE');
      expect(assessment.unresolvedObligations).toEqual([]);
      expect(assessment.releaseCredit).toBe(false);
    }
  });

  it('is deterministic, non-mutating, and deeply immutable', () => {
    const input = quarantineInput();
    const before = JSON.stringify(input);
    const first = createQuarantineProposal(input);
    const second = createQuarantineProposal(quarantineInput());
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);

    const evidence = [
      {
        evidenceId: 'ev-1',
        executionInstanceId: 'instance-1',
        digest: B,
        outcome: 'BUG',
        obligation: { obligationId: 'obl-1', manifestId: 'manifest-1', contentFingerprint: A },
      },
      {
        evidenceId: 'ev-2',
        executionInstanceId: 'instance-2',
        digest: C,
        outcome: 'PASS',
        obligation: { obligationId: 'obl-1', manifestId: 'manifest-1', contentFingerprint: A },
      },
    ];
    const assessment = createQuarantineProposal(quarantineInput({ evidence }));
    const snapshot = JSON.stringify(assessment);
    evidence[0]!.outcome = 'PASS';
    evidence[0]!.obligation.obligationId = 'mutated';
    expect(JSON.stringify(assessment)).toBe(snapshot);
    // The assessment owns its copies: it never aliases a caller obligation.
    expect(assessment.unresolvedObligations[0]).not.toBe(OBLIGATION);

    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.issues)).toBe(true);
    expect(Object.isFrozen(assessment.unresolvedObligations)).toBe(true);
    expect(Object.isFrozen(assessment.unresolvedObligations[0])).toBe(true);
    expect(Reflect.set(assessment, 'releaseCredit', true)).toBe(false);
    expect(Reflect.set(assessment.unresolvedObligations[0]!, 'obligationId', 'changed')).toBe(
      false,
    );
  });

  it('exposes no apply, append, filter, retry, or credit surface', () => {
    expect(Object.keys(quarantineGovernance).sort()).toEqual([
      'assessReinstatementProposal',
      'assessReplacementProposal',
      'createQuarantineProposal',
    ]);
    expect(Object.keys(quarantineContract).sort()).toEqual([
      'QUARANTINE_DECISIONS',
      'QUARANTINE_FINAL_APPROVAL_AUTHORITY',
      'QUARANTINE_ISSUE_CODES',
      'QUARANTINE_OUTCOMES',
      'QUARANTINE_SCHEMA_VERSION',
      'REINSTATEMENT_DECISIONS',
      'REPLACEMENT_DECISIONS',
    ]);
  });
});

describe('Gate-G replacement mapping (never discharges a lost obligation)', () => {
  it('accepts an exact one-to-one lost→replacement mapping without resolving anything', () => {
    const assessment = assessReplacementProposal(replacementInput());
    expect(assessment.valid).toBe(true);
    expect(assessment.decision).toBe('REPLACEMENT_PROPOSED');
    expect(assessment.issues).toEqual([]);
    expect(assessment.unresolvedObligations).toEqual([LOST_A, LOST_B]);
    expect(assessment.releaseCredit).toBe(false);
  });

  it('fails closed on missing, extra, duplicate, and inconsistent mapping endpoints', () => {
    const missingSource = replacementInput({
      mapping: [{ lostObligation: LOST_A, replacementObligation: REPL_A }],
    });
    const extraSource = replacementInput({
      mapping: [
        { lostObligation: LOST_A, replacementObligation: REPL_A },
        { lostObligation: LOST_B, replacementObligation: REPL_B },
        {
          lostObligation: {
            obligationId: 'unknown',
            manifestId: 'manifest-1',
            contentFingerprint: A,
          },
          replacementObligation: {
            obligationId: 'repl-c',
            manifestId: 'manifest-2',
            contentFingerprint: D,
          },
        },
      ],
    });
    const duplicateSource = replacementInput({
      mapping: [
        { lostObligation: LOST_A, replacementObligation: REPL_A },
        { lostObligation: LOST_A, replacementObligation: REPL_B },
      ],
    });
    const duplicateTarget = replacementInput({
      mapping: [
        { lostObligation: LOST_A, replacementObligation: REPL_A },
        { lostObligation: LOST_B, replacementObligation: REPL_A },
      ],
    });
    const inconsistent = replacementInput({
      mapping: [
        { lostObligation: { ...LOST_A, contentFingerprint: D }, replacementObligation: REPL_A },
        { lostObligation: LOST_B, replacementObligation: REPL_B },
      ],
    });
    const wrongManifest = replacementInput({
      mapping: [
        { lostObligation: LOST_A, replacementObligation: { ...REPL_A, manifestId: 'manifest-9' } },
        { lostObligation: LOST_B, replacementObligation: REPL_B },
      ],
    });

    for (const input of [
      missingSource,
      extraSource,
      duplicateSource,
      duplicateTarget,
      inconsistent,
      wrongManifest,
    ]) {
      const assessment = assessReplacementProposal(input);
      expect(assessment.issues).toContain('QUARANTINE_MAPPING');
      expect(assessment.valid).toBe(false);
      expect(assessment.releaseCredit).toBe(false);
      expect(assessment.unresolvedObligations).toEqual([LOST_A, LOST_B]);
    }

    expect(assessReplacementProposal(replacementInput({ lostObligations: [] })).issues).toContain(
      'QUARANTINE_OBLIGATION',
    );
    expect(
      assessReplacementProposal(replacementInput({ lostObligations: [LOST_A, LOST_A] })).issues,
    ).toContain('QUARANTINE_OBLIGATION');
  });

  it('retains every parseable lost obligation when the root envelope has an unknown key', () => {
    const unknownKey = replacementInput({ extra: 'surprise' });
    expect(() => assessReplacementProposal(unknownKey)).not.toThrow();
    const assessment = assessReplacementProposal(unknownKey);
    expect(assessment.issues).toContain('QUARANTINE_SHAPE');
    expect(assessment.valid).toBe(false);
    expect(assessment.unresolvedObligations).toEqual([LOST_A, LOST_B]);
    expect(assessment.releaseCredit).toBe(false);
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.unresolvedObligations)).toBe(true);

    // Unparseable references are never inferred; parseable ones are never dropped.
    const mixedLost = assessReplacementProposal({
      ...replacementInput({ extra: 'surprise' }),
      lostObligations: [LOST_A, { obligationId: 'broken' }, LOST_B],
    });
    expect(mixedLost.issues).toContain('QUARANTINE_SHAPE');
    expect(mixedLost.issues).toContain('QUARANTINE_OBLIGATION');
    expect(mixedLost.unresolvedObligations).toEqual([LOST_A, LOST_B]);
    expect(mixedLost.releaseCredit).toBe(false);
  });

  it('fails closed on a false or malformed qualification/admission reference', () => {
    const admittedFalse = replacementInput({
      qualification: {
        batchId: 'batch-1',
        manifestId: 'manifest-2',
        contentFingerprint: D,
        admitted: false,
      },
    });
    const malformed = replacementInput({
      qualification: {
        batchId: 'batch-1',
        manifestId: 'manifest-2',
        contentFingerprint: D,
        admitted: 'yes',
      },
    });
    const wrongManifest = replacementInput({
      qualification: {
        batchId: 'batch-1',
        manifestId: 'manifest-9',
        contentFingerprint: D,
        admitted: true,
      },
    });

    for (const input of [
      replacementInput({ qualification: undefined }),
      admittedFalse,
      malformed,
      wrongManifest,
    ]) {
      const assessment = assessReplacementProposal(input);
      expect(assessment.issues).toContain('QUARANTINE_QUALIFICATION');
      expect(assessment.valid).toBe(false);
      expect(assessment.unresolvedObligations).toEqual([LOST_A, LOST_B]);
      expect(assessment.releaseCredit).toBe(false);
    }
  });

  it('requires the action-scoped final approval reference without a rigid four-role matrix', () => {
    expect(QUARANTINE_FINAL_APPROVAL_AUTHORITY).toBe('PRODUCT_OWNER');
    expect(assessReplacementProposal(replacementInput({ approvals: undefined })).issues).toContain(
      'QUARANTINE_APPROVAL',
    );
    const wrongAuthority = replacementInput({
      approvals: [{ authority: 'VERIFICATION', reference: 'approval-1', digest: E }],
    });
    expect(assessReplacementProposal(wrongAuthority).issues).toContain('QUARANTINE_APPROVAL');
    const malformed = replacementInput({
      approvals: [{ authority: 'PRODUCT_OWNER', reference: 'approval-1', digest: 'nope' }],
    });
    expect(assessReplacementProposal(malformed).issues).toContain('QUARANTINE_APPROVAL');
    expect(assessReplacementProposal(replacementInput()).valid).toBe(true);
  });
});

describe('Gate-G reinstatement assessment (never applied, never credited)', () => {
  it('accepts a plausible reinstatement shape yet keeps the obligation unresolved and uncredited', () => {
    const assessment = assessReinstatementProposal(reinstatementInput());
    expect(assessment.valid).toBe(true);
    expect(assessment.decision).toBe('REINSTATEMENT_PROPOSED');
    expect(assessment.issues).toEqual([]);
    expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
    expect(assessment.releaseCredit).toBe(false);
  });

  it('fails closed on each absent or wrong required reinstatement dimension', () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ cause: undefined }, 'QUARANTINE_EVIDENCE'],
      [{ cause: '   ' }, 'QUARANTINE_EVIDENCE'],
      [{ correction: undefined }, 'QUARANTINE_EVIDENCE'],
      [{ nonWeakeningProof: [] }, 'QUARANTINE_EVIDENCE'],
      [
        { nonWeakeningProof: [{ evidenceId: 'p', digest: F, complete: false, valid: true }] },
        'QUARANTINE_EVIDENCE',
      ],
      [{ qualification: undefined }, 'QUARANTINE_QUALIFICATION'],
      [{ approvals: undefined }, 'QUARANTINE_APPROVAL'],
      [{ manifest: undefined }, 'QUARANTINE_MANIFEST'],
      [{ manifest: { manifestId: 'manifest-1', contentFingerprint: A } }, 'QUARANTINE_FINGERPRINT'],
      [{ releaseRun: undefined }, 'QUARANTINE_EVIDENCE'],
      [
        { releaseRun: { ...reinstatementInput().releaseRun, outcome: 'BUG' } },
        'QUARANTINE_EVIDENCE',
      ],
      [
        { releaseRun: { ...reinstatementInput().releaseRun, complete: false } },
        'QUARANTINE_EVIDENCE',
      ],
      [
        {
          releaseRun: {
            ...reinstatementInput().releaseRun,
            manifest: { manifestId: 'manifest-2', contentFingerprint: A },
          },
        },
        'QUARANTINE_FINGERPRINT',
      ],
      [
        {
          releaseRun: { ...reinstatementInput().releaseRun, executedAtUtc: '2025-12-31T00:00:00Z' },
        },
        'QUARANTINE_TIMING',
      ],
    ];

    for (const [overrides, code] of cases) {
      const assessment = assessReinstatementProposal(reinstatementInput(overrides));
      expect(assessment.issues, JSON.stringify(overrides)).toContain(code);
      expect(assessment.valid).toBe(false);
      expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
      expect(assessment.releaseCredit).toBe(false);
    }
  });

  it('retains the parseable affected obligation when the root envelope has an unknown key', () => {
    const input = reinstatementInput({ extra: 'surprise' });
    expect(() => assessReinstatementProposal(input)).not.toThrow();
    const assessment = assessReinstatementProposal(input);
    expect(assessment.issues).toContain('QUARANTINE_SHAPE');
    expect(assessment.valid).toBe(false);
    expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
    expect(assessment.releaseCredit).toBe(false);
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.unresolvedObligations)).toBe(true);
  });
});

describe('Gate-G adversarial closure (fails closed, keeps obligations unresolved)', () => {
  it('rejects history/manifest mutation, scope narrowing, promotion, and credit attempts', () => {
    const mutation = createQuarantineProposal(
      quarantineInput({ assertedEffects: { mutatesHistory: true } }),
    );
    expect(mutation.issues).toContain('QUARANTINE_MUTATION');

    const manifestMutation = createQuarantineProposal(
      quarantineInput({ assertedEffects: { mutatesManifest: true } }),
    );
    expect(manifestMutation.issues).toContain('QUARANTINE_MUTATION');

    const narrowing = createQuarantineProposal(
      quarantineInput({ assertedEffects: { narrowsScope: true } }),
    );
    expect(narrowing.issues).toContain('QUARANTINE_SCOPE');

    const omission = createQuarantineProposal(
      quarantineInput({ assertedEffects: { clearsObligations: ['obl-1'] } }),
    );
    expect(omission.issues).toContain('QUARANTINE_SCOPE');

    const promotion = createQuarantineProposal(
      quarantineInput({ assertedEffects: { diagnosticPass: { runId: 'diagnostic-1' } } }),
    );
    expect(promotion.issues).toContain('QUARANTINE_PROMOTION');

    const credit = createQuarantineProposal(
      quarantineInput({ assertedEffects: { grantsReleaseCredit: true } }),
    );
    expect(credit.issues).toContain('QUARANTINE_CREDIT');

    const replacement = assessReplacementProposal(
      replacementInput({ assertedEffects: { grantsReleaseCredit: true, mutatesManifest: true } }),
    );
    expect(replacement.issues).toContain('QUARANTINE_CREDIT');
    expect(replacement.issues).toContain('QUARANTINE_MUTATION');
    expect(replacement.unresolvedObligations).toEqual([LOST_A, LOST_B]);

    const reinstatement = assessReinstatementProposal(
      reinstatementInput({ assertedEffects: { narrowsScope: true } }),
    );
    expect(reinstatement.issues).toContain('QUARANTINE_SCOPE');
    expect(reinstatement.unresolvedObligations).toEqual([OBLIGATION]);

    for (const assessment of [mutation, manifestMutation, narrowing, omission, promotion, credit]) {
      expect(assessment.valid).toBe(false);
      expect(assessment.releaseCredit).toBe(false);
      expect(assessment.unresolvedObligations).toEqual([OBLIGATION]);
      expect(JSON.stringify(assessment)).not.toMatch(/satisfied|admitted|activated|reinstated/i);
    }
  });

  it('never repairs an earlier failure and always reports unresolved obligations with false credit', () => {
    for (const assessment of [
      createQuarantineProposal(quarantineInput()),
      assessReplacementProposal(replacementInput()),
      assessReinstatementProposal(reinstatementInput()),
    ]) {
      expect(assessment.releaseCredit).toBe(false);
      expect(assessment.unresolvedObligations.length).toBeGreaterThan(0);
      expect(Object.isFrozen(assessment.issues)).toBe(true);
      expect(Object.isFrozen(assessment.unresolvedObligations)).toBe(true);
    }
  });
});
