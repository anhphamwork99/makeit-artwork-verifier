import { execFileSync } from 'node:child_process';

import type { RunOwnershipRecord, RunOwnershipState } from '../contracts/runtime';

/**
 * Structural and live identity verification for owned-run process ownership
 * (specification 10, Gate D).
 *
 * A durable ownership record is written to a scratch directory that another
 * local process could edit. Destructive cleanup must therefore never trust the
 * recorded `processPid`, `processGroupId`, or `ownedCommand` fields at face
 * value. Two independent gates apply:
 *
 * 1. structural validation of the recorded fields (types, ranges, required
 *    presence for a launched run, and a well-formed owned command); and
 * 2. a live identity check immediately before signalling: the recorded pid's
 *    real process group must equal the recorded process group, and the live
 *    process command must match the recorded owned command.
 *
 * Any mismatch or malformed field refuses destructive cleanup. This module has
 * no dependency on the ownership lease, so the lease can validate record fields
 * without an import cycle.
 */

const OWNERSHIP_STATES: readonly RunOwnershipState[] = [
  'allocated',
  'cleaned',
  'launched',
  'stopped',
];

export interface LiveProcessIdentity {
  pid: number;
  processGroupId: number;
  command: string;
}

export type RecordedProcessFields = Pick<
  RunOwnershipRecord,
  'state' | 'processPid' | 'processGroupId' | 'ownedCommand'
>;

function isVerifiablePid(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value > 1);
}

function isWellFormedCommand(command: readonly string[] | null): boolean {
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((token) => typeof token === 'string' && token.trim().length > 0)
  );
}

/**
 * Returns a human-readable problem with the recorded process fields, or `null`
 * when the fields are structurally valid. Structural validity never proves the
 * live process matches; it only rejects records that can never be verified.
 */
export function ownershipProcessFieldsProblem(record: RecordedProcessFields): string | null {
  const { state, processPid, processGroupId, ownedCommand } = record;

  if (!OWNERSHIP_STATES.includes(state)) {
    return `unknown ownership state ${JSON.stringify(state)}`;
  }
  if (!isVerifiablePid(processPid)) {
    return 'recorded process pid is not a verifiable positive integer';
  }
  if (!isVerifiablePid(processGroupId)) {
    return 'recorded process group id is not a verifiable positive integer';
  }

  const hasAnyProcess = processPid !== null || processGroupId !== null;
  if (hasAnyProcess && (processPid === null || processGroupId === null)) {
    return 'recorded pid and process group must both be present or both be absent';
  }
  if (state === 'launched' && !hasAnyProcess) {
    return 'a launched record must record both its pid and its process group';
  }
  if (hasAnyProcess && !isWellFormedCommand(ownedCommand)) {
    return 'recorded owned command is missing or malformed for a process-owning record';
  }
  if (ownedCommand !== null && !isWellFormedCommand(ownedCommand)) {
    return 'recorded owned command is malformed';
  }
  return null;
}

/**
 * Reads the live process group and command line for a pid through POSIX `ps`.
 * Returns `null` when the process does not exist or cannot be inspected.
 */
export function readLiveProcessIdentity(pid: number): LiveProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const output = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'pgid=', '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /^\s*(\d+)\s+(.*)$/s.exec(output.trim());
    if (!match) return null;
    const processGroupId = Number(match[1]);
    const command = (match[2] ?? '').trim();
    if (!Number.isInteger(processGroupId) || processGroupId <= 1 || command.length === 0) {
      return null;
    }
    return { pid, processGroupId, command };
  } catch {
    return null;
  }
}

function basename(token: string): string {
  const segments = token.split(/[\\/]/);
  return segments[segments.length - 1] ?? token;
}

/** Bounded command-identity check: executable basename plus every later token. */
function liveCommandMatchesOwned(liveCommand: string, ownedCommand: readonly string[]): boolean {
  const liveArgv = liveCommand.split(/\s+/).filter((token) => token.length > 0);
  const liveExecutable = liveArgv[0];
  const ownedExecutable = ownedCommand[0];
  if (liveExecutable === undefined || ownedExecutable === undefined) return false;
  if (basename(liveExecutable) !== basename(ownedExecutable)) return false;
  for (const token of ownedCommand.slice(1)) {
    if (!liveCommand.includes(token)) return false;
  }
  return true;
}

export type RecordedProcessIdentityResult =
  | { ok: true; live: LiveProcessIdentity | null }
  | { ok: false; reason: string };

export interface VerifyProcessIdentityDeps {
  isProcessGroupAlive: (processGroupId: number) => boolean;
  readProcessIdentity?: (pid: number) => LiveProcessIdentity | null;
}

/**
 * Verifies that the recorded pid/process group/command identify the live owned
 * process, before any destructive signal is sent. A record that is already dead
 * verifies successfully with `live: null`; a record whose pid is gone while its
 * recorded process group is still alive is refused, because the surviving group
 * cannot be attributed to this run.
 */
export function verifyRecordedProcessIdentity(
  record: RecordedProcessFields,
  deps: VerifyProcessIdentityDeps,
): RecordedProcessIdentityResult {
  const structural = ownershipProcessFieldsProblem(record);
  if (structural !== null) return { ok: false, reason: structural };

  const { processPid, processGroupId, ownedCommand } = record;
  if (processPid === null || processGroupId === null) {
    return { ok: true, live: null };
  }

  const read = deps.readProcessIdentity ?? readLiveProcessIdentity;
  const live = read(processPid);
  if (live === null) {
    if (deps.isProcessGroupAlive(processGroupId)) {
      return {
        ok: false,
        reason: `recorded process ${processPid} is gone but recorded process group ${processGroupId} is still alive; the surviving group cannot be verified as this run's owner`,
      };
    }
    return { ok: true, live: null };
  }

  if (live.processGroupId !== processGroupId) {
    return {
      ok: false,
      reason: `recorded process group ${processGroupId} does not match the live process group ${live.processGroupId} of recorded pid ${processPid}`,
    };
  }

  const command = ownedCommand ?? [];
  if (!liveCommandMatchesOwned(live.command, command)) {
    return {
      ok: false,
      reason: `live process ${processPid} command does not match the recorded owned command`,
    };
  }

  return { ok: true, live };
}
