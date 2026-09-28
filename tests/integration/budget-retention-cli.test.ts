import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The separately tested evidence transaction verifier is isolated exactly as in
// the foundation budget suite: every other reader (strict public-v4 parser,
// ledger, cleanup/current-tree, nested byte reader, retention inventory) runs on
// real temp files. The synthetic child therefore never launches a browser.
vi.mock('../../src/evidence/integrity', () => ({
  verifyEvidenceRoot: () => ({
    transaction: { creditEligible: true, strictRecordPresent: true },
    provenance: { currentTreeCheck: 'PASS', currentTreeCreditEligible: true },
    checks: [{ result: 'PASS' }],
  }),
  createCurrentTreeProvenanceProvider: () => () => ({ currentTreeCheck: 'PASS' }),
  createNodeEvidenceVerifyFsAdapter: () => ({}),
}));

import { canonicalize } from '../../src/canonical/canonicalize';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import { compilePreparedExecutionCandidate } from '../../src/cli/diagnostic';
import { runBudgetCalibrationCommand } from '../../src/cli/budget';
import { runCli } from '../../src/cli/main';
import { parseCliResultEnvelope } from '../../src/cli/output';
import {
  BUDGET_MEASUREMENT_JOIN_METHOD,
  BUDGET_MEASUREMENT_VERIFIER_METHOD,
  BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
  BUDGET_POLICY_METHOD,
  BUDGET_POLICY_SCHEMA_VERSION,
} from '../../src/contracts/budget-retention';
import type {
  BudgetMeasurementSetContentV1,
  BudgetPolicyProposalArtifactV1,
  BudgetPolicyProposalV1,
} from '../../src/contracts/budget-retention';
import type { ExecutableManifestValidationContext } from '../../src/contracts/executable-selection-manifest';
import type { ExecutableSelectionManifestDraftV1 } from '../../src/contracts/executable-selection-manifest';
import {
  createFreshMeasurementSet,
  prepareDiagnosticCalibration,
  runDiagnosticCalibration,
  verifyBudgetMeasurementSet,
  verifyDiagnosticCalibration,
  type BudgetRuntimeDependencies,
} from '../../src/governance/budget';
import {
  prepareQualificationBatch,
  readAndVerifyDiagnosticChild,
  runQualificationBatch,
} from '../../src/governance/qualification-runtime';
import { readFinalPublicRecord } from '../../src/contracts/final-public-record';
import { appendRetentionAudit } from '../../src/governance/retention';
import { normalizeCaseRequest } from '../../src/planner/normalize-intent';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { resolveToolkitRoot } from '../../src/runtime/paths';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const actualSkill = resolveToolkitRoot();
const draftName = 'draft-4fb06edd4de0cd64e0c56f926342599b0d1c323811c06e3fcc0a89649b1cb173.json';
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/p8b/committed-run/run-record.json',
);
const PROPOSAL_ID = `budget-policy-${'1'.repeat(64)}`;
const REVIEW_ID = `budget-policy-${'2'.repeat(64)}`;
const APPROVAL_ID = `budget-policy-${'3'.repeat(64)}`;

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

/** One owned temp skill root with the shared harness-owned runtime dependencies. */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'budget-cli-')));
  roots.push(root);
  const drafts = path.join(root, 'cases/selection-manifests/drafts');
  mkdirSync(drafts, { recursive: true });
  const draftFile = path.join(drafts, draftName);
  writeFileSync(
    draftFile,
    readFileSync(path.join(actualSkill, 'cases/selection-manifests/drafts', draftName)),
  );
  const authorityDirectory = path.join(root, 'governance/authorities/0102');
  mkdirSync(authorityDirectory, { recursive: true });
  for (const name of ['decision.md', 'proposed-scope.json', 'review.md']) {
    writeFileSync(
      path.join(authorityDirectory, name),
      readFileSync(path.join(actualSkill, 'governance/authorities/0102', name)),
    );
  }
  let clock = 0;
  let started = 0;
  let interrupt = false;
  const outcome: 'PASS' | 'BUG' = 'PASS';
  const dependencies: BudgetRuntimeDependencies = {
    skillRoot: root,
    repoRoot: root,
    loadContext: context,
    compileCandidate: compilePreparedExecutionCandidate,
    collectSourceDigest: () => 'a'.repeat(64),
    makeId: randomUUID,
    monotonicNow: () => (clock += 5),
    wallNow: () => '2026-09-26T12:00:00.000Z',
    runCandidate: async ({ preparedCandidate, runId }) => {
      started++;
      if (interrupt) throw new Error('owned runner interruption');
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
      const runRoot = path.join(root, 'evidence/runs', runId);
      mkdirSync(path.join(runRoot, 'nested'), { recursive: true });
      writeFileSync(path.join(runRoot, 'run-record.json'), `${JSON.stringify(record)}\n`);
      writeFileSync(path.join(runRoot, 'nested', 'manifest.json'), '{"child":true}\n');
      return {
        schemaVersion: 2,
        command: 'diagnostic',
        subcommand: null,
        status: outcome,
        exitCode: outcome === 'PASS' ? 0 : 1,
        launchAttempted: true,
        outcome,
        detail: 'synthetic child',
        details: null,
        diagnostics: [],
      };
    },
    readAndVerifyChild: (runId) => readAndVerifyDiagnosticChild(root, runId, root),
  };
  return {
    root,
    draftFile,
    dependencies,
    get started() {
      return started;
    },
    setInterrupt() {
      interrupt = true;
    },
  };
}

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

async function calibratedId(f: ReturnType<typeof fixture>): Promise<string> {
  const prepared = prepareDiagnosticCalibration(
    { draftFile: f.draftFile },
    { dependencies: f.dependencies },
  );
  if (!prepared.ok) throw new Error(`prepareDiagnosticCalibration: ${prepared.code}`);
  const run = await runDiagnosticCalibration(prepared.value, { dependencies: f.dependencies });
  if (!run.ok) throw new Error(`runDiagnosticCalibration: ${run.code}`);
  return run.value.calibrationId;
}

async function qualificationBatchId(f: ReturnType<typeof fixture>): Promise<string> {
  const draft = JSON.parse(readFileSync(f.draftFile, 'utf8')) as ExecutableSelectionManifestDraftV1;
  const scenarios = ['drag-warped-nested', 'replace-image', 'serialize-raw-semantic'];
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
    { dependencies: f.dependencies },
  );
  if (!prepared.ok) throw new Error(`prepareQualificationBatch: ${prepared.code}`);
  const result = await runQualificationBatch(prepared.batch.batchId, {
    dependencies: f.dependencies,
  });
  if (result?.state !== 'REVIEW_READY') throw new Error('runQualificationBatch did not pass');
  return prepared.batch.batchId;
}

/** Build a feasible `full-scope-envelope-v1` proposal bound to real current content. */
function proposalFor(
  content: BudgetMeasurementSetContentV1,
  retainedBytes: number,
): BudgetPolicyProposalV1 {
  const digest = createHash('sha256').update(canonicalize(content)).digest('hex');
  const sum = (runs: readonly { evidenceByteCount: number }[]): number =>
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
      retainedEvidenceBytes: retainedBytes,
      imageTornRecaptures: imageTotal,
    },
  };
}

function writePolicyArtifact(
  root: string,
  kind: 'approvals' | 'proposals' | 'reviews',
  id: string,
  value: unknown,
): string {
  const directory = path.join(root, 'evidence/governance/budget/policies', kind);
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(`${canonicalize(value)}\n`);
  writeFileSync(path.join(directory, `${id}.json`), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Write the full proposal/review/approval triplet and return raw digests. */
function writeTriplet(root: string, content: BudgetMeasurementSetContentV1, retainedBytes: number) {
  const proposalValue = {
    schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
    proposalId: PROPOSAL_ID,
    state: 'PROPOSED_NOT_APPROVED',
    releaseCredit: false,
    proposal: proposalFor(content, retainedBytes),
    rationale: 'Independent proposal rationale.',
  } as unknown as BudgetPolicyProposalArtifactV1;
  const proposalDigest = writePolicyArtifact(root, 'proposals', PROPOSAL_ID, proposalValue);
  const reviewDigest = writePolicyArtifact(root, 'reviews', REVIEW_ID, {
    schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
    reviewId: REVIEW_ID,
    reviewer: 'independent-reviewer',
    result: 'PASS',
    proposalId: PROPOSAL_ID,
    proposalDigest,
    rationale: 'Independent review rationale.',
  });
  const approvalDigest = writePolicyArtifact(root, 'approvals', APPROVAL_ID, {
    schemaVersion: BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
    approvalId: APPROVAL_ID,
    decisionMaker: 'delegated-owner / Codex orchestrator',
    mandate: 'ADR-0099',
    decisionScope: 'budget-policy',
    proposalId: PROPOSAL_ID,
    proposalDigest,
    reviewId: REVIEW_ID,
    reviewDigest,
    rationale: 'Delegated-owner approval rationale.',
    timestamp: '2026-09-27T00:00:00.000Z',
  });
  return { proposalDigest, reviewDigest, approvalDigest };
}

interface Envelope {
  status: string;
  exitCode: number;
  command: string;
  subcommand: string | null;
  launchAttempted: boolean;
  outcome: unknown;
  detail: string;
  details: Record<string, unknown> | null;
}

/** Invoke the top-level CLI route, capturing the envelope and proving no leak. */
async function invoke(
  argv: readonly string[],
  f: ReturnType<typeof fixture> | null,
): Promise<{ code: number; envelope: Envelope; raw: string }> {
  const output: string[] = [];
  const code = await runCli(argv, {
    stdout: (chunk) => output.push(chunk),
    ...(f === null ? {} : { budget: { runtime: { dependencies: f.dependencies } } }),
  });
  const raw = output.join('');
  return {
    code,
    envelope: parseCliResultEnvelope<Record<string, unknown>>(JSON.parse(raw)) as Envelope,
    raw,
  };
}

describe('budget CLI route (registered by main.ts in WP6)', () => {
  it.each([
    ['budget'],
    ['budget', 'frobnicate'],
    ['budget', 'measure'],
    ['budget', 'measure', '--qualification', 'x', '--calibration', 'y', '--retention', 'z'],
    ['budget', 'measure', '--calibration', 'y', '--calibration', 'y', '--retention', 'z'],
    ['budget', 'measure', '--calibration', 'y', '--qualification', 'z'],
    [
      'budget',
      'measure',
      '--calibration',
      'y',
      '--qualification',
      'z',
      '--retention',
      'r',
      '--release',
      'q',
    ],
    [
      'budget',
      'measure',
      '--calibration',
      'cal-11111111-1111-1111-1111-111111111111',
      '--qualification',
      'qbatch-22222222-2222-2222-2222-222222222222',
      '--retention',
      '../escape',
    ],
    ['budget', 'inspect'],
    ['budget', 'inspect', '--set'],
    ['budget', 'inspect', '--set', 'bset-00', '--proposal', 'x'],
    ['budget', 'inspect', '--set', `../proposals/bset-${'0'.repeat(64)}`],
    ['budget', 'inspect', '--proposal', 'not-a-policy-id'],
    ['budget', 'inspect', '--approved', `budget-policy-${'g'.repeat(64)}`],
    ['budget', 'inspect', '--root', '/private'],
    ['budget', 'inspect', '--set', `bset-${'0'.repeat(64)}`, '--set', `bset-${'0'.repeat(64)}`],
  ])('refuses invalid grammar as USAGE before any service call: %j', async (...argv) => {
    const f = fixture();
    const before = listTree(f.root);
    const { code, envelope, raw } = await invoke(argv, f);
    expect(code).toBe(64);
    expect(envelope.status).toBe('USAGE');
    expect(envelope.exitCode).toBe(64);
    expect(envelope.details?.failureCode).toBe('ARGUMENTS_INVALID');
    expect(envelope.details?.releaseCredit).toBe(false);
    expect(envelope.launchAttempted).toBe(false);
    expect(envelope.outcome).toBeNull();
    expect(raw).not.toContain(f.root);
    expect(listTree(f.root)).toEqual(before);
    expect(f.started).toBe(0);
  });

  it('lists every budget mode in help without touching a root', async () => {
    const f = fixture();
    const before = listTree(f.root);
    const { code, envelope } = await invoke(['--help'], f);
    expect(code).toBe(64);
    for (const line of [
      'budget calibrate --manifest <draft.json>',
      'budget measure --calibration <id> --qualification <id> --retention <id>',
      'budget inspect --set <measurement-set-id>',
      'budget inspect --proposal <proposal-id>',
      'budget inspect --approved <approval-id>',
    ])
      expect(envelope.detail).toContain(line);
    expect(listTree(f.root)).toEqual(before);
  });

  it('refuses a traversal-shaped calibration manifest without writing or leaking the root', async () => {
    const f = fixture();
    const before = listTree(f.root);
    const { code, envelope, raw } = await invoke(
      ['budget', 'calibrate', '--manifest', path.join(f.root, '../secret.json')],
      f,
    );
    expect(code).toBe(2);
    expect(envelope.status).toBe('HARNESS_BLOCKED');
    expect(envelope.details).toMatchObject({
      failureCode: 'CANDIDATE_INVALID',
      releaseCredit: false,
    });
    expect(raw).not.toContain(f.root);
    expect(listTree(f.root)).toEqual(before);
    expect(f.started).toBe(0);
  });

  it('refuses a valid-shaped approved id with AUTHORITY_UNATTESTED even when canonical files exist', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f);
    const qualificationBatchIdValue = await qualificationBatchId(f);
    const retention = appendRetentionAudit(f.root);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const saved = createFreshMeasurementSet(
      {
        calibrationId,
        qualificationBatchId: qualificationBatchIdValue,
        retentionAuditId: retention.value.auditId,
      },
      { dependencies: f.dependencies },
    );
    if (!saved.ok) throw new Error(`createFreshMeasurementSet: ${saved.code}`);
    writeTriplet(f.root, saved.value.content, retention.value.snapshot.totalByteCount);
    const before = listTree(f.root);
    const { code, envelope, raw } = await invoke(
      ['budget', 'inspect', '--approved', APPROVAL_ID],
      f,
    );
    expect(code).toBe(2);
    expect(envelope.status).toBe('HARNESS_BLOCKED');
    expect(envelope.details?.failureCode).toBe('AUTHORITY_UNATTESTED');
    expect(envelope.details?.releaseCredit).toBe(false);
    expect(envelope.details?.decision).toBeNull();
    expect(listTree(f.root)).toEqual(before);
    expect(raw).not.toContain(f.root);
  });

  it('routes calibrate through the top-level command with an injected executor and no live run', async () => {
    const f = fixture();
    f.setInterrupt();
    const { code, envelope } = await invoke(['budget', 'calibrate', '--manifest', f.draftFile], f);
    expect(code).toBe(2);
    expect(envelope.command).toBe('budget');
    expect(envelope.subcommand).toBe('calibrate');
    expect(envelope.details).toMatchObject({
      state: 'INTERRUPTED',
      completedCount: 1,
      releaseCredit: false,
    });
    expect((envelope.details?.unstartedOrders as number[]).length).toBeGreaterThan(0);
    expect(f.started).toBe(1);
  });
});

describe('budget CLI measure/inspect services (injected dependencies, no live calibration)', () => {
  it('appends one immutable no-credit set and inspects it through the exact route', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f);
    const qualificationBatchIdValue = await qualificationBatchId(f);
    const retention = appendRetentionAudit(f.root);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const startedBefore = f.started;

    const measured = await invoke(
      [
        'budget',
        'measure',
        '--calibration',
        calibrationId,
        '--qualification',
        qualificationBatchIdValue,
        '--retention',
        retention.value.auditId,
      ],
      f,
    );
    expect(measured.code).toBe(0);
    expect(measured.envelope.status).toBe('PASS');
    expect(measured.envelope.details).toMatchObject({
      calibrationId,
      qualificationBatchId: qualificationBatchIdValue,
      retentionAuditId: retention.value.auditId,
      releaseCredit: false,
      failureCode: null,
    });
    const measurementSetId = measured.envelope.details?.measurementSetId as string;
    expect(measurementSetId).toMatch(/^bset-[0-9a-f]{64}$/);
    // The measurement pass re-reads verified lineage and never executes calibration.
    expect(f.started).toBe(startedBefore);
    // No policy/approval authoring accompanies a measurement set.
    expect(listTree(f.root).some((file) => file.includes('budget/policies/'))).toBe(false);

    const inspected = await invoke(['budget', 'inspect', '--set', measurementSetId], f);
    expect(inspected.code).toBe(0);
    expect(inspected.envelope.status).toBe('PASS');
    expect(inspected.envelope.details).toMatchObject({
      measurementSetId,
      calibrationId,
      qualificationBatchId: qualificationBatchIdValue,
      retentionAuditId: retention.value.auditId,
      releaseCredit: false,
      failureCode: null,
    });
    expect(measured.raw).not.toContain(f.root);

    // An unknown but well-formed set id refuses without writing.
    const before = listTree(f.root);
    const missing = await invoke(['budget', 'inspect', '--set', `bset-${'0'.repeat(64)}`], f);
    expect(missing.code).toBe(2);
    expect(missing.envelope.details?.failureCode).toBe('MEASUREMENT_NOT_FOUND');
    expect(listTree(f.root)).toEqual(before);
  });

  it('refuses a well-formed measure whose lineage is absent without writing', async () => {
    const f = fixture();
    const before = listTree(f.root);
    const { code, envelope, raw } = await invoke(
      [
        'budget',
        'measure',
        '--calibration',
        'cal-11111111-1111-1111-1111-111111111111',
        '--qualification',
        'qbatch-22222222-2222-2222-2222-222222222222',
        '--retention',
        `retention-${'0'.repeat(64)}`,
      ],
      f,
    );
    expect(code).toBe(2);
    expect(envelope.status).toBe('HARNESS_BLOCKED');
    expect(envelope.details?.failureCode).toBe('CALIBRATION_INVALID');
    expect(envelope.details?.releaseCredit).toBe(false);
    expect(raw).not.toContain(f.root);
    expect(listTree(f.root)).toEqual(before);
  });

  it('inspects a real proposal as PROPOSED_NOT_APPROVED with no approval or credit', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f);
    const qualificationBatchIdValue = await qualificationBatchId(f);
    const retention = appendRetentionAudit(f.root);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const saved = createFreshMeasurementSet(
      {
        calibrationId,
        qualificationBatchId: qualificationBatchIdValue,
        retentionAuditId: retention.value.auditId,
      },
      { dependencies: f.dependencies },
    );
    if (!saved.ok) throw new Error(`createFreshMeasurementSet: ${saved.code}`);
    const digests = writeTriplet(
      f.root,
      saved.value.content,
      retention.value.snapshot.totalByteCount,
    );
    const before = listTree(f.root);

    const { code, envelope } = await invoke(['budget', 'inspect', '--proposal', PROPOSAL_ID], f);
    expect(code).toBe(0);
    expect(envelope.status).toBe('PASS');
    expect(envelope.details).toMatchObject({
      state: 'PROPOSED_NOT_APPROVED',
      decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED',
      proposalId: PROPOSAL_ID,
      proposalDigest: digests.proposalDigest,
      measurementSetId: saved.value.measurementSetId,
      retentionAuditId: retention.value.auditId,
      releaseCredit: false,
      failureCode: null,
    });
    // Inspection writes nothing and authors no approval artifact.
    expect(listTree(f.root)).toEqual(before);
  });

  it('keeps runBudgetCalibrationCommand directly callable for existing consumers', async () => {
    const f = fixture();
    const result = await runBudgetCalibrationCommand(['inspect'], {
      runtime: { dependencies: f.dependencies },
    });
    expect(result).toMatchObject({
      status: 'USAGE',
      exitCode: 64,
      details: { failureCode: 'ARGUMENTS_INVALID', releaseCredit: false },
    });
    const calibration = await runBudgetCalibrationCommand(
      ['calibrate', '--manifest', f.draftFile],
      {
        runtime: { dependencies: f.dependencies },
      },
    );
    expect(calibration).toMatchObject({
      status: 'PASS',
      exitCode: 0,
      details: { state: 'COMPLETE_ALL_PASS', releaseCredit: false, failureCode: null },
    });
    if (calibration.details?.calibrationId)
      expect(
        verifyDiagnosticCalibration(calibration.details.calibrationId, {
          dependencies: f.dependencies,
        }),
      ).toMatchObject({ ok: true, value: { state: 'COMPLETE_ALL_PASS' } });
  });
});

describe('budget CLI measurement-set verifier join', () => {
  it('exposes a verifiable set for the exact named lineage', async () => {
    const f = fixture();
    const calibrationId = await calibratedId(f);
    const qualificationBatchIdValue = await qualificationBatchId(f);
    const retention = appendRetentionAudit(f.root);
    if (!retention.ok) throw new Error(`appendRetentionAudit: ${retention.code}`);
    const saved = createFreshMeasurementSet(
      {
        calibrationId,
        qualificationBatchId: qualificationBatchIdValue,
        retentionAuditId: retention.value.auditId,
      },
      { dependencies: f.dependencies },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.content.joinMethod).toBe(BUDGET_MEASUREMENT_JOIN_METHOD);
    expect(saved.value.content.verifierMethod).toBe(BUDGET_MEASUREMENT_VERIFIER_METHOD);
    expect(
      verifyBudgetMeasurementSet(saved.value.measurementSetId, { dependencies: f.dependencies }),
    ).toMatchObject({ ok: true, value: { measurementSetId: saved.value.measurementSetId } });
  });
});
