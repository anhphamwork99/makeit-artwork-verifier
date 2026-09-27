import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import net from 'node:net';

import { evidenceRootFor, expectedDistDirFor, scratchRootFor } from '../../src/allocation/lease';
import { runCli } from '../../src/cli/main';
import { runWithCliStdout } from '../../src/cli/output';

/**
 * Shared fixtures for owned-runtime integration tests.
 *
 * Every test derives a unique safe run id and removes only the exact resources
 * it created. Nothing here ever kills a process or deletes another owner.
 */

export function uniqueRunId(prefix = 'vt'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Captures one CLI invocation's stdout through the per-invocation sink seam.
 *
 * This deliberately never reassigns `process.stdout.write`: a global patch is
 * restored by a `finally` that a Vitest timeout skips, so a timed-out run's late
 * continuation would append its envelope to the *next* test's buffer (the exact
 * failure this helper removes). The sink is scoped to the invocation and its
 * async continuations only.
 */
export async function withCapturedCliStdout<T>(
  run: () => Promise<T>,
): Promise<{ value: T; stdout: string }> {
  let stdout = '';
  const value = await runWithCliStdout((chunk) => {
    stdout += chunk;
  }, run);
  return { value, stdout };
}

export interface CapturedCliRun<T = Record<string, unknown>> {
  code: number;
  stdout: string;
  result: T;
}

/** Runs `runCli(argv)` under a scoped stdout capture and parses the envelope. */
export async function captureCliResult<T = Record<string, unknown>>(
  argv: readonly string[],
): Promise<CapturedCliRun<T>> {
  const { value: code, stdout } = await withCapturedCliStdout(() => runCli(argv));
  return { code, stdout, result: JSON.parse(stdout) as T };
}

export function removeTestRunArtifacts(runId: string): void {
  for (const target of [scratchRootFor(runId), expectedDistDirFor(runId), evidenceRootFor(runId)]) {
    rmSync(target, { recursive: true, force: true });
  }
}

export interface OccupiedPort {
  port: number;
  close: () => Promise<void>;
}

/** Binds a loopback listener on `port`, or an OS-chosen port when omitted. */
export function occupyPort(port = 0): Promise<OccupiedPort> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('occupied port has no address'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}
