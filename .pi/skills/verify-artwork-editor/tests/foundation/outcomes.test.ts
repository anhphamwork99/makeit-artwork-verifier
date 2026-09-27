import { describe, expect, it } from 'vitest';

import {
  OUTCOMES,
  classifyOutcome,
  isOutcome,
  nonPassIsBlocking,
  nonPassMeaning,
  recomputeAuthoritativeOutcome,
} from '../../src/runtime/outcomes';

const PASSING = [{ checkId: 'geometry.delta', passed: true }];
const FAILING = [{ checkId: 'geometry.delta', passed: false }];

describe('[Gate D/G] four terminal outcomes (TS-1)', () => {
  it('exposes exactly the four accepted terminal outcomes', () => {
    expect(OUTCOMES).toEqual(['PASS', 'BUG', 'HARNESS_BLOCKED', 'ENVIRONMENT_FAILURE']);
    expect(OUTCOMES.every((outcome) => isOutcome(outcome))).toBe(true);
    expect(isOutcome('SKIPPED')).toBe(false);
    expect(isOutcome('FLAKY')).toBe(false);
  });

  it('classifies all required checks passing with successful cleanup as PASS', () => {
    expect(classifyOutcome({ requiredChecks: PASSING, cleanupSucceeded: true })).toBe('PASS');
  });

  it('classifies a trustworthy product mismatch as BUG', () => {
    expect(classifyOutcome({ requiredChecks: FAILING, cleanupSucceeded: true })).toBe('BUG');
  });

  it('classifies conflicting required sources as BUG rather than PASS', () => {
    expect(
      classifyOutcome({
        requiredChecks: PASSING,
        cleanupSucceeded: true,
        requiredSourcesAgree: false,
      }),
    ).toBe('BUG');
  });

  it('never lets cleanup failure produce PASS', () => {
    expect(classifyOutcome({ requiredChecks: PASSING, cleanupSucceeded: false })).toBe(
      'ENVIRONMENT_FAILURE',
    );
    expect(classifyOutcome({ requiredChecks: FAILING, cleanupSucceeded: false })).toBe(
      'ENVIRONMENT_FAILURE',
    );
  });

  it('classifies invalid harness semantics as HARNESS_BLOCKED ahead of product mismatch', () => {
    expect(
      classifyOutcome({ requiredChecks: FAILING, cleanupSucceeded: true, harnessInvalid: true }),
    ).toBe('HARNESS_BLOCKED');
  });

  it('classifies an external runtime failure as ENVIRONMENT_FAILURE', () => {
    expect(
      classifyOutcome({
        requiredChecks: PASSING,
        cleanupSucceeded: true,
        environmentInvalid: true,
      }),
    ).toBe('ENVIRONMENT_FAILURE');
  });

  it('refuses to grant PASS without any authoritative required check', () => {
    expect(classifyOutcome({ requiredChecks: [], cleanupSucceeded: true })).toBe('HARNESS_BLOCKED');
  });

  it('keeps every non-PASS outcome release-blocking but semantically distinct', () => {
    expect(nonPassIsBlocking('PASS')).toBe(false);
    expect(nonPassIsBlocking('BUG')).toBe(true);
    expect(nonPassIsBlocking('HARNESS_BLOCKED')).toBe(true);
    expect(nonPassIsBlocking('ENVIRONMENT_FAILURE')).toBe(true);
    expect(nonPassMeaning('BUG')).toBe('product-defect');
    expect(nonPassMeaning('HARNESS_BLOCKED')).toBe('unavailable-evidence');
    expect(nonPassMeaning('ENVIRONMENT_FAILURE')).toBe('unavailable-evidence');
  });
});

describe('[Gate G] diagnostic depth cannot rescue a terminal outcome (TS-1)', () => {
  it('keeps a failed authoritative check as BUG whatever the diagnostic depth shows', () => {
    expect(
      recomputeAuthoritativeOutcome({
        requiredChecks: FAILING,
        cleanupSucceeded: true,
        diagnosticEvidence: [{ evidenceId: 'deep-trace', passed: true }],
      }),
    ).toBe('BUG');
  });

  it('keeps a passing authoritative check as PASS despite failing diagnostics', () => {
    expect(
      recomputeAuthoritativeOutcome({
        requiredChecks: PASSING,
        cleanupSucceeded: true,
        diagnosticEvidence: [{ evidenceId: 'deep-trace', passed: false }],
      }),
    ).toBe('PASS');
  });

  it('ignores diagnostic-only evidence for every authoritative input combination', () => {
    const inputs = [
      { requiredChecks: PASSING, cleanupSucceeded: true },
      { requiredChecks: FAILING, cleanupSucceeded: true },
      { requiredChecks: PASSING, cleanupSucceeded: false },
      { requiredChecks: PASSING, cleanupSucceeded: true, harnessInvalid: true },
      { requiredChecks: PASSING, cleanupSucceeded: true, environmentInvalid: true },
    ] as const;

    for (const input of inputs) {
      expect(
        recomputeAuthoritativeOutcome({
          ...input,
          diagnosticEvidence: [
            { evidenceId: 'a', passed: true },
            { evidenceId: 'b', passed: false },
          ],
        }),
      ).toBe(classifyOutcome(input));
    }
  });
});
