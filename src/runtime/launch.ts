import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

import type { RunAllocation } from '../contracts/runtime';
import { isProcessGroupAlive, updateOwnershipRecord } from '../allocation/lease';
import { releaseRunPortReservation } from '../allocation/port-reservation';
import { snapshotRepoConfig } from './config-snapshot';
import { waitForHttpReadiness } from './readiness';

/**
 * Node-owned Next.js launch (specification 10, Gate D).
 *
 * The run starts its own Next.js development server with an exact owned
 * process group and the namespaced `distDir` this run exclusively owns. It never
 * attaches to, reuses, or shares a development server. Readiness is bounded and
 * reported with structured diagnostics.
 */

export const DEFAULT_READINESS_DEADLINE_MS = 180_000;

export interface LaunchOwnedServerOptions {
  allocation: RunAllocation;
  readinessDeadlineMs?: number;
  fetchImpl?: typeof fetch;
}

export interface LaunchSuccess {
  ok: true;
  pid: number;
  processGroupId: number;
  command: readonly string[];
  serverLogPath: string;
  readinessMs: number;
}

export interface LaunchFailure {
  ok: false;
  reason: 'RUNTIME_LAUNCH_FAILED' | 'RUNTIME_READINESS_FAILED';
  detail: string;
  processExited: boolean;
  /** Present once a process was spawned, even if readiness never succeeded. */
  pid: number | null;
  processGroupId: number | null;
  serverLogPath: string | null;
}

export type LaunchResult = LaunchSuccess | LaunchFailure;

export function resolveNextBinary(repoRoot: string): string {
  return path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
}

export async function launchOwnedServer(options: LaunchOwnedServerOptions): Promise<LaunchResult> {
  const { allocation } = options;
  const deadlineMs = options.readinessDeadlineMs ?? DEFAULT_READINESS_DEADLINE_MS;
  const nextBinary = resolveNextBinary(allocation.repoRoot);
  const serverLogPath = path.join(allocation.scratchRoot, 'server.log');

  if (!existsSync(nextBinary)) {
    return {
      ok: false,
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: `Next.js binary is unavailable at ${nextBinary}. Run pnpm install --frozen-lockfile.`,
      processExited: false,
      pid: null,
      processGroupId: null,
      serverLogPath: null,
    };
  }

  mkdirSync(allocation.scratchRoot, { recursive: true });
  const logFd = openSync(serverLogPath, 'a');

  // The dev server rewrites shared repository config while it runs: it adds its
  // run-specific types path to `tsconfig.json` and rewrites `next-env.d.ts` with
  // a run-specific types reference. Snapshot the exact bytes of both before
  // launch so cleanup restores them (or removes one the run created).
  const repoConfigSnapshot = snapshotRepoConfig(allocation.repoRoot, allocation.scratchRoot);
  updateOwnershipRecord(allocation.runId, { repoConfigSnapshot });

  const command = [
    process.execPath,
    nextBinary,
    'dev',
    '--turbopack',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(allocation.port),
  ];

  let child: ReturnType<typeof spawn>;
  try {
    // Launch handoff: the run's held port reservation is released exactly here,
    // immediately before the owned Next process starts, so it can bind the
    // port. A residual external race after this release is classified as
    // ENVIRONMENT_FAILURE by the bounded readiness gate; it is never claimed
    // away.
    await releaseRunPortReservation(allocation.runId);
    child = spawn(command[0] as string, command.slice(1), {
      cwd: allocation.repoRoot,
      env: {
        ...process.env,
        ARTWORK_VERIFY_DIST_DIR: allocation.repoRelativeDistDir,
        NEXT_PUBLIC_APP_URL: allocation.baseUrl,
        // The owned API origin is the owned app origin, so the seller Save /
        // response round trip is a same-origin request the case-owned route
        // contract can fulfill deterministically (WP5 Slice 5-F, ADR 0019 R5).
        NEXT_PUBLIC_API_URL: allocation.baseUrl,
        NEXT_PUBLIC_ARTWORK_VERIFICATION: 'true',
        NEXT_PUBLIC_MOCK_API: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } catch (error) {
    closeSync(logFd);
    return {
      ok: false,
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: `Owned Next.js process could not be spawned: ${(error as Error).message}`,
      processExited: false,
      pid: null,
      processGroupId: null,
      serverLogPath,
    };
  }
  closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    return {
      ok: false,
      reason: 'RUNTIME_LAUNCH_FAILED',
      detail: 'Owned Next.js process did not report a pid.',
      processExited: true,
      pid: null,
      processGroupId: null,
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

  return waitForHttpReadiness({
    url: `${allocation.baseUrl}/artwork/editor`,
    deadlineMs,
    isProcessAlive: () => isProcessGroupAlive(processGroupId),
    fetchImpl: options.fetchImpl,
  }).then((readiness) => {
    if (readiness.ready) {
      return {
        ok: true as const,
        pid,
        processGroupId,
        command,
        serverLogPath,
        readinessMs: readiness.elapsedMs,
      };
    }
    return {
      ok: false as const,
      reason: 'RUNTIME_READINESS_FAILED' as const,
      detail: readiness.processExited
        ? `Owned Next.js process group ${processGroupId} exited before readiness (${readiness.attempts} attempts). See ${serverLogPath}.`
        : `Owned Artwork Editor did not become ready within ${deadlineMs}ms (${readiness.attempts} attempts, last error: ${readiness.lastError}). See ${serverLogPath}.`,
      processExited: readiness.processExited,
      pid,
      processGroupId,
      serverLogPath,
    };
  });
}
