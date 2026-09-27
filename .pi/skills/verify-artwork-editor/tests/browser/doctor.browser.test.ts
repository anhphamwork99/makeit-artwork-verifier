import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDoctorCommand } from '../../src/cli/doctor';
import { evidenceRootFor, scratchRootFor, expectedDistDirFor } from '../../src/allocation/lease';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import { digestOfFile } from '../../src/runtime/config-snapshot';
import { resolveRepoRoot } from '../../src/runtime/paths';

/**
 * Real owned-runtime Doctor proof (TS-4/TS-5, Gate D).
 *
 * Launches exactly one owned Next.js server, runs the read-only Doctor in a
 * fresh Chromium context, and verifies exact cleanup and evidence survival.
 */

const repoRoot = resolveRepoRoot();

describe('[Gate D] real browser Doctor over an owned runtime', () => {
  it('passes Doctor and cleans every owned resource while preserving evidence', async () => {
    const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
    const tsconfigDigestBefore = digestOfFile(tsconfigPath);
    // `next-env.d.ts` is rewritten by Next dev with the run-specific distDir
    // types reference, so it is a shared config file the run must own too.
    const nextEnvPath = path.join(repoRoot, 'next-env.d.ts');
    const nextEnvDigestBefore = digestOfFile(nextEnvPath);

    const result = await runDoctorCommand({ readinessDeadlineMs: 300_000 });
    const details = result.details;
    if (!details) throw new Error('doctor command returned no details');
    const runId = details.runId;

    try {
      expect(result.command).toBe('doctor');
      expect(result.status).toBe('PASS');
      expect(result.outcome).toBe('PASS');
      expect(result.launchAttempted).toBe(true);
      expect(details.behaviorOutcome).toBe('PASS');
      expect(details.finalOutcome).toBe('PASS');
      expect(details.launch?.pid).toBeGreaterThan(0);
      expect(details.launch?.processGroupId).toBe(details.launch?.pid);
      expect(details.allocation?.repoRelativeDistDir).toBe(`.next/verify-runs/${runId}`);

      expect(details.cleanup?.complete).toBe(true);
      expect(details.cleanup?.verification.processDead).toBe(true);
      expect(details.cleanup?.verification.portClosed).toBe(true);
      expect(details.cleanup?.verification.distDirRemoved).toBe(true);
      expect(details.cleanup?.verification.scratchRemoved).toBe(true);
      expect(details.cleanup?.verification.configRestored).toBe(true);
      expect(details.cleanup?.verification.evidencePreserved).toBe(true);

      // The owned scratch and namespaced build output are gone.
      expect(existsSync(scratchRootFor(runId))).toBe(false);
      expect(existsSync(expectedDistDirFor(runId))).toBe(false);

      // Raw Doctor JSON remains private scratch and is removed by cleanup. The
      // public transaction contains only the strict command record and optional
      // approved screenshot, with inventory first and final manifest last.
      const evidenceRoot = evidenceRootFor(runId);
      expect(existsSync(path.join(evidenceRoot, 'doctor.json'))).toBe(false);
      expect(existsSync(path.join(evidenceRoot, 'doctor.png'))).toBe(true);
      expect(existsSync(path.join(evidenceRoot, 'intended-inventory.json'))).toBe(true);
      expect(existsSync(path.join(evidenceRoot, 'final-manifest.json'))).toBe(true);
      const inventory = JSON.parse(
        readFileSync(path.join(evidenceRoot, 'intended-inventory.json'), 'utf8'),
      ) as { artifacts: readonly { artifactId: string; relativePath: string }[] };
      expect(inventory.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifactId: 'run.record', relativePath: 'run-record.json' }),
          expect.objectContaining({
            artifactId: 'doctor.screenshot',
            relativePath: 'doctor.png',
          }),
        ]),
      );

      expect(details.runRecordPath).toBe(path.join(evidenceRootFor(runId), 'run-record.json'));
      if (details.runRecordPath === null) throw new Error('Doctor command-v4 record missing');
      const commandRecord = readFinalPublicRecordFile(details.runRecordPath);
      expect(commandRecord.kind).toBe('command-v4');
      expect(commandRecord.current).toBe(true);
      if (commandRecord.kind !== 'command-v4') throw new Error('Doctor record is not command-v4');
      expect(commandRecord.record.command).toBe('doctor');
      expect(commandRecord.record.behaviorOutcome).toBe('PASS');
      expect(commandRecord.record.finalOutcome).toBe('PASS');
      expect(commandRecord.record.cleanup?.complete).toBe(true);
      expect(existsSync(path.join(evidenceRootFor(runId), 'manifest.json'))).toBe(false);

      // Both shared repository config files are byte-exact after the run, and
      // no dangling run-specific `.next/verify-runs/<run-id>` path survives.
      expect(digestOfFile(tsconfigPath)).toBe(tsconfigDigestBefore);
      expect(digestOfFile(nextEnvPath)).toBe(nextEnvDigestBefore);
      if (existsSync(nextEnvPath)) {
        const nextEnvContent = readFileSync(nextEnvPath, 'utf8');
        expect(nextEnvContent).not.toContain('.next/verify-runs/');
      }
    } finally {
      rmSync(evidenceRootFor(runId), { recursive: true, force: true });
      rmSync(scratchRootFor(runId), { recursive: true, force: true });
      rmSync(expectedDistDirFor(runId), { recursive: true, force: true });
    }
  });
});
