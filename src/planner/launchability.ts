import type { AdapterCatalogue, AdapterDeclaration } from '../contracts/catalogues';
import type { SubjectAdapter } from '../contracts/adapter';
import type { BindingFixture, BindingFixtureCatalogue } from '../contracts/fixtures';
import type { Capability } from '../contracts/discriminants';
import type { DiagnosticRecord } from '../contracts/diagnostics';
import type { WorkflowStep, WorkflowStepCatalogue } from '../contracts/workflows';
import type { PreflightReport } from '../contracts/planner-outputs';
import { PREFLIGHT_STAGE_NAMES } from '../contracts/planner-outputs';
import type { LaunchabilityProjection } from '../contracts/runtime';
import { LAUNCHABILITY_SCHEMA_VERSION } from '../contracts/schema-versions';
import { resolveAdapterImplementation } from '../adapters/registry';
import { resolveWorkflowSteps } from '../workflows/steps';
import { resolveBindingFixture } from '../catalogue/fixtures';

/**
 * Static plan launchability projection (specification 8.3, 8.5; WP5 Slice 5-A).
 *
 * A plan is launchable only when every correctness-affecting pre-launch stage
 * resolved, including fixture/resource/environment resolution (P5) and
 * readiness/Oracle evidence resolution (P7). A binding resolves those stages
 * only when *every* role is delivered: a fixture exists for its
 * `subjectId × capability × scenarioId`, its adapter is implemented at the
 * declared compatibility version, and its workflow declares delivered steps.
 * Every undelivered binding fails closed and stays non-launchable.
 */

const LAUNCHABILITY_STAGES = ['P5', 'P7'] as const;
type LaunchabilityStage = (typeof LAUNCHABILITY_STAGES)[number];

function isLaunchabilityStage(stageId: string): stageId is LaunchabilityStage {
  return (LAUNCHABILITY_STAGES as readonly string[]).includes(stageId);
}

export interface BindingDeliveryInput {
  subjectId: string;
  capability: Capability;
  scenarioId: string;
  adapterDeclaration: AdapterDeclaration | null;
  adapterId: string;
  adapterCompatibilityVersion: number;
  workflowId: string;
  adapterCatalogue: AdapterCatalogue;
  workflowStepCatalogue: WorkflowStepCatalogue;
  fixtureCatalogue: BindingFixtureCatalogue;
}

export interface BindingDelivery {
  delivered: boolean;
  fixture: BindingFixture | null;
  adapter: SubjectAdapter | null;
  workflowSteps: readonly WorkflowStep[] | null;
  blockers: readonly string[];
  findings: readonly DiagnosticRecord[];
}

/**
 * Resolves whether *every* role a drive needs is delivered for one binding. The
 * decision is pure catalogue/adapter data; no Subject-name branch exists here.
 */
export function resolveBindingDelivery(input: BindingDeliveryInput): BindingDelivery {
  const blockers: string[] = [];
  const findings: DiagnosticRecord[] = [];

  const fixture = resolveBindingFixture(input.fixtureCatalogue, {
    subjectId: input.subjectId,
    capability: input.capability,
    scenarioId: input.scenarioId,
  });
  if (fixture === null) blockers.push('fixture-missing');

  const adapterResolution = resolveAdapterImplementation({
    catalogue: input.adapterCatalogue,
    declaration: input.adapterDeclaration ?? {
      adapterId: input.adapterId,
      compatibilityVersion: input.adapterCompatibilityVersion,
    },
  });
  if (!adapterResolution.ok) {
    blockers.push('adapter-implementation-unavailable');
    findings.push(adapterResolution.finding);
  }

  const stepEntry = resolveWorkflowSteps(input.workflowStepCatalogue, input.workflowId);
  if (stepEntry === null || stepEntry.steps.length === 0) {
    blockers.push('workflow-steps-unavailable');
  }

  return {
    delivered: blockers.length === 0,
    fixture,
    adapter: adapterResolution.ok ? adapterResolution.adapter : null,
    workflowSteps: stepEntry?.steps ?? null,
    blockers,
    findings,
  };
}

export function deriveLaunchability(report: PreflightReport): LaunchabilityProjection {
  const deferredStages = report.stages
    .filter(
      (stage) =>
        isLaunchabilityStage(stage.stageId) &&
        stage.outcome === 'deferred' &&
        report.status === 'PLANNED',
    )
    .map((stage) => stage.stageId);

  const blockers = deferredStages.map(
    (stageId) =>
      `${stageId}-deferred:${PREFLIGHT_STAGE_NAMES[stageId]} is not delivered for this binding in this Work Package`,
  );

  if (report.status !== 'PLANNED') {
    blockers.push(
      `plan-rejected:${report.status}: ${report.rejectionReasons.join('; ') || 'the attempt was rejected before launch'}`,
    );
  }

  const launchable = report.status === 'PLANNED' && deferredStages.length === 0;

  return {
    schemaVersion: LAUNCHABILITY_SCHEMA_VERSION,
    launchable,
    blockers,
    deferredStages,
    detail: launchable
      ? 'Every pre-launch stage, including fixture/resources/environment and readiness/Oracle/evidence roles, is resolved for this binding.'
      : blockers.length === 0
        ? 'No deferred launchability stage was recorded for this attempt.'
        : `Not launchable while ${deferredStages.length > 0 ? deferredStages.join(', ') : 'earlier stages'} remain deferred. Planning only; no launch was attempted.`,
  };
}
