import { describe, expect, it } from 'vitest';

import type {
  ReleaseAssessmentInput,
  ReleaseRequiredEntry,
  ReleaseWorkRecord,
} from '../../src/contracts/release-credit';
import { assessReleaseCredit } from '../../src/governance/release-credit';

const FINGERPRINT = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

const REQUIRED_ENTRIES: ReleaseRequiredEntry[] = [
  { entryId: 'one', cellId: 'desktop', order: 0 },
  { entryId: 'two', cellId: 'desktop', order: 1 },
];

function workRecords(): ReleaseWorkRecord[] {
  return REQUIRED_ENTRIES.map((entry) => ({
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
}

/** Fully synthetic all-positive input: every static predicate happens to pass. */
function positiveInput(): ReleaseAssessmentInput {
  return {
    schemaVersion: 1,
    gateF: { accepted: true, integrity: 'complete' },
    expectedManifest: { manifestId: 'manifest-1', contentFingerprint: FINGERPRINT },
    activeManifest: {
      manifestId: 'manifest-1',
      contentFingerprint: FINGERPRINT,
      state: 'ACTIVE',
      revision: 4,
    },
    requiredEntries: REQUIRED_ENTRIES,
    work: workRecords(),
    cleanup: { succeeded: true },
  };
}

function withWork(work: ReleaseWorkRecord[]): ReleaseAssessmentInput {
  return { ...positiveInput(), work };
}

describe('Gate-G static Release-credit assessment (never grants credit)', () => {
  it('passes every static predicate for an all-positive hypothetical yet returns no credit', () => {
    expect(assessReleaseCredit(positiveInput())).toEqual({
      eligible: true,
      issues: [],
      releaseCredit: false,
    });
    // The caller-supplied Gate-F acceptance label is untrusted: it never grants credit.
    const assessment = assessReleaseCredit(positiveInput());
    expect(assessment.releaseCredit).toBe(false);
    expect(JSON.stringify(assessment)).toContain('"releaseCredit":false');
  });

  it('denies missing, unaccepted, or incomplete Gate-F integrity', () => {
    expect(assessReleaseCredit({ ...positiveInput(), gateF: undefined }).issues).toContain(
      'RELEASE_GATE_F',
    );
    expect(
      assessReleaseCredit({
        ...positiveInput(),
        gateF: { accepted: false, integrity: 'complete' },
      }).issues,
    ).toContain('RELEASE_GATE_F');
    expect(
      assessReleaseCredit({
        ...positiveInput(),
        gateF: { accepted: true, integrity: 'incomplete' },
      }).issues,
    ).toContain('RELEASE_GATE_F_INTEGRITY');
    expect(
      assessReleaseCredit({ ...positiveInput(), gateF: { accepted: true, integrity: 'invalid' } })
        .issues,
    ).toContain('RELEASE_GATE_F_INTEGRITY');
  });

  it('denies manifest drift, non-active manifests, and missing manifest identity', () => {
    expect(
      assessReleaseCredit({
        ...positiveInput(),
        activeManifest: {
          manifestId: 'manifest-1',
          contentFingerprint: 'c'.repeat(64),
          state: 'ACTIVE',
          revision: 4,
        },
      }).issues,
    ).toContain('RELEASE_MANIFEST_DRIFT');
    expect(
      assessReleaseCredit({
        ...positiveInput(),
        activeManifest: {
          manifestId: 'manifest-1',
          contentFingerprint: FINGERPRINT,
          state: 'APPROVED_FROZEN',
          revision: 4,
        },
      }).issues,
    ).toContain('RELEASE_MANIFEST_STATE');
    expect(
      assessReleaseCredit({ ...positiveInput(), expectedManifest: undefined }).issues,
    ).toContain('RELEASE_MANIFEST');
  });

  it('denies missing, duplicate, skipped, retried, replaced, reordered, and non-PASS work', () => {
    const work = workRecords();
    expect(assessReleaseCredit(withWork([work[0]!])).issues).toContain('RELEASE_EXECUTION_MISSING');
    expect(assessReleaseCredit(withWork([work[0]!, { ...work[0]! }, work[1]!])).issues).toContain(
      'RELEASE_EXECUTION_DUPLICATE',
    );
    expect(
      assessReleaseCredit(withWork([{ ...work[0]!, skipped: true }, work[1]!])).issues,
    ).toContain('RELEASE_EXECUTION_SKIPPED');
    expect(assessReleaseCredit(withWork([{ ...work[0]!, attempt: 2 }, work[1]!])).issues).toContain(
      'RELEASE_EXECUTION_RETRIED',
    );
    expect(
      assessReleaseCredit(withWork([{ ...work[0]!, replaced: true }, work[1]!])).issues,
    ).toContain('RELEASE_EXECUTION_REPLACED');
    expect(assessReleaseCredit(withWork([work[1]!, work[0]!])).issues).toContain(
      'RELEASE_EXECUTION_ORDER',
    );
    expect(
      assessReleaseCredit(withWork([{ ...work[0]!, outcome: 'HARNESS_BLOCKED' }, work[1]!])).issues,
    ).toContain('RELEASE_RESULT');
  });

  it('denies a contradictory numeric order even when the entry/cell pair sequence matches', () => {
    const work = workRecords();
    // Identical entry/cell pair sequence, but the observed numeric order contradicts it.
    const swappedObservedOrder = [
      { ...work[0]!, order: work[1]!.order },
      { ...work[1]!, order: work[0]!.order },
    ];
    const swapped = assessReleaseCredit(withWork(swappedObservedOrder));
    expect(swapped.issues).toContain('RELEASE_EXECUTION_ORDER');
    expect(swapped.eligible).toBe(false);
    expect(swapped.releaseCredit).toBe(false);

    const offsetObservedOrder = [
      { ...work[0]!, order: 0 },
      { ...work[1]!, order: 7 },
    ];
    expect(assessReleaseCredit(withWork(offsetObservedOrder)).issues).toContain(
      'RELEASE_EXECUTION_ORDER',
    );

    // A required sequence whose declared order is not its canonical position is
    // itself contradictory: it cannot be eligible even when observed matches it.
    const nonCanonicalRequired: ReleaseRequiredEntry[] = [
      { entryId: 'one', cellId: 'desktop', order: 1 },
      { entryId: 'two', cellId: 'desktop', order: 0 },
    ];
    const matchedWork = nonCanonicalRequired.map((entry) => ({
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
    const nonCanonical = assessReleaseCredit({
      ...positiveInput(),
      requiredEntries: nonCanonicalRequired,
      work: matchedWork,
    });
    expect(nonCanonical.issues).toContain('RELEASE_EXECUTION_ORDER');
    expect(nonCanonical.eligible).toBe(false);
    expect(nonCanonical.releaseCredit).toBe(false);
  });

  it('denies incomplete or invalid evidence and failed or missing cleanup', () => {
    const work = workRecords();
    expect(
      assessReleaseCredit(
        withWork([{ ...work[0]!, evidence: { ...work[0]!.evidence, complete: false } }, work[1]!]),
      ).issues,
    ).toContain('RELEASE_EVIDENCE');
    expect(
      assessReleaseCredit(
        withWork([{ ...work[0]!, evidence: { ...work[0]!.evidence, valid: false } }, work[1]!]),
      ).issues,
    ).toContain('RELEASE_EVIDENCE');
    expect(
      assessReleaseCredit(
        withWork([
          { ...work[0]!, evidence: { ...work[0]!.evidence, digest: 'not-a-digest' } },
          work[1]!,
        ]),
      ).issues,
    ).toContain('RELEASE_EVIDENCE');
    expect(
      assessReleaseCredit({ ...positiveInput(), cleanup: { succeeded: false } }).issues,
    ).toContain('RELEASE_CLEANUP');
    expect(assessReleaseCredit({ ...positiveInput(), cleanup: undefined }).issues).toContain(
      'RELEASE_CLEANUP',
    );
  });

  it('never lets a later Diagnostic PASS repair a prior Release failure', () => {
    const failed = withWork([{ ...workRecords()[0]!, outcome: 'BUG' }, workRecords()[1]!]);
    expect(assessReleaseCredit(failed).eligible).toBe(false);
    expect(assessReleaseCredit(failed).issues).toContain('RELEASE_RESULT');

    const repairAttempt = {
      ...failed,
      diagnosticPass: { runId: 'diagnostic-run-1' },
    };
    const repaired = assessReleaseCredit(repairAttempt);
    expect(repaired.issues).toContain('RELEASE_DIAGNOSTIC_PASS');
    expect(repaired.eligible).toBe(false);
    expect(repaired.releaseCredit).toBe(false);

    // Even an otherwise all-PASS assessment cannot be rescued by diagnostic evidence.
    const allPassWithDiagnostic = assessReleaseCredit({
      ...positiveInput(),
      diagnosticPass: { runId: 'diagnostic-run-2' },
    });
    expect(allPassWithDiagnostic.issues).toContain('RELEASE_DIAGNOSTIC_PASS');
    expect(allPassWithDiagnostic.eligible).toBe(false);
    expect(allPassWithDiagnostic.releaseCredit).toBe(false);
  });

  it('denies closed-shape violations and hostile input without granting credit', () => {
    expect(assessReleaseCredit({ ...positiveInput(), releaseCredit: true })).toEqual({
      eligible: false,
      issues: ['RELEASE_SHAPE'],
      releaseCredit: false,
    });
    expect(assessReleaseCredit({ ...positiveInput(), unexpected: 1 }).issues).toContain(
      'RELEASE_SHAPE',
    );
    expect(assessReleaseCredit(null).issues).toContain('RELEASE_SHAPE');
    expect(assessReleaseCredit(null).releaseCredit).toBe(false);

    const cyclic: Record<string, unknown> = { ...positiveInput() };
    cyclic.self = cyclic;
    expect(() => assessReleaseCredit(cyclic)).not.toThrow();
    expect(assessReleaseCredit(cyclic).eligible).toBe(false);

    const hostile = Object.defineProperty({}, 'schemaVersion', {
      get() {
        throw new Error('hostile');
      },
      enumerable: true,
    });
    expect(() => assessReleaseCredit(hostile)).not.toThrow();
    expect(assessReleaseCredit(hostile).issues).toContain('RELEASE_SHAPE');
  });
});
