import type {
  AdapterDiagnostics,
  AdapterElementFact,
  AdapterNormalizedResult,
  AdapterObservationVariable,
  AdapterPreconditionInput,
  AdapterPreconditionProblem,
  AdapterReadinessContribution,
  AdapterReadinessInput,
  AdapterResolveTargetsInput,
  ResolvedTarget,
  SemanticTargetRole,
  SubjectAdapter,
  TargetResolution,
} from '../contracts/adapter';
import { rolesForPhase } from '../contracts/adapter';
import type { Capability } from '../contracts/discriminants';

/**
 * Default (family-level) Subject adapter v1 (specification 6.3; WP5 Slice 5-F).
 *
 * This is the generic adapter for subjects whose binding needs no
 * application-kind-specialized semantics. It resolves declared semantic roles
 * by kind against the live document, performs no typed-geometry or generated
 * precondition, and contributes the base `action-cycle-v1` readiness identity.
 *
 * Whole-document capabilities such as cross-subject history select their own
 * binding-declared readiness/Oracle profile in the dedicated drive, so this
 * adapter never needs a capability branch. It contains no Subject-name, family,
 * application-kind, scenario, or variant branch.
 */

export const DEFAULT_ADAPTER_ID = 'default';
export const DEFAULT_COMPATIBILITY_VERSION = 1;

function matchRole(
  role: SemanticTargetRole,
  input: AdapterResolveTargetsInput,
): { matches: AdapterElementFact[] } {
  const matches = input.elements.filter((element) => {
    if (element.kind !== role.kind) return false;
    if (role.layoutRole === 'active') return element.parentId === input.activeLayoutId;
    return true;
  });
  return { matches };
}

function detailFor(
  role: SemanticTargetRole,
  status: TargetResolution['status'],
  matches: readonly AdapterElementFact[],
): string {
  switch (status) {
    case 'ambiguous':
      return `Semantic target role "${role.role}" matched ${matches.length} elements; exactly one is required.`;
    case 'unresolved':
      return `Semantic target role "${role.role}" matched no element.`;
    case 'unmounted':
      return `Semantic target role "${role.role}" matched element "${matches[0]?.id ?? 'unknown'}" but it is not mounted.`;
    case 'resolved':
      return `Semantic target role "${role.role}" resolved exactly one mounted element.`;
  }
}

function resolveOne(role: SemanticTargetRole, input: AdapterResolveTargetsInput): TargetResolution {
  const { matches } = matchRole(role, input);
  const matchedElementIds = matches.map((element) => element.id);
  if (matches.length === 0) {
    return {
      role: role.role,
      status: 'unresolved',
      matchCount: 0,
      matchedElementIds,
      target: null,
      detail: detailFor(role, 'unresolved', matches),
    };
  }
  if (matches.length > 1) {
    return {
      role: role.role,
      status: 'ambiguous',
      matchCount: matches.length,
      matchedElementIds,
      target: null,
      detail: detailFor(role, 'ambiguous', matches),
    };
  }
  const match = matches[0] as AdapterElementFact;
  if (!match.mounted) {
    return {
      role: role.role,
      status: 'unmounted',
      matchCount: 1,
      matchedElementIds,
      target: null,
      detail: detailFor(role, 'unmounted', matches),
    };
  }
  const target: ResolvedTarget = {
    role: role.role,
    elementId: match.id,
    kind: match.kind,
    parentId: match.parentId,
    ...(role.geometryProfile === undefined ? {} : { geometryProfile: role.geometryProfile }),
    ...(role.semanticProfile === undefined ? {} : { semanticProfile: role.semanticProfile }),
  };
  return {
    role: role.role,
    status: 'resolved',
    matchCount: 1,
    matchedElementIds,
    target,
    detail: detailFor(role, 'resolved', matches),
  };
}

const DEFAULT_ADAPTER: SubjectAdapter = {
  adapterId: DEFAULT_ADAPTER_ID,
  compatibilityVersion: DEFAULT_COMPATIBILITY_VERSION,

  resolveTargets(input: AdapterResolveTargetsInput): readonly TargetResolution[] {
    return rolesForPhase(input.roles, input.phase).map((role) => resolveOne(role, input));
  },

  validatePreconditions(_input: AdapterPreconditionInput): readonly AdapterPreconditionProblem[] {
    return [];
  },

  contributeReadiness(input: AdapterReadinessInput): AdapterReadinessContribution {
    const targetIds = input.resolutions
      .filter((resolution) => resolution.status === 'resolved' && resolution.target !== null)
      .map((resolution) => (resolution.target as ResolvedTarget).elementId);
    return { profileId: 'action-cycle-v1', targetIds, targetAware: targetIds.length > 0 };
  },

  normalizeResult(
    resolutions: readonly TargetResolution[],
    capability: Capability,
    requiredChecks: readonly string[],
  ): AdapterNormalizedResult {
    const targets: AdapterObservationVariable[] = resolutions
      .filter((resolution) => resolution.target !== null)
      .map((resolution) => ({
        role: resolution.role,
        elementId: (resolution.target as ResolvedTarget).elementId,
      }));
    return { capability, targets, requiredChecks: [...requiredChecks] };
  },

  diagnostics(): AdapterDiagnostics {
    return {
      adapterId: DEFAULT_ADAPTER_ID,
      compatibilityVersion: DEFAULT_COMPATIBILITY_VERSION,
      targetRoles: [],
    };
  },
};

/** Returns the default adapter implementation. */
export function defaultAdapter(): SubjectAdapter {
  return DEFAULT_ADAPTER;
}
