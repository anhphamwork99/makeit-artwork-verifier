import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type { ResolvedCorrectnessProfile } from '../../src/contracts/correctness';
import type { Capability } from '../../src/contracts/discriminants';
import type { MaterializedExecutionEnvelopeV1 } from '../../src/planner/execution-materialization';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import {
  assembleFinalChildRecordV4,
  assembleFinalCommandRecordV4,
  type AssembleFinalChildRecordV4Input,
  type FinalNestedProjectionV4,
} from '../../src/contracts/final-record-v4';
import { readFinalRecord } from '../../src/contracts/final-record-reader';
import {
  DOCTOR_COMMAND_AUTHORITY,
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  evaluateDoctorCommandChecks,
  evaluateGeometryDeltaOracle,
  evaluateProductionAbsenceCommandChecks,
} from '../../src/index';
import {
  evaluateOrdinaryTextLiveChecks,
  evaluateWarpedTextLiveChecks,
  projectOrdinaryTextLiveFact,
} from '../../src/adapters/text-live-facts';
import { evaluateNestedObjectLiveChecks } from '../../src/adapters/object-live-facts';
import { evaluateImageLiveChecks } from '../../src/adapters/image-live-facts';
import { evaluateCrosswordLiveChecks } from '../../src/adapters/crossword-live-facts';
import { evaluateHistoryLiveChecks } from '../../src/adapters/history-live-facts';
import { evaluateRestoreLiveChecks } from '../../src/adapters/restore-live-facts';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
} from '../../src/contracts/correctness';

/**
 * P7-B2-C focused proof: inactive strict-v4 assembly and strict current/legacy
 * reader (ADR 0029 §4 B2-C, ADR 0025 §7).
 *
 * The suites drive the assembly from the *real* exact envelopes produced by
 * `planCaseForExecution` and the *real* inactive per-family live-fact adapters
 * and kernels, prove strict v4 round trips for all seven evaluator families,
 * prove every nested check-bearing projection is constructed and validated,
 * prove command-context separation, prove the malformed/legacy/mixed/unknown
 * boundaries fail closed, and prove no active module imports or writes through
 * the new inactive surface.
 */

const skillRoot = resolveToolkitRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();
const resolvedRequests = resolveSuiteRequests(loadDiagnosticSuite('representative'));

function representativeRequest(fileName: string): unknown {
  const entry = resolvedRequests.find(
    (candidate) => path.basename(candidate.relativePath) === fileName,
  );
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

interface PreparedFamily {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: {
    readonly subjectId: string;
    readonly capability: Capability;
    readonly variant: string | null;
  };
  readonly actionCycle: ActionCycleCorrectnessIdentity;
}

function prepare(fileName: string): PreparedFamily {
  const result = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (result.status !== 'PLANNED') throw new Error(`${fileName} did not plan: ${result.status}`);
  if (result.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = result.envelope as MaterializedExecutionEnvelopeV1;
  const profile = envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile;
  const intent = result.materializedCase.intent;
  const actionCycle: ActionCycleCorrectnessIdentity = {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId: `b2c-cycle-${fileName}`,
    resolvedProfileFingerprint: profile.resolvedFingerprint,
    readinessFingerprint: profile.componentFingerprints.readiness,
  };
  return {
    envelope,
    profile,
    route: { subjectId: intent.subjectId, capability: intent.capability, variant: intent.variant },
    actionCycle,
  };
}

function readinessPolicy(profile: ResolvedCorrectnessProfile) {
  return {
    policy: {
      profileId: profile.readiness.profileId,
      deadlineCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...profile.readiness.fallbackCadenceMs],
      stableFrames: profile.readiness.stableFrames,
      quiescenceRequired: profile.readiness.quiescenceRequired,
      stableFrameRequired: profile.readiness.stableFrameRequired,
    },
    observation: { outcome: 'unusable', authority: 'missing' },
  };
}

function requireChecks(outcome: {
  ok: boolean;
  result?: { checks: readonly CorrectnessCheckResult[] };
}): readonly CorrectnessCheckResult[] {
  if (!outcome.ok || outcome.result === undefined) throw new Error('family adapter failed');
  return outcome.result.checks;
}

interface FamilyProof {
  readonly family: string;
  readonly prepared: PreparedFamily;
  readonly checks: readonly CorrectnessCheckResult[];
}

/** The seven accepted evaluator families, each from its exact envelope + adapter + kernel. */
function buildFamilyProofs(): FamilyProof[] {
  const ordinary = prepare('layer-text-move-drag-ordinary.json');
  const warped = prepare('layer-text-move-drag-warped-nested.json');
  const nested = prepare('container-object-move-nested-rotated.json');
  const image = prepare('layer-image-upload-replace.json');
  const crossword = prepare('layer-crossword-create.json');
  const history = prepare('artwork-editor-history-undo-redo.json');
  const restore = prepare('artwork-editor-serialize-restore-normalized.json');

  return [
    {
      family: 'text-ordinary',
      prepared: ordinary,
      checks: requireChecks(
        evaluateOrdinaryTextLiveChecks({
          envelope: ordinary.envelope,
          route: ordinary.route,
          actionCycle: ordinary.actionCycle,
          minimumDelta: null,
          delta: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'text-warped',
      prepared: warped,
      checks: requireChecks(
        evaluateWarpedTextLiveChecks({
          envelope: warped.envelope,
          route: warped.route,
          actionCycle: warped.actionCycle,
          minimumDelta: null,
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'nested-object',
      prepared: nested,
      checks: requireChecks(
        evaluateNestedObjectLiveChecks({
          envelope: nested.envelope,
          route: nested.route,
          actionCycle: nested.actionCycle,
          minimumDelta: null,
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'image',
      prepared: image,
      checks: requireChecks(
        evaluateImageLiveChecks({
          envelope: image.envelope,
          route: image.route,
          actionCycle: image.actionCycle,
          mode: 'upload',
          targetId: 'b2c-image-target',
          expectedLayoutId: 'b2c-image-layout',
          expectedFrame: { x: 0, y: 0, width: 32, height: 24, rotation: 0 },
          expectedResource: {
            logicalId: 'image.upload-a',
            version: 1,
            sha256: 'f'.repeat(64),
            byteLength: 1,
            mimeType: 'image/png',
            dimensions: { width: 32, height: 24 },
            probes: [],
          },
          acceptedUpload: null,
          oracle: null,
          raster: null,
          readiness: readinessPolicy(image.profile) as never,
          evidence: [],
        }),
      ),
    },
    {
      family: 'crossword',
      prepared: crossword,
      checks: requireChecks(
        evaluateCrosswordLiveChecks({
          envelope: crossword.envelope,
          route: crossword.route,
          actionCycle: crossword.actionCycle,
          clock: null,
          sourceFingerprintExpected: '',
          executions: [],
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'history',
      prepared: history,
      checks: requireChecks(
        evaluateHistoryLiveChecks({
          envelope: history.envelope,
          route: history.route,
          actionCycle: history.actionCycle,
          retainedLayoutId: null,
          setup: [],
          actions: [],
          finalHistory: null,
          readiness: readinessPolicy(history.profile) as never,
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'restore',
      prepared: restore,
      checks: requireChecks(
        evaluateRestoreLiveChecks({
          envelope: restore.envelope,
          route: restore.route,
          actionCycle: restore.actionCycle,
          schemaVersion: 1,
          transition: {},
          meaning: {},
          rawSemantics: {},
          source: null,
          restored: null,
          setup: [],
          readiness: readinessPolicy(restore.profile) as never,
          oracle: null,
          evidence: [],
        }),
      ),
    },
  ];
}

function actionCycleProjection(prepared: PreparedFamily): FinalNestedProjectionV4 {
  const { profile, actionCycle } = prepared;
  return {
    schemaVersion: 4,
    family: 'action-cycle',
    actionCycles: [actionCycle],
    readiness: {
      profileId: profile.readiness.profileId,
      timingCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      stableFrames: profile.readiness.stableFrames,
    },
  };
}

/** Builds the exact nested projections required by the current public DTO per family. */
function nestedProjectionsFor(
  proof: FamilyProof,
  checks: readonly CorrectnessCheckResult[],
): FinalNestedProjectionV4[] {
  const { prepared } = proof;
  const actionCycle = prepared.actionCycle;
  const projections: FinalNestedProjectionV4[] = [actionCycleProjection(prepared)];
  if (proof.family === 'image') {
    projections.push({
      schemaVersion: 4,
      family: 'image',
      cycles: [
        {
          checkpoint: 'after-upload-current',
          mode: 'upload',
          outcome: 'HARNESS_BLOCKED',
          observationId: null,
          tornRecaptureCount: 0,
          actionCycleRef: actionCycle.actionCycleId,
          checks,
        },
      ],
    });
  } else if (proof.family === 'crossword') {
    projections.push({
      schemaVersion: 4,
      family: 'crossword',
      providerId: 'playwright-clock-fixed-wall-v1',
      namespace: 'crossword.create.date-now.v1',
      comparisonProfileId: 'crossword-determinism-comparison-v1',
      executions: (['A1', 'A2', 'B'] as const).map((executionRole) => ({
        executionRole,
        clockBaselineUtc: '2026-01-01T00:00:00.000Z',
        expectedSeed: 1,
        actualSeed: 1,
        hostLayoutId: 'b2c-crossword-host',
        createdTargetId: 'b2c-crossword-target',
        words: [],
        semanticDigest: '0'.repeat(64),
        actionCycleRef: actionCycle.actionCycleId,
        checks,
      })),
      comparison: {
        sameSeedEqual: true,
        sameWordsEqual: true,
        sameSemanticDigestEqual: true,
        controlSeedDifferent: false,
        controlWordsEqual: true,
        controlSemanticDigestDifferent: false,
      },
    });
  } else if (proof.family === 'history') {
    projections.push({
      schemaVersion: 4,
      family: 'history',
      normalizationProfileId: 'artwork-product-meaning-v1',
      readinessProfileId: prepared.profile.readiness.profileId,
      oracleProfileId: prepared.profile.oracle.oracleProfileId,
      timingCategory: prepared.profile.readiness.deadlineCategory,
      deadlineMs: prepared.profile.readiness.deadlineMs,
      retainedLayoutId: 'b2c-history-layout',
      finalHistory: { pastDepth: 0, futureDepth: 0, baselineClean: true },
      actionCycleRef: actionCycle.actionCycleId,
      checks,
    });
  } else if (proof.family === 'restore') {
    projections.push({
      schemaVersion: 4,
      family: 'restore',
      normalizationProfileId: 'artwork-product-meaning-v1',
      readinessProfileId: prepared.profile.readiness.profileId,
      oracleProfileId: prepared.profile.oracle.oracleProfileId,
      timingCategory: prepared.profile.readiness.deadlineCategory,
      deadlineMs: prepared.profile.readiness.deadlineMs,
      scenarioId: 'serialize-roundtrip',
      sourceDocumentId: 'b2c-restore-source',
      restoredDocumentId: 'b2c-restore-restored',
      actionCycleRef: actionCycle.actionCycleId,
      checks,
    });
  }
  return projections;
}

function assemblyInput(
  proof: FamilyProof,
  overrides: Partial<AssembleFinalChildRecordV4Input> = {},
): AssembleFinalChildRecordV4Input {
  return {
    envelope: proof.prepared.envelope,
    runId: `b2c-run-${proof.family}`,
    observationId: null,
    actionCycles: [proof.prepared.actionCycle],
    requiredChecks: proof.checks,
    nestedProjections: nestedProjectionsFor(proof, proof.checks),
    ...overrides,
  };
}

function issueCodes(result: { ok: boolean; issues?: readonly { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

describe('[P7-B2-C] strict-v4 assembly round trip for all seven families', () => {
  const proofs = buildFamilyProofs();

  it('exposes exactly the seven accepted evaluator families', () => {
    expect(proofs.map((proof) => proof.family)).toEqual([
      'text-ordinary',
      'text-warped',
      'nested-object',
      'image',
      'crossword',
      'history',
      'restore',
    ]);
  });

  it('assembles and reads one complete strict v4 record per family', () => {
    for (const proof of proofs) {
      const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
      expect(assembled.ok, `${proof.family}: ${issueCodes(assembled).join(', ')}`).toBe(true);
      if (!assembled.ok) continue;
      const record = assembled.record;
      expect(record.schemaVersion).toBe(4);
      expect(record.resolvedProfileFingerprint).toBe(proof.prepared.profile.resolvedFingerprint);
      expect(record.componentFingerprints).toEqual(proof.prepared.profile.componentFingerprints);
      expect(record.requiredChecks.map((check) => check.checkId)).toEqual(
        proof.prepared.profile.requiredChecks.map((contract) => contract.checkId),
      );
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.hasOwn(record, 'harnessInvalid')).toBe(false);
      for (const check of record.requiredChecks) {
        expect(Object.hasOwn(check, 'passed')).toBe(false);
        expect(Object.hasOwn(check, 'harnessInvalid')).toBe(false);
        expect(check.actionCycleRef).toBe(proof.prepared.actionCycle.actionCycleId);
      }
      const read = readFinalRecord(record);
      expect(read.kind).toBe('current-v4');
      if (read.kind !== 'current-v4') continue;
      expect(read.legacy).toBe(false);
      expect(read.current).toBe(true);
      expect(read.ambiguous).toBe(false);
      expect(read.record).toEqual(record);
    }
  });

  it('is faithful across a JSON round trip (a stored v4 record re-reads as current)', () => {
    for (const proof of proofs) {
      const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
      if (!assembled.ok) throw new Error(`${proof.family} did not assemble`);
      const stored = JSON.parse(JSON.stringify(assembled.record)) as unknown;
      const read = readFinalRecord(stored);
      expect(read.kind, proof.family).toBe('current-v4');
      if (read.kind !== 'current-v4') continue;
      expect(read.record).toEqual(assembled.record);
    }
  });

  it('produces a strict PASS record from the real ordinary-Text oracle', () => {
    const ordinary = prepare('layer-text-move-drag-ordinary.json');
    const outcome = evaluateOrdinaryTextLiveChecks({
      envelope: ordinary.envelope,
      route: ordinary.route,
      actionCycle: ordinary.actionCycle,
      minimumDelta: { x: 40, y: 20 },
      delta: projectOrdinaryTextLiveFact(
        evaluateGeometryDeltaOracle({
          minimumDelta: { x: 40, y: 20 },
          canonicalBefore: { x: 100, y: 100 },
          canonicalAfter: { x: 150, y: 130 },
          renderedBefore: { x: 100, y: 100 },
          renderedAfter: { x: 150, y: 130 },
        }),
      ),
      evidence: ordinary.profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
        evidenceId,
        availability: 'authoritative' as const,
      })),
    });
    if (!outcome.ok) throw new Error('expected the ordinary-Text adapter to succeed');
    expect(outcome.result.checks.every((check) => check.status === 'PASS')).toBe(true);
    const assembled = assembleFinalChildRecordV4({
      envelope: ordinary.envelope,
      runId: 'b2c-run-text-pass',
      observationId: 'b2c-observation',
      actionCycles: [ordinary.actionCycle],
      requiredChecks: outcome.result.checks,
      nestedProjections: [actionCycleProjection(ordinary)],
    });
    expect(assembled.ok, issueCodes(assembled).join(', ')).toBe(true);
    if (!assembled.ok) return;
    const read = readFinalRecord(assembled.record);
    expect(read.kind).toBe('current-v4');
    if (read.kind === 'current-v4') {
      expect(read.record.requiredChecks.every((check) => check.status === 'PASS')).toBe(true);
    }
  });

  it('constructs and validates every nested check-bearing projection family', () => {
    const byFamily = new Map(proofs.map((proof) => [proof.family, proof]));
    for (const [family, projectionFamily] of [
      ['image', 'image'],
      ['crossword', 'crossword'],
      ['history', 'history'],
      ['restore', 'restore'],
      ['text-ordinary', 'action-cycle'],
    ] as const) {
      const proof = byFamily.get(family);
      if (proof === undefined) throw new Error(`missing ${family}`);
      const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
      expect(assembled.ok, `${family}: ${issueCodes(assembled).join(', ')}`).toBe(true);
      if (!assembled.ok) continue;
      const families = assembled.record.nestedProjections.map((entry) => entry.family);
      expect(families).toContain(projectionFamily);
      expect(families).toContain('action-cycle');
    }
  });
});

describe('[P7-B2-C] strict-v4 assembly rejects malformed and contradictory records', () => {
  const proofs = buildFamilyProofs();
  const textOrdinary = proofs.find((proof) => proof.family === 'text-ordinary') as FamilyProof;
  const imageProof = proofs.find((proof) => proof.family === 'image') as FamilyProof;
  const baseChecks = textOrdinary.checks;

  function mutateCheck(index: number, patch: Record<string, unknown>): CorrectnessCheckResult[] {
    return baseChecks.map((check, position) =>
      position === index ? ({ ...check, ...patch } as CorrectnessCheckResult) : check,
    );
  }

  function expectRejected(input: AssembleFinalChildRecordV4Input, code: string): void {
    const result = assembleFinalChildRecordV4(input);
    expect(result.ok, `expected rejection with ${code}`).toBe(false);
    if (result.ok) return;
    expect(issueCodes(result)).toContain(code);
  }

  it('rejects an unsupported envelope schema and a mutated plan fingerprint', () => {
    expectRejected(
      assemblyInput(textOrdinary, {
        envelope: { ...textOrdinary.prepared.envelope, schemaVersion: 99 } as never,
      }),
      'FINAL_RECORD_ENVELOPE_SCHEMA_UNSUPPORTED',
    );
    expectRejected(
      assemblyInput(textOrdinary, {
        envelope: { ...textOrdinary.prepared.envelope, planFingerprint: 'a'.repeat(64) } as never,
      }),
      'FINAL_RECORD_ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
    );
  });

  it('rejects a mutated compiled profile fingerprint', () => {
    const envelope = textOrdinary.prepared.envelope as unknown as Record<string, unknown>;
    const profile = envelope.correctnessProfile as Record<string, unknown>;
    const tampered = {
      ...envelope,
      correctnessProfile: {
        ...profile,
        readiness: { ...(profile.readiness as object), deadlineMs: 1 },
      },
    };
    expectRejected(
      assemblyInput(textOrdinary, { envelope: tampered as never }),
      'FINAL_RECORD_ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
    );
  });

  it('rejects a missing, duplicate, or unknown required check', () => {
    expectRejected(
      assemblyInput(textOrdinary, { requiredChecks: [] }),
      'RESULT_REQUIRED_CHECK_MISSING',
    );
    expectRejected(
      assemblyInput(textOrdinary, {
        requiredChecks: [
          baseChecks[0] as CorrectnessCheckResult,
          baseChecks[0] as CorrectnessCheckResult,
        ],
      }),
      'RESULT_REQUIRED_CHECK_DUPLICATE',
    );
    expectRejected(
      assemblyInput(textOrdinary, { requiredChecks: mutateCheck(0, { checkId: 'not.declared' }) }),
      'RESULT_REQUIRED_CHECK_UNKNOWN',
    );
  });

  it('rejects an unresolved Action Cycle reference and a bad Action Cycle set', () => {
    expectRejected(
      assemblyInput(textOrdinary, { requiredChecks: mutateCheck(0, { actionCycleRef: 'nope' }) }),
      'RESULT_ACTION_CYCLE_UNRESOLVED',
    );
    expectRejected(
      assemblyInput(textOrdinary, { actionCycles: [] }),
      'FINAL_RECORD_ACTION_CYCLE_MISSING',
    );
    expectRejected(
      assemblyInput(textOrdinary, {
        actionCycles: [textOrdinary.prepared.actionCycle, textOrdinary.prepared.actionCycle],
      }),
      'FINAL_RECORD_ACTION_CYCLE_DUPLICATE',
    );
  });

  it('rejects contradictory component, evidence, and reference identities', () => {
    const consumed = (baseChecks[0] as CorrectnessCheckResult).consumedComponentFingerprints;
    expectRejected(
      assemblyInput(textOrdinary, {
        requiredChecks: mutateCheck(0, {
          consumedComponentFingerprints: { ...consumed, oracle: 'b'.repeat(64) },
        }),
      }),
      'RESULT_CONSUMED_COMPONENT_MISMATCH',
    );
    expectRejected(
      assemblyInput(textOrdinary, {
        requiredChecks: mutateCheck(0, { evidenceIds: ['undeclared'] }),
      }),
      'RESULT_EVIDENCE_UNDECLARED',
    );
    expectRejected(
      assemblyInput(textOrdinary, {
        requiredChecks: mutateCheck(0, { toleranceRefs: ['undeclared.tolerance'] }),
      }),
      'RESULT_TOLERANCE_REF_UNDECLARED',
    );
    expectRejected(
      assemblyInput(textOrdinary, {
        requiredChecks: mutateCheck(0, { visualRefs: ['undeclared.visual'] }),
      }),
      'RESULT_VISUAL_REF_UNDECLARED',
    );
  });

  it('rejects a legacy boolean or harnessInvalid surface inside a strict v4 record', () => {
    expectRejected(
      assemblyInput(textOrdinary, { requiredChecks: mutateCheck(0, { passed: true }) }),
      'RESULT_BOOLEAN_PASSED_PRESENT',
    );
    expectRejected(
      assemblyInput(textOrdinary, { requiredChecks: mutateCheck(0, { harnessInvalid: false }) }),
      'RESULT_HARNESS_INVALID_PRESENT',
    );
  });

  it('rejects a command-context check from a compiled-profile record', () => {
    const commandResult = evaluateDoctorCommandChecks({
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: DOCTOR_COMMAND_CHECKS.map((declaration) => ({
        checkId: declaration.checkId,
        authorityState: 'current' as const,
        matched: true,
        actual: { observed: declaration.checkId },
      })),
      evidence: DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
        evidenceId,
        availability: 'authoritative' as const,
      })),
      cleanupSucceeded: true,
    });
    const mixed = baseChecks.map((check, index) =>
      index === 0 ? ({ ...check, ...commandResult.checks[0] } as never) : check,
    );
    expectRejected(
      assemblyInput(textOrdinary, { requiredChecks: mixed }),
      'RESULT_COMMAND_CONTEXT_FORBIDDEN',
    );
  });

  it('rejects an unknown nested projection family, a duplicate family, and a bad nested check', () => {
    expectRejected(
      assemblyInput(textOrdinary, {
        nestedProjections: [
          actionCycleProjection(textOrdinary.prepared),
          { schemaVersion: 4, family: 'unknown-family', checks: [] } as never,
        ],
      }),
      'FINAL_RECORD_NESTED_PROJECTION_UNKNOWN_FAMILY',
    );
    expectRejected(
      assemblyInput(textOrdinary, {
        nestedProjections: [
          actionCycleProjection(textOrdinary.prepared),
          actionCycleProjection(textOrdinary.prepared),
        ],
      }),
      'FINAL_RECORD_NESTED_PROJECTION_DUPLICATE',
    );
    expectRejected(
      assemblyInput(imageProof, {
        nestedProjections: [
          actionCycleProjection(imageProof.prepared),
          {
            schemaVersion: 4,
            family: 'image',
            cycles: [
              {
                checkpoint: 'after-upload-current',
                mode: 'upload',
                outcome: 'HARNESS_BLOCKED',
                observationId: null,
                tornRecaptureCount: 0,
                actionCycleRef: imageProof.prepared.actionCycle.actionCycleId,
                checks: mutateCheck(0, { checkId: 'not-a-declared-check' }),
              },
            ],
          },
        ],
      }),
      'FINAL_RECORD_NESTED_PROJECTION_CHECK_DRIFT',
    );
  });

  it('rejects a missing action-cycle readiness projection', () => {
    expectRejected(
      assemblyInput(textOrdinary, { nestedProjections: [] }),
      'FINAL_RECORD_NESTED_PROJECTION_INVALID',
    );
  });
});

describe('[P7-B2-C] strict current/legacy reader discrimination', () => {
  it('accepts a strict v4 record and rejects a v4 record with any legacy surface', () => {
    const proof = buildFamilyProofs()[0] as FamilyProof;
    const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
    if (!assembled.ok) throw new Error('expected assembly');
    expect(readFinalRecord(assembled.record).kind).toBe('current-v4');

    const withBoolean = JSON.parse(JSON.stringify(assembled.record)) as Record<string, unknown>;
    (withBoolean.requiredChecks as Record<string, unknown>[])[0].passed = false;
    expect(readFinalRecord(withBoolean).kind).toBe('mixed');

    const withHarnessInvalid = JSON.parse(JSON.stringify(assembled.record)) as Record<
      string,
      unknown
    >;
    withHarnessInvalid.harnessInvalid = true;
    const harnessRead = readFinalRecord(withHarnessInvalid);
    expect(harnessRead.kind).toBe('invalid');
    expect(harnessRead.record).toBeNull();
  });

  it('reads v1/v2/v3 legacy records read-only, non-converting, and ambiguous', () => {
    for (const [version, label] of [
      [1, 'legacy-v1'],
      [2, 'legacy-v2'],
      [3, 'legacy-v3'],
    ] as const) {
      const legacy = {
        schemaVersion: version,
        command: 'diagnostic',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runId: `legacy-run-${version}`,
        requiredChecks: [{ checkId: 'geometry.delta', passed: false, evidenceIds: ['e1'] }],
      };
      const read = readFinalRecord(legacy);
      expect(read.kind).toBe(`legacy-v${version}`);
      expect(read.legacy).toBe(true);
      expect(read.current).toBe(false);
      expect(read.ambiguous).toBe(true);
      expect(read.label).toBe(label);
      if (!read.legacy) continue;
      expect(read.record).toEqual(legacy);
      const first = read.checks[0];
      expect(first?.kind).toBe('legacy-boolean');
      // The historical boolean is preserved exactly; it is never converted.
      expect(first?.passed).toBe(false);
      expect(first?.status).toBeNull();
      expect(first?.ambiguous).toBe(true);
      expect(read.issues.map((issue) => issue.code)).toContain('RESULT_LEGACY_BOOLEAN_AMBIGUOUS');
    }
  });

  it('rejects a mixed boolean/status record and an unknown schema', () => {
    const mixedRead = readFinalRecord({
      schemaVersion: 3,
      requiredChecks: [{ checkId: 'geometry.delta', passed: true, status: 'PASS' }],
    });
    expect(mixedRead.kind).toBe('mixed');
    expect(mixedRead.record).toBeNull();

    const unknownRead = readFinalRecord({ schemaVersion: 99, requiredChecks: [] });
    expect(unknownRead.kind).toBe('unknown');
    expect(unknownRead.record).toBeNull();

    const notObject = readFinalRecord(42);
    expect(notObject.kind).toBe('invalid');
    expect(notObject.record).toBeNull();
  });

  it('rejects a v4 record with a missing required identity field', () => {
    const proof = buildFamilyProofs()[0] as FamilyProof;
    const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
    if (!assembled.ok) throw new Error('expected assembly');
    const broken = JSON.parse(JSON.stringify(assembled.record)) as Record<string, unknown>;
    broken.resolvedProfileFingerprint = 'not-a-fingerprint';
    const read = readFinalRecord(broken);
    expect(read.kind).toBe('invalid');
    expect(read.issues.map((issue) => issue.code)).toContain('FINAL_RECORD_FIELD_INVALID');
  });

  it('rejects a v4 record carrying an unknown top-level field (closed DTO)', () => {
    const proof = buildFamilyProofs()[0] as FamilyProof;
    const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
    if (!assembled.ok) throw new Error('expected assembly');
    const broken = JSON.parse(JSON.stringify(assembled.record)) as Record<string, unknown>;
    broken.surprise = true;
    expect(readFinalRecord(broken).kind).toBe('invalid');
  });
});

describe('[P7-B2-C] command-context separation', () => {
  function assembleCommand(result: {
    declaredAuthority: typeof DOCTOR_COMMAND_STATUS_AUTHORITY;
    checks: readonly unknown[];
  }) {
    return assembleFinalCommandRecordV4({
      commandAuthority: result.declaredAuthority,
      checks: result.checks as never,
    });
  }

  it('assembles and reads separate Doctor and production-absence v4 command records', () => {
    const doctorResult = evaluateDoctorCommandChecks({
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: DOCTOR_COMMAND_CHECKS.map((declaration) => ({
        checkId: declaration.checkId,
        authorityState: 'current' as const,
        matched: true,
        actual: { observed: declaration.checkId },
      })),
      evidence: DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
        evidenceId,
        availability: 'authoritative' as const,
      })),
      cleanupSucceeded: true,
    });
    const productionResult = evaluateProductionAbsenceCommandChecks({
      commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
      checks: PRODUCTION_ABSENCE_COMMAND_CHECKS.map((declaration) => ({
        checkId: declaration.checkId,
        authorityState: 'current' as const,
        matched: true,
        actual: { observed: declaration.checkId },
      })),
      evidence: PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
        evidenceId,
        availability: 'authoritative' as const,
      })),
      cleanupSucceeded: true,
    });
    for (const [result, authority] of [
      [doctorResult, DOCTOR_COMMAND_STATUS_AUTHORITY],
      [productionResult, PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY],
    ] as const) {
      expect(result.ok).toBe(true);
      const assembled = assembleCommand(result);
      expect(assembled.ok, issueCodes(assembled).join(', ')).toBe(true);
      if (!assembled.ok) continue;
      const read = readFinalRecord(assembled.record);
      expect(read.kind).toBe('command-v4');
      if (read.kind !== 'command-v4') continue;
      expect(read.record.command).toBe(authority.command);
      expect(read.record.commandAuthority.commandAuthorityFingerprint).toBe(
        authority.commandAuthorityFingerprint,
      );
      for (const check of read.record.checks) {
        expect(Object.hasOwn(check, 'passed')).toBe(false);
        expect(Object.hasOwn(check, 'actionCycleRef')).toBe(false);
        expect(Object.hasOwn(check, 'consumedComponentFingerprints')).toBe(false);
      }
    }
  });

  it('keeps the Doctor and production-absence command authority domains distinct', () => {
    expect(DOCTOR_COMMAND_AUTHORITY.command).toBe('doctor');
    expect(DOCTOR_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint).not.toBe(
      PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY.commandAuthorityFingerprint,
    );
  });
});

describe('[P7-B2-C] current strict-v4 record boundary', () => {
  const NEW_MODULES = ['src/contracts/final-record-v4.ts', 'src/contracts/final-record-reader.ts'];
  const AUTHORITY_SYMBOLS = [
    'assembleFinalChildRecordV4',
    'assembleFinalCommandRecordV4',
    'validateFinalChildRecordV4',
    'validateFinalCommandRecordV4',
    'readFinalRecord',
  ];

  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  it('is reached only by the current orchestration and the ADR 0033 executors, never by a legacy writer, reader, CLI, or browser module', () => {
    // The retained legacy writer/reader, the boolean classifier, the command
    // entries, and the browser producers must never reach the strict-v4
    // authority: no module edge and no authority symbol.
    for (const relative of [
      'src/evidence/writer.ts',
      'src/evidence/reader.ts',
      'src/evidence/public-dto.ts',
      'src/runtime/outcomes.ts',
      'src/runtime/result-outcome.ts',
      'src/cli/diagnostic.ts',
      'src/cli/main.ts',
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
    ]) {
      const text = source(relative);
      expect(text, `legacy module ${relative} imports a strict-v4 authority module`).not.toMatch(
        /from '[^']*final-record-(v4|reader)'/,
      );
      for (const marker of AUTHORITY_SYMBOLS) {
        expect(text, `legacy module ${relative} references ${marker}`).not.toContain(marker);
      }
    }
    // The current Diagnostic orchestration reaches the v4 assembler and the v4
    // reader is the current reader authority.
    expect(source('src/orchestration/diagnostic-execution.ts')).toContain(
      'assembleFinalChildRecordV4',
    );
    expect(source('src/contracts/final-record-reader.ts')).toContain('readFinalRecord');
    // The ADR 0033 executors may import the nested-projection *types* only; they
    // never call an assembler, validator, or reader.
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/execute-image-plan.ts',
      'src/runtime/execute-crossword-plan.ts',
      'src/runtime/execute-history-plan.ts',
      'src/runtime/execute-restore-plan.ts',
      'src/runtime/action-cycle.ts',
    ]) {
      const text = source(relative);
      for (const marker of AUTHORITY_SYMBOLS) {
        expect(text, `executor ${relative} references ${marker}`).not.toContain(marker);
      }
    }
    expect(source('src/runtime/execute-plan.ts')).toMatch(
      /import type \{[\s\S]*?\} from '\.\.\/contracts\/final-record-v4';/,
    );
  });

  it('reaches no active executor, Oracle, CLI, browser, writer, or classifier module', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toMatch(
        /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
      );
      expect(text, relative).not.toContain('contracts/execution');
    }
  });

  it('never writes a record on the active evidence path (no filesystem or writer import)', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text).not.toContain('node:fs');
      expect(text).not.toContain('writePublicRunRecord');
      expect(text).not.toContain('writeExclusiveRecordFile');
      expect(text).not.toContain('evidence/writer');
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
