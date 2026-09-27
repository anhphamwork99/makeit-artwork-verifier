import { readFileSync } from 'node:fs';

import {
  readFinalPublicRecord,
  type FinalPublicRecordReadResult,
} from '../contracts/final-public-record';

/**
 * Current strict reader of a durable public v4 record (ADR 0025 §7;
 * ADR 0032 §E3-S2).
 *
 * The reader discriminates exactly one branch without coercing:
 *
 * - a strict current v4 public child record (or v4 public command record) is
 *   accepted only when its complete closed DTO validates;
 * - a historical v1/v2/v3 record is exposed through the labelled, read-only,
 *   non-converting legacy branch, which preserves the recorded `passed` boolean
 *   exactly and reports it as ambiguous;
 * - a malformed, mixed, or unknown record is rejected.
 *
 * The destination is always an explicit caller-supplied path; the module owns
 * no default or active evidence location, and it never writes anything. It is
 * the sole current durable public record reader: the active entry paths reach
 * it through the final modules.
 */

/**
 * Reads one durable public record from disk. An unreadable file propagates the
 * operating-system error (I/O failure is not a record classification); content
 * that is not valid JSON fails closed as an invalid record rather than throwing.
 */
export function readFinalPublicRecordFile(target: string): FinalPublicRecordReadResult {
  const text = readFileSync(target, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      kind: 'invalid',
      label: 'invalid',
      schemaVersion: null,
      legacy: false,
      current: false,
      ambiguous: false,
      record: null,
      issues: [
        {
          code: 'FINAL_RECORD_FIELD_INVALID',
          detail: 'The durable public record is not valid JSON.',
          checkId: null,
        },
      ],
    };
  }
  return readFinalPublicRecord(parsed);
}
