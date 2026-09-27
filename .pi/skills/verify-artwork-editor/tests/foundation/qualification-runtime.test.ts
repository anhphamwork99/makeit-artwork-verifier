import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalize, sha256Hex } from '../../src/canonical/canonicalize';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type { ExecutableManifestValidationContext } from '../../src/contracts/executable-selection-manifest';
import { buildCliResult } from '../../src/cli/output';
import {
  compilePreparedExecutionCandidate,
  type PreparedExecutionCandidate,
} from '../../src/cli/diagnostic';
import { normalizeCaseRequest } from '../../src/planner/normalize-intent';
import { generateExecutableSelectionManifest } from '../../src/governance/executable-selection-manifest';
import {
  prepareQualificationBatch,
  runQualificationBatch,
  verifyQualificationBatch,
  type QualificationRuntimeDependencies,
  type VerifiedChild,
} from '../../src/governance/qualification-runtime';
import { readQualificationLedger } from '../../src/governance/qualification-ledger';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { resolveSkillRoot } from '../../src/runtime/paths';

function context(): ExecutableManifestValidationContext {
  const root = resolveSkillRoot();
  const environmentCatalogue = loadEnvironmentCatalogue({ rootDir: root });
  const requestTemplates = resolveSuiteRequests(
    loadDiagnosticSuite('representative', { rootDir: root }),
  ).map((member) => {
    const normalized = normalizeCaseRequest(member.request);
    if (!normalized.ok) throw new Error('invalid representative request');
    return {
      templateId: path.basename(member.relativePath, '.json'),
      subjectId: normalized.request.intent.subjectId,
      capability: normalized.request.intent.capability,
      scenarioId: normalized.request.intent.scenario,
      intent: normalized.request.intent,
    };
  });
  return {
    catalogues: loadCatalogueBundle({ rootDir: root }),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates,
  };
}

function fixture() {
  const current = context();
  const generated = generateExecutableSelectionManifest(current);
  if (generated.status !== 'GENERATED_DRAFT') throw new Error('manifest generation failed');
  const root = realpathSync(
    mkdtempSync(path.join(realpathSync(tmpdir()), 'qualification-foundation-')),
  );
  const children = new Map<string, PreparedExecutionCandidate>();
  let source = 'a'.repeat(64);
  let outcome: 'PASS' | 'BUG' = 'PASS';
  let interrupted = false;
  let mismatchIdentity = false;
  const dependencies: QualificationRuntimeDependencies = {
    skillRoot: root,
    repoRoot: root,
    loadContext: () => current,
    compileCandidate: compilePreparedExecutionCandidate,
    runCandidate: async ({ preparedCandidate, runId }) => {
      children.set(runId, preparedCandidate);
      if (interrupted) throw new Error('interrupted');
      return buildCliResult({
        command: 'diagnostic',
        status: outcome,
        outcome,
        detail: 'test result',
        details: null,
      });
    },
    collectSourceDigest: () => source,
    readAndVerifyChild: (runId): VerifiedChild => {
      const candidate = children.get(runId);
      if (!candidate)
        return {
          valid: false,
          recordDigest: null,
          outcome: null,
          cleanupVerified: false,
          evidenceVerified: false,
          code: 'CHILD_RECORD_INVALID',
        };
      return {
        valid: true,
        recordDigest: 'b'.repeat(64),
        evidenceDigest: 'c'.repeat(64),
        outcome,
        cleanupVerified: true,
        evidenceVerified: true,
        code: null,
        runId,
        caseId: mismatchIdentity ? 'wrong-case' : candidate.identity.caseId,
        materializationFingerprint: candidate.identity.materializationFingerprint,
        planFingerprint: candidate.identity.planFingerprint,
        cellId: candidate.identity.cellId,
        profile: 'release',
        provenance: 'manifest',
        evidenceDepth: 'standard',
      };
    },
    makeId: randomUUID,
  };
  return {
    draft: generated.draft,
    root,
    dependencies,
    setSource: (next: string) => {
      source = next;
    },
    setOutcome: (next: 'PASS' | 'BUG') => {
      outcome = next;
    },
    setInterrupted: (next: boolean) => {
      interrupted = next;
    },
    setIdentityMismatch: (next: boolean) => {
      mismatchIdentity = next;
    },
  };
}

function removeQualificationTimings(root: string, batchId: string): void {
  const eventsDir = path.join(
    root,
    'evidence/governance/qualification-authority/batches',
    batchId,
    'events',
  );
  const names = readdirSync(eventsDir).sort();
  let previousDigest: string | null = null;
  for (let index = 0; index < names.length; index += 1) {
    const file = path.join(eventsDir, names[index] as string);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const event = record.event as Record<string, unknown>;
    if (event.type === 'instance-finished' || event.type === 'batch-assessed') delete event.timing;
    const unsigned = {
      schemaVersion: record.schemaVersion,
      batchId: record.batchId,
      sequence: index + 1,
      previousDigest,
      event,
    };
    const digest = sha256Hex(canonicalize(unsigned));
    writeFileSync(file, `${canonicalize({ ...unsigned, digest })}\n`);
    previousDigest = digest;
  }
}

describe('executable Qualification runtime', () => {
  it('measures each attempt through strict child verification using monotonic time', async () => {
    const state = fixture();
    let elapsedClock = 0;
    let wallSecond = 0;
    const dependencies: QualificationRuntimeDependencies = {
      ...state.dependencies,
      monotonicNow: () => elapsedClock,
      wallNow: () => {
        wallSecond += 1;
        return new Date(Date.UTC(2026, 8, 26, 10) - wallSecond * 60_000).toISOString();
      },
      runCandidate: async (input) => {
        elapsedClock += 11;
        return state.dependencies.runCandidate(input);
      },
      readAndVerifyChild: (runId) => {
        const child = state.dependencies.readAndVerifyChild(runId);
        elapsedClock += 7;
        return child;
      },
    };
    try {
      const batch = prepareQualificationBatch(
        {
          draft: state.draft,
          entryIds: state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId),
          selectionRationale: 'Fixed representative sample for timing verification.',
        },
        { dependencies: state.dependencies },
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      const result = await runQualificationBatch(batch.batch.batchId, { dependencies });
      expect(result?.state).toBe('REVIEW_READY');
      const records = readQualificationLedger(state.root, batch.batch.batchId);
      const finished = records
        .map((record) => record.event)
        .filter((event) => event.type === 'instance-finished');
      const assessed = records.at(-1)?.event;
      expect(finished).toHaveLength(3);
      expect(
        finished.map((event) => event.type === 'instance-finished' && event.timing?.elapsedMs),
      ).toEqual([18, 18, 18]);
      expect(assessed?.type === 'batch-assessed' ? assessed.timing?.elapsedMs : null).toBe(54);
      expect(assessed?.type === 'batch-assessed' ? assessed.timing?.startedAt : '').toBe(
        '2026-09-26T09:59:00.000Z',
      );
      expect(assessed?.type === 'batch-assessed' ? assessed.timing?.endedAt : '').toBe(
        '2026-09-26T09:52:00.000Z',
      );
      expect(verifyQualificationBatch(batch.batch.batchId, { dependencies }).ok).toBe(true);
      removeQualificationTimings(state.root, batch.batch.batchId);
      expect(verifyQualificationBatch(batch.batch.batchId, { dependencies }).ok).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('preserves the child outcome but fails qualification when a slot clock resets', async () => {
    const state = fixture();
    const values = [100, 110, 100, 200];
    const dependencies: QualificationRuntimeDependencies = {
      ...state.dependencies,
      monotonicNow: () => values.shift() ?? 200,
      wallNow: () => '2026-09-26T10:00:00.000Z',
    };
    try {
      const batch = prepareQualificationBatch(
        {
          draft: state.draft,
          entryIds: state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId),
          selectionRationale: 'Fixed representative sample for reset-clock refusal.',
        },
        { dependencies: state.dependencies },
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      const result = await runQualificationBatch(batch.batch.batchId, { dependencies });
      expect(result).toMatchObject({ state: 'FAILED', failureCode: 'TIMING_INVALID' });
      expect(result?.attempts[0]).toMatchObject({ outcome: 'PASS', failureCode: 'TIMING_INVALID' });
      const terminal = readQualificationLedger(state.root, batch.batch.batchId).at(-1)?.event;
      expect(terminal).toMatchObject({
        type: 'batch-assessed',
        state: 'FAILED',
        failureCode: 'TIMING_INVALID',
      });
      expect(verifyQualificationBatch(batch.batch.batchId, { dependencies }).ok).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('keeps a missing-batch ledger lookup read-only', () => {
    const state = fixture();
    try {
      expect(() => readQualificationLedger(state.root, `qbatch-${randomUUID()}`)).toThrow();
      expect(existsSync(path.join(state.root, 'evidence'))).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('predeclares three distinct manifest entries in caller order and runs each once to review readiness', async () => {
    const state = fixture();
    try {
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        {
          draft: state.draft,
          entryIds,
          selectionRationale: 'Distinct bindings provide representative admission evidence.',
        },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      expect(prepared.batch.selectedEntryIds).toEqual(entryIds);
      expect(prepared.batch.slots.map((slot) => slot.ordinal)).toEqual([1, 2, 3]);
      expect(prepared.batch.slots.map((slot) => slot.entryId)).toEqual(entryIds);
      const ledger = readQualificationLedger(state.root, prepared.batch.batchId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.event.type).toBe('batch-predeclared');

      const result = await runQualificationBatch(prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      expect(result?.state).toBe('REVIEW_READY');
      expect(result?.attempts).toHaveLength(3);
      expect(
        result?.attempts.every(
          (attempt) =>
            attempt.outcome === 'PASS' && attempt.evidenceVerified && attempt.cleanupVerified,
        ),
      ).toBe(true);
      expect(result?.releaseCredit).toBe(false);
      const finalLedger = readQualificationLedger(state.root, prepared.batch.batchId);
      expect(finalLedger.at(-1)?.event).toMatchObject({
        type: 'batch-assessed',
        state: 'REVIEW_READY',
        completedAttemptCount: 3,
        releaseCredit: false,
      });
      expect(
        await runQualificationBatch(prepared.batch.batchId, { dependencies: state.dependencies }),
      ).toBeNull();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate or missing entries before creating authority bytes', () => {
    const state = fixture();
    try {
      const duplicate = state.draft.content.entries[0]?.entryId ?? '';
      expect(
        prepareQualificationBatch(
          {
            draft: state.draft,
            entryIds: [duplicate, duplicate, duplicate],
            selectionRationale: 'No duplicates.',
          },
          { dependencies: state.dependencies },
        ),
      ).toMatchObject({ ok: false, code: 'ENTRY_SELECTION_INVALID' });
      expect(
        existsSync(path.join(state.root, 'evidence', 'governance', 'qualification-authority')),
      ).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('permanently consumes a batch when source provenance drifts before the first attempt', async () => {
    const state = fixture();
    try {
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        { draft: state.draft, entryIds, selectionRationale: 'Frozen source state.' },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      state.setSource('c'.repeat(64));
      const result = await runQualificationBatch(prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      expect(result).toMatchObject({ state: 'FAILED', failureCode: 'SOURCE_DRIFT', attempts: [] });
      const records = readQualificationLedger(state.root, prepared.batch.batchId);
      expect(records.at(-1)?.event).toMatchObject({
        type: 'batch-assessed',
        state: 'FAILED',
        failureCode: 'SOURCE_DRIFT',
      });
      expect(records[1]?.event.type).toBe('batch-started');
      expect(
        existsSync(
          path.join(
            state.root,
            'evidence',
            'governance',
            'qualification-authority',
            'batches',
            prepared.batch.batchId,
            'run-once.lock',
          ),
        ),
      ).toBe(true);
      state.setSource('a'.repeat(64));
      expect(
        await runQualificationBatch(prepared.batch.batchId, { dependencies: state.dependencies }),
      ).toBeNull();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses a changed event record before any execution', async () => {
    const state = fixture();
    try {
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        { draft: state.draft, entryIds, selectionRationale: 'Integrity check.' },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      const eventPath = path.join(
        state.root,
        'evidence',
        'governance',
        'qualification-authority',
        'batches',
        prepared.batch.batchId,
        'events',
        'event-000001.json',
      );
      const event = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
      event.digest = '0'.repeat(64);
      writeFileSync(eventPath, canonicalize(event));
      expect(
        await runQualificationBatch(prepared.batch.batchId, { dependencies: state.dependencies }),
      ).toBeNull();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('rejects an event record with an unknown top-level key even when its known fields are valid', () => {
    const state = fixture();
    try {
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        { draft: state.draft, entryIds, selectionRationale: 'Closed ledger records.' },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      const eventPath = path.join(
        state.root,
        'evidence',
        'governance',
        'qualification-authority',
        'batches',
        prepared.batch.batchId,
        'events',
        'event-000001.json',
      );
      const record = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
      record.unrecognized = 'not covered by the record digest';
      writeFileSync(eventPath, canonicalize(record));

      expect(() => readQualificationLedger(state.root, prepared.batch.batchId)).toThrow();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('refuses a rehashed structurally malformed batch before claiming or appending', async () => {
    const state = fixture();
    try {
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        { draft: state.draft, entryIds, selectionRationale: 'Malformed batches must not start.' },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      const eventPath = path.join(
        state.root,
        'evidence',
        'governance',
        'qualification-authority',
        'batches',
        prepared.batch.batchId,
        'events',
        'event-000001.json',
      );
      const record = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
      const event = record.event as {
        batch: {
          batchFingerprint: string;
          slots: Array<{ runId: string }>;
        };
      };
      const firstSlot = event.batch.slots[0];
      if (!firstSlot) throw new Error('fixture slot missing');
      firstSlot.runId = '../unsafe-run';
      const { batchFingerprint: _previousBatchFingerprint, ...fingerprintedBatch } = event.batch;
      event.batch.batchFingerprint = sha256Hex(canonicalize(fingerprintedBatch));
      const { digest: _oldDigest, ...unsigned } = record;
      record.digest = sha256Hex(canonicalize(unsigned));
      writeFileSync(eventPath, canonicalize(record));
      const result = await runQualificationBatch(prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      expect(result).toBeNull();
      expect(readQualificationLedger(state.root, prepared.batch.batchId)).toHaveLength(1);
      expect(
        existsSync(
          path.join(
            state.root,
            'evidence',
            'governance',
            'qualification-authority',
            'batches',
            prepared.batch.batchId,
            'run-once.lock',
          ),
        ),
      ).toBe(false);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('records a real child BUG and refuses any rerun', async () => {
    const state = fixture();
    try {
      state.setOutcome('BUG');
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        { draft: state.draft, entryIds, selectionRationale: 'No retry after a product failure.' },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      const result = await runQualificationBatch(prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      expect(result).toMatchObject({ state: 'FAILED', failureCode: 'CHILD_OUTCOME_NON_PASS' });
      expect(result?.attempts[0]?.outcome).toBe('BUG');
      expect(result?.attempts).toHaveLength(1);
      expect(
        await runQualificationBatch(prepared.batch.batchId, { dependencies: state.dependencies }),
      ).toBeNull();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('marks a child identity mismatch failed even when its record and evidence otherwise verify', async () => {
    const state = fixture();
    try {
      state.setIdentityMismatch(true);
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        {
          draft: state.draft,
          entryIds,
          selectionRationale: 'Child record must agree with the frozen slot.',
        },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      const result = await runQualificationBatch(prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      expect(result).toMatchObject({ state: 'FAILED', failureCode: 'CHILD_RECORD_INVALID' });
      expect(result?.attempts[0]?.evidenceVerified).toBe(true);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('records interruption and never resumes remaining slots', async () => {
    const state = fixture();
    try {
      state.setInterrupted(true);
      const entryIds = state.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
      const prepared = prepareQualificationBatch(
        {
          draft: state.draft,
          entryIds,
          selectionRationale: 'Interrupted batches remain fixed and failed.',
        },
        { dependencies: state.dependencies },
      );
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) return;
      const result = await runQualificationBatch(prepared.batch.batchId, {
        dependencies: state.dependencies,
      });
      expect(result).toMatchObject({
        state: 'INTERRUPTED',
        failureCode: 'EXECUTION_INTERRUPTED',
        attempts: [{ outcome: null }],
      });
      const ledger = readQualificationLedger(state.root, prepared.batch.batchId);
      expect(ledger.at(-1)?.event).toMatchObject({
        type: 'batch-assessed',
        state: 'INTERRUPTED',
        completedAttemptCount: 1,
      });
      expect(
        await runQualificationBatch(prepared.batch.batchId, { dependencies: state.dependencies }),
      ).toBeNull();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
