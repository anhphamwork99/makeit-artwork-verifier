import { readFileSync } from 'node:fs';

import {
  readFinalSuiteRecord,
  type FinalSuiteRecordIssue,
  type FinalSuiteRecordReadResult,
} from '../contracts/final-suite-record';

/**
 * P7-B2-E2R current strict reader of a durable suite record (ADR 0031 §4;
 * ADR 0032 §E3-S2).
 *
 * The reader discriminates exactly one branch without coercing:
 *
 * - a current v4-bound suite aggregate (schema version 2, label `suite-v2`) is
 *   accepted only when its complete closed DTO validates;
 * - a historical schema-1 suite record is exposed through the labelled,
 *   read-only, non-converting legacy branch, which preserves the recorded values
 *   exactly and can never satisfy current acceptance;
 * - a malformed, mixed, or unknown record is rejected.
 *
 * The destination is always an explicit caller-supplied path; the module owns no
 * default or active evidence location and never writes anything. It is the sole
 * current durable suite-record reader: the active suite entry path reaches it
 * through the current final modules.
 */

function invalid(detail: string): FinalSuiteRecordReadResult {
  const issues: FinalSuiteRecordIssue[] = [
    { code: 'SUITE_RECORD_NOT_OBJECT', detail, checkId: null },
  ];
  return {
    kind: 'invalid',
    label: 'invalid',
    schemaVersion: null,
    legacy: false,
    current: false,
    record: null,
    issues,
  };
}

/**
 * Reads one durable suite record from disk. An unreadable file propagates the
 * operating-system error (I/O failure is not a record classification); content
 * that is not valid JSON fails closed as an invalid record rather than throwing.
 */
export function readFinalSuiteRecordFile(target: string): FinalSuiteRecordReadResult {
  const text = readFileSync(target, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalid('The durable suite record is not valid JSON.');
  }
  return readFinalSuiteRecord(parsed);
}
