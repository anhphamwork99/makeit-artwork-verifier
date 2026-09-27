import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const evidenceControl = vi.hoisted(() => ({
  creditEligible: true,
  strictRecordPresent: true,
  currentTreeCheck: 'PASS' as 'PASS' | 'DRIFT',
  currentTreeCreditEligible: true,
}));

vi.mock('../../src/evidence/integrity', () => ({
  verifyEvidenceRoot: () => ({
    transaction: {
      creditEligible: evidenceControl.creditEligible,
      strictRecordPresent: evidenceControl.strictRecordPresent,
    },
    provenance: {
      currentTreeCheck: evidenceControl.currentTreeCheck,
      currentTreeCreditEligible: evidenceControl.currentTreeCreditEligible,
    },
    checks: [{ result: 'PASS' }],
  }),
  createCurrentTreeProvenanceProvider: () => () => ({
    currentTreeCheck: evidenceControl.currentTreeCheck,
  }),
  createNodeEvidenceVerifyFsAdapter: () => ({}),
}));

import { readAndVerifyDiagnosticChild } from '../../src/governance/qualification-runtime';
import { readFinalPublicRecord } from '../../src/contracts/final-public-record';

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../integration/fixtures/p8b/committed-run/run-record.json',
);
const tempRoots: string[] = [];

function temporaryRoots(): { skillRoot: string; repoRoot: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'governance-child-reader-'));
  tempRoots.push(root);
  const canonicalRoot = realpathSync(root);
  const repoRoot = path.join(canonicalRoot, 'repo');
  const skillRoot = path.join(repoRoot, '.pi', 'skills', 'verify-artwork-editor');
  mkdirSync(skillRoot, { recursive: true });
  return { skillRoot, repoRoot };
}

function releaseRecord(runId: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  value.runId = runId;
  value.profile = 'release';
  value.provenance = 'manifest';
  value.evidenceDepth = 'standard';
  value.environmentCellId = 'cell:chromium-desktop-v1';
  value.cleanup = {
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
  const ownership = value.ownership as Record<string, unknown>;
  ownership.runId = runId;
  return value;
}

function writeRecord(skillRoot: string, directoryRunId: string, record: unknown): string {
  const runRoot = path.join(skillRoot, 'evidence', 'runs', directoryRunId);
  mkdirSync(runRoot, { recursive: true });
  const recordPath = path.join(runRoot, 'run-record.json');
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return recordPath;
}

function read(skillRoot: string, runId: string, repoRoot: string) {
  return readAndVerifyDiagnosticChild(skillRoot, runId, repoRoot);
}

function resetEvidenceControl(): void {
  evidenceControl.creditEligible = true;
  evidenceControl.strictRecordPresent = true;
  evidenceControl.currentTreeCheck = 'PASS';
  evidenceControl.currentTreeCreditEligible = true;
}

afterEach(() => {
  resetEvidenceControl();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared actual-file Diagnostic child reader', () => {
  it('reads a strict current-v4 Release/manifest/standard record with complete cleanup', () => {
    const { skillRoot, repoRoot } = temporaryRoots();
    const runId = 'release-child-valid-001';
    const record = releaseRecord(runId);
    expect(readFinalPublicRecord(record).kind).toBe('current-v4');
    const recordPath = writeRecord(skillRoot, runId, record);
    expect(
      readFinalPublicRecord(JSON.parse(readFileSync(recordPath, 'utf8')) as unknown).kind,
    ).toBe('current-v4');

    const result = read(skillRoot, runId, repoRoot);
    expect(result).toMatchObject({
      valid: true,
      runId,
      caseId: 'layer-text-move',
      materializationFingerprint: 'a1'.repeat(32),
      planFingerprint: 'b2'.repeat(32),
      cellId: 'cell:chromium-desktop-v1',
      profile: 'release',
      provenance: 'manifest',
      evidenceDepth: 'standard',
      outcome: 'PASS',
      cleanupVerified: true,
      evidenceVerified: true,
      code: null,
    });
    expect(result.recordDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses malformed and legacy records through the actual strict reader', () => {
    const { skillRoot, repoRoot } = temporaryRoots();
    const malformedId = 'release-child-malformed';
    const malformedPath = writeRecord(skillRoot, malformedId, {});
    writeFileSync(malformedPath, '{broken json');
    expect(read(skillRoot, malformedId, repoRoot)).toMatchObject({
      valid: false,
      code: 'CHILD_RECORD_INVALID',
    });

    const legacyId = 'release-child-legacy';
    writeRecord(skillRoot, legacyId, { schemaVersion: 1, command: 'diagnostic', runId: legacyId });
    expect(read(skillRoot, legacyId, repoRoot)).toMatchObject({
      valid: false,
      code: 'CHILD_RECORD_INVALID',
    });
  });

  it('rejects a record whose embedded run id differs from its owned directory/request', () => {
    const { skillRoot, repoRoot } = temporaryRoots();
    const requestedId = 'release-child-requested';
    const record = releaseRecord(requestedId);
    record.runId = 'release-child-other';
    expect(readFinalPublicRecord(record).kind).toBe('current-v4');
    writeRecord(skillRoot, requestedId, record);
    expect(read(skillRoot, requestedId, repoRoot)).toMatchObject({
      valid: false,
      code: 'CHILD_RECORD_INVALID',
    });
  });

  it.each([
    ['profile', 'diagnostic'],
    ['provenance', 'diagnostic-request'],
    ['evidenceDepth', 'deep'],
  ])('rejects a strict record with wrong %s identity', (field, wrongValue) => {
    const { skillRoot, repoRoot } = temporaryRoots();
    const runId = `release-child-wrong-${field}`;
    const record = releaseRecord(runId);
    record[field] = wrongValue;
    expect(readFinalPublicRecord(record).kind).toBe('current-v4');
    writeRecord(skillRoot, runId, record);
    expect(read(skillRoot, runId, repoRoot)).toMatchObject({
      valid: false,
      code: 'CHILD_RECORD_INVALID',
    });
  });

  it('reports incomplete cleanup without treating passing evidence as sufficient', () => {
    const { skillRoot, repoRoot } = temporaryRoots();
    const runId = 'release-child-cleanup-fail';
    const record = releaseRecord(runId);
    (record.cleanup as Record<string, unknown>).complete = false;
    writeRecord(skillRoot, runId, record);
    expect(read(skillRoot, runId, repoRoot)).toMatchObject({
      valid: false,
      cleanupVerified: false,
      evidenceVerified: true,
      code: 'CLEANUP_INVALID',
    });
  });

  it.each([
    [
      'ineligible transaction',
      () => {
        evidenceControl.creditEligible = false;
      },
    ],
    [
      'missing strict record',
      () => {
        evidenceControl.strictRecordPresent = false;
      },
    ],
    [
      'current-tree drift',
      () => {
        evidenceControl.currentTreeCheck = 'DRIFT';
      },
    ],
    [
      'ineligible current-tree result',
      () => {
        evidenceControl.currentTreeCreditEligible = false;
      },
    ],
  ])('refuses evidence verifier result with %s', (_label, setFailure) => {
    const { skillRoot, repoRoot } = temporaryRoots();
    const runId = `release-child-evidence-${_label.replaceAll(' ', '-')}`;
    writeRecord(skillRoot, runId, releaseRecord(runId));
    setFailure();
    expect(read(skillRoot, runId, repoRoot)).toMatchObject({
      valid: false,
      cleanupVerified: true,
      evidenceVerified: false,
      code: 'EVIDENCE_INVALID',
    });
  });

  it('refuses no-follow symlink and multiply-linked record paths', () => {
    const { skillRoot, repoRoot } = temporaryRoots();
    const symlinkId = 'release-child-symlink';
    const symlinkPath = writeRecord(skillRoot, symlinkId, releaseRecord(symlinkId));
    const targetPath = `${symlinkPath}.target`;
    rmSync(symlinkPath);
    writeFileSync(targetPath, JSON.stringify(releaseRecord(symlinkId)), { mode: 0o600 });
    symlinkSync(targetPath, symlinkPath);
    expect(read(skillRoot, symlinkId, repoRoot)).toMatchObject({
      valid: false,
      code: 'CHILD_RECORD_INVALID',
    });

    const hardlinkId = 'release-child-hardlink';
    const hardlinkPath = writeRecord(skillRoot, hardlinkId, releaseRecord(hardlinkId));
    linkSync(hardlinkPath, `${hardlinkPath}.extra`);
    expect(lstatSync(hardlinkPath).nlink).toBe(2);
    expect(read(skillRoot, hardlinkId, repoRoot)).toMatchObject({
      valid: false,
      code: 'CHILD_RECORD_INVALID',
    });
  });
});
