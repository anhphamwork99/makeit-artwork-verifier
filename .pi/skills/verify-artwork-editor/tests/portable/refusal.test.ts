import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evidenceRootFor } from '../../src/allocation/lease';
import { runDiagnosticCommand, type DiagnosticCliDetails } from '../../src/cli/diagnostic';
import { runCli } from '../../src/cli/main';
import { runWithCliStdout } from '../../src/cli/output';
import type { CaseRequest } from '../../src/contracts/case-model';
import type { CliResult } from '../../src/contracts/runtime';
import { resolveExecutionSupport } from '../../src/planner/execution-support';
import { resolveSkillRoot } from '../../src/runtime/paths';

/**
 * Portable pre-allocation refusal matrix (ADR 0118, WP2 C3/C4).
 *
 * Every case in this suite must be decided at Diagnostic preflight — before
 * port/scratch allocation, process launch, browser creation or evidence
 * creation — and must report `launchAttempted: false` with no owned evidence.
 * The suite runs with no FE checkout present: every app root is either an
 * explicit failure path or a synthetic fixture under `tests/portable/fixtures/`.
 *
 * The provider is an integration/harness input, so a missing or incompatible
 * provider must stay `HARNESS_BLOCKED`/`ENVIRONMENT_FAILURE`-free: it is never a
 * product `BUG` and never a usage error once an app root was supplied.
 */

const PORTABLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(PORTABLE_ROOT, 'fixtures');
const APP_ROOT_COMPATIBLE = path.join(FIXTURES_ROOT, 'app-root-compatible');
const APP_ROOT_INCOMPATIBLE_SCHEMA = path.join(FIXTURES_ROOT, 'app-root-incompatible-schema');
const APP_ROOT_BAD_EXPORT = path.join(FIXTURES_ROOT, 'app-root-bad-export');
const APP_ROOT_LOAD_FAILURE = path.join(FIXTURES_ROOT, 'app-root-load-failure');
const APP_ROOT_NO_PROVIDER = path.join(FIXTURES_ROOT, 'app-root-no-provider');

/** A real, catalogue-bound layer/text move request that routes to a delivered runtime. */
function supportedCasePath(): string {
  return path.join(
    resolveSkillRoot(),
    'cases',
    'diagnostic',
    'requests',
    'layer-text-move-drag-ordinary.json',
  );
}

/** A plan-valid request whose subject has no delivered fixture binding. */
function unboundRequest(): CaseRequest {
  return {
    schemaVersion: 1,
    profile: 'diagnostic',
    provenance: 'diagnostic-request',
    evidenceDepth: 'deep',
    intent: {
      subjectId: 'container/layout',
      capability: 'move',
      variant: null,
      scenario: 'drag-ordinary',
      preState: {},
      operations: [{ discriminant: 'move.by', parameters: { dx: 10, dy: 10 } }],
      expected: { minimumDelta: { x: 5, y: 5 } },
      resources: [],
    },
  };
}

async function captureCli<TDetails = unknown>(
  argv: readonly string[],
): Promise<CliResult<TDetails>> {
  let stdout = '';
  const code = await runWithCliStdout((chunk) => {
    stdout += chunk;
  }, () => runCli(argv));
  const envelope = JSON.parse(stdout) as CliResult<TDetails>;
  expect(envelope.exitCode).toBe(code);
  return envelope;
}

function codes(result: Pick<CliResult<unknown>, 'diagnostics'>): string[] {
  return result.diagnostics.map((entry) => entry.code);
}

function providerContext(result: CliResult<DiagnosticCliDetails>): string | undefined {
  return result.diagnostics.find((entry) => entry.code.startsWith('PRODUCT_MEANING_PROVIDER'))
    ?.context.appRootCode;
}

/**
 * The single invariant every pre-allocation refusal shares: nothing was
 * allocated, launched, or written, and no evidence artifact exists.
 */
function expectPreallocationRefusal(
  result: CliResult<DiagnosticCliDetails>,
  runId: string,
): void {
  expect(result.launchAttempted).toBe(false);
  const details = result.details;
  expect(details).not.toBeNull();
  if (details === null) return;
  expect(details.allocation).toBeNull();
  expect(details.launch).toBeNull();
  expect(details.behaviorOutcome).toBeNull();
  expect(details.finalOutcome).toBeNull();
  expect(details.evidence.references).toEqual([]);
  expect(details.evidence.runRecord).toBeNull();
  expect(details.runRecordPath).toBeNull();
  expect(details.durable.required).toBe(false);
  expect(details.durable.attempted).toBe(false);
  expect(details.durable.wrote).toBe(false);
  expect(details.cleanup).toBeNull();
  expect(existsSync(path.join(evidenceRootFor(runId), 'run-record.json'))).toBe(false);
}

describe('[ADR 0118] explicit app root preflight refusals', () => {
  it('refuses a Diagnostic invocation with no app root as USAGE/exit 64', async () => {
    const result = await runDiagnosticCommand({ casePath: supportedCasePath() });
    expect(result.status).toBe('USAGE');
    expect(result.exitCode).toBe(64);
    expect(codes(result)).toContain('CLI_USAGE_INVALID');
    expectPreallocationRefusal(result, '');
  });

  it('refuses a blank app root as USAGE/exit 64', async () => {
    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: '   ',
    });
    expect(result.status).toBe('USAGE');
    expect(result.exitCode).toBe(64);
    expect(codes(result)).toContain('CLI_USAGE_INVALID');
    expectPreallocationRefusal(result, '');
  });

  it('refuses a nonexistent app root as HARNESS_BLOCKED without allocation', async () => {
    const runId = 'vt-refusal-root-missing';
    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: path.join(FIXTURES_ROOT, 'definitely-not-here'),
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(codes(result)).toContain('PRODUCT_MEANING_PROVIDER_UNAVAILABLE');
    expect(providerContext(result)).toBe('APP_ROOT_UNRESOLVED');
    expectPreallocationRefusal(result, runId);
  });

  it('refuses a file app root as HARNESS_BLOCKED without allocation', async () => {
    const runId = 'vt-refusal-root-file';
    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: path.join(APP_ROOT_NO_PROVIDER, 'NOTE.txt'),
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result)).toContain('PRODUCT_MEANING_PROVIDER_UNAVAILABLE');
    expect(providerContext(result)).toBe('APP_ROOT_NOT_DIRECTORY');
    expectPreallocationRefusal(result, runId);
  });

  it('refuses an app root with no provider entry as HARNESS_BLOCKED', async () => {
    const runId = 'vt-refusal-provider-absent';
    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: APP_ROOT_NO_PROVIDER,
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result)).toContain('PRODUCT_MEANING_PROVIDER_UNAVAILABLE');
    expect(providerContext(result)).toBe('PROVIDER_ENTRY_MISSING');
    expectPreallocationRefusal(result, runId);
  });

  it('refuses a bad provider export as HARNESS_BLOCKED', async () => {
    const runId = 'vt-refusal-provider-bad-export';
    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: APP_ROOT_BAD_EXPORT,
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result)).toContain('PRODUCT_MEANING_PROVIDER_UNAVAILABLE');
    expect(providerContext(result)).toBe('PROVIDER_CONTRACT_INVALID');
    expectPreallocationRefusal(result, runId);
  });

  it('refuses an invalid provider schema/version as HARNESS_BLOCKED and never BUG', async () => {
    const runId = 'vt-refusal-provider-incompatible';
    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: APP_ROOT_INCOMPATIBLE_SCHEMA,
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.status).not.toBe('BUG');
    expect(result.outcome).toBeNull();
    expect(codes(result)).toContain('PRODUCT_MEANING_PROVIDER_INCOMPATIBLE');
    expect(providerContext(result)).toBe('PROVIDER_INCOMPATIBLE');
    expectPreallocationRefusal(result, runId);
  });

  it('refuses a provider that throws while loading as HARNESS_BLOCKED', async () => {
    const runId = 'vt-refusal-provider-load-failure';
    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: APP_ROOT_LOAD_FAILURE,
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result)).toContain('PRODUCT_MEANING_PROVIDER_UNAVAILABLE');
    expect(providerContext(result)).toBe('PROVIDER_LOAD_FAILED');
    expectPreallocationRefusal(result, runId);
  });

  it('refuses the internal request seam without an app root as USAGE', async () => {
    const result = await runDiagnosticCommand({ request: unboundRequest() });
    expect(result.status).toBe('USAGE');
    expect(codes(result)).toContain('CLI_USAGE_INVALID');
    expectPreallocationRefusal(result, '');
  });
});

describe('[ADR 0118] request refusals stay before provider load and allocation', () => {
  it('refuses an unbound request as HARNESS_BLOCKED even with a compatible app root', async () => {
    const runId = 'vt-refusal-unbound-request';
    const result = await runDiagnosticCommand({
      request: unboundRequest(),
      appRoot: APP_ROOT_COMPATIBLE,
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(codes(result)).toContain('FIXTURE_UNAVAILABLE');
    expectPreallocationRefusal(result, runId);
  });

  it('refuses an unreadable case path as USAGE', async () => {
    const result = await runDiagnosticCommand({
      casePath: path.join(FIXTURES_ROOT, 'no-such-case.json'),
      appRoot: APP_ROOT_COMPATIBLE,
      runId: 'vt-refusal-unreadable-case',
    });
    expect(result.status).toBe('USAGE');
    expect(result.exitCode).toBe(64);
    expect(codes(result)).toContain('CLI_USAGE_INVALID');
    expectPreallocationRefusal(result, 'vt-refusal-unreadable-case');
  });

  it('refuses a generated-Crossword case whose product source is absent from a standalone checkout', async () => {
    // The generated-Crossword binding binds the accepted FE product source
    // contract (ADR 0017 R4). In a detached toolkit checkout that source is not
    // present, so the case must refuse as a harness/integration prerequisite
    // before allocation, never launch a half-wired drive and never emit BUG.
    const runId = 'vt-refusal-crossword-source-absent';
    const result = await runDiagnosticCommand({
      casePath: path.join(
        resolveSkillRoot(),
        'cases',
        'diagnostic',
        'requests',
        'layer-crossword-create.json',
      ),
      appRoot: APP_ROOT_COMPATIBLE,
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.status).not.toBe('BUG');
    expect(result.outcome).toBeNull();
    expectPreallocationRefusal(result, runId);
  });

  it('classifies a plan-valid but undelivered adapter/workflow as a deliberate deferral', () => {
    // The generic default adapter is delivered only for the history and
    // serialize workflows; anything else is a structured NOT_IMPLEMENTED gate,
    // never a half-wired launch and never a product BUG.
    const undelivered = resolveExecutionSupport('default', 'shared.move');
    expect(undelivered.supported).toBe(false);
    expect(undelivered.detail).toContain('not yet supported');

    expect(resolveExecutionSupport('default', 'shared.history').supported).toBe(true);
    expect(resolveExecutionSupport('default', 'shared.serialize').supported).toBe(true);
    expect(resolveExecutionSupport('text-specialized').supported).toBe(true);
  });
});

describe('[ADR 0118] CLI-level Diagnostic refusals preserve status and exit code', () => {
  it('refuses diagnostic without --app-root as USAGE/exit 64', async () => {
    const envelope = await captureCli<DiagnosticCliDetails>([
      'diagnostic',
      '--case',
      supportedCasePath(),
      '--run-id',
      'vt-refusal-cli-no-root',
    ]);
    expect(envelope.exitCode).toBe(64);
    expect(envelope.status).toBe('USAGE');
    expect(codes(envelope)).toContain('CLI_USAGE_INVALID');
    expectPreallocationRefusal(envelope, 'vt-refusal-cli-no-root');
  });

  it('refuses diagnostic with an unusable --app-root as HARNESS_BLOCKED/exit 2', async () => {
    const runId = 'vt-refusal-cli-bad-root';
    const envelope = await captureCli<DiagnosticCliDetails>([
      'diagnostic',
      '--case',
      supportedCasePath(),
      '--app-root',
      path.join(FIXTURES_ROOT, 'definitely-not-here'),
      '--run-id',
      runId,
    ]);
    expect(envelope.exitCode).toBe(2);
    expect(envelope.status).toBe('HARNESS_BLOCKED');
    expect(codes(envelope)).toContain('PRODUCT_MEANING_PROVIDER_UNAVAILABLE');
    expectPreallocationRefusal(envelope, runId);
  });
});
