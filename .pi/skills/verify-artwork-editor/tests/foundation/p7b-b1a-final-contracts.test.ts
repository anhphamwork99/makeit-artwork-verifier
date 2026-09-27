import { describe, expect, it } from 'vitest';

import {
  COMMAND_CHECK_CONTEXTS,
  FINAL_CURRENT_RESULT_SCHEMA_VERSION,
  RUN_RECORD_VERSION_KINDS,
  classifyLegacyCheckResult,
  compileResolvedCorrectnessProfile,
  discriminateRunRecordVersion,
  isCommandCheckContext,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  validateCheckContextSeparation,
  validateCheckResultShape,
  validateCommandCheck,
  validateCurrentResultRecordV4,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  ConsumedCorrectnessComponentFingerprints,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  ResultContractIssue,
} from '../../src/index';

/**
 * P7-B B1-A final result-contract and inactive pure-kernel tests (ADR 0028 §3).
 *
 * These tests exercise only the inactive additive kernel: the completed
 * `CorrectnessCheckResult`, the Action Cycle readiness link, the strict final
 * v4 current DTO discrimination, the legacy/current boundary, command-context
 * separation, and the compiled-profile/result agreement validators. They never
 * launch a browser, write a current record, or touch an active runtime path.
 */

const catalogue = loadCorrectnessCatalogue();
const compiled = compileResolvedCorrectnessProfile({
  catalogue,
  selection: resolveRouteSelection(catalogue, {
    subjectId: 'layer/text',
    capability: 'move',
    variant: 'plain',
  })!,
  declaredChecks: ['geometry.delta'],
});
if (!compiled.ok) throw new Error('The accepted layer/text plain profile must compile.');
const identity = projectCorrectnessProfileIdentity(compiled.profile);
const contract = identity.requiredChecks[0]!;

function hex(char: string): string {
  return char.repeat(64);
}

function consumed(
  overrides: Partial<ConsumedCorrectnessComponentFingerprints> = {},
): ConsumedCorrectnessComponentFingerprints {
  return {
    resolvedProfile: identity.resolvedFingerprint,
    requiredCheckSet: identity.componentFingerprints.requiredCheckSet,
    oracle: identity.componentFingerprints.oracle,
    capture: identity.componentFingerprints.capture,
    tolerances: identity.componentFingerprints.tolerances,
    visuals: identity.componentFingerprints.visuals,
    normalization: identity.componentFingerprints.normalization,
    ...overrides,
  };
}

function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    checkId: contract.checkId,
    status: 'PASS',
    expected: { schema: contract.expectedSchema },
    actual: { schema: contract.actualSchema },
    evidenceIds: [...contract.requiredEvidence],
    toleranceRefs: [...contract.toleranceRefs],
    visualRefs: [...contract.visualRefs],
    normalizationRef: contract.normalizationRef,
    actionCycleRef: 'action-cycle-1',
    consumedComponentFingerprints: consumed(),
    ...overrides,
  };
}

function cycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionCycleId: 'action-cycle-1',
    resolvedProfileFingerprint: identity.resolvedFingerprint,
    readinessFingerprint: identity.componentFingerprints.readiness,
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: FINAL_CURRENT_RESULT_SCHEMA_VERSION,
    resolvedProfileFingerprint: identity.resolvedFingerprint,
    componentFingerprints: identity.componentFingerprints,
    actionCycles: [cycle()],
    requiredChecks: [check()],
    ...overrides,
  };
}

function runAgreement(
  anIdentity: CorrectnessProfileIdentityView,
  actionCycles: unknown,
  requiredChecks: unknown,
) {
  return validateResultIdentityAgreement(anIdentity, {
    actionCycles: actionCycles as readonly ActionCycleCorrectnessIdentity[],
    requiredChecks: requiredChecks as readonly CorrectnessCheckResult[],
  });
}

function codes(validation: { issues: readonly { code: string }[] }): string[] {
  return validation.issues.map((issue) => issue.code);
}

/** Collects the issue codes `validateCheckResultShape` appends to its out-array. */
function shapeCodes(checkLike: unknown): string[] {
  const issues: ResultContractIssue[] = [];
  validateCheckResultShape(checkLike, issues);
  return issues.map((issue) => issue.code);
}

describe('[P7-B B1-A] completed final check contract and identity view', () => {
  it('projects the compiled profile into the exact consumed identity view', () => {
    expect(identity.resolvedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.requiredCheckIds).toEqual([contract.checkId]);
    expect(identity.requiredAuthoritativeEvidence).toEqual([...contract.requiredEvidence]);
    expect(identity.normalization).toEqual({ applicable: false });
  });

  it('accepts a complete, exactly agreeing current v4 record', () => {
    const validation = validateCurrentResultRecordV4(record(), identity);
    expect(validation.kind).toBe('current-v4');
    expect(validation.ok).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it('rejects a missing status with no default', () => {
    const withoutStatus = check();
    delete withoutStatus.status;
    const validation = runAgreement(identity, [cycle()], [withoutStatus]);
    expect(codes(validation)).toContain('RESULT_CHECK_STATUS_MISSING');
    expect(validation.ok).toBe(false);
  });

  it('rejects an unknown status fail-closed', () => {
    const validation = runAgreement(identity, [cycle()], [check({ status: 'passed' })]);
    expect(codes(validation)).toContain('RESULT_CHECK_STATUS_UNKNOWN');
  });

  it('rejects an absent consumed component fingerprint object', () => {
    const validation = runAgreement(
      identity,
      [cycle()],
      [check({ consumedComponentFingerprints: undefined })],
    );
    expect(codes(validation)).toContain('RESULT_COMPONENT_FINGERPRINTS_MISSING');
  });

  it('rejects incomplete consumed component fingerprints', () => {
    const validation = runAgreement(
      identity,
      [cycle()],
      [check({ consumedComponentFingerprints: { resolvedProfile: identity.resolvedFingerprint } })],
    );
    expect(codes(validation)).toContain('RESULT_FINGERPRINT_MISSING');
  });

  it('rejects a non-canonical 64-hex component fingerprint', () => {
    expect(
      shapeCodes(check({ consumedComponentFingerprints: consumed({ oracle: 'deadbeef' }) })),
    ).toContain('RESULT_FINGERPRINT_MISSING');
    expect(isFullCanonicalFingerprint(hex('a'))).toBe(true);
    expect(isFullCanonicalFingerprint(hex('A'))).toBe(false);
    expect(isFullCanonicalFingerprint('abc')).toBe(false);
  });

  it('rejects a boolean passed field on a current check', () => {
    expect(shapeCodes(check({ passed: true }))).toContain('RESULT_BOOLEAN_PASSED_PRESENT');
  });

  it('rejects a harnessInvalid side channel on a current check', () => {
    expect(shapeCodes(check({ harnessInvalid: true }))).toContain('RESULT_HARNESS_INVALID_PRESENT');
  });
});

describe('[P7-B B1-A] Action Cycle readiness linkage', () => {
  it('resolves the action-cycle reference and its readiness fingerprint', () => {
    const validation = runAgreement(identity, [cycle()], [check()]);
    expect(validation.ok).toBe(true);
  });

  it('rejects an unresolved action-cycle reference', () => {
    const validation = runAgreement(identity, [], [check()]);
    expect(codes(validation)).toContain('RESULT_ACTION_CYCLE_UNRESOLVED');
  });

  it('rejects a missing action-cycle reference', () => {
    const validation = runAgreement(identity, [cycle()], [check({ actionCycleRef: '' })]);
    expect(codes(validation)).toContain('RESULT_ACTION_CYCLE_REF_MISSING');
  });

  it('rejects a duplicated Action Cycle identity', () => {
    const validation = runAgreement(identity, [cycle(), cycle()], [check()]);
    expect(codes(validation)).toContain('RESULT_ACTION_CYCLE_DUPLICATE');
  });

  it('rejects an action-cycle resolved-profile disagreement', () => {
    const validation = runAgreement(
      identity,
      [cycle({ resolvedProfileFingerprint: hex('b') })],
      [check()],
    );
    expect(codes(validation)).toContain('RESULT_ACTION_CYCLE_PROFILE_MISMATCH');
  });

  it('rejects an action-cycle readiness disagreement', () => {
    const validation = runAgreement(
      identity,
      [cycle({ readinessFingerprint: hex('c') })],
      [check()],
    );
    expect(codes(validation)).toContain('RESULT_READINESS_FINGERPRINT_MISMATCH');
  });

  it('rejects a consumed resolved profile that disagrees with the compiled profile', () => {
    const validation = runAgreement(
      identity,
      [cycle()],
      [check({ consumedComponentFingerprints: consumed({ resolvedProfile: hex('d') }) })],
    );
    expect(codes(validation)).toContain('RESULT_CONSUMED_COMPONENT_MISMATCH');
  });
});

describe('[P7-B B1-A] evidence and policy-reference agreement', () => {
  it('rejects undeclared evidence consumption', () => {
    const validation = runAgreement(
      identity,
      [cycle()],
      [check({ evidenceIds: [...contract.requiredEvidence, 'diagnostic-only:trace'] })],
    );
    expect(codes(validation)).toContain('RESULT_EVIDENCE_UNDECLARED');
  });

  it('rejects a passing check that omits declared required evidence', () => {
    const validation = runAgreement(identity, [cycle()], [check({ evidenceIds: [] })]);
    expect(codes(validation)).toContain('RESULT_EVIDENCE_MISSING');
  });

  it('rejects a tolerance reference that disagrees with the compiled declaration', () => {
    const validation = runAgreement(
      identity,
      [cycle()],
      [check({ toleranceRefs: [...contract.toleranceRefs, 'unknown-tolerance-v1'] })],
    );
    expect(codes(validation)).toContain('RESULT_TOLERANCE_REF_UNDECLARED');
  });

  it('rejects a visual reference that is not declared', () => {
    const validation = runAgreement(
      identity,
      [cycle()],
      [check({ visualRefs: ['unknown-visual-v1'] })],
    );
    expect(codes(validation)).toContain('RESULT_VISUAL_REF_UNDECLARED');
  });
});

describe('[P7-B B1-A] normalization non-applicability', () => {
  const applicableIdentity: CorrectnessProfileIdentityView = {
    ...identity,
    normalization: {
      applicable: true,
      normalizationId: 'restore-normalization-v1',
      version: 1,
      applicability: 'frontend-serialize-restore',
      meaningRef: 'artwork-product-meaning-v1',
      evaluator: 'restore-normalization-v1',
      fingerprint: hex('e'),
    },
    requiredChecks: [{ ...contract, normalizationRef: 'restore-normalization-v1' }],
  };

  it('accepts null normalizationRef only under the explicit non-applicable state', () => {
    const validation = runAgreement(identity, [cycle()], [check({ normalizationRef: null })]);
    expect(validation.ok).toBe(true);
  });

  it('rejects a normalization reference while the profile is non-applicable', () => {
    const validation = runAgreement(
      identity,
      [cycle()],
      [check({ normalizationRef: 'restore-normalization-v1' })],
    );
    expect(codes(validation)).toContain('RESULT_NORMALIZATION_REF_INVALID');
  });

  it('requires the declared normalization reference when the profile is applicable', () => {
    const validation = runAgreement(
      applicableIdentity,
      [cycle()],
      [check({ normalizationRef: null })],
    );
    expect(codes(validation)).toContain('RESULT_NORMALIZATION_REF_INVALID');
  });
});

describe('[P7-B B1-A] required-check completeness', () => {
  it('rejects an empty check set for a profile with declared checks', () => {
    const validation = runAgreement(identity, [cycle()], []);
    expect(codes(validation)).toContain('RESULT_EMPTY_REQUIRED_CHECKS');
  });

  it('rejects a missing declared required check', () => {
    const validation = runAgreement(identity, [cycle()], []);
    expect(codes(validation)).toContain('RESULT_REQUIRED_CHECK_MISSING');
  });

  it('rejects an unknown check id', () => {
    const validation = runAgreement(identity, [cycle()], [check({ checkId: 'geometry.unknown' })]);
    expect(codes(validation)).toContain('RESULT_REQUIRED_CHECK_UNKNOWN');
  });

  it('rejects a duplicated check id', () => {
    const validation = runAgreement(identity, [cycle()], [check(), check()]);
    expect(codes(validation)).toContain('RESULT_REQUIRED_CHECK_DUPLICATE');
  });
});

describe('[P7-B B1-A] strict legacy/current discrimination', () => {
  it('classifies a strict current v4 record as current', () => {
    const result = discriminateRunRecordVersion(record());
    expect(result.kind).toBe('current-v4');
    expect(result.current).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it('classifies v1, v2, and v3 as legacy-ambiguous, never current', () => {
    const legacyCheck = { checkId: 'geometry.delta', passed: true, evidenceIds: ['observation'] };
    for (const version of [1, 2, 3]) {
      const result = discriminateRunRecordVersion({
        schemaVersion: version,
        requiredChecks: [legacyCheck],
      });
      expect(result.kind).toBe(`legacy-v${version}`);
      expect(result.legacy).toBe(true);
      expect(result.current).toBe(false);
      expect(result.ambiguousLegacy).toBe(true);
    }
  });

  it('rejects an unknown schema version rather than coercing it', () => {
    const result = discriminateRunRecordVersion({ schemaVersion: 99, requiredChecks: [] });
    expect(result.kind).toBe('unknown');
    expect(codes(result)).toContain('RESULT_SCHEMA_VERSION_UNSUPPORTED');
  });

  it('rejects a non-object record', () => {
    expect(discriminateRunRecordVersion(null).kind).toBe('invalid');
    expect(discriminateRunRecordVersion('record').kind).toBe('invalid');
  });

  it('rejects a v4 record that still carries a boolean passed check', () => {
    const result = discriminateRunRecordVersion({
      schemaVersion: FINAL_CURRENT_RESULT_SCHEMA_VERSION,
      requiredChecks: [{ checkId: 'geometry.delta', passed: false }],
    });
    expect(result.kind).toBe('mixed');
    expect(codes(result)).toContain('RESULT_BOOLEAN_PASSED_PRESENT');
  });

  it('rejects a v4 check that mixes a boolean and a status on the same check', () => {
    const result = discriminateRunRecordVersion({
      schemaVersion: FINAL_CURRENT_RESULT_SCHEMA_VERSION,
      requiredChecks: [{ checkId: 'geometry.delta', passed: false, status: 'FAIL' }],
    });
    expect(result.kind).toBe('mixed');
    expect(codes(result)).toContain('RESULT_CHECK_SHAPE_MIXED');
  });

  it('rejects a legacy record that carries a status shape', () => {
    const result = discriminateRunRecordVersion({
      schemaVersion: 2,
      requiredChecks: [{ checkId: 'geometry.delta', status: 'PASS' }],
    });
    expect(result.kind).toBe('mixed');
    expect(codes(result)).toContain('RESULT_CHECK_SHAPE_MIXED');
  });

  it('keeps a legacy false check ambiguous and never converts it to FAIL or UNUSABLE', () => {
    const classified = classifyLegacyCheckResult({
      checkId: 'geometry.delta',
      passed: false,
      evidenceIds: ['observation'],
    });
    expect(classified.kind).toBe('legacy-boolean');
    expect(classified.passed).toBe(false);
    expect(classified.status).toBeNull();
    expect(classified.ambiguous).toBe(true);
    expect(classified.status).not.toBe('FAIL');
    expect(classified.status).not.toBe('UNUSABLE');
    expect(codes(classified)).toContain('RESULT_LEGACY_BOOLEAN_AMBIGUOUS');
  });

  it('rejects a legacy check that mixes boolean and status', () => {
    const classified = classifyLegacyCheckResult({
      checkId: 'geometry.delta',
      passed: false,
      status: 'FAIL',
    });
    expect(classified.kind).toBe('invalid');
    expect(codes(classified)).toContain('RESULT_CHECK_SHAPE_MIXED');
  });
});

describe('[P7-B B1-A] command-context status authority', () => {
  const commandCheck = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 1,
    checkId: 'doctor.bridge.version',
    status: 'PASS',
    expected: { version: 7 },
    actual: { version: 7 },
    evidenceIds: [],
    commandAuthority: {
      schemaVersion: 7,
      command: 'doctor',
      commandAuthorityId: 'doctor-result-v7',
      commandAuthorityFingerprint: hex('f'),
    },
    ...overrides,
  });

  it('accepts a well-formed Doctor command check that fabricates no profile identity', () => {
    expect(COMMAND_CHECK_CONTEXTS).toEqual(['doctor', 'production-absence']);
    expect(isCommandCheckContext('production-absence')).toBe(true);
    expect(isCommandCheckContext('diagnostic')).toBe(false);
    expect(validateCommandCheck(commandCheck()).ok).toBe(true);
    expect(validateCheckContextSeparation(commandCheck()).ok).toBe(true);
  });

  it('rejects a command check that fabricates compiled-profile identity', () => {
    const validation = validateCommandCheck(
      commandCheck({ resolvedProfile: identity.resolvedFingerprint }),
    );
    expect(codes(validation)).toContain('RESULT_COMMAND_CONTEXT_FORBIDDEN');
  });

  it('rejects a check that mixes command authority and profile identity', () => {
    const validation = validateCheckContextSeparation(
      commandCheck({ consumedComponentFingerprints: consumed() }),
    );
    expect(codes(validation)).toContain('RESULT_COMMAND_CONTEXT_FORBIDDEN');
  });

  it('rejects an unknown command authority fingerprint', () => {
    const validation = validateCommandCheck(
      commandCheck({
        commandAuthority: {
          schemaVersion: 7,
          command: 'production-absence',
          commandAuthorityId: 'production-absence-v1',
          commandAuthorityFingerprint: 'not-a-fingerprint',
        },
      }),
    );
    expect(codes(validation)).toContain('RESULT_COMMAND_AUTHORITY_INVALID');
  });

  it('rejects a check that declares no context at all', () => {
    const validation = validateCheckContextSeparation({ checkId: 'orphan', status: 'PASS' });
    expect(codes(validation)).toContain('RESULT_COMMAND_CONTEXT_REQUIRED');
  });

  it('accepts a Diagnostic check through the separation validator', () => {
    expect(validateCheckContextSeparation(check()).ok).toBe(true);
  });
});

describe('[P7-B B1-A] inactive kernel invariants', () => {
  it('keeps the final schema v4 while the active run-record schema stays v3', () => {
    expect(FINAL_CURRENT_RESULT_SCHEMA_VERSION).toBe(4);
    expect(RUN_RECORD_VERSION_KINDS).toContain('current-v4');
    expect(RUN_RECORD_VERSION_KINDS).toContain('legacy-v3');
  });
});
