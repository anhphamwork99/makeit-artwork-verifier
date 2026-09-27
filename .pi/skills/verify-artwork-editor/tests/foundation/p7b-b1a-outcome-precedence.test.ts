import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STATUS_OUTCOME_PRECEDENCE,
  classifyBehaviorOutcome,
  classifyFinalOutcome,
  classifyStatusOutcome,
  statusNonPassIsBlocking,
  statusNonPassMeaning,
} from '../../src/index';

/**
 * P7-B B1-A pure status-derived classifier tests (ADR 0025 §4, ADR 0028 §3).
 *
 * These tests pin the complete outcome precedence over the closed three-state
 * check vocabulary, prove that `FAIL + UNUSABLE` follows the binding
 * `HARNESS_BLOCKED` precedence, and prove cleanup/external failure cannot erase
 * the separately preserved behavior outcome. After the E3-S2 source switch the
 * retained boolean `CheckResult` type, the historical v3 marker, and the
 * boolean classifier are asserted as retained off-path surfaces, and the active
 * record-writer authority is asserted to be the strict-v4 final writer.
 */

const PASSING = [{ checkId: 'geometry.delta', status: 'PASS' as const }];
const FAILING = [{ checkId: 'geometry.delta', status: 'FAIL' as const }];
const UNUSABLE = [{ checkId: 'geometry.delta', status: 'UNUSABLE' as const }];

describe('[P7-B B1-A] status-derived behavior outcome', () => {
  it('classifies every check PASS with agreeing sources as PASS', () => {
    expect(classifyBehaviorOutcome({ requiredChecks: PASSING, requiredSourcesAgree: true })).toBe(
      'PASS',
    );
  });

  it('classifies a trustworthy FAIL as BUG', () => {
    expect(classifyBehaviorOutcome({ requiredChecks: FAILING })).toBe('BUG');
  });

  it('classifies UNUSABLE authority as HARNESS_BLOCKED', () => {
    expect(classifyBehaviorOutcome({ requiredChecks: UNUSABLE })).toBe('HARNESS_BLOCKED');
  });

  it('classifies required-source disagreement with interpretable evidence as BUG', () => {
    expect(classifyBehaviorOutcome({ requiredChecks: PASSING, requiredSourcesAgree: false })).toBe(
      'BUG',
    );
  });

  it('gives FAIL + UNUSABLE the binding HARNESS_BLOCKED precedence', () => {
    expect(classifyBehaviorOutcome({ requiredChecks: [...FAILING, ...UNUSABLE] })).toBe(
      'HARNESS_BLOCKED',
    );
    expect(classifyBehaviorOutcome({ requiredChecks: [...UNUSABLE, ...FAILING] })).toBe(
      'HARNESS_BLOCKED',
    );
  });

  it('refuses to grant PASS without any required check', () => {
    expect(classifyBehaviorOutcome({ requiredChecks: [] })).toBe('HARNESS_BLOCKED');
  });

  it('fails closed on a missing or unknown status rather than defaulting', () => {
    expect(classifyBehaviorOutcome({ requiredChecks: [{ checkId: 'a', status: undefined }] })).toBe(
      'HARNESS_BLOCKED',
    );
    expect(classifyBehaviorOutcome({ requiredChecks: [{ checkId: 'a', status: 'passed' }] })).toBe(
      'HARNESS_BLOCKED',
    );
  });

  it('documents the complete precedence order', () => {
    expect(STATUS_OUTCOME_PRECEDENCE).toHaveLength(5);
    expect(STATUS_OUTCOME_PRECEDENCE[0]).toContain('empty-required-checks');
    expect(STATUS_OUTCOME_PRECEDENCE[4]).toContain('all-PASS');
  });
});

describe('[P7-B B1-A] final outcome with cleanup and external failure', () => {
  it('keeps a complete all-PASS run as final PASS', () => {
    expect(classifyFinalOutcome({ requiredChecks: PASSING, cleanupSucceeded: true })).toBe('PASS');
  });

  it('converts any incomplete cleanup to ENVIRONMENT_FAILURE', () => {
    expect(classifyFinalOutcome({ requiredChecks: PASSING, cleanupSucceeded: false })).toBe(
      'ENVIRONMENT_FAILURE',
    );
    expect(classifyFinalOutcome({ requiredChecks: FAILING, cleanupSucceeded: false })).toBe(
      'ENVIRONMENT_FAILURE',
    );
  });

  it('classifies an external failure as ENVIRONMENT_FAILURE even without evaluated checks', () => {
    expect(
      classifyFinalOutcome({ requiredChecks: [], cleanupSucceeded: true, externalFailure: true }),
    ).toBe('ENVIRONMENT_FAILURE');
  });

  it('preserves the behavior outcome separately from a later cleanup failure', () => {
    const classified = classifyStatusOutcome({ requiredChecks: FAILING, cleanupSucceeded: false });
    expect(classified.behaviorOutcome).toBe('BUG');
    expect(classified.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(classified.failingCheckIds).toEqual(['geometry.delta']);
  });

  it('preserves an unusable behavior result separately from a later cleanup failure', () => {
    const classified = classifyStatusOutcome({ requiredChecks: UNUSABLE, cleanupSucceeded: false });
    expect(classified.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(classified.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(classified.unusableCheckIds).toEqual(['geometry.delta']);
  });

  it('records no behavior outcome for a pre-authority external failure', () => {
    const classified = classifyStatusOutcome({
      requiredChecks: [],
      cleanupSucceeded: true,
      externalFailure: true,
    });
    expect(classified.behaviorOutcome).toBeNull();
    expect(classified.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('never maps an unusable-authority outcome to a product-defect meaning', () => {
    expect(statusNonPassMeaning('HARNESS_BLOCKED')).toBe('unavailable-evidence');
    expect(statusNonPassMeaning('ENVIRONMENT_FAILURE')).toBe('unavailable-evidence');
    expect(statusNonPassMeaning('BUG')).toBe('product-defect');
    expect(statusNonPassIsBlocking('HARNESS_BLOCKED')).toBe(true);
    expect(statusNonPassIsBlocking('PASS')).toBe(false);
  });
});

describe('[P7-B B1-A] post-cutover retained legacy surfaces', () => {
  const skillRoot = path.resolve(process.cwd(), '.pi/skills/verify-artwork-editor');
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('retains the shared CheckResult boolean for its unchanged read-only consumers', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
  });

  it('retains the historical v3 run-record schema marker', () => {
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
  });

  it('retains the boolean classifier off the active status path', () => {
    const outcomes = source('src/runtime/outcomes.ts');
    expect(outcomes).toContain('input.harnessInvalid');
    expect(outcomes).toContain('check.passed');
    expect(outcomes).not.toContain('isCheckResultStatus');
    // E3-S2 removed the boolean classifier from the active path: no active CLI
    // entry may reach `runtime/outcomes` any more.
    for (const entry of [
      'src/cli/diagnostic.ts',
      'src/cli/suite.ts',
      'src/cli/doctor.ts',
      'src/cli/production-absence.ts',
    ]) {
      expect(source(entry), entry).not.toMatch(/from '\.\.\/runtime\/outcomes'/);
    }
  });

  it('moves the active record-writer authority to the strict-v4 final writer', () => {
    // E3-S2 removed the boolean/v3 writer authority from the legacy module; only
    // the shared exclusive-write primitive remains.
    const writer = source('src/evidence/writer.ts');
    expect(writer).not.toContain('DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION');
    expect(writer).not.toMatch(/export (function|const) (build|write)PublicRunRecord/);
    expect(writer).not.toMatch(/export (function|const) (build|write)RejectionRecord/);
    expect(writer).toContain('writeExclusiveRecordFile');
    // The strict-v4 writer is the sole current record writer.
    expect(source('src/evidence/final-writer.ts')).toContain('writeFinalPublicRunRecordV4');
  });
});
