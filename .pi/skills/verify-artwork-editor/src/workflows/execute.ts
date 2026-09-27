import type { CaseIntentOperation } from '../contracts/case-model';
import type { TargetResolution, ResolvedTarget } from '../contracts/adapter';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { WorkflowStep } from '../contracts/workflows';
import { RESOURCE_USE_OPERATION } from '../contracts/resources';
import {
  controlAccessibleName,
  dialogAccessibleName,
  FILE_INPUT_ACCEPT,
} from '../browser/public-controls';

/**
 * Declarative workflow-step executor (specification 6.4; WP5 Slice 5-A).
 *
 * The executor interprets only the closed primitive vocabulary and resolves
 * every primitive parameter from the *approved operation* the case declared. An
 * unknown primitive, an unresolvable operation parameter, or an unresolved
 * target role is a pre-action `HARNESS_BLOCKED`; the executor never invents a
 * coordinate, never runs a script, and never sleeps.
 */

export interface PointerDragRequest {
  from: { x: number; y: number };
  dx: number;
  dy: number;
  targetElementId: string;
}

export interface PointerClickRequest {
  point: { x: number; y: number };
  targetElementId: string;
}

export interface ControlActivateRequest {
  /** Exact accessible name of the control to activate. */
  control: string;
}

export interface KeyboardPressRequest {
  key: string;
}

export interface FileInputSetRequest {
  /** Exact accessible name of the open dialog that owns the file input. */
  dialogAccessibleName: string;
  /** Exact required `accept` value. */
  accept: string;
  /** Declared fixture resource role, resolved to a `ResolvedResource` by the runtime. */
  resourceRole: string;
}

export interface StepActionLog {
  stepId: string;
  primitive: WorkflowStep['primitive'];
  targetElementId: string | null;
  detail: string;
  at: string;
}

/** A primitive handler's result; a refusal carries its precise diagnostic code. */
export interface WorkflowPrimitiveResult {
  ok: boolean;
  detail: string;
  code?: DiagnosticCode;
}

/** Native handlers supplied by the browser layer; the executor owns no browser. */
export interface WorkflowPrimitiveHandlers {
  pointerDrag(request: PointerDragRequest): Promise<WorkflowPrimitiveResult>;
  pointerClick(request: PointerClickRequest): Promise<WorkflowPrimitiveResult>;
  controlActivate(request: ControlActivateRequest): Promise<WorkflowPrimitiveResult>;
  keyboardPress(request: KeyboardPressRequest): Promise<WorkflowPrimitiveResult>;
  fileInputSet(request: FileInputSetRequest): Promise<WorkflowPrimitiveResult>;
}

export interface ExecuteWorkflowStepsInput {
  steps: readonly WorkflowStep[];
  operation: CaseIntentOperation | undefined;
  resolutions: readonly TargetResolution[];
  /** Live viewport points per resolved target element id (from geometry). */
  points: Readonly<Record<string, { x: number; y: number }>>;
  handlers: WorkflowPrimitiveHandlers;
}

export type ExecuteWorkflowStepsResult =
  | { ok: true; logs: readonly StepActionLog[] }
  | { ok: false; finding: DiagnosticRecord; logs: readonly StepActionLog[] };

/**
 * Declared prefixed workflow target roles (WP5 Slice 5-C).
 *
 * `control:<slug>` names an exact public button; `dialog:<slug>:file` names the
 * native file input inside an exact open dialog. These are role *names*, not
 * element ids, so the executor resolves them through the closed public-control
 * vocabulary rather than the semantic adapter.
 */
export function parseControlRole(role: string): string | null {
  return role.startsWith('control:') ? role.slice('control:'.length) : null;
}

export function parseDialogFileRole(role: string): string | null {
  if (!role.startsWith('dialog:') || !role.endsWith(':file')) return null;
  return role.slice('dialog:'.length, role.length - ':file'.length);
}

function resolveTargetForRole(
  role: string,
  resolutions: readonly TargetResolution[],
): ResolvedTarget | null {
  const resolution = resolutions.find((entry) => entry.role === role);
  return resolution?.status === 'resolved' ? resolution.target : null;
}

function resolveNumericParameter(
  step: WorkflowStep,
  parameterName: string,
  operation: CaseIntentOperation | undefined,
): { ok: true; value: number } | { ok: false; detail: string } {
  const binding = step.parameters.find((entry) => entry.name === parameterName);
  if (!binding)
    return { ok: false, detail: `step "${step.stepId}" declares no "${parameterName}" binding` };
  if (!operation || operation.discriminant !== binding.operation) {
    return {
      ok: false,
      detail: `step "${step.stepId}" binds "${parameterName}" to operation "${binding.operation}" but the case declares "${operation?.discriminant ?? 'no operation'}"`,
    };
  }
  const value = operation.parameters[binding.parameter];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      ok: false,
      detail: `operation "${operation.discriminant}" parameter "${binding.parameter}" is not a finite number`,
    };
  }
  return { ok: true, value };
}

function stepFailure(
  step: WorkflowStep,
  detail: string,
  logs: readonly StepActionLog[],
  code: DiagnosticCode = 'WORKFLOW_STEP_UNKNOWN',
): ExecuteWorkflowStepsResult {
  return {
    ok: false,
    finding: createDiagnostic(code, detail, {
      context: { stepId: step.stepId, primitive: step.primitive },
    }),
    logs,
  };
}

export async function executeWorkflowSteps(
  input: ExecuteWorkflowStepsInput,
): Promise<ExecuteWorkflowStepsResult> {
  if (input.steps.length === 0) {
    return {
      ok: false,
      finding: createDiagnostic(
        'WORKFLOW_STEPS_UNAVAILABLE',
        'The resolved workflow declares no delivered declarative step.',
      ),
      logs: [],
    };
  }

  const logs: StepActionLog[] = [];

  for (const step of input.steps) {
    // ADR 0027 §2.5: the restore marker is executable only by the dedicated
    // restore profile. The generic executor refuses it before any target
    // resolution, point lookup, or primitive handler, and never executes a
    // restore itself.
    if (step.primitive === 'frontend.restore.capture') {
      return stepFailure(
        step,
        'frontend.restore.capture is executable only by the dedicated restore profile.',
        logs,
        'WORKFLOW_STEP_UNKNOWN',
      );
    }

    const controlSlug = parseControlRole(step.targetRole);
    const dialogSlug = parseDialogFileRole(step.targetRole);

    if (controlSlug !== null) {
      if (step.primitive !== 'control.activate') {
        return stepFailure(
          step,
          `step "${step.stepId}" declares a control role but primitive "${step.primitive}".`,
          logs,
        );
      }
      const controlName = controlAccessibleName(controlSlug);
      if (controlName === null) {
        return stepFailure(
          step,
          `step "${step.stepId}" names unknown public control "${controlSlug}".`,
          logs,
        );
      }
      const controlOutcome = await input.handlers.controlActivate({ control: controlName });
      if (!controlOutcome.ok) {
        return stepFailure(step, controlOutcome.detail, logs, controlOutcome.code);
      }
      logs.push({
        stepId: step.stepId,
        primitive: step.primitive,
        targetElementId: null,
        detail: controlOutcome.detail,
        at: new Date().toISOString(),
      });
      continue;
    }

    if (dialogSlug !== null) {
      if (step.primitive !== 'fileInput.set') {
        return stepFailure(
          step,
          `step "${step.stepId}" declares a dialog role but primitive "${step.primitive}".`,
          logs,
        );
      }
      const dialogName = dialogAccessibleName(dialogSlug);
      if (dialogName === null) {
        return stepFailure(
          step,
          `step "${step.stepId}" names unknown dialog "${dialogSlug}".`,
          logs,
        );
      }
      const resourceBinding = step.parameters.find(
        (entry) => entry.name === 'resource' && entry.operation === RESOURCE_USE_OPERATION,
      );
      if (!resourceBinding) {
        return stepFailure(
          step,
          `step "${step.stepId}" declares no resource.use binding for its file input.`,
          logs,
        );
      }
      const fileOutcome = await input.handlers.fileInputSet({
        dialogAccessibleName: dialogName,
        accept: FILE_INPUT_ACCEPT,
        resourceRole: resourceBinding.parameter,
      });
      if (!fileOutcome.ok) {
        return stepFailure(step, fileOutcome.detail, logs, fileOutcome.code);
      }
      logs.push({
        stepId: step.stepId,
        primitive: step.primitive,
        targetElementId: null,
        detail: fileOutcome.detail,
        at: new Date().toISOString(),
      });
      continue;
    }

    const target = resolveTargetForRole(step.targetRole, input.resolutions);
    if (!target) {
      return stepFailure(
        step,
        `step "${step.stepId}" requires a resolved target role "${step.targetRole}" but it is not resolved.`,
        logs,
      );
    }

    let outcome: WorkflowPrimitiveResult;
    const point = input.points[target.elementId] ?? null;
    if (point === null) {
      return stepFailure(
        step,
        `step "${step.stepId}" has no live viewport point for target "${target.elementId}".`,
        logs,
      );
    }
    switch (step.primitive) {
      case 'pointer.drag': {
        const dx = resolveNumericParameter(step, 'dx', input.operation);
        if (!dx.ok) return stepFailure(step, dx.detail, logs);
        const dy = resolveNumericParameter(step, 'dy', input.operation);
        if (!dy.ok) return stepFailure(step, dy.detail, logs);
        outcome = await input.handlers.pointerDrag({
          from: point,
          dx: dx.value,
          dy: dy.value,
          targetElementId: target.elementId,
        });
        break;
      }
      case 'pointer.click': {
        outcome = await input.handlers.pointerClick({
          point,
          targetElementId: target.elementId,
        });
        break;
      }
      case 'control.activate': {
        outcome = await input.handlers.controlActivate({ control: step.targetRole });
        break;
      }
      case 'keyboard.press': {
        outcome = await input.handlers.keyboardPress({ key: target.elementId });
        break;
      }
      case 'fileInput.set': {
        outcome = await input.handlers.fileInputSet({
          dialogAccessibleName: step.targetRole,
          accept: FILE_INPUT_ACCEPT,
          resourceRole: target.elementId,
        });
        break;
      }
    }

    if (!outcome.ok) {
      return stepFailure(step, outcome.detail, logs, outcome.code);
    }

    logs.push({
      stepId: step.stepId,
      primitive: step.primitive,
      targetElementId: target.elementId,
      detail: outcome.detail,
      at: new Date().toISOString(),
    });
  }

  return { ok: true, logs };
}
