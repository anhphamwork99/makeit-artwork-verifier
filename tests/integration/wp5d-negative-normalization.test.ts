// @vitest-environment node
import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { evidenceRootFor } from '../../src/allocation/lease';
import { runDiagnosticCommand, type DiagnosticCliDetails } from '../../src/cli/diagnostic';
import type { ExecutePlanInput, ExecutePlanResult } from '../../src/runtime/execute-plan';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import {
  setupRefusalSatisfiesNegativeNormalizationProof,
  type SetupNormalizationRefusalEvidence,
} from '../../src/contracts/seam';
import { buildSetupRefusalProjection } from '../../src/evidence/public-dto';
import { RUN_RECORD_FILE_NAME } from '../../src/evidence/writer';
import {
  buildNestedObjectNegativeFixtureSnapshot,
  certifyNegativeNestedObjectNormalization,
} from '@/lib/artwork/verification/artworkSetupBoundary';
import { removeTestRunArtifacts, uniqueRunId } from './helpers';

/**
 * WP5 Slice 5-D negative normalization — pre-behavior terminal (ADR 0016 R6/R7).
 *
 * This runs a real owned Next.js launch and exact cleanup, then substitutes the
 * documented `execute` test seam for the drive so the pre-behavior refusal
 * terminal is proven without a browser. The refusal is a pre-execution terminal:
 * the strict current path fabricates no durable child record, and the delivered
 * refusal evidence still satisfies the named negative-normalization predicate.
 */

function negativeRequestPath(): string {
  return path.join(
    resolveToolkitRoot(),
    'tests',
    'integration',
    'fixtures',
    'container-object-move-nested-not-normalized.request.json',
  );
}

function productEvidence(): SetupNormalizationRefusalEvidence {
  const certification = certifyNegativeNestedObjectNormalization(
    buildNestedObjectNegativeFixtureSnapshot(),
  );
  if (certification.ok || certification.evidence === undefined) {
    throw new Error('the negative fixture must refuse with evaluation evidence');
  }
  return {
    phase: 'pre-hydration',
    code: 'FIXTURE_NOT_NORMALIZED',
    reason: certification.reason,
    constructorId: 'artwork.nested-object.normalization-negative.v1',
    constructorVersion: 1,
    fixtureId: 'artwork.fixture.nested-object.normalization-negative',
    fixtureVersion: 1,
    ...certification.evidence,
    mutationApplied: false,
    authorizationConsumed: true,
    lifecycle: 'SEALED',
    sealCreated: false,
    constructAttemptCount: 1,
    hydrateCallCount: 0,
    storeMutationCount: 0,
  };
}

/** The exact pre-hydration refusal evidence the negative fixture delivers. */
const DELIVERED_EVIDENCE: SetupNormalizationRefusalEvidence = productEvidence();

const PRE_BEHAVIOR_DETAIL = 'Setup did not seal: FIXTURE_NOT_NORMALIZED (FIXTURE_NOT_FIXED_POINT)';

function preBehaviorExecution(input: ExecutePlanInput): ExecutePlanResult {
  return {
    behavior: {
      outcome: 'HARNESS_BLOCKED',
      requiredChecks: input.plan.requiredChecks.map((checkId) => ({ checkId, passed: false })),
      requiredSourcesAgree: true,
      harnessInvalid: true,
      diagnostics: [],
      resolutions: [],
      targetIds: [],
      preBehaviorRefusal: {
        code: 'FIXTURE_NOT_NORMALIZED',
        reason: 'FIXTURE_NOT_FIXED_POINT',
        detail: PRE_BEHAVIOR_DETAIL,
        normalization: DELIVERED_EVIDENCE,
      },
      seal: null,
      bridgeContract: null,
      action: null,
      actionLogs: [],
      cycle: null,
      observation: null,
      oracleInputs: null,
      wakeSource: 'none',
      fallbackPollCount: 0,
      profile: {
        readinessProfileId: 'action-cycle-v1',
        readinessDeadlineMs: 5000,
        readinessStableFrames: 3,
        readinessTimingCategory: 'INTERACTIVE_RENDER_V1',
        oracleProfileId: 'geometry-delta-v1',
      },
      timings: {},
      detail: PRE_BEHAVIOR_DETAIL,
    },
    browserClose: { closed: true, detail: null },
    environmentInvalid: false,
    // A genuine pre-behavior setup refusal never enters a family execution, so
    // the executor hands back no atomic final observation.
    finalObservation: null,
  };
}

const created: string[] = [];

afterEach(() => {
  for (const runId of created.splice(0)) removeTestRunArtifacts(runId);
});

describe('[TS-2] diagnostic pre-behavior setup refusal (ADR 0016 R6/R7)', () => {
  it('refuses before behavior with no record, exit 2, and a complete cleanup', async () => {
    const runId = uniqueRunId('vt-wp5d-neg');
    created.push(runId);

    const result = await runDiagnosticCommand({
      casePath: negativeRequestPath(),
      runId,
      execute: (input) => Promise.resolve(preBehaviorExecution(input)),
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(result.outcome).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(true);
    expect(result.detail).toContain('no record was produced');

    const details = result.details as DiagnosticCliDetails;
    expect(details.behaviorOutcome).toBeNull();
    expect(details.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(details.observationId).toBeNull();
    expect(details.cleanup?.complete).toBe(true);
    // The pre-execution refusal fabricates no durable child record.
    expect(details.runRecordPath).toBeNull();
    expect(details.durable.required).toBe(false);
    expect(existsSync(path.join(evidenceRootFor(runId), RUN_RECORD_FILE_NAME))).toBe(false);
    // No behavior check or fabricated verdict was produced.
    expect(details.requiredChecks).toEqual([]);
    expect(details.issues).toContain('OBSERVATION_PAYLOAD_MALFORMED');

    // The named live acceptance predicate still holds for exactly the delivered
    // pre-hydration refusal evidence; a non-refusal or mutated shape never does.
    expect(
      setupRefusalSatisfiesNegativeNormalizationProof({
        setupRefusal: buildSetupRefusalProjection(DELIVERED_EVIDENCE),
        behaviorOutcome: details.behaviorOutcome,
        finalOutcome: details.finalOutcome,
        launchAttempted: result.launchAttempted,
        cleanupComplete: details.cleanup?.complete ?? false,
      }),
    ).toBe(true);
  }, 180_000);
});
