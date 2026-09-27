/**
 * Durable suite-record file-name role (ADR 0019 R13; ADR 0031 §4;
 * ADR 0032 §E3-S2).
 *
 * E3-S2 removes the schema-1 aggregate suite-record writer authority. The
 * v4-bound suite aggregate (`contracts/final-suite-record.ts`, schema version 2,
 * label `suite-v2`) written by `evidence/final-suite-writer.ts` is the sole
 * current suite authority, and `evidence/final-suite-reader.ts` is its sole
 * current reader. The former current `writePublicSuiteRecord` and the schema-1
 * `buildPublicDiagnosticSuiteRecordV1` authority are gone.
 *
 * The current suite aggregate keeps the accepted per-run durable file name, so
 * one run root still holds at most one record and a suite execution can never
 * overwrite an existing record.
 */

export const SUITE_RECORD_FILE_NAME = 'suite-record.json';
