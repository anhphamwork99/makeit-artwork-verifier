import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PACKAGE7_COMPLETENESS_DIMENSIONS,
  PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH,
  PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION,
} from '../../src/index';
import type { Package7CompletenessLedger } from '../../src/index';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { captureCliResult } from './helpers';

/**
 * Package 7 Slice C `validate --all` integration (gap-plan §5 P7-C).
 *
 * `validate --all` must persist one deterministic, timestamp-free,
 * machine-readable completeness ledger atomically, and repeated invocations
 * must produce byte-identical bytes. This test reads the artifact exactly as an
 * independent reviewer would and never launches the application.
 */

interface ValidateEnvelope {
  status: string;
  exitCode: number;
  launchAttempted: boolean;
  details: {
    correctness: {
      completeness: {
        artifactPath: string;
        artifactSha256: string | null;
        artifactBytes: number | null;
        persisted: boolean;
        ledgerFingerprint: string;
        acceptedRepresentativeState: string;
        counts: Record<string, number>;
        dimensions: { dimension: string; releaseCredit: boolean }[];
        releaseCreditGranted: boolean;
      };
    };
  } | null;
}

const artifactAbsolute = path.join(resolveSkillRoot(), PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH);

function readArtifact(): { raw: Buffer; ledger: Package7CompletenessLedger } {
  const raw = readFileSync(artifactAbsolute);
  return { raw, ledger: JSON.parse(raw.toString('utf8')) as Package7CompletenessLedger };
}

describe('[P7-C] validate --all completeness ledger integration', () => {
  it('persists the durable completeness ledger and reports it in the envelope', async () => {
    // A pre-launch fail-closed budget under parallel workers; no retry.
    const { code, result } = await captureCliResult<Record<string, unknown>>(['validate', '--all']);
    expect(code).toBe(0);
    const envelope = result as unknown as ValidateEnvelope;
    expect(envelope.status).toBe('PASS');
    expect(envelope.launchAttempted).toBe(false);
    const details = envelope.details;
    if (details === null) throw new Error('unreachable');
    const completeness = details.correctness.completeness;

    expect(completeness.artifactPath).toBe(PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH);
    expect(completeness.persisted).toBe(true);
    expect(completeness.acceptedRepresentativeState).toBe('accepted');
    expect(completeness.releaseCreditGranted).toBe(false);
    expect(completeness.dimensions.map((entry) => entry.dimension)).toEqual([
      ...PACKAGE7_COMPLETENESS_DIMENSIONS,
    ]);
    expect(completeness.dimensions.every((entry) => entry.releaseCredit === false)).toBe(true);
    expect(completeness.counts).toMatchObject({
      declaredBindings: 65,
      coverageModels: 7,
      compiledProfiles: 7,
      selectedReleaseAssignments: 55,
      releaseAssignmentsExecuted: 0,
      acceptedRepresentativeCases: 8,
      diagnosticOnlyScenarios: 11,
      runtimeAvailableSelections: 7,
    });

    const { raw, ledger } = readArtifact();
    const observed = createHash('sha256').update(raw).digest('hex');
    expect(completeness.artifactSha256).toBe(observed);
    expect(completeness.artifactBytes).toBe(raw.length);
    expect(completeness.ledgerFingerprint).toBe(ledger.fingerprint);

    expect(ledger.schemaVersion).toBe(PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION);
    expect(ledger.label).toBe('package7-completeness-ledger.v1');
    expect(ledger.branch).toBe('P7-C');
    expect(ledger.releaseCreditGranted).toBe(false);
    expect(ledger.integrityVerificationPerformed).toBe(false);
    expect(ledger.acceptedRepresentativeSuite.integrityVerified).toBe(false);
    expect(ledger.acceptedRepresentativeSuite.state).toBe('accepted');
    expect(ledger.counts.selectedReleaseAssignments).not.toBe(
      ledger.counts.acceptedRepresentativeCases,
    );
  }, 30_000);

  it('produces byte-identical durable bytes across repeated validate --all runs', async () => {
    await captureCliResult(['validate', '--all']);
    const first = readArtifact();
    await captureCliResult(['validate', '--all']);
    const second = readArtifact();
    expect(first.raw.equals(second.raw)).toBe(true);
    // No timestamp and no absolute private path is persisted in the artifact.
    const text = first.raw.toString('utf8');
    expect(text).not.toMatch(/recordedAt|generatedAt|"timestamp"/);
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/private\//);
  }, 60_000);
});
