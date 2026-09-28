import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import { evidenceRootFor, expectedDistDirFor, scratchRootFor } from '../../src/allocation/lease';
import { releaseAllRunPortReservations } from '../../src/allocation/port-reservation';
import { cleanupRun } from '../../src/cleanup/cleanup';
import {
  installTerminationSignalHandlers,
  runTerminationCleanup,
  setActiveRun,
  type TerminationCliDetails,
} from '../../src/cli/termination';
import { resetTerminationStateForTests } from '../../src/cli/termination-state';
import type { CleanupResult, CliResult } from '../../src/contracts/runtime';
import { removeTestRunArtifacts, uniqueRunId } from './helpers';

/**
 * Bounded SIGINT/SIGTERM terminal safety net (F6, Gate D).
 *
 * Signal handling must route to exact cleanup of the single known active run id
 * and terminate non-zero with a structured result. It must never perform a broad
 * process-name or port sweep, and must never hang termination.
 */

const disposers: Array<() => void> = [];
const runIds: string[] = [];

function trackedRunId(prefix: string): string {
  const runId = uniqueRunId(prefix);
  runIds.push(runId);
  return runId;
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  setActiveRun(null);
  resetTerminationStateForTests();
  await releaseAllRunPortReservations();
  for (const runId of runIds.splice(0)) removeTestRunArtifacts(runId);
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('[Gate D] signal-driven terminal cleanup (F6)', () => {
  it('routes SIGINT to exact run cleanup by known run id and exits non-zero', async () => {
    const runId = trackedRunId('vt-sigint');
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');
    mkdirSync(expectedDistDirFor(runId), { recursive: true });
    writeFileSync(path.join(expectedDistDirFor(runId), 'build.txt'), 'owned\n');
    mkdirSync(evidenceRootFor(runId), { recursive: true });
    writeFileSync(path.join(evidenceRootFor(runId), 'doctor.json'), '{}\n');

    setActiveRun(runId);
    const emitted: CliResult<TerminationCliDetails>[] = [];
    const exits: number[] = [];
    disposers.push(
      installTerminationSignalHandlers({
        emit: (result) => emitted.push(result),
        exit: (code) => exits.push(code),
      }),
    );

    process.emit('SIGINT');
    await waitFor(() => exits.length > 0);

    expect(exits).toEqual([130]);
    const result = emitted[0];
    if (!result) throw new Error('no termination result was emitted');
    expect(result.command).toBe('termination');
    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    expect(result.exitCode).toBe(130);
    expect(result.launchAttempted).toBe(true);
    expect(result.details?.signal).toBe('SIGINT');
    expect(result.details?.runId).toBe(runId);
    expect(result.details?.cleanup?.complete).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('RUNTIME_TERMINATED_BY_SIGNAL');

    // Exactly the owned run was cleaned; evidence survived.
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    expect(existsSync(expectedDistDirFor(runId))).toBe(false);
    expect(existsSync(path.join(evidenceRootFor(runId), 'doctor.json'))).toBe(true);
  }, 30_000);

  it('performs no cleanup and still exits non-zero when no run is active', async () => {
    setActiveRun(null);
    const exits: number[] = [];
    let cleanupCalls = 0;
    disposers.push(
      installTerminationSignalHandlers({
        clean: async () => {
          cleanupCalls += 1;
          return cleanupRun('no-such-run');
        },
        emit: () => {},
        exit: (code) => exits.push(code),
      }),
    );

    process.emit('SIGTERM');
    await waitFor(() => exits.length > 0);

    expect(exits).toEqual([143]);
    expect(cleanupCalls).toBe(0);
  });

  it('classifies an incomplete owned cleanup as non-zero ENVIRONMENT_FAILURE', async () => {
    const incomplete: CleanupResult = {
      schemaVersion: 1,
      runId: 'vt-incomplete',
      attempted: true,
      complete: false,
      alreadyClean: false,
      refusedReason: null,
      detail: 'owned port is still open',
      verification: {
        processSignalled: null,
        processEscalated: false,
        processDead: true,
        portClosed: false,
        distDirRemoved: true,
        scratchRemoved: true,
        configRestored: true,
        browserClosed: true,
        evidencePreserved: true,
      },
      diagnostics: [],
    };

    setActiveRun('vt-incomplete');
    const exitCodes: number[] = [];
    disposers.push(
      installTerminationSignalHandlers({
        clean: async () => incomplete,
        emit: () => {},
        exit: (code) => exitCodes.push(code),
      }),
    );

    process.emit('SIGINT');
    await waitFor(() => exitCodes.length > 0);
    expect(exitCodes).toEqual([130]);

    // Direct call also yields the structured diagnostic and non-zero envelope.
    const outcome = await runTerminationCleanup('SIGTERM', { clean: async () => incomplete });
    expect(outcome.exitCode).toBe(143);
    expect(outcome.result.status).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.result.diagnostics.map((entry) => entry.code)).toContain('CLEANUP_INCOMPLETE');
  });

  it('bounds cleanup so an unresponsive cleanup cannot hang termination', async () => {
    setActiveRun('vt-hang');
    const exitCodes: number[] = [];
    disposers.push(
      installTerminationSignalHandlers({
        clean: () => new Promise<CleanupResult>(() => {}),
        deadlineMs: 25,
        emit: () => {},
        exit: (code) => exitCodes.push(code),
      }),
    );

    const started = Date.now();
    process.emit('SIGINT');
    await waitFor(() => exitCodes.length > 0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exitCodes).toEqual([130]);

    const outcome = await runTerminationCleanup('SIGTERM', {
      clean: () => new Promise<CleanupResult>(() => {}),
      deadlineMs: 25,
    });
    expect(outcome.result.details?.cleanupTimedOut).toBe(true);
    expect(outcome.result.details?.cleanup).toBeNull();
    expect(outcome.result.diagnostics.map((entry) => entry.code)).toContain('CLEANUP_INCOMPLETE');
  });

  it('terminates immediately on a second signal without stacking cleanup', async () => {
    setActiveRun('vt-second');
    const exitCodes: number[] = [];
    let cleanupCalls = 0;
    disposers.push(
      installTerminationSignalHandlers({
        clean: () => {
          cleanupCalls += 1;
          return new Promise<CleanupResult>(() => {});
        },
        deadlineMs: 60_000,
        emit: () => {},
        exit: (code) => exitCodes.push(code),
      }),
    );

    process.emit('SIGINT');
    await waitFor(() => cleanupCalls > 0);
    process.emit('SIGTERM');
    await waitFor(() => exitCodes.length > 0);

    expect(exitCodes[0]).toBe(143);
    expect(cleanupCalls).toBe(1);
  });
});
