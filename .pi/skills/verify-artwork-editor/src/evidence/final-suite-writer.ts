import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  assembleFinalSuiteRecordV2,
  validateFinalSuiteRecordV2,
  type FinalSuiteRecordV2,
} from '../contracts/final-suite-record';
import { serializePublicRecord } from './guard';
import { RunRecordWriteError, writeExclusiveRecordFile } from './writer';

/**
 * P7-B2-E2R current durable v4-bound suite aggregate writer (ADR 0031 §4;
 * ADR 0032 §E3-S2).
 *
 * It accepts only the complete closed `FinalSuiteRecordV2` DTO and applies the
 * exact same durable procedure the accepted B2-E1 public v4 writer uses:
 *
 * 1. assemble the record from the accepted current-v4 child identities and
 *    explicit no-record refusals, failing closed on any disagreement;
 * 2. re-validate the closed record, completely and cycle-safely rejecting the
 *    removed legacy authorities (`passed`, `harnessInvalid`) anywhere in it;
 * 3. apply the accepted complete public redaction guard to the record *and* to
 *    the exact bytes that would be written (`serializePublicRecord`);
 * 4. write exclusively with `wx` creation and `fsync` through the shared
 *    `writeExclusiveRecordFile`, refusing to overwrite an existing record;
 * 5. perform a strict self-readback: the bytes on disk must equal the guarded
 *    bytes exactly, must parse, must re-validate as a closed v4-bound aggregate
 *    of schema version 2, and must re-serialize byte-identically.
 *
 * It is the sole current suite-aggregate writer. The
 * destination is always an explicit out-of-band sink. Every non-`PASS` outcome
 * is a thrown error, never a claimed write.
 */

/** The durable file name shared with the current suite-record role. */
export const FINAL_SUITE_RECORD_FILE_NAME = 'suite-record.json';

export interface WriteFinalSuiteRecordV2Input {
  readonly payload: Omit<FinalSuiteRecordV2, 'schemaVersion' | 'command' | 'label' | 'recordedAt'>;
  /** Explicit sink; never copied into the record. */
  readonly evidenceRoot: string;
  /** Registered private absolute paths the guard must reject if leaked. */
  readonly forbiddenPaths?: readonly string[];
  /** Deterministic test seam; defaults to the wall clock. */
  readonly recordedAt?: string;
}

export interface WriteFinalSuiteRecordV2Result {
  readonly path: string;
  readonly serialized: string;
  readonly record: FinalSuiteRecordV2;
}

function describe(issues: readonly { readonly code: string }[]): string {
  return issues.map((entry) => entry.code).join(', ');
}

/**
 * Strict self-readback of an already-written v4-bound suite aggregate. It
 * re-reads the exact bytes, re-validates the parsed record against the closed
 * DTO, and re-serializes it; any disagreement is a hard write failure rather
 * than a durable-record claim.
 */
export function readBackFinalSuiteRecordV2(target: string, serialized: string): FinalSuiteRecordV2 {
  let text: string;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    throw new RunRecordWriteError(
      `The v4-bound suite aggregate could not be read back from ${target}: ${(error as Error).message}`,
    );
  }
  if (text !== `${serialized}\n`) {
    throw new RunRecordWriteError(
      `The v4-bound suite aggregate read back from ${target} does not carry the exact guarded bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RunRecordWriteError(
      `The v4-bound suite aggregate read back from ${target} is not valid JSON.`,
    );
  }
  const validation = validateFinalSuiteRecordV2(parsed);
  if (!validation.ok) {
    throw new RunRecordWriteError(
      `The v4-bound suite aggregate read back from ${target} is not a complete closed record: ${describe(validation.issues)}.`,
    );
  }
  if (JSON.stringify(parsed) !== serialized) {
    throw new RunRecordWriteError(
      `The v4-bound suite aggregate read back from ${target} is not byte-canonical.`,
    );
  }
  return parsed as FinalSuiteRecordV2;
}

/**
 * Build, guard, exclusively write, and strictly read back one complete
 * v4-bound suite aggregate. Throws (writing nothing) on any unsafe or
 * incomplete record.
 */
export function writeFinalSuiteRecordV2(
  input: WriteFinalSuiteRecordV2Input,
): WriteFinalSuiteRecordV2Result {
  const assembled = assembleFinalSuiteRecordV2(input.payload, input.recordedAt);
  if (!assembled.ok) {
    throw new RunRecordWriteError(
      `The v4-bound suite aggregate is not a complete closed record: ${describe(assembled.issues)}.`,
    );
  }
  const record = assembled.record;
  const strict = validateFinalSuiteRecordV2(record);
  if (!strict.ok) {
    throw new RunRecordWriteError(
      `The v4-bound suite aggregate failed strict validation: ${describe(strict.issues)}.`,
    );
  }
  // The guard runs before any byte reaches disk and covers the complete record
  // plus the exact serialized bytes that will be written.
  const serialized = serializePublicRecord(record, {
    forbiddenPaths: input.forbiddenPaths ?? [],
  });
  const target = path.join(input.evidenceRoot, FINAL_SUITE_RECORD_FILE_NAME);
  writeExclusiveRecordFile(target, serialized);
  readBackFinalSuiteRecordV2(target, serialized);
  return { path: target, serialized, record };
}
