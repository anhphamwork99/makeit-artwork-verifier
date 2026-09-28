import type { CapabilityBinding, ResolvedSubject } from '../contracts/catalogues';
import type { ResolvedRoute } from '../contracts/case-model';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { Capability } from '../contracts/discriminants';

/**
 * Adapter and workflow routing (decisions 0003 and 0007 stage 7).
 *
 * Routing is a pure lookup against the Subject's resolved capability bindings.
 * There is no branch on Subject identity, family, application kind, or renderer
 * flag anywhere in this module: a Subject selects exactly one adapter for the
 * whole Subject, and each binding selects its workflow within that adapter.
 */

export type RouteResolution =
  | { ok: true; binding: CapabilityBinding }
  | { ok: false; finding: DiagnosticRecord };

export function resolveCapabilityBinding(
  subject: ResolvedSubject,
  capability: Capability,
): RouteResolution {
  const binding = subject.capabilityBindings.find((entry) => entry.capability === capability);
  if (!binding) {
    return {
      ok: false,
      finding: createDiagnostic(
        'CAPABILITY_UNSUPPORTED',
        `Subject declares no binding for Capability "${capability}"`,
        { subjectId: subject.subjectId, context: { capability } },
      ),
    };
  }
  return { ok: true, binding };
}

export function resolveAdapterForSubject(subject: ResolvedSubject): ResolvedSubject['adapter'] {
  return { ...subject.adapter };
}

export type RouteResult =
  | { ok: true; route: ResolvedRoute }
  | { ok: false; finding: DiagnosticRecord };

export function resolveRoute(subject: ResolvedSubject, capability: Capability): RouteResult {
  const resolution = resolveCapabilityBinding(subject, capability);
  if (!resolution.ok) return { ok: false, finding: resolution.finding };

  const adapter = resolveAdapterForSubject(subject);

  return {
    ok: true,
    route: {
      subjectId: subject.subjectId,
      adapterId: adapter.adapterId,
      adapterCompatibilityVersion: adapter.compatibilityVersion,
      workflowId: resolution.binding.workflowId,
      capability: resolution.binding.capability,
      checks: [...resolution.binding.checks].sort(),
    },
  };
}

export interface VariantPolicyEvaluation {
  status: 'declared' | 'unknown';
  /** Blocking or warning finding raised for the observed variant, if any. */
  finding: DiagnosticRecord | null;
  /** True when the undeclared variant prohibits execution for this binding. */
  blocked: boolean;
  /** True when registry coverage must be reported as incomplete. */
  coverageIncomplete: boolean;
}

/**
 * Unknown-variant policy (decision 0002 "Variants", decision 0003 "Unknown
 * variants"). An undeclared variant is always a coverage warning; it only
 * blocks execution when the selected adapter has no validated
 * variant-independence declaration for this Capability binding.
 */
export function evaluateVariantPolicy(
  subject: ResolvedSubject,
  binding: CapabilityBinding,
  variant: string | null,
): VariantPolicyEvaluation {
  if (variant === null || subject.variants.includes(variant)) {
    return { status: 'declared', finding: null, blocked: false, coverageIncomplete: false };
  }

  const blocked = !binding.variantIndependent;

  return {
    status: 'unknown',
    finding: blocked
      ? createDiagnostic(
          'SUBJECT_VARIANT_UNSUPPORTED',
          `Undeclared variant "${variant}" cannot execute Capability "${binding.capability}" without a validated variant-independence declaration`,
          { subjectId: subject.subjectId, context: { capability: binding.capability, variant } },
        )
      : createDiagnostic('SUBJECT_VARIANT_UNKNOWN', `Observed undeclared variant "${variant}"`, {
          subjectId: subject.subjectId,
          context: { capability: binding.capability, variant },
        }),
    blocked,
    coverageIncomplete: true,
  };
}
