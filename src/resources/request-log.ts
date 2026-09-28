/**
 * Resource request lifecycle log (WP5 Slice 5-C).
 *
 * Every declared or denied resource-related request records one compact,
 * non-secret lifecycle record. The log proves request ownership and the denial
 * policy; it can never satisfy an upload, decode, readiness, raster, or Oracle
 * check because it records only route facts, never product state.
 */

export const RESOURCE_REQUEST_LOG_SCHEMA_VERSION = 1;

export type ResourceDisposition = 'fulfilled' | 'denied-undeclared' | 'denied-shape' | 'failed';

export interface ResourceRequestLifecycle {
  schemaVersion: number;
  requestId: string;
  logicalId: string | null;
  resourceVersion: number | null;
  expectedSha256: string | null;
  method: string;
  canonicalPath: string;
  originMatched: boolean;
  requestStartedAtMs: number;
  matchedAtMs: number | null;
  fulfilledAtMs: number | null;
  requestFinishedAtMs: number | null;
  responseStatus: number | null;
  responseByteLength: number | null;
  disposition: ResourceDisposition;
  consumer: 'resource-preflight' | 'denied';
}

export interface ResourceRequestLog {
  schemaVersion: number;
  records: ResourceRequestLifecycle[];
}

export function createResourceRequestLog(): ResourceRequestLog {
  return { schemaVersion: RESOURCE_REQUEST_LOG_SCHEMA_VERSION, records: [] };
}

export interface RecordResourceRequestInput {
  requestId: string;
  logicalId: string | null;
  resourceVersion: number | null;
  expectedSha256: string | null;
  method: string;
  canonicalPath: string;
  originMatched: boolean;
  startedAtMs: number;
}

export function beginResourceRequest(
  log: ResourceRequestLog,
  input: RecordResourceRequestInput,
): ResourceRequestLifecycle {
  const record: ResourceRequestLifecycle = {
    schemaVersion: RESOURCE_REQUEST_LOG_SCHEMA_VERSION,
    requestId: input.requestId,
    logicalId: input.logicalId,
    resourceVersion: input.resourceVersion,
    expectedSha256: input.expectedSha256,
    method: input.method,
    canonicalPath: input.canonicalPath,
    originMatched: input.originMatched,
    requestStartedAtMs: input.startedAtMs,
    matchedAtMs: null,
    fulfilledAtMs: null,
    requestFinishedAtMs: null,
    responseStatus: null,
    responseByteLength: null,
    disposition: 'failed',
    consumer: 'denied',
  };
  log.records.push(record);
  return record;
}

/** Count of fulfilled declared requests for one logical id. */
export function fulfilledCount(log: ResourceRequestLog, logicalId: string): number {
  return log.records.filter(
    (record) => record.logicalId === logicalId && record.disposition === 'fulfilled',
  ).length;
}

/** Count of declared requests that were not fulfilled (denied or failed). */
export function incompleteDeclaredCount(log: ResourceRequestLog): number {
  return log.records.filter(
    (record) =>
      record.logicalId !== null &&
      (record.disposition === 'denied-shape' || record.disposition === 'failed'),
  ).length;
}

/** Count of undeclared reserved-path or external requests that were denied. */
export function deniedUndeclaredCount(log: ResourceRequestLog): number {
  return log.records.filter((record) => record.disposition === 'denied-undeclared').length;
}
