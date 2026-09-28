import { describe, expect, it } from 'vitest';

import { CLI_STATUSES, OUTCOMES } from '../../src/contracts/discriminants';
import { CLI_RESULT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  buildCliResult,
  EXIT_CODES,
  exitCodeForOutcome,
  parseCliResultEnvelope,
  statusForOutcome,
} from '../../src/cli/output';

/**
 * CLI result schema v2 and the first-class `BUG` mapping (WP5 Slice 5-A; TS-2).
 *
 * The mapping is centralized and invariant-checked: `BUG` exits 1 and can never
 * be represented as environment failure, `PASS` exits 0, unavailable-evidence
 * exits 2, deliberately deferred exits 3, and usage exits 64.
 */

describe('[TS-2] CLI result schema v2 and BUG mapping', () => {
  it('declares the widened closed status vocabulary including BUG', () => {
    expect(CLI_STATUSES).toContain('BUG');
    expect([...CLI_STATUSES].sort()).toEqual(
      ['BUG', 'ENVIRONMENT_FAILURE', 'HARNESS_BLOCKED', 'NOT_IMPLEMENTED', 'PASS', 'USAGE'].sort(),
    );
  });

  it('maps every terminal outcome exhaustively to its status and exit code', () => {
    expect(
      OUTCOMES.map((outcome) => [outcome, statusForOutcome(outcome), exitCodeForOutcome(outcome)]),
    ).toEqual([
      ['PASS', 'PASS', 0],
      ['BUG', 'BUG', 1],
      ['HARNESS_BLOCKED', 'HARNESS_BLOCKED', 2],
      ['ENVIRONMENT_FAILURE', 'ENVIRONMENT_FAILURE', 2],
    ]);
    expect(statusForOutcome('BUG')).not.toBe('ENVIRONMENT_FAILURE');
  });

  it('declares the full exit-code contract', () => {
    expect(EXIT_CODES).toEqual({
      PASS: 0,
      BUG: 1,
      HARNESS_BLOCKED: 2,
      ENVIRONMENT_FAILURE: 2,
      NOT_IMPLEMENTED: 3,
      USAGE: 64,
    });
  });

  it('emits schema v2 with the BUG/outcome/exit tuple for a product defect', () => {
    const result = buildCliResult({
      command: 'diagnostic',
      status: 'BUG',
      outcome: 'BUG',
      detail: 'post-action mismatch',
    });
    expect(result).toEqual(
      expect.objectContaining({ schemaVersion: 2, status: 'BUG', outcome: 'BUG', exitCode: 1 }),
    );
  });

  it('refuses a contradictory terminal envelope instead of masking BUG', () => {
    expect(() =>
      buildCliResult({
        command: 'doctor',
        status: 'ENVIRONMENT_FAILURE',
        outcome: 'BUG',
        detail: 'x',
      }),
    ).toThrow(/Contradictory CLI envelope/);
    expect(() =>
      buildCliResult({ command: 'doctor', status: 'BUG', outcome: 'PASS', detail: 'x' }),
    ).toThrow(/Contradictory CLI envelope/);
  });

  it('still emits schema v2 for deferred and usage envelopes', () => {
    const deferred = buildCliResult({ command: 'release', status: 'NOT_IMPLEMENTED', detail: 'x' });
    expect(deferred).toEqual(expect.objectContaining({ schemaVersion: 2, exitCode: 3 }));
    const usage = buildCliResult({ command: '(none)', status: 'USAGE', detail: 'x' });
    expect(usage).toEqual(expect.objectContaining({ schemaVersion: 2, exitCode: 64 }));
  });

  it('accepts a self-consistent v2 envelope', () => {
    const result = buildCliResult({
      command: 'doctor',
      status: 'PASS',
      outcome: 'PASS',
      detail: 'x',
    });
    expect(parseCliResultEnvelope(result).status).toBe('PASS');
  });

  it('rejects a schema-v1 fixture and a contradictory tuple', () => {
    expect(() =>
      parseCliResultEnvelope({ schemaVersion: 1, status: 'PASS', exitCode: 0, outcome: 'PASS' }),
    ).toThrow(/Unsupported CLI result schema/);
    expect(() =>
      parseCliResultEnvelope({
        schemaVersion: 2,
        status: 'ENVIRONMENT_FAILURE',
        exitCode: 2,
        outcome: 'BUG',
      }),
    ).toThrow(/contradicts outcome/);
    expect(() =>
      parseCliResultEnvelope({ schemaVersion: 2, status: 'BUG', exitCode: 2, outcome: 'BUG' }),
    ).toThrow(/does not match status/);
  });

  it('exposes the CLI result schema version as 2', () => {
    expect(CLI_RESULT_SCHEMA_VERSION).toBe(2);
  });
});
