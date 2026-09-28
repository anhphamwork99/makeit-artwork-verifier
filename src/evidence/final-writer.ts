import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  assembleFinalPublicCommandRecordV4,
  assembleFinalPublicRunRecordV4,
  validateFinalPublicCommandRecordV4,
  validateFinalPublicRunRecordV4,
  type AssembleFinalPublicCommandRecordV4Input,
  type AssembleFinalPublicRunRecordV4Input,
  type FinalPublicCommandRecordV4,
  type FinalPublicRecordValidation,
  type FinalPublicRunRecordV4,
} from '../contracts/final-public-record';
import { serializePublicRecord } from './guard';
import { RUN_RECORD_FILE_NAME, RunRecordWriteError, writeExclusiveRecordFile } from './writer';

/**
 * Current durable strict-v4 public evidence writer (ADR 0025 §7;
 * ADR 0032 §E3-S2).
 *
 * The writer accepts only the complete closed public v4 DTO, for both record
 * families: the compiled-profile child family
 * (`writeFinalPublicRunRecordV4`) and the command-context family
 * (`writeFinalPublicCommandRecordV4`, Doctor / production-absence). It:
 *
 * 1. assembles the record from the accepted strict-v4 child or command record
 *    plus the safe operational projections, failing closed on any disagreement;
 * 2. re-validates the closed record, completely and cycle-safely rejecting the
 *    removed legacy authorities (`passed`, `harnessInvalid`) anywhere in it;
 * 3. applies the accepted complete public redaction guard to the record *and* to
 *    the exact bytes that would be written (`serializePublicRecord`), so an
 *    unsafe candidate never reaches disk;
 * 4. writes exclusively with `wx` creation and `fsync` through the shared
 *    `writeExclusiveRecordFile`, refusing to overwrite an existing record;
 * 5. performs a strict self-readback: the bytes on disk must equal the guarded
 *    bytes exactly, must parse, must re-validate as a closed record of the same
 *    family, and must re-serialize byte-identically.
 *
 * Both families write the same per-run durable record file name, so one run
 * root cannot hold two records and the durable reader discriminates the family
 * by content, never by file name.
 *
 * It is the sole current durable public record writer. The
 * destination is always an explicit out-of-band sink: the module owns no
 * default or active evidence location and copies no destination into the
 * record. Every non-`PASS` outcome is a thrown error, never a claimed write.
 */

/** The out-of-band destination for a public v4 child record. */
export interface WriteFinalPublicRunRecordV4Input extends AssembleFinalPublicRunRecordV4Input {
  /** Explicit sink; never copied into the record. */
  readonly evidenceRoot: string;
  /** Registered private absolute paths the guard must reject if leaked. */
  readonly forbiddenPaths?: readonly string[];
}

export interface WriteFinalPublicRunRecordV4Result {
  readonly path: string;
  readonly serialized: string;
  readonly record: FinalPublicRunRecordV4;
}

function describe(issues: readonly { readonly code: string }[]): string {
  return issues.map((entry) => entry.code).join(', ');
}

/**
 * Strict self-readback of an already-written public v4 record. It re-reads the
 * exact bytes, re-validates the parsed record against the family's closed DTO,
 * and re-serializes it; any disagreement is a hard write failure rather than a
 * durable-record claim. Both public v4 record families share this exact
 * procedure and differ only in the label they report and the validator they
 * apply, so the command write can never be weaker than the child write.
 */
function readBackFinalPublicRecordV4<T>(
  target: string,
  serialized: string,
  label: 'public v4 record' | 'public v4 command record',
  validate: (value: unknown) => FinalPublicRecordValidation,
): T {
  let text: string;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    throw new RunRecordWriteError(
      `The ${label} could not be read back from ${target}: ${(error as Error).message}`,
    );
  }
  if (text !== `${serialized}\n`) {
    throw new RunRecordWriteError(
      `The ${label} read back from ${target} does not carry the exact guarded bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RunRecordWriteError(`The ${label} read back from ${target} is not valid JSON.`);
  }
  const validation = validate(parsed);
  if (!validation.ok) {
    throw new RunRecordWriteError(
      `The ${label} read back from ${target} is not a complete closed record: ${describe(
        validation.issues,
      )}.`,
    );
  }
  if (JSON.stringify(parsed) !== serialized) {
    throw new RunRecordWriteError(`The ${label} read back from ${target} is not byte-canonical.`);
  }
  return parsed as T;
}

/** Prepared strict-v4 child record; preparation performs no filesystem I/O. */
export interface PreparedFinalPublicRunRecordV4 {
  readonly family: 'current-v4';
  readonly record: FinalPublicRunRecordV4;
  readonly serialized: string;
}

/** Prepared strict-v4 command record; preparation performs no filesystem I/O. */
export interface PreparedFinalPublicCommandRecordV4 {
  readonly family: 'command-v4';
  readonly record: FinalPublicCommandRecordV4;
  readonly serialized: string;
}

function prepareRunRecord(input: WriteFinalPublicRunRecordV4Input): PreparedFinalPublicRunRecordV4 {
  const assembled = assembleFinalPublicRunRecordV4(input);
  if (!assembled.ok) {
    throw new RunRecordWriteError(
      `The public v4 record is not a complete closed record: ${describe(assembled.issues)}.`,
    );
  }
  const record = assembled.record;
  const strict = validateFinalPublicRunRecordV4(record);
  if (!strict.ok) {
    throw new RunRecordWriteError(
      `The public v4 record failed strict validation: ${describe(strict.issues)}.`,
    );
  }
  const serialized = serializePublicRecord(record, {
    forbiddenPaths: input.forbiddenPaths ?? [],
  });
  return Object.freeze({ family: 'current-v4', record, serialized });
}

function prepareCommandRecord(
  input: WriteFinalPublicCommandRecordV4Input,
): PreparedFinalPublicCommandRecordV4 {
  const assembled = assembleFinalPublicCommandRecordV4(input);
  if (!assembled.ok) {
    throw new RunRecordWriteError(
      `The public v4 command record is not a complete closed record: ${describe(assembled.issues)}.`,
    );
  }
  const record = assembled.record;
  const strict = validateFinalPublicCommandRecordV4(record);
  if (!strict.ok) {
    throw new RunRecordWriteError(
      `The public v4 command record failed strict validation: ${describe(strict.issues)}.`,
    );
  }
  const serialized = serializePublicRecord(record, {
    forbiddenPaths: input.forbiddenPaths ?? [],
  });
  return Object.freeze({ family: 'command-v4', record, serialized });
}

/** Assemble, validate, guard, and serialize a child record without writing. */
export function prepareFinalPublicRunRecordV4(
  input: WriteFinalPublicRunRecordV4Input,
): PreparedFinalPublicRunRecordV4 {
  return prepareRunRecord(input);
}

/** Assemble, validate, guard, and serialize a command record without writing. */
export function prepareFinalPublicCommandRecordV4(
  input: WriteFinalPublicCommandRecordV4Input,
): PreparedFinalPublicCommandRecordV4 {
  return prepareCommandRecord(input);
}

export function validatePreparedFinalPublicRunRecordV4(
  prepared: PreparedFinalPublicRunRecordV4,
): FinalPublicRecordValidation {
  return validateFinalPublicRunRecordV4(prepared.record);
}

export function validatePreparedFinalPublicCommandRecordV4(
  prepared: PreparedFinalPublicCommandRecordV4,
): FinalPublicRecordValidation {
  return validateFinalPublicCommandRecordV4(prepared.record);
}

export function serializePreparedFinalPublicRunRecordV4(
  prepared: PreparedFinalPublicRunRecordV4,
): string {
  return prepared.serialized;
}

export function serializePreparedFinalPublicCommandRecordV4(
  prepared: PreparedFinalPublicCommandRecordV4,
): string {
  return prepared.serialized;
}

/** Strict self-readback of a durable public v4 child record. */
export function readBackFinalPublicRunRecordV4(
  target: string,
  serialized: string,
): FinalPublicRunRecordV4 {
  return readBackFinalPublicRecordV4<FinalPublicRunRecordV4>(
    target,
    serialized,
    'public v4 record',
    validateFinalPublicRunRecordV4,
  );
}

/** Strict self-readback of a durable public v4 command-context record. */
export function readBackFinalPublicCommandRecordV4(
  target: string,
  serialized: string,
): FinalPublicCommandRecordV4 {
  return readBackFinalPublicRecordV4<FinalPublicCommandRecordV4>(
    target,
    serialized,
    'public v4 command record',
    validateFinalPublicCommandRecordV4,
  );
}

/**
 * Build, guard, exclusively write, and strictly read back one complete public
 * v4 child record. Throws (writing nothing) on any unsafe or incomplete record.
 */
export function writeFinalPublicRunRecordV4(
  input: WriteFinalPublicRunRecordV4Input,
): WriteFinalPublicRunRecordV4Result {
  const prepared = prepareRunRecord(input);
  const target = path.join(input.evidenceRoot, RUN_RECORD_FILE_NAME);
  writeExclusiveRecordFile(target, prepared.serialized);
  readBackFinalPublicRunRecordV4(target, prepared.serialized);
  return { path: target, serialized: prepared.serialized, record: prepared.record };
}

/** The out-of-band destination for a public v4 command-context record. */
export interface WriteFinalPublicCommandRecordV4Input
  extends AssembleFinalPublicCommandRecordV4Input {
  /** Explicit sink; never copied into the record. */
  readonly evidenceRoot: string;
  /** Registered private absolute paths the guard must reject if leaked. */
  readonly forbiddenPaths?: readonly string[];
}

export interface WriteFinalPublicCommandRecordV4Result {
  readonly path: string;
  readonly serialized: string;
  readonly record: FinalPublicCommandRecordV4;
}

/**
 * Build, guard, exclusively write, and strictly read back one complete public
 * v4 command-context record. It applies exactly the same closed-DTO assembly,
 * complete redaction guard over the record and the exact serialized bytes,
 * `wx`/`fsync` exclusive write with overwrite refusal, and strict byte-exact
 * self-readback as the child writer; only the record family and its validator
 * differ. Throws (writing nothing) on any unsafe or incomplete record.
 */
export function writeFinalPublicCommandRecordV4(
  input: WriteFinalPublicCommandRecordV4Input,
): WriteFinalPublicCommandRecordV4Result {
  const prepared = prepareCommandRecord(input);
  const target = path.join(input.evidenceRoot, RUN_RECORD_FILE_NAME);
  writeExclusiveRecordFile(target, prepared.serialized);
  readBackFinalPublicCommandRecordV4(target, prepared.serialized);
  return { path: target, serialized: prepared.serialized, record: prepared.record };
}
