import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

/** Original filesystem failure identity retained across writer/publication boundaries. */
export interface RunRecordWriteFailureCause {
  readonly code: string | null;
  readonly cause: unknown;
}

/**
 * Exclusive durable-record write primitive (ADR 0011 R9; ADR 0030 §B2-E1;
 * ADR 0031 §4; ADR 0032 §E3-S2).
 *
 * E3-S2 removes the boolean/v3 public writer authority. The strict-v4
 * `evidence/final-writer.ts` is the sole current Diagnostic child/public record
 * writer and the v4-bound `evidence/final-suite-writer.ts` is the sole current
 * suite writer. The former current builders and writers
 * (`buildPublicRunRecordV2`, `buildPublicRunRecordV3`, `writePublicRunRecordV2`,
 * `writePublicRunRecordV3`, `buildRejectionRecordV2`, `writeRejectionRecordV2`)
 * and the `public-dto` re-export block are gone.
 *
 * What remains is the shared low-level durability guarantee both current writers
 * reuse, unchanged: exclusive `wx` creation with `fsync`, refusing to overwrite
 * an existing run record. That is a bounded run-record safety guarantee, not a
 * claim that Gate F append-only auditing is implemented.
 *
 * P8-A1 (ADR 0041) additionally exports {@link writeExclusiveExactBytes}: the
 * same exclusive-`wx`/`fsync` durability discipline without the trailing
 * newline, so the dormant Package-8 publication primitives can create exact
 * bytes (intended inventory, approved artifacts, final manifest) with exclusive
 * no-overwrite creation. The primitive is additive; no active runtime, CLI, or
 * browser path imports it.
 */

export const RUN_RECORD_FILE_NAME = 'run-record.json';

export class RunRecordWriteError extends Error {
  readonly code: string | null;
  readonly cause: unknown;

  constructor(
    message: string,
    options: { readonly code?: string | null; readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'RunRecordWriteError';
    this.code = options.code ?? null;
    this.cause = options.cause;
  }
}

export class RunRecordExistsError extends RunRecordWriteError {
  constructor(target: string) {
    super(`A run record already exists at ${target}; refusing to overwrite it.`);
    this.name = 'RunRecordExistsError';
  }
}

export interface WriteRunRecordResult {
  path: string;
  serialized: string;
}

/** Exclusive, fsynced atomic record write shared by every public record writer. */
export function writeExclusiveRecordFile(target: string, serialized: string): void {
  writeExclusiveExactBytes(target, `${serialized}\n`);
}

/**
 * Additive exact-byte exclusive creation primitive (ADR 0041 P8-A1).
 *
 * Identical durability discipline as {@link writeExclusiveRecordFile} — create
 * with exclusive `wx`, write, `fsync`, close — but it writes the caller's exact
 * bytes and appends no newline. The Package-8 evidence transaction uses it to
 * create the sibling intended-inventory file, every approved artifact byte
 * sequence, and the final manifest with exclusive no-overwrite creation.
 *
 * This is a pure additive primitive: `writeExclusiveRecordFile` keeps its
 * existing behavior byte-for-byte by delegating here, and the dormant Package-8
 * modules are the only callers. It activates no runtime, CLI, or browser path.
 */
export function writeExclusiveExactBytes(target: string, bytes: string | Uint8Array): void {
  mkdirSync(path.dirname(target), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(target, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RunRecordExistsError(target);
    }
    throw new RunRecordWriteError(
      `Run record could not be created at ${target}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code:
          typeof (error as NodeJS.ErrnoException)?.code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : null,
        cause: error,
      },
    );
  }
  let writeError: RunRecordWriteError | null = null;
  try {
    if (typeof bytes === 'string') writeSync(descriptor, bytes, null, 'utf8');
    else writeSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    writeError = new RunRecordWriteError(
      `Run record could not be written at ${target}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code:
          typeof (error as NodeJS.ErrnoException)?.code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : null,
        cause: error,
      },
    );
  }
  let closeError: RunRecordWriteError | null = null;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = new RunRecordWriteError(
      `Run record could not be closed at ${target}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code:
          typeof (error as NodeJS.ErrnoException)?.code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : null,
        cause: error,
      },
    );
  }
  if (writeError !== null) throw writeError;
  if (closeError !== null) throw closeError;
}
