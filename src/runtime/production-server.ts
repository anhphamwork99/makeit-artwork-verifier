import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isProcessGroupAlive, updateOwnershipRecord } from '../allocation/lease';
import { releaseRunPortReservation } from '../allocation/port-reservation';
import type { RunAllocation } from '../contracts/runtime';
import { snapshotRepoConfig } from './config-snapshot';
import { resolveNextBinary } from './launch';
import { terminateProcessGroup } from './process-group';
import { waitForHttpReadiness } from './readiness';

/**
 * Owned production build + `next start` (specification 16 Gate C; Gate D).
 *
 * Production absence cannot be proven against the dev server: the dev server
 * runs with `NODE_ENV=development` and serves modules on demand. This module
 * builds the exact production artifact into the run's own
 * `.next/verify-runs/<run-id>` and then starts `next start` from that same
 * output, in an exact owned process group, on the run's reserved loopback port.
 *
 * The build is deliberately *hostile*: `NEXT_PUBLIC_ARTWORK_VERIFICATION=true`
 * and `NEXT_PUBLIC_MOCK_API=true` are passed in, so a production artifact that
 * reaches a seam is caught rather than avoided. `NODE_ENV` is forced to
 * `production` so the artifact under test is always a production artifact.
 *
 * Like the dev launch, the build rewrites the shared `tsconfig.json` and
 * `next-env.d.ts` to reference the run-specific types path, so both are
 * snapshotted before the first child starts and restored byte-exactly by the
 * existing cleanup.
 */

export const DEFAULT_PRODUCTION_BUILD_DEADLINE_MS = 600_000;
export const DEFAULT_PRODUCTION_START_DEADLINE_MS = 120_000;

export interface ProductionRunOptions {
  allocation: RunAllocation;
  buildDeadlineMs?: number;
  startDeadlineMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ProductionRunSuccess {
  ok: true;
  buildMs: number;
  readinessMs: number;
  pid: number;
  processGroupId: number;
  command: readonly string[];
  buildCommand: readonly string[];
  buildLogPath: string;
  serverLogPath: string;
}

export interface ProductionRunFailure {
  ok: false;
  phase: 'build' | 'start';
  reason: 'RUNTIME_LAUNCH_FAILED' | 'RUNTIME_READINESS_FAILED';
  detail: string;
  processExited: boolean;
  pid: number | null;
  processGroupId: number | null;
  buildLogPath: string;
  serverLogPath: string | null;
}

export type ProductionRunResult = ProductionRunSuccess | ProductionRunFailure;

/** The shared environment every owned production child receives. */
export function productionChildEnv(allocation: RunAllocation): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Hostile build: the public verification flag is on, so absence is proven by
    // tree-shaking + gates, never by withholding the flag.
    NEXT_PUBLIC_ARTWORK_VERIFICATION: 'true',
    NEXT_PUBLIC_MOCK_API: 'true',
    NEXT_PUBLIC_APP_URL: allocation.baseUrl,
    ARTWORK_VERIFY_DIST_DIR: allocation.repoRelativeDistDir,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'production',
  };
}

export function buildProductionCommand(repoRoot: string): string[] {
  return [process.execPath, resolveNextBinary(repoRoot), 'build', '--turbopack'];
}

export function startProductionCommand(repoRoot: string, port: number): string[] {
  return [
    process.execPath,
    resolveNextBinary(repoRoot),
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ];
}

/**
 * `next start` calls Next's shared `startServer`, which sets
 * `process.title = 'next-server (v…)'` on its own process. That overwrites the
 * argv view `ps` reports, so the accepted live process-identity gate (which
 * matches the recorded owned command against the live command) would refuse to
 * clean up the owned server. `next dev` does not hit this because it keeps a
 * parent process with an intact argv.
 *
 * The fix is an owned argv-preserving launcher: a tiny Node program written to
 * the run's scratch root, spawned as the process-group leader, which re-execs
 * the exact `next start` argv as its child and forwards the exit code. The
 * launcher never touches `process.title`, so the recorded owned command still
 * matches the live process while the whole group is still exactly terminated by
 * cleanup. The launcher deletes itself with the owned scratch root.
 */
export function productionStartLauncherPath(scratchRoot: string): string {
  return path.join(scratchRoot, 'production-start-launcher.cjs');
}

const START_LAUNCHER_SOURCE = `'use strict';
// Owned production next-start launcher. argv[2..] is the exact server command so
// the recorded owned command remains visible to the live identity gate.
const { spawn } = require('node:child_process');
const command = process.argv.slice(2);
if (command.length === 0) {
  process.stderr.write('missing server command\\n');
  process.exit(1);
}
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
child.on('error', () => process.exit(1));
child.on('exit', (code) => {
  process.exit(typeof code === 'number' ? code : 1);
});
`;

/** Writes the launcher into the owned scratch root; returns its path. */
export function writeProductionStartLauncher(scratchRoot: string): string {
  const launcherPath = productionStartLauncherPath(scratchRoot);
  writeFileSync(launcherPath, START_LAUNCHER_SOURCE, 'utf8');
  return launcherPath;
}

interface WaitForExitResult {
  exited: boolean;
  code: number | null;
  timedOut: boolean;
}

/** Waits for a bounded child exit; the caller owns killing a timed-out group. */
function waitForExit(child: ChildProcess, deadlineMs: number): Promise<WaitForExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WaitForExitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ exited: false, code: null, timedOut: true }),
      deadlineMs,
    );
    timer.unref?.();
    child.once('exit', (code) => finish({ exited: true, code, timedOut: false }));
    child.once('error', () => finish({ exited: true, code: null, timedOut: false }));
  });
}

/**
 * Builds and starts the owned production server. The configuration snapshot is
 * taken before the build child exists; each spawned child is recorded in the
 * durable ownership record before it can do anything a cleanup must be able to
 * stop.
 */
export async function runOwnedProductionServer(
  options: ProductionRunOptions,
): Promise<ProductionRunResult> {
  const { allocation } = options;
  const buildDeadlineMs = options.buildDeadlineMs ?? DEFAULT_PRODUCTION_BUILD_DEADLINE_MS;
  const startDeadlineMs = options.startDeadlineMs ?? DEFAULT_PRODUCTION_START_DEADLINE_MS;
  const nextBinary = resolveNextBinary(allocation.repoRoot);
  const buildLogPath = path.join(allocation.scratchRoot, 'build.log');
  const serverLogPath = path.join(allocation.scratchRoot, 'server.log');

  if (!existsSync(nextBinary)) {
    return {
      ok: false,
      phase: 'build',
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: `Next.js binary is unavailable at ${nextBinary}. Run pnpm install --frozen-lockfile.`,
      processExited: false,
      pid: null,
      processGroupId: null,
      buildLogPath,
      serverLogPath: null,
    };
  }

  mkdirSync(allocation.scratchRoot, { recursive: true });

  // Snapshot the shared config before the first owned child can rewrite it.
  const repoConfigSnapshot = snapshotRepoConfig(allocation.repoRoot, allocation.scratchRoot);
  updateOwnershipRecord(allocation.runId, { repoConfigSnapshot });

  const buildCommand = buildProductionCommand(allocation.repoRoot);
  const build = await runLoggedChild({
    allocation,
    command: buildCommand,
    logPath: buildLogPath,
    deadlineMs: buildDeadlineMs,
  });
  if (!build.ok) {
    return {
      ok: false,
      phase: 'build',
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: build.detail,
      processExited: build.processExited,
      pid: build.pid,
      processGroupId: build.processGroupId,
      buildLogPath,
      serverLogPath: null,
    };
  }

  if (!existsSync(path.join(allocation.distDir, 'BUILD_ID'))) {
    return {
      ok: false,
      phase: 'build',
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: `Owned production build completed without a BUILD_ID at ${allocation.repoRelativeDistDir}/BUILD_ID.`,
      processExited: true,
      pid: null,
      processGroupId: null,
      buildLogPath,
      serverLogPath: null,
    };
  }

  const serverArgv = startProductionCommand(allocation.repoRoot, allocation.port).slice(1);
  const launcherPath = writeProductionStartLauncher(allocation.scratchRoot);
  const command = [process.execPath, launcherPath, ...serverArgv];
  const logFd = openSync(serverLogPath, 'a');
  let child: ChildProcess;
  try {
    // Launch handoff: release the held port reservation exactly here so the
    // owned `next start` can bind it.
    await releaseRunPortReservation(allocation.runId);
    child = spawn(command[0] as string, command.slice(1), {
      cwd: allocation.repoRoot,
      env: productionChildEnv(allocation),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } catch (error) {
    closeSync(logFd);
    return {
      ok: false,
      phase: 'start',
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: `Owned production server could not be spawned: ${(error as Error).message}`,
      processExited: false,
      pid: null,
      processGroupId: null,
      buildLogPath,
      serverLogPath,
    };
  }
  closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    return {
      ok: false,
      phase: 'start',
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: 'Owned production server did not report a pid.',
      processExited: true,
      pid: null,
      processGroupId: null,
      buildLogPath,
      serverLogPath,
    };
  }
  const processGroupId = pid;

  updateOwnershipRecord(allocation.runId, {
    state: 'launched',
    processPid: pid,
    processGroupId,
    ownedCommand: command,
  });

  child.on('error', () => {
    // Diagnostics are captured through the server log and readiness result.
  });
  child.unref();

  const readiness = await waitForHttpReadiness({
    url: `${allocation.baseUrl}/artwork/editor`,
    deadlineMs: startDeadlineMs,
    isProcessAlive: () => isProcessGroupAlive(processGroupId),
    fetchImpl: options.fetchImpl,
  });

  if (readiness.ready) {
    return {
      ok: true,
      buildMs: build.elapsedMs,
      readinessMs: readiness.elapsedMs,
      pid,
      processGroupId,
      command,
      buildCommand,
      buildLogPath,
      serverLogPath,
    };
  }

  return {
    ok: false,
    phase: 'start',
    reason: 'RUNTIME_READINESS_FAILED',
    detail: readiness.processExited
      ? `Owned production server group ${processGroupId} exited before readiness (${readiness.attempts} attempts). See ${serverLogPath}.`
      : `Owned production server did not become ready within ${startDeadlineMs}ms (${readiness.attempts} attempts, last error: ${readiness.lastError}). See ${serverLogPath}.`,
    processExited: readiness.processExited,
    pid,
    processGroupId,
    buildLogPath,
    serverLogPath,
  };
}

interface LoggedChildSuccess {
  ok: true;
  elapsedMs: number;
}
interface LoggedChildFailure {
  ok: false;
  detail: string;
  processExited: boolean;
  pid: number | null;
  processGroupId: number | null;
}

/**
 * Runs one owned detached child to completion, recording it in the ownership
 * record so a signal or cleanup can terminate exactly its process group, and
 * bounding it by `deadlineMs`.
 */
async function runLoggedChild(input: {
  allocation: RunAllocation;
  command: readonly string[];
  logPath: string;
  deadlineMs: number;
}): Promise<LoggedChildSuccess | LoggedChildFailure> {
  const { allocation, command, logPath, deadlineMs } = input;
  const startedAt = Date.now();
  const logFd = openSync(logPath, 'a');
  let child: ChildProcess;
  try {
    child = spawn(command[0] as string, command.slice(1), {
      cwd: allocation.repoRoot,
      env: productionChildEnv(allocation),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } catch (error) {
    closeSync(logFd);
    return {
      ok: false,
      detail: `Owned production build could not be spawned: ${(error as Error).message}`,
      processExited: false,
      pid: null,
      processGroupId: null,
    };
  }
  closeSync(logFd);

  const pid = child.pid ?? null;
  const processGroupId = pid;
  if (pid !== null) {
    updateOwnershipRecord(allocation.runId, {
      state: 'launched',
      processPid: pid,
      processGroupId: pid,
      ownedCommand: command,
    });
  }

  const exit = await waitForExit(child, deadlineMs);

  if (exit.timedOut) {
    if (processGroupId !== null) await terminateProcessGroup(processGroupId);
    return {
      ok: false,
      detail: `Owned production build exceeded ${deadlineMs}ms and its process group ${String(processGroupId)} was terminated. See ${logPath}.`,
      processExited: true,
      pid,
      processGroupId,
    };
  }

  if (exit.code !== 0) {
    return {
      ok: false,
      detail: `Owned production build exited with code ${String(exit.code)}. See ${logPath}.`,
      processExited: true,
      pid,
      processGroupId,
    };
  }

  // The build child is complete; clear its recorded process (and drop the
  // `launched` requirement) so cleanup never signals a dead group. The start
  // phase re-records its own process and returns the record to `launched`.
  updateOwnershipRecord(allocation.runId, {
    state: 'allocated',
    processPid: null,
    processGroupId: null,
    ownedCommand: null,
  });

  return { ok: true, elapsedMs: Date.now() - startedAt };
}
