import type { Capability } from './discriminants';

/**
 * Declarative workflow-step contract (specification 6.4; WP5 Slice 5-A).
 *
 * A workflow step is closed declarative data over a closed primitive
 * vocabulary. It names a semantic target role and binds primitive parameters to
 * *approved operation parameters* — never to scripts, literal coordinates,
 * sleeps, predicates, callbacks, or any executable payload. Unknown
 * discriminants or steps are a pre-launch `HARNESS_BLOCKED`.
 */

export const WORKFLOW_PRIMITIVES = [
  'pointer.drag',
  'pointer.click',
  'control.activate',
  'keyboard.press',
  'fileInput.set',
  /**
   * Closed frontend SAVE→restore runtime handoff (WP5 Slice 5-F). It is a
   * declarative marker naming the closed restore workflow; it accepts no URL,
   * body, expected value, coordinate, script, or predicate, and it is delivered
   * only by the dedicated restore drive.
   */
  'frontend.restore.capture',
] as const;
export type WorkflowPrimitive = (typeof WORKFLOW_PRIMITIVES)[number];

export const WORKFLOW_STEP_KEYS_V1 = ['stepId', 'primitive', 'targetRole', 'parameters'] as const;
export const WORKFLOW_STEP_KEYS_V2 = [
  'stepId',
  'primitive',
  'targetRole',
  'parameters',
  'checkpoint',
] as const;
export const WORKFLOW_STEP_KEYS = WORKFLOW_STEP_KEYS_V2;
export const WORKFLOW_STEP_PARAMETER_KEYS = ['name', 'operation', 'parameter'] as const;

/**
 * Closed checkpoint vocabulary (WP5 Slice 5-C step schema v2, supervisor R1).
 * A checkpoint is declarative data naming the Action-Cycle boundary a
 * `fileInput.set` step completes; it is not executable logic and it never
 * carries a resource, path, digest, or expected result.
 */
export const WORKFLOW_CHECKPOINTS = ['after-upload-current', 'after-replacement-current'] as const;
export type WorkflowCheckpoint = (typeof WORKFLOW_CHECKPOINTS)[number];

/** Binds one primitive parameter to one approved-operation parameter. */
export interface WorkflowStepParameterBinding {
  name: string;
  operation: string;
  parameter: string;
}

export interface WorkflowStep {
  stepId: string;
  primitive: WorkflowPrimitive;
  targetRole: string;
  parameters: readonly WorkflowStepParameterBinding[];
  /** Present only in step schema v2; names one Action-Cycle checkpoint. */
  checkpoint?: WorkflowCheckpoint;
}

export interface WorkflowStepEntry {
  workflowId: string;
  capability: Capability;
  steps: readonly WorkflowStep[];
}

export interface WorkflowStepCatalogue {
  schemaVersion: number;
  stepSchemaVersion: number;
  workflows: readonly WorkflowStepEntry[];
}
