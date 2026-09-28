import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main';
import { captureCliResult, withCapturedCliStdout } from './helpers';

/**
 * Regression: the abandoned-timeout capture contamination.
 *
 * The prior harness captured CLI stdout by reassigning the global
 * `process.stdout.write` and restoring it in a `finally`. Vitest skips a
 * timed-out test's `finally`, so when the run's async continuation resolved
 * later it wrote its envelope through whatever patch was installed at that
 * moment — the *next* test's buffer. That produced the observed
 * `Unexpected non-whitespace character after JSON` failure and the absurd
 * wall-clock durations (the reported duration tracked the abandoned
 * continuation, e.g. a machine-suspend span).
 *
 * The fix routes output through a per-invocation `AsyncLocalStorage` sink, so
 * these tests prove:
 *
 * 1. a late-resolving invocation writes only to its own capture;
 * 2. a concurrently-owned capture stays parseable (exactly one envelope);
 * 3. the harness never reassigns `process.stdout.write`, `Date.now`, or
 *    `performance.now`.
 */

function envelopeCount(stdout: string): number {
  return stdout.match(/"schemaVersion"/g)?.length ?? 0;
}

describe('[P7-A regression] CLI stdout capture isolation', () => {
  it('does not let a late-resolving invocation contaminate a concurrent capture', async () => {
    let releaseAbandoned!: () => void;
    const abandonedGate = new Promise<void>((resolve) => {
      releaseAbandoned = resolve;
    });
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });

    // Models the timed-out test: the invocation is still pending when another
    // capture has taken ownership of output.
    const abandoned = withCapturedCliStdout(async () => {
      await abandonedGate;
      return runCli(['help']);
    });
    const owner = withCapturedCliStdout(async () => {
      await ownerGate;
      return runCli(['--help']);
    });

    releaseAbandoned();
    const { value: abandonedCode, stdout: abandonedStdout } = await abandoned;

    releaseOwner();
    const { value: ownerCode, stdout: ownerStdout } = await owner;

    expect(abandonedCode).toBe(64);
    expect(ownerCode).toBe(64);
    expect(envelopeCount(abandonedStdout)).toBe(1);
    expect(envelopeCount(ownerStdout)).toBe(1);
    expect(JSON.parse(abandonedStdout)).toMatchObject({ command: '(help)', status: 'USAGE' });
    expect(JSON.parse(ownerStdout)).toMatchObject({ status: 'USAGE' });
  });

  it('parses a capture that runs to completion while another capture is abandoned', async () => {
    const pristineWrite = process.stdout.write;
    const pristineDateNow = Date.now;
    const pristinePerformanceNow = performance.now;

    let releaseAbandoned!: () => void;
    const abandonedGate = new Promise<void>((resolve) => {
      releaseAbandoned = resolve;
    });
    const abandoned = withCapturedCliStdout(async () => {
      await abandonedGate;
      return runCli(['diagnostic']);
    });

    const survivor = await captureCliResult(['help']);
    releaseAbandoned();
    const { value: abandonedCode, stdout: abandonedStdout } = await abandoned;

    expect(survivor.code).toBe(64);
    expect(envelopeCount(survivor.stdout)).toBe(1);
    expect(survivor.result).toMatchObject({ command: '(help)', status: 'USAGE' });
    expect(abandonedCode).toBe(64);
    expect(envelopeCount(abandonedStdout)).toBe(1);

    // No global state is mutated: no stdout patch to leak and no clock patch
    // that could produce an absurd reported duration.
    expect(process.stdout.write).toBe(pristineWrite);
    expect(Date.now).toBe(pristineDateNow);
    expect(performance.now).toBe(pristinePerformanceNow);
  });
});
