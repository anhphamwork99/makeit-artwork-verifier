import { isCapability } from '../contracts/discriminants';
import {
  WORKFLOW_PRIMITIVES,
  WORKFLOW_CHECKPOINTS,
  WORKFLOW_STEP_KEYS_V2,
  WORKFLOW_STEP_PARAMETER_KEYS,
  type WorkflowCheckpoint,
  type WorkflowStep,
  type WorkflowStepCatalogue,
  type WorkflowStepEntry,
  type WorkflowStepParameterBinding,
  type WorkflowPrimitive,
} from '../contracts/workflows';
import {
  WORKFLOW_CATALOGUE_V4_SCHEMA_VERSION,
  WORKFLOW_STEP_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * Declarative workflow-step catalogue parsing (WP5 Slice 5-A).
 *
 * The parser is deliberately hostile to executable authoring: the step and
 * parameter key sets are closed, the primitive vocabulary is closed, and a
 * parameter binding may only name an operation parameter. Anything that could
 * smuggle behaviour (a script, a literal coordinate, a sleep, a predicate, a
 * callback) is structurally rejected before launch.
 */

export type WorkflowStepErrorCode =
  | 'WORKFLOW_STEP_CATALOGUE_INVALID'
  | 'WORKFLOW_STEP_CATALOGUE_SCHEMA_UNSUPPORTED'
  | 'WORKFLOW_STEP_CATALOGUE_DUPLICATE'
  | 'WORKFLOW_STEP_UNKNOWN'
  | 'WORKFLOW_STEP_FORBIDDEN_KEY';

export class WorkflowStepError extends Error {
  readonly code: WorkflowStepErrorCode;

  constructor(code: WorkflowStepErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowStepError';
    this.code = code;
  }
}

/** Authoring keys that can never appear on a declarative step. */
export const WORKFLOW_STEP_FORBIDDEN_KEYS = [
  'callback',
  'code',
  'coordinates',
  'delay',
  'evaluate',
  'fn',
  'handler',
  'method',
  'predicate',
  'script',
  'sleep',
  'timeout',
  'wait',
  'x',
  'y',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: WorkflowStepErrorCode, message: string): never {
  throw new WorkflowStepError(code, message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function rejectForbiddenKeys(record: Record<string, unknown>, label: string): void {
  const forbidden = Object.keys(record).filter((key) =>
    (WORKFLOW_STEP_FORBIDDEN_KEYS as readonly string[]).includes(key),
  );
  if (forbidden.length > 0) {
    fail(
      'WORKFLOW_STEP_FORBIDDEN_KEY',
      `${label} declares forbidden key(s): ${forbidden.join(', ')}`,
    );
  }
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  rejectForbiddenKeys(record, label);
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label} has unknown keys: ${unknown.join(', ')}`);
  }
}

function parseParameter(raw: unknown, label: string): WorkflowStepParameterBinding {
  if (!isRecord(raw)) fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label} must be an object`);
  requireExactKeys(raw, WORKFLOW_STEP_PARAMETER_KEYS, label);
  // A literal coordinate/value is the one thing a parameter binding must never
  // be: it is data supplied by the approved operation, not by the workflow.
  const operation = requireString(raw.operation, `${label}.operation`);
  return {
    name: requireString(raw.name, `${label}.name`),
    operation,
    parameter: requireString(raw.parameter, `${label}.parameter`),
  };
}

function parseStep(raw: unknown, label: string): WorkflowStep {
  if (!isRecord(raw)) fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label} must be an object`);
  requireExactKeys(raw, WORKFLOW_STEP_KEYS_V2, label);
  const primitive = requireString(raw.primitive, `${label}.primitive`);
  if (!(WORKFLOW_PRIMITIVES as readonly string[]).includes(primitive)) {
    fail(
      'WORKFLOW_STEP_UNKNOWN',
      `${label}.primitive "${primitive}" is not in the closed primitive vocabulary (${WORKFLOW_PRIMITIVES.join(', ')})`,
    );
  }
  if (!Array.isArray(raw.parameters)) {
    fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label}.parameters must be an array`);
  }
  let checkpoint: WorkflowCheckpoint | undefined;
  if (raw.checkpoint !== undefined) {
    const value = requireString(raw.checkpoint, `${label}.checkpoint`);
    if (!(WORKFLOW_CHECKPOINTS as readonly string[]).includes(value)) {
      fail(
        'WORKFLOW_STEP_UNKNOWN',
        `${label}.checkpoint "${value}" is not in the closed checkpoint vocabulary (${WORKFLOW_CHECKPOINTS.join(', ')})`,
      );
    }
    checkpoint = value as WorkflowCheckpoint;
  }
  return {
    stepId: requireString(raw.stepId, `${label}.stepId`),
    primitive: primitive as WorkflowPrimitive,
    targetRole: requireString(raw.targetRole, `${label}.targetRole`),
    parameters: raw.parameters.map((entry, index) =>
      parseParameter(entry, `${label}.parameters[${index}]`),
    ),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

function parseWorkflowEntry(raw: unknown, index: number): WorkflowStepEntry {
  const label = `workflows[${index}]`;
  if (!isRecord(raw)) fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label} must be an object`);
  requireExactKeys(raw, ['workflowId', 'capability', 'steps'], label);
  if (!isCapability(raw.capability)) {
    fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label}.capability is not a declared Capability`);
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    fail('WORKFLOW_STEP_CATALOGUE_INVALID', `${label}.steps must declare at least one step`);
  }
  return {
    workflowId: requireString(raw.workflowId, `${label}.workflowId`),
    capability: raw.capability,
    steps: raw.steps.map((entry, stepIndex) => parseStep(entry, `${label}.steps[${stepIndex}]`)),
  };
}

export function parseWorkflowStepCatalogue(raw: unknown): WorkflowStepCatalogue {
  if (!isRecord(raw))
    fail('WORKFLOW_STEP_CATALOGUE_INVALID', 'Workflow step catalogue must be an object');
  if (raw.schemaVersion !== WORKFLOW_CATALOGUE_V4_SCHEMA_VERSION) {
    fail(
      'WORKFLOW_STEP_CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported workflow step catalogue schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (raw.stepSchemaVersion !== WORKFLOW_STEP_SCHEMA_VERSION) {
    fail(
      'WORKFLOW_STEP_CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported workflow step schema version: ${String(raw.stepSchemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.workflows) || raw.workflows.length === 0) {
    fail('WORKFLOW_STEP_CATALOGUE_INVALID', 'Workflow step catalogue must declare workflows');
  }
  const workflows = raw.workflows.map(parseWorkflowEntry);
  const ids = workflows.map((entry) => entry.workflowId);
  if (new Set(ids).size !== ids.length) {
    fail(
      'WORKFLOW_STEP_CATALOGUE_DUPLICATE',
      'Workflow step catalogue declares a duplicate workflowId',
    );
  }
  // A checkpoint is a unique Action-Cycle boundary inside one workflow, so a
  // silent duplicate boundary can never collapse two cycles into one.
  for (const entry of workflows) {
    const checkpoints = entry.steps
      .map((step) => step.checkpoint)
      .filter((value): value is WorkflowCheckpoint => value !== undefined);
    if (new Set(checkpoints).size !== checkpoints.length) {
      fail(
        'WORKFLOW_STEP_CATALOGUE_DUPLICATE',
        `Workflow "${entry.workflowId}" declares a duplicate checkpoint`,
      );
    }
  }
  return {
    schemaVersion: raw.schemaVersion,
    stepSchemaVersion: raw.stepSchemaVersion,
    workflows: workflows.sort((left, right) => (left.workflowId < right.workflowId ? -1 : 1)),
  };
}

/** Resolves the delivered steps for one workflow, or `null` when undeclared. */
export function resolveWorkflowSteps(
  catalogue: WorkflowStepCatalogue,
  workflowId: string,
): WorkflowStepEntry | null {
  return catalogue.workflows.find((entry) => entry.workflowId === workflowId) ?? null;
}
