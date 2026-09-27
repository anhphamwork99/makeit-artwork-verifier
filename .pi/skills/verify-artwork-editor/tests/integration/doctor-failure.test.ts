import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDoctorCommand } from '../../src/cli/doctor';
import { evidenceRootFor, expectedDistDirFor, scratchRootFor } from '../../src/allocation/lease';
import { RUN_RECORD_FILE_NAME } from '../../src/evidence/writer';

/**
 * Terminal-path failure surface for the owned runtime (Gate D).
 *
 * A bounded readiness deadline that expires must classify as
 * `ENVIRONMENT_FAILURE`, must never run Doctor, must still clean every owned
 * resource, and must fabricate no durable record (neither the current
 * command-v4 record nor a legacy manifest).
 */
describe('[Gate D] owned runtime readiness failure', () => {
  it('fails as ENVIRONMENT_FAILURE and still cleans up on the terminal path', async () => {
    const result = await runDoctorCommand({ readinessDeadlineMs: 1 });
    const details = result.details;
    if (!details) throw new Error('doctor command returned no details');
    const runId = details.runId;

    try {
      expect(result.launchAttempted).toBe(true);
      expect(result.status).toBe('ENVIRONMENT_FAILURE');
      expect(result.outcome).toBe('ENVIRONMENT_FAILURE');
      expect(details.behaviorOutcome).toBeNull();
      expect(details.launch?.pid).toBeGreaterThan(0);
      expect(details.launch?.processGroupId).toBe(details.launch?.pid);
      expect(details.launch?.readinessMs).toBeNull();
      expect(details.cleanup?.complete).toBe(true);
      expect(details.cleanup?.verification.processDead).toBe(true);
      expect(details.cleanup?.verification.portClosed).toBe(true);
      expect(details.cleanup?.verification.scratchRemoved).toBe(true);
      expect(details.cleanup?.verification.distDirRemoved).toBe(true);
      expect(details.finalOutcome).toBe('ENVIRONMENT_FAILURE');

      expect(existsSync(scratchRootFor(runId))).toBe(false);
      expect(existsSync(expectedDistDirFor(runId))).toBe(false);

      // A readiness failure is decided before any record exists: the current
      // command-v4 path writes no record at all and never a legacy manifest.
      expect(details.runRecordPath).toBeNull();
      const evidenceRoot = evidenceRootFor(runId);
      expect(existsSync(path.join(evidenceRoot, RUN_RECORD_FILE_NAME))).toBe(false);
      expect(existsSync(path.join(evidenceRoot, 'manifest.json'))).toBe(false);
      expect(details.finalOutcome).toBe('ENVIRONMENT_FAILURE');
      expect(details.behaviorOutcome).toBeNull();
      expect(result.diagnostics.map((entry) => entry.code)).toContain('RUNTIME_READINESS_FAILED');
    } finally {
      rmSync(evidenceRootFor(runId), { recursive: true, force: true });
      rmSync(scratchRootFor(runId), { recursive: true, force: true });
      rmSync(expectedDistDirFor(runId), { recursive: true, force: true });
    }
  }, 60_000);
});
