import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import {
  expectedDistDirFor,
  evidenceRootFor,
  ownershipRecordIsVerifiable,
  ownershipRecordPathFor,
  readOwnershipRecord,
  repositoryRootProblem,
  scratchRootFor,
  updateOwnershipRecord,
} from '../../src/allocation/lease';
import { releaseAllRunPortReservations } from '../../src/allocation/port-reservation';
import { cleanupRun } from '../../src/cleanup/cleanup';
import { runDiagnosticCommand, type DiagnosticCliDetails } from '../../src/cli/diagnostic';
import { runDoctorCommand } from '../../src/cli/doctor';
import type { CleanupCliDetails } from '../../src/cli/cleanup';
import { runCli } from '../../src/cli/main';
import { runWithCliStdout } from '../../src/cli/output';
import type { CaseRequest } from '../../src/contracts/case-model';
import type { CliResult, RunOwnershipRecord } from '../../src/contracts/runtime';
import { RUN_OWNERSHIP_RECORD_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { resolveExecutionSupport } from '../../src/planner/execution-support';
import { productMeaningProviderEntryPath } from '../../src/runtime/product-meaning-provider';
import { generateRunId } from '../../src/runtime/run-id';
import { resolveRepoRoot, resolveSkillRoot, resolveToolkitRoot } from '../../src/runtime/paths';

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
const APP_ROOT_MISSING_IMAGE_CAPABILITY = path.join(
  FIXTURES_ROOT,
  'app-root-missing-image-capability',
);
const APP_ROOT_INCOMPATIBLE_SCHEMA = path.join(FIXTURES_ROOT, 'app-root-incompatible-schema');
const APP_ROOT_INCOMPATIBLE_BRIDGE = path.join(FIXTURES_ROOT, 'app-root-incompatible-bridge');
const APP_ROOT_BAD_EXPORT = path.join(FIXTURES_ROOT, 'app-root-bad-export');
const APP_ROOT_LOAD_FAILURE = path.join(FIXTURES_ROOT, 'app-root-load-failure');
const APP_ROOT_NO_PROVIDER = path.join(FIXTURES_ROOT, 'app-root-no-provider');

/** A real, catalogue-bound layer/text move request that routes to a delivered runtime. */
function supportedCasePath(): string {
  return path.join(
    resolveToolkitRoot(),
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

  it('refuses a selected image workflow when the FE host omits its capability', async () => {
    const runId = 'vt-refusal-host-image-capability';
    const result = await runDiagnosticCommand({
      casePath: path.join(
        resolveToolkitRoot(),
        'cases',
        'diagnostic',
        'requests',
        'layer-image-upload-replace.json',
      ),
      appRoot: APP_ROOT_MISSING_IMAGE_CAPABILITY,
      runId,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.status).not.toBe('BUG');
    expect(codes(result)).toContain('HOST_CAPABILITY_MISSING');
    expect(
      result.diagnostics.find((entry) => entry.code === 'HOST_CAPABILITY_MISSING')?.context,
    ).toMatchObject({
      capabilityId: 'image-upload.public-control',
      expectedVersion: 'role-name-v1',
    });
    expectPreallocationRefusal(result, runId);
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
        resolveToolkitRoot(),
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

describe('[current-source compatibility] Doctor preflight', () => {
  it('requires an explicit app root before allocation', async () => {
    const result = await runDoctorCommand({ runId: 'vt-doctor-no-root' });
    expect(result.status).toBe('USAGE');
    expect(result.launchAttempted).toBe(false);
    expect(codes(result)).toContain('CLI_USAGE_INVALID');
    expect(result.details?.allocation).toBeNull();
    expect(result.details?.evidenceRoot).toBeNull();
  });

  it('refuses an incompatible declared bridge before allocation', async () => {
    const result = await runDoctorCommand({
      runId: 'vt-doctor-bridge-mismatch',
      appRoot: APP_ROOT_INCOMPATIBLE_BRIDGE,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
    expect(codes(result)).toContain('HOST_BRIDGE_VERSION_INCOMPATIBLE');
    expect(result.details?.allocation).toBeNull();
    expect(result.details?.evidenceRoot).toBeNull();
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

/**
 * ADR 0119 — cleanup authority is the independently supplied canonical app root.
 *
 * `record.repoRoot` and its derived `distDir` are read back from
 * attacker-influenceable scratch state, so they are accepted only when the
 * record's root is exactly the root the caller independently validated. A
 * product-meaning provider file is a preflight compatibility test, never cleanup
 * authority. Every refusal below is non-destructive: no kill, restore or delete.
 */
const APP_ROOT = APP_ROOT_COMPATIBLE;
const FOREIGN_PROVIDER_ROOT = APP_ROOT_INCOMPATIBLE_SCHEMA;
const trackedRunIds: string[] = [];

function trackRun(runId: string): string {
  trackedRunIds.push(runId);
  return runId;
}

afterEach(async () => {
  await releaseAllRunPortReservations();
  for (const runId of trackedRunIds.splice(0)) {
    rmSync(scratchRootFor(runId), { recursive: true, force: true });
    rmSync(evidenceRootFor(runId), { recursive: true, force: true });
    rmSync(expectedDistDirFor(runId, APP_ROOT), { recursive: true, force: true });
    rmSync(expectedDistDirFor(runId, FOREIGN_PROVIDER_ROOT), { recursive: true, force: true });
  }
});

function verifiableRecord(runId: string, repoRoot: string): RunOwnershipRecord {
  return {
    schemaVersion: RUN_OWNERSHIP_RECORD_SCHEMA_VERSION,
    owner: 'verify-artwork-editor',
    state: 'allocated',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    processPid: null,
    processGroupId: null,
    ownedCommand: null,
    serverLogPath: path.join(evidenceRootFor(runId), 'server.log'),
    repoConfigSnapshot: null,
    activeCase: null,
    runId,
    repoRoot,
    skillRoot: resolveSkillRoot(),
    repoRelativeDistDir: `.next/verify-runs/${runId}`,
    distDir: expectedDistDirFor(runId, repoRoot),
    scratchRoot: scratchRootFor(runId),
    evidenceRoot: evidenceRootFor(runId),
    routeNamespace: `verify:${runId}:routes`,
    storageNamespace: `verify:${runId}:storage`,
    port: 55958,
    baseUrl: 'http://127.0.0.1:55958',
    environmentCellId: 'chromium-desktop-1440x1000',
  };
}

describe('[ADR 0119] exact app-root ownership binding', () => {
  it('accepts a record only for its exact validated root, never a provider-bearing foreign root', () => {
    const runId = 'vt-bind-authority';
    const bound = verifiableRecord(runId, APP_ROOT);

    expect(ownershipRecordIsVerifiable(bound, APP_ROOT)).toBe(true);
    expect(ownershipRecordIsVerifiable(bound, FOREIGN_PROVIDER_ROOT)).toBe(false);
    expect(ownershipRecordIsVerifiable(bound, resolveRepoRoot())).toBe(false);

    // A coherently tampered record: repoRoot *and* its derived distDir both point
    // at a different provider-bearing checkout. The provider file plus a matching
    // derived distDir must not authorize cleanup of a root the caller never named.
    const foreign = verifiableRecord(runId, FOREIGN_PROVIDER_ROOT);
    expect(existsSync(productMeaningProviderEntryPath(FOREIGN_PROVIDER_ROOT))).toBe(true);
    expect(repositoryRootProblem(foreign, FOREIGN_PROVIDER_ROOT)).toBeNull();
    expect(ownershipRecordIsVerifiable(foreign, APP_ROOT)).toBe(false);
    expect(repositoryRootProblem(foreign, APP_ROOT)).not.toBeNull();
  });

  it('refuses a record whose distDir is not derived from its own verified root', () => {
    const runId = 'vt-bind-dist';
    const record = verifiableRecord(runId, APP_ROOT);
    const tampered = {
      ...record,
      distDir: expectedDistDirFor(runId, FOREIGN_PROVIDER_ROOT),
    };
    expect(ownershipRecordIsVerifiable(tampered, APP_ROOT)).toBe(false);
    expect(repositoryRootProblem(tampered, APP_ROOT)).not.toBeNull();
  });

  it('cleans an allocated-but-unlaunched run only with its exact validated root', async () => {
    const runId = trackRun(generateRunId());
    const allocated = await allocateRun({ runId, appRoot: APP_ROOT });
    expect(allocated.ok).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(true);

    const cleanup = await cleanupRun(runId, { expectedAppRoot: APP_ROOT });
    expect(cleanup.attempted).toBe(true);
    expect(cleanup.complete).toBe(true);
    expect(cleanup.verification.processDead).toBe(true);
    expect(cleanup.verification.scratchRemoved).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
  });

  it('refuses a tampered foreign-root record without killing or deleting anything', async () => {
    const runId = trackRun(generateRunId());
    const allocated = await allocateRun({ runId, appRoot: APP_ROOT });
    expect(allocated.ok).toBe(true);

    // The record is edited to name a different, existing provider-bearing root
    // with a coherent derived distDir. Cleanup with the bound root must refuse.
    const foreignDist = expectedDistDirFor(runId, FOREIGN_PROVIDER_ROOT);
    mkdirSync(foreignDist, { recursive: true });
    const marker = path.join(foreignDist, 'keep.txt');
    writeFileSync(marker, 'keep\n');
    updateOwnershipRecord(runId, { repoRoot: FOREIGN_PROVIDER_ROOT, distDir: foreignDist });

    const cleanup = await cleanupRun(runId, { expectedAppRoot: APP_ROOT });
    expect(cleanup.attempted).toBe(false);
    expect(cleanup.complete).toBe(false);
    expect(cleanup.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(true);
  });

  it('preserves an incumbent lease when a second allocation collides, without cleaning it', async () => {
    const runId = trackRun(generateRunId());
    const first = await allocateRun({ runId, appRoot: APP_ROOT });
    expect(first.ok).toBe(true);
    const incumbent = readOwnershipRecord(runId);
    expect(incumbent).not.toBeNull();

    const second = await allocateRun({ runId, appRoot: APP_ROOT });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('SCRATCH_ROOT_OCCUPIED');
    // No cleanup ran: the incumbent record and its scratch lease are untouched.
    expect(readOwnershipRecord(runId)).toEqual(incumbent);
    expect(existsSync(scratchRootFor(runId))).toBe(true);

    const cleanup = await cleanupRun(runId, { expectedAppRoot: APP_ROOT });
    expect(cleanup.complete).toBe(true);
  });

  it('does not auto-clean the incumbent owner after a Diagnostic allocation collision', async () => {
    const runId = trackRun(generateRunId());
    const incumbent = await allocateRun({ runId, appRoot: APP_ROOT });
    expect(incumbent.ok).toBe(true);
    const before = readOwnershipRecord(runId);

    const result = await runDiagnosticCommand({
      casePath: supportedCasePath(),
      appRoot: APP_ROOT,
      runId,
    });

    // The collision is a pre-authority, pre-launch refusal with no product verdict.
    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    expect(result.launchAttempted).toBe(false);
    expect(result.details?.allocation).toBeNull();
    // Reaching the execution pre-authority path (not a provider/fixture refusal)
    // proves the run got as far as the allocation attempt, where it collided.
    const refusal = result.diagnostics.find((entry) => entry.code === 'RUNTIME_LAUNCH_FAILED');
    expect(refusal?.context.issueCode).toBe('EXTERNAL_PREAUTHORITY_FAILURE');
    // A failed allocation never cleans: the incumbent lease survives exactly.
    expect(readOwnershipRecord(runId)).toEqual(before);
    expect(existsSync(scratchRootFor(runId))).toBe(true);

    const cleanup = await cleanupRun(runId, { expectedAppRoot: APP_ROOT });
    expect(cleanup.complete).toBe(true);
  });
});

describe('[ADR 0119] public cleanup requires an explicit trusted app root', () => {
  it('refuses cleanup without --app-root as USAGE/exit 64', async () => {
    const envelope = await captureCli(['cleanup', '--run-id', 'vt-cli-cleanup-no-root']);
    expect(envelope.exitCode).toBe(64);
    expect(envelope.status).toBe('USAGE');
    expect(codes(envelope)).toContain('CLI_USAGE_INVALID');
  });

  it('refuses a wrong root without destructive action, then cleans with the exact root', async () => {
    const runId = trackRun(generateRunId());
    const allocated = await allocateRun({ runId, appRoot: APP_ROOT });
    expect(allocated.ok).toBe(true);

    const wrong = await captureCli<CleanupCliDetails>([
      'cleanup',
      '--run-id',
      runId,
      '--app-root',
      FOREIGN_PROVIDER_ROOT,
    ]);
    expect(wrong.status).toBe('HARNESS_BLOCKED');
    expect(wrong.details?.cleanup.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(existsSync(scratchRootFor(runId))).toBe(true);

    const right = await captureCli<CleanupCliDetails>([
      'cleanup',
      '--run-id',
      runId,
      '--app-root',
      APP_ROOT,
    ]);
    expect(right.status).toBe('PASS');
    expect(right.exitCode).toBe(0);
    expect(right.details?.cleanup.complete).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
  });
});

/**
 * ADR 0119 — symlink/path-identity ambiguity fails closed.
 *
 * The app root is an identity, not a string: a symlinked `--app-root` must be
 * canonicalized to its real directory before it is recorded as ownership
 * authority, and a recorded root that is not its own canonical path must be
 * refused. Without this, retargeting a symlink after allocation could redirect
 * cleanup to a different checkout than the one the run actually owned.
 */
function makeTempRoots(...names: readonly string[]): { base: string; roots: string[] } {
  // `os.tmpdir()` is itself a symlink on some platforms; canonicalize so the
  // synthetic roots are their own real paths and the test asserts identity.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vt-symlink-root-')));
  const roots = names.map((name) => {
    const dir = path.join(base, name);
    mkdirSync(dir);
    return dir;
  });
  return { base, roots };
}

describe('[ADR 0119] symlink app roots fail closed', () => {
  it('records the canonical root for a symlinked app root and cleans via that true root', async () => {
    const { base, roots } = makeTempRoots('real-app');
    const realRoot = roots[0] as string;
    const link = path.join(base, 'alias');
    symlinkSync(realRoot, link, 'dir');

    const runId = trackRun(generateRunId());
    const allocated = await allocateRun({ runId, appRoot: link });
    expect(allocated.ok).toBe(true);

    // Authority records the true root, never the symlinked spelling.
    const record = readOwnershipRecord(runId);
    expect(record?.repoRoot).toBe(realRoot);
    expect(record?.repoRoot).not.toBe(link);

    const cleanup = await cleanupRun(runId, { expectedAppRoot: realRoot });
    expect(cleanup.complete).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses cleanup through a retargeted symlink but cleans via the true root', async () => {
    const { base, roots } = makeTempRoots('root-a', 'root-b');
    const [rootA, rootB] = roots as [string, string];
    const link = path.join(base, 'alias');
    symlinkSync(rootA, link, 'dir');

    const runId = trackRun(generateRunId());
    const allocated = await allocateRun({ runId, appRoot: link });
    expect(allocated.ok).toBe(true);
    expect(readOwnershipRecord(runId)?.repoRoot).toBe(rootA);

    // Retarget the same symlink to another valid root.
    rmSync(link, { force: true });
    symlinkSync(rootB, link, 'dir');

    // The public recovery path canonicalizes the symlink it is given, so it now
    // names root-b and must refuse the record that owns root-a, non-destructively.
    const refused = await captureCli<CleanupCliDetails>([
      'cleanup',
      '--run-id',
      runId,
      '--app-root',
      link,
    ]);
    expect(refused.status).toBe('HARNESS_BLOCKED');
    expect(refused.details?.cleanup.attempted).toBe(false);
    expect(refused.details?.cleanup.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(existsSync(scratchRootFor(runId))).toBe(true);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);

    // The true original root still cleans exactly its own resources.
    const cleaned = await captureCli<CleanupCliDetails>([
      'cleanup',
      '--run-id',
      runId,
      '--app-root',
      rootA,
    ]);
    expect(cleaned.status).toBe('PASS');
    expect(cleaned.details?.cleanup.complete).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses a manually forged record whose repoRoot is a symlink', async () => {
    const { base, roots } = makeTempRoots('real');
    const realRoot = roots[0] as string;
    const link = path.join(base, 'link');
    symlinkSync(realRoot, link, 'dir');

    const runId = trackRun(generateRunId());
    const allocated = await allocateRun({ runId, appRoot: realRoot });
    expect(allocated.ok).toBe(true);

    // A forged record names the symlink (not its canonical target) with a
    // coherently derived distDir; the symlink is not a verifiable identity.
    updateOwnershipRecord(runId, {
      repoRoot: link,
      distDir: path.join(link, `.next/verify-runs/${runId}`),
    });

    const cleanup = await cleanupRun(runId, { expectedAppRoot: realRoot });
    expect(cleanup.attempted).toBe(false);
    expect(cleanup.complete).toBe(false);
    expect(cleanup.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(existsSync(scratchRootFor(runId))).toBe(true);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});
