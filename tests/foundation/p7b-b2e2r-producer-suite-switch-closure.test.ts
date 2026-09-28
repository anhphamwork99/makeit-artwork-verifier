import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  adaptDoctorCommandFacts,
  DOCTOR_LIVE_FACT_ISSUE_CODES,
  type DoctorCommandDeclarationView,
} from '../../src/adapters/doctor-command-live-facts';
import {
  adaptProductionAbsenceCommandFacts,
  PRODUCTION_ABSENCE_LIVE_FACT_ISSUE_CODES,
  type ProductionAbsenceCommandDeclarationView,
} from '../../src/adapters/production-absence-command-live-facts';
import {
  DOCTOR_RAW_AUTHORITY_STATES,
  projectDoctorRawCommandFacts,
  type DoctorRawObservation,
} from '../../src/browser/doctor';
import {
  projectProductionAbsenceRawCommandFacts,
  PRODUCTION_ABSENCE_RAW_AUTHORITY_STATES,
} from '../../src/browser/production-absence';
import {
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
} from '../../src/commands/doctor-command-context';
import {
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
} from '../../src/commands/production-absence-command-context';
import {
  assembleFinalSuiteRecordV2,
  FINAL_SUITE_CHILD_KEYS,
  FINAL_SUITE_RECORD_KEYS,
  FINAL_SUITE_RECORD_LABEL,
  FINAL_SUITE_RECORD_SCHEMA_VERSION,
  readFinalSuiteRecord,
  validateFinalSuiteRecordV2,
  type FinalSuiteRecordV2,
} from '../../src/contracts/final-suite-record';
import { PRODUCTION_ABSENCE_ROUTE } from '../../src/contracts/production-absence';
import { readFinalSuiteRecordFile } from '../../src/evidence/final-suite-reader';
import {
  FINAL_SUITE_RECORD_FILE_NAME,
  readBackFinalSuiteRecordV2,
  writeFinalSuiteRecordV2,
} from '../../src/evidence/final-suite-writer';
import { executeDoctorCommandContext } from '../../src/orchestration/doctor-command-execution';
import {
  FINAL_SWITCH_E2R_WRITE_SET,
  FINAL_SWITCH_E3_ROLLBACK_BASELINE,
  FINAL_SWITCH_E3_ROLLBACK_FILES,
  FINAL_SWITCH_E3_WRITE_SET,
  FINAL_SWITCH_FINAL_MODULE_IMPORTERS,
  FINAL_SWITCH_MANIFEST,
  finalSwitchManifestIssues,
  finalSwitchModuleSpecifiers,
  type FinalSwitchManifestView,
} from '../../src/orchestration/final-switch-manifest';
import { executeProductionAbsenceCommandContext } from '../../src/orchestration/production-absence-command-execution';
import { resolveToolkitRoot } from '../../src/runtime/paths';

const skillRoot = resolveToolkitRoot();
const repoRoot = path.resolve(skillRoot, '..', '..', '..');

// ── Raw fact forbidden-field scan ────────────────────────────────────────────

const FORBIDDEN_RAW_KEYS = ['passed', 'harnessInvalid', 'status', 'outcome', 'profile'];

function forbiddenKeys(value: unknown, found: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RAW_KEYS.includes(key)) found.push(key);
    forbiddenKeys(entry, found);
  }
  return found;
}

/** The legacy authority keys the aggregate must never carry (the V1 `profile`
 * discriminant is a safe operational field, not a correctness profile). */
const FORBIDDEN_AGGREGATE_KEYS = [
  'passed',
  'harnessInvalid',
  'status',
  'outcome',
  'resolvedProfile',
  'resolvedProfileFingerprint',
  'actionCycleRef',
];

function forbiddenAggregateKeys(value: unknown, found: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_AGGREGATE_KEYS.includes(key)) found.push(key);
    forbiddenAggregateKeys(entry, found);
  }
  return found;
}

function passDoctorObservation(): DoctorRawObservation {
  return {
    pageReachable: true,
    routeMatches: true,
    titleMatches: true,
    finalUrl: 'http://127.0.0.1:4321/artwork/editor',
    title: 'Editor - Artwork',
    bridgePresent: true,
    inspectionPresent: true,
    documentIdentityPresent: true,
    observedDocumentId: 'doc-1',
    observedDocumentEpoch: 1,
    observedVersion: 5,
    expectedVersion: 5,
    observedMethods: [
      'doctor',
      'snapshot',
      'elements',
      'geometry',
      'raster',
      'cursor',
      'waitForChange',
      'waitForIdle',
    ],
    methodsExact: true,
    bridgeFrozen: true,
    cursorWellFormed: true,
    cursorCurrent: true,
    cursorStable: true,
    waiterPresent: true,
    waiterBounded: true,
    geometryOk: true,
    rasterOk: true,
    mutationDetected: false,
    stageMounted: true,
    missingLayers: [],
    layoutCount: 3,
    minLayouts: 2,
    scenegraphPresent: true,
    scenegraphInSync: true,
    environmentObserved: true,
    environmentMismatchCount: 0,
    environmentCellId: 'chromium-desktop',
    browserCloseError: null,
  };
}

function absenceAttempt(
  attempt: 'initial' | 'reload',
  overrides: Partial<{
    editorMounted: boolean;
    observationGlobalType: string;
    signalAnchorSlotPresent: boolean;
    requestedPaths: readonly string[];
  }> = {},
) {
  return {
    attempt,
    httpStatus: 200,
    finalUrl: `http://127.0.0.1:4321${PRODUCTION_ABSENCE_ROUTE}`,
    title: 'Editor - Artwork',
    observationGlobalType: overrides.observationGlobalType ?? 'undefined',
    setupGlobalType: 'undefined',
    brokerSlotPresent: false,
    setupAnchorSlotPresent: false,
    documentAnchorSlotPresent: false,
    signalAnchorSlotPresent: overrides.signalAnchorSlotPresent ?? false,
    requestedPaths: overrides.requestedPaths ?? ['/_next/static/chunks/app/page.js'],
    editorMounted: overrides.editorMounted ?? true,
    requestedResourceCount: 1,
  };
}

function passAbsenceRaw() {
  return projectProductionAbsenceRawCommandFacts({
    scan: { clean: true, hits: [], scannedFiles: 12 },
    attempts: [absenceAttempt('initial'), absenceAttempt('reload')],
    chunkReconciliation: { resolved: 1, unresolved: [] },
    buildOrStartFailed: false,
    browserCloseError: null,
    cleanupSucceeded: true,
  });
}

const DOCTOR_DECLARATION: DoctorCommandDeclarationView = {
  authority: DOCTOR_COMMAND_STATUS_AUTHORITY,
  requiredCheckIds: DOCTOR_COMMAND_CHECKS.map((check) => check.checkId),
  requiredEvidenceIds: [...DOCTOR_COMMAND_REQUIRED_EVIDENCE],
  diagnosticEvidenceIds: [...DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE],
};

const PRODUCTION_DECLARATION: ProductionAbsenceCommandDeclarationView = {
  authority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  requiredCheckIds: PRODUCTION_ABSENCE_COMMAND_CHECKS.map((check) => check.checkId),
  requiredEvidenceIds: [...PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE],
  diagnosticEvidenceIds: [...PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE],
};

function adaptDoctor(raw: Parameters<typeof adaptDoctorCommandFacts>[0]['raw']) {
  return adaptDoctorCommandFacts({ declaration: DOCTOR_DECLARATION, raw });
}

function adaptAbsence(raw: Parameters<typeof adaptProductionAbsenceCommandFacts>[0]['raw']) {
  return adaptProductionAbsenceCommandFacts({ declaration: PRODUCTION_DECLARATION, raw });
}

describe('[P7-B2-E2R] additive raw Doctor/production-absence fact APIs', () => {
  it('exposes only named observations with no passed/harnessInvalid/status/outcome/profile', () => {
    const doctor = projectDoctorRawCommandFacts(passDoctorObservation());
    const absence = passAbsenceRaw();
    expect(forbiddenKeys(doctor)).toEqual([]);
    expect(forbiddenKeys(absence)).toEqual([]);
    expect(doctor.command).toBe('doctor');
    expect(absence.command).toBe('production-absence');
    // A raw observation that could not be established is never a fabricated pass.
    const unavailable = projectDoctorRawCommandFacts({
      ...passDoctorObservation(),
      pageReachable: false,
      inspectionPresent: false,
      bridgePresent: false,
      environmentObserved: false,
    });
    for (const check of unavailable.checks) {
      if (check.authority !== 'current') expect(check.comparison).toBeNull();
    }
  });

  it('covers every declared Doctor check and evidence role exactly once', () => {
    const doctor = projectDoctorRawCommandFacts(passDoctorObservation());
    expect(doctor.checks.map((check) => check.checkId)).toEqual(
      DOCTOR_COMMAND_CHECKS.map((check) => check.checkId),
    );
    expect(doctor.evidence.map((entry) => entry.evidenceId).sort()).toEqual(
      [...DOCTOR_COMMAND_REQUIRED_EVIDENCE, ...DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE].sort(),
    );
    for (const check of doctor.checks) {
      expect(DOCTOR_RAW_AUTHORITY_STATES).toContain(check.authority);
    }
  });

  it('covers every declared production-absence check and evidence role exactly once', () => {
    const absence = passAbsenceRaw();
    expect(absence.checks.map((check) => check.checkId)).toEqual(
      PRODUCTION_ABSENCE_COMMAND_CHECKS.map((check) => check.checkId),
    );
    expect(absence.evidence.map((entry) => entry.evidenceId).sort()).toEqual(
      [
        ...PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
        ...PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE,
      ].sort(),
    );
    for (const check of absence.checks) {
      expect(PRODUCTION_ABSENCE_RAW_AUTHORITY_STATES).toContain(check.authority);
    }
  });
});

describe('[P7-B2-E2R] command live-fact adapters map raw facts to B1-G facts', () => {
  it('maps the raw Doctor facts to a trustworthy PASS command context without legacy arrays', () => {
    const adaptation = adaptDoctor(projectDoctorRawCommandFacts(passDoctorObservation()));
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    expect(adaptation.input.checks).toHaveLength(DOCTOR_COMMAND_CHECKS.length);
    for (const check of adaptation.input.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'harnessInvalid')).toBe(false);
    }
    const outcome = executeDoctorCommandContext(adaptation.input);
    expect(outcome.authoritative).toBe(true);
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('PASS');
    expect(outcome.record?.command).toBe('doctor');
  });

  it('maps an environment-cell mismatch to ENVIRONMENT_FAILURE, never PASS', () => {
    const adaptation = adaptDoctor(
      projectDoctorRawCommandFacts({
        ...passDoctorObservation(),
        environmentMismatchCount: 1,
      }),
    );
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const outcome = executeDoctorCommandContext(adaptation.input);
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.record).not.toBeNull();
  });

  it('maps the raw production-absence facts to a trustworthy PASS command context', () => {
    const adaptation = adaptAbsence(passAbsenceRaw());
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const outcome = executeProductionAbsenceCommandContext(adaptation.input);
    expect(outcome.authoritative).toBe(true);
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.record?.command).toBe('production-absence');
  });

  it('never PASSes a non-hydrated production document (authority incomplete)', () => {
    const raw = projectProductionAbsenceRawCommandFacts({
      scan: { clean: true, hits: [], scannedFiles: 12 },
      attempts: [
        absenceAttempt('initial', { editorMounted: false }),
        absenceAttempt('reload', { editorMounted: false }),
      ],
      chunkReconciliation: { resolved: 1, unresolved: [] },
      buildOrStartFailed: false,
      browserCloseError: null,
      cleanupSucceeded: true,
    });
    expect(raw.externalFailure).toBe(true);
    const adaptation = adaptAbsence(raw);
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const outcome = executeProductionAbsenceCommandContext(adaptation.input);
    expect(outcome.finalOutcome).not.toBe('PASS');
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('fails closed on a raw fact set that does not cover the declaration', () => {
    const doctor = projectDoctorRawCommandFacts(passDoctorObservation());
    const missing = { ...doctor, checks: doctor.checks.slice(1) };
    const doctorAdaptation = adaptDoctor(missing);
    expect(doctorAdaptation.ok).toBe(false);
    if (!doctorAdaptation.ok) {
      expect(doctorAdaptation.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
      );
    }
    const absence = passAbsenceRaw();
    const absenceAdaptation = adaptAbsence({
      ...absence,
      command: 'doctor' as unknown as 'production-absence',
    });
    expect(absenceAdaptation.ok).toBe(false);
    if (!absenceAdaptation.ok) {
      expect(absenceAdaptation.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_COMMAND_MISMATCH',
      );
    }
    expect(DOCTOR_LIVE_FACT_ISSUE_CODES).toContain('RAW_FACTS_AUTHORITY_UNKNOWN');
    expect(PRODUCTION_ABSENCE_LIVE_FACT_ISSUE_CODES).toContain('RAW_FACTS_COMPARISON_INVALID');
  });

  it('refuses duplicate, extra, and malformed checks on both adapters', () => {
    const doctor = projectDoctorRawCommandFacts(passDoctorObservation());
    const duplicateCheck = adaptDoctor({
      ...doctor,
      checks: [...doctor.checks, doctor.checks[0]],
    });
    expect(duplicateCheck.ok).toBe(false);
    if (!duplicateCheck.ok) {
      expect(duplicateCheck.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
      );
    }
    const extraCheck = adaptDoctor({
      ...doctor,
      checks: [
        ...doctor.checks,
        { checkId: 'doctor.undeclared', authority: 'current', comparison: true, observed: {} },
      ],
    });
    expect(extraCheck.ok).toBe(false);
    if (!extraCheck.ok) {
      expect(extraCheck.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
      );
    }

    const absence = passAbsenceRaw();
    const absenceDuplicate = adaptAbsence({
      ...absence,
      checks: [...absence.checks, absence.checks[0]],
    });
    expect(absenceDuplicate.ok).toBe(false);
    if (!absenceDuplicate.ok) {
      expect(absenceDuplicate.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
      );
    }
    const absenceExtra = adaptAbsence({
      ...absence,
      checks: [
        ...absence.checks,
        { checkId: 'production.undeclared', authority: 'current', comparison: true, observed: {} },
      ],
    });
    expect(absenceExtra.ok).toBe(false);
    if (!absenceExtra.ok) {
      expect(absenceExtra.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_CHECK_COVERAGE_MISMATCH',
      );
    }
  });

  it('refuses duplicate, extra, and malformed evidence on both adapters', () => {
    const doctor = projectDoctorRawCommandFacts(passDoctorObservation());
    const duplicate = adaptDoctor({
      ...doctor,
      evidence: [...doctor.evidence, doctor.evidence[0]],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
      );
    }
    const extra = adaptDoctor({
      ...doctor,
      evidence: [
        ...doctor.evidence,
        { evidenceId: 'doctor.undeclared-evidence', availability: 'authoritative' },
      ],
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
      );
    }
    const malformed = adaptDoctor({
      ...doctor,
      evidence: [...doctor.evidence, { evidenceId: '', availability: 'authoritative' }],
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.issues.map((entry) => entry.code)).toContain('RAW_FACTS_EVIDENCE_MALFORMED');
    }

    const absence = passAbsenceRaw();
    const absenceDuplicate = adaptAbsence({
      ...absence,
      evidence: [...absence.evidence, absence.evidence[0]],
    });
    expect(absenceDuplicate.ok).toBe(false);
    if (!absenceDuplicate.ok) {
      expect(absenceDuplicate.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
      );
    }
    const absenceExtra = adaptAbsence({
      ...absence,
      evidence: [
        ...absence.evidence,
        { evidenceId: 'production.undeclared-evidence', availability: 'authoritative' },
      ],
    });
    expect(absenceExtra.ok).toBe(false);
    if (!absenceExtra.ok) {
      expect(absenceExtra.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_EVIDENCE_COVERAGE_MISMATCH',
      );
    }
    const absenceMalformed = adaptAbsence({
      ...absence,
      evidence: [...absence.evidence, { evidenceId: '', availability: 'authoritative' }],
    });
    expect(absenceMalformed.ok).toBe(false);
    if (!absenceMalformed.ok) {
      expect(absenceMalformed.issues.map((entry) => entry.code)).toContain(
        'RAW_FACTS_EVIDENCE_MALFORMED',
      );
    }
  });
});

// ── v4-bound suite aggregate contract, writer, reader ────────────────────────

const FINGERPRINT = 'a'.repeat(64);

function aggregatePayload(
  overrides: Partial<Parameters<typeof assembleFinalSuiteRecordV2>[0]> = {},
) {
  return {
    suiteExecutionId: 'p7b-e2r-suite-execution',
    suiteLineageId: 'p7b-e2r-suite-lineage',
    suiteId: 'representative' as const,
    suiteVersion: 1,
    suiteFingerprint: FINGERPRINT,
    profile: 'diagnostic' as const,
    execution: 'sequential-independent-runs' as const,
    repository: { commit: 'p7b-e2r-commit', dirty: true, lockfileDigest: 'p7b-e2r-lockfile' },
    declaredCaseCount: 1,
    executedCount: 1,
    canonicalOrder: [1],
    children: [
      {
        order: 1,
        caseId: 'p7b-e2r-case',
        request: 'layer-text-move.request.json',
        expectedOutcome: 'PASS' as const,
        runId: 'p7b-e2r-run-1',
        executionId: 'p7b-e2r-execution-1',
        parentSuiteExecutionId: 'p7b-e2r-suite-execution',
        suiteLineageId: 'p7b-e2r-suite-lineage',
        recordPresent: true,
        childRecordLabel: 'current-v4' as const,
        childRecordSchemaVersion: 4,
        childProfile: 'ordinary-text-v1',
        materializationFingerprint: FINGERPRINT,
        planFingerprint: FINGERPRINT,
        expectedMet: true,
        behaviorOutcome: 'PASS' as const,
        finalOutcome: 'PASS' as const,
        cleanupComplete: true,
        startedAt: '2026-09-20T00:00:00.000Z',
        endedAt: '2026-09-20T00:00:01.000Z',
        durationMs: 1000,
        runRecordRole: 'run-record' as const,
      },
    ],
    complete: true,
    stoppedEarly: false,
    stopReason: null,
    interrupted: false,
    aggregateStatus: 'PASS' as const,
    startedAt: '2026-09-20T00:00:00.000Z',
    endedAt: '2026-09-20T00:00:01.000Z',
    durationMs: 1000,
    detail: 'Suite representative@1: 1/1 children executed; aggregate PASS.',
    ...overrides,
  };
}

const createdRoots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p7b-b2e2r-'));
  createdRoots.push(root);
  return root;
}
afterAll(() => {
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

describe('[P7-B2-E2R] v4-bound suite aggregate schema version 2', () => {
  it('assembles a closed aggregate with its own discriminant and no legacy authority', () => {
    const assembled = assembleFinalSuiteRecordV2(aggregatePayload());
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const record: FinalSuiteRecordV2 = assembled.record;
    expect(record.schemaVersion).toBe(FINAL_SUITE_RECORD_SCHEMA_VERSION);
    expect(record.label).toBe(FINAL_SUITE_RECORD_LABEL);
    expect(record.children[0]?.childRecordSchemaVersion).toBe(4);
    expect(validateFinalSuiteRecordV2(record).ok).toBe(true);
    expect(Object.keys(record).sort()).toEqual([...FINAL_SUITE_RECORD_KEYS].sort());
    expect(Object.keys(record.children[0] as object).sort()).toEqual(
      [...FINAL_SUITE_CHILD_KEYS].sort(),
    );
    expect(forbiddenAggregateKeys(record)).toEqual([]);
  });

  it('rejects a record-bearing child that is not a strict-v4 child', () => {
    const bad = aggregatePayload({
      children: [
        {
          ...aggregatePayload().children[0],
          childRecordSchemaVersion: 3,
        },
      ],
    });
    const assembled = assembleFinalSuiteRecordV2(bad);
    expect(assembled.ok).toBe(false);
    if (!assembled.ok) {
      expect(assembled.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_CHILD_NOT_STRICT_V4',
      );
    }
    const legacyBoolean = aggregatePayload();
    const withPassed = {
      ...legacyBoolean,
      children: [{ ...legacyBoolean.children[0], passed: true }],
    };
    const rejected = assembleFinalSuiteRecordV2(withPassed as never);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_LEGACY_AUTHORITY_PRESENT',
      );
    }
  });

  it('refuses a non-canonical order and a duplicated child', () => {
    const nonCanonical = assembleFinalSuiteRecordV2(
      aggregatePayload({ canonicalOrder: [2], executedCount: 1 }),
    );
    expect(nonCanonical.ok).toBe(false);
    const duplicated = assembleFinalSuiteRecordV2(
      aggregatePayload({
        declaredCaseCount: 2,
        executedCount: 2,
        canonicalOrder: [1, 2],
        children: [aggregatePayload().children[0], { ...aggregatePayload().children[0], order: 2 }],
      }),
    );
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_CHILD_DUPLICATE',
      );
    }
  });

  it('refuses a child execution id aliased to its own or a sibling run id', () => {
    const ownAlias = aggregatePayload();
    const selfAliased = assembleFinalSuiteRecordV2({
      ...ownAlias,
      children: [{ ...ownAlias.children[0], executionId: ownAlias.children[0].runId }],
    });
    expect(selfAliased.ok).toBe(false);
    if (!selfAliased.ok) {
      expect(selfAliased.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_CHILD_EXECUTION_ALIASED',
      );
    }
    const two = aggregatePayload();
    const siblingAliased = assembleFinalSuiteRecordV2({
      ...two,
      declaredCaseCount: 2,
      executedCount: 2,
      canonicalOrder: [1, 2],
      children: [
        two.children[0],
        {
          ...two.children[0],
          order: 2,
          caseId: 'p7b-e2r-case-2',
          request: 'layer-text-move-second.request.json',
          runId: 'p7b-e2r-run-2',
          executionId: 'p7b-e2r-run-1',
        },
      ],
    });
    expect(siblingAliased.ok).toBe(false);
    if (!siblingAliased.ok) {
      expect(siblingAliased.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_CHILD_EXECUTION_ALIASED',
      );
    }
  });

  it('refuses an aggregate whose execution id aliases its lineage or a child from another suite', () => {
    const aliasedSuite = assembleFinalSuiteRecordV2(
      aggregatePayload({ suiteLineageId: 'p7b-e2r-suite-execution' }),
    );
    expect(aliasedSuite.ok).toBe(false);
    if (!aliasedSuite.ok) {
      expect(aliasedSuite.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_LINEAGE_MISMATCH',
      );
    }
    const parentMismatch = aggregatePayload();
    const foreignParent = assembleFinalSuiteRecordV2({
      ...parentMismatch,
      children: [
        { ...parentMismatch.children[0], parentSuiteExecutionId: 'p7b-e2r-other-execution' },
      ],
    });
    expect(foreignParent.ok).toBe(false);
    if (!foreignParent.ok) {
      expect(foreignParent.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_LINEAGE_MISMATCH',
      );
    }
    const lineageMismatch = aggregatePayload();
    const foreignLineage = assembleFinalSuiteRecordV2({
      ...lineageMismatch,
      children: [{ ...lineageMismatch.children[0], suiteLineageId: 'p7b-e2r-other-lineage' }],
    });
    expect(foreignLineage.ok).toBe(false);
    if (!foreignLineage.ok) {
      expect(foreignLineage.issues.map((entry) => entry.code)).toContain(
        'SUITE_RECORD_LINEAGE_MISMATCH',
      );
    }
  });

  it('writes exclusively with fsync, refuses overwrite, and self-reads back exactly', () => {
    const root = tempRoot();
    const written = writeFinalSuiteRecordV2({ payload: aggregatePayload(), evidenceRoot: root });
    expect(written.path).toBe(path.join(root, FINAL_SUITE_RECORD_FILE_NAME));
    const read = readFinalSuiteRecordFile(written.path);
    expect(read.kind).toBe('suite-v2');
    expect(read.current).toBe(true);
    expect(readBackFinalSuiteRecordV2(written.path, written.serialized).schemaVersion).toBe(2);
    expect(() =>
      writeFinalSuiteRecordV2({ payload: aggregatePayload(), evidenceRoot: root }),
    ).toThrow();
    expect(() => readBackFinalSuiteRecordV2(written.path, 'tampered')).toThrow();
  });

  it('applies the recursive guard to the exact serialized bytes', () => {
    const root = tempRoot();
    expect(() =>
      writeFinalSuiteRecordV2({
        payload: aggregatePayload({ detail: 'leaked /Users/private/secret' }),
        evidenceRoot: root,
        forbiddenPaths: ['/Users/private'],
      }),
    ).toThrow();
    expect(existsSync(path.join(root, FINAL_SUITE_RECORD_FILE_NAME))).toBe(false);
  });

  it('treats a historical schema-1 suite record as labelled read-only legacy', () => {
    const root = tempRoot();
    const target = path.join(root, 'legacy-suite.json');
    writeFileSync(
      target,
      `${JSON.stringify({ schemaVersion: 1, command: 'diagnostic', children: [], aggregateStatus: 'PASS' })}\n`,
      'utf8',
    );
    const read = readFinalSuiteRecordFile(target);
    expect(read.kind).toBe('legacy-suite-v1');
    expect(read.legacy).toBe(true);
    expect(read.current).toBe(false);
    const parsed = readFinalSuiteRecord({ schemaVersion: 1, command: 'diagnostic' });
    expect(parsed.kind).toBe('legacy-suite-v1');
  });
});

// ── Frozen E3 switch manifest closure ────────────────────────────────────────

function repositoryView(): FinalSwitchManifestView {
  const read = (dir: string, prefix: string) => {
    const files: { path: string; text: string }[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(target);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        files.push({
          path: `${prefix}/${path.relative(dir, target)}`,
          text: readFileSync(target, 'utf8'),
        });
      }
    };
    walk(dir);
    return files;
  };
  return {
    sourceFiles: read(path.join(skillRoot, 'src'), 'src'),
    testFiles: read(path.join(skillRoot, 'tests'), 'tests'),
    fixturePaths: FINAL_SWITCH_MANIFEST.historicalFixtures.filter((relative) =>
      existsSync(path.join(repoRoot, relative)),
    ),
  };
}

function codes(view: FinalSwitchManifestView): string[] {
  return finalSwitchManifestIssues(view).map((entry) => entry.code);
}

/**
 * Mirrors the manifest's own `src/`-relative specifier resolution over a test
 * file, using the exported specifier extractor, so the test reconciles the
 * real discovered test set with the frozen inventory instead of trusting it.
 */
function testEdgeTargets(fromPath: string, text: string): readonly string[] {
  const segments = fromPath.split('/').slice(0, -1);
  const targets = new Set<string>();
  for (const specifier of finalSwitchModuleSpecifiers(text)) {
    if (!specifier.startsWith('.')) continue;
    const parts = [...segments];
    for (const part of specifier.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    targets.add(parts.join('/').replace(/\.(ts|js|mjs|cjs)$/, ''));
  }
  return [...targets];
}

/**
 * Recomputes the real discovered changed-module test set from the repository
 * view exactly as the audit does, excluding every already-classified test.
 */
function discoveredChangedModuleTests(view: FinalSwitchManifestView): readonly string[] {
  const strip = (path: string): string => path.replace(/\.ts$/, '');
  const targets = new Set(
    [
      ...FINAL_SWITCH_MANIFEST.oldAuthorityModules,
      ...FINAL_SWITCH_MANIFEST.activeCliEntries,
      ...FINAL_SWITCH_MANIFEST.dynamicDispatchFiles,
      ...FINAL_SWITCH_MANIFEST.e3WriteSet.filter((path) => path.startsWith('src/')),
    ].map(strip),
  );
  const classified = new Set([
    ...FINAL_SWITCH_MANIFEST.migratedTests,
    ...FINAL_SWITCH_MANIFEST.replacedArchitectureTests,
    ...FINAL_SWITCH_MANIFEST.historicalFixtureTests,
    ...FINAL_SWITCH_MANIFEST.retainedTestSupport,
  ]);
  return view.testFiles
    .filter((file) => testEdgeTargets(file.path, file.text).some((target) => targets.has(target)))
    .map((file) => file.path)
    .filter((path) => !classified.has(path))
    .sort();
}

describe('[P7-B2-E2R] corrected switch closure manifest', () => {
  it('passes its own closure audit against the real repository view', () => {
    expect(codes(repositoryView())).toEqual([]);
  });

  it('names the complete Diagnostic runtime/Oracle and command producer closure', () => {
    const producers = [
      ...FINAL_SWITCH_MANIFEST.diagnosticProducerFiles,
      ...FINAL_SWITCH_MANIFEST.commandProducerFiles,
    ];
    for (const required of [
      'src/runtime/action-cycle.ts',
      'src/runtime/execute-plan.ts',
      'src/oracles/evaluate.ts',
      'src/oracles/geometry.ts',
      'src/oracles/image.ts',
      'src/oracles/crossword.ts',
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
      'src/adapters/doctor-command-live-facts.ts',
      'src/adapters/production-absence-command-live-facts.ts',
    ]) {
      expect(producers, `producer closure names ${required}`).toContain(required);
    }
  });

  it('proves all seven Diagnostic primitive family→adapter edges', () => {
    const families = FINAL_SWITCH_MANIFEST.diagnosticFamilyEdges;
    expect(families).toHaveLength(7);
    expect(new Set(families.map((edge) => edge.family)).size).toBe(7);
    for (const required of [
      'ordinary-text',
      'circle-warped-text',
      'nested-object',
      'image',
      'crossword',
      'history',
      'frontend-restore',
    ]) {
      expect(families.map((edge) => edge.family)).toContain(required);
    }
    // The audit already proves every family edge exists from diagnostic-execution.
    expect(codes(repositoryView())).toEqual([]);
  });

  it('proves the E3 write set and rollback set are identical with an E2R baseline', () => {
    expect([...FINAL_SWITCH_E3_WRITE_SET].sort()).toEqual(
      [...FINAL_SWITCH_E3_ROLLBACK_FILES].sort(),
    );
    expect(FINAL_SWITCH_MANIFEST.e3WriteSet).toEqual(FINAL_SWITCH_E3_WRITE_SET);
    expect(FINAL_SWITCH_MANIFEST.rollbackFiles).toEqual(FINAL_SWITCH_E3_ROLLBACK_FILES);
    expect(FINAL_SWITCH_E3_ROLLBACK_BASELINE).toBe('accepted-e2r-tree');
    expect(FINAL_SWITCH_MANIFEST.e3RollbackBaseline).toBe('accepted-e2r-tree');
    for (const path of FINAL_SWITCH_E2R_WRITE_SET) {
      expect(FINAL_SWITCH_MANIFEST.e2rWriteSet).toContain(path);
    }
  });

  it('detects single/double-quoted static imports, re-exports, and dynamic imports', () => {
    const single = "import { classifyOutcome } from '../runtime/outcomes';";
    const double = 'import { classifyOutcome } from "../runtime/outcomes";';
    const reexport = "export { classifyOutcome } from '../runtime/outcomes';";
    const typeReexport = "export type { CheckResult } from '../contracts/execution';";
    const dynamic = "const m = await import('../runtime/outcomes');";
    for (const text of [single, double, reexport, dynamic]) {
      expect(finalSwitchModuleSpecifiers(text)).toContain('../runtime/outcomes');
    }
    expect(finalSwitchModuleSpecifiers(typeReexport)).toContain('../contracts/execution');
  });

  it('reports an unaccounted importer for double-quoted, re-export, and dynamic edges', () => {
    const view = repositoryView();
    const inject = (text: string): FinalSwitchManifestView => ({
      sourceFiles: [...view.sourceFiles, { path: 'src/cli/rogue-entry.ts', text }],
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    });
    expect(codes(inject('import { classifyOutcome } from "../runtime/outcomes";'))).toContain(
      'MANIFEST_SRC_CLOSURE_INCOMPLETE',
    );
    expect(codes(inject("export { classifyOutcome } from '../runtime/outcomes';"))).toContain(
      'MANIFEST_SRC_CLOSURE_INCOMPLETE',
    );
    expect(codes(inject("const m = await import('../runtime/outcomes');"))).toContain(
      'MANIFEST_SRC_CLOSURE_INCOMPLETE',
    );
  });

  it('detects a missing dynamic dispatch edge and a re-exposed removed export', () => {
    const view = repositoryView();
    const noDynamic: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.map((file) =>
        file.path === 'src/cli/main.ts' ? { ...file, text: '// stripped\n' } : file,
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(noDynamic)).toContain('MANIFEST_DYNAMIC_EDGE_ABSENT');
    // Post-cutover the removed exports must be *unreachable*, so an empty barrel
    // is simply clean; the defect the audit must still catch is a barrel that
    // re-exposes a removed legacy authority symbol.
    const emptied: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.map((file) =>
        file.path === 'src/index.ts' ? { ...file, text: '// stripped\n' } : file,
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(emptied)).not.toContain('MANIFEST_REMOVED_EXPORT_PRESENT');
    const reExposed: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.map((file) =>
        file.path === 'src/index.ts'
          ? {
              ...file,
              text: `${file.text}\nexport { classifyOutcome } from './runtime/outcomes';\n`,
            }
          : file,
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(reExposed)).toContain('MANIFEST_REMOVED_EXPORT_PRESENT');
  });

  it('detects an unmanifested final-module producer/writer edge and an unlisted test', () => {
    const view = repositoryView();
    const rogueSource: FinalSwitchManifestView = {
      sourceFiles: [
        ...view.sourceFiles,
        {
          path: 'src/cli/rogue-final.ts',
          text: "import { runFinalSuiteActivePath } from '../orchestration/final-active-path';\n",
        },
      ],
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(rogueSource)).toContain('MANIFEST_FINAL_EDGE_UNMANIFESTED');
    const rogueTest: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles,
      testFiles: [
        ...view.testFiles,
        {
          path: 'tests/foundation/rogue-active-cli.test.ts',
          text: "import { runDiagnosticCommand } from '../../src/cli/diagnostic';\n",
        },
      ],
      fixturePaths: view.fixturePaths,
    };
    expect(codes(rogueTest)).toContain('MANIFEST_TEST_CLOSURE_INCOMPLETE');
  });

  it('reconciles the real discovered changed-module test set exactly', () => {
    const view = repositoryView();
    expect(discoveredChangedModuleTests(view)).toEqual(
      [...FINAL_SWITCH_MANIFEST.discoveredChangedModuleTests].sort(),
    );
  });

  it('detects mutated producer endpoints and an absent producer edge', () => {
    const view = repositoryView();
    const withoutAdapter: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.filter(
        (file) => file.path !== 'src/adapters/doctor-command-live-facts.ts',
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(withoutAdapter)).toContain('MANIFEST_PRODUCER_ENDPOINT_MISSING');

    const strippedProducer: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.map((file) =>
        file.path === 'src/orchestration/command-execution.ts'
          ? { ...file, text: '// stripped\n' }
          : file,
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(strippedProducer)).toContain('MANIFEST_PRODUCER_EDGE_ABSENT');

    const strippedFamily: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.map((file) =>
        file.path === 'src/orchestration/diagnostic-execution.ts'
          ? { ...file, text: '// stripped\n' }
          : file,
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(strippedFamily)).toContain('MANIFEST_FAMILY_EDGE_ABSENT');
  });

  it('detects a missing activation endpoint on either side of the edge', () => {
    const view = repositoryView();
    const missingEntry: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.filter((file) => file.path !== 'src/cli/doctor.ts'),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(missingEntry)).toContain('MANIFEST_ACTIVATION_FROM_MISSING');

    const missingFacade: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.filter(
        (file) => file.path !== 'src/orchestration/final-active-path.ts',
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(codes(missingFacade)).toContain('MANIFEST_ACTIVATION_TO_MISSING');
  });

  it('classifies every changed-module rogue test import category as an unlisted test', () => {
    const view = repositoryView();
    const rogueTexts: readonly string[] = [
      "import { runDiagnosticCommand } from '../../src/cli/diagnostic';\n",
      "import { classifyOutcome } from '../../src/runtime/outcomes';\n",
      'export { classifyOutcome } from "../../src/runtime/outcomes";\n',
      "const m = await import('../../src/runtime/outcomes');\n",
      "import { planCaseForExecution } from '../../src/planner/plan-case';\n",
      "import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';\n",
    ];
    for (const text of rogueTexts) {
      const rogue: FinalSwitchManifestView = {
        sourceFiles: view.sourceFiles,
        testFiles: [...view.testFiles, { path: 'tests/foundation/rogue-changed.test.ts', text }],
        fixturePaths: view.fixturePaths,
      };
      expect(codes(rogue), text).toContain('MANIFEST_TEST_CLOSURE_INCOMPLETE');
    }
  });

  it('accounts for every source importer of the old authority or active CLI', () => {
    const view = repositoryView();
    expect(codes(view)).toEqual([]);
    const coveredSource = new Set([
      ...FINAL_SWITCH_MANIFEST.activeCliEntries,
      ...FINAL_SWITCH_MANIFEST.dynamicDispatchFiles,
      ...FINAL_SWITCH_MANIFEST.diagnosticProducerFiles,
      ...FINAL_SWITCH_MANIFEST.commandProducerFiles,
      ...FINAL_SWITCH_MANIFEST.contractsEvidenceFiles,
      ...FINAL_SWITCH_MANIFEST.plannerOrchestrationFiles,
      ...FINAL_SWITCH_MANIFEST.publicBarrelFiles,
      ...FINAL_SWITCH_MANIFEST.auditedDependencyFiles,
      ...FINAL_SWITCH_MANIFEST.retainedReadOnlyFiles,
      ...FINAL_SWITCH_MANIFEST.typeOnlyEdges,
      ...FINAL_SWITCH_MANIFEST.finalAuthorityFiles,
      ...FINAL_SWITCH_MANIFEST.facadeFiles,
    ]);
    for (const required of [
      'src/browser/doctor.ts',
      'src/runtime/action-cycle.ts',
      'src/oracles/evaluate.ts',
      'src/runtime/execute-plan.ts',
      'src/index.ts',
      'src/cli/diagnostic.ts',
    ]) {
      expect(coveredSource.has(required), `covers ${required}`).toBe(true);
    }
    expect(FINAL_SWITCH_MANIFEST.finalModuleImporters.length).toBeGreaterThan(0);
    for (const importer of FINAL_SWITCH_FINAL_MODULE_IMPORTERS) {
      expect(FINAL_SWITCH_MANIFEST.finalModuleImporters).toContain(importer);
    }
  });
});

// ── Post-cutover reachability: only the accepted active edges reach these ────

describe('[P7-B2-E2R] post-cutover reachability', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const ACTIVE_CLI_ENTRIES = [
    'src/cli/diagnostic.ts',
    'src/cli/suite.ts',
    'src/cli/doctor.ts',
    'src/cli/production-absence.ts',
  ];

  it('is reached only through the accepted post-cutover activation and producer edges', () => {
    // Each of the four active CLI entries routes through the one final façade.
    for (const entry of ACTIVE_CLI_ENTRIES) {
      expect(source(entry), entry).toContain('orchestration/final-active-path');
    }
    // The strict-v4 writer/reader are the current durable authority reached by
    // the façade, never the legacy boolean/v3 writer and reader.
    expect(source('src/evidence/final-writer.ts')).toContain('writeFinalPublicRunRecordV4');
    expect(source('src/evidence/final-reader.ts')).toContain('readFinalPublicRecordFile');
    // The two command entries reach their raw-fact adapters directly.
    expect(source('src/cli/doctor.ts')).toContain('adapters/doctor-command-live-facts');
    expect(source('src/cli/production-absence.ts')).toContain(
      'adapters/production-absence-command-live-facts',
    );
    // The façade and the manifest stay internal: the public barrel never
    // re-exports them.
    const barrel = source('src/index.ts');
    for (const marker of ['orchestration/', 'final-active-path', 'final-switch-manifest']) {
      expect(barrel, marker).not.toContain(marker);
    }
    // No active CLI entry reaches the removed legacy writer, reader, suite
    // record, or boolean classifier.
    for (const entry of ACTIVE_CLI_ENTRIES) {
      const text = source(entry);
      for (const marker of [
        'runtime/outcomes',
        'evidence/suite-record',
        'writePublicRunRecordV3',
      ]) {
        expect(text, `${entry} references ${marker}`).not.toContain(marker);
      }
    }
  });

  it('retains the boolean baseline while the barrel exposes only the final current surfaces', () => {
    const execution = readFileSync(path.join(skillRoot, 'src/contracts/execution.ts'), 'utf8');
    expect(execution).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    const outcomes = readFileSync(path.join(skillRoot, 'src/runtime/outcomes.ts'), 'utf8');
    expect(outcomes).toContain('harnessInvalid');
    const barrel = readFileSync(path.join(skillRoot, 'src/index.ts'), 'utf8');
    // The strict-v4 contract and evidence surfaces are the current public
    // authority post-cutover.
    for (const marker of [
      'final-record-v4',
      'final-record-reader',
      'final-public-record',
      'final-suite-record',
    ]) {
      expect(barrel, marker).toContain(marker);
    }
    // The internal façade and manifest remain unexported.
    for (const marker of ['orchestration/', 'final-active-path', 'final-switch-manifest']) {
      expect(barrel, marker).not.toContain(marker);
    }
  });
});
