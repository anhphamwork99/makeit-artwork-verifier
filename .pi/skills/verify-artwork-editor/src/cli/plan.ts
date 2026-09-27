import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { CliResult } from '../contracts/runtime';
import type { LaunchabilityProjection } from '../contracts/runtime';
import { planCase } from '../planner/plan-case';
import { deriveLaunchability } from '../planner/launchability';
import { buildCliResult } from './output';

/**
 * `pnpm verify:artwork plan --case <request.json> --out <dir>` (TS-2, Gate B).
 *
 * Consumes the production planner and emits the static planning artifacts. The
 * plan is explicitly `launchable: false` while fixture/resource/environment
 * resolution (P5) and readiness/Oracle resolution (P7) remain deferred. This
 * command never launches the application.
 */

export interface PlanDetails {
  launchAttempted: false;
  launchability: LaunchabilityProjection;
  caseId: string | null;
  materializationFingerprint: string | null;
  planFingerprint: string | null;
  status: string;
  outDir: string;
  artifacts: readonly string[];
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export interface RunPlanInput {
  casePath: string;
  outDir: string;
}

export function runPlan(input: RunPlanInput): CliResult<PlanDetails> {
  let raw: string;
  try {
    raw = readFileSync(input.casePath, 'utf8');
  } catch (error) {
    return buildCliResult<PlanDetails>({
      command: 'plan',
      status: 'HARNESS_BLOCKED',
      detail: `Case request is unreadable: ${input.casePath}`,
      diagnostics: [
        createDiagnostic(
          'MALFORMED_CASE_REQUEST',
          `Case request is unreadable: ${(error as Error).message}`,
        ),
      ],
    });
  }

  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    return buildCliResult<PlanDetails>({
      command: 'plan',
      status: 'HARNESS_BLOCKED',
      detail: 'Case request is not valid JSON.',
      diagnostics: [createDiagnostic('MALFORMED_CASE_REQUEST', (error as Error).message)],
    });
  }

  const result = planCase(request);
  const preflightReport =
    result.status === 'PLANNED' ? result.outputs.preflightReport : result.report;
  const launchability = deriveLaunchability(preflightReport);

  const outDir = path.resolve(input.outDir);
  mkdirSync(outDir, { recursive: true });
  const artifacts: string[] = [];

  const writeArtifact = (name: string, value: unknown): void => {
    writeJson(path.join(outDir, name), value);
    artifacts.push(name);
  };

  writeArtifact('preflight-report.json', preflightReport);
  writeArtifact('launchability.json', launchability);

  if (result.status !== 'PLANNED') {
    const diagnostics =
      result.status === 'HARNESS_BLOCKED'
        ? [result.diagnostic, ...result.findings]
        : result.findings;
    writeArtifact('plan-rejection.json', {
      status: result.status,
      launchAttempted: false,
      diagnostics,
    });
    return buildCliResult<PlanDetails>({
      command: 'plan',
      status: result.status === 'ENVIRONMENT_FAILURE' ? 'ENVIRONMENT_FAILURE' : 'HARNESS_BLOCKED',
      detail:
        result.status === 'HARNESS_BLOCKED'
          ? `Planning rejected at ${result.diagnostic.code}: ${result.diagnostic.detail}`
          : `Planning blocked before launch: ${result.reason}`,
      launchAttempted: false,
      details: {
        launchAttempted: false,
        launchability,
        caseId: null,
        materializationFingerprint: null,
        planFingerprint: null,
        status: result.status,
        outDir,
        artifacts,
      },
      diagnostics: diagnostics as readonly DiagnosticRecord[],
    });
  }

  writeArtifact('case-intent.json', result.materializedCase.intent);
  writeArtifact('materialized-case.json', result.materializedCase);
  writeArtifact('execution-plan.json', result.plan);
  writeArtifact('coverage-attribution.json', result.outputs.coverageAttribution);
  writeArtifact('evidence-requirements.json', result.outputs.evidenceRequirements);
  writeArtifact('ownership-cleanup.json', result.outputs.ownershipCleanup);
  writeArtifact('plan.json', {
    schemaVersion: result.plan.schemaVersion,
    status: result.status,
    launchAttempted: false,
    launchable: launchability.launchable,
    launchability,
    caseId: result.caseId,
    materializationFingerprint: result.materializationFingerprint,
    planFingerprint: result.planFingerprint,
    correctness: result.plan.correctness,
    fingerprints: result.outputs.preflightReport.fingerprints,
    route: result.materializedCase.route,
    requiredChecks: result.plan.requiredChecks,
    cleanup: result.plan.cleanup,
  });

  return buildCliResult<PlanDetails>({
    command: 'plan',
    status: 'PASS',
    detail: `Planned case ${result.caseId} and emitted ${artifacts.length} static artifact(s) to ${outDir}. launchable=false (${launchability.deferredStages.join(', ') || 'no deferred stage recorded'}).`,
    launchAttempted: false,
    details: {
      launchAttempted: false,
      launchability,
      caseId: result.caseId,
      materializationFingerprint: result.materializationFingerprint,
      planFingerprint: result.planFingerprint,
      status: result.status,
      outDir,
      artifacts,
    },
    diagnostics: result.findings,
  });
}
