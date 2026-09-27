import { randomBytes } from 'node:crypto';

import { isSafeRunId } from './paths';

/**
 * Immutable run id (specification 10).
 *
 * A UTC timestamp plus random suffix is a single safe path segment, so it can
 * safely namespace the owned `distDir`, scratch root, route/storage namespace,
 * and evidence root.
 */
export function generateRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const suffix = randomBytes(3).toString('hex');
  const runId = `${stamp}-${suffix}`;
  if (!isSafeRunId(runId)) {
    throw new Error(`Generated run id is not a safe path segment: ${runId}`);
  }
  return runId;
}
