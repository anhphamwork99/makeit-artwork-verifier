import net from 'node:net';

import { isProcessGroupAlive } from '../allocation/lease';

/**
 * Exact process-group termination (specification 10, Gate D).
 *
 * Only the recorded process group of the owned run is ever signalled. The
 * current process and the shared development server are never targets, and a
 * group that cannot be verified is refused rather than guessed at.
 */

export interface ProcessGroupTermination {
  signalled: number | null;
  refused: string | null;
  escalated: boolean;
  dead: boolean;
}

export interface TerminateOptions {
  termDeadlineMs?: number;
  killDeadlineMs?: number;
  pollIntervalMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, deadlineMs: number, intervalMs: number) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

export async function terminateProcessGroup(
  processGroupId: number | null,
  options: TerminateOptions = {},
): Promise<ProcessGroupTermination> {
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const termDeadlineMs = options.termDeadlineMs ?? 10_000;
  const killDeadlineMs = options.killDeadlineMs ?? 5_000;

  if (processGroupId === null || !Number.isInteger(processGroupId) || processGroupId <= 1) {
    return {
      signalled: null,
      refused: 'process group is missing or not verifiable',
      escalated: false,
      dead: false,
    };
  }
  const ownGroup = getOwnProcessGroupId();
  if (ownGroup !== null && processGroupId === ownGroup) {
    return {
      signalled: null,
      refused: 'refusing to signal the current process group',
      escalated: false,
      dead: false,
    };
  }

  if (!isProcessGroupAlive(processGroupId)) {
    return { signalled: null, refused: null, escalated: false, dead: true };
  }

  try {
    process.kill(-processGroupId, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { signalled: null, refused: null, escalated: false, dead: true };
    }
    return {
      signalled: null,
      refused: `SIGTERM failed: ${(error as Error).message}`,
      escalated: false,
      dead: false,
    };
  }

  if (await waitUntil(() => !isProcessGroupAlive(processGroupId), termDeadlineMs, pollIntervalMs)) {
    return { signalled: processGroupId, refused: null, escalated: false, dead: true };
  }

  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      return {
        signalled: processGroupId,
        refused: `SIGKILL failed: ${(error as Error).message}`,
        escalated: true,
        dead: false,
      };
    }
  }

  const dead = await waitUntil(
    () => !isProcessGroupAlive(processGroupId),
    killDeadlineMs,
    pollIntervalMs,
  );
  return { signalled: processGroupId, refused: null, escalated: true, dead };
}

export function getOwnProcessGroupId(): number | null {
  const getpgid = (process as unknown as { getpgid?: (pid: number) => number }).getpgid;
  if (typeof getpgid !== 'function') return null;
  try {
    return getpgid.call(process, 0);
  } catch {
    return null;
  }
}

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

export async function waitForPortClosed(
  port: number,
  deadlineMs = 5_000,
  pollIntervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (!(await isPortOpen(port))) return true;
    if (Date.now() >= deadline) return false;
    await delay(pollIntervalMs);
  }
}
