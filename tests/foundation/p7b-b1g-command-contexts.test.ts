import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  COMMAND_AUTHORITY_STATES,
  COMMAND_CONTEXT_ISSUE_CODES,
  COMMAND_EVIDENCE_AVAILABILITIES,
  COMMAND_NEGATIVE_DISPOSITIONS,
  DOCTOR_COMMAND_AUTHORITY,
  DOCTOR_COMMAND_AUTHORITY_ID,
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_CONTEXT,
  DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE,
  DOCTOR_COMMAND_EXPECTED_BRIDGE_VERSION,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_SCHEMA_VERSION,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY_ID,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_CONTEXT,
  PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_SCHEMA_VERSION,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  deriveCommandAuthorityFingerprint,
  evaluateDoctorCommandChecks,
  evaluateProductionAbsenceCommandChecks,
  isCommandAuthorityState,
  isCommandEvidenceAvailability,
  isCommandNegativeDisposition,
  isFullCanonicalFingerprint,
  projectCommandStatusAuthority,
  sameCommandContext,
  validateCheckContextSeparation,
  validateCommandAuthorityAgreement,
  validateCommandAuthorityDeclaration,
  validateCommandCheck,
  validateCommandContextResult,
} from '../../src/index';
import type {
  CommandAuthorityDeclaration,
  CommandCheckFact,
  CommandContextResult,
  CommandEvidenceFact,
  CommandStatusAuthority,
} from '../../src/index';

/**
 * P7-B B1-G explicit-status command-context tests (ADR 0028 §3 B1-G; ADR 0032
 * §E3-S2 post-cutover binding).
 *
 * These tests drive the command-context modules directly. They never launch a
 * browser, write a current record, or touch an active Doctor/production-absence
 * CLI writer, classifier, or output path. Post-cutover the two active command
 * entries consume these declarations while the retained boolean
 * `CheckResult`/`harnessInvalid` surface stays off the active path.
 */

const DOCTOR_CHECK_IDS = [
  'doctor.route',
  'doctor.title',
  'doctor.bridge.available',
  'doctor.bridge.version',
  'doctor.bridge.document',
  'doctor.bridge.methods',
  'doctor.bridge.frozen',
  'doctor.bridge.cursor',
  'doctor.bridge.cursor-stable',
  'doctor.bridge.waiter',
  'doctor.bridge.geometry',
  'doctor.bridge.raster',
  'doctor.bridge.no-mutation',
  'doctor.stage.mounted',
  'doctor.stage.layers',
  'doctor.state.layouts',
  'doctor.state.scenegraph',
  'doctor.environment.cell',
] as const;

const PRODUCTION_CHECK_IDS = [
  'production.artifact-absence',
  'production.browser-absence.initial',
  'production.browser-absence.reload',
  'production.chunk-reconciliation',
] as const;

const HEX_A = 'a'.repeat(64);

function doctorFacts(): CommandCheckFact[] {
  return DOCTOR_CHECK_IDS.map((checkId) => ({
    checkId,
    authorityState: 'current',
    matched: true,
    actual: { observed: checkId },
  }));
}

function doctorEvidence(): CommandEvidenceFact[] {
  return DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
    evidenceId,
    availability: 'authoritative',
  }));
}

function productionFacts(): CommandCheckFact[] {
  return PRODUCTION_CHECK_IDS.map((checkId) => ({
    checkId,
    authorityState: 'current',
    matched: true,
    actual: { observed: checkId },
  }));
}

function productionEvidence(): CommandEvidenceFact[] {
  return PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
    evidenceId,
    availability: 'authoritative',
  }));
}

function withFact(
  facts: readonly CommandCheckFact[],
  checkId: string,
  patch: Partial<CommandCheckFact>,
): CommandCheckFact[] {
  return facts.map((fact) => (fact.checkId === checkId ? { ...fact, ...patch } : fact));
}

function runDoctor(
  overrides: {
    checks?: readonly CommandCheckFact[];
    evidence?: readonly CommandEvidenceFact[];
    commandAuthority?: CommandStatusAuthority;
    environmentFailure?: boolean;
    cleanupSucceeded?: boolean;
  } = {},
): CommandContextResult {
  return evaluateDoctorCommandChecks({
    commandAuthority: overrides.commandAuthority ?? DOCTOR_COMMAND_STATUS_AUTHORITY,
    checks: overrides.checks ?? doctorFacts(),
    evidence: overrides.evidence ?? doctorEvidence(),
    environmentFailure: overrides.environmentFailure,
    cleanupSucceeded: overrides.cleanupSucceeded ?? true,
  });
}

function runProduction(
  overrides: {
    checks?: readonly CommandCheckFact[];
    evidence?: readonly CommandEvidenceFact[];
    commandAuthority?: CommandStatusAuthority;
    environmentFailure?: boolean;
    cleanupSucceeded?: boolean;
  } = {},
): CommandContextResult {
  return evaluateProductionAbsenceCommandChecks({
    commandAuthority: overrides.commandAuthority ?? PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    checks: overrides.checks ?? productionFacts(),
    evidence: overrides.evidence ?? productionEvidence(),
    environmentFailure: overrides.environmentFailure,
    cleanupSucceeded: overrides.cleanupSucceeded ?? true,
  });
}

function codes(result: { issues: readonly { code: string }[] }): string[] {
  return result.issues.map((issue) => issue.code);
}

function statusOf(result: CommandContextResult, checkId: string): string {
  const check = result.checks.find((entry) => entry.checkId === checkId);
  if (check === undefined) throw new Error(`No check "${checkId}" was produced.`);
  return check.status;
}

// ── Versioned command authority declarations ─────────────────────────────────

describe('[P7-B B1-G] versioned command authority declarations', () => {
  it('declares the accepted Doctor command contract exactly once', () => {
    expect(DOCTOR_COMMAND_CONTEXT).toBe('doctor');
    expect(DOCTOR_COMMAND_SCHEMA_VERSION).toBe(7);
    expect(DOCTOR_COMMAND_AUTHORITY_ID).toBe('doctor-result-v7');
    expect(DOCTOR_COMMAND_EXPECTED_BRIDGE_VERSION).toBe(7);
    expect(DOCTOR_COMMAND_AUTHORITY.command).toBe('doctor');
    expect(DOCTOR_COMMAND_AUTHORITY.schemaVersion).toBe(7);
    expect(DOCTOR_COMMAND_CHECKS.map((check) => check.checkId)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(DOCTOR_COMMAND_AUTHORITY.requiredChecks).toBe(DOCTOR_COMMAND_CHECKS);
  });

  it('declares the accepted production-absence command contract exactly once', () => {
    expect(PRODUCTION_ABSENCE_COMMAND_CONTEXT).toBe('production-absence');
    expect(PRODUCTION_ABSENCE_COMMAND_SCHEMA_VERSION).toBe(1);
    expect(PRODUCTION_ABSENCE_COMMAND_AUTHORITY_ID).toBe('production-absence-v1');
    expect(PRODUCTION_ABSENCE_COMMAND_CHECKS.map((check) => check.checkId)).toEqual([
      ...PRODUCTION_CHECK_IDS,
    ]);
  });

  it('derives a full canonical 64-hex identity for each command authority', () => {
    for (const authority of [
      DOCTOR_COMMAND_STATUS_AUTHORITY,
      PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    ]) {
      expect(isFullCanonicalFingerprint(authority.commandAuthorityFingerprint)).toBe(true);
    }
    expect(DOCTOR_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint).not.toBe(
      PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint,
    );
    expect(projectCommandStatusAuthority(DOCTOR_COMMAND_AUTHORITY)).toEqual(
      DOCTOR_COMMAND_STATUS_AUTHORITY,
    );
  });

  it('validates the strict closed declaration DTO', () => {
    expect(validateCommandAuthorityDeclaration(DOCTOR_COMMAND_AUTHORITY).ok).toBe(true);
    expect(validateCommandAuthorityDeclaration(PRODUCTION_ABSENCE_COMMAND_AUTHORITY).ok).toBe(true);
    expect(COMMAND_AUTHORITY_STATES).toContain('current');
    expect(COMMAND_NEGATIVE_DISPOSITIONS).toEqual([
      'authority-unavailable',
      'environment-mismatch',
      'product-mismatch',
    ]);
    expect(COMMAND_EVIDENCE_AVAILABILITIES).toContain('authoritative');
    expect(isCommandAuthorityState('torn')).toBe(true);
    expect(isCommandAuthorityState('passed')).toBe(false);
    expect(isCommandNegativeDisposition('product-mismatch')).toBe(true);
    expect(isCommandNegativeDisposition('bug')).toBe(false);
    expect(isCommandEvidenceAvailability('diagnostic-only')).toBe(true);
    expect(isCommandEvidenceAvailability('authoritative')).toBe(true);
    expect(isCommandEvidenceAvailability('passed')).toBe(false);
  });

  it('declares disjoint required and diagnostic evidence vocabularies', () => {
    for (const declaration of [DOCTOR_COMMAND_AUTHORITY, PRODUCTION_ABSENCE_COMMAND_AUTHORITY]) {
      const required = new Set(declaration.requiredAuthoritativeEvidence);
      for (const diagnostic of declaration.diagnosticOnlyEvidence) {
        expect(required.has(diagnostic)).toBe(false);
      }
    }
    expect(DOCTOR_COMMAND_REQUIRED_EVIDENCE).toHaveLength(3);
    expect(DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE).toContain('doctor.screenshot');
    expect(PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE).toEqual(['production.screenshot']);
  });
});

// ── Success ──────────────────────────────────────────────────────────────────

describe('[P7-B B1G] command success maps to PASS', () => {
  it('produces one PASS per declared Doctor check with the exact expected/actual payload', () => {
    const result = runDoctor();
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.checks.map((check) => check.checkId)).toEqual([...DOCTOR_CHECK_IDS]);
    for (const check of result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
      expect(check.expected).toBe(
        DOCTOR_COMMAND_CHECKS.find((entry) => entry.checkId === check.checkId)?.expected,
      );
      expect(check.actual.authorityState).toBe('current');
      expect(check.actual.matched).toBe(true);
      expect(check.commandAuthority).toBe(DOCTOR_COMMAND_STATUS_AUTHORITY);
      expect(validateCommandCheck(check).ok).toBe(true);
      expect(validateCheckContextSeparation(check).ok).toBe(true);
    }
  });

  it('produces one PASS per declared production-absence check', () => {
    const result = runProduction();
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.checks.map((check) => check.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
  });

  it('fabricates no compiled-profile identity on any command check', () => {
    for (const check of runDoctor().checks) {
      for (const key of [
        'actionCycleRef',
        'consumedComponentFingerprints',
        'resolvedProfile',
        'resolvedProfileFingerprint',
        'passed',
        'harnessInvalid',
      ]) {
        expect(Object.hasOwn(check, key)).toBe(false);
      }
      expect(Object.hasOwn(check, 'commandAuthority')).toBe(true);
    }
  });

  it('classifies an all-PASS, clean, non-environment command as PASS', () => {
    const result = runDoctor();
    expect(result.environmentFailure).toBe(false);
    expect(result.outcome.behaviorOutcome).toBe('PASS');
    expect(result.outcome.finalOutcome).toBe('PASS');
    expect(result.outcome.unusableCheckIds).toEqual([]);
    expect(result.outcome.failingCheckIds).toEqual([]);
  });
});

// ── Mismatch maps to FAIL ────────────────────────────────────────────────────

describe('[P7-B B1-G] trustworthy command mismatch maps to FAIL', () => {
  it('maps a current Doctor product mismatch to FAIL and BUG', () => {
    const result = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.bridge.methods', { matched: false }),
    });
    expect(statusOf(result, 'doctor.bridge.methods')).toBe('FAIL');
    expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_MISMATCH');
    expect(result.outcome.behaviorOutcome).toBe('BUG');
    expect(result.outcome.finalOutcome).toBe('BUG');
    expect(result.outcome.failingCheckIds).toEqual(['doctor.bridge.methods']);
  });

  it('maps a live production seam to FAIL and BUG', () => {
    const result = runProduction({
      checks: withFact(productionFacts(), 'production.browser-absence.initial', { matched: false }),
    });
    expect(statusOf(result, 'production.browser-absence.initial')).toBe('FAIL');
    expect(result.outcome.behaviorOutcome).toBe('BUG');
  });

  it('maps a seam present in the emitted artifact to FAIL and BUG', () => {
    const result = runProduction({
      checks: withFact(productionFacts(), 'production.artifact-absence', { matched: false }),
    });
    expect(statusOf(result, 'production.artifact-absence')).toBe('FAIL');
    expect(result.outcome.finalOutcome).toBe('BUG');
  });

  it('does not assert FAIL for a dimension declared authority-unavailable', () => {
    for (const checkId of [
      'doctor.bridge.available',
      'doctor.bridge.document',
      'doctor.state.scenegraph',
    ]) {
      const result = runDoctor({ checks: withFact(doctorFacts(), checkId, { matched: false }) });
      expect(statusOf(result, checkId)).toBe('UNUSABLE');
      expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_AUTHORITY_UNUSABLE');
      expect(result.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    }
    const production = runProduction({
      checks: withFact(productionFacts(), 'production.chunk-reconciliation', { matched: false }),
    });
    expect(statusOf(production, 'production.chunk-reconciliation')).toBe('UNUSABLE');
    expect(production.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
  });
});

// ── Unusable authority maps to UNUSABLE ──────────────────────────────────────

describe('[P7-B B1-G] unusable authority maps to UNUSABLE', () => {
  const states = [
    'ambiguous',
    'incomplete',
    'malformed',
    'missing',
    'stale',
    'torn',
    'unsupported',
  ] as const;

  it('maps every non-current authority state to UNUSABLE', () => {
    for (const authorityState of states) {
      const result = runDoctor({
        checks: withFact(doctorFacts(), 'doctor.bridge.cursor', {
          authorityState,
          matched: null,
        }),
      });
      expect(statusOf(result, 'doctor.bridge.cursor')).toBe('UNUSABLE');
      expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_AUTHORITY_UNUSABLE');
      expect(result.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
      expect(result.outcome.unusableCheckIds).toEqual(['doctor.bridge.cursor']);
    }
  });

  it('treats a missing comparison fact on current authority as incomplete', () => {
    const result = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.stage.mounted', { matched: null }),
    });
    expect(statusOf(result, 'doctor.stage.mounted')).toBe('UNUSABLE');
    expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_INCOMPLETE');
  });

  it('treats a missing delivered fact as UNUSABLE, never PASS or FAIL', () => {
    const result = runDoctor({
      checks: doctorFacts().filter((fact) => fact.checkId !== 'doctor.bridge.frozen'),
    });
    expect(statusOf(result, 'doctor.bridge.frozen')).toBe('UNUSABLE');
    expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_CHECK_MISSING');
    expect(result.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
  });

  it('rejects a comparison on a non-current authority as unusable, not a mismatch', () => {
    const result = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.title', { authorityState: 'stale', matched: false }),
    });
    expect(statusOf(result, 'doctor.title')).toBe('UNUSABLE');
    expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_INCOMPLETE');
  });
});

// ── Empty, unknown, mixed ────────────────────────────────────────────────────

describe('[P7-B B1-G] empty, unknown, and mixed inputs fail closed', () => {
  it('rejects a declaration with no required checks and fabricates no check', () => {
    const empty: CommandAuthorityDeclaration = { ...DOCTOR_COMMAND_AUTHORITY, requiredChecks: [] };
    expect(codes(validateCommandAuthorityDeclaration(empty))).toContain(
      'COMMAND_CONTEXT_EMPTY_REQUIRED_CHECKS',
    );
    const result = evaluateDoctorCommandChecks({
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: [],
      evidence: doctorEvidence(),
      cleanupSucceeded: true,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
  });

  it('classifies an empty command result as HARNESS_BLOCKED, never PASS', () => {
    const result = evaluateDoctorCommandChecks({
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: [],
      evidence: [],
      cleanupSucceeded: true,
    });
    expect(result.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(result.outcome.finalOutcome).toBe('HARNESS_BLOCKED');
  });

  it('reports an unknown delivered check id without consuming it', () => {
    const result = runDoctor({
      checks: [
        ...doctorFacts(),
        { checkId: 'doctor.unknown', authorityState: 'current', matched: true, actual: {} },
      ],
    });
    expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_CHECK_UNKNOWN');
    expect(result.checks.some((check) => check.checkId === 'doctor.unknown')).toBe(false);
  });

  it('reports a duplicated delivered check id', () => {
    const facts = doctorFacts();
    const result = runDoctor({ checks: [facts[0]!, ...facts] });
    expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_CHECK_DUPLICATE');
  });

  it('rejects an unknown authority state and an unknown negative disposition', () => {
    const unknownState = runDoctor({
      checks: doctorFacts().map((fact) =>
        fact.checkId === 'doctor.route'
          ? ({ ...fact, authorityState: 'passed' } as unknown as CommandCheckFact)
          : fact,
      ),
    });
    expect(codes(unknownState)).toContain('COMMAND_CONTEXT_FACT_AUTHORITY_STATE_UNKNOWN');

    const unknownDisposition: CommandAuthorityDeclaration = {
      ...DOCTOR_COMMAND_AUTHORITY,
      requiredChecks: DOCTOR_COMMAND_CHECKS.map((check) =>
        check.checkId === 'doctor.route'
          ? ({ ...check, negativeDisposition: 'bug' } as unknown as typeof check)
          : check,
      ),
    };
    expect(codes(validateCommandAuthorityDeclaration(unknownDisposition))).toContain(
      'COMMAND_CONTEXT_NEGATIVE_DISPOSITION_UNKNOWN',
    );
  });

  it('rejects a command fact that fabricates a compiled-profile identity', () => {
    const result = runDoctor({
      checks: doctorFacts().map((fact) =>
        fact.checkId === 'doctor.title'
          ? ({ ...fact, resolvedProfile: HEX_A } as unknown as CommandCheckFact)
          : fact,
      ),
    });
    expect(codes(result)).toContain('COMMAND_CONTEXT_FACT_PROFILE_FABRICATION');
    expect(result.checks.some((check) => check.checkId === 'doctor.title')).toBe(true);
  });
});

// ── No mixed profile-command context ─────────────────────────────────────────

describe('[P7-B B1-G] no mixed profile-command context', () => {
  it('rejects a check that mixes command authority and compiled-profile identity', () => {
    const check = { ...runDoctor().checks[0]! } as Record<string, unknown>;
    check.consumedComponentFingerprints = { resolvedProfile: HEX_A };
    expect(codes(validateCheckContextSeparation(check))).toContain(
      'RESULT_COMMAND_CONTEXT_FORBIDDEN',
    );
  });

  it('rejects a command check that carries a legacy boolean or harnessInvalid side channel', () => {
    const result = runDoctor();
    const withBoolean = { ...result.checks[0]!, passed: true };
    expect(codes(validateCheckContextSeparation(withBoolean))).toContain(
      'RESULT_BOOLEAN_PASSED_PRESENT',
    );
    const withHarnessInvalid = { ...result.checks[0]!, harnessInvalid: true };
    expect(codes(validateCheckContextSeparation(withHarnessInvalid))).toContain(
      'RESULT_HARNESS_INVALID_PRESENT',
    );
  });

  it('rejects a declaration that carries profile identity', () => {
    const fabricated = {
      ...DOCTOR_COMMAND_AUTHORITY,
      actionCycleRef: 'action-cycle-1',
    } as unknown as CommandAuthorityDeclaration;
    expect(codes(validateCommandAuthorityDeclaration(fabricated))).toContain(
      'COMMAND_CONTEXT_FACT_PROFILE_FABRICATION',
    );
  });

  it('rejects a foreign command context through the strict result validator', () => {
    const productionCheck = runProduction().checks[0]!;
    expect(
      codes(validateCommandContextResult(DOCTOR_COMMAND_AUTHORITY, productionCheck)),
    ).toContain('COMMAND_CONTEXT_FACT_CHECK_UNKNOWN');
  });

  it('tracks command context identity across both command contexts', () => {
    const doctor = runDoctor().checks[0]!;
    const production = runProduction().checks[0]!;
    expect(sameCommandContext(doctor, doctor)).toBe(true);
    expect(sameCommandContext(doctor, production)).toBe(false);
  });
});

// ── Evidence agreement ───────────────────────────────────────────────────────

describe('[P7-B B1-G] required evidence agreement', () => {
  it('consumes only the declared required-authoritative evidence on a PASS', () => {
    const result = runDoctor();
    for (const check of result.checks) {
      const declaration = DOCTOR_COMMAND_CHECKS.find((entry) => entry.checkId === check.checkId)!;
      expect([...check.evidenceIds].sort()).toEqual([...declaration.requiredEvidence].sort());
    }
    expect(runDoctor().checks[0]!.evidenceIds).toEqual(['doctor.instance-observation']);
  });

  it('maps a missing required evidence item to UNUSABLE', () => {
    const result = runDoctor({
      evidence: doctorEvidence().filter((fact) => fact.evidenceId !== 'doctor.bridge-inspection'),
    });
    expect(statusOf(result, 'doctor.bridge.version')).toBe('UNUSABLE');
    expect(codes(result)).toContain('COMMAND_CONTEXT_EVIDENCE_MISSING');
    expect(result.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
  });

  it('maps stale, torn, ambiguous, and malformed required evidence to UNUSABLE', () => {
    for (const availability of ['stale', 'torn', 'ambiguous', 'malformed'] as const) {
      const result = runDoctor({
        evidence: doctorEvidence().map((fact) =>
          fact.evidenceId === 'doctor.browser-environment' ? { ...fact, availability } : fact,
        ),
      });
      expect(statusOf(result, 'doctor.environment.cell')).toBe('UNUSABLE');
      expect(codes(result)).toContain('COMMAND_CONTEXT_EVIDENCE_UNUSABLE');
    }
  });

  it('never lets diagnostic-only evidence satisfy a required check', () => {
    const result = runDoctor({
      evidence: doctorEvidence().map((fact) =>
        fact.evidenceId === 'doctor.instance-observation'
          ? { ...fact, availability: 'diagnostic-only' }
          : fact,
      ),
    });
    expect(statusOf(result, 'doctor.route')).toBe('UNUSABLE');
    expect(codes(result)).toContain('COMMAND_CONTEXT_EVIDENCE_DIAGNOSTIC_ONLY');
    expect(statusOf(result, 'doctor.route')).not.toBe('PASS');
  });

  it('rejects undeclared and diagnostic-only evidence through the strict validator', () => {
    const result = runDoctor();
    const undeclared = { ...result.checks[0]!, evidenceIds: ['undeclared-evidence'] };
    expect(codes(validateCommandContextResult(DOCTOR_COMMAND_AUTHORITY, undeclared))).toContain(
      'COMMAND_CONTEXT_EVIDENCE_UNDECLARED',
    );
    const diagnostic = { ...result.checks[0]!, evidenceIds: ['doctor.screenshot'] };
    expect(codes(validateCommandContextResult(DOCTOR_COMMAND_AUTHORITY, diagnostic))).toContain(
      'COMMAND_CONTEXT_EVIDENCE_DIAGNOSTIC_ONLY',
    );
  });

  it('rejects a passing check that omits its declared required evidence', () => {
    const result = runDoctor();
    const stripped = { ...result.checks[0]!, evidenceIds: [] };
    expect(codes(validateCommandContextResult(DOCTOR_COMMAND_AUTHORITY, stripped))).toContain(
      'COMMAND_CONTEXT_EVIDENCE_MISSING',
    );
  });

  it('accepts a complete produced check through the strict validator', () => {
    for (const check of runDoctor().checks) {
      expect(
        validateCommandContextResult(DOCTOR_COMMAND_AUTHORITY, check, doctorEvidence()).ok,
      ).toBe(true);
    }
    for (const check of runProduction().checks) {
      expect(
        validateCommandContextResult(
          PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
          check,
          productionEvidence(),
        ).ok,
      ).toBe(true);
    }
  });
});

// ── Identity and currentness ─────────────────────────────────────────────────

describe('[P7-B B1-G] authority identity and currentness', () => {
  it('accepts the exact declared authority', () => {
    expect(
      validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, DOCTOR_COMMAND_STATUS_AUTHORITY)
        .ok,
    ).toBe(true);
  });

  it('rejects a stale schema version', () => {
    const stale = { ...DOCTOR_COMMAND_STATUS_AUTHORITY, schemaVersion: 6 };
    const validation = validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, stale);
    expect(codes(validation)).toContain('COMMAND_CONTEXT_AUTHORITY_SCHEMA_UNSUPPORTED');
    const result = runDoctor({ commandAuthority: stale });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
  });

  it('rejects a wrong authority id and a wrong command context', () => {
    expect(
      codes(
        validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, {
          ...DOCTOR_COMMAND_STATUS_AUTHORITY,
          commandAuthorityId: 'doctor-result-v6',
        }),
      ),
    ).toContain('COMMAND_CONTEXT_AUTHORITY_ID_MISMATCH');
    expect(
      codes(
        validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, {
          ...DOCTOR_COMMAND_STATUS_AUTHORITY,
          command: 'production-absence',
        }),
      ),
    ).toContain('COMMAND_CONTEXT_AUTHORITY_COMMAND_MISMATCH');
  });

  it('rejects a missing, malformed, or mismatched authority fingerprint', () => {
    expect(
      codes(
        validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, {
          ...DOCTOR_COMMAND_STATUS_AUTHORITY,
          commandAuthorityFingerprint: '',
        }),
      ),
    ).toContain('COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_MISSING');
    expect(
      codes(
        validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, {
          ...DOCTOR_COMMAND_STATUS_AUTHORITY,
          commandAuthorityFingerprint: 'deadbeef',
        }),
      ),
    ).toContain('COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_INVALID');
    expect(
      codes(
        validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, {
          ...DOCTOR_COMMAND_STATUS_AUTHORITY,
          commandAuthorityFingerprint: HEX_A,
        }),
      ),
    ).toContain('COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_MISMATCH');
  });

  it('rejects a non-object authority and fabricates no check', () => {
    const validation = validateCommandAuthorityAgreement(DOCTOR_COMMAND_AUTHORITY, null);
    expect(codes(validation)).toContain('COMMAND_CONTEXT_AUTHORITY_NOT_OBJECT');
    const result = evaluateDoctorCommandChecks({
      commandAuthority: null as unknown as CommandStatusAuthority,
      checks: doctorFacts(),
      evidence: doctorEvidence(),
      cleanupSucceeded: true,
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
  });
});

// ── Classifier precedence and environment failure ────────────────────────────

describe('[P7-B B1-G] pure-classifier outcome precedence', () => {
  it('maps FAIL with no UNUSABLE to BUG and each failing id is reported', () => {
    const result = runDoctor({
      checks: withFact(
        withFact(doctorFacts(), 'doctor.title', { matched: false }),
        'doctor.bridge.frozen',
        { matched: false },
      ),
    });
    expect(result.outcome.behaviorOutcome).toBe('BUG');
    expect(result.outcome.failingCheckIds).toEqual(['doctor.title', 'doctor.bridge.frozen']);
    expect(result.outcome.unusableCheckIds).toEqual([]);
  });

  it('resolves FAIL beside UNUSABLE to HARNESS_BLOCKED while keeping the failing id', () => {
    const result = runDoctor({
      checks: withFact(
        withFact(doctorFacts(), 'doctor.title', { matched: false }),
        'doctor.bridge.cursor',
        { authorityState: 'torn', matched: null },
      ),
    });
    expect(result.outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(result.outcome.unusableCheckIds).toEqual(['doctor.bridge.cursor']);
    expect(result.outcome.failingCheckIds).toEqual(['doctor.title']);
  });

  it('resolves an observed environment mismatch to a FAIL check with environment precedence', () => {
    const result = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.environment.cell', { matched: false }),
    });
    expect(statusOf(result, 'doctor.environment.cell')).toBe('FAIL');
    expect(result.environmentFailure).toBe(true);
    expect(result.outcome.behaviorOutcome).toBe('BUG');
    expect(result.outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('keeps behavior and final outcome separate under an external failure', () => {
    const result = runDoctor({ environmentFailure: true });
    expect(result.outcome.behaviorOutcome).toBe('PASS');
    expect(result.outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('keeps behavior and final outcome separate under a cleanup failure', () => {
    const result = runProduction({ cleanupSucceeded: false });
    expect(result.outcome.behaviorOutcome).toBe('PASS');
    expect(result.outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('records no behavior outcome for a pre-authority environment failure with no evaluated checks', () => {
    const result = evaluateProductionAbsenceCommandChecks({
      commandAuthority: {
        ...PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
        schemaVersion: 99,
      },
      checks: [],
      evidence: [],
      environmentFailure: true,
      cleanupSucceeded: true,
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(result.outcome.behaviorOutcome).toBeNull();
    expect(result.outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('does not let a later cleanup failure erase a BUG behavior outcome', () => {
    const result = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.title', { matched: false }),
      cleanupSucceeded: false,
    });
    expect(result.outcome.behaviorOutcome).toBe('BUG');
    expect(result.outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });
});

// ── Mutation matrix ──────────────────────────────────────────────────────────

describe('[P7-B B1-G] command authority mutation matrix', () => {
  function clone(declaration: CommandAuthorityDeclaration): CommandAuthorityDeclaration {
    return structuredClone(declaration);
  }

  const doctorMutations: readonly {
    label: string;
    mutate: (d: CommandAuthorityDeclaration) => void;
  }[] = [
    { label: 'schemaVersion', mutate: (d) => ((d as { schemaVersion: number }).schemaVersion = 6) },
    {
      label: 'command',
      mutate: (d) => ((d as { command: string }).command = 'production-absence'),
    },
    {
      label: 'commandAuthorityId',
      mutate: (d) =>
        ((d as { commandAuthorityId: string }).commandAuthorityId = 'doctor-result-v8'),
    },
    {
      label: 'check id',
      mutate: (d) => ((d.requiredChecks[0] as { checkId: string }).checkId = 'doctor.routes'),
    },
    {
      label: 'negative disposition',
      mutate: (d) =>
        ((d.requiredChecks[0] as { negativeDisposition: string }).negativeDisposition =
          'authority-unavailable'),
    },
    {
      label: 'expected leaf',
      mutate: (d) => ((d.requiredChecks[0]!.expected as { route: string }).route = '/artwork/edit'),
    },
    {
      label: 'required evidence',
      mutate: (d) =>
        ((
          d.requiredChecks[0] as unknown as { requiredEvidence: readonly string[] }
        ).requiredEvidence = ['doctor.browser-environment']),
    },
    {
      label: 'required authoritative evidence',
      mutate: (d) =>
        ((
          d as unknown as { requiredAuthoritativeEvidence: readonly string[] }
        ).requiredAuthoritativeEvidence = ['doctor.browser-environment']),
    },
    {
      label: 'diagnostic evidence',
      mutate: (d) =>
        ((d as unknown as { diagnosticOnlyEvidence: readonly string[] }).diagnosticOnlyEvidence = [
          'doctor.console-errors',
        ]),
    },
  ];

  it('detects every single-leaf authority mutation by identity and agreement', () => {
    const baseline = deriveCommandAuthorityFingerprint(DOCTOR_COMMAND_AUTHORITY);
    for (const { label, mutate } of doctorMutations) {
      const mutated = clone(DOCTOR_COMMAND_AUTHORITY);
      mutate(mutated);
      expect(deriveCommandAuthorityFingerprint(mutated), label).not.toBe(baseline);
      expect(
        validateCommandAuthorityAgreement(mutated, DOCTOR_COMMAND_STATUS_AUTHORITY).ok,
        label,
      ).toBe(false);
    }
  });

  it('detects a production-absence authority mutation by identity', () => {
    const mutated = clone(PRODUCTION_ABSENCE_COMMAND_AUTHORITY);
    (mutated.requiredChecks[0] as { negativeDisposition: string }).negativeDisposition =
      'authority-unavailable';
    expect(deriveCommandAuthorityFingerprint(mutated)).not.toBe(
      deriveCommandAuthorityFingerprint(PRODUCTION_ABSENCE_COMMAND_AUTHORITY),
    );
    expect(
      validateCommandAuthorityAgreement(mutated, PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY).ok,
    ).toBe(false);
  });

  it('changing the authority command context changes only that context identity', () => {
    expect(
      deriveCommandAuthorityFingerprint(
        clone({ ...DOCTOR_COMMAND_AUTHORITY, command: 'production-absence' }),
      ),
    ).not.toBe(deriveCommandAuthorityFingerprint(DOCTOR_COMMAND_AUTHORITY));
  });
});

// ── Declaration invariants ───────────────────────────────────────────────────

describe('[P7-B B1-G] command-context declaration invariants', () => {
  const skillRoot = path.resolve(process.cwd());
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('exposes a closed local issue vocabulary that never enters the active DiagnosticCode set', () => {
    for (const code of COMMAND_CONTEXT_ISSUE_CODES) {
      expect(code).toMatch(/^COMMAND_CONTEXT_/);
    }
    expect(source('src/commands/command-context.ts')).not.toContain('DiagnosticCode');
  });

  it('does not import any active CLI, browser, executor, Oracle, evidence writer, or classifier', () => {
    for (const relative of [
      'src/commands/command-context.ts',
      'src/commands/doctor-command-context.ts',
      'src/commands/production-absence-command-context.ts',
    ]) {
      const module = source(relative);
      expect(module).not.toMatch(/from '\.\.\/(cli|browser|oracles|evidence)\//);
      expect(module).not.toMatch(/from '\.\.\/runtime\/(outcomes|execute|action-cycle)/);
      expect(module).not.toContain('contracts/execution');
    }
    // The declaration consumes only the pure B1-A status classifier.
    expect(source('src/commands/command-context.ts')).toContain("from '../runtime/result-outcome'");
    expect(source('src/commands/command-context.ts')).not.toContain('harnessInvalid');
  });

  it('is bound only by the active Doctor and production-absence command entries', () => {
    // Post-cutover the two active command entries consume the accepted B1-G
    // declarations directly.
    expect(source('src/cli/doctor.ts')).toContain("from '../commands/doctor-command-context'");
    expect(source('src/cli/production-absence.ts')).toContain(
      "from '../commands/production-absence-command-context'",
    );
    // No producer, runtime, legacy writer/reader, or boolean contract module may
    // reach the declarations, and nothing calls the pure check evaluators.
    for (const relative of [
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
      'src/runtime/outcomes.ts',
      'src/runtime/result-outcome.ts',
      'src/evidence/writer.ts',
      'src/evidence/public-dto.ts',
      'src/contracts/execution.ts',
    ]) {
      const reference = source(relative);
      expect(reference, relative).not.toContain('command-context');
      expect(reference, relative).not.toContain('evaluateDoctorCommandChecks');
      expect(reference, relative).not.toContain('evaluateProductionAbsenceCommandChecks');
    }
  });

  it('retains the boolean baseline while the active Doctor entry binds the three-state declaration', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
    // The retained runtime classifier still consumes `harnessInvalid`; only the
    // active command entries stop doing so.
    expect(source('src/runtime/outcomes.ts')).toContain('harnessInvalid');
    // The active Doctor entry no longer declares the legacy boolean shape: it
    // binds the accepted B1-G three-state status declaration.
    const doctor = source('src/cli/doctor.ts');
    expect(doctor).not.toContain('requiredChecks: readonly CheckResult[]');
    expect(doctor).toContain('DOCTOR_COMMAND_STATUS_AUTHORITY');
    expect(doctor).toContain('requiredChecks: readonly { checkId: string; status: string }[]');
  });

  it('keeps every produced command identity and fingerprint full canonical', () => {
    for (const result of [runDoctor(), runProduction()]) {
      expect(isFullCanonicalFingerprint(result.declaredAuthority.commandAuthorityFingerprint)).toBe(
        true,
      );
      for (const check of result.checks) {
        expect(isFullCanonicalFingerprint(check.commandAuthority.commandAuthorityFingerprint)).toBe(
          true,
        );
      }
    }
  });
});
