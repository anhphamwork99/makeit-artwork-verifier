import { describe, expect, it } from 'vitest';

import * as qualificationContract from '../../src/contracts/qualification';
import type {
  QualificationBatch,
  QualificationInstanceResult,
} from '../../src/contracts/qualification';
import * as qualificationGovernance from '../../src/governance/qualification';
import {
  createQualificationBatch,
  evaluateQualificationBatch,
} from '../../src/governance/qualification';

const CANDIDATE = { manifestId: 'manifest-1', contentFingerprint: 'a'.repeat(64) };

function batchOf(requiredCells: readonly string[] = ['desktop', 'mobile']): QualificationBatch {
  const creation = createQualificationBatch(CANDIDATE, requiredCells);
  expect(creation.valid).toBe(true);
  expect(creation.releaseCredit).toBe(false);
  return creation.batch!;
}

function instancesOf(batch: QualificationBatch) {
  return batch.cells.flatMap((cell) => cell.instances);
}

function passResults(batch: QualificationBatch): QualificationInstanceResult[] {
  return instancesOf(batch).map((instance) => ({
    instanceId: instance.instanceId,
    cellId: instance.cellId,
    order: instance.order,
    outcome: 'PASS',
  }));
}

describe('Gate-G static qualification preparation (never grants credit)', () => {
  it('freezes exactly three independently identified instances per required cell', () => {
    const batch = batchOf(['desktop', 'mobile']);
    expect(batch.cells.map((cell) => cell.cellId)).toEqual(['desktop', 'mobile']);
    for (const cell of batch.cells) {
      expect(cell.instances).toHaveLength(3);
      expect(cell.instances.map((instance) => instance.order)).toEqual([0, 1, 2]);
    }
    const ids = instancesOf(batch).map((instance) => instance.instanceId);
    expect(new Set(ids).size).toBe(ids.length);
    // Set-like cell membership is normalized, so authoring order does not drift identity.
    expect(createQualificationBatch(CANDIDATE, ['mobile', 'desktop']).batch?.batchFingerprint).toBe(
      batch.batchFingerprint,
    );
    expect(
      createQualificationBatch({ ...CANDIDATE, contentFingerprint: 'b'.repeat(64) }, [
        'desktop',
        'mobile',
      ]).batch?.batchFingerprint,
    ).not.toBe(batch.batchFingerprint);
    // The frozen batch cannot be edited after allocation, before any result exists.
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.cells)).toBe(true);
    expect(Object.isFrozen(batch.cells[0]!.instances)).toBe(true);
    expect(Object.isFrozen(batch.cells[0]!.instances[0]!)).toBe(true);
    expect(Reflect.set(batch, 'batchFingerprint', 'changed')).toBe(false);
    expect(batch.batchFingerprint).toBe(batchOf(['desktop', 'mobile']).batchFingerprint);
  });

  it('exposes no append, filter, or retry-to-green surface', () => {
    expect(Object.keys(qualificationGovernance).sort()).toEqual([
      'createQualificationBatch',
      'evaluateQualificationBatch',
    ]);
    expect(Object.keys(qualificationContract).sort()).toEqual([
      'QUALIFICATION_INSTANCES_PER_CELL',
      'QUALIFICATION_ISSUE_CODES',
      'QUALIFICATION_OUTCOMES',
      'QUALIFICATION_SCHEMA_VERSION',
    ]);
  });

  it('admits a complete exact-set all-PASS batch without granting credit', () => {
    const batch = batchOf();
    expect(evaluateQualificationBatch(batch, passResults(batch))).toEqual({
      admitted: true,
      issues: [],
      releaseCredit: false,
    });
  });

  it('denies missing, duplicate, extra, reordered, and non-PASS results', () => {
    const batch = batchOf();
    const complete = passResults(batch);

    const missing = complete.slice(0, -1);
    expect(evaluateQualificationBatch(batch, missing).issues).toContain('QUALIFICATION_MISSING');

    const duplicated = [...complete, complete[0]!];
    expect(evaluateQualificationBatch(batch, duplicated).issues).toContain(
      'QUALIFICATION_DUPLICATE',
    );

    const extra = [
      ...complete,
      { instanceId: 'unknown-instance', cellId: 'desktop', order: 0, outcome: 'PASS' },
    ];
    expect(evaluateQualificationBatch(batch, extra).issues).toContain('QUALIFICATION_EXTRA');

    const reordered = [complete[1]!, complete[0]!, ...complete.slice(2)];
    expect(evaluateQualificationBatch(batch, reordered).issues).toContain('QUALIFICATION_ORDER');

    const nonPass = [{ ...complete[0]!, outcome: 'BUG' }, ...complete.slice(1)];
    expect(evaluateQualificationBatch(batch, nonPass).issues).toContain('QUALIFICATION_RESULT');

    for (const results of [missing, duplicated, extra, reordered, nonPass]) {
      const evaluation = evaluateQualificationBatch(batch, results);
      expect(evaluation.admitted).toBe(false);
      expect(evaluation.releaseCredit).toBe(false);
    }
  });

  it('fails closed without mutating the batch and without throwing', () => {
    const batch = batchOf(['desktop']);
    const before = JSON.stringify(batch);
    const evaluation = evaluateQualificationBatch(batch, passResults(batch));
    expect(evaluation.releaseCredit).toBe(false);
    expect(JSON.stringify(batch)).toBe(before);

    expect(() => evaluateQualificationBatch(batch, null)).not.toThrow();
    expect(evaluateQualificationBatch(batch, null).issues).toContain('QUALIFICATION_RESULTS_SHAPE');

    expect(
      evaluateQualificationBatch({ ...batch, batchFingerprint: 'c'.repeat(64) }, passResults(batch))
        .issues,
    ).toContain('QUALIFICATION_BATCH_IDENTITY');

    const invalidCandidate = createQualificationBatch({ ...CANDIDATE, extra: 'surprise' }, [
      'desktop',
    ]);
    expect(invalidCandidate).toEqual({
      valid: false,
      batch: null,
      issues: ['QUALIFICATION_CANDIDATE'],
      releaseCredit: false,
    });
    expect(createQualificationBatch(CANDIDATE, []).issues).toContain('QUALIFICATION_CELLS');
    expect(createQualificationBatch(CANDIDATE, ['desktop', 'desktop']).issues).toContain(
      'QUALIFICATION_CELLS',
    );
    expect(createQualificationBatch(CANDIDATE, 'desktop').issues).toContain('QUALIFICATION_CELLS');
    expect(() => createQualificationBatch(null, null)).not.toThrow();
  });
});
