import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the separately tested evidence transaction verifier is isolated. The strict
// public-v4 record parser, cleanup/current-tree reader, ledger and byte reader run on real files.
vi.mock('../../src/evidence/integrity', () => ({
  verifyEvidenceRoot: () => ({
    transaction: { creditEligible: true, strictRecordPresent: true },
    provenance: { currentTreeCheck: 'PASS', currentTreeCreditEligible: true },
    checks: [{ result: 'PASS' }],
  }),
  createCurrentTreeProvenanceProvider: () => () => ({ currentTreeCheck: 'PASS' }),
  createNodeEvidenceVerifyFsAdapter: () => ({}),
}));

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import { compilePreparedExecutionCandidate } from '../../src/cli/diagnostic';
import { buildCliResult } from '../../src/cli/output';
import { canonicalize, sha256Hex } from '../../src/canonical/canonicalize';
import { appendRetentionAudit } from '../../src/governance/retention';
import { generateExecutableSelectionManifest } from '../../src/governance/executable-selection-manifest';
import {
  prepareQualificationBatch,
  runQualificationBatch,
  verifyQualificationBatch,
} from '../../src/governance/qualification-runtime';
import type { ExecutableSelectionManifestDraftV1 } from '../../src/contracts/executable-selection-manifest';
import type { ExecutableManifestValidationContext } from '../../src/contracts/executable-selection-manifest';
import {
  readFinalPublicRecord,
  type FinalPublicRunRecordV4,
} from '../../src/contracts/final-public-record';
import {
  BUDGET_MEASUREMENT_JOIN_METHOD,
  BUDGET_MEASUREMENT_VERIFIER_METHOD,
  BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
  BUDGET_POLICY_DECISION_MAKER,
  BUDGET_POLICY_DECISION_SCOPE,
  BUDGET_POLICY_MANDATE,
  BUDGET_POLICY_METHOD,
  BUDGET_POLICY_SCHEMA_VERSION,
} from '../../src/contracts/budget-retention';
import type {
  BudgetFamilyMeasurementV1,
  BudgetMeasuredRunV1,
  BudgetMeasurementSetContentV1,
  BudgetPolicyApprovalArtifactV1,
  BudgetPolicyAuthorityAttestationV1,
  BudgetPolicyAuthorityProvider,
  BudgetPolicyCeilingsV1,
  BudgetPolicyProposalArtifactV1,
  BudgetPolicyProposalV1,
  BudgetPolicyReviewArtifactV1,
} from '../../src/contracts/budget-retention';
import {
  createGovernanceTiming,
  type GovernanceTimingV1,
} from '../../src/contracts/governance-timing';
import {
  assessBudgetPolicyProposal,
  checkBudgetPolicyFeasibility,
  deriveFreshMeasurementContent,
  createFreshMeasurementSet,
  inspectBudgetPolicyProposal,
  prepareDiagnosticCalibration,
  projectBudgetMeasuredRun,
  readReleaseChildStrictFacts,
  REFUSING_BUDGET_POLICY_AUTHORITY_PROVIDER,
  resolveReleaseBudgetPreflight,
  runDiagnosticCalibration,
  verifyApprovedBudgetPolicy,
  verifyDiagnosticCalibration,
  verifyBudgetMeasurementSet,
  type BudgetMeasuredRunProjectionInputV1,
  type BudgetMeasuredRunRecordSourceV1,
  type BudgetRunInventorySummaryV1,
  type BudgetRuntimeDependencies,
} from '../../src/governance/budget';
// Namespace import proves the read-only inspector is the only new capability and
// the generic artifact reader/validators stay private (WP6, ADR 0115).
import * as budgetGovernance from '../../src/governance/budget';
import { normalizeCaseRequest } from '../../src/planner/normalize-intent';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { readAndVerifyDiagnosticChild } from '../../src/governance/qualification-runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const actualSkill = resolveSkillRoot();
const draftName = 'draft-4fb06edd4de0cd64e0c56f926342599b0d1c323811c06e3fcc0a89649b1cb173.json';
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../integration/fixtures/p8b/committed-run/run-record.json',
);

function context(): ExecutableManifestValidationContext {
  const environmentCatalogue = loadEnvironmentCatalogue({ rootDir: actualSkill });
  const requestTemplates = resolveSuiteRequests(
    loadDiagnosticSuite('representative', { rootDir: actualSkill }),
  ).map((member) => {
    const normalized = normalizeCaseRequest(member.request);
    if (!normalized.ok) throw new Error('invalid fixture');
    return {
      templateId: path.basename(member.relativePath, '.json'),
      subjectId: normalized.request.intent.subjectId,
      capability: normalized.request.intent.capability,
      scenarioId: normalized.request.intent.scenario,
      intent: normalized.request.intent,
    };
  });
  return {
    catalogues: loadCatalogueBundle({ rootDir: actualSkill }),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates,
  };
}

function fixture() {
  const skillRoot = realpathSync(
    mkdtempSync(path.join(realpathSync(os.tmpdir()), 'budget-calibration-')),
  );
  roots.push(skillRoot);
  const drafts = path.join(skillRoot, 'cases/selection-manifests/drafts');
  mkdirSync(drafts, { recursive: true });
  const draftFile = path.join(drafts, draftName);
  writeFileSync(
    draftFile,
    readFileSync(path.join(actualSkill, 'cases/selection-manifests/drafts', draftName)),
  );
  const authorityDirectory = path.join(skillRoot, 'governance/authorities/0102');
  mkdirSync(authorityDirectory, { recursive: true });
  for (const name of ['decision.md', 'proposed-scope.json', 'review.md']) {
    writeFileSync(
      path.join(authorityDirectory, name),
      readFileSync(path.join(actualSkill, 'governance/authorities/0102', name)),
    );
  }
  let clock = 0;
  let started = 0;
  let reads = 0;
  let outcome: 'PASS' | 'BUG' = 'PASS';
  const dependencies: BudgetRuntimeDependencies = {
    skillRoot,
    repoRoot: skillRoot,
    loadContext: context,
    compileCandidate: compilePreparedExecutionCandidate,
    collectSourceDigest: () => 'a'.repeat(64),
    makeId: randomUUID,
    monotonicNow: () => (clock += 5),
    wallNow: () => '2026-09-26T12:00:00.000Z',
    runCandidate: async ({ preparedCandidate, runId }) => {
      started++;
      const record = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
      record.runId = runId;
      record.profile = 'release';
      record.provenance = 'manifest';
      record.evidenceDepth = 'standard';
      record.caseId = preparedCandidate.identity.caseId;
      record.materializationFingerprint = preparedCandidate.identity.materializationFingerprint;
      record.planFingerprint = preparedCandidate.identity.planFingerprint;
      record.environmentCellId = preparedCandidate.identity.cellId;
      const route = preparedCandidate.planning.materializedCase.route;
      record.adapter = { adapterId: route.adapterId, compatibilityVersion: 1 };
      record.workflow = { workflowId: route.workflowId, version: 1 };
      record.finalOutcome = outcome;
      record.behaviorOutcome = outcome;
      if (preparedCandidate.planning.materializedCase.subject.applicationKind === 'image') {
        // A selected Image family requires the strict persisted v4 torn counter.
        const check = (record.requiredChecks as unknown[])[0];
        record.nestedProjections = [
          ...(record.nestedProjections as unknown[]),
          {
            schemaVersion: 4,
            family: 'image',
            cycles: [
              {
                checkpoint: 'after-upload-current',
                mode: 'replace',
                outcome: 'PASS',
                observationId: null,
                tornRecaptureCount: 2,
                actionCycleRef: 'cycle:1',
                checks: [check],
              },
            ],
          },
        ];
      }
      const ownership = record.ownership as Record<string, unknown>;
      ownership.runId = runId;
      record.cleanup = {
        schemaVersion: 1,
        runId,
        attempted: true,
        complete: true,
        alreadyClean: false,
        refusedReason: null,
        facts: {
          processSignalled: true,
          processEscalated: false,
          processDead: true,
          portClosed: true,
          distDirRemoved: true,
          scratchRemoved: true,
          configRestored: true,
          browserClosed: true,
          evidencePreserved: true,
        },
        diagnostics: [],
      };
      expect(readFinalPublicRecord(record).kind).toBe('current-v4');
      const runRoot = path.join(skillRoot, 'evidence/runs', runId);
      mkdirSync(path.join(runRoot, 'nested'), { recursive: true });
      writeFileSync(path.join(runRoot, 'run-record.json'), `${JSON.stringify(record)}\n`);
      writeFileSync(path.join(runRoot, 'nested', 'manifest.json'), '{"child":true}\n');
      return buildCliResult({
        command: 'diagnostic',
        status: outcome,
        outcome,
        detail: 'synthetic child',
        details: null,
      });
    },
    readAndVerifyChild: (runId) => {
      reads++;
      return readAndVerifyDiagnosticChild(skillRoot, runId, skillRoot);
    },
  };
  return {
    skillRoot,
    draftFile,
    dependencies,
    get started() {
      return started;
    },
    get reads() {
      return reads;
    },
    setOutcome(value: 'PASS' | 'BUG') {
      outcome = value;
    },
  };
}

describe('no-credit full-manifest calibration', () => {
  it('compiles all exact entries before writes and reads strict files, cleanup and nested bytes again', async () => {
    const f = fixture();
    const prepared = prepareDiagnosticCalibration(
      { draftFile: f.draftFile },
      { dependencies: f.dependencies },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.calibration.slots.length).toBe(
      prepared.value.calibration.candidate.content.entries.length,
    );
    expect(f.started).toBe(0);
    expect(readdirSync(f.skillRoot)).toEqual(['cases', 'governance']);
    const run = await runDiagnosticCalibration(prepared.value, { dependencies: f.dependencies });
    expect(run).toMatchObject({
      ok: true,
      value: { state: 'COMPLETE_ALL_PASS', noReleaseCredit: true },
    });
    if (!run.ok) return;
    expect(f.started).toBe(prepared.value.calibration.slots.length);
    const verified = verifyDiagnosticCalibration(run.value.calibrationId, {
      dependencies: f.dependencies,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.slots).toHaveLength(f.started);
    expect(
      verified.value.slots.every(
        (slot) =>
          slot.evidenceFileCount === 2 &&
          slot.evidenceByteCount > Buffer.byteLength('{"child":true}\n'),
      ),
    ).toBe(true);
    expect(f.reads).toBe(f.started * 2);
    const firstRun = verified.value.slots[0]!.runId;
    writeFileSync(
      path.join(f.skillRoot, 'evidence/runs', firstRun, 'nested/manifest.json'),
      '{"child":false}\n',
    );
    expect(
      verifyDiagnosticCalibration(run.value.calibrationId, { dependencies: f.dependencies }).ok,
    ).toBe(false);
  });

  it('refuses a duplicate predeclared work ID without child allocation', async () => {
    const f = fixture();
    const prepared = prepareDiagnosticCalibration(
      { draftFile: f.draftFile },
      { dependencies: { ...f.dependencies, makeId: () => '1'.repeat(36) } },
    );
    expect(prepared).toEqual({ ok: false, code: 'PLAN_DRIFT' });
    expect(f.started).toBe(0);
    expect(readdirSync(f.skillRoot)).toEqual(['cases', 'governance']);
  });

  it('rejects a changed draft before allocation and preserves non-PASS history', async () => {
    const f = fixture();
    const prepared = prepareDiagnosticCalibration(
      { draftFile: f.draftFile },
      { dependencies: f.dependencies },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    writeFileSync(f.draftFile, `${readFileSync(f.draftFile, 'utf8')} `);
    expect(
      await runDiagnosticCalibration(prepared.value, { dependencies: f.dependencies }),
    ).toEqual({ ok: false, code: 'CANDIDATE_DRIFT' });
    expect(f.started).toBe(0);
    writeFileSync(
      f.draftFile,
      readFileSync(path.join(actualSkill, 'cases/selection-manifests/drafts', draftName)),
    );
    f.setOutcome('BUG');
    const run = await runDiagnosticCalibration(prepared.value, { dependencies: f.dependencies });
    expect(run).toMatchObject({
      ok: true,
      value: { state: 'NON_CREDITABLE', noReleaseCredit: true },
    });
    expect(f.started).toBe(prepared.value.calibration.slots.length);
    if (run.ok)
      expect(
        verifyDiagnosticCalibration(run.value.calibrationId, { dependencies: f.dependencies }).ok,
      ).toBe(true);
  });

  it('refuses a pre-existing owned run root before ledger creation or allocation', async () => {
    const f = fixture();
    const prepared = prepareDiagnosticCalibration(
      { draftFile: f.draftFile },
      { dependencies: f.dependencies },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    mkdirSync(path.join(f.skillRoot, 'evidence/runs', prepared.value.calibration.slots[0]!.runId), {
      recursive: true,
    });
    const result = await runDiagnosticCalibration(prepared.value, {
      dependencies: f.dependencies,
    });
    expect(result).toEqual({ ok: false, code: 'CALIBRATION_CONSUMED' });
    expect(f.started).toBe(0);
    expect(readdirSync(path.join(f.skillRoot, 'evidence')).includes('governance')).toBe(false);
  });

  it('refuses ledger mutation and an unsafe nested evidence file on reread', async () => {
    const f = fixture();
    const prepared = prepareDiagnosticCalibration(
      { draftFile: f.draftFile },
      { dependencies: f.dependencies },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const run = await runDiagnosticCalibration(prepared.value, {
      dependencies: f.dependencies,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const verify = () =>
      verifyDiagnosticCalibration(run.value.calibrationId, {
        dependencies: f.dependencies,
      });
    expect(verify().ok).toBe(true);
    const nestedFile = path.join(
      f.skillRoot,
      'evidence/runs',
      prepared.value.calibration.slots[0]!.runId,
      'nested/manifest.json',
    );
    rmSync(nestedFile);
    symlinkSync(f.draftFile, nestedFile);
    expect(verify().ok).toBe(false);
    rmSync(nestedFile);
    writeFileSync(nestedFile, '{"child":true}\n');
    expect(verify().ok).toBe(true);
    const eventFile = path.join(
      f.skillRoot,
      'evidence/governance/budget/measurements/calibrations',
      run.value.calibrationId,
      'events/event-000003.json',
    );
    writeFileSync(
      eventFile,
      readFileSync(eventFile, 'utf8').replace('slot-started', 'slot-finished'),
    );
    expect(verify()).toEqual({ ok: false, code: 'LEDGER_INVALID' });
  });

  it('preserves an unstarted order when the monotonic clock resets before launch', async () => {
    const f = fixture();
    const prepared = prepareDiagnosticCalibration(
      { draftFile: f.draftFile },
      { dependencies: f.dependencies },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    let sample = 0;
    const run = await runDiagnosticCalibration(prepared.value, {
      dependencies: {
        ...f.dependencies,
        monotonicNow: () => (++sample === 1 ? 10 : 1),
      },
    });
    expect(run).toMatchObject({
      ok: true,
      value: { state: 'INTERRUPTED', completedCount: 0, noReleaseCredit: true },
    });
    expect(f.started).toBe(0);
    if (run.ok) {
      expect(run.value.unstartedOrders).toHaveLength(prepared.value.calibration.slots.length);
      expect(
        verifyDiagnosticCalibration(run.value.calibrationId, {
          dependencies: f.dependencies,
        }),
      ).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', timing: null, slots: [] },
      });
    }
  });
});

describe('measured-run metric projection (pure, no-credit)', () => {
  const RUN_ID = 'run-20260926T120000Z-000001';
  const WALL_START = '2026-09-26T12:00:00.000Z';
  const WALL_END = '2026-09-26T12:00:01.000Z';

  function measuredTiming(elapsedMs = 5): GovernanceTimingV1 {
    return createGovernanceTiming({
      monotonicStart: 1_000,
      monotonicEnd: 1_000 + elapsedMs,
      wallStart: WALL_START,
      wallEnd: WALL_END,
    })!;
  }

  function measuredInventory(
    evidenceFileCount = 2,
    evidenceByteCount = 128,
  ): BudgetRunInventorySummaryV1 {
    return { evidenceFileCount, evidenceByteCount };
  }

  /** A small strict-shaped non-Image record: only an Action Cycle projection, no tear counter. */
  function baseRunRecord(): BudgetMeasuredRunRecordSourceV1 {
    return {
      schemaVersion: 4,
      command: 'diagnostic',
      runId: RUN_ID,
      nestedProjections: [{ schemaVersion: 4, family: 'action-cycle' }],
    };
  }

  function imageRunRecord(
    cycles: readonly { readonly tornRecaptureCount?: number }[],
  ): BudgetMeasuredRunRecordSourceV1 {
    return {
      schemaVersion: 4,
      command: 'diagnostic',
      runId: RUN_ID,
      nestedProjections: [{ schemaVersion: 4, family: 'image', cycles }],
    };
  }

  function measuredInput(
    overrides: Partial<BudgetMeasuredRunProjectionInputV1> = {},
  ): BudgetMeasuredRunProjectionInputV1 {
    return {
      entryId: 'entry-text',
      runId: RUN_ID,
      family: 'text',
      timing: measuredTiming(),
      inventory: measuredInventory(),
      record: baseRunRecord(),
      ...overrides,
    };
  }

  it('sums each strict Image cycle tear counter exactly once and preserves verified numbers', () => {
    const result = projectBudgetMeasuredRun(
      measuredInput({
        family: 'image',
        entryId: 'entry-image',
        record: imageRunRecord([
          { tornRecaptureCount: 2 },
          { tornRecaptureCount: 3 },
          { tornRecaptureCount: 1 },
        ]),
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        runId: RUN_ID,
        entryId: 'entry-image',
        elapsedMs: 5,
        evidenceFileCount: 2,
        evidenceByteCount: 128,
        imageTornRecaptures: 6,
        imageApplicability: 'MEASURED',
      },
    });
  });

  it('measures a strict Image run with zero tears as a real zero, not unavailable', () => {
    const result = projectBudgetMeasuredRun(
      measuredInput({
        family: 'image',
        record: imageRunRecord([{ tornRecaptureCount: 0 }, { tornRecaptureCount: 0 }]),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { imageTornRecaptures: 0, imageApplicability: 'MEASURED' },
    });
  });

  it('returns UNAVAILABLE with a null counter for a selected non-Image family, never NOT_APPLICABLE', () => {
    for (const family of ['text', 'object', 'crossword', 'history', 'restore'] as const) {
      const result = projectBudgetMeasuredRun(
        measuredInput({ family, entryId: `entry-${family}`, record: baseRunRecord() }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.imageTornRecaptures).toBeNull();
      expect(result.value.imageApplicability).toBe('UNAVAILABLE');
      expect(result.value.imageApplicability).not.toBe('NOT_APPLICABLE');
    }
  });

  it('refuses a selected Image run whose strict projection is missing', () => {
    expect(
      projectBudgetMeasuredRun(measuredInput({ family: 'image', record: baseRunRecord() })).ok,
    ).toBe(false);
  });

  it('refuses an unrecognized family or a record from a different run', () => {
    expect(projectBudgetMeasuredRun(measuredInput({ family: 'unknown' as 'text' }))).toMatchObject({
      ok: false,
      code: 'INPUT_INVALID',
    });
    expect(
      projectBudgetMeasuredRun(
        measuredInput({ record: { ...baseRunRecord(), runId: 'run-other' } }),
      ),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_INVALID' });
  });

  it('refuses a duplicated Image projection', () => {
    const record = imageRunRecord([{ tornRecaptureCount: 1 }]);
    const mutated: BudgetMeasuredRunRecordSourceV1 = {
      ...record,
      nestedProjections: [
        ...record.nestedProjections,
        { schemaVersion: 4, family: 'image', cycles: [] },
      ],
    };
    expect(projectBudgetMeasuredRun(measuredInput({ family: 'image', record: mutated })).ok).toBe(
      false,
    );
  });

  it('refuses malformed, negative, non-integer or overflowing Image tear counters', () => {
    const cases: readonly (readonly { readonly tornRecaptureCount?: number }[])[] = [
      [{ tornRecaptureCount: -1 }],
      [{ tornRecaptureCount: 1.5 }],
      [{ tornRecaptureCount: Number.NaN }],
      [{ tornRecaptureCount: Number.POSITIVE_INFINITY }],
      [{}],
      [
        { tornRecaptureCount: Number.MAX_SAFE_INTEGER },
        { tornRecaptureCount: Number.MAX_SAFE_INTEGER },
      ],
    ];
    for (const cycles of cases) {
      expect(
        projectBudgetMeasuredRun(measuredInput({ family: 'image', record: imageRunRecord(cycles) }))
          .ok,
      ).toBe(false);
    }
  });

  it('refuses an Image projection with a non-array cycle list or wrong projection schema version', () => {
    const noCycles = {
      schemaVersion: 4,
      command: 'diagnostic',
      runId: RUN_ID,
      nestedProjections: [{ schemaVersion: 4, family: 'image' }],
    } satisfies BudgetMeasuredRunRecordSourceV1;
    expect(projectBudgetMeasuredRun(measuredInput({ family: 'image', record: noCycles })).ok).toBe(
      false,
    );
    const badVersion = {
      schemaVersion: 4,
      command: 'diagnostic',
      runId: RUN_ID,
      nestedProjections: [{ schemaVersion: 3, family: 'image', cycles: [] }],
    } satisfies BudgetMeasuredRunRecordSourceV1;
    expect(
      projectBudgetMeasuredRun(measuredInput({ family: 'image', record: badVersion })).ok,
    ).toBe(false);
  });

  it('refuses invalid elapsed, unsafe file/byte totals and invalid identity', () => {
    const base = measuredTiming();
    expect(projectBudgetMeasuredRun(measuredInput({ timing: { ...base, elapsedMs: -1 } })).ok).toBe(
      false,
    );
    expect(
      projectBudgetMeasuredRun(
        measuredInput({ timing: { ...base, elapsedMs: Number.POSITIVE_INFINITY } }),
      ).ok,
    ).toBe(false);
    expect(
      projectBudgetMeasuredRun(measuredInput({ inventory: measuredInventory(-1, 0) })).ok,
    ).toBe(false);
    expect(
      projectBudgetMeasuredRun(
        measuredInput({ inventory: measuredInventory(0, Number.MAX_SAFE_INTEGER + 1) }),
      ).ok,
    ).toBe(false);
    expect(projectBudgetMeasuredRun(measuredInput({ entryId: '' })).ok).toBe(false);
    expect(projectBudgetMeasuredRun(measuredInput({ runId: '../escape' })).ok).toBe(false);
  });

  it('accepts a strict validated public v4 run record as its source region (compile-time)', () => {
    type Compatible = FinalPublicRunRecordV4 extends BudgetMeasuredRunRecordSourceV1 ? true : never;
    const compatible: Compatible = true;
    expect(compatible).toBe(true);
  });
});

describe('strict per-child Release budget facts (WP5-B, ADR 0112)', () => {
  function writeRunRoot(runId: string, record: Record<string, unknown>): string {
    const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'release-facts-')));
    roots.push(root);
    const directory = path.join(root, 'evidence', 'runs', runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'run-record.json'), `${JSON.stringify(record)}\n`);
    return root;
  }

  function committedRecord(runId: string): Record<string, unknown> {
    const record = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    record.runId = runId;
    return record;
  }

  it('reads strict owned evidence bytes and no Image counter for a non-Image child', () => {
    const runId = 'release-facts-text-1';
    const record = committedRecord(runId);
    const view = readFinalPublicRecord(record);
    expect(view.kind).toBe('current-v4');
    if (view.kind !== 'current-v4') return;
    const root = writeRunRoot(runId, record);
    const result = readReleaseChildStrictFacts({
      skillRoot: root,
      runId,
      family: 'text',
      expectedRecordDigest: sha256Hex(canonicalize(view.record)),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      family: 'text',
      evidenceByteCount: Buffer.byteLength(`${JSON.stringify(record)}\n`),
      imageTornRecaptures: null,
    });
  });

  it('refuses an Image family whose strict persisted counter is absent', () => {
    const runId = 'release-facts-image-missing';
    const root = writeRunRoot(runId, committedRecord(runId));
    expect(readReleaseChildStrictFacts({ skillRoot: root, runId, family: 'image' })).toMatchObject({
      ok: false,
      code: 'MEASUREMENT_INVALID',
    });
  });

  it('refuses a record whose exact bytes do not join the verified child digest', () => {
    const runId = 'release-facts-digest';
    const root = writeRunRoot(runId, committedRecord(runId));
    expect(
      readReleaseChildStrictFacts({
        skillRoot: root,
        runId,
        family: 'text',
        expectedRecordDigest: 'a'.repeat(64),
      }),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_INVALID' });
  });

  it('refuses an absent owned evidence root and an unsafe run id', () => {
    const root = realpathSync(
      mkdtempSync(path.join(realpathSync(os.tmpdir()), 'release-facts-empty-')),
    );
    roots.push(root);
    expect(
      readReleaseChildStrictFacts({
        skillRoot: root,
        runId: 'release-facts-absent',
        family: 'text',
      }),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_INVALID' });
    expect(
      readReleaseChildStrictFacts({ skillRoot: root, runId: '../escape', family: 'text' }),
    ).toMatchObject({ ok: false, code: 'INPUT_INVALID' });
  });

  it('rederives owned evidence bytes from root files, never a stored scalar, and refuses a mutated record (WP5-C C9)', () => {
    const runId = 'release-facts-rederive';
    const record = committedRecord(runId);
    const view = readFinalPublicRecord(record);
    expect(view.kind).toBe('current-v4');
    if (view.kind !== 'current-v4') return;
    const root = writeRunRoot(runId, record);
    const expected = sha256Hex(canonicalize(view.record));
    const before = readReleaseChildStrictFacts({
      skillRoot: root,
      runId,
      family: 'text',
      expectedRecordDigest: expected,
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    // Adding one owned evidence artifact changes the strictly recomputed byte
    // total: the count is derived from the rooted files, not persisted state.
    const extra = Buffer.from('owned-evidence-payload\n');
    writeFileSync(path.join(root, 'evidence', 'runs', runId, 'attachment.bin'), extra);
    const after = readReleaseChildStrictFacts({
      skillRoot: root,
      runId,
      family: 'text',
      expectedRecordDigest: expected,
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.evidenceByteCount).toBe(before.value.evidenceByteCount + extra.byteLength);
    // A mutated record whose exact bytes no longer join the verified child digest
    // refuses rather than rederiving from the replaced bytes.
    writeFileSync(
      path.join(root, 'evidence', 'runs', runId, 'run-record.json'),
      `${JSON.stringify({ ...record, finalOutcome: 'BUG' })}\n`,
    );
    expect(
      readReleaseChildStrictFacts({
        skillRoot: root,
        runId,
        family: 'text',
        expectedRecordDigest: expected,
      }),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_INVALID' });
  });
});

function listTree(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const next = relative ? `${relative}/${name}` : name;
      if (lstatSync(absolute).isDirectory()) walk(absolute, next);
      else files.push(next);
    }
  };
  walk(root, '');
  return files;
}

async function calibratedId(
  f: ReturnType<typeof fixture>,
  deps: BudgetRuntimeDependencies,
): Promise<string> {
  const prepared = prepareDiagnosticCalibration({ draftFile: f.draftFile }, { dependencies: deps });
  if (!prepared.ok) throw new Error(`prepareDiagnosticCalibration: ${prepared.code}`);
  const run = await runDiagnosticCalibration(prepared.value, { dependencies: deps });
  if (!run.ok) throw new Error(`runDiagnosticCalibration: ${run.code}`);
  return run.value.calibrationId;
}

async function qualificationId(
  f: ReturnType<typeof fixture>,
  deps: BudgetRuntimeDependencies,
  scenarios: readonly string[] = ['drag-warped-nested', 'replace-image', 'serialize-raw-semantic'],
): Promise<string> {
  const draft = JSON.parse(readFileSync(f.draftFile, 'utf8')) as ExecutableSelectionManifestDraftV1;
  const prepared = prepareQualificationBatch(
    {
      draft,
      entryIds: scenarios.map((scenario) => {
        const entry = draft.content.entries.find((item) => item.scenarioId === scenario);
        if (!entry) throw new Error(`Missing fixture scenario: ${scenario}`);
        return entry.entryId;
      }),
      selectionRationale: 'Fixed three-slot representative sample for the WP3b join.',
    },
    { dependencies: deps },
  );
  if (!prepared.ok) throw new Error(`prepareQualificationBatch: ${prepared.code}`);
  const result = await runQualificationBatch(prepared.batch.batchId, { dependencies: deps });
  if (result?.state !== 'REVIEW_READY') throw new Error('runQualificationBatch did not pass');
  return prepared.batch.batchId;
}

describe('read-only measurement-set eligibility join (WP3b, no persistence)', () => {
  it.each([
    ['other valid entries', ['serialize-raw-semantic', 'serialize-roundtrip', 'undo-redo-text']],
    [
      'reordered approved entries',
      ['replace-image', 'drag-warped-nested', 'serialize-raw-semantic'],
    ],
  ] as const)('refuses a passing same-candidate batch with %s', async (_name, scenarios) => {
    const f = fixture();
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies, scenarios);
    const retention = appendRetentionAudit(f.skillRoot);
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;
    const before = listTree(f.skillRoot);
    const input = {
      calibrationId,
      qualificationBatchId,
      retentionAuditId: retention.value.auditId,
    };
    expect(deriveFreshMeasurementContent(input, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'LINEAGE_MISMATCH',
    });
    expect(createFreshMeasurementSet(input, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'LINEAGE_MISMATCH',
    });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses changed or missing packaged authority even when the Qualification sample matches', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;
    const input = {
      calibrationId,
      qualificationBatchId,
      retentionAuditId: retention.value.auditId,
    };
    const proposal = path.join(f.skillRoot, 'governance/authorities/0102/proposed-scope.json');
    writeFileSync(proposal, `${readFileSync(proposal, 'utf8')} `);
    const before = listTree(f.skillRoot);
    expect(createFreshMeasurementSet(input, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'LINEAGE_MISMATCH',
    });
    expect(listTree(f.skillRoot)).toEqual(before);
    rmSync(proposal);
    symlinkSync(f.draftFile, proposal);
    expect(deriveFreshMeasurementContent(input, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'LINEAGE_MISMATCH',
    });
  });
  it('derives validated content from real calibration, Qualification and retention files with no writes', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;

    const before = listTree(f.skillRoot);
    const result = deriveFreshMeasurementContent(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    expect(listTree(f.skillRoot)).toEqual(before);
    expect(result).toEqual({ ok: true, value: expect.any(Object) });
    if (!result.ok) return;
    const content = result.value;

    expect(content.schemaVersion).toBe(1);
    expect(content.joinMethod).toBe(BUDGET_MEASUREMENT_JOIN_METHOD);
    expect(content.verifierMethod).toBe(BUDGET_MEASUREMENT_VERIFIER_METHOD);
    const contentDigest = (value: unknown) =>
      createHash('sha256').update(canonicalize(value)).digest('hex');
    expect(
      contentDigest({ ...content, joinMethod: 'fresh-qualification-calibration-retention-v2' }),
    ).not.toBe(contentDigest(content));
    expect(
      contentDigest({ ...content, verifierMethod: 'strict-current-ledger-child-retention-v2' }),
    ).not.toBe(contentDigest(content));
    expect(content.calibrationId).toBe(calibrationId);
    expect(content.qualificationBatchId).toBe(qualificationBatchId);
    expect(content.retentionAuditId).toBe(retention.value.auditId);
    expect(content.releaseCredit).toBe(false);
    expect(content.calibrationRuns).toHaveLength(8);
    expect(content.qualificationRuns).toHaveLength(3);
    for (const digest of [
      content.calibrationLedgerDigest,
      content.qualificationLedgerDigest,
      content.retentionAuditDigest,
      content.manifestFingerprint,
      content.sourceProvenanceDigest,
    ])
      expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const verified = verifyDiagnosticCalibration(calibrationId, { dependencies: f.dependencies });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(content.calibrationLedgerDigest).toBe(verified.value.finalLedgerDigest);
      expect(content.calibrationElapsedMs).toBe(verified.value.timing?.elapsedMs);
      expect(content.manifestId).toBe(verified.value.calibration.manifestId);
      expect(content.manifestFingerprint).toBe(verified.value.calibration.manifestFingerprint);
      expect(content.sourceProvenanceDigest).toBe(
        verified.value.calibration.sourceProvenanceDigest,
      );
      expect(content.requiredCellId).toBe(verified.value.calibration.requiredCell.cellId);
    }

    const families = new Map(content.families.map((entry) => [entry.family, entry]));
    expect(families.size).toBe(6);
    expect(families.get('image')).toEqual({
      family: 'image',
      status: 'MEASURED',
      tornRecaptureCount: 4,
      reason: 'STRICT_V4_IMAGE_CYCLES',
    });
    for (const family of ['text', 'object', 'crossword', 'history', 'restore'] as const) {
      expect(families.get(family)).toEqual({
        family,
        status: 'UNAVAILABLE',
        tornRecaptureCount: null,
        reason: 'NO_TRUSTED_V4_COUNTER',
      });
    }
    expect(
      content.calibrationRuns.filter((run) => run.imageApplicability === 'MEASURED'),
    ).toHaveLength(1);
    expect(
      [...content.calibrationRuns, ...content.qualificationRuns].every(
        (run) => run.evidenceFileCount === 2 && run.evidenceByteCount > 0 && run.elapsedMs > 0,
      ),
    ).toBe(true);

    const again = deriveFreshMeasurementContent(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(canonicalize(again.value)).toBe(canonicalize(content));

    const saved = createFreshMeasurementSet(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok) return;
    expect(saved.value.content).toEqual(content);
    expect(saved.value.measurementSetId).toMatch(/^bset-[0-9a-f]{64}$/);
    expect(
      verifyBudgetMeasurementSet(saved.value.measurementSetId, { dependencies: f.dependencies }),
    ).toEqual(saved);
    expect(
      verifyBudgetMeasurementSet(`bset-${'0'.repeat(64)}`, { dependencies: f.dependencies }),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_NOT_FOUND' });
    expect(
      createFreshMeasurementSet(
        { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
        { dependencies: f.dependencies },
      ),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_WRITE_REFUSED' });
    const recordFile = path.join(
      f.skillRoot,
      'evidence/governance/budget/measurements/sets',
      `${saved.value.measurementSetId}.json`,
    );
    const originalBytes = readFileSync(recordFile, 'utf8');
    for (const field of ['joinMethod', 'verifierMethod'] as const) {
      for (const replacement of [undefined, 'unknown-method-v2']) {
        const altered = JSON.parse(originalBytes) as {
          content: Record<string, unknown>;
        };
        if (replacement === undefined) delete altered.content[field];
        else altered.content[field] = replacement;
        writeFileSync(recordFile, `${JSON.stringify(altered)}\n`);
        expect(
          verifyBudgetMeasurementSet(saved.value.measurementSetId, {
            dependencies: f.dependencies,
          }),
        ).toMatchObject({ ok: false, code: 'MEASUREMENT_INVALID' });
      }
    }
    writeFileSync(recordFile, originalBytes);
    expect(
      verifyBudgetMeasurementSet(saved.value.measurementSetId, { dependencies: f.dependencies }),
    ).toEqual(saved);
    writeFileSync(recordFile, `${readFileSync(recordFile, 'utf8')} `);
    expect(
      verifyBudgetMeasurementSet(saved.value.measurementSetId, { dependencies: f.dependencies }),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_INVALID' });
    rmSync(recordFile);
    symlinkSync(fixturePath, recordFile);
    expect(
      verifyBudgetMeasurementSet(saved.value.measurementSetId, { dependencies: f.dependencies }),
    ).toMatchObject({ ok: false, code: 'MEASUREMENT_INVALID' });
  });

  it('refuses an absent Qualification batch with a closed code and no writes', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;
    const before = listTree(f.skillRoot);
    const result = deriveFreshMeasurementContent(
      {
        calibrationId,
        qualificationBatchId: `qbatch-${randomUUID()}`,
        retentionAuditId: retention.value.auditId,
      },
      { dependencies: f.dependencies },
    );
    expect(result).toEqual({ ok: false, code: 'QUALIFICATION_INVALID' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses a Qualification batch whose matched source lineage is wrong', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f, f.dependencies);
    const wrongDeps: BudgetRuntimeDependencies = {
      ...f.dependencies,
      collectSourceDigest: () => 'b'.repeat(64),
    };
    const qualificationBatchId = await qualificationId(f, wrongDeps);
    const retention = appendRetentionAudit(f.skillRoot);
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;
    const result = deriveFreshMeasurementContent(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      {
        dependencies: {
          ...f.dependencies,
          verifyQualification: (batchId) =>
            verifyQualificationBatch(batchId, { dependencies: wrongDeps }),
        },
      },
    );
    expect(result).toEqual({ ok: false, code: 'LINEAGE_MISMATCH' });
  });

  it('refuses a retention snapshot that does not cover the required lineage bytes', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;
    // Qualification runs after the snapshot; its ledger/run bytes are uncovered.
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const before = listTree(f.skillRoot);
    const result = deriveFreshMeasurementContent(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    expect(result).toEqual({ ok: false, code: 'RETENTION_INVALID' });
    expect(listTree(f.skillRoot)).toEqual(before);
    expect(
      deriveFreshMeasurementContent(
        {
          calibrationId,
          qualificationBatchId,
          retentionAuditId: `retention-${'0'.repeat(64)}`,
        },
        { dependencies: f.dependencies },
      ),
    ).toEqual({ ok: false, code: 'RETENTION_INVALID' });
  });
});

const policyDigest = (value: unknown): string =>
  createHash('sha256').update(canonicalize(value)).digest('hex');

type ImageState = 'MEASURED' | 'UNAVAILABLE' | 'NOT_APPLICABLE';

function contentFixture(imageState: ImageState = 'MEASURED'): BudgetMeasurementSetContentV1 {
  const imageRun = (
    runId: string,
    entryId: string,
    elapsedMs: number,
    evidenceByteCount: number,
    tears: number,
  ): BudgetMeasuredRunV1 =>
    imageState === 'MEASURED'
      ? {
          runId,
          entryId,
          elapsedMs,
          evidenceFileCount: 2,
          evidenceByteCount,
          imageTornRecaptures: tears,
          imageApplicability: 'MEASURED',
        }
      : {
          runId,
          entryId,
          elapsedMs,
          evidenceFileCount: 2,
          evidenceByteCount,
          imageTornRecaptures: null,
          imageApplicability: 'UNAVAILABLE',
        };
  const otherRun = (
    runId: string,
    entryId: string,
    elapsedMs: number,
    evidenceByteCount: number,
  ): BudgetMeasuredRunV1 => ({
    runId,
    entryId,
    elapsedMs,
    evidenceFileCount: 2,
    evidenceByteCount,
    imageTornRecaptures: null,
    imageApplicability: 'UNAVAILABLE',
  });
  const imageFamily: BudgetFamilyMeasurementV1 =
    imageState === 'MEASURED'
      ? {
          family: 'image',
          status: 'MEASURED',
          tornRecaptureCount: 4,
          reason: 'STRICT_V4_IMAGE_CYCLES',
        }
      : imageState === 'UNAVAILABLE'
        ? {
            family: 'image',
            status: 'UNAVAILABLE',
            tornRecaptureCount: null,
            reason: 'NO_TRUSTED_V4_COUNTER',
          }
        : {
            family: 'image',
            status: 'NOT_APPLICABLE',
            tornRecaptureCount: null,
            reason: 'NOT_IN_MANIFEST',
          };
  const unavailableFamily = (
    family: BudgetFamilyMeasurementV1['family'],
  ): BudgetFamilyMeasurementV1 => ({
    family,
    status: 'UNAVAILABLE',
    tornRecaptureCount: null,
    reason: 'NO_TRUSTED_V4_COUNTER',
  });
  return {
    schemaVersion: 1,
    joinMethod: BUDGET_MEASUREMENT_JOIN_METHOD,
    verifierMethod: BUDGET_MEASUREMENT_VERIFIER_METHOD,
    calibrationId: 'cal-11111111-1111-1111-1111-111111111111',
    calibrationLedgerDigest: 'a'.repeat(64),
    qualificationBatchId: 'qbatch-22222222-2222-2222-2222-222222222222',
    qualificationLedgerDigest: 'b'.repeat(64),
    retentionAuditId: 'retention-33333333-3333-3333-3333-333333333333',
    retentionAuditDigest: 'c'.repeat(64),
    manifestId: 'manifest-00000000000000000000000000000000',
    manifestFingerprint: 'd'.repeat(64),
    sourceProvenanceDigest: 'e'.repeat(64),
    requiredCellId: 'chromium-desktop-1280x800',
    calibrationElapsedMs: 1000,
    qualificationElapsedMs: 2000,
    calibrationRuns: [
      imageRun('run-0001', 'entry-image', 400, 10, 3),
      otherRun('run-0002', 'entry-text', 600, 20),
    ],
    qualificationRuns: [
      imageRun('run-0101', 'entry-image', 800, 5, 1),
      otherRun('run-0102', 'entry-text', 700, 7),
      otherRun('run-0103', 'entry-object', 500, 11),
    ],
    families: [
      imageFamily,
      unavailableFamily('text'),
      unavailableFamily('object'),
      unavailableFamily('crossword'),
      unavailableFamily('history'),
      unavailableFamily('restore'),
    ],
    releaseCredit: false,
  };
}

function policyFixture(
  content: BudgetMeasurementSetContentV1,
  retainedInventoryBytes = 500,
): BudgetPolicyProposalV1 {
  const digest = policyDigest(content);
  const sum = (runs: readonly BudgetMeasuredRunV1[]): number =>
    runs.reduce((total, run) => total + run.evidenceByteCount, 0);
  const image = content.families.find((family) => family.family === 'image');
  let imageTotal: number | null = null;
  if (image?.status === 'MEASURED') {
    let total = 0;
    for (const run of [...content.calibrationRuns, ...content.qualificationRuns])
      if (run.imageApplicability === 'MEASURED' && run.imageTornRecaptures !== null)
        total += run.imageTornRecaptures;
    imageTotal = total;
  }
  return {
    schemaVersion: BUDGET_POLICY_SCHEMA_VERSION,
    method: BUDGET_POLICY_METHOD,
    state: 'PROPOSED_NOT_APPROVED',
    releaseCredit: false,
    measurementSetId: `bset-${digest}`,
    measurementSetContentDigest: digest,
    retentionAuditId: content.retentionAuditId,
    retentionAuditDigest: content.retentionAuditDigest,
    manifestId: content.manifestId,
    manifestFingerprint: content.manifestFingerprint,
    sourceProvenanceDigest: content.sourceProvenanceDigest,
    requiredCellId: content.requiredCellId,
    familyStates: content.families.map((family) => ({
      family: family.family,
      status: family.status,
    })),
    tornCounterDependencies: content.families
      .filter((family) => family.status === 'MEASURED')
      .map((family) => family.family),
    ceilings: {
      releaseDurationMs: content.calibrationElapsedMs,
      releaseEvidenceBytes: sum(content.calibrationRuns),
      qualificationDurationMs: content.qualificationElapsedMs,
      qualificationEvidenceBytes: sum(content.qualificationRuns),
      retainedEvidenceBytes: retainedInventoryBytes,
      imageTornRecaptures: imageTotal,
    },
  };
}

function withCeiling(
  policy: BudgetPolicyProposalV1,
  key: keyof BudgetPolicyCeilingsV1,
  value: number,
): BudgetPolicyProposalV1 {
  const ceilings = { ...policy.ceilings, [key]: value } as BudgetPolicyCeilingsV1;
  return { ...policy, ceilings };
}

function withImageCeiling(
  policy: BudgetPolicyProposalV1,
  value: number | null,
): BudgetPolicyProposalV1 {
  return { ...policy, ceilings: { ...policy.ceilings, imageTornRecaptures: value } };
}

function policyWith(
  policy: BudgetPolicyProposalV1,
  patch: Record<string, unknown>,
): BudgetPolicyProposalV1 {
  return { ...policy, ...patch } as unknown as BudgetPolicyProposalV1;
}

function contentWith(
  content: BudgetMeasurementSetContentV1,
  patch: Record<string, unknown>,
): BudgetMeasurementSetContentV1 {
  return { ...content, ...patch } as unknown as BudgetMeasurementSetContentV1;
}

function check(
  content: BudgetMeasurementSetContentV1,
  policy: BudgetPolicyProposalV1,
  retainedInventoryBytes = 500,
) {
  return checkBudgetPolicyFeasibility({ content, policy, retainedInventoryBytes });
}

describe('pure full-scope-envelope-v1 feasibility checker (WP4, no persistence/approval)', () => {
  const ceilingCases: readonly {
    readonly key: keyof BudgetPolicyCeilingsV1;
    readonly observed: number;
  }[] = [
    { key: 'releaseDurationMs', observed: 1000 },
    { key: 'releaseEvidenceBytes', observed: 30 },
    { key: 'qualificationDurationMs', observed: 2000 },
    { key: 'qualificationEvidenceBytes', observed: 23 },
    { key: 'retainedEvidenceBytes', observed: 500 },
    { key: 'imageTornRecaptures', observed: 4 },
  ];

  it.each(ceilingCases)('accepts equality and headroom but refuses above the $key ceiling', ({
    key,
    observed,
  }) => {
    const content = contentFixture();
    const policy = policyFixture(content);
    expect(check(content, withCeiling(policy, key, observed))).toMatchObject({
      ok: true,
      decision: 'FEASIBLE',
    });
    expect(check(content, withCeiling(policy, key, observed + 1))).toMatchObject({
      ok: true,
      decision: 'FEASIBLE',
    });
    expect(check(content, withCeiling(policy, key, observed - 1))).toEqual({
      ok: false,
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('reports every observed dimension and is deterministic without mutating its inputs', () => {
    const content = contentFixture();
    const policy = policyFixture(content);
    const contentBefore = canonicalize(content);
    const policyBefore = canonicalize(policy);
    const first = check(content, policy);
    expect(first).toEqual({
      ok: true,
      decision: 'FEASIBLE',
      observed: {
        releaseDurationMs: 1000,
        releaseEvidenceBytes: 30,
        qualificationDurationMs: 2000,
        qualificationEvidenceBytes: 23,
        retainedInventoryBytes: 500,
        imageTornRecaptures: 4,
      },
    });
    expect(check(content, policy)).toEqual(first);
    expect(canonicalize(content)).toBe(contentBefore);
    expect(canonicalize(policy)).toBe(policyBefore);
  });

  it('refuses an unknown or missing policy field, version or method', () => {
    const content = contentFixture();
    const policy = policyFixture(content);
    expect(check(content, policyWith(policy, { extra: true }))).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
    const { releaseCredit: _dropped, ...missing } = policy;
    expect(check(content, missing as unknown as BudgetPolicyProposalV1)).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
    expect(check(content, policyWith(policy, { schemaVersion: 2 }))).toEqual({
      ok: false,
      code: 'POLICY_UNSUPPORTED',
    });
    expect(check(content, policyWith(policy, { method: 'some-other-method-v1' }))).toEqual({
      ok: false,
      code: 'POLICY_UNSUPPORTED',
    });
    expect(check(content, policyWith(policy, { state: 'APPROVED' }))).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
  });

  it('refuses negative, fractional or overflowing ceilings and an invalid retained byte input', () => {
    const content = contentFixture();
    const policy = policyFixture(content);
    expect(check(content, withCeiling(policy, 'releaseEvidenceBytes', -1))).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
    expect(check(content, withCeiling(policy, 'retainedEvidenceBytes', 500.5))).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
    expect(
      check(
        content,
        withCeiling(policy, 'qualificationEvidenceBytes', Number.MAX_SAFE_INTEGER + 2),
      ),
    ).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
    expect(
      check(content, withCeiling(policy, 'releaseDurationMs', Number.POSITIVE_INFINITY)),
    ).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
    expect(check(content, policy, -1)).toEqual({ ok: false, code: 'RETAINED_BYTES_INVALID' });
    expect(check(content, policy, 1.5)).toEqual({ ok: false, code: 'RETAINED_BYTES_INVALID' });
  });

  it('refuses mismatched measurement-set, manifest, source, cell and retention bindings', () => {
    const content = contentFixture();
    const policy = policyFixture(content);
    for (const patch of [
      { measurementSetContentDigest: '0'.repeat(64) },
      { measurementSetId: `bset-${'0'.repeat(64)}` },
      { manifestId: 'manifest-ffffffffffffffffffffffffffffffff' },
      { manifestFingerprint: 'f'.repeat(64) },
      { sourceProvenanceDigest: 'f'.repeat(64) },
      { requiredCellId: 'chromium-desktop-9999x9999' },
      { retentionAuditId: 'retention-ffffffff-ffff-ffff-ffff-ffffffffffff' },
      { retentionAuditDigest: 'f'.repeat(64) },
    ])
      expect(check(content, policyWith(policy, patch))).toEqual({
        ok: false,
        code: 'BINDING_MISMATCH',
      });
  });

  it('refuses policy dependencies on unavailable or absent family counters', () => {
    const content = contentFixture();
    const policy = policyFixture(content);
    expect(
      check(content, policyWith(policy, { tornCounterDependencies: ['image', 'text'] })),
    ).toEqual({ ok: false, code: 'UNAVAILABLE_DEPENDENCY' });
    expect(
      check(content, policyWith(policy, { tornCounterDependencies: ['image', 'crossword'] })),
    ).toEqual({ ok: false, code: 'UNAVAILABLE_DEPENDENCY' });
    expect(
      check(content, policyWith(policy, { tornCounterDependencies: ['image', 'bogus'] })),
    ).toEqual({
      ok: false,
      code: 'POLICY_INVALID',
    });
    expect(check(content, policyWith(policy, { tornCounterDependencies: [] }))).toEqual({
      ok: false,
      code: 'FAMILY_STATE_MISMATCH',
    });
  });

  it('refuses a selected Image whose count is missing or unmeasured', () => {
    const measured = contentFixture();
    const measuredPolicy = policyFixture(measured);
    expect(check(measured, withImageCeiling(measuredPolicy, null))).toEqual({
      ok: false,
      code: 'REQUIRED_IMAGE_UNMEASURED',
    });
    const unavailable = contentFixture('UNAVAILABLE');
    expect(check(unavailable, policyFixture(unavailable))).toEqual({
      ok: false,
      code: 'FAMILY_STATE_MISMATCH',
    });
  });

  it('treats an absent Image as not-applicable with no Image ceiling', () => {
    const content = contentFixture('NOT_APPLICABLE');
    const policy = policyFixture(content);
    expect(policy.ceilings.imageTornRecaptures).toBeNull();
    expect(policy.tornCounterDependencies).toEqual([]);
    expect(check(content, policy)).toEqual({
      ok: true,
      decision: 'FEASIBLE',
      observed: {
        releaseDurationMs: 1000,
        releaseEvidenceBytes: 30,
        qualificationDurationMs: 2000,
        qualificationEvidenceBytes: 23,
        retainedInventoryBytes: 500,
        imageTornRecaptures: null,
      },
    });
    expect(check(content, withImageCeiling(policy, 0))).toEqual({
      ok: false,
      code: 'FAMILY_STATE_MISMATCH',
    });
  });

  it('refuses a mismatched family state and malformed measurement content', () => {
    const content = contentFixture();
    const policy = policyFixture(content);
    const textMeasured = policy.familyStates.map((state) =>
      state.family === 'text' ? { ...state, status: 'MEASURED' as const } : state,
    );
    expect(check(content, policyWith(policy, { familyStates: textMeasured }))).toEqual({
      ok: false,
      code: 'FAMILY_STATE_MISMATCH',
    });
    expect(check(contentWith(content, { releaseCredit: true }), policy)).toEqual({
      ok: false,
      code: 'MEASUREMENT_SHAPE_INVALID',
    });
    expect(check(contentWith(content, { extra: 1 }), policy)).toEqual({
      ok: false,
      code: 'MEASUREMENT_SHAPE_INVALID',
    });
    const firstRun = content.calibrationRuns[0];
    if (!firstRun) throw new Error('fixture missing calibration run');
    const badRun = contentWith(content, {
      calibrationRuns: [{ ...firstRun, evidenceByteCount: 1.5 }],
    });
    expect(check(badRun, policy)).toEqual({ ok: false, code: 'MEASUREMENT_SHAPE_INVALID' });
    const wrongImageTotal = contentWith(content, {
      families: content.families.map((family) =>
        family.family === 'image' ? { ...family, tornRecaptureCount: 5 } : family,
      ),
    });
    expect(check(wrongImageTotal, policy)).toEqual({
      ok: false,
      code: 'MEASUREMENT_SHAPE_INVALID',
    });
  });

  it('accepts a real WP3b-derived measurement set bound to exact ceilings with no writes', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;
    const derived = deriveFreshMeasurementContent(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const retained = retention.value.snapshot.totalByteCount;
    const policy = policyFixture(derived.value, retained);
    const before = listTree(f.skillRoot);
    const result = checkBudgetPolicyFeasibility({
      content: derived.value,
      policy,
      retainedInventoryBytes: retained,
    });
    expect(listTree(f.skillRoot)).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision).toBe('FEASIBLE');
    expect(result.observed).toEqual({
      releaseDurationMs: derived.value.calibrationElapsedMs,
      releaseEvidenceBytes: derived.value.calibrationRuns.reduce(
        (total, run) => total + run.evidenceByteCount,
        0,
      ),
      qualificationDurationMs: derived.value.qualificationElapsedMs,
      qualificationEvidenceBytes: derived.value.qualificationRuns.reduce(
        (total, run) => total + run.evidenceByteCount,
        0,
      ),
      retainedInventoryBytes: retained,
      imageTornRecaptures: 4,
    });
    expect(
      checkBudgetPolicyFeasibility({
        content: derived.value,
        policy: withCeiling(policy, 'retainedEvidenceBytes', retained - 1),
        retainedInventoryBytes: retained,
      }),
    ).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
  });
});

describe('read-only proposal assessment wrapper (WP4, no approval/persistence)', () => {
  const auditRecordPath = (skillRoot: string, auditId: string): string =>
    path.join(skillRoot, 'evidence/governance/retention-audit', `${auditId}.json`);
  const setRecordPath = (skillRoot: string, measurementSetId: string): string =>
    path.join(
      skillRoot,
      'evidence/governance/budget/measurements/sets',
      `${measurementSetId}.json`,
    );

  /** Real calibration + Qualification + retention, then the persisted immutable set. */
  async function savedRealSet(f: ReturnType<typeof fixture>) {
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const saved = createFreshMeasurementSet(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    if (!saved.ok) throw new Error(`createFreshMeasurementSet: ${saved.code}`);
    return { retention, saved };
  }

  it('derives retained bytes from the verified audit and returns a no-approval feasible result with no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const content = saved.value.content;
    // The test supplies the ceilings separately; the retained ceiling equals the
    // independently read audit total so equality is allowed.
    const retained = retention.value.snapshot.totalByteCount;
    const policy = policyFixture(content, retained);
    const before = listTree(f.skillRoot);
    const result = assessBudgetPolicyProposal(saved.value.measurementSetId, policy, {
      dependencies: f.dependencies,
    });
    expect(listTree(f.skillRoot)).toEqual(before);
    expect(result).toEqual({
      ok: true,
      decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED',
      releaseCredit: false,
      measurementSetId: saved.value.measurementSetId,
      measurementSetContentDigest: saved.value.contentDigest,
      retentionAuditId: retention.value.auditId,
      retentionAuditDigest: retention.value.digest,
      observed: {
        releaseDurationMs: content.calibrationElapsedMs,
        releaseEvidenceBytes: content.calibrationRuns.reduce(
          (total, run) => total + run.evidenceByteCount,
          0,
        ),
        qualificationDurationMs: content.qualificationElapsedMs,
        qualificationEvidenceBytes: content.qualificationRuns.reduce(
          (total, run) => total + run.evidenceByteCount,
          0,
        ),
        retainedInventoryBytes: retained,
        imageTornRecaptures: 4,
      },
    });
    // The passing arm can never be confused with policy authorization.
    if (result.ok) expect(result.decision).not.toBe('FEASIBLE');
  });

  it('refuses a retained ceiling below the verified audit bytes, proving no caller byte override', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const tight = policyFixture(saved.value.content, retained - 1);
    const before = listTree(f.skillRoot);
    expect(
      assessBudgetPolicyProposal(saved.value.measurementSetId, tight, {
        dependencies: f.dependencies,
      }),
    ).toEqual({ ok: false, code: 'LIMIT_EXCEEDED' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses an unbound proposal, a missing set and a changed set with no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const policy = policyFixture(saved.value.content, retained);
    const before = listTree(f.skillRoot);
    expect(
      assessBudgetPolicyProposal(
        saved.value.measurementSetId,
        policyWith(policy, { measurementSetId: `bset-${'0'.repeat(64)}` }),
        { dependencies: f.dependencies },
      ),
    ).toEqual({ ok: false, code: 'BINDING_MISMATCH' });
    expect(
      assessBudgetPolicyProposal(
        saved.value.measurementSetId,
        policyWith(policy, { retentionAuditId: 'retention-ffffffff-ffff-ffff-ffff-ffffffffffff' }),
        { dependencies: f.dependencies },
      ),
    ).toEqual({ ok: false, code: 'BINDING_MISMATCH' });
    expect(
      assessBudgetPolicyProposal(`bset-${'0'.repeat(64)}`, policy, {
        dependencies: f.dependencies,
      }),
    ).toEqual({ ok: false, code: 'MEASUREMENT_NOT_FOUND' });
    expect(listTree(f.skillRoot)).toEqual(before);

    const record = setRecordPath(f.skillRoot, saved.value.measurementSetId);
    writeFileSync(record, `${readFileSync(record, 'utf8')} `);
    expect(
      assessBudgetPolicyProposal(saved.value.measurementSetId, policy, {
        dependencies: f.dependencies,
      }),
    ).toEqual({ ok: false, code: 'MEASUREMENT_INVALID' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses a tampered audit with a sanitized code and no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const policy = policyFixture(saved.value.content, retained);
    const record = auditRecordPath(f.skillRoot, retention.value.auditId);
    const before = listTree(f.skillRoot);
    writeFileSync(record, `${readFileSync(record, 'utf8')} `);
    expect(
      assessBudgetPolicyProposal(saved.value.measurementSetId, policy, {
        dependencies: f.dependencies,
      }),
    ).toEqual({ ok: false, code: 'RETENTION_INVALID' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses a missing audit with a sanitized code and no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const policy = policyFixture(saved.value.content, retained);
    rmSync(auditRecordPath(f.skillRoot, retention.value.auditId));
    const before = listTree(f.skillRoot);
    expect(
      assessBudgetPolicyProposal(saved.value.measurementSetId, policy, {
        dependencies: f.dependencies,
      }),
    ).toEqual({ ok: false, code: 'RETENTION_INVALID' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });
});

describe('external-authority approved budget policy verifier (WP4, ADR 0111)', () => {
  const P_ID = `budget-policy-${'1'.repeat(64)}`;
  const R_ID = `budget-policy-${'2'.repeat(64)}`;
  const A_ID = `budget-policy-${'3'.repeat(64)}`;
  const artifactPath = (
    skillRoot: string,
    kind: 'approvals' | 'proposals' | 'reviews',
    id: string,
  ): string => path.join(skillRoot, 'evidence/governance/budget/policies', kind, `${id}.json`);

  function writeArtifact(
    skillRoot: string,
    kind: 'approvals' | 'proposals' | 'reviews',
    id: string,
    value: unknown,
  ): string {
    const directory = path.join(skillRoot, 'evidence/governance/budget/policies', kind);
    mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from(`${canonicalize(value)}\n`);
    writeFileSync(path.join(directory, `${id}.json`), bytes);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function savedRealSet(f: ReturnType<typeof fixture>) {
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const saved = createFreshMeasurementSet(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    if (!saved.ok) throw new Error(`createFreshMeasurementSet: ${saved.code}`);
    return { retention, saved };
  }

  interface TripletOverrides {
    readonly proposal?: Record<string, unknown>;
    readonly review?: Record<string, unknown>;
    readonly approval?: Record<string, unknown>;
    readonly policy?: Record<string, unknown>;
  }

  /** Write the three canonical artifacts and return their exact raw digests. */
  function writeTriplet(
    skillRoot: string,
    content: BudgetMeasurementSetContentV1,
    retainedBytes: number,
    overrides: TripletOverrides = {},
  ): { readonly proposal: string; readonly review: string; readonly approval: string } {
    const policy = {
      ...policyFixture(content, retainedBytes),
      ...(overrides.policy ?? {}),
    } as BudgetPolicyProposalV1;
    const proposalValue = {
      schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
      proposalId: P_ID,
      state: 'PROPOSED_NOT_APPROVED',
      releaseCredit: false,
      proposal: policy,
      rationale: 'Independent proposal rationale.',
      ...(overrides.proposal ?? {}),
    } as unknown as BudgetPolicyProposalArtifactV1;
    const proposalDigest = writeArtifact(skillRoot, 'proposals', P_ID, proposalValue);

    const reviewValue = {
      schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
      reviewId: R_ID,
      reviewer: 'independent-reviewer',
      result: 'PASS',
      proposalId: P_ID,
      proposalDigest,
      rationale: 'Independent review rationale.',
      ...(overrides.review ?? {}),
    } as unknown as BudgetPolicyReviewArtifactV1;
    const reviewDigest = writeArtifact(skillRoot, 'reviews', R_ID, reviewValue);

    const approvalValue = {
      schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
      approvalId: A_ID,
      decisionMaker: BUDGET_POLICY_DECISION_MAKER,
      mandate: BUDGET_POLICY_MANDATE,
      decisionScope: BUDGET_POLICY_DECISION_SCOPE,
      proposalId: P_ID,
      proposalDigest,
      reviewId: R_ID,
      reviewDigest,
      rationale: 'Delegated-owner approval rationale.',
      timestamp: '2026-09-27T00:00:00.000Z',
      ...(overrides.approval ?? {}),
    } as unknown as BudgetPolicyApprovalArtifactV1;
    const approvalDigest = writeArtifact(skillRoot, 'approvals', A_ID, approvalValue);

    return { proposal: proposalDigest, review: reviewDigest, approval: approvalDigest };
  }

  /** Simulated independent trust root: literal pins, never a same-user read. */
  function pinningProvider(
    digests: { readonly proposal: string; readonly review: string; readonly approval: string },
    overrides: Record<string, unknown> = {},
  ): BudgetPolicyAuthorityProvider {
    return {
      resolve: (id) =>
        id === A_ID
          ? ({
              decisionScope: BUDGET_POLICY_DECISION_SCOPE,
              proposalId: P_ID,
              proposalDigest: digests.proposal,
              reviewId: R_ID,
              reviewDigest: digests.review,
              approvalId: A_ID,
              approvalDigest: digests.approval,
              ...overrides,
            } as BudgetPolicyAuthorityAttestationV1)
          : null,
    };
  }

  it('refuses with AUTHORITY_UNATTESTED by default even when all three artifacts verify', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    writeTriplet(f.skillRoot, saved.value.content, retention.value.snapshot.totalByteCount);
    const before = listTree(f.skillRoot);
    expect(verifyApprovedBudgetPolicy(A_ID, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'AUTHORITY_UNATTESTED',
    });
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: REFUSING_BUDGET_POLICY_AUTHORITY_PROVIDER,
      }),
    ).toEqual({ ok: false, code: 'AUTHORITY_UNATTESTED' });
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: { resolve: () => null },
      }),
    ).toEqual({ ok: false, code: 'AUTHORITY_UNATTESTED' });
    // Even an absent options object refuses before touching any file.
    expect(verifyApprovedBudgetPolicy(A_ID)).toEqual({
      ok: false,
      code: 'AUTHORITY_UNATTESTED',
    });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('verifies an independent pinned triplet against the current feasible set with no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const triplet = writeTriplet(f.skillRoot, saved.value.content, retained);
    const before = listTree(f.skillRoot);
    const result = verifyApprovedBudgetPolicy(A_ID, {
      dependencies: f.dependencies,
      authority: pinningProvider(triplet),
    });
    expect(listTree(f.skillRoot)).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision).toBe('POLICY_VERIFIED_NON_CREDITABLE');
    expect(result.releaseCredit).toBe(false);
    expect(result).toMatchObject({
      approvalId: A_ID,
      approvalDigest: triplet.approval,
      proposalId: P_ID,
      proposalDigest: triplet.proposal,
      reviewId: R_ID,
      reviewDigest: triplet.review,
      measurementSetId: saved.value.measurementSetId,
      measurementSetContentDigest: saved.value.contentDigest,
    });
  });

  it.each([
    ['approval', 'APPROVAL_INVALID'],
    ['review', 'REVIEW_INVALID'],
    ['proposal', 'PROPOSAL_INVALID'],
  ] as const)('refuses a missing %s artifact with a sanitized code and no writes', async (kind, code) => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const triplet = writeTriplet(
      f.skillRoot,
      saved.value.content,
      retention.value.snapshot.totalByteCount,
    );
    const id = kind === 'approval' ? A_ID : kind === 'review' ? R_ID : P_ID;
    rmSync(artifactPath(f.skillRoot, `${kind}s` as 'approvals' | 'proposals' | 'reviews', id));
    const before = listTree(f.skillRoot);
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      }),
    ).toEqual({ ok: false, code });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it.each([
    ['approval', 'APPROVAL_INVALID'],
    ['review', 'REVIEW_INVALID'],
    ['proposal', 'PROPOSAL_INVALID'],
  ] as const)('refuses a tampered %s artifact and no writes', async (kind, code) => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const triplet = writeTriplet(
      f.skillRoot,
      saved.value.content,
      retention.value.snapshot.totalByteCount,
    );
    const id = kind === 'approval' ? A_ID : kind === 'review' ? R_ID : P_ID;
    const file = artifactPath(f.skillRoot, `${kind}s` as 'approvals' | 'proposals' | 'reviews', id);
    writeFileSync(file, `${readFileSync(file, 'utf8')} `);
    const before = listTree(f.skillRoot);
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      }),
    ).toEqual({ ok: false, code });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses a forged decision-maker, a reviewer equal to it, wrong mandate and wrong scope', async () => {
    const forgedActor = await (async () => {
      const f = fixture();
      const { retention, saved } = await savedRealSet(f);
      const triplet = writeTriplet(
        f.skillRoot,
        saved.value.content,
        retention.value.snapshot.totalByteCount,
        { approval: { decisionMaker: 'same-user-attacker' } },
      );
      return verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      });
    })();
    expect(forgedActor).toEqual({ ok: false, code: 'ACTOR_INVALID' });

    const reviewerIsActor = await (async () => {
      const f = fixture();
      const { retention, saved } = await savedRealSet(f);
      const triplet = writeTriplet(
        f.skillRoot,
        saved.value.content,
        retention.value.snapshot.totalByteCount,
        { review: { reviewer: BUDGET_POLICY_DECISION_MAKER } },
      );
      return verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      });
    })();
    expect(reviewerIsActor).toEqual({ ok: false, code: 'ACTOR_INVALID' });

    const wrongMandate = await (async () => {
      const f = fixture();
      const { retention, saved } = await savedRealSet(f);
      const triplet = writeTriplet(
        f.skillRoot,
        saved.value.content,
        retention.value.snapshot.totalByteCount,
        { approval: { mandate: 'ADR-0000' } },
      );
      return verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      });
    })();
    expect(wrongMandate).toEqual({ ok: false, code: 'MANDATE_INVALID' });

    const wrongScope = await (async () => {
      const f = fixture();
      const { retention, saved } = await savedRealSet(f);
      const triplet = writeTriplet(
        f.skillRoot,
        saved.value.content,
        retention.value.snapshot.totalByteCount,
        { approval: { decisionScope: 'activate-exact-release-candidate' } },
      );
      return verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      });
    })();
    expect(wrongScope).toEqual({ ok: false, code: 'SCOPE_INVALID' });
  });

  it('refuses an independent pin that does not match the artifact triplet', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const triplet = writeTriplet(
      f.skillRoot,
      saved.value.content,
      retention.value.snapshot.totalByteCount,
    );
    const before = listTree(f.skillRoot);
    for (const overrides of [
      { approvalDigest: '0'.repeat(64) },
      { reviewDigest: '0'.repeat(64) },
      { proposalDigest: '0'.repeat(64) },
      { decisionScope: 'activate-exact-release-candidate' },
    ]) {
      expect(
        verifyApprovedBudgetPolicy(A_ID, {
          dependencies: f.dependencies,
          authority: pinningProvider(triplet, overrides),
        }),
      ).toEqual({ ok: false, code: 'AUTHORITY_MISMATCH' });
    }
    // A provider that resolves a different approval id cannot attest this one.
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet, { approvalId: R_ID }),
      }),
    ).toEqual({ ok: false, code: 'AUTHORITY_UNATTESTED' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses a mismatched source binding, a missing bound set, a non-PASS review and an open proposal', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;

    const mismatchedSource = writeTriplet(f.skillRoot, saved.value.content, retained, {
      policy: { sourceProvenanceDigest: 'f'.repeat(64) },
    });
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(mismatchedSource),
      }),
    ).toEqual({ ok: false, code: 'BINDING_MISMATCH' });

    const missingSet = writeTriplet(f.skillRoot, saved.value.content, retained, {
      policy: { measurementSetId: `bset-${'0'.repeat(64)}` },
    });
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(missingSet),
      }),
    ).toEqual({ ok: false, code: 'MEASUREMENT_NOT_FOUND' });

    const failedReview = writeTriplet(f.skillRoot, saved.value.content, retained, {
      review: { result: 'FAIL' },
    });
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(failedReview),
      }),
    ).toEqual({ ok: false, code: 'REVIEW_INVALID' });

    const openProposal = writeTriplet(f.skillRoot, saved.value.content, retained, {
      proposal: { extra: true },
    });
    expect(
      verifyApprovedBudgetPolicy(A_ID, {
        dependencies: f.dependencies,
        authority: pinningProvider(openProposal),
      }),
    ).toEqual({ ok: false, code: 'PROPOSAL_INVALID' });
  });
});

describe('Release budget preflight adapter (WP5-A, ADR 0111/0112)', () => {
  const P_ID = `budget-policy-${'4'.repeat(64)}`;
  const R_ID = `budget-policy-${'5'.repeat(64)}`;
  const A_ID = `budget-policy-${'6'.repeat(64)}`;

  function writeArtifact(
    skillRoot: string,
    kind: 'approvals' | 'proposals' | 'reviews',
    id: string,
    value: unknown,
  ): string {
    const directory = path.join(skillRoot, 'evidence/governance/budget/policies', kind);
    mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from(`${canonicalize(value)}\n`);
    writeFileSync(path.join(directory, `${id}.json`), bytes);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function savedRealSet(f: ReturnType<typeof fixture>) {
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const saved = createFreshMeasurementSet(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    if (!saved.ok) throw new Error(`createFreshMeasurementSet: ${saved.code}`);
    return { retention, saved };
  }

  interface TripletOverrides {
    readonly proposal?: Record<string, unknown>;
    readonly review?: Record<string, unknown>;
    readonly approval?: Record<string, unknown>;
    readonly policy?: Record<string, unknown>;
  }

  function writeTriplet(
    skillRoot: string,
    content: BudgetMeasurementSetContentV1,
    retainedBytes: number,
    overrides: TripletOverrides = {},
  ): { readonly proposal: string; readonly review: string; readonly approval: string } {
    const policy = {
      ...policyFixture(content, retainedBytes),
      ...(overrides.policy ?? {}),
    } as BudgetPolicyProposalV1;
    const proposalValue = {
      schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
      proposalId: P_ID,
      state: 'PROPOSED_NOT_APPROVED',
      releaseCredit: false,
      proposal: policy,
      rationale: 'Independent proposal rationale.',
      ...(overrides.proposal ?? {}),
    } as unknown as BudgetPolicyProposalArtifactV1;
    const proposalDigest = writeArtifact(skillRoot, 'proposals', P_ID, proposalValue);

    const reviewValue = {
      schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
      reviewId: R_ID,
      reviewer: 'independent-reviewer',
      result: 'PASS',
      proposalId: P_ID,
      proposalDigest,
      rationale: 'Independent review rationale.',
      ...(overrides.review ?? {}),
    } as unknown as BudgetPolicyReviewArtifactV1;
    const reviewDigest = writeArtifact(skillRoot, 'reviews', R_ID, reviewValue);

    const approvalValue = {
      schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
      approvalId: A_ID,
      decisionMaker: BUDGET_POLICY_DECISION_MAKER,
      mandate: BUDGET_POLICY_MANDATE,
      decisionScope: BUDGET_POLICY_DECISION_SCOPE,
      proposalId: P_ID,
      proposalDigest,
      reviewId: R_ID,
      reviewDigest,
      rationale: 'Delegated-owner approval rationale.',
      timestamp: '2026-09-27T00:00:00.000Z',
      ...(overrides.approval ?? {}),
    } as unknown as BudgetPolicyApprovalArtifactV1;
    const approvalDigest = writeArtifact(skillRoot, 'approvals', A_ID, approvalValue);

    return { proposal: proposalDigest, review: reviewDigest, approval: approvalDigest };
  }

  function pinningProvider(
    digests: { readonly proposal: string; readonly review: string; readonly approval: string },
    overrides: Record<string, unknown> = {},
  ): BudgetPolicyAuthorityProvider {
    return {
      resolve: (id) =>
        id === A_ID
          ? ({
              decisionScope: BUDGET_POLICY_DECISION_SCOPE,
              proposalId: P_ID,
              proposalDigest: digests.proposal,
              reviewId: R_ID,
              reviewDigest: digests.review,
              approvalId: A_ID,
              approvalDigest: digests.approval,
              ...overrides,
            } as BudgetPolicyAuthorityAttestationV1)
          : null,
    };
  }

  function releaseInput(content: BudgetMeasurementSetContentV1, policyApprovalId: string | null) {
    return {
      manifestId: content.manifestId,
      manifestFingerprint: content.manifestFingerprint,
      requiredCellId: content.requiredCellId,
      sourceProvenanceDigest: content.sourceProvenanceDigest,
      policyApprovalId,
    };
  }

  it('refuses without an independent root, and a proposal-only artifact set never passes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const triplet = writeTriplet(
      f.skillRoot,
      saved.value.content,
      retention.value.snapshot.totalByteCount,
    );
    const input = releaseInput(saved.value.content, A_ID);
    const before = listTree(f.skillRoot);
    expect(resolveReleaseBudgetPreflight(input, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'BUDGET_AUTHORITY_UNATTESTED',
    });
    expect(
      resolveReleaseBudgetPreflight(input, {
        dependencies: f.dependencies,
        authority: REFUSING_BUDGET_POLICY_AUTHORITY_PROVIDER,
      }),
    ).toEqual({ ok: false, code: 'BUDGET_AUTHORITY_UNATTESTED' });
    expect(
      resolveReleaseBudgetPreflight(input, {
        dependencies: f.dependencies,
        authority: { resolve: () => null },
      }),
    ).toEqual({ ok: false, code: 'BUDGET_AUTHORITY_UNATTESTED' });
    // A bare locator reference (or none) is never authority.
    expect(
      resolveReleaseBudgetPreflight(releaseInput(saved.value.content, null), {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      }),
    ).toEqual({ ok: false, code: 'BUDGET_AUTHORITY_UNATTESTED' });
    expect(
      resolveReleaseBudgetPreflight(releaseInput(saved.value.content, 'not-a-policy-id'), {
        dependencies: f.dependencies,
        authority: pinningProvider(triplet),
      }),
    ).toEqual({ ok: false, code: 'BUDGET_AUTHORITY_UNATTESTED' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('maps an independently pinned policy onto exact policy/set/method basis with no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const triplet = writeTriplet(f.skillRoot, saved.value.content, retained);
    const before = listTree(f.skillRoot);
    const result = resolveReleaseBudgetPreflight(releaseInput(saved.value.content, A_ID), {
      dependencies: f.dependencies,
      authority: pinningProvider(triplet),
    });
    expect(listTree(f.skillRoot)).toEqual(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.releaseCredit).toBe(false);
    expect(result.value).toMatchObject({
      policyApprovalId: A_ID,
      policyDigest: triplet.proposal,
      approvalDigest: triplet.approval,
      reviewDigest: triplet.review,
      measurementSetId: saved.value.measurementSetId,
      measurementSetContentDigest: saved.value.contentDigest,
      method: 'full-scope-envelope-v1',
      methodVersion: 1,
      manifestId: saved.value.content.manifestId,
      manifestFingerprint: saved.value.content.manifestFingerprint,
      requiredCellId: saved.value.content.requiredCellId,
      sourceProvenanceDigest: saved.value.content.sourceProvenanceDigest,
      basis: {
        measurementSetContentDigest: saved.value.contentDigest,
        retentionAuditId: retention.value.auditId,
        retentionAuditDigest: retention.value.digest,
      },
    });
    expect(result.value.ceilings).toEqual(policyFixture(saved.value.content, retained).ceilings);
    expect(result.value.limitations).toContain('family:text:UNAVAILABLE');
    expect(result.value.limitations).toContain('torn-counter:image:REQUIRED');
  });

  it('refuses a manifest/cell/source binding mismatch with a sanitized code and no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const triplet = writeTriplet(
      f.skillRoot,
      saved.value.content,
      retention.value.snapshot.totalByteCount,
    );
    const before = listTree(f.skillRoot);
    for (const patch of [
      { manifestId: 'other-manifest' },
      { manifestFingerprint: '0'.repeat(64) },
      { requiredCellId: 'other-cell' },
      { sourceProvenanceDigest: '1'.repeat(64) },
    ]) {
      expect(
        resolveReleaseBudgetPreflight(
          { ...releaseInput(saved.value.content, A_ID), ...patch },
          { dependencies: f.dependencies, authority: pinningProvider(triplet) },
        ),
      ).toEqual({ ok: false, code: 'BUDGET_BINDING_MISMATCH' });
    }
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses an unsupported method and a missing current measurement set with sanitized codes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const unsupported = writeTriplet(f.skillRoot, saved.value.content, retained, {
      policy: { method: 'unknown-method-v9' },
    });
    const before = listTree(f.skillRoot);
    expect(
      resolveReleaseBudgetPreflight(releaseInput(saved.value.content, A_ID), {
        dependencies: f.dependencies,
        authority: pinningProvider(unsupported),
      }),
    ).toEqual({ ok: false, code: 'BUDGET_POLICY_INVALID' });
    const missingSet = writeTriplet(f.skillRoot, saved.value.content, retained, {
      policy: { measurementSetId: `bset-${'0'.repeat(64)}` },
    });
    expect(
      resolveReleaseBudgetPreflight(releaseInput(saved.value.content, A_ID), {
        dependencies: f.dependencies,
        authority: pinningProvider(missingSet),
      }),
    ).toEqual({ ok: false, code: 'BUDGET_MEASUREMENT_INVALID' });
    expect(listTree(f.skillRoot)).toEqual(before);
  });
});

describe('read-only proposal-by-ID inspection accessor (WP6, ADR 0115)', () => {
  const P_ID = `budget-policy-${'7'.repeat(64)}`;

  const proposalDirectory = (skillRoot: string): string =>
    path.join(skillRoot, 'evidence/governance/budget/policies/proposals');
  const proposalPath = (skillRoot: string, id: string): string =>
    path.join(proposalDirectory(skillRoot), `${id}.json`);

  /** Write one canonical proposal artifact; return its exact raw-byte digest. */
  function writeProposal(skillRoot: string, value: unknown): string {
    mkdirSync(proposalDirectory(skillRoot), { recursive: true });
    const bytes = Buffer.from(`${canonicalize(value)}\n`);
    writeFileSync(proposalPath(skillRoot, P_ID), bytes);
    return createHash('sha256').update(bytes).digest('hex');
  }

  /** Real calibration + Qualification + retention, then the persisted immutable set. */
  async function savedRealSet(f: ReturnType<typeof fixture>) {
    const calibrationId = await calibratedId(f, f.dependencies);
    const qualificationBatchId = await qualificationId(f, f.dependencies);
    const retention = appendRetentionAudit(f.skillRoot);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const saved = createFreshMeasurementSet(
      { calibrationId, qualificationBatchId, retentionAuditId: retention.value.auditId },
      { dependencies: f.dependencies },
    );
    if (!saved.ok) throw new Error(`createFreshMeasurementSet: ${saved.code}`);
    return { retention, saved };
  }

  function proposalArtifact(
    content: BudgetMeasurementSetContentV1,
    retainedBytes = 500,
    overrides: {
      readonly artifact?: Record<string, unknown>;
      readonly policy?: Record<string, unknown>;
    } = {},
  ): Record<string, unknown> {
    const policy = {
      ...policyFixture(content, retainedBytes),
      ...(overrides.policy ?? {}),
    } as BudgetPolicyProposalV1;
    return {
      schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
      proposalId: P_ID,
      state: 'PROPOSED_NOT_APPROVED',
      releaseCredit: false,
      proposal: policy,
      rationale: 'Independent proposal rationale.',
      ...(overrides.artifact ?? {}),
    };
  }

  it('reports exact proposal identity and rederived feasibility with no writes and no approval', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const content = saved.value.content;
    const retained = retention.value.snapshot.totalByteCount;
    const policy = policyFixture(content, retained);
    const digest = writeProposal(f.skillRoot, proposalArtifact(content, retained));
    const before = listTree(f.skillRoot);
    const result = inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies });
    expect(listTree(f.skillRoot)).toEqual(before);
    expect(result).toEqual({
      ok: true,
      state: 'PROPOSED_NOT_APPROVED',
      releaseCredit: false,
      decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED',
      proposalId: P_ID,
      proposalDigest: digest,
      measurementSetId: saved.value.measurementSetId,
      measurementSetContentDigest: saved.value.contentDigest,
      retentionAuditId: retention.value.auditId,
      retentionAuditDigest: retention.value.digest,
      manifestId: content.manifestId,
      manifestFingerprint: content.manifestFingerprint,
      requiredCellId: content.requiredCellId,
      sourceProvenanceDigest: content.sourceProvenanceDigest,
      ceilings: policy.ceilings,
      familyStates: policy.familyStates,
      tornCounterDependencies: policy.tornCounterDependencies,
      observed: {
        releaseDurationMs: content.calibrationElapsedMs,
        releaseEvidenceBytes: content.calibrationRuns.reduce(
          (total, run) => total + run.evidenceByteCount,
          0,
        ),
        qualificationDurationMs: content.qualificationElapsedMs,
        qualificationEvidenceBytes: content.qualificationRuns.reduce(
          (total, run) => total + run.evidenceByteCount,
          0,
        ),
        retainedInventoryBytes: retained,
        imageTornRecaptures: 4,
      },
    });
    if (!result.ok) return;
    // A feasible, well-formed proposal is explicitly not approval or credit, and
    // no review/approval artifact is required or consulted.
    expect(result.state).toBe('PROPOSED_NOT_APPROVED');
    expect(result.releaseCredit).toBe(false);
    expect(result.decision).not.toBe('FEASIBLE');
    const tree = listTree(f.skillRoot);
    expect(tree.some((file) => file.includes('/reviews/'))).toBe(false);
    expect(tree.some((file) => file.includes('/approvals/'))).toBe(false);
  });

  it('exposes no generic artifact reader or raw-file/path capability', () => {
    expect(typeof budgetGovernance.inspectBudgetPolicyProposal).toBe('function');
    for (const name of [
      'readPolicyArtifact',
      'validateProposalArtifact',
      'validateReviewArtifact',
      'validateApprovalArtifact',
      'validAttestationShape',
    ])
      expect(name in budgetGovernance).toBe(false);
  });

  it('refuses a missing proposal with a sanitized code and no writes', () => {
    const f = fixture();
    const before = listTree(f.skillRoot);
    const result = inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies });
    expect(result).toEqual({ ok: false, code: 'PROPOSAL_INVALID' });
    expect(Object.keys(result)).toEqual(['ok', 'code']);
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses malformed and traversal-shaped ids before any file access with no writes', () => {
    const f = fixture();
    writeProposal(f.skillRoot, proposalArtifact(contentFixture()));
    const before = listTree(f.skillRoot);
    const rejected = [
      '',
      '   ',
      'not-a-policy-id',
      '..',
      '../proposals',
      `../proposals/${P_ID}`,
      `${P_ID}/../${P_ID}`,
      `${P_ID}/`,
      '/etc/passwd',
      `budget-policy-${'g'.repeat(64)}`,
      `budget-policy-${'7'.repeat(63)}`,
      `budget-policy-${'7'.repeat(65)}`,
      ` budget-policy-${'7'.repeat(64)}`,
    ];
    for (const id of rejected) {
      const result = inspectBudgetPolicyProposal(id, { dependencies: f.dependencies });
      expect(result, id).toEqual({ ok: false, code: 'PROPOSAL_INVALID' });
      expect(Object.keys(result), id).toEqual(['ok', 'code']);
    }
    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses noncanonical, oversized, unknown-key and wrong-shape proposals with one sanitized code', () => {
    const f = fixture();
    const content = contentFixture();
    const base = proposalArtifact(content);
    const refuse = () => inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies });
    const bad = { ok: false, code: 'PROPOSAL_INVALID' };

    // Valid baseline is accepted (so each later refusal is the variant's cause).
    writeProposal(f.skillRoot, base);
    const before = listTree(f.skillRoot);

    // Noncanonical canonical-form bytes: valid JSON plus a trailing space.
    writeFileSync(proposalPath(f.skillRoot, P_ID), Buffer.from(`${canonicalize(base)}\n `));
    expect(refuse()).toEqual(bad);

    // Oversized: one byte past the bounded 4 MiB artifact ceiling.
    writeFileSync(proposalPath(f.skillRoot, P_ID), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    expect(refuse()).toEqual(bad);

    // Unknown artifact key.
    writeProposal(f.skillRoot, { ...base, extra: true });
    expect(refuse()).toEqual(bad);

    // Unknown nested policy key.
    writeProposal(f.skillRoot, proposalArtifact(content, 500, { policy: { extra: true } }));
    expect(refuse()).toEqual(bad);

    // Wrong embedded proposal id.
    writeProposal(f.skillRoot, { ...base, proposalId: `budget-policy-${'8'.repeat(64)}` });
    expect(refuse()).toEqual(bad);

    // Wrong state and a claim of credit are never accepted.
    writeProposal(f.skillRoot, { ...base, state: 'APPROVED' });
    expect(refuse()).toEqual(bad);
    writeProposal(f.skillRoot, { ...base, releaseCredit: true });
    expect(refuse()).toEqual(bad);

    expect(listTree(f.skillRoot)).toEqual(before);
  });

  it('refuses a symlinked proposal file and unsafe symlinked ancestry with no writes', () => {
    const bytes = Buffer.from(`${canonicalize(proposalArtifact(contentFixture()))}\n`);
    const bad = { ok: false, code: 'PROPOSAL_INVALID' };

    // (1) The proposal file itself is a symlink to valid canonical bytes.
    {
      const f = fixture();
      mkdirSync(proposalDirectory(f.skillRoot), { recursive: true });
      const realFile = path.join(f.skillRoot, 'real-proposal-bytes.json');
      writeFileSync(realFile, bytes);
      symlinkSync(realFile, proposalPath(f.skillRoot, P_ID));
      const before = listTree(f.skillRoot);
      expect(inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies })).toEqual(bad);
      expect(listTree(f.skillRoot)).toEqual(before);
    }

    // (2) The proposals directory itself is a symlink.
    {
      const f = fixture();
      mkdirSync(path.join(f.skillRoot, 'evidence/governance/budget/policies'), {
        recursive: true,
      });
      const realDirectory = path.join(f.skillRoot, 'real-proposals');
      mkdirSync(realDirectory, { recursive: true });
      writeFileSync(path.join(realDirectory, `${P_ID}.json`), bytes);
      symlinkSync(realDirectory, proposalDirectory(f.skillRoot));
      const before = listTree(f.skillRoot);
      expect(inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies })).toEqual(bad);
      expect(listTree(f.skillRoot)).toEqual(before);
    }

    // (3) An ancestor directory is a symlink resolving outside the governed path.
    {
      const f = fixture();
      mkdirSync(path.join(f.skillRoot, 'evidence/governance/budget'), { recursive: true });
      const realPolicies = path.join(f.skillRoot, 'real-policies');
      mkdirSync(path.join(realPolicies, 'proposals'), { recursive: true });
      writeFileSync(path.join(realPolicies, 'proposals', `${P_ID}.json`), bytes);
      symlinkSync(realPolicies, path.join(f.skillRoot, 'evidence/governance/budget/policies'));
      const before = listTree(f.skillRoot);
      expect(inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies })).toEqual(bad);
      expect(listTree(f.skillRoot)).toEqual(before);
    }
  });

  it('refuses a stale/changed measurement set and a missing bound set with no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    writeProposal(f.skillRoot, proposalArtifact(saved.value.content, retained));
    const setRecord = path.join(
      f.skillRoot,
      'evidence/governance/budget/measurements/sets',
      `${saved.value.measurementSetId}.json`,
    );
    const before = listTree(f.skillRoot);
    writeFileSync(setRecord, `${readFileSync(setRecord, 'utf8')} `);
    expect(inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'MEASUREMENT_INVALID',
    });
    expect(listTree(f.skillRoot)).toEqual(before);

    const g = fixture();
    const other = await savedRealSet(g);
    writeProposal(
      g.skillRoot,
      proposalArtifact(other.saved.value.content, other.retention.value.snapshot.totalByteCount, {
        policy: { measurementSetId: `bset-${'0'.repeat(64)}` },
      }),
    );
    const otherBefore = listTree(g.skillRoot);
    expect(inspectBudgetPolicyProposal(P_ID, { dependencies: g.dependencies })).toEqual({
      ok: false,
      code: 'MEASUREMENT_NOT_FOUND',
    });
    expect(listTree(g.skillRoot)).toEqual(otherBefore);
  });

  it('refuses an absent or tampered retention audit and a mismatched binding with no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const retained = retention.value.snapshot.totalByteCount;
    const auditRecord = path.join(
      f.skillRoot,
      'evidence/governance/retention-audit',
      `${retention.value.auditId}.json`,
    );
    writeProposal(f.skillRoot, proposalArtifact(saved.value.content, retained));
    const before = listTree(f.skillRoot);
    writeFileSync(auditRecord, `${readFileSync(auditRecord, 'utf8')} `);
    expect(inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'RETENTION_INVALID',
    });
    expect(listTree(f.skillRoot)).toEqual(before);

    const g = fixture();
    const other = await savedRealSet(g);
    rmSync(
      path.join(
        g.skillRoot,
        'evidence/governance/retention-audit',
        `${other.retention.value.auditId}.json`,
      ),
    );
    writeProposal(g.skillRoot, proposalArtifact(other.saved.value.content, retained));
    const missingBefore = listTree(g.skillRoot);
    expect(inspectBudgetPolicyProposal(P_ID, { dependencies: g.dependencies })).toEqual({
      ok: false,
      code: 'RETENTION_INVALID',
    });
    expect(listTree(g.skillRoot)).toEqual(missingBefore);

    const h = fixture();
    const third = await savedRealSet(h);
    writeProposal(
      h.skillRoot,
      proposalArtifact(third.saved.value.content, third.retention.value.snapshot.totalByteCount, {
        policy: { retentionAuditId: 'retention-ffffffff-ffff-ffff-ffff-ffffffffffff' },
      }),
    );
    const bindingBefore = listTree(h.skillRoot);
    expect(inspectBudgetPolicyProposal(P_ID, { dependencies: h.dependencies })).toEqual({
      ok: false,
      code: 'BINDING_MISMATCH',
    });
    expect(listTree(h.skillRoot)).toEqual(bindingBefore);
  });

  it('refuses an infeasible proposal with a sanitized policy code and no writes', async () => {
    const f = fixture();
    const { retention, saved } = await savedRealSet(f);
    const content = saved.value.content;
    const retained = retention.value.snapshot.totalByteCount;
    writeProposal(
      f.skillRoot,
      proposalArtifact(content, retained, {
        policy: {
          ceilings: {
            ...policyFixture(content, retained).ceilings,
            releaseDurationMs: content.calibrationElapsedMs - 1,
          },
        },
      }),
    );
    const before = listTree(f.skillRoot);
    expect(inspectBudgetPolicyProposal(P_ID, { dependencies: f.dependencies })).toEqual({
      ok: false,
      code: 'LIMIT_EXCEEDED',
    });
    expect(listTree(f.skillRoot)).toEqual(before);
  });
});
