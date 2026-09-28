import type {
  AdapterElementFact,
  AdapterNormalizedResult,
  AdapterObservationVariable,
  AdapterPreconditionInput,
  AdapterPreconditionProblem,
  AdapterReadinessContribution,
  AdapterReadinessInput,
  AdapterResolveTargetsInput,
  AdapterDiagnostics,
  ResolvedTarget,
  SemanticTargetRole,
  SubjectAdapter,
  TargetResolution,
} from '../contracts/adapter';
import { rolesForPhase } from '../contracts/adapter';
import type { Capability } from '../contracts/discriminants';
import {
  circleControlBounds,
  quadArea,
  quadIsSimple,
  validateTypedGeometry,
  type CircleControlEnvelopeQuadV1,
} from '../contracts/geometry-v2';
import { findWarpedCanonicalLayer } from '../oracles/warped-text';

/**
 * Text-specialized Subject adapter (specification 6.3; WP5 Slice 5-A/5-B).
 *
 * This is the first implemented adapter and the only deliberate place where
 * Text-specific semantic roles are interpreted. It reuses the common
 * role-resolution behaviour for ordinary `move` and adds the typed
 * circle-control-envelope requirements for a role that declares
 * `geometryProfile: circle-control-envelope-quad-v1`. The generic engine selects
 * it by catalogue data through `adapters/registry.ts`; nothing here is reachable
 * by a Subject-name, scenario, or variant branch.
 *
 * Role resolution never guesses: a role that matches zero elements is
 * `unresolved`, more than one is `ambiguous`, one unmounted element is
 * `unmounted`, and only exactly one mounted element is `resolved`.
 */

/** The one typed geometry representation profile this adapter requires. */
export const CIRCLE_ENVELOPE_GEOMETRY_PROFILE = 'circle-control-envelope-quad-v1';

/** Readiness profile the typed warped Text drive uses. */
export const WARPED_TEXT_READINESS_PROFILE = 'warped-text-action-cycle-v1';

/** Added required check for the typed circle envelope profile. */
export const WARPED_TEXT_ENVELOPE_CHECK = 'geometry.warp-envelope';

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

function wantsCircleEnvelope(role: string): boolean {
  return role === CIRCLE_ENVELOPE_GEOMETRY_PROFILE;
}

function typedGeometryProblems(
  resolution: TargetResolution,
  input: AdapterPreconditionInput,
): AdapterPreconditionProblem[] {
  const target = resolution.target as ResolvedTarget;
  const elementId = target.elementId;
  const profile = target.geometryProfile;
  if (profile === undefined || !wantsCircleEnvelope(profile)) return [];

  const problems: AdapterPreconditionProblem[] = [];
  const raw = (input.typedGeometry ?? {})[elementId] as
    | {
        geometryV2?: {
          schemaVersion?: unknown;
          representation?: unknown;
          typedProvenance?: unknown;
          cssRatios?: unknown;
        } | null;
      }
    | undefined;
  const typed = raw?.geometryV2 ?? null;
  if (typed === null) {
    problems.push({
      code: 'GEOMETRY_TRANSFORM_INVALID',
      detail: `Resolved target "${elementId}" declares the circle envelope profile but the bridge published no typed geometry schema v2 record.`,
      context: { role: resolution.role, elementId, reason: 'TYPED_GEOMETRY_MISSING' },
    });
    return problems;
  }
  if (typed.schemaVersion !== 2) {
    problems.push({
      code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      detail: `Resolved target "${elementId}" typed geometry schema is ${String(typed.schemaVersion)}, not 2.`,
      context: { role: resolution.role, elementId, reason: 'SCHEMA_VERSION_UNSUPPORTED' },
    });
    return problems;
  }
  const representation = typed.representation as CircleControlEnvelopeQuadV1 | undefined;
  if (!representation || representation.kind !== CIRCLE_ENVELOPE_GEOMETRY_PROFILE) {
    problems.push({
      code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      detail: `Resolved target "${elementId}" does not publish the ${CIRCLE_ENVELOPE_GEOMETRY_PROFILE} representation.`,
      context: { role: resolution.role, elementId, reason: 'REPRESENTATION_KIND_UNSUPPORTED' },
    });
    return problems;
  }
  const provenance = typed.typedProvenance as
    | {
        schemaVersion?: unknown;
        target?: { id?: unknown } | null;
        layout?: { id?: unknown } | null;
      }
    | undefined;
  if (provenance?.target?.id !== elementId) {
    problems.push({
      code: 'GEOMETRY_TARGET_ID_MISMATCH',
      detail: `Resolved target "${elementId}" typed provenance names target "${String(provenance?.target?.id)}".`,
      context: { role: resolution.role, elementId, reason: 'TARGET_ID_MISMATCH' },
    });
    return problems;
  }
  const canonical = input.canonical;
  if (!canonical) {
    problems.push({
      code: 'GEOMETRY_TRANSFORM_INVALID',
      detail: `Resolved target "${elementId}" has no accepted canonical layer facts to validate against.`,
      context: { role: resolution.role, elementId, reason: 'CANONICAL_UNAVAILABLE' },
    });
    return problems;
  }
  if (provenance?.layout?.id !== canonical.expectedLayoutId) {
    problems.push({
      code: 'GEOMETRY_LAYOUT_ID_MISMATCH',
      detail: `Resolved target "${elementId}" typed provenance names Layout "${String(provenance?.layout?.id)}" instead of the accepted parent "${canonical.expectedLayoutId}".`,
      context: { role: resolution.role, elementId, reason: 'LAYOUT_ID_MISMATCH' },
    });
    return problems;
  }
  const layer = findWarpedCanonicalLayer(canonical.layoutItems, elementId);
  if (layer === null || layer.parentLayoutId !== canonical.expectedLayoutId) {
    problems.push({
      code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      detail: `The accepted snapshot does not resolve "${elementId}" as a circle-warped Text child of "${canonical.expectedLayoutId}".`,
      context: { role: resolution.role, elementId, reason: 'CANONICAL_REPRESENTATION_UNSUPPORTED' },
    });
    return problems;
  }
  const validation = validateTypedGeometry({
    schemaVersion: typed.schemaVersion,
    representation,
    provenance,
    ratios: typed.cssRatios,
    expectedControlBounds: circleControlBounds(layer.payload) ?? undefined,
    expectedFlips: { flipX: layer.flipX, flipY: layer.flipY },
  });
  if (!validation.ok) {
    problems.push({
      code: validation.failure.code,
      detail: validation.failure.detail,
      context: {
        role: resolution.role,
        elementId,
        reason: validation.failure.reason,
        ...validation.failure.context,
      },
    });
    return problems;
  }
  if (
    !quadIsSimple(representation.layoutLocal) ||
    !quadIsSimple(representation.browserClientCss) ||
    quadArea(representation.layoutLocal) <= 1
  ) {
    problems.push({
      code: 'GEOMETRY_TRANSFORM_INVALID',
      detail: `Resolved target "${elementId}" publishes a degenerate, non-convex, or self-intersecting circle envelope.`,
      context: { role: resolution.role, elementId, reason: 'ENVELOPE_DEGENERATE' },
    });
  }
  return problems;
}

const TEXT_SPECIALIZED_ADAPTER: SubjectAdapter = {
  adapterId: 'text-specialized',
  compatibilityVersion: 3,

  resolveTargets(input: AdapterResolveTargetsInput): readonly TargetResolution[] {
    return rolesForPhase(input.roles, input.phase).map((role) => resolveOne(role, input));
  },

  validatePreconditions(input: AdapterPreconditionInput): readonly AdapterPreconditionProblem[] {
    const problems: AdapterPreconditionProblem[] = [];
    for (const resolution of input.resolutions) {
      if (resolution.status !== 'resolved' || resolution.target === null) continue;
      const geometry = input.geometry[resolution.target.elementId] ?? null;
      if (geometry === null) {
        problems.push({
          code: 'UNUSABLE_EVIDENCE',
          detail: `No live geometry was read for resolved target "${resolution.target.elementId}".`,
          context: { role: resolution.role, elementId: resolution.target.elementId },
        });
        continue;
      }
      if (!geometry.mounted) {
        problems.push({
          code: 'TARGET_NOT_MOUNTED',
          detail: `Resolved target "${resolution.target.elementId}" is not mounted on the live Stage.`,
          context: { role: resolution.role, elementId: resolution.target.elementId },
        });
        continue;
      }
      if (!geometry.visible || !geometry.listening) {
        problems.push({
          code: 'UNUSABLE_EVIDENCE',
          detail: `Resolved target "${resolution.target.elementId}" is not visible and listening (visible=${String(
            geometry.visible,
          )}, listening=${String(geometry.listening)}).`,
          context: { role: resolution.role, elementId: resolution.target.elementId },
        });
        continue;
      }
      if (!geometry.hasHitPoint) {
        problems.push({
          code: 'HIT_POINT_UNAVAILABLE',
          detail: `Resolved target "${resolution.target.elementId}" exposes no live hit point inside its listening region.`,
          context: { role: resolution.role, elementId: resolution.target.elementId },
        });
        continue;
      }
      problems.push(...typedGeometryProblems(resolution, input));
    }
    return problems;
  },

  contributeReadiness(input: AdapterReadinessInput): AdapterReadinessContribution {
    const resolutions = input.resolutions;
    const targetIds = resolutions
      .filter((resolution) => resolution.status === 'resolved' && resolution.target !== null)
      .map((resolution) => (resolution.target as ResolvedTarget).elementId);
    const typed = resolutions.some(
      (resolution) =>
        resolution.target !== null &&
        resolution.target.geometryProfile !== undefined &&
        wantsCircleEnvelope(resolution.target.geometryProfile),
    );
    return {
      profileId: typed ? WARPED_TEXT_READINESS_PROFILE : 'action-cycle-v1',
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
    const typed = resolutions.some(
      (resolution) =>
        resolution.target !== null &&
        resolution.target.geometryProfile !== undefined &&
        wantsCircleEnvelope(resolution.target.geometryProfile),
    );
    const checks = new Set(requiredChecks);
    if (typed) checks.add(WARPED_TEXT_ENVELOPE_CHECK);
    return { capability, targets, requiredChecks: [...checks].sort() };
  },

  diagnostics(): AdapterDiagnostics {
    return {
      adapterId: 'text-specialized',
      compatibilityVersion: 3,
      targetRoles: ['target'],
    };
  },
};

export function textSpecializedAdapter(): SubjectAdapter {
  return TEXT_SPECIALIZED_ADAPTER;
}
