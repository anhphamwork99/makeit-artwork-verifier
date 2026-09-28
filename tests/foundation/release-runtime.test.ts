import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { canonicalize, sha256Hex } from '../../src/canonical/canonicalize';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import { buildCliResult } from '../../src/cli/output';
import { parseCliResultEnvelope } from '../../src/cli/output';
import { runCli } from '../../src/cli/main';
import {
  compilePreparedExecutionCandidate,
  type PreparedExecutionCandidate,
} from '../../src/cli/diagnostic';
import type {
  ExecutableManifestValidationContext,
  ExecutableSelectionManifestDraftV1,
} from '../../src/contracts/executable-selection-manifest';
import type {
  ReleaseApprovalV1,
  ReleaseBudgetPreflightInputV1,
  ReleaseBudgetPreflightResultV1,
  ReleaseReviewReceiptV1,
  ReleaseScopeProposalV1,
} from '../../src/contracts/release-runtime';
import type { BudgetPolicyCeilingsV1 } from '../../src/contracts/budget-retention';
import { normalizeCaseRequest } from '../../src/planner/normalize-intent';
import * as evidenceIntegrity from '../../src/evidence/integrity';
import { generateExecutableSelectionManifest } from '../../src/governance/executable-selection-manifest';
import {
  readAndVerifyDiagnosticChild,
  prepareQualificationBatch,
  runQualificationBatch,
  verifyQualificationBatch,
  type QualificationRuntimeDependencies,
  type VerifiedChild,
} from '../../src/governance/qualification-runtime';
import { readFinalPublicRecord } from '../../src/contracts/final-public-record';
import {
  activateRelease,
  runRelease,
  verifyReleaseRun,
  type ReleaseRuntimeDependencies,
  type TerminalPersistenceStage,
} from '../../src/governance/release-runtime';
import { createReleaseLedger, readReleaseLedger } from '../../src/governance/release-ledger';
import { readQualificationLedger } from '../../src/governance/qualification-ledger';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';

function context(): ExecutableManifestValidationContext {
  const environmentCatalogue = loadEnvironmentCatalogue();
  const requestTemplates = resolveSuiteRequests(loadDiagnosticSuite('representative')).map(
    (member) => {
      const normalized = normalizeCaseRequest(member.request);
      if (!normalized.ok) throw new Error('bad fixture');
      const { intent } = normalized.request;
      return {
        templateId: path.basename(member.relativePath, '.json'),
        subjectId: intent.subjectId,
        capability: intent.capability,
        scenarioId: intent.scenario,
        intent,
      };
    },
  );
  return {
    catalogues: loadCatalogueBundle(),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates,
  };
}

function unsignedDigest(value: Record<string, unknown>, field: string): string {
  const { [field]: _ignored, ...unsigned } = value;
  return sha256Hex(`makeit.verify-artwork-editor/${field}/v1\n${canonicalize(unsigned)}`);
}

function rewriteReleaseLedger(
  root: string,
  runId: string,
  mutateFirst: (event: Record<string, unknown>) => void,
  mutateIndex: number | 'last' = 0,
): void {
  const eventsDir = path.join(root, 'evidence/governance/release-runs', runId, 'events');
  const names = readdirSync(eventsDir).sort();
  let previousDigest: string | null = null;
  for (let index = 0; index < names.length; index += 1) {
    const file = path.join(eventsDir, names[index] as string);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (index === (mutateIndex === 'last' ? names.length - 1 : mutateIndex))
      mutateFirst(record.event as Record<string, unknown>);
    const unsigned = {
      schemaVersion: record.schemaVersion,
      ledgerId: record.ledgerId,
      sequence: index + 1,
      previousDigest,
      event: record.event,
    };
    const digest = sha256Hex(canonicalize(unsigned));
    writeFileSync(file, `${canonicalize({ ...unsigned, digest })}\n`);
    previousDigest = digest;
  }
}

function lifecycleIdForTest(draft: ExecutableSelectionManifestDraftV1, bytes: string): string {
  return `manifest-${sha256Hex(`makeit.verify-artwork-editor/manifest-lifecycle-snapshot/v1\n${canonicalize({ manifestId: draft.manifestId, contentFingerprint: draft.contentFingerprint, draftBytesDigest: sha256Hex(bytes) })}`)}`;
}

function obligationRows(draft: ExecutableSelectionManifestDraftV1) {
  return draft.content.bindings.map((binding) => {
    const entries = draft.content.entries.filter(
      (entry) => entry.subjectId === binding.subjectId && entry.capability === binding.capability,
    );
    const includedEntryIds = entries.map((entry) => entry.entryId);
    const covered = new Set(entries.flatMap((entry) => entry.obligationIds));
    const required = binding.selection.obligationMappings
      .filter((mapping) => mapping.requiredFor === 'release')
      .map((mapping) => mapping.obligationId);
    return {
      subjectId: binding.subjectId,
      capability: binding.capability,
      includedEntryIds,
      uncoveredObligations: [...new Set(required.filter((id) => !covered.has(id)))].sort(),
    };
  });
}

type FixtureDependencies = QualificationRuntimeDependencies & {
  readonly resolveBudgetPreflight: NonNullable<
    ReleaseRuntimeDependencies['resolveBudgetPreflight']
  >;
  readonly readChildBudgetFacts: NonNullable<ReleaseRuntimeDependencies['readChildBudgetFacts']>;
};

const SYNTHETIC_POLICY_ID = `budget-policy-${'e'.repeat(64)}`;
const SYNTHETIC_SET_ID = `bset-${'f'.repeat(64)}`;
const SYNTHETIC_RETENTION_ID = 'retention-00000000-0000-0000-0000-000000000000';
const SYNTHETIC_POLICY_DIGEST = sha256Hex('synthetic-release-policy');
const SYNTHETIC_SET_DIGEST = sha256Hex('synthetic-release-set');

/** Explicit synthetic-only seam: never live authority, never Release credit. */
function syntheticBudgetPreflight(
  input: ReleaseBudgetPreflightInputV1,
): ReleaseBudgetPreflightResultV1 {
  return {
    ok: true,
    value: {
      releaseCredit: false,
      policyApprovalId: SYNTHETIC_POLICY_ID,
      policyDigest: SYNTHETIC_POLICY_DIGEST,
      approvalDigest: sha256Hex('synthetic-release-approval'),
      reviewDigest: sha256Hex('synthetic-release-review'),
      measurementSetId: SYNTHETIC_SET_ID,
      measurementSetContentDigest: SYNTHETIC_SET_DIGEST,
      method: 'full-scope-envelope-v1',
      methodVersion: 1,
      ceilings: {
        releaseDurationMs: 1_000_000,
        releaseEvidenceBytes: 1_000_000,
        qualificationDurationMs: 1_000_000,
        qualificationEvidenceBytes: 1_000_000,
        retainedEvidenceBytes: 1_000_000,
        imageTornRecaptures: null,
      },
      limitations: ['family:text:UNAVAILABLE', 'torn-counter:image:REQUIRED'],
      manifestId: input.manifestId,
      manifestFingerprint: input.manifestFingerprint,
      requiredCellId: input.requiredCellId,
      sourceProvenanceDigest: input.sourceProvenanceDigest,
      basis: {
        measurementSetContentDigest: SYNTHETIC_SET_DIGEST,
        retentionAuditId: SYNTHETIC_RETENTION_ID,
        retentionAuditDigest: sha256Hex('synthetic-release-retention'),
      },
    },
  };
}

function fixture() {
  const current = context();
  const generated = generateExecutableSelectionManifest(current);
  if (generated.status !== 'GENERATED_DRAFT') throw new Error('manifest generation failed');
  const root = realpathSync(
    mkdtempSync(path.join(realpathSync(tmpdir()), 'release-runtime-test-')),
  );
  const draft = generated.draft;
  const drafts = path.join(root, 'cases/selection-manifests/drafts');
  mkdirSync(drafts, { recursive: true });
  const draftBytes = `${canonicalize(draft)}\n`;
  const draftFile = path.join(drafts, `draft-${sha256Hex(draftBytes)}.json`);
  writeFileSync(draftFile, draftBytes);
  const candidates = new Map<string, PreparedExecutionCandidate>();
  let source = 'a'.repeat(64);
  const dependencies: FixtureDependencies = {
    skillRoot: root,
    repoRoot: root,
    loadContext: () => current,
    compileCandidate: compilePreparedExecutionCandidate,
    runCandidate: async ({ preparedCandidate, runId }) => {
      candidates.set(runId, preparedCandidate);
      return buildCliResult({
        command: 'diagnostic',
        status: 'PASS',
        outcome: 'PASS',
        detail: 'fixture',
        details: null,
      });
    },
    collectSourceDigest: () => source,
    readAndVerifyChild: (runId): VerifiedChild => {
      const candidate = candidates.get(runId);
      if (!candidate)
        return {
          valid: false,
          recordDigest: null,
          evidenceDigest: null,
          outcome: null,
          cleanupVerified: false,
          evidenceVerified: false,
          code: 'CHILD_RECORD_INVALID',
        };
      return {
        valid: true,
        recordDigest: sha256Hex(`record:${runId}`),
        evidenceDigest: sha256Hex(`evidence:${runId}`),
        outcome: 'PASS',
        cleanupVerified: true,
        evidenceVerified: true,
        code: null,
        runId,
        caseId: candidate.identity.caseId,
        materializationFingerprint: candidate.identity.materializationFingerprint,
        planFingerprint: candidate.identity.planFingerprint,
        cellId: candidate.identity.cellId,
        profile: 'release',
        provenance: 'manifest',
        evidenceDepth: 'standard',
      };
    },
    makeId: randomUUID,
    resolveBudgetPreflight: syntheticBudgetPreflight,
    // Synthetic bounded strict facts: a tiny payload that never trips the
    // synthetic ceilings, so existing non-budget assertions stay exact.
    readChildBudgetFacts: () => ({
      ok: true,
      value: { family: 'text', evidenceByteCount: 0, imageTornRecaptures: null },
    }),
  };
  const entryIds = [
    '3b244208ea3d8f1e373d63fb8611fcbc9e7680822423a92a987d9aab052ef3b0',
    'a1785d09ebbe5377b9c80d2f8dd5274a26350749c90087d30d4c9a580d5fa8b0',
    'cddacddbea78bcc47f3a68bdacb404496d232d26c77d187ba6fdeba8a75c2569',
  ];
  if (entryIds.some((id) => !draft.content.entries.some((entry) => entry.entryId === id)))
    throw new Error('ADR 0102 qualification packet does not match current draft.');
  const prepared = prepareQualificationBatch(
    {
      draft,
      entryIds,
      selectionRationale:
        'Exercise three distinct complex correctness paths: nested warped-text native pointer geometry; image replacement with asynchronous resource identity; raw semantic serialize/restore reconciliation. Selection fixed before any qualification result; all eight entries remain required for a later Release.',
    },
    { dependencies },
  );
  if (!prepared.ok) throw new Error('qualification preparation failed');
  return {
    root,
    draft,
    draftFile,
    draftBytes,
    dependencies,
    prepared,
    candidates,
    setSource: (v: string) => {
      source = v;
    },
  };
}

function strictReleaseRecord(
  runId: string,
  candidate: PreparedExecutionCandidate,
): Record<string, unknown> {
  const sourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../integration/fixtures/p8b/committed-run/run-record.json',
  );
  const record = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>;
  record.runId = runId;
  record.caseId = candidate.identity.caseId;
  record.materializationFingerprint = candidate.identity.materializationFingerprint;
  record.planFingerprint = candidate.identity.planFingerprint;
  record.profile = 'release';
  record.provenance = 'manifest';
  record.evidenceDepth = 'standard';
  record.environmentCellId = candidate.environmentCell.cellId;
  record.finalOutcome = 'PASS';
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
  (record.ownership as Record<string, unknown>).runId = runId;
  return record;
}

function authorAuthority(
  state: ReturnType<typeof fixture>,
  draftFile = state.draftFile,
  draftBytes = state.draftBytes,
  suffix = 'fixture',
) {
  const { root, draft, prepared } = state;
  const batch = prepared.batch;
  const ledger = readQualificationLedger(root, batch.batchId);
  const final = ledger.at(-1);
  if (!final) throw new Error('missing qualification predeclaration');
  const generatedProposal: ReleaseScopeProposalV1 = {
    schemaVersion: 1,
    state: 'PROPOSED_NOT_APPROVED',
    manifestId: draft.manifestId,
    contentFingerprint: draft.contentFingerprint,
    artifact: path.relative(root, draftFile).split(path.sep).join('/'),
    releaseCredit: false,
    scope: 'Only the exact declared manifest entries in its one required cell.',
    qualificationEntryIdsInOrder: [...batch.selectedEntryIds],
    qualificationScenarioOrder: batch.selectedEntryIds.map(
      (id) => draft.content.entries.find((entry) => entry.entryId === id)?.scenarioId ?? '',
    ),
    selectionRationale: batch.selectionRationale,
    lostObligationsByBinding: obligationRows(draft),
    exclusionCount: draft.content.exclusions.length,
    exclusionReasonCounts: draft.content.exclusions.reduce<Record<string, number>>(
      (counts, item) => {
        counts[item.code] = (counts[item.code] ?? 0) + 1;
        return counts;
      },
      {},
    ),
    completeExclusionLedgerSource:
      'The full exclusion array in the referenced immutable manifest draft.',
  };
  const sourceProposalBytes =
    suffix === 'b'
      ? null
      : readFileSync(
          path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../integration/fixtures/release/proposed-scope.json.fixture',
          ),
          'utf8',
        );
  if (
    suffix !== 'b' &&
    sha256Hex(sourceProposalBytes ?? '') !==
      '75d90bcefdd19b364ee84dd06ec01166af8e7e21bf224c514c4c114c6aa95880'
  )
    throw new Error('approved proposal fixture bytes changed');
  const proposal =
    suffix === 'b'
      ? generatedProposal
      : (JSON.parse(sourceProposalBytes ?? '') as ReleaseScopeProposalV1);
  const proposalBytes = sourceProposalBytes ?? `${canonicalize(proposal)}\n`;
  const proposalRef = `evidence/governance/proposals/proposal-${suffix}.json`;
  mkdirSync(path.join(root, 'evidence/governance/proposals'), { recursive: true });
  writeFileSync(path.join(root, proposalRef), proposalBytes);
  const proposalDigest = sha256Hex(proposalBytes);
  const review: ReleaseReviewReceiptV1 = {
    schemaVersion: 1,
    reviewId: `review-${suffix}`,
    reviewer: 'independent-reviewer',
    result: 'PASS',
    manifestId: draft.manifestId,
    manifestFingerprint: draft.contentFingerprint,
    qualificationBatchId: batch.batchId,
    qualificationLedgerDigest: final.digest,
    proposalDigest,
    rationale: 'Independently checked exact scope and Qualification evidence.',
  };
  const reviewBytes = `${canonicalize(review)}\n`;
  mkdirSync(path.join(root, 'evidence/governance/reviews'), { recursive: true });
  writeFileSync(
    path.join(root, `evidence/governance/reviews/${review.reviewId}.json`),
    reviewBytes,
  );
  const approvalBase = {
    schemaVersion: 1 as const,
    approvalId: `approval-${suffix}`,
    decisionMaker: 'delegated-owner / Codex orchestrator' as const,
    mandate: 'ADR-0099' as const,
    decisionScope: 'activate-exact-release-candidate' as const,
    manifestId: draft.manifestId,
    manifestFingerprint: draft.contentFingerprint,
    draftBytesDigest: sha256Hex(draftBytes),
    qualificationBatchId: batch.batchId,
    qualificationBatchFingerprint: batch.batchFingerprint,
    qualificationLedgerDigest: final.digest,
    requiredWork: draft.content.entries.map((entry) => ({
      entryId: entry.entryId,
      cellId: draft.content.requiredCell.cellId,
    })),
    proposalReference: proposalRef,
    proposalBytesDigest: proposalDigest,
    qualificationEntryIdsInOrder: [...batch.selectedEntryIds],
    reviews: [{ reviewId: review.reviewId, bytesDigest: sha256Hex(reviewBytes) }],
    rationale: 'Authorize this exact, reviewed scope after verified Qualification.',
    timestamp: '2026-09-26T00:00:00.000Z',
    previousLifecycleDigest: final.digest,
  };
  const approval = {
    ...approvalBase,
    recordDigest: unsignedDigest(
      approvalBase as unknown as Record<string, unknown>,
      'recordDigest',
    ),
  } satisfies ReleaseApprovalV1;
  const approvalBytes = `${canonicalize(approval)}\n`;
  mkdirSync(path.join(root, 'evidence/governance/approvals'), { recursive: true });
  writeFileSync(
    path.join(root, `evidence/governance/approvals/${approval.approvalId}.json`),
    approvalBytes,
  );
  return { proposal, review, approval };
}

describe('governed Release runtime', () => {
  /**
   * Synthetic-only budget ceiling override. The preflight seam is never
   * authority (ADR 0111); these numbers only exercise aggregate enforcement.
   */
  function preflightWithCeilings(
    ceilings: Partial<BudgetPolicyCeilingsV1>,
  ): NonNullable<ReleaseRuntimeDependencies['resolveBudgetPreflight']> {
    return (input) => {
      const base = syntheticBudgetPreflight(input);
      if (!base.ok) return base;
      return {
        ok: true,
        value: { ...base.value, ceilings: { ...base.value.ceilings, ...ceilings } },
      };
    };
  }

  async function activatedState() {
    const state = fixture();
    await runQualificationBatch(state.prepared.batch.batchId, {
      dependencies: state.dependencies,
    });
    const authority = authorAuthority(state);
    const verifyQualification = (batchId: string) =>
      verifyQualificationBatch(batchId, { dependencies: state.dependencies });
    const activation = activateRelease(
      {
        manifestFile: state.draftFile,
        batchId: state.prepared.batch.batchId,
        approvalId: authority.approval.approvalId,
      },
      { dependencies: { ...state.dependencies, verifyQualification } },
    );
    if (!activation.ok) throw new Error(`activation failed: ${activation.code}`);
    return { state, authority, verifyQualification };
  }

  it('terminates non-creditably at the aggregate duration ceiling without starting the next slot', async () => {
    const { state, verifyQualification } = await activatedState();
    const launched: string[] = [];
    const childReads: string[] = [];
    let clock = 0;
    let wallStep = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflightWithCeilings({ releaseDurationMs: 30 }),
      monotonicNow: () => clock,
      // Deliberately backwards wall timestamps: chronology only, never the budget.
      wallNow: () => {
        wallStep += 1;
        return new Date(Date.UTC(2026, 8, 26, 12, 0, 0) - wallStep * 60_000).toISOString();
      },
      // A between-slot orchestration gap is charged to the aggregate.
      collectSourceDigest: () => {
        clock += 20;
        return state.dependencies.collectSourceDigest();
      },
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        launched.push(input.runId);
        clock += 5;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        childReads.push(runId);
        clock += 5;
        return state.dependencies.readAndVerifyChild(runId);
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: {
          state: 'BUDGET_TERMINATED',
          releaseCreditGranted: false,
          workCount: state.draft.content.entries.length,
        },
      });
      if (!run.ok) return;
      // Exactly one started child, preserved as PASS with strict verification and
      // owned cleanup still attempted.
      expect(launched).toHaveLength(1);
      expect(childReads).toHaveLength(1);
      expect(run.value.outcomes).toEqual([
        { order: 0, runId: expect.any(String), outcome: 'PASS' },
      ]);
      const events = readReleaseLedger(state.root, run.value.runId).map((record) => record.event);
      expect(events.filter((event) => event.type === 'slot-started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'slot-finished')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: 'run-assessed',
        state: 'BUDGET_TERMINATED',
        unstartedOrders: [1, 2, 3, 4, 5, 6, 7],
        releaseCreditGranted: false,
      });
      // The per-slot elapsed alone is under the ceiling: only the aggregate,
      // gap-inclusive clock can terminate the run.
      const finished = events.find((event) => event.type === 'slot-finished');
      expect(finished?.type === 'slot-finished' ? finished.timing?.elapsedMs : null).toBeLessThan(
        30,
      );
      const readback = verifyReleaseRun(state.root, run.value.runId, { dependencies });
      expect(readback).toMatchObject({
        ok: true,
        value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('charges a started child strict readback/cleanup time to the aggregate before the next slot', async () => {
    const { state, verifyQualification } = await activatedState();
    const launched: string[] = [];
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflightWithCeilings({ releaseDurationMs: 25 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      collectSourceDigest: () => {
        clock += 1;
        return state.dependencies.collectSourceDigest();
      },
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        launched.push(input.runId);
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      // Strict evidence reread plus owned cleanup verification dominate slot time.
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 30;
        return state.dependencies.readAndVerifyChild(runId);
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      expect(launched).toHaveLength(1);
      expect(run.value.outcomes).toEqual([
        { order: 0, runId: expect.any(String), outcome: 'PASS' },
      ]);
      expect(readReleaseLedger(state.root, run.value.runId).at(-1)?.event).toMatchObject({
        type: 'run-assessed',
        state: 'BUDGET_TERMINATED',
        unstartedOrders: [1, 2, 3, 4, 5, 6, 7],
        releaseCreditGranted: false,
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('stops exactly at the duration ceiling equality and runs the full manifest', async () => {
    const { state, verifyQualification } = await activatedState();
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflightWithCeilings({ releaseDurationMs: 16 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: {
          state: 'COMPLETE_ALL_PASS',
          releaseCreditGranted: false,
          workCount: state.draft.content.entries.length,
        },
      });
      if (!run.ok) return;
      expect(run.value.outcomes).toHaveLength(state.draft.content.entries.length);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('terminalizes a final-gap duration overrun as a non-creditable budget stop with no remaining slot', async () => {
    const { state, verifyQualification } = await activatedState();
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflightWithCeilings({ releaseDurationMs: 15 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      expect(run.value.outcomes).toHaveLength(state.draft.content.entries.length);
      expect(readReleaseLedger(state.root, run.value.runId).at(-1)?.event).toMatchObject({
        type: 'run-assessed',
        state: 'BUDGET_TERMINATED',
        unstartedOrders: [],
        releaseCreditGranted: false,
      });
      // Even a completed-but-overrun run never gains credit nor partial PASS.
      const readback = verifyReleaseRun(state.root, run.value.runId, { dependencies });
      expect(readback).toMatchObject({
        ok: true,
        value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('terminates after a started slot when the cumulative strict-evidence byte ceiling is crossed', async () => {
    const { state, verifyQualification } = await activatedState();
    const launched: string[] = [];
    const childReads: string[] = [];
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflightWithCeilings({ releaseEvidenceBytes: 150 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      collectSourceDigest: () => {
        clock += 1;
        return state.dependencies.collectSourceDigest();
      },
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        launched.push(input.runId);
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        childReads.push(runId);
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
      readChildBudgetFacts: () =>
        ({
          ok: true,
          value: { family: 'text', evidenceByteCount: 100, imageTornRecaptures: null },
        }) as const,
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      // 100 + 100 = 200 > 150 after the second strictly verified child.
      expect(launched).toHaveLength(2);
      expect(childReads).toHaveLength(2);
      expect(run.value.outcomes).toEqual([
        { order: 0, runId: expect.any(String), outcome: 'PASS' },
        { order: 1, runId: expect.any(String), outcome: 'PASS' },
      ]);
      const events = readReleaseLedger(state.root, run.value.runId).map((record) => record.event);
      expect(events.filter((event) => event.type === 'slot-started')).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({
        type: 'run-assessed',
        state: 'BUDGET_TERMINATED',
        unstartedOrders: [2, 3, 4, 5, 6, 7],
        releaseCreditGranted: false,
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('terminates after a started slot when the cumulative strict Image tear ceiling is crossed', async () => {
    const { state, verifyQualification } = await activatedState();
    const launched: string[] = [];
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflightWithCeilings({ imageTornRecaptures: 5 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      collectSourceDigest: () => {
        clock += 1;
        return state.dependencies.collectSourceDigest();
      },
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        launched.push(input.runId);
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
      readChildBudgetFacts: () =>
        ({
          ok: true,
          value: { family: 'image', evidenceByteCount: 1, imageTornRecaptures: 3 },
        }) as const,
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      // 3 + 3 = 6 > 5 after the second strictly verified child.
      expect(launched).toHaveLength(2);
      expect(readReleaseLedger(state.root, run.value.runId).at(-1)?.event).toMatchObject({
        type: 'run-assessed',
        state: 'BUDGET_TERMINATED',
        unstartedOrders: [2, 3, 4, 5, 6, 7],
        releaseCreditGranted: false,
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses credit under a stronger integrity stop when a required strict budget fact is unavailable', async () => {
    const { state, verifyQualification } = await activatedState();
    const launched: string[] = [];
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflightWithCeilings({ imageTornRecaptures: 10 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      collectSourceDigest: () => {
        clock += 1;
        return state.dependencies.collectSourceDigest();
      },
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        launched.push(input.runId);
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
      // The method requires a strict Image counter, but no strict fact is derivable.
      readChildBudgetFacts: () => ({ ok: false, code: 'EVIDENCE_INVALID' }) as const,
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      // The child is started and its strict verification/cleanup attempted, but the
      // terminal must be an integrity stop, never a weaker budget skip.
      expect(launched).toHaveLength(1);
      const events = readReleaseLedger(state.root, run.value.runId).map((record) => record.event);
      expect(events.find((event) => event.type === 'slot-finished')).toMatchObject({
        outcome: null,
        failureCode: 'EVIDENCE_INVALID',
      });
      const terminal = events.at(-1);
      expect(terminal).toMatchObject({ type: 'run-assessed', state: 'INTERRUPTED' });
      expect(terminal?.type === 'run-assessed' ? terminal.state : null).not.toBe(
        'BUDGET_TERMINATED',
      );
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
  it('ingests exact independent authority, activates and executes the complete work list once through the prepared path', async () => {
    const state = fixture();
    try {
      const qualification = await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      expect(qualification?.state).toBe('REVIEW_READY');
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const cliOptions = {
        release: {
          skillRoot: state.root,
          repoRoot: state.root,
          loadContext: () => context(),
          runtime: { dependencies: { ...state.dependencies, verifyQualification } },
        },
      };
      const badIdOutput: string[] = [];
      const badIdCode = await runCli(
        [
          'release',
          'activate',
          '--manifest',
          state.draftFile,
          '--batch',
          '../outside',
          '--approval',
          authority.approval.approvalId,
        ],
        { ...cliOptions, stdout: (chunk) => badIdOutput.push(chunk) },
      );
      const badIdEnvelope = parseCliResultEnvelope(JSON.parse(badIdOutput.join('')) as unknown);
      expect(badIdCode).toBe(2);
      expect(badIdEnvelope.status).toBe('HARNESS_BLOCKED');
      expect(existsSync(path.join(state.root, 'evidence/governance/manifest-lifecycle'))).toBe(
        false,
      );
      const traversalOutput: string[] = [];
      const traversalCode = await runCli(
        [
          'release',
          'run',
          '--manifest',
          path.join(state.root, 'cases/selection-manifests/drafts/../../../../outside.json'),
        ],
        { ...cliOptions, stdout: (chunk) => traversalOutput.push(chunk) },
      );
      const traversalEnvelope = parseCliResultEnvelope(
        JSON.parse(traversalOutput.join('')) as unknown,
      );
      expect(traversalCode).toBe(2);
      expect(traversalEnvelope.status).toBe('HARNESS_BLOCKED');
      expect(JSON.stringify(traversalEnvelope)).not.toContain(state.root);
      expect(existsSync(path.join(state.root, 'evidence/governance/release-runs'))).toBe(false);
      const activationOutput: string[] = [];
      const activationCode = await runCli(
        [
          'release',
          'activate',
          '--manifest',
          state.draftFile,
          '--batch',
          state.prepared.batch.batchId,
          '--approval',
          authority.approval.approvalId,
        ],
        {
          ...cliOptions,
          stdout: (chunk) => activationOutput.push(chunk),
        },
      );
      const activationEnvelope = parseCliResultEnvelope<Record<string, unknown>>(
        JSON.parse(activationOutput.join('')) as unknown,
      );
      expect(activationCode).toBe(0);
      expect(activationEnvelope.status).toBe('PASS');
      expect(activationEnvelope.details).toMatchObject({
        state: 'ACTIVE',
        workCount: state.draft.content.entries.length,
      });
      const runOutput: string[] = [];
      const runCode = await runCli(['release', 'run', '--manifest', state.draftFile], {
        ...cliOptions,
        stdout: (chunk) => runOutput.push(chunk),
      });
      const runEnvelope = parseCliResultEnvelope<Record<string, unknown>>(
        JSON.parse(runOutput.join('')) as unknown,
      );
      expect(runCode).toBe(2);
      expect(runEnvelope.status).toBe('HARNESS_BLOCKED');
      expect(runEnvelope.details).toMatchObject({
        state: 'COMPLETE_ALL_PASS',
        releaseCreditGranted: false,
        workCount: state.draft.content.entries.length,
      });
      const runId = String(runEnvelope.details?.runId);
      const verified = verifyReleaseRun(state.root, runId, {
        dependencies: {
          ...state.dependencies,
          verifyQualification: (batchId) =>
            verifyQualificationBatch(batchId, { dependencies: state.dependencies }),
        },
      });
      expect(verified).toMatchObject({
        ok: true,
        value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
      });
      const mismatchedChild = verifyReleaseRun(state.root, runId, {
        dependencies: {
          ...state.dependencies,
          verifyQualification: (batchId) =>
            verifyQualificationBatch(batchId, { dependencies: state.dependencies }),
          readAndVerifyChild: (id) => ({
            ...state.dependencies.readAndVerifyChild(id),
            caseId: 'different-case',
          }),
        },
      });
      expect(mismatchedChild.ok).toBe(false);
      const lifecycleDirectory = path.join(state.root, 'evidence/governance/manifest-lifecycle');
      expect(existsSync(lifecycleDirectory)).toBe(true);
      expect(
        existsSync(
          path.join(
            lifecycleDirectory,
            'manifest-' +
              sha256Hex(
                `makeit.verify-artwork-editor/manifest-lifecycle-snapshot/v1\n${canonicalize({ manifestId: state.draft.manifestId, contentFingerprint: state.draft.contentFingerprint, draftBytesDigest: sha256Hex(state.draftBytes) })}`,
              ),
            'events/event-000002.json',
          ),
        ),
      ).toBe(true);
      rewriteReleaseLedger(state.root, runId, (event) => {
        const slots = event.slots as Record<string, unknown>[];
        const firstSlot = slots[0];
        const cell = firstSlot?.cell as Record<string, unknown> | undefined;
        const viewport = cell?.viewport as Record<string, unknown> | undefined;
        if (!firstSlot || !cell || !viewport) throw new Error('missing predeclared cell');
        viewport.width = Number(viewport.width) + 1;
      });
      expect(
        verifyReleaseRun(state.root, runId, {
          dependencies: {
            ...state.dependencies,
            verifyQualification: (batchId) =>
              verifyQualificationBatch(batchId, { dependencies: state.dependencies }),
          },
        }).ok,
      ).toBe(false);
      rewriteReleaseLedger(state.root, runId, (event) => {
        const slots = event.slots as Record<string, unknown>[];
        event.slots = slots.slice(1).map((slot, order) => ({ ...slot, order }));
      });
      expect(
        verifyReleaseRun(state.root, runId, {
          dependencies: {
            ...state.dependencies,
            verifyQualification: (batchId) =>
              verifyQualificationBatch(batchId, { dependencies: state.dependencies }),
          },
        }).ok,
      ).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('reads all Release children from strict-v4 files through the shared production reader', async () => {
    const state = fixture();
    const verifyEvidence = vi.spyOn(evidenceIntegrity, 'verifyEvidenceRoot').mockReturnValue({
      transaction: { creditEligible: true, strictRecordPresent: true },
      provenance: { currentTreeCheck: 'PASS', currentTreeCreditEligible: true },
      checks: [{ result: 'PASS' }],
    } as unknown as ReturnType<typeof evidenceIntegrity.verifyEvidenceRoot>);
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      expect(state.draft.content.entries).toHaveLength(8);
      const readRunIds: string[] = [];
      let elapsedClock = 0;
      let wallSecond = 0;
      const runtimeDependencies = {
        ...state.dependencies,
        verifyQualification,
        monotonicNow: () => elapsedClock,
        wallNow: () => {
          wallSecond += 1;
          return new Date(Date.UTC(2026, 8, 26, 10) - wallSecond * 60_000).toISOString();
        },
        collectSourceDigest: () => {
          elapsedClock += 1;
          return state.dependencies.collectSourceDigest();
        },
        runCandidate: async ({
          preparedCandidate,
          runId,
        }: {
          preparedCandidate: PreparedExecutionCandidate;
          expectedIdentity: PreparedExecutionCandidate['identity'];
          runId: string;
        }) => {
          elapsedClock += 2;
          state.candidates.set(runId, preparedCandidate);
          const record = strictReleaseRecord(runId, preparedCandidate);
          expect(readFinalPublicRecord(record).kind).toBe('current-v4');
          const directory = path.join(state.root, 'evidence/runs', runId);
          mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, 'run-record.json'), `${JSON.stringify(record)}\n`);
          return buildCliResult({
            command: 'diagnostic',
            status: 'PASS',
            outcome: 'PASS',
            detail: 'fixture strict-v4 child',
            details: null,
          });
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          readRunIds.push(runId);
          const child = readAndVerifyDiagnosticChild(state.root, runId, state.root);
          elapsedClock += 3;
          return child;
        },
      };
      const run = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: runtimeDependencies },
      );
      expect(run).toMatchObject({
        ok: true,
        value: {
          state: 'COMPLETE_ALL_PASS',
          releaseCreditGranted: false,
          workCount: state.draft.content.entries.length,
        },
      });
      expect(readRunIds).toHaveLength(state.draft.content.entries.length);
      expect(new Set(readRunIds).size).toBe(state.draft.content.entries.length);
      expect(verifyEvidence).toHaveBeenCalledTimes(state.draft.content.entries.length);
      if (!run.ok) return;
      const runEvents = readReleaseLedger(state.root, run.value.runId).map(
        (record) => record.event,
      );
      const slotTimings = runEvents
        .filter((event) => event.type === 'slot-finished')
        .map((event) => (event.type === 'slot-finished' ? event.timing?.elapsedMs : null));
      const terminalTiming = runEvents.at(-1);
      expect(slotTimings).toEqual(Array.from({ length: 8 }, () => 5));
      expect(
        terminalTiming?.type === 'run-assessed' ? terminalTiming.timing?.elapsedMs : null,
      ).toBeGreaterThan(
        slotTimings.reduce<number>((total, duration) => total + (duration ?? 0), 0),
      );
      expect(
        terminalTiming?.type === 'run-assessed' ? terminalTiming.timing?.startedAt : '',
      ).not.toBe(terminalTiming?.type === 'run-assessed' ? terminalTiming.timing?.endedAt : '');
      const verified = verifyReleaseRun(state.root, run.value.runId, {
        dependencies: runtimeDependencies,
      });
      expect(verified).toMatchObject({
        ok: true,
        value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
      });
      expect(readRunIds).toHaveLength(state.draft.content.entries.length * 2);
      rewriteReleaseLedger(
        state.root,
        run.value.runId,
        (event) => {
          delete event.timing;
        },
        'last',
      );
      expect(
        verifyReleaseRun(state.root, run.value.runId, { dependencies: runtimeDependencies }).ok,
      ).toBe(false);
      rewriteReleaseLedger(
        state.root,
        run.value.runId,
        (event) => {
          if (terminalTiming?.type === 'run-assessed' && terminalTiming.timing)
            event.timing = terminalTiming.timing;
        },
        'last',
      );
      expect(
        verifyReleaseRun(state.root, run.value.runId, { dependencies: runtimeDependencies }).ok,
      ).toBe(true);
      const corruptedChild = path.join(
        state.root,
        'evidence/runs',
        readRunIds[0] as string,
        'run-record.json',
      );
      writeFileSync(corruptedChild, '{corrupt strict-v4 record');
      expect(
        verifyReleaseRun(state.root, run.value.runId, { dependencies: runtimeDependencies }).ok,
      ).toBe(false);
    } finally {
      verifyEvidence.mockRestore();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('stops before the next slot after a monotonic clock reset and preserves the child PASS', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      const values = [100, 110, 100, 200];
      const dependencies = {
        ...state.dependencies,
        verifyQualification,
        monotonicNow: () => values.shift() ?? 200,
        wallNow: () => '2026-09-26T10:00:00.000Z',
      };
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: {
          state: 'INTERRUPTED',
          releaseCreditGranted: false,
          outcomes: [{ outcome: 'PASS' }],
        },
      });
      if (!run.ok) return;
      expect(run.value.outcomes).toHaveLength(1);
      const events = readReleaseLedger(state.root, run.value.runId).map((record) => record.event);
      expect(events.find((event) => event.type === 'slot-finished')).toMatchObject({
        outcome: 'PASS',
        failureCode: 'TIMING_INVALID',
      });
      expect(events.at(-1)).toMatchObject({
        type: 'run-assessed',
        state: 'INTERRUPTED',
        unstartedOrders: [1, 2, 3, 4, 5, 6, 7],
        timingFailureCode: 'TIMING_INVALID',
      });
      expect(verifyReleaseRun(state.root, run.value.runId, { dependencies }).ok).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('detects a monotonic reset between slots before allocating the next slot', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      const values = [100, 1000, 1010, 90, 200];
      let childCalls = 0;
      const dependencies = {
        ...state.dependencies,
        verifyQualification,
        monotonicNow: () => values.shift() ?? 200,
        wallNow: () => '2026-09-26T10:00:00.000Z',
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          childCalls += 1;
          return state.dependencies.runCandidate(input);
        },
      };
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      expect(childCalls).toBe(1);
      expect(run.value.outcomes).toEqual([
        { order: 0, runId: expect.any(String), outcome: 'PASS' },
      ]);
      const events = readReleaseLedger(state.root, run.value.runId).map((record) => record.event);
      expect(events.filter((event) => event.type === 'slot-started')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: 'run-assessed',
        state: 'INTERRUPTED',
        unstartedOrders: [1, 2, 3, 4, 5, 6, 7],
        timingFailureCode: 'TIMING_INVALID',
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('assesses an aggregate clock reset below sequential slot time as non-creditable', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      const values = [100];
      for (let order = 0; order < 8; order += 1) values.push(1000 + order * 20, 1010 + order * 20);
      values.push(150);
      const dependencies = {
        ...state.dependencies,
        verifyQualification,
        monotonicNow: () => values.shift() ?? 200,
        wallNow: () => '2026-09-26T10:00:00.000Z',
      };
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'NON_CREDITABLE', releaseCreditGranted: false, workCount: 8 },
      });
      if (!run.ok) return;
      const terminal = readReleaseLedger(state.root, run.value.runId).at(-1)?.event;
      expect(terminal).toMatchObject({
        type: 'run-assessed',
        state: 'NON_CREDITABLE',
        timingFailureCode: 'TIMING_INVALID',
      });
      expect(verifyReleaseRun(state.root, run.value.runId, { dependencies }).ok).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses a changed exact review receipt before writing lifecycle state', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      writeFileSync(
        path.join(state.root, `evidence/governance/reviews/${authority.review.reviewId}.json`),
        `${canonicalize({ ...authority.review, rationale: 'substituted' })}\n`,
      );
      const result = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification: (batchId) =>
              verifyQualificationBatch(batchId, { dependencies: state.dependencies }),
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(existsSync(path.join(state.root, 'evidence/governance/manifest-lifecycle'))).toBe(
        false,
      );
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it.each([
    'approval-digest',
    'proposal-bytes',
    'qualification-sample-order',
    'approval-symlink',
    'approval-hardlink',
    'review-symlink',
    'review-hardlink',
    'proposal-symlink',
    'proposal-hardlink',
    'lifecycle-symlink',
    'lifecycle-hardlink',
    'lifecycle-sequence',
    'lifecycle-previous-digest',
    'post-activation-approval-drift',
    'post-activation-proposal-drift',
  ] as const)('fails closed for %s authority tampering', async (scenario) => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const options = { dependencies: { ...state.dependencies, verifyQualification } };
      if (scenario === 'approval-digest') {
        const file = path.join(
          state.root,
          `evidence/governance/approvals/${authority.approval.approvalId}.json`,
        );
        writeFileSync(
          file,
          `${canonicalize({ ...authority.approval, rationale: 'changed without new digest' })}\n`,
        );
      } else if (scenario === 'proposal-bytes') {
        const file = path.join(state.root, authority.approval.proposalReference);
        writeFileSync(
          file,
          `${canonicalize({ ...authority.proposal, scope: 'substituted proposal content' })}\n`,
        );
      } else if (scenario === 'qualification-sample-order') {
        const file = path.join(
          state.root,
          `evidence/governance/approvals/${authority.approval.approvalId}.json`,
        );
        const reordered = [...authority.approval.qualificationEntryIdsInOrder].reverse();
        const changed = { ...authority.approval, qualificationEntryIdsInOrder: reordered };
        const recordDigest = unsignedDigest(
          changed as unknown as Record<string, unknown>,
          'recordDigest',
        );
        writeFileSync(file, `${canonicalize({ ...changed, recordDigest })}\n`);
      } else if (scenario.endsWith('-symlink') || scenario.endsWith('-hardlink')) {
        const kind = scenario.endsWith('-symlink') ? 'symlink' : 'hardlink';
        let file: string;
        if (scenario.startsWith('lifecycle-')) {
          const active = activateRelease(
            {
              manifestFile: state.draftFile,
              batchId: state.prepared.batch.batchId,
              approvalId: authority.approval.approvalId,
            },
            options,
          );
          expect(active.ok).toBe(true);
          if (!active.ok) return;
          file = path.join(
            state.root,
            'evidence/governance/manifest-lifecycle',
            active.value.lifecycleId,
            'events/event-000001.json',
          );
        } else if (scenario.startsWith('approval-')) {
          file = path.join(
            state.root,
            `evidence/governance/approvals/${authority.approval.approvalId}.json`,
          );
        } else if (scenario.startsWith('review-')) {
          file = path.join(
            state.root,
            `evidence/governance/reviews/${authority.review.reviewId}.json`,
          );
        } else {
          file = path.join(state.root, authority.approval.proposalReference);
        }
        const held = `${file}.held`;
        renameSync(file, held);
        if (kind === 'symlink') symlinkSync(path.basename(held), file);
        else linkSync(held, file);
        if (scenario.startsWith('lifecycle-')) {
          const run = await runRelease({ manifestFile: state.draftFile }, options);
          expect(run.ok).toBe(false);
          expect(existsSync(path.join(state.root, 'evidence/governance/release-runs'))).toBe(false);
          return;
        }
      } else {
        const active = activateRelease(
          {
            manifestFile: state.draftFile,
            batchId: state.prepared.batch.batchId,
            approvalId: authority.approval.approvalId,
          },
          options,
        );
        expect(active.ok).toBe(true);
        if (!active.ok) return;
        if (scenario === 'post-activation-approval-drift') {
          const approvalFile = path.join(
            state.root,
            `evidence/governance/approvals/${authority.approval.approvalId}.json`,
          );
          writeFileSync(
            approvalFile,
            `${canonicalize({ ...authority.approval, rationale: 'changed after activation' })}\n`,
          );
        } else if (scenario === 'post-activation-proposal-drift') {
          const proposalFile = path.join(state.root, authority.approval.proposalReference);
          writeFileSync(
            proposalFile,
            `${canonicalize({ ...authority.proposal, scope: 'changed after activation' })}\n`,
          );
        } else {
          const file = path.join(
            state.root,
            'evidence/governance/manifest-lifecycle',
            active.value.lifecycleId,
            'events/event-000002.json',
          );
          const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
          if (scenario === 'lifecycle-sequence') record.sequence = Number(record.sequence) + 1;
          else record.previousDigest = 'f'.repeat(64);
          writeFileSync(file, `${canonicalize(record)}\n`);
        }
        const run = await runRelease({ manifestFile: state.draftFile }, options);
        expect(run.ok).toBe(false);
        expect(existsSync(path.join(state.root, 'evidence/governance/release-runs'))).toBe(false);
        return;
      }
      const result = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        options,
      );
      expect(result.ok).toBe(false);
      expect(existsSync(path.join(state.root, 'evidence/governance/manifest-lifecycle'))).toBe(
        false,
      );
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('resumes only an identical approval after the frozen event was appended', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const final = readQualificationLedger(state.root, state.prepared.batch.batchId).at(-1);
      if (!final) throw new Error('missing final Qualification digest');
      const approvalPath = path.join(
        state.root,
        `evidence/governance/approvals/${authority.approval.approvalId}.json`,
      );
      const reviewPath = path.join(
        state.root,
        `evidence/governance/reviews/${authority.review.reviewId}.json`,
      );
      const lifecycleId = lifecycleIdForTest(state.draft, state.draftBytes);
      createReleaseLedger(state.root, lifecycleId, {
        type: 'APPROVED_FROZEN',
        manifest: state.draft,
        draftBytesDigest: sha256Hex(state.draftBytes),
        batchId: state.prepared.batch.batchId,
        batchFingerprint: state.prepared.batch.batchFingerprint,
        qualificationLedgerDigest: final.digest,
        approvalId: authority.approval.approvalId,
        approvalBytesDigest: sha256Hex(readFileSync(approvalPath, 'utf8')),
        proposalBytesDigest: authority.approval.proposalBytesDigest,
        reviewBytesDigests: [sha256Hex(readFileSync(reviewPath, 'utf8'))],
        work: state.draft.content.entries.map((entry) => ({
          entryId: entry.entryId,
          cellId: state.draft.content.requiredCell.cellId,
        })),
      });
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const resumed = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(resumed).toMatchObject({ ok: true, value: { lifecycleId } });
      expect(readReleaseLedger(state.root, lifecycleId).map((record) => record.event.type)).toEqual(
        ['APPROVED_FROZEN', 'ACTIVE'],
      );
      const duplicate = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(duplicate.ok).toBe(false);
      expect(readReleaseLedger(state.root, lifecycleId)).toHaveLength(2);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses stale governed source before activation or any Release run allocation', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      state.setSource('b'.repeat(64));
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(activation.ok).toBe(false);
      expect(existsSync(path.join(state.root, 'evidence/governance/manifest-lifecycle'))).toBe(
        false,
      );
      state.setSource('a'.repeat(64));
      const active = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      state.setSource('b'.repeat(64));
      const run = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(run.ok).toBe(false);
      expect(existsSync(path.join(state.root, 'evidence/governance/release-runs'))).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('keeps separately approved exact snapshots in distinct lifecycle namespaces', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const a = authorAuthority(state, state.draftFile, state.draftBytes, 'a');
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activatedA = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: a.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(activatedA.ok).toBe(true);
      if (!activatedA.ok) return;
      const lifecycleRoot = path.join(state.root, 'evidence/governance/manifest-lifecycle');
      const aEvents = path.join(lifecycleRoot, activatedA.value.lifecycleId, 'events');
      const aBefore = readFileSync(path.join(aEvents, 'event-000002.json'));

      const bBytes = `${JSON.stringify(state.draft, null, 2)}\n`;
      const bFile = path.join(
        state.root,
        'cases/selection-manifests/drafts',
        `draft-${sha256Hex(bBytes)}.json`,
      );
      writeFileSync(bFile, bBytes);
      const b = authorAuthority(state, bFile, bBytes, 'b');
      const crossApproval = activateRelease(
        {
          manifestFile: bFile,
          batchId: state.prepared.batch.batchId,
          approvalId: a.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(crossApproval.ok).toBe(false);
      expect(readdirSync(lifecycleRoot)).toEqual([activatedA.value.lifecycleId]);

      const activatedB = activateRelease(
        {
          manifestFile: bFile,
          batchId: state.prepared.batch.batchId,
          approvalId: b.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(activatedB.ok).toBe(true);
      if (!activatedB.ok) return;
      expect(activatedB.value.lifecycleId).not.toBe(activatedA.value.lifecycleId);
      expect(readFileSync(path.join(aEvents, 'event-000002.json'))).toEqual(aBefore);
      expect(readdirSync(lifecycleRoot).sort()).toEqual(
        [activatedA.value.lifecycleId, activatedB.value.lifecycleId].sort(),
      );
      const runA = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(runA).toMatchObject({
        ok: true,
        value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
      });
      if (!runA.ok) return;
      const runAPlan = readReleaseLedger(state.root, runA.value.runId)[0]?.event;
      if (runAPlan?.type !== 'run-predeclared') throw new Error('missing first Release plan');
      const runA2 = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(runA2).toMatchObject({
        ok: true,
        value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
      });
      if (!runA2.ok) return;
      const runA2Plan = readReleaseLedger(state.root, runA2.value.runId)[0]?.event;
      if (runA2Plan?.type !== 'run-predeclared') throw new Error('missing second Release plan');
      expect(runA2.value.runId).not.toBe(runA.value.runId);
      expect(runA2Plan.slots.map((slot) => slot.runId)).not.toEqual(
        runAPlan.slots.map((slot) => slot.runId),
      );
      expect(runA2Plan.slots.map((slot) => slot.instanceId)).not.toEqual(
        runAPlan.slots.map((slot) => slot.instanceId),
      );
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('records a thrown first launch as started, interrupted, and permanently non-creditable', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      let launches = 0;
      const run = await runRelease(
        { manifestFile: state.draftFile },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification,
            runCandidate: async () => {
              launches += 1;
              throw new Error('interrupted');
            },
          },
        },
      );
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', releaseCreditGranted: false, outcomes: [{ outcome: null }] },
      });
      expect(launches).toBe(1);
      if (!run.ok) return;
      const verified = verifyReleaseRun(state.root, run.value.runId, {
        dependencies: { ...state.dependencies, verifyQualification },
      });
      expect(verified).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', releaseCreditGranted: false },
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('stops allocating after a child fails evidence verification', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      let launches = 0;
      const run = await runRelease(
        { manifestFile: state.draftFile },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification,
            runCandidate: async ({ preparedCandidate, runId }) => {
              launches += 1;
              state.candidates.set(runId, preparedCandidate);
              return buildCliResult({
                command: 'diagnostic',
                status: 'PASS',
                outcome: 'PASS',
                detail: 'fixture',
                details: null,
              });
            },
            readAndVerifyChild: () => ({
              valid: false,
              recordDigest: null,
              evidenceDigest: null,
              outcome: null,
              cleanupVerified: false,
              evidenceVerified: false,
              code: 'EVIDENCE_INVALID',
            }),
          },
        },
      );
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', releaseCreditGranted: false, outcomes: [{ outcome: null }] },
      });
      expect(launches).toBe(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('records a thrown child reader as an interrupted slot with the remaining work explicit', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      let launches = 0;
      const run = await runRelease(
        { manifestFile: state.draftFile },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification,
            runCandidate: async ({ preparedCandidate, runId }) => {
              launches += 1;
              state.candidates.set(runId, preparedCandidate);
              return buildCliResult({
                command: 'diagnostic',
                status: 'PASS',
                outcome: 'PASS',
                detail: 'fixture',
                details: null,
              });
            },
            readAndVerifyChild: () => {
              throw new Error('child evidence reader stopped');
            },
          },
        },
      );
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', releaseCreditGranted: false, outcomes: [{ outcome: null }] },
      });
      expect(launches).toBe(1);
      if (!run.ok) return;
      const verified = verifyReleaseRun(state.root, run.value.runId, {
        dependencies: {
          ...state.dependencies,
          verifyQualification,
          readAndVerifyChild: () => {
            throw new Error('unstarted child reader must not run');
          },
        },
      });
      expect(verified).toMatchObject({
        ok: true,
        value: {
          state: 'INTERRUPTED',
          releaseCreditGranted: false,
          workCount: state.draft.content.entries.length,
        },
      });
      const records = readReleaseLedger(state.root, run.value.runId);
      expect(records.at(-1)?.event).toMatchObject({
        type: 'run-assessed',
        state: 'INTERRUPTED',
        releaseCreditGranted: false,
        unstartedOrders: state.draft.content.entries.slice(1).map((_, index) => index + 1),
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it.each([
    'BUG',
    'HARNESS_BLOCKED',
    'ENVIRONMENT_FAILURE',
  ] as const)('preserves %s and executes every later approved slot exactly once without credit', async (outcome) => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        {
          dependencies: { ...state.dependencies, verifyQualification },
        },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      let launches = 0;
      const runtimeDependencies = {
        ...state.dependencies,
        verifyQualification,
        runCandidate: async ({
          preparedCandidate,
          runId,
        }: {
          preparedCandidate: PreparedExecutionCandidate;
          expectedIdentity: PreparedExecutionCandidate['identity'];
          runId: string;
        }) => {
          launches += 1;
          state.candidates.set(runId, preparedCandidate);
          return buildCliResult({
            command: 'diagnostic',
            status: outcome,
            outcome,
            detail: 'non-pass fixture',
            details: null,
          });
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          const candidate = state.candidates.get(runId);
          if (!candidate)
            return {
              valid: false,
              recordDigest: null,
              evidenceDigest: null,
              outcome: null,
              cleanupVerified: false,
              evidenceVerified: false,
              code: 'CHILD_RECORD_INVALID',
            };
          return {
            valid: true,
            recordDigest: sha256Hex(`record:${runId}`),
            evidenceDigest: sha256Hex(`evidence:${runId}`),
            outcome,
            cleanupVerified: true,
            evidenceVerified: true,
            code: null,
            runId,
            caseId: candidate.identity.caseId,
            materializationFingerprint: candidate.identity.materializationFingerprint,
            planFingerprint: candidate.identity.planFingerprint,
            cellId: candidate.identity.cellId,
            profile: 'release',
            provenance: 'manifest',
            evidenceDepth: 'standard',
          };
        },
      };
      const run = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: runtimeDependencies },
      );
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'NON_CREDITABLE', releaseCreditGranted: false },
      });
      expect(launches).toBe(state.draft.content.entries.length);
      if (!run.ok) return;
      expect(run.value.outcomes.every((item) => item.outcome === outcome)).toBe(true);
      const verified = verifyReleaseRun(state.root, run.value.runId, {
        dependencies: runtimeDependencies,
      });
      expect(verified).toMatchObject({
        ok: true,
        value: { state: 'NON_CREDITABLE', releaseCreditGranted: false },
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses a Release run before any allocation when the default budget authority is absent', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      const runRoot = path.join(state.root, 'evidence/governance/release-runs');
      const absentProvider = await runRelease(
        { manifestFile: state.draftFile },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification,
            resolveBudgetPreflight: undefined,
          },
        },
      );
      expect(absentProvider).toEqual({ ok: false, code: 'BUDGET_PREFLIGHT_REFUSED' });
      expect(existsSync(runRoot)).toBe(false);
      // A caller-supplied locator reference alone is never authority.
      const referenceOnly = await runRelease(
        { manifestFile: state.draftFile },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification,
            resolveBudgetPreflight: undefined,
            budgetPolicyApprovalId: SYNTHETIC_POLICY_ID,
          },
        },
      );
      expect(referenceOnly).toEqual({ ok: false, code: 'BUDGET_PREFLIGHT_REFUSED' });
      expect(existsSync(runRoot)).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses failed, mismatched and throwing budget preflights before any allocation', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      const runRoot = path.join(state.root, 'evidence/governance/release-runs');
      const refusal = { ok: false as const, code: 'BUDGET_POLICY_INVALID' as const };
      const mismatchedBinding: ReleaseRuntimeDependencies['resolveBudgetPreflight'] = (input) => {
        const base = syntheticBudgetPreflight(input);
        if (!base.ok) return base;
        return { ok: true, value: { ...base.value, manifestId: 'not-the-governed-manifest' } };
      };
      const cases: readonly ReleaseRuntimeDependencies['resolveBudgetPreflight'][] = [
        () => refusal,
        mismatchedBinding,
        () => {
          throw new Error('preflight provider stopped');
        },
      ];
      for (const resolveBudgetPreflight of cases) {
        const run = await runRelease(
          { manifestFile: state.draftFile },
          { dependencies: { ...state.dependencies, verifyQualification, resolveBudgetPreflight } },
        );
        expect(run).toEqual({ ok: false, code: 'BUDGET_PREFLIGHT_REFUSED' });
        expect(existsSync(runRoot)).toBe(false);
      }
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('binds the exact verified policy and set digests into a V2 predeclaration after approval and Qualification', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      const order: string[] = [];
      const runRoot = path.join(state.root, 'evidence/governance/release-runs');
      const run = await runRelease(
        { manifestFile: state.draftFile },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification: (batchId: string) => {
              order.push('qualification');
              return verifyQualificationBatch(batchId, { dependencies: state.dependencies });
            },
            resolveBudgetPreflight: (input) => {
              order.push('budget-preflight');
              expect(existsSync(runRoot)).toBe(false);
              return syntheticBudgetPreflight(input);
            },
            runCandidate: async (input) => {
              order.push('launch');
              return state.dependencies.runCandidate(input);
            },
          },
        },
      );
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      expect(order[0]).toBe('qualification');
      expect(order[1]).toBe('budget-preflight');
      expect(order.filter((entry) => entry === 'budget-preflight')).toHaveLength(1);
      expect(order.indexOf('launch')).toBeGreaterThan(order.indexOf('budget-preflight'));
      const plan = readReleaseLedger(state.root, run.value.runId)[0];
      expect(plan?.schemaVersion).toBe(2);
      const event = plan?.event;
      if (!event || event.type !== 'run-predeclared' || !('budget' in event))
        throw new Error('missing bound V2 predeclaration');
      expect(event.budget).toMatchObject({
        releaseCredit: false,
        policyApprovalId: SYNTHETIC_POLICY_ID,
        policyDigest: SYNTHETIC_POLICY_DIGEST,
        measurementSetId: SYNTHETIC_SET_ID,
        measurementSetContentDigest: SYNTHETIC_SET_DIGEST,
        method: 'full-scope-envelope-v1',
        methodVersion: 1,
        manifestId: state.draft.manifestId,
        manifestFingerprint: state.draft.contentFingerprint,
        requiredCellId: state.draft.content.requiredCell.cellId,
        sourceProvenanceDigest: state.dependencies.collectSourceDigest(),
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('never lets a caller-forged shape-valid preflight gain credit in runRelease or verifyReleaseRun readback', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      // A hand-built result that passes every structural guard with arbitrary but
      // internally consistent digests the caller fully controls. Types and
      // SHA-256 formatting are shape, not trust.
      const forgedBudgetPreflight: ReleaseRuntimeDependencies['resolveBudgetPreflight'] = (
        input,
      ) => {
        const forgedSetDigest = sha256Hex('forged-set-bytes');
        return {
          ok: true,
          value: {
            releaseCredit: false,
            policyApprovalId: `budget-policy-${'a'.repeat(64)}`,
            policyDigest: sha256Hex('forged-policy-bytes'),
            approvalDigest: sha256Hex('forged-approval-bytes'),
            reviewDigest: sha256Hex('forged-review-bytes'),
            measurementSetId: `bset-${'b'.repeat(64)}`,
            measurementSetContentDigest: forgedSetDigest,
            method: 'full-scope-envelope-v1',
            methodVersion: 1,
            ceilings: {
              releaseDurationMs: 9_999_999,
              releaseEvidenceBytes: 9_999_999,
              qualificationDurationMs: 9_999_999,
              qualificationEvidenceBytes: 9_999_999,
              retainedEvidenceBytes: 9_999_999,
              imageTornRecaptures: null,
            },
            limitations: ['family:text:UNAVAILABLE'],
            manifestId: input.manifestId,
            manifestFingerprint: input.manifestFingerprint,
            requiredCellId: input.requiredCellId,
            sourceProvenanceDigest: input.sourceProvenanceDigest,
            basis: {
              measurementSetContentDigest: forgedSetDigest,
              retentionAuditId: 'retention-00000000-0000-0000-0000-000000000000',
              retentionAuditDigest: sha256Hex('forged-retention-bytes'),
            },
          },
        };
      };
      const run = await runRelease(
        { manifestFile: state.draftFile },
        {
          dependencies: {
            ...state.dependencies,
            verifyQualification,
            resolveBudgetPreflight: forgedBudgetPreflight,
          },
        },
      );
      // Ordering/V2 are still exercised (the forged result is admitted before
      // allocation and the full work list runs), but no credit is minted.
      expect(run).toMatchObject({
        ok: true,
        value: {
          state: 'COMPLETE_ALL_PASS',
          releaseCreditGranted: false,
          workCount: state.draft.content.entries.length,
        },
      });
      if (!run.ok) return;
      expect(run.value.outcomes.map((item) => item.outcome)).toEqual(
        state.draft.content.entries.map(() => 'PASS'),
      );
      const terminal = readReleaseLedger(state.root, run.value.runId).at(-1)?.event;
      expect(terminal).toMatchObject({
        type: 'run-assessed',
        state: 'COMPLETE_ALL_PASS',
        releaseCreditGranted: false,
      });
      const verified = verifyReleaseRun(state.root, run.value.runId, {
        dependencies: { ...state.dependencies, verifyQualification },
      });
      expect(verified).toMatchObject({
        ok: true,
        value: {
          state: 'COMPLETE_ALL_PASS',
          releaseCreditGranted: false,
          workCount: state.draft.content.entries.length,
        },
      });
      if (!verified.ok) return;
      expect(verified.value.outcomes.map((item) => item.outcome)).toEqual(
        state.draft.content.entries.map(() => 'PASS'),
      );
      // Terminal corroboration is read-only and materializes no authority/budget
      // state anywhere in the governed root.
      expect(existsSync(path.join(state.root, 'evidence/governance/budget'))).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses readback that persists a forged credit flag and never derives credit from it', async () => {
    const state = fixture();
    try {
      await runQualificationBatch(state.prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      const authority = authorAuthority(state);
      const verifyQualification = (batchId: string) =>
        verifyQualificationBatch(batchId, { dependencies: state.dependencies });
      const activation = activateRelease(
        {
          manifestFile: state.draftFile,
          batchId: state.prepared.batch.batchId,
          approvalId: authority.approval.approvalId,
        },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(activation.ok).toBe(true);
      if (!activation.ok) return;
      const run = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      // An attacker who can rewrite the ledger flips the persisted consistency
      // flag while keeping the V2 record structurally valid. Readback must not
      // trust it: it recomputes independently rooted credit and refuses.
      rewriteReleaseLedger(
        state.root,
        run.value.runId,
        (event) => {
          event.releaseCreditGranted = true;
        },
        'last',
      );
      expect(
        verifyReleaseRun(state.root, run.value.runId, {
          dependencies: { ...state.dependencies, verifyQualification },
        }),
      ).toEqual({ ok: false, code: 'LEDGER_INVALID' });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});

describe('WP5-B remediation — ADR 0113 finite provisional endpoint and facts authority', () => {
  /** Synthetic-only ceiling override; never authority (ADR 0111). */
  function preflight(
    ceilings: Partial<BudgetPolicyCeilingsV1>,
  ): NonNullable<ReleaseRuntimeDependencies['resolveBudgetPreflight']> {
    return (input) => {
      const base = syntheticBudgetPreflight(input);
      if (!base.ok) return base;
      return {
        ok: true,
        value: { ...base.value, ceilings: { ...base.value.ceilings, ...ceilings } },
      };
    };
  }

  async function activatedState() {
    const state = fixture();
    await runQualificationBatch(state.prepared.batch.batchId, {
      dependencies: state.dependencies,
    });
    const authority = authorAuthority(state);
    const verifyQualification = (batchId: string) =>
      verifyQualificationBatch(batchId, { dependencies: state.dependencies });
    const activation = activateRelease(
      {
        manifestFile: state.draftFile,
        batchId: state.prepared.batch.batchId,
        approvalId: authority.approval.approvalId,
      },
      { dependencies: { ...state.dependencies, verifyQualification } },
    );
    if (!activation.ok) throw new Error(`activation failed: ${activation.code}`);
    return { state, verifyQualification };
  }

  /** Rewrites the whole V2 chain with freshly linked canonical digests. */
  function writeRunEventChain(
    root: string,
    runId: string,
    events: readonly Record<string, unknown>[],
  ): void {
    const directory = path.join(root, 'evidence/governance/release-runs', runId, 'events');
    const names = readdirSync(directory).sort();
    const template = JSON.parse(readFileSync(path.join(directory, names[0] as string), 'utf8')) as {
      schemaVersion: number;
    };
    for (const name of names) rmSync(path.join(directory, name));
    let previousDigest: string | null = null;
    events.forEach((event, index) => {
      const unsigned = {
        schemaVersion: template.schemaVersion,
        ledgerId: runId,
        sequence: index + 1,
        previousDigest,
        event,
      };
      const digest = sha256Hex(canonicalize(unsigned));
      writeFileSync(
        path.join(directory, `event-${String(index + 1).padStart(6, '0')}.json`),
        `${canonicalize({ ...unsigned, digest })}\n`,
      );
      previousDigest = digest;
    });
  }

  it('persists a pending provisional assessment before the charged endpoint sample (C5)', async () => {
    const { state, verifyQualification } = await activatedState();
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflight({ releaseDurationMs: 20 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
      // Simulate provisional append + strict readback waiting without touching the
      // filesystem globally: 8 slots × 2ms = 16ms, plus 10ms here ⇒ 26ms > 20ms.
      afterProvisionalReadback: () => {
        clock += 10;
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: {
          state: 'BUDGET_TERMINATED',
          releaseCreditGranted: false,
          budgetAuthority: 'NON_AUTHORITATIVE',
          workCount: state.draft.content.entries.length,
        },
      });
      if (!run.ok) return;
      const events = readReleaseLedger(state.root, run.value.runId).map((record) => record.event);
      const provisionalIndex = events.findIndex((event) => event.type === 'run-provisional');
      const terminalIndex = events.findIndex((event) => event.type === 'run-assessed');
      expect(provisionalIndex).toBeGreaterThan(-1);
      // Exactly one provisional immediately precedes the single final assessment.
      expect(terminalIndex).toBe(provisionalIndex + 1);
      expect(events.filter((event) => event.type === 'run-provisional')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'run-assessed')).toHaveLength(1);
      expect(events[provisionalIndex]).toMatchObject({
        type: 'run-provisional',
        completedOrders: [0, 1, 2, 3, 4, 5, 6, 7],
        unstartedOrders: [],
        pending: true,
        releaseCreditGranted: false,
      });
      const terminal = events[terminalIndex];
      // The endpoint sample (taken after provisional persistence/readback) is the
      // sole charged duration: 26ms, never the pre-provisional 16ms.
      expect(terminal?.type === 'run-assessed' ? terminal.timing?.elapsedMs : null).toBe(26);
      expect(terminal).toMatchObject({
        type: 'run-assessed',
        state: 'BUDGET_TERMINATED',
        unstartedOrders: [],
        releaseCreditGranted: false,
      });
      const readback = verifyReleaseRun(state.root, run.value.runId, { dependencies });
      expect(readback).toMatchObject({
        ok: true,
        value: {
          state: 'BUDGET_TERMINATED',
          releaseCreditGranted: false,
          budgetAuthority: 'NON_AUTHORITATIVE',
        },
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('uses the charged endpoint as the sole duration: equality passes while one millisecond over terminates (C5)', async () => {
    for (const [ceiling, expected] of [
      [26, 'COMPLETE_ALL_PASS'],
      [25, 'BUDGET_TERMINATED'],
    ] as const) {
      const { state, verifyQualification } = await activatedState();
      let clock = 0;
      const dependencies = {
        ...state.dependencies,
        verifyQualification,
        resolveBudgetPreflight: preflight({ releaseDurationMs: ceiling }),
        monotonicNow: () => clock,
        wallNow: () => '2026-09-26T12:00:00.000Z',
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          clock += 1;
          return state.dependencies.runCandidate(input);
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          clock += 1;
          return state.dependencies.readAndVerifyChild(runId);
        },
        afterProvisionalReadback: () => {
          clock += 10;
        },
      };
      try {
        const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
        expect(run).toMatchObject({
          ok: true,
          value: {
            state: expected,
            releaseCreditGranted: false,
            budgetAuthority: 'NON_AUTHORITATIVE',
          },
        });
        if (!run.ok) continue;
        const terminal = readReleaseLedger(state.root, run.value.runId).at(-1)?.event;
        expect(terminal?.type === 'run-assessed' ? terminal.timing?.elapsedMs : null).toBe(26);
      } finally {
        rmSync(state.root, { recursive: true, force: true });
      }
    }
  });

  it('fails closed without credit when the monotonic sample is invalid at the provisional boundary (C5)', async () => {
    const { state, verifyQualification } = await activatedState();
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflight({ releaseDurationMs: 1_000_000 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
      // A backwards/reset observation at the provisional boundary is a timing
      // refusal, never a duration of zero or a budget-stop pretext.
      afterProvisionalReadback: () => {
        clock -= 1;
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: {
          state: 'NON_CREDITABLE',
          releaseCreditGranted: false,
          budgetAuthority: 'NON_AUTHORITATIVE',
        },
      });
      if (!run.ok) return;
      const events = readReleaseLedger(state.root, run.value.runId).map((record) => record.event);
      expect(events.some((event) => event.type === 'run-provisional')).toBe(true);
      const terminal = events.at(-1);
      expect(terminal).toMatchObject({
        type: 'run-assessed',
        state: 'NON_CREDITABLE',
        timingFailureCode: 'TIMING_INVALID',
      });
      expect(terminal?.type === 'run-assessed' ? terminal.timing : undefined).toBeUndefined();
      // An invalid endpoint timing is never a creditable durable terminal.
      expect(verifyReleaseRun(state.root, run.value.runId, { dependencies }).ok).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses readback when the V2 provisional/final sequence is absent, duplicated or contradictory (C5)', async () => {
    const { state, verifyQualification } = await activatedState();
    const dependencies = { ...state.dependencies, verifyQualification };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({ ok: true, value: { state: 'COMPLETE_ALL_PASS' } });
      if (!run.ok) return;
      const readback = () => verifyReleaseRun(state.root, run.value.runId, { dependencies });
      expect(readback().ok).toBe(true);
      const events = readReleaseLedger(state.root, run.value.runId).map(
        (record) => record.event as unknown as Record<string, unknown>,
      );
      const provisionalIndex = events.findIndex((event) => event.type === 'run-provisional');
      expect(provisionalIndex).toBeGreaterThan(-1);
      const provisional = events[provisionalIndex] as Record<string, unknown>;
      // Absent provisional record: no exact V2 sequence ⇒ no durable terminal.
      writeRunEventChain(
        state.root,
        run.value.runId,
        events.filter((_, index) => index !== provisionalIndex),
      );
      expect(readback().ok).toBe(false);
      // Duplicated provisional record.
      writeRunEventChain(state.root, run.value.runId, [
        ...events.slice(0, provisionalIndex),
        provisional,
        provisional,
        ...events.slice(provisionalIndex + 1),
      ]);
      expect(readback().ok).toBe(false);
      // Contradictory suffix between the provisional and the final assessment.
      writeRunEventChain(
        state.root,
        run.value.runId,
        events.map((event, index) =>
          index === provisionalIndex ? { ...event, unstartedOrders: [99] } : event,
        ),
      );
      expect(readback().ok).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('never lets synthetic forged child budget facts yield an authoritative terminal (C6)', async () => {
    async function runWithFacts(
      ceilings: Partial<BudgetPolicyCeilingsV1>,
      evidenceByteCount: number,
    ) {
      const { state, verifyQualification } = await activatedState();
      let clock = 0;
      const dependencies = {
        ...state.dependencies,
        verifyQualification,
        resolveBudgetPreflight: preflight(ceilings),
        monotonicNow: () => clock,
        wallNow: () => '2026-09-26T12:00:00.000Z',
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          clock += 1;
          return state.dependencies.runCandidate(input);
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          clock += 1;
          return state.dependencies.readAndVerifyChild(runId);
        },
        // Caller-controlled forged facts: shape-valid but not root-bound.
        readChildBudgetFacts: () =>
          ({
            ok: true,
            value: { family: 'text', evidenceByteCount, imageTornRecaptures: null },
          }) as const,
      };
      try {
        const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
        const readback = run.ok
          ? verifyReleaseRun(state.root, run.value.runId, { dependencies })
          : null;
        return { state, run, readback };
      } finally {
        rmSync(state.root, { recursive: true, force: true });
      }
    }

    // Inflated forged facts force a stop-shaped transition, but it is never an
    // authoritative durable termination.
    const inflated = await runWithFacts({ releaseEvidenceBytes: 150 }, 1_000_000);
    expect(inflated.run).toMatchObject({
      ok: true,
      value: {
        state: 'BUDGET_TERMINATED',
        releaseCreditGranted: false,
        budgetAuthority: 'NON_AUTHORITATIVE',
      },
    });
    expect(inflated.readback).toMatchObject({
      ok: true,
      value: {
        state: 'BUDGET_TERMINATED',
        releaseCreditGranted: false,
        budgetAuthority: 'NON_AUTHORITATIVE',
      },
    });

    // Zeroed forged facts avoid a genuine ceiling: still non-authoritative and
    // never creditable, so a synthetic reader can neither force nor evade an
    // authoritative budget decision.
    const zeroed = await runWithFacts({ releaseEvidenceBytes: 0 }, 0);
    expect(zeroed.run).toMatchObject({
      ok: true,
      value: {
        state: 'COMPLETE_ALL_PASS',
        releaseCreditGranted: false,
        budgetAuthority: 'NON_AUTHORITATIVE',
      },
    });
    expect(zeroed.readback).toMatchObject({
      ok: true,
      value: { releaseCreditGranted: false, budgetAuthority: 'NON_AUTHORITATIVE' },
    });
  });
});

describe('WP5-C — independent V2 terminal readback and budget-state recomputation', () => {
  /** Synthetic-only ceiling override; never authority (ADR 0111/0113). */
  function preflight(
    ceilings: Partial<BudgetPolicyCeilingsV1>,
  ): NonNullable<ReleaseRuntimeDependencies['resolveBudgetPreflight']> {
    return (input) => {
      const base = syntheticBudgetPreflight(input);
      if (!base.ok) return base;
      return {
        ok: true,
        value: { ...base.value, ceilings: { ...base.value.ceilings, ...ceilings } },
      };
    };
  }

  async function activatedState() {
    const state = fixture();
    await runQualificationBatch(state.prepared.batch.batchId, {
      dependencies: state.dependencies,
    });
    const authority = authorAuthority(state);
    const verifyQualification = (batchId: string) =>
      verifyQualificationBatch(batchId, { dependencies: state.dependencies });
    const activation = activateRelease(
      {
        manifestFile: state.draftFile,
        batchId: state.prepared.batch.batchId,
        approvalId: authority.approval.approvalId,
      },
      { dependencies: { ...state.dependencies, verifyQualification } },
    );
    if (!activation.ok) throw new Error(`activation failed: ${activation.code}`);
    return { state, verifyQualification };
  }

  function eventsDirectory(root: string, runId: string): string {
    return path.join(root, 'evidence/governance/release-runs', runId, 'events');
  }

  /** Rewrites the whole chain with freshly linked canonical digests. */
  function writeRunEventChain(
    root: string,
    runId: string,
    events: readonly Record<string, unknown>[],
    version = 2,
  ): void {
    const directory = eventsDirectory(root, runId);
    for (const name of readdirSync(directory)) rmSync(path.join(directory, name));
    let previousDigest: string | null = null;
    events.forEach((event, index) => {
      const unsigned = {
        schemaVersion: version,
        ledgerId: runId,
        sequence: index + 1,
        previousDigest,
        event,
      };
      const digest = sha256Hex(canonicalize(unsigned));
      writeFileSync(
        path.join(directory, `event-${String(index + 1).padStart(6, '0')}.json`),
        `${canonicalize({ ...unsigned, digest })}\n`,
      );
      previousDigest = digest;
    });
  }

  function chainEvents(root: string, runId: string): Record<string, unknown>[] {
    return readReleaseLedger(root, runId).map(
      (record) => JSON.parse(JSON.stringify(record.event)) as Record<string, unknown>,
    );
  }

  /** Mutates the last terminal record's raw bytes but keeps its stale digest. */
  function tamperTerminalRaw(
    root: string,
    runId: string,
    mutate: (event: Record<string, unknown>) => void,
  ): void {
    const directory = eventsDirectory(root, runId);
    const names = readdirSync(directory).sort();
    const file = path.join(directory, names[names.length - 1] as string);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    mutate(record.event as Record<string, unknown>);
    writeFileSync(file, `${canonicalize(record)}\n`);
  }

  /** Rebuilds a self-consistent governance timing with a chosen elapsed value. */
  function retimed(timing: Record<string, unknown>, elapsedMs: number): Record<string, unknown> {
    const unsigned = {
      schemaVersion: timing.schemaVersion,
      method: timing.method,
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
      elapsedMs,
    };
    return {
      ...unsigned,
      measurementDigest: sha256Hex(
        `makeit.verify-artwork-editor/governance-timing/v1\n${canonicalize(unsigned)}`,
      ),
    };
  }

  /** Downgrades a produced V2 run chain to its V1 shape (no budget/provisional). */
  function downgradeToV1(root: string, runId: string): Record<string, unknown>[] {
    const events = chainEvents(root, runId)
      .filter((event) => event.type !== 'run-provisional')
      .map((event) => {
        if (event.type === 'run-predeclared') {
          const { budget: _budget, ...rest } = event;
          return rest;
        }
        return event;
      });
    writeRunEventChain(root, runId, events, 1);
    return events;
  }

  it('independently rederives terminal state and counters and refuses an inconsistent state or duration (C9)', async () => {
    const { state, verifyQualification } = await activatedState();
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflight({
        releaseDurationMs: 1_000_000,
        releaseEvidenceBytes: 500,
        imageTornRecaptures: 10,
      }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        return state.dependencies.readAndVerifyChild(runId);
      },
      readChildBudgetFacts: () =>
        ({
          ok: true,
          value: { family: 'text', evidenceByteCount: 10, imageTornRecaptures: 1 },
        }) as const,
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      const runId = run.value.runId;
      const readback = () => verifyReleaseRun(state.root, runId, { dependencies });
      const verified = readback();
      expect(verified).toMatchObject({
        ok: true,
        value: {
          state: 'COMPLETE_ALL_PASS',
          releaseCreditGranted: false,
          budgetAuthority: 'NON_AUTHORITATIVE',
          budgetRederivation: {
            state: 'COMPLETE_ALL_PASS',
            evidenceByteCount: 80,
            evidenceByteCeiling: 500,
            imageTornRecaptures: 8,
            imageTornCeiling: 10,
            ceilingExceeded: false,
            credit: false,
            budgetAuthority: 'NON_AUTHORITATIVE',
          },
        },
      });
      const terminal = readReleaseLedger(state.root, runId).at(-1)?.event;
      // The derived duration is the persisted bound endpoint timing, never a wall
      // delta or per-slot sum.
      if (verified.ok)
        expect(verified.value.budgetRederivation?.elapsedMs).toBe(
          terminal?.type === 'run-assessed' ? terminal.timing?.elapsedMs : undefined,
        );
      const original = chainEvents(state.root, runId);
      // (a) A re-signed state flip with no real crossing never stands.
      writeRunEventChain(
        state.root,
        runId,
        original.map((event, index) =>
          index === original.length - 1 ? { ...event, state: 'BUDGET_TERMINATED' } : event,
        ),
      );
      expect(readback()).toEqual({ ok: false, code: 'LEDGER_INVALID' });
      // (b) A re-signed forged endpoint above the ceiling while the recorded state
      // stays COMPLETE refuses on the derived/recorded mismatch.
      writeRunEventChain(
        state.root,
        runId,
        original.map((event, index) =>
          index === original.length - 1
            ? { ...event, timing: retimed(event.timing as Record<string, unknown>, 1_000_001) }
            : event,
        ),
      );
      expect(readback()).toEqual({ ok: false, code: 'LEDGER_INVALID' });
      // (c) A forged endpoint above the ceiling *with* the matching derived state is
      // accepted only as a NON_AUTHORITATIVE termination, never credit.
      writeRunEventChain(
        state.root,
        runId,
        original.map((event, index) =>
          index === original.length - 1
            ? {
                ...event,
                state: 'BUDGET_TERMINATED',
                timing: retimed(event.timing as Record<string, unknown>, 1_000_001),
              }
            : event,
        ),
      );
      expect(readback()).toMatchObject({
        ok: true,
        value: {
          state: 'BUDGET_TERMINATED',
          releaseCreditGranted: false,
          budgetAuthority: 'NON_AUTHORITATIVE',
          budgetRederivation: {
            state: 'BUDGET_TERMINATED',
            ceilingExceeded: true,
            credit: false,
          },
        },
      });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('rederives cumulative strict evidence bytes and refuses altered counters (C9)', async () => {
    const runWithFacts = async (
      runBytes: number,
      readBytes: number,
      ceilings: Partial<BudgetPolicyCeilingsV1>,
    ) => {
      const { state, verifyQualification } = await activatedState();
      let clock = 0;
      const base = {
        ...state.dependencies,
        verifyQualification,
        resolveBudgetPreflight: preflight(ceilings),
        monotonicNow: () => clock,
        wallNow: () => '2026-09-26T12:00:00.000Z',
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          clock += 1;
          return state.dependencies.runCandidate(input);
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          clock += 1;
          return state.dependencies.readAndVerifyChild(runId);
        },
      };
      const facts = (bytes: number) =>
        ({
          ok: true,
          value: { family: 'text', evidenceByteCount: bytes, imageTornRecaptures: null },
        }) as const;
      try {
        const run = await runRelease(
          { manifestFile: state.draftFile },
          { dependencies: { ...base, readChildBudgetFacts: () => facts(runBytes) } },
        );
        const readback = run.ok
          ? verifyReleaseRun(state.root, run.value.runId, {
              dependencies: { ...base, readChildBudgetFacts: () => facts(readBytes) },
            })
          : null;
        return { run, readback };
      } finally {
        rmSync(state.root, { recursive: true, force: true });
      }
    };

    // Zero run-time bytes complete the manifest; a re-read large total is refused
    // because it contradicts the recorded terminal rather than being trusted.
    const complete = await runWithFacts(0, 1_000_000, { releaseEvidenceBytes: 150 });
    expect(complete.run).toMatchObject({
      ok: true,
      value: { state: 'COMPLETE_ALL_PASS', releaseCreditGranted: false },
    });
    expect(complete.readback).toEqual({ ok: false, code: 'LEDGER_INVALID' });

    // A real byte-ceiling crossing is rederived from the strictly re-read facts;
    // zeroing the counters afterwards can no longer evade the recorded stop.
    const terminated = await runWithFacts(100, 0, { releaseEvidenceBytes: 150 });
    expect(terminated.run).toMatchObject({
      ok: true,
      value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
    });
    expect(terminated.readback).toEqual({ ok: false, code: 'LEDGER_INVALID' });

    // Consistent re-read facts rederive the exact crossing and counter total.
    const consistent = await runWithFacts(100, 100, { releaseEvidenceBytes: 150 });
    expect(consistent.readback).toMatchObject({
      ok: true,
      value: {
        state: 'BUDGET_TERMINATED',
        releaseCreditGranted: false,
        budgetRederivation: {
          state: 'BUDGET_TERMINATED',
          evidenceByteCount: 200,
          evidenceByteCeiling: 150,
          ceilingExceeded: true,
        },
      },
    });
  });

  it('rederives the Image tear total from strict child facts and refuses an altered counter (C9)', async () => {
    const runWithTorn = async (runTorn: number, readTorn: number) => {
      const { state, verifyQualification } = await activatedState();
      let clock = 0;
      const base = {
        ...state.dependencies,
        verifyQualification,
        resolveBudgetPreflight: preflight({ imageTornRecaptures: 5 }),
        monotonicNow: () => clock,
        wallNow: () => '2026-09-26T12:00:00.000Z',
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          clock += 1;
          return state.dependencies.runCandidate(input);
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          clock += 1;
          return state.dependencies.readAndVerifyChild(runId);
        },
      };
      const facts = (torn: number) =>
        ({
          ok: true,
          value: { family: 'image', evidenceByteCount: 1, imageTornRecaptures: torn },
        }) as const;
      try {
        const run = await runRelease(
          { manifestFile: state.draftFile },
          { dependencies: { ...base, readChildBudgetFacts: () => facts(runTorn) } },
        );
        const readback = run.ok
          ? verifyReleaseRun(state.root, run.value.runId, {
              dependencies: { ...base, readChildBudgetFacts: () => facts(readTorn) },
            })
          : null;
        return { run, readback };
      } finally {
        rmSync(state.root, { recursive: true, force: true });
      }
    };

    const consistent = await runWithTorn(3, 3);
    expect(consistent.run).toMatchObject({
      ok: true,
      value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
    });
    expect(consistent.readback).toMatchObject({
      ok: true,
      value: {
        state: 'BUDGET_TERMINATED',
        releaseCreditGranted: false,
        budgetRederivation: {
          state: 'BUDGET_TERMINATED',
          imageTornRecaptures: 6,
          imageTornCeiling: 5,
          ceilingExceeded: true,
        },
      },
    });

    const altered = await runWithTorn(3, 0);
    expect(altered.run).toMatchObject({
      ok: true,
      value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
    });
    expect(altered.readback).toEqual({ ok: false, code: 'LEDGER_INVALID' });
  });

  it('refuses any raw terminal V2 field or digest tamper and any unknown ledger version (C9/C10)', async () => {
    const { state, verifyQualification } = await activatedState();
    try {
      const run = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: { ...state.dependencies, verifyQualification } },
      );
      expect(run).toMatchObject({ ok: true, value: { state: 'COMPLETE_ALL_PASS' } });
      if (!run.ok) return;
      const runId = run.value.runId;
      const readback = () =>
        verifyReleaseRun(state.root, runId, {
          dependencies: { ...state.dependencies, verifyQualification },
        });
      expect(readback().ok).toBe(true);
      const directory = eventsDirectory(state.root, runId);
      const names = readdirSync(directory).sort();
      const terminalFile = path.join(directory, names[names.length - 1] as string);
      const originalBytes = readFileSync(terminalFile, 'utf8');
      const mutations: ((event: Record<string, unknown>) => void)[] = [
        (event) => {
          event.state = 'INTERRUPTED';
        },
        (event) => {
          event.state = 'BUDGET_TERMINATED';
        },
        (event) => {
          event.unstartedOrders = [1, 2, 3, 4, 5, 6, 7];
        },
        (event) => {
          event.releaseCreditGranted = true;
        },
        (event) => {
          delete event.timing;
        },
        (event) => {
          event.timingFailureCode = 'TIMING_INVALID';
        },
        (event) => {
          (event.timing as Record<string, unknown>).elapsedMs = 42;
        },
      ];
      for (const mutate of mutations) {
        writeFileSync(terminalFile, originalBytes);
        tamperTerminalRaw(state.root, runId, mutate);
        expect(readback()).toEqual({ ok: false, code: 'LEDGER_INVALID' });
      }
      writeFileSync(terminalFile, originalBytes);
      expect(readback().ok).toBe(true);
      // An unknown/future ledger version fails closed rather than reading it.
      writeRunEventChain(state.root, runId, chainEvents(state.root, runId), 3);
      expect(readback()).toEqual({ ok: false, code: 'LEDGER_INVALID' });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('keeps a retained V1 run readable yet never budget-authorized (C10)', async () => {
    // A NON_CREDITABLE run (one BUG slot) downgraded to the closed V1 shape stays
    // readable but cannot derive credit or a V2 budget ceiling.
    const bugState = await activatedState();
    try {
      const { state, verifyQualification } = bugState;
      const runtimeDependencies = {
        ...state.dependencies,
        verifyQualification,
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          state.candidates.set(input.runId, input.preparedCandidate);
          return buildCliResult({
            command: 'diagnostic',
            status: 'BUG',
            outcome: 'BUG',
            detail: 'non-pass fixture',
            details: null,
          });
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          const candidate = state.candidates.get(runId);
          if (!candidate)
            return {
              valid: false,
              recordDigest: null,
              evidenceDigest: null,
              outcome: null,
              cleanupVerified: false,
              evidenceVerified: false,
              code: 'CHILD_RECORD_INVALID',
            };
          return {
            valid: true,
            recordDigest: sha256Hex(`record:${runId}`),
            evidenceDigest: sha256Hex(`evidence:${runId}`),
            outcome: 'BUG',
            cleanupVerified: true,
            evidenceVerified: true,
            code: null,
            runId,
            caseId: candidate.identity.caseId,
            materializationFingerprint: candidate.identity.materializationFingerprint,
            planFingerprint: candidate.identity.planFingerprint,
            cellId: candidate.identity.cellId,
            profile: 'release',
            provenance: 'manifest',
            evidenceDepth: 'standard',
          };
        },
      };
      const run = await runRelease(
        { manifestFile: state.draftFile },
        { dependencies: runtimeDependencies },
      );
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'NON_CREDITABLE', releaseCreditGranted: false },
      });
      if (!run.ok) return;
      const runId = run.value.runId;
      downgradeToV1(state.root, runId);
      const readback = verifyReleaseRun(state.root, runId, { dependencies: runtimeDependencies });
      expect(readback).toMatchObject({
        ok: true,
        value: {
          state: 'NON_CREDITABLE',
          releaseCreditGranted: false,
          budgetAuthority: 'NON_AUTHORITATIVE',
        },
      });
      if (readback.ok) expect(readback.value.budgetRederivation?.durationCeilingMs).toBeNull();
    } finally {
      rmSync(bugState.state.root, { recursive: true, force: true });
    }

    // A V1-shaped COMPLETE record whose persisted credit flag is true can never be
    // rederived into budget-authorized credit.
    const completeState = await activatedState();
    try {
      const { state, verifyQualification } = completeState;
      const dependencies = { ...state.dependencies, verifyQualification };
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({ ok: true, value: { state: 'COMPLETE_ALL_PASS' } });
      if (!run.ok) return;
      const runId = run.value.runId;
      const events = downgradeToV1(state.root, runId);
      writeRunEventChain(
        state.root,
        runId,
        events.map((event, index) =>
          index === events.length - 1 ? { ...event, releaseCreditGranted: true } : event,
        ),
        1,
      );
      expect(verifyReleaseRun(state.root, runId, { dependencies })).toEqual({
        ok: false,
        code: 'LEDGER_INVALID',
      });
    } finally {
      rmSync(completeState.state.root, { recursive: true, force: true });
    }
  });

  it('records an exact-once preflight→slots→provisional→final order and refuses a mid-run append failure (C11)', async () => {
    // Cleanup-overrun termination: the started child is completed and cleaned up
    // exactly once, then no later slot is allocated.
    const overrunState = await activatedState();
    try {
      const { state, verifyQualification } = overrunState;
      const launched: string[] = [];
      let clock = 0;
      const dependencies = {
        ...state.dependencies,
        verifyQualification,
        resolveBudgetPreflight: preflight({ releaseDurationMs: 25 }),
        monotonicNow: () => clock,
        wallNow: () => '2026-09-26T12:00:00.000Z',
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          launched.push(input.runId);
          clock += 1;
          return state.dependencies.runCandidate(input);
        },
        // Strict evidence reread plus owned cleanup verification dominate slot time.
        readAndVerifyChild: (runId: string): VerifiedChild => {
          clock += 30;
          return state.dependencies.readAndVerifyChild(runId);
        },
      };
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'BUDGET_TERMINATED', releaseCreditGranted: false },
      });
      expect(launched).toHaveLength(1);
      if (!run.ok) return;
      const records = readReleaseLedger(state.root, run.value.runId);
      expect(records.map((record) => record.event.type)).toEqual([
        'run-predeclared',
        'run-started',
        'slot-started',
        'slot-finished',
        'run-provisional',
        'run-assessed',
      ]);
      expect(records.filter((record) => record.event.type === 'run-provisional')).toHaveLength(1);
      expect(records.filter((record) => record.event.type === 'run-assessed')).toHaveLength(1);
      const startedOrders = records
        .map((record) => record.event)
        .filter((event) => event.type === 'slot-started')
        .map((event) => (event.type === 'slot-started' ? event.order : -1));
      expect(startedOrders).toEqual([0]);
      expect(verifyReleaseRun(state.root, run.value.runId, { dependencies })).toMatchObject({
        ok: true,
        value: {
          state: 'BUDGET_TERMINATED',
          releaseCreditGranted: false,
          budgetRederivation: {
            state: 'BUDGET_TERMINATED',
            durationCeilingMs: 25,
            ceilingExceeded: true,
            credit: false,
          },
        },
      });
    } finally {
      rmSync(overrunState.state.root, { recursive: true, force: true });
    }

    // An append/readback failure after the started child fails closed: no fabricated
    // terminal is written and the prior durable events are preserved.
    const appendState = await activatedState();
    try {
      const { state, verifyQualification } = appendState;
      const launched: string[] = [];
      let clock = 0;
      const runsRoot = path.join(state.root, 'evidence/governance/release-runs');
      const dependencies = {
        ...state.dependencies,
        verifyQualification,
        resolveBudgetPreflight: preflight({}),
        monotonicNow: () => clock,
        wallNow: () => '2026-09-26T12:00:00.000Z',
        runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
          launched.push(input.runId);
          clock += 1;
          // Inject an out-of-sequence durable record so the next append/readback
          // refuses; the tampered record is removed afterwards to inspect history.
          const runDirs = readdirSync(runsRoot);
          expect(runDirs).toHaveLength(1);
          writeFileSync(
            path.join(runsRoot, runDirs[0] as string, 'events', 'event-000099.json'),
            '{"tampered":true}\n',
          );
          return state.dependencies.runCandidate(input);
        },
        readAndVerifyChild: (runId: string): VerifiedChild => {
          clock += 1;
          return state.dependencies.readAndVerifyChild(runId);
        },
      };
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toEqual({ ok: false, code: 'LEDGER_INVALID' });
      expect(launched).toHaveLength(1);
      const runDirs = readdirSync(runsRoot);
      expect(runDirs).toHaveLength(1);
      const eventsDir = eventsDirectory(state.root, runDirs[0] as string);
      rmSync(path.join(eventsDir, 'event-000099.json'));
      const preserved = readReleaseLedger(state.root, runDirs[0] as string).map(
        (record) => record.event.type,
      );
      expect(preserved).toEqual(['run-predeclared', 'run-started', 'slot-started']);
      expect(preserved).not.toContain('run-assessed');
      expect(preserved).not.toContain('run-provisional');
    } finally {
      rmSync(appendState.state.root, { recursive: true, force: true });
    }
  });

  it('treats an incomplete owned cleanup as an integrity stop, never a budget termination (C11)', async () => {
    const { state, verifyQualification } = await activatedState();
    const launched: string[] = [];
    let clock = 0;
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      resolveBudgetPreflight: preflight({ releaseDurationMs: 1_000_000 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        launched.push(input.runId);
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      // The child runs, but its owned cleanup is not verified complete.
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 1;
        const child = state.dependencies.readAndVerifyChild(runId);
        return { ...child, cleanupVerified: false };
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      expect(run).toMatchObject({
        ok: true,
        value: { state: 'INTERRUPTED', releaseCreditGranted: false },
      });
      expect(launched).toHaveLength(1);
      if (!run.ok) return;
      const terminal = readReleaseLedger(state.root, run.value.runId).at(-1)?.event;
      expect(terminal?.type === 'run-assessed' ? terminal.state : null).not.toBe(
        'BUDGET_TERMINATED',
      );
      expect(terminal).toMatchObject({ type: 'run-assessed', state: 'INTERRUPTED' });
      // No credit and no claim of a durable successful/terminated completion.
      expect(verifyReleaseRun(state.root, run.value.runId, { dependencies }).ok).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  const TERMINAL_STAGE_ORDER: readonly TerminalPersistenceStage[] = [
    'before-provisional-append',
    'before-provisional-reread',
    'before-final-append',
    'before-final-reread',
  ];

  /**
   * Deterministically provokes one terminal-stage append/readback refusal by
   * injecting exactly at the named seam stage. The injected bytes grant no
   * authority: they only make the runtime's own strict append/reread refuse.
   * Returns the observable durable state for the boundary under test.
   */
  async function runTerminalBoundaryFailure(stage: TerminalPersistenceStage) {
    const { state, verifyQualification } = await activatedState();
    const runsRoot = path.join(state.root, 'evidence/governance/release-runs');
    const injectedFile = 'event-000099.json';
    const launched: string[] = [];
    const stagesSeen: TerminalPersistenceStage[] = [];
    // Append boundaries inject an out-of-sequence record; reread boundaries stale-rewrite
    // the just-appended record in place. Neither path is ever rewritten by the runtime.
    const mechanism =
      stage === 'before-provisional-append' || stage === 'before-final-append'
        ? 'append'
        : 'reread';
    let clock = 0;
    const capture: {
      snapshot: {
        readonly names: readonly string[];
        readonly bytes: readonly string[];
        readonly lock: string;
      } | null;
    } = { snapshot: null };
    const dependencies = {
      ...state.dependencies,
      verifyQualification,
      // A small ceiling terminates after the one started child so every boundary is
      // reached with a fast, deterministic run.
      resolveBudgetPreflight: preflight({ releaseDurationMs: 25 }),
      monotonicNow: () => clock,
      wallNow: () => '2026-09-26T12:00:00.000Z',
      runCandidate: async (input: Parameters<typeof state.dependencies.runCandidate>[0]) => {
        launched.push(input.runId);
        clock += 1;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId: string): VerifiedChild => {
        clock += 30;
        return state.dependencies.readAndVerifyChild(runId);
      },
      terminalPersistenceSeam: (seen: TerminalPersistenceStage) => {
        stagesSeen.push(seen);
        if (seen !== stage || capture.snapshot) return;
        const runId = readdirSync(runsRoot)[0] as string;
        const directory = eventsDirectory(state.root, runId);
        const names = readdirSync(directory).sort();
        capture.snapshot = {
          names,
          bytes: names.map((name) => readFileSync(path.join(directory, name), 'utf8')),
          lock: readFileSync(path.join(runsRoot, runId, 'run-once.lock'), 'utf8'),
        };
        if (mechanism === 'append') {
          // An out-of-sequence durable record makes the next strict append refuse.
          writeFileSync(path.join(directory, injectedFile), '{"tampered":true}\n');
        } else {
          // A stale-digest rewrite of the just-appended record makes the next strict
          // reread refuse while leaving the record file durably in place.
          const target = path.join(directory, names[names.length - 1] as string);
          const record = JSON.parse(readFileSync(target, 'utf8')) as {
            event: Record<string, unknown>;
          };
          record.event.unstartedOrders = [];
          writeFileSync(target, `${canonicalize(record)}\n`);
        }
      },
    };
    try {
      const run = await runRelease({ manifestFile: state.draftFile }, { dependencies });
      const runDirs = readdirSync(runsRoot);
      expect(runDirs).toHaveLength(1);
      const runId = runDirs[0] as string;
      const directory = eventsDirectory(state.root, runId);
      const after = readdirSync(directory).sort();
      // A sanitized refusal is returned; no ReleaseRunResult or durable-success claim exists.
      expect(run).toEqual({ ok: false, code: 'LEDGER_INVALID' });
      expect(stagesSeen).toEqual(
        TERMINAL_STAGE_ORDER.slice(0, TERMINAL_STAGE_ORDER.indexOf(stage) + 1),
      );
      expect(launched).toHaveLength(1);
      if (!capture.snapshot) throw new Error('terminal seam was not reached');
      const captured = capture.snapshot;
      // The started child's durable claim is preserved and never re-minted (no retry).
      expect(readFileSync(path.join(runsRoot, runId, 'run-once.lock'), 'utf8')).toBe(captured.lock);
      // Every pre-existing append-only event is byte-identical: no historical overwrite.
      for (let index = 0; index < captured.names.length; index += 1) {
        const last = index === captured.names.length - 1;
        if (mechanism === 'reread' && last) continue;
        expect(readFileSync(path.join(directory, captured.names[index] as string), 'utf8')).toBe(
          captured.bytes[index],
        );
      }
      // The independently confirming readback refuses the incomplete/unconfirmed chain.
      const readbackRefused = verifyReleaseRun(state.root, runId, { dependencies }).ok === false;
      expect(readbackRefused).toBe(true);
      const rawEvents = after
        .filter((name) => name !== injectedFile)
        .map(
          (name) =>
            JSON.parse(readFileSync(path.join(directory, name), 'utf8')).event as { type: string },
        );
      return {
        run,
        stagesSeen,
        launched,
        mechanism,
        injectedExtraFile: after.includes(injectedFile),
        preservedTypes: rawEvents.map((event) => event.type),
        finalRecordPending: rawEvents.at(-1)?.type === 'run-provisional',
        terminalPresent: rawEvents.some((event) => event.type === 'run-assessed'),
      };
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  }

  it('refuses a provisional append failure with the durable prefix preserved and no terminal (C11)', async () => {
    const outcome = await runTerminalBoundaryFailure('before-provisional-append');
    expect(outcome.stagesSeen).toEqual(['before-provisional-append']);
    expect(outcome.mechanism).toBe('append');
    expect(outcome.injectedExtraFile).toBe(true);
    expect(outcome.preservedTypes).toEqual([
      'run-predeclared',
      'run-started',
      'slot-started',
      'slot-finished',
    ]);
    expect(outcome.terminalPresent).toBe(false);
  });

  it('refuses a provisional strict reread failure over a durably appended pending record (C11)', async () => {
    const outcome = await runTerminalBoundaryFailure('before-provisional-reread');
    expect(outcome.stagesSeen).toEqual(['before-provisional-append', 'before-provisional-reread']);
    expect(outcome.mechanism).toBe('reread');
    expect(outcome.injectedExtraFile).toBe(false);
    expect(outcome.preservedTypes).toEqual([
      'run-predeclared',
      'run-started',
      'slot-started',
      'slot-finished',
      'run-provisional',
    ]);
    // The pending provisional is durable but non-credit and never a terminal.
    expect(outcome.finalRecordPending).toBe(true);
    expect(outcome.terminalPresent).toBe(false);
  });

  it('refuses a final append failure with the provisional preserved and no terminal (C11)', async () => {
    const outcome = await runTerminalBoundaryFailure('before-final-append');
    expect(outcome.stagesSeen).toEqual([
      'before-provisional-append',
      'before-provisional-reread',
      'before-final-append',
    ]);
    expect(outcome.mechanism).toBe('append');
    expect(outcome.injectedExtraFile).toBe(true);
    expect(outcome.preservedTypes).toEqual([
      'run-predeclared',
      'run-started',
      'slot-started',
      'slot-finished',
      'run-provisional',
    ]);
    expect(outcome.terminalPresent).toBe(false);
  });

  it('refuses a final confirming reread failure and never accepts the unconfirmed terminal (C11)', async () => {
    const outcome = await runTerminalBoundaryFailure('before-final-reread');
    expect(outcome.stagesSeen).toEqual(TERMINAL_STAGE_ORDER);
    expect(outcome.mechanism).toBe('reread');
    expect(outcome.injectedExtraFile).toBe(false);
    expect(outcome.preservedTypes).toEqual([
      'run-predeclared',
      'run-started',
      'slot-started',
      'slot-finished',
      'run-provisional',
      'run-assessed',
    ]);
    // The final append is durable but its confirming reread failed: the chain stays
    // unconfirmed (readback refused) and grants no credit or durable-success claim.
    expect(outcome.terminalPresent).toBe(true);
    expect(outcome.run).toEqual({ ok: false, code: 'LEDGER_INVALID' });
  });
});
