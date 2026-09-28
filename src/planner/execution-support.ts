/**
 * Delivered-runtime execution support (WP5 Slice 5-F boundary).
 *
 * Planning is fully contract-complete for every delivered binding, but the
 * diagnostic *runtime* — the owned browser drive that seals a fixture, performs
 * the native action, captures the coherent observation, evaluates the Oracle,
 * and writes the public run record — is delivered only for the adapters listed
 * here, plus the closed set of whole-document workflows listed below.
 *
 * A binding whose adapter/workflow has no delivered runtime is plan-valid and
 * launchable, yet must fail closed at the pre-launch boundary with an explicit
 * `EXECUTION_NOT_YET_SUPPORTED` gate rather than launch a half-wired drive. The
 * gate is data-routed on the catalogue-selected adapter id (and, for the generic
 * default adapter, the resolved workflow id), so it contains no Subject-name,
 * family, application-kind, scenario, or variant branch.
 */

/** Adapter ids whose diagnostic runtime orchestration is delivered. */
export const DELIVERED_EXECUTION_ADAPTERS: readonly string[] = Object.freeze([
  'image-specialized',
  'object-specialized',
  'text-specialized',
  'generated-specialized',
]);

/**
 * Workflow-scoped delivery for an adapter that is generic rather than
 * semantically specialized. The `default` adapter resolves roles generically,
 * and the cross-subject history and frontend serialize/restore drives are
 * delivered through it; every other default-adapter binding fails closed exactly
 * as before.
 */
export const DELIVERED_ADAPTER_WORKFLOWS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    default: Object.freeze(['shared.history', 'shared.serialize']),
  });

export interface ExecutionSupportDecision {
  adapterId: string;
  workflowId: string | null;
  supported: boolean;
  detail: string;
}

/**
 * Resolves whether the diagnostic runtime can execute a plan routed through
 * `adapterId` for `workflowId`. An undelivered adapter/workflow is a deliberate
 * deferral, never a harness failure and never a product `BUG`.
 */
export function resolveExecutionSupport(
  adapterId: string,
  workflowId?: string,
): ExecutionSupportDecision {
  const scoped = workflowId === undefined ? [] : (DELIVERED_ADAPTER_WORKFLOWS[adapterId] ?? []);
  const supported =
    DELIVERED_EXECUTION_ADAPTERS.includes(adapterId) ||
    (workflowId !== undefined && scoped.includes(workflowId));
  return {
    adapterId,
    workflowId: workflowId ?? null,
    supported,
    detail: supported
      ? `Diagnostic runtime execution is delivered for adapter "${adapterId}"${workflowId === undefined ? '' : ` workflow "${workflowId}"`}.`
      : `Diagnostic runtime execution is not yet supported for adapter "${adapterId}"${workflowId === undefined ? '' : ` workflow "${workflowId}"`}: the binding is fully planned and launchable, but its observation/capture/Oracle orchestration and public run-record writer are deferred, so no half-wired runtime is launched.`,
  };
}
