import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DOCTOR_COMMAND_AUTHORITY,
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  OBSERVATION_GLOBAL_MARKER,
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  PRODUCTION_ABSENCE_ROUTE,
  evaluateProductionAbsence,
  evaluateProductionBrowserAbsence,
  projectCommandStatusAuthority,
  scanArtifactContent,
  validateCheckContextSeparation,
  validateCommandContextResult,
} from '../../src/index';
import type {
  CommandCheckFact,
  CommandEvidenceAvailability,
  CommandEvidenceFact,
  CommandStatusAuthority,
  ProductionBrowserObservation,
} from '../../src/index';
import { readFinalRecord } from '../../src/contracts/final-record-reader';
import {
  COMMAND_EXECUTION_ISSUE_CODES,
  validateCommandExecutionChecks,
  type CommandExecutionOutcome,
} from '../../src/orchestration/command-execution';
import { executeDoctorCommandContext } from '../../src/orchestration/doctor-command-execution';
import { executeProductionAbsenceCommandContext } from '../../src/orchestration/production-absence-command-execution';
import { resolveToolkitRoot } from '../../src/runtime/paths';

/**
 * P7-B2-D2 focused proof: inactive Doctor and production-absence command
 * orchestration (ADR 0029 §4 B2-D).
 *
 * The suites drive the real B1-G command authorities and the real delivered
 * command facts through the inactive command orchestration, prove the explicit
 * `PASS | FAIL | UNUSABLE` mapping and the behavior/final classification, read
 * every produced strict v4 command record through the strict reader, and prove
 * the foreign/stale/malformed/mixed-authority refusal boundary. They never touch
 * an active Doctor/production-absence CLI, browser runner, writer, classifier,
 * or output path, and never fabricate a compiled correctness profile.
 */

const skillRoot = resolveToolkitRoot();

const DOCTOR_CHECK_IDS = DOCTOR_COMMAND_CHECKS.map((check) => check.checkId);
const PRODUCTION_CHECK_IDS = PRODUCTION_ABSENCE_COMMAND_CHECKS.map((check) => check.checkId);

function doctorFacts(matches: Readonly<Record<string, boolean>> = {}): CommandCheckFact[] {
  return DOCTOR_COMMAND_CHECKS.map((declaration) => ({
    checkId: declaration.checkId,
    authorityState: 'current' as const,
    matched: matches[declaration.checkId] ?? true,
    actual: { observed: declaration.checkId },
  }));
}

function doctorEvidence(
  availability: CommandEvidenceAvailability = 'authoritative',
): CommandEvidenceFact[] {
  return DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({ evidenceId, availability }));
}

interface DoctorOverrides {
  checks?: readonly CommandCheckFact[];
  evidence?: readonly CommandEvidenceFact[];
  commandAuthority?: CommandStatusAuthority;
  environmentFailure?: boolean;
  cleanupSucceeded?: boolean;
}

function runDoctor(overrides: DoctorOverrides = {}): CommandExecutionOutcome {
  return executeDoctorCommandContext({
    commandAuthority:
      'commandAuthority' in overrides
        ? (overrides.commandAuthority as CommandStatusAuthority)
        : DOCTOR_COMMAND_STATUS_AUTHORITY,
    checks: overrides.checks ?? doctorFacts(),
    evidence: overrides.evidence ?? doctorEvidence(),
    environmentFailure: overrides.environmentFailure,
    cleanupSucceeded: overrides.cleanupSucceeded ?? true,
  });
}

function withFact(
  facts: readonly CommandCheckFact[],
  checkId: string,
  patch: Partial<CommandCheckFact>,
): CommandCheckFact[] {
  return facts.map((fact) => (fact.checkId === checkId ? { ...fact, ...patch } : fact));
}

function statusOf(outcome: CommandExecutionOutcome, checkId: string): string {
  const check = outcome.requiredChecks.find((entry) => entry.checkId === checkId);
  if (check === undefined) throw new Error(`No check "${checkId}" was produced.`);
  return check.status;
}

/** Reads one produced record back through the strict reader after a JSON round-trip. */
function readBack(record: unknown) {
  return readFinalRecord(JSON.parse(JSON.stringify(record)) as unknown);
}

// ── Production-absence facts from the real seam predicates ───────────────────

function observation(attempt: 'initial' | 'reload', clean: boolean): ProductionBrowserObservation {
  return {
    attempt,
    httpStatus: 200,
    finalUrl: `http://127.0.0.1:3210${PRODUCTION_ABSENCE_ROUTE}`,
    title: 'Editor - Artwork',
    observationGlobalType: clean ? 'undefined' : 'object',
    setupGlobalType: 'undefined',
    brokerSlotPresent: false,
    setupAnchorSlotPresent: false,
    documentAnchorSlotPresent: false,
    signalAnchorSlotPresent: !clean,
    requestedPaths: clean
      ? ['/_next/static/chunks/app/page.js']
      : ['/_next/static/chunks/artworkVerificationBridge.js'],
  };
}

function productionFacts(
  options: {
    readonly artifactClean?: boolean;
    readonly initialClean?: boolean;
    readonly reloadClean?: boolean;
    readonly unresolvedChunks?: number;
  } = {},
): CommandCheckFact[] {
  const artifactClean = options.artifactClean !== false;
  const hits = artifactClean
    ? scanArtifactContent('dist/server/chunks/app/page.js', 'export const x = 1;')
    : scanArtifactContent(
        'dist/server/chunks/bridge.js',
        `window.${OBSERVATION_GLOBAL_MARKER} = {};`,
      );
  const scan = { clean: hits.length === 0, hits };
  const initial = observation('initial', options.initialClean !== false);
  const reload = observation('reload', options.reloadClean !== false);
  const absence = evaluateProductionAbsence({ scan, observations: [initial, reload] });
  const initialVerdict = evaluateProductionBrowserAbsence(initial);
  const reloadVerdict = evaluateProductionBrowserAbsence(reload);
  const unresolved = options.unresolvedChunks ?? 0;
  return PRODUCTION_ABSENCE_COMMAND_CHECKS.map((declaration) => {
    const matched =
      declaration.checkId === 'production.artifact-absence'
        ? scan.clean
        : declaration.checkId === 'production.browser-absence.initial'
          ? initialVerdict.clean
          : declaration.checkId === 'production.browser-absence.reload'
            ? reloadVerdict.clean
            : unresolved === 0;
    return {
      checkId: declaration.checkId,
      authorityState: 'current' as const,
      matched,
      actual:
        declaration.checkId === 'production.artifact-absence'
          ? { violations: [...absence.violations] }
          : { matched },
    };
  });
}

function productionEvidence(
  availability: CommandEvidenceAvailability = 'authoritative',
): CommandEvidenceFact[] {
  return PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
    evidenceId,
    availability,
  }));
}

interface ProductionOverrides {
  checks?: readonly CommandCheckFact[];
  evidence?: readonly CommandEvidenceFact[];
  commandAuthority?: CommandStatusAuthority;
  environmentFailure?: boolean;
  cleanupSucceeded?: boolean;
}

function runProduction(overrides: ProductionOverrides = {}): CommandExecutionOutcome {
  return executeProductionAbsenceCommandContext({
    commandAuthority:
      'commandAuthority' in overrides
        ? (overrides.commandAuthority as CommandStatusAuthority)
        : PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    checks: overrides.checks ?? productionFacts(),
    evidence: overrides.evidence ?? productionEvidence(),
    environmentFailure: overrides.environmentFailure,
    cleanupSucceeded: overrides.cleanupSucceeded ?? true,
  });
}

function codes(outcome: CommandExecutionOutcome): string[] {
  return outcome.issues.map((entry) => entry.code);
}

// ── Orchestration surface ────────────────────────────────────────────────────

describe('[P7-B2-D2] command orchestration surface', () => {
  it('declares a closed, unique issue vocabulary', () => {
    expect(new Set(COMMAND_EXECUTION_ISSUE_CODES).size).toBe(COMMAND_EXECUTION_ISSUE_CODES.length);
    expect(COMMAND_EXECUTION_ISSUE_CODES).toContain('COMMAND_AUTHORITY_UNTRUSTWORTHY');
    expect(COMMAND_EXECUTION_ISSUE_CODES).toContain('COMMAND_AUTHORITY_MIXED');
    expect(COMMAND_EXECUTION_ISSUE_CODES).toContain('COMMAND_CHECK_MIXED_CONTEXT');
    expect(COMMAND_EXECUTION_ISSUE_CODES).toContain('COMMAND_RECORD_NOT_STRICT_V4');
  });

  it('binds each adapter to its own distinct B1-G command authority', () => {
    const doctor = runDoctor();
    const production = runProduction();
    expect(doctor.command).toBe('doctor');
    expect(production.command).toBe('production-absence');
    expect(doctor.record?.commandAuthority).toEqual(DOCTOR_COMMAND_STATUS_AUTHORITY);
    expect(production.record?.commandAuthority).toEqual(
      PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    );
    expect(DOCTOR_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint).not.toBe(
      PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint,
    );
    expect(projectCommandStatusAuthority(DOCTOR_COMMAND_AUTHORITY)).toEqual(
      DOCTOR_COMMAND_STATUS_AUTHORITY,
    );
  });
});

// ── All-pass ─────────────────────────────────────────────────────────────────

describe('[P7-B2-D2] all-pass commands', () => {
  it('classifies a real current Doctor command as PASS with a strict v4 record', () => {
    const outcome = runDoctor();
    expect(outcome.authoritative).toBe(true);
    expect(outcome.preauthority).toBe(false);
    expect(outcome.issues).toEqual([]);
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('PASS');
    expect(outcome.unusableCheckIds).toEqual([]);
    expect(outcome.failingCheckIds).toEqual([]);
    expect(outcome.requiredChecks.map((check) => check.checkId)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(outcome.requiredChecks.every((check) => check.status === 'PASS')).toBe(true);
    expect(outcome.record).not.toBeNull();
    const read = readBack(outcome.record);
    expect(read.kind).toBe('command-v4');
    if (read.kind !== 'command-v4') return;
    expect(read.record.command).toBe('doctor');
    expect(read.record.checks.map((check) => check.checkId)).toEqual([...DOCTOR_CHECK_IDS]);
  });

  it('classifies a real clean production-absence command as PASS with a strict v4 record', () => {
    const outcome = runProduction();
    expect(outcome.authoritative).toBe(true);
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('PASS');
    expect(outcome.requiredChecks.map((check) => check.checkId)).toEqual([...PRODUCTION_CHECK_IDS]);
    expect(outcome.requiredChecks.every((check) => check.status === 'PASS')).toBe(true);
    const read = readBack(outcome.record);
    expect(read.kind).toBe('command-v4');
    if (read.kind !== 'command-v4') return;
    expect(read.record.command).toBe('production-absence');
  });

  it('fabricates no compiled-profile identity and no legacy boolean side channel', () => {
    for (const outcome of [runDoctor(), runProduction()]) {
      const record = outcome.record;
      if (record === null) throw new Error('expected a command record');
      for (const key of [
        'resolvedProfileFingerprint',
        'componentFingerprints',
        'actionCycles',
        'requiredChecks',
        'passed',
        'harnessInvalid',
      ]) {
        expect(Object.hasOwn(record, key), key).toBe(false);
      }
      for (const check of record.checks) {
        for (const key of [
          'actionCycleRef',
          'consumedComponentFingerprints',
          'resolvedProfile',
          'resolvedProfileFingerprint',
          'passed',
          'harnessInvalid',
        ]) {
          expect(Object.hasOwn(check, key), key).toBe(false);
        }
        expect(Object.keys(check.commandAuthority).sort()).toEqual([
          'command',
          'commandAuthorityFingerprint',
          'commandAuthorityId',
          'schemaVersion',
        ]);
      }
    }
  });
});

// ── Doctor semantics ─────────────────────────────────────────────────────────

describe('[P7-B2-D2] Doctor explicit-status semantics', () => {
  it('maps a Doctor product mismatch to a FAIL check and a BUG behavior/final outcome', () => {
    const outcome = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.bridge.methods', { matched: false }),
    });
    expect(statusOf(outcome, 'doctor.bridge.methods')).toBe('FAIL');
    expect(outcome.behaviorOutcome).toBe('BUG');
    expect(outcome.finalOutcome).toBe('BUG');
    expect(outcome.failingCheckIds).toEqual(['doctor.bridge.methods']);
    expect(outcome.record).not.toBeNull();
    const read = readBack(outcome.record);
    expect(read.kind).toBe('command-v4');
    if (read.kind !== 'command-v4') return;
    expect(
      read.record.checks.find((check) => check.checkId === 'doctor.bridge.methods')?.status,
    ).toBe('FAIL');
  });

  it('maps an environment-cell mismatch to a FAIL check, BUG behavior, and ENVIRONMENT_FAILURE final', () => {
    const outcome = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.environment.cell', { matched: false }),
    });
    expect(statusOf(outcome, 'doctor.environment.cell')).toBe('FAIL');
    expect(outcome.behaviorOutcome).toBe('BUG');
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.failingCheckIds).toEqual(['doctor.environment.cell']);
  });

  it('maps an authority-unavailable dimension negative to UNUSABLE and HARNESS_BLOCKED', () => {
    for (const checkId of [
      'doctor.bridge.available',
      'doctor.bridge.document',
      'doctor.state.scenegraph',
    ]) {
      const outcome = runDoctor({ checks: withFact(doctorFacts(), checkId, { matched: false }) });
      expect(statusOf(outcome, checkId)).toBe('UNUSABLE');
      expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
      expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
      expect(outcome.record).not.toBeNull();
    }
  });

  it('maps every non-current authority state to UNUSABLE', () => {
    for (const authorityState of [
      'ambiguous',
      'incomplete',
      'malformed',
      'missing',
      'stale',
      'torn',
      'unsupported',
    ] as const) {
      const outcome = runDoctor({
        checks: withFact(doctorFacts(), 'doctor.bridge.cursor', { authorityState, matched: null }),
      });
      expect(statusOf(outcome, 'doctor.bridge.cursor')).toBe('UNUSABLE');
      expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    }
  });

  it('maps a missing delivered fact to UNUSABLE, never PASS or FAIL', () => {
    const outcome = runDoctor({
      checks: doctorFacts().filter((fact) => fact.checkId !== 'doctor.bridge.frozen'),
    });
    expect(statusOf(outcome, 'doctor.bridge.frozen')).toBe('UNUSABLE');
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
  });

  it('never lets diagnostic-only evidence satisfy a required check', () => {
    const outcome = runDoctor({ evidence: doctorEvidence('diagnostic-only') });
    expect(outcome.requiredChecks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(
      DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE.every(
        (id) => !(DOCTOR_COMMAND_REQUIRED_EVIDENCE as readonly string[]).includes(id),
      ),
    ).toBe(true);
  });
});

// ── Production-absence semantics ─────────────────────────────────────────────

describe('[P7-B2-D2] production-absence explicit-status semantics', () => {
  it('maps a seam present in the emitted artifact to FAIL and BUG', () => {
    const outcome = runProduction({ checks: productionFacts({ artifactClean: false }) });
    expect(statusOf(outcome, 'production.artifact-absence')).toBe('FAIL');
    expect(outcome.behaviorOutcome).toBe('BUG');
    expect(outcome.finalOutcome).toBe('BUG');
  });

  it('maps a live browser seam on the initial load to FAIL and BUG', () => {
    const outcome = runProduction({ checks: productionFacts({ initialClean: false }) });
    expect(statusOf(outcome, 'production.browser-absence.initial')).toBe('FAIL');
    expect(outcome.behaviorOutcome).toBe('BUG');
  });

  it('maps a live browser seam on the reload to FAIL and BUG', () => {
    const outcome = runProduction({ checks: productionFacts({ reloadClean: false }) });
    expect(statusOf(outcome, 'production.browser-absence.reload')).toBe('FAIL');
    expect(outcome.behaviorOutcome).toBe('BUG');
  });

  it('maps an unresolved requested chunk to UNUSABLE authority and HARNESS_BLOCKED', () => {
    const outcome = runProduction({ checks: productionFacts({ unresolvedChunks: 2 }) });
    expect(statusOf(outcome, 'production.chunk-reconciliation')).toBe('UNUSABLE');
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
  });

  it('maps a missing browser observation fact to UNUSABLE, never a vacuous PASS', () => {
    const outcome = runProduction({
      checks: productionFacts().filter(
        (fact) => fact.checkId !== 'production.browser-absence.reload',
      ),
    });
    expect(statusOf(outcome, 'production.browser-absence.reload')).toBe('UNUSABLE');
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
  });

  it('never lets diagnostic-only production evidence satisfy a required check', () => {
    const outcome = runProduction({ evidence: productionEvidence('diagnostic-only') });
    expect(outcome.requiredChecks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE).toEqual(['production.screenshot']);
  });
});

// ── External, cleanup, and pre-authority boundaries ──────────────────────────

describe('[P7-B2-D2] external, cleanup, and pre-authority boundaries', () => {
  it('preserves a PASS behavior verdict when cleanup fails and only converts the final outcome', () => {
    const outcome = runProduction({ cleanupSucceeded: false });
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.record).not.toBeNull();
  });

  it('does not let a later external failure erase a BUG behavior verdict', () => {
    const outcome = runDoctor({
      checks: withFact(doctorFacts(), 'doctor.title', { matched: false }),
      environmentFailure: true,
    });
    expect(outcome.behaviorOutcome).toBe('BUG');
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('keeps behavior and final outcomes separate under an external failure', () => {
    const outcome = runDoctor({ environmentFailure: true });
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('fabricates no check, no record, and a null behavior verdict for a pre-authority external failure', () => {
    const outcome = executeProductionAbsenceCommandContext({
      commandAuthority: {
        ...PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
        schemaVersion: 99,
      },
      checks: [],
      evidence: [],
      environmentFailure: true,
      cleanupSucceeded: true,
    });
    expect(outcome.authoritative).toBe(false);
    expect(outcome.preauthority).toBe(true);
    expect(outcome.behaviorOutcome).toBeNull();
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.requiredChecks).toEqual([]);
    expect(outcome.record).toBeNull();
    expect(codes(outcome)).toContain('COMMAND_AUTHORITY_UNTRUSTWORTHY');
  });
});

// ── Fail-closed authority boundaries ─────────────────────────────────────────

describe('[P7-B2-D2] fail-closed authority boundaries', () => {
  it('refuses a foreign command authority pre-authority with no fabricated check', () => {
    const outcome = runDoctor({ commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY });
    expect(outcome.authoritative).toBe(false);
    expect(outcome.preauthority).toBe(true);
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.requiredChecks).toEqual([]);
    expect(outcome.record).toBeNull();
    expect(codes(outcome)).toContain('COMMAND_AUTHORITY_UNTRUSTWORTHY');
    expect(outcome.commandIssues.map((entry) => entry.code)).toContain(
      'COMMAND_CONTEXT_AUTHORITY_FINGERPRINT_MISMATCH',
    );
  });

  it('refuses a stale command authority schema', () => {
    const outcome = runDoctor({
      commandAuthority: { ...DOCTOR_COMMAND_STATUS_AUTHORITY, schemaVersion: 6 },
    });
    expect(outcome.authoritative).toBe(false);
    expect(outcome.record).toBeNull();
    expect(outcome.commandIssues.map((entry) => entry.code)).toContain(
      'COMMAND_CONTEXT_AUTHORITY_SCHEMA_UNSUPPORTED',
    );
  });

  it('refuses a malformed or id-mismatched command authority', () => {
    const nonObject = runDoctor({
      commandAuthority: null as unknown as CommandStatusAuthority,
    });
    expect(nonObject.authoritative).toBe(false);
    expect(nonObject.record).toBeNull();
    expect(codes(nonObject)).toContain('COMMAND_AUTHORITY_UNTRUSTWORTHY');

    const wrongId = runDoctor({
      commandAuthority: { ...DOCTOR_COMMAND_STATUS_AUTHORITY, commandAuthorityId: 'doctor-v6' },
    });
    expect(wrongId.commandIssues.map((entry) => entry.code)).toContain(
      'COMMAND_CONTEXT_AUTHORITY_ID_MISMATCH',
    );
  });

  it('refuses a mixed command authority that carries compiled-profile identity', () => {
    const mixed = {
      ...DOCTOR_COMMAND_STATUS_AUTHORITY,
      resolvedProfileFingerprint: 'a'.repeat(64),
    } as unknown as CommandStatusAuthority;
    const outcome = runDoctor({ commandAuthority: mixed });
    expect(outcome.authoritative).toBe(false);
    expect(outcome.preauthority).toBe(true);
    expect(outcome.behaviorOutcome).toBeNull();
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.requiredChecks).toEqual([]);
    expect(outcome.record).toBeNull();
    expect(codes(outcome)).toEqual(['COMMAND_AUTHORITY_MIXED']);
  });

  it('fails a mixed delivered fact closed to UNUSABLE for its declared check', () => {
    const mixedFact = {
      ...doctorFacts()[0],
      resolvedProfileFingerprint: 'a'.repeat(64),
    } as unknown as CommandCheckFact;
    const checks = [mixedFact, ...doctorFacts().slice(1)];
    const outcome = runDoctor({ checks });
    expect(statusOf(outcome, 'doctor.route')).toBe('UNUSABLE');
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.requiredChecks.some((check) => check.status === 'PASS')).toBe(true);
  });

  it('rejects an unknown command context on the consumed authority', () => {
    const outcome = runDoctor({
      commandAuthority: {
        ...DOCTOR_COMMAND_STATUS_AUTHORITY,
        command: 'diagnostic',
      } as unknown as CommandStatusAuthority,
    });
    expect(outcome.authoritative).toBe(false);
    expect(outcome.record).toBeNull();
    expect(codes(outcome)).toContain('COMMAND_AUTHORITY_UNTRUSTWORTHY');
  });
});

// ── Evidence and context identity ────────────────────────────────────────────

describe('[P7-B2-D2] evidence and context identity', () => {
  it('accepts the produced command checks and rejects a foreign or mixed check', () => {
    const doctor = runDoctor();
    expect(validateCommandExecutionChecks(DOCTOR_COMMAND_AUTHORITY, doctor.requiredChecks).ok).toBe(
      true,
    );

    const production = runProduction();
    const foreign = validateCommandExecutionChecks(
      DOCTOR_COMMAND_AUTHORITY,
      production.requiredChecks,
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.issues.map((entry) => entry.code)).toContain('COMMAND_CHECK_FOREIGN_CONTEXT');

    const doctorCheck = doctor.requiredChecks[0] as unknown as Record<string, unknown>;
    const mixed = validateCommandExecutionChecks(DOCTOR_COMMAND_AUTHORITY, [
      { ...doctorCheck, resolvedProfileFingerprint: 'b'.repeat(64) },
    ]);
    expect(mixed.ok).toBe(false);
    expect(mixed.issues.map((entry) => entry.code)).toContain('COMMAND_CHECK_MIXED_CONTEXT');
  });

  it('binds every produced check to exactly one context and the declared authority', () => {
    for (const [outcome, declaration, authority, evidence] of [
      [runDoctor(), DOCTOR_COMMAND_AUTHORITY, DOCTOR_COMMAND_STATUS_AUTHORITY, doctorEvidence()],
      [
        runProduction(),
        PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
        PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
        productionEvidence(),
      ],
    ] as const) {
      for (const check of outcome.requiredChecks) {
        expect(validateCheckContextSeparation(check).ok).toBe(true);
        expect(check.commandAuthority).toEqual(authority);
        expect(validateCommandContextResult(declaration, check, evidence).ok).toBe(true);
      }
    }
  });

  it('refuses a produced check that consumed diagnostic-only or undeclared evidence', () => {
    const doctor = runDoctor();
    const check = doctor.requiredChecks[0] as unknown as Record<string, unknown>;
    const stripped = { ...check, evidenceIds: [] };
    expect(
      validateCommandContextResult(DOCTOR_COMMAND_AUTHORITY, stripped, doctorEvidence()).issues.map(
        (entry) => entry.code,
      ),
    ).toContain('COMMAND_CONTEXT_EVIDENCE_MISSING');
    const undeclared = { ...check, evidenceIds: ['doctor.untrusted'] };
    expect(
      validateCommandContextResult(
        DOCTOR_COMMAND_AUTHORITY,
        undeclared,
        doctorEvidence(),
      ).issues.map((entry) => entry.code),
    ).toContain('COMMAND_CONTEXT_EVIDENCE_UNDECLARED');
  });
});

// ── Strict reader discrimination (joint D1+D2) ───────────────────────────────

describe('[P7-B2-D1+D2] joint strict reader discrimination', () => {
  it('accepts the command record and rejects every mixed, legacy, or unknown variant', () => {
    const record = runDoctor().record;
    if (record === null) throw new Error('expected a command record');

    const mixedProfile = readFinalRecord({
      ...(record as unknown as Record<string, unknown>),
      resolvedProfileFingerprint: 'a'.repeat(64),
    });
    expect(mixedProfile.kind).not.toBe('command-v4');
    expect(['invalid', 'mixed', 'unknown']).toContain(mixedProfile.kind);

    const mixedBoolean = readFinalRecord({
      ...(record as unknown as Record<string, unknown>),
      checks: [
        { ...(record.checks[0] as unknown as Record<string, unknown>), passed: true },
        ...record.checks.slice(1),
      ],
    });
    expect(mixedBoolean.kind).toBe('mixed');

    const legacy = readFinalRecord({
      schemaVersion: 3,
      command: 'doctor',
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: [{ checkId: 'doctor.route', passed: true }],
    });
    expect(legacy.legacy).toBe(true);
    expect(legacy.kind).toBe('legacy-v3');
    expect(legacy.ambiguous).toBe(true);

    const unknown = readFinalRecord({
      schemaVersion: 99,
      command: 'doctor',
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: record.checks,
    });
    expect(unknown.kind).toBe('unknown');
    expect(unknown.kind).not.toBe('command-v4');
  });

  it('keeps the command record distinct from a compiled-profile child record shape', () => {
    const record = runDoctor().record;
    if (record === null) throw new Error('expected a command record');
    // A compiled-profile child record never carries a command authority.
    const childLike = {
      schemaVersion: 4,
      runId: 'r',
      caseId: 'c',
      materializationFingerprint: 'm',
      planFingerprint: 'p',
      profile: 'x',
      observationId: null,
      resolvedProfileFingerprint: 'a'.repeat(64),
      componentFingerprints: {},
      actionCycles: [],
      requiredChecks: [],
      nestedProjections: [],
    };
    expect(readFinalRecord(childLike).kind).not.toBe('command-v4');
    expect(readFinalRecord(record).kind).toBe('command-v4');
  });
});

// ── Inactive import and write boundary ───────────────────────────────────────

describe('[P7-B2-D2] current import and write boundary', () => {
  const NEW_MODULES = [
    'src/orchestration/command-execution.ts',
    'src/orchestration/doctor-command-execution.ts',
    'src/orchestration/production-absence-command-execution.ts',
  ];

  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  it('is reached only through the final façade, never by an executor, writer, reader, runtime, or classifier module', () => {
    const markers = [
      'orchestration/command-execution',
      'orchestration/doctor-command-execution',
      'orchestration/production-absence-command-execution',
      'executeDoctorCommandContext',
      'executeProductionAbsenceCommandContext',
      'executeCommandContext',
      'validateCommandExecutionChecks',
    ];
    // The two current command entries consume the command-execution input *type*
    // only; the façade owns the command orchestration call.
    for (const relative of ['src/cli/doctor.ts', 'src/cli/production-absence.ts']) {
      const text = source(relative);
      expect(text, relative).toContain(
        "import type { CommandExecutionContextInput } from '../orchestration/command-execution';",
      );
      for (const marker of markers) {
        if (marker === 'orchestration/command-execution') continue;
        expect(text, `module ${relative} references ${marker}`).not.toContain(marker);
      }
    }
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/runtime/outcomes.ts',
      'src/evidence/writer.ts',
      'src/evidence/reader.ts',
      'src/evidence/public-dto.ts',
      'src/cli/main.ts',
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
    ]) {
      const text = source(relative);
      for (const marker of markers) {
        expect(text, `module ${relative} references ${marker}`).not.toContain(marker);
      }
    }
  });

  it('is not exported from the public barrel', () => {
    const barrel = source('src/index.ts');
    for (const marker of [
      'orchestration/command-execution',
      'executeDoctorCommandContext',
      'executeProductionAbsenceCommandContext',
    ]) {
      expect(barrel, `barrel exports ${marker}`).not.toContain(marker);
    }
  });

  it('reaches no active executor, Oracle, CLI, browser, writer, or classifier module', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toMatch(/from '\.\.\/(cli|browser|oracles|evidence)\//);
      expect(text, relative).not.toMatch(/from '\.\.\/runtime\/(outcomes|execute|action-cycle)/);
      expect(text, relative).not.toContain('contracts/execution');
      expect(text, relative).not.toContain('harnessInvalid');
    }
  });

  it('never consumes a compiled profile or execution envelope and never recompiles', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toContain('execution-materialization');
      expect(text, relative).not.toContain('MaterializedExecutionEnvelope');
      expect(text, relative).not.toContain('ResolvedCorrectnessProfile');
      expect(text, relative).not.toContain('planCase');
      expect(text, relative).not.toContain('loadCatalogueBundle');
      expect(text, relative).not.toContain('compilePlan');
    }
  });

  it('writes no record on the active evidence path', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toContain('node:fs');
      expect(text, relative).not.toContain('writePublicRunRecord');
      expect(text, relative).not.toContain('writeExclusiveRecordFile');
      expect(text, relative).not.toContain("from '../evidence/");
    }
  });

  it('retains the boolean/v3 baseline off the current path', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
    expect(source('src/runtime/outcomes.ts')).toContain('harnessInvalid');
  });
});
