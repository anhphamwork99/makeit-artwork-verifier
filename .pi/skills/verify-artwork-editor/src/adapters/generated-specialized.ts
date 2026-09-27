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
import {
  CROSSWORD_REQUIRED_CHECKS,
  CROSSWORD_SEMANTIC_PROFILE,
} from '../contracts/crossword-observation';

/**
 * Generated-specialized Subject adapter v2 (ADR 0017 R4–R8; ADR 0018 CR5/CR6).
 *
 * This is the only deliberate place where generated-layer semantic roles are
 * interpreted. It resolves a generated-layer role at the explicit lifecycle
 * phase declared by the role contract:
 *
 * - `pre-action`: only `pre-action-existing` roles are evaluated. A create host
 *   Layout resolves to the exact active Layout and exposes no hit-point
 *   requirement, because the workflow pointer-targets public controls, not the
 *   Layout.
 * - `post-action`: only `post-action-new` roles are evaluated, from the exact
 *   set difference between the post-action and sealed pre-action active-host
 *   child ids of the declared kind. Selection, array position, id prefix, and
 *   global search never establish identity.
 *
 * The generic engine selects this adapter by catalogue data through
 * `adapters/registry.ts`; nothing here is reachable by a Subject-name,
 * scenario, or variant branch. Role resolution never guesses: zero matches is
 * `unresolved`, more than one is `ambiguous`, one unmounted element is
 * `unmounted`, and only exactly one mounted element is `resolved`.
 */

export const GENERATED_SPECIALIZED_ADAPTER_ID = 'generated-specialized';

/** Compatibility version this adapter implements. */
export const GENERATED_SPECIALIZED_COMPATIBILITY_VERSION = 2;

/** Readiness profile the generated-Crossword drive uses. */
export const CROSSWORD_GENERATION_READINESS_PROFILE = 'crossword-generation-action-cycle-v1';

/** Oracle profile the generated-Crossword drive uses. */
export const CROSSWORD_ORACLE_PROFILE = 'crossword-determinism-v1';

/** The one generated-semantic profile this adapter recognises. */
export const GENERATED_CROSSWORD_SEMANTIC_PROFILE = CROSSWORD_SEMANTIC_PROFILE;

/** The six required checks the generated-Crossword Oracle profile evaluates. */
export const CROSSWORD_ADAPTER_REQUIRED_CHECKS = CROSSWORD_REQUIRED_CHECKS;

function matchRole(
  role: SemanticTargetRole,
  input: AdapterResolveTargetsInput,
): { matches: AdapterElementFact[] } {
  const matches = input.elements.filter((element) => {
    if (element.kind !== role.kind) return false;
    if (role.layoutRole === 'active') {
      // A child of the active Layout, or the active Layout element itself: the
      // extra identity check is generic (the element whose id is the active
      // layout id), so no application-kind literal is needed here.
      return element.parentId === input.activeLayoutId || element.id === input.activeLayoutId;
    }
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

function resolved(
  role: SemanticTargetRole,
  match: AdapterElementFact,
  matchedElementIds: readonly string[],
): TargetResolution {
  return {
    role: role.role,
    status: 'resolved',
    matchCount: 1,
    matchedElementIds,
    target: {
      role: role.role,
      elementId: match.id,
      kind: match.kind,
      parentId: match.parentId,
      ...(role.geometryProfile === undefined ? {} : { geometryProfile: role.geometryProfile }),
      ...(role.semanticProfile === undefined ? {} : { semanticProfile: role.semanticProfile }),
    },
    detail: detailFor(role, 'resolved', [match]),
  };
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
  if (!match.mounted || match.hidden === true) {
    return {
      role: role.role,
      status: 'unmounted',
      matchCount: 1,
      matchedElementIds,
      target: null,
      detail: `${detailFor(role, 'unmounted', matches)}${
        match.hidden === true ? ' It is hidden.' : ''
      }`,
    };
  }
  return resolved(role, match, matchedElementIds);
}

/**
 * Post-action resolution by exact active-host set difference (ADR 0017 CR6). A
 * `post-action-new` role resolves only to element ids that are children of the
 * sealed active host, of the declared kind, and were absent from the sealed
 * pre-action set. Exactly one new id is required.
 */
function resolveCreatedTarget(
  role: SemanticTargetRole,
  input: AdapterResolveTargetsInput,
): TargetResolution {
  const baseline = input.baseline;
  if (baseline === undefined || baseline.activeLayoutId !== input.activeLayoutId) {
    return {
      role: role.role,
      status: 'unresolved',
      matchCount: 0,
      matchedElementIds: [],
      target: null,
      detail: `Semantic target role "${role.role}" is post-action and requires the sealed pre-action baseline on the same active host.`,
    };
  }
  const preExisting = new Set(baseline.activeLayoutChildIdsByKind[role.kind] ?? []);
  const postAction = input.elements.filter(
    (element) => element.kind === role.kind && element.parentId === baseline.activeLayoutId,
  );
  const newMatches = postAction.filter((element) => !preExisting.has(element.id));
  const matchedElementIds = newMatches.map((element) => element.id);
  if (newMatches.length === 0) {
    return {
      role: role.role,
      status: 'unresolved',
      matchCount: 0,
      matchedElementIds,
      target: null,
      detail: `Semantic target role "${role.role}" resolved no newly created ${role.kind} child of the active host; no create transition was observed.`,
    };
  }
  if (newMatches.length > 1) {
    return {
      role: role.role,
      status: 'ambiguous',
      matchCount: newMatches.length,
      matchedElementIds,
      target: null,
      detail: `Semantic target role "${role.role}" resolved ${newMatches.length} newly created ${role.kind} children of the active host; exactly one is required.`,
    };
  }
  const match = newMatches[0] as AdapterElementFact;
  if (!match.mounted || match.hidden === true) {
    return {
      role: role.role,
      status: 'unmounted',
      matchCount: 1,
      matchedElementIds,
      target: null,
      detail: `${detailFor(role, 'unmounted', newMatches)} The exact created target is not mounted and visible.`,
    };
  }
  // The created target must remain a child of the active host: a wrong-parent
  // addition is unusable harness authority, never a guessed target.
  if (match.parentId !== baseline.activeLayoutId) {
    return {
      role: role.role,
      status: 'unresolved',
      matchCount: 1,
      matchedElementIds,
      target: null,
      detail: `Semantic target role "${role.role}" resolved a new ${role.kind} outside the active host, which is unusable.`,
    };
  }
  return resolved(role, match, matchedElementIds);
}

function wantsCrosswordSemantics(roles: readonly SemanticTargetRole[]): boolean {
  return roles.some(
    (role) =>
      role.semanticProfile !== undefined &&
      role.semanticProfile === GENERATED_CROSSWORD_SEMANTIC_PROFILE,
  );
}

const GENERATED_SPECIALIZED_ADAPTER: SubjectAdapter = {
  adapterId: GENERATED_SPECIALIZED_ADAPTER_ID,
  compatibilityVersion: GENERATED_SPECIALIZED_COMPATIBILITY_VERSION,

  resolveTargets(input: AdapterResolveTargetsInput): readonly TargetResolution[] {
    return rolesForPhase(input.roles, input.phase).map((role) =>
      input.phase === 'post-action' ? resolveCreatedTarget(role, input) : resolveOne(role, input),
    );
  },

  validatePreconditions(input: AdapterPreconditionInput): readonly AdapterPreconditionProblem[] {
    const problems: AdapterPreconditionProblem[] = [];
    for (const resolution of input.resolutions) {
      if (resolution.status !== 'resolved' || resolution.target === null) continue;
      const elementId = resolution.target.elementId;
      const geometry = input.geometry[elementId] ?? null;
      if (geometry === null) {
        problems.push({
          code: 'UNUSABLE_EVIDENCE',
          detail: `No live geometry was read for resolved target "${elementId}".`,
          context: { role: resolution.role, elementId },
        });
        continue;
      }
      if (!geometry.mounted) {
        problems.push({
          code: 'TARGET_NOT_MOUNTED',
          detail: `Resolved target "${elementId}" is not mounted on the live Stage.`,
          context: { role: resolution.role, elementId },
        });
        continue;
      }
      if (!geometry.visible || !geometry.listening) {
        problems.push({
          code: 'UNUSABLE_EVIDENCE',
          detail: `Resolved target "${elementId}" is not visible and listening (visible=${String(
            geometry.visible,
          )}, listening=${String(geometry.listening)}).`,
          context: { role: resolution.role, elementId },
        });
        continue;
      }
      // A role the workflow does not pointer-target (for example a create host
      // Layout) is not required to expose a live hit point (ADR 0018 CR5).
      const pointerRoles = input.pointerRoles;
      const requiresHitPoint = pointerRoles === undefined || pointerRoles.includes(resolution.role);
      if (requiresHitPoint && !geometry.hasHitPoint) {
        problems.push({
          code: 'HIT_POINT_UNAVAILABLE',
          detail: `Resolved target "${elementId}" exposes no live hit point inside its listening region.`,
          context: { role: resolution.role, elementId },
        });
      }
    }
    return problems;
  },

  contributeReadiness(input: AdapterReadinessInput): AdapterReadinessContribution {
    const crossword = wantsCrosswordSemantics(input.roles);
    const targetIds = input.resolutions
      .filter((resolution) => resolution.status === 'resolved' && resolution.target !== null)
      .map((resolution) => (resolution.target as ResolvedTarget).elementId);
    if (crossword) {
      // ADR 0017 CR5: before the native action the created target does not
      // exist, so readiness is declared from the role contract with no target
      // ids; only after exact created-target resolution does it become
      // target-aware.
      const createdTargetIds =
        input.phase === 'post-action'
          ? input.resolutions
              .filter(
                (resolution) =>
                  resolution.status === 'resolved' &&
                  resolution.target !== null &&
                  resolution.target.semanticProfile === GENERATED_CROSSWORD_SEMANTIC_PROFILE,
              )
              .map((resolution) => (resolution.target as ResolvedTarget).elementId)
          : [];
      return {
        profileId: CROSSWORD_GENERATION_READINESS_PROFILE,
        targetIds: createdTargetIds,
        targetAware: createdTargetIds.length > 0,
      };
    }
    return {
      profileId: 'action-cycle-v1',
      targetIds,
      targetAware: targetIds.length > 0,
    };
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
    const checks = new Set(requiredChecks);
    if (
      resolutions.some(
        (resolution) =>
          resolution.target !== null &&
          resolution.target.semanticProfile === GENERATED_CROSSWORD_SEMANTIC_PROFILE,
      )
    ) {
      for (const check of CROSSWORD_ADAPTER_REQUIRED_CHECKS) checks.add(check);
    }
    return { capability, targets, requiredChecks: [...checks].sort() };
  },

  diagnostics(): AdapterDiagnostics {
    return {
      adapterId: GENERATED_SPECIALIZED_ADAPTER_ID,
      compatibilityVersion: GENERATED_SPECIALIZED_COMPATIBILITY_VERSION,
      targetRoles: ['host', 'created-target'],
    };
  },
};

export function generatedSpecializedAdapter(): SubjectAdapter {
  return GENERATED_SPECIALIZED_ADAPTER;
}
