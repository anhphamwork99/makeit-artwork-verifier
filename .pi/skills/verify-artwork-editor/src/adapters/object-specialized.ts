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
  cameraAgreementPasses,
  deriveNestedCanonicalChain,
  evaluateNestedCameraAgreementV3,
  NESTED_OBJECT_AFFINE_CHAIN_KIND,
  parseNestedGeometryV3,
  type NestedObjectGeometryContractFailure,
  type NestedObjectGeometryV3,
} from '../contracts/geometry-v3';

/**
 * Object-specialized Subject adapter v2 (WP5 Slice 5-D, ADR 0013 R11).
 *
 * This is the only deliberate place where nested Object/Group semantic roles are
 * interpreted. It resolves exactly one root Object under the declared Layout
 * role transitively through fresh parent links, resolves exactly one Text
 * witness that is a descendant of that target, validates the exact
 * Text → inner Object → outer Object → Layout chain, requires the typed
 * geometry-v3 authority, and contributes the nested readiness/Oracle/capture
 * profile ids. The generic engine selects it by catalogue data; nothing here is
 * reachable by a Subject-name, scenario, or variant branch.
 *
 * `layoutRole: active` is interpreted transitively: an element belongs to the
 * active Layout when walking its fresh `parentId` chain reaches that Layout. The
 * default direct-parent rule is deliberately not reused.
 */

export const OBJECT_SPECIALIZED_ADAPTER_ID = 'object-specialized';

/** Compatibility version this adapter implements. */
export const OBJECT_SPECIALIZED_COMPATIBILITY_VERSION = 2;

/** Readiness profile the nested drive uses. */
export const NESTED_OBJECT_READINESS_PROFILE = 'nested-object-action-cycle-v1';

/** Capture profile the nested drive uses. */
export const NESTED_OBJECT_CAPTURE_PROFILE = 'nested-object-affine-capture-v1';

/** Oracle profile the nested drive uses. */
export const NESTED_OBJECT_ORACLE_PROFILE = 'nested-object-move-v1';

/** The typed geometry representation profile the nested roles declare. */
export const NESTED_OBJECT_GEOMETRY_PROFILE = NESTED_OBJECT_AFFINE_CHAIN_KIND;

/** The four required checks the nested Oracle profile must evaluate. */
export const NESTED_OBJECT_REQUIRED_CHECKS = [
  'containment.parent-chain',
  'geometry.local-invariant',
  'geometry.world-composition',
  'geometry.delta',
] as const;

function buildParentMap(elements: readonly AdapterElementFact[]): Map<string, AdapterElementFact> {
  return new Map(elements.map((element) => [element.id, element]));
}

/**
 * True when `element` is a *root* Object whose direct parent is a Layout that
 * matches the declared role (`null` means any Layout). Nested descendant
 * Objects are excluded: their parent is another Object, not a Layout. This is
 * the transitive interpretation in the only direction it is safe — the witness
 * walks up through fresh parent links, while the target stays a root Object.
 */
function isRootObjectUnderDeclaredLayout(
  element: AdapterElementFact,
  activeLayoutId: string | null,
  parents: Map<string, AdapterElementFact>,
): boolean {
  if (element.parentId === null) return false;
  const parent = parents.get(element.parentId);
  if (!parent || parent.parentId !== null) return false;
  if (activeLayoutId !== null && element.parentId !== activeLayoutId) return false;
  return true;
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

function resolveTargetRole(
  role: SemanticTargetRole,
  input: AdapterResolveTargetsInput,
): TargetResolution {
  const parents = buildParentMap(input.elements);
  const candidates = input.elements.filter((element) => {
    if (element.kind !== role.kind) return false;
    return isRootObjectUnderDeclaredLayout(
      element,
      role.layoutRole === 'active' ? input.activeLayoutId : null,
      parents,
    );
  });
  const matchedElementIds = candidates.map((element) => element.id);
  if (candidates.length === 0) {
    return {
      role: role.role,
      status: 'unresolved',
      matchCount: 0,
      matchedElementIds,
      target: null,
      detail: detailFor(role, 'unresolved', candidates),
    };
  }
  if (candidates.length > 1) {
    return {
      role: role.role,
      status: 'ambiguous',
      matchCount: candidates.length,
      matchedElementIds,
      target: null,
      detail: detailFor(role, 'ambiguous', candidates),
    };
  }
  const match = candidates[0] as AdapterElementFact;
  if (!match.mounted) {
    return {
      role: role.role,
      status: 'unmounted',
      matchCount: 1,
      matchedElementIds,
      target: null,
      detail: detailFor(role, 'unmounted', candidates),
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
    detail: detailFor(role, 'resolved', candidates),
  };
}

/**
 * Resolves the single Text witness that is an exact descendant of the resolved
 * target through the exact two-Object chain, or a precise non-resolved status.
 */
function resolveWitnessRole(
  role: SemanticTargetRole,
  input: AdapterResolveTargetsInput,
  target: ResolvedTarget | null,
): TargetResolution {
  if (target === null) {
    return {
      role: role.role,
      status: 'unresolved',
      matchCount: 0,
      matchedElementIds: [],
      target: null,
      detail: `Semantic witness role "${role.role}" cannot resolve without a resolved target.`,
    };
  }
  const parents = buildParentMap(input.elements);
  const candidates = input.elements.filter((element) => {
    if (element.kind !== role.kind) return false;
    const parent = element.parentId === null ? undefined : parents.get(element.parentId);
    if (!parent || parent.kind !== target.kind) return false;
    const grandparent = parent.parentId === null ? undefined : parents.get(parent.parentId);
    if (!grandparent || grandparent.kind !== target.kind) return false;
    return grandparent.id === target.elementId;
  });
  const matchedElementIds = candidates.map((element) => element.id);
  if (candidates.length === 0) {
    return {
      role: role.role,
      status: 'unresolved',
      matchCount: 0,
      matchedElementIds,
      target: null,
      detail: `Semantic witness role "${role.role}" matched no Text descendant of target "${target.elementId}".`,
    };
  }
  if (candidates.length > 1) {
    return {
      role: role.role,
      status: 'ambiguous',
      matchCount: candidates.length,
      matchedElementIds,
      target: null,
      detail: `Semantic witness role "${role.role}" matched ${candidates.length} Text descendants of target "${target.elementId}".`,
    };
  }
  const match = candidates[0] as AdapterElementFact;
  if (!match.mounted) {
    return {
      role: role.role,
      status: 'unmounted',
      matchCount: 1,
      matchedElementIds,
      target: null,
      detail: `Semantic witness role "${role.role}" matched "${match.id}" but it is not mounted.`,
    };
  }
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
    },
    detail: `Semantic witness role "${role.role}" resolved exactly one mounted Text descendant.`,
  };
}

function nestedTypedProblem(
  failure: NestedObjectGeometryContractFailure,
  resolution: TargetResolution,
  elementId: string,
): AdapterPreconditionProblem {
  return {
    code: failure.code,
    detail: failure.detail,
    context: {
      role: resolution.role,
      elementId,
      reason: failure.reason,
      ...failure.context,
    },
  };
}

function typedGeometryProblems(
  resolution: TargetResolution,
  witnessResolution: TargetResolution | null,
  input: AdapterPreconditionInput,
): AdapterPreconditionProblem[] {
  const target = resolution.target as ResolvedTarget;
  if (witnessResolution === null || witnessResolution.target === null) {
    return [
      {
        code: 'TARGET_UNRESOLVED',
        detail: `Resolved target "${target.elementId}" has no resolved Text witness.`,
        context: { role: resolution.role, elementId: target.elementId },
      },
    ];
  }
  const witness = witnessResolution.target;
  const canonical = input.canonical;
  if (!canonical) {
    return [
      {
        code: 'GEOMETRY_TRANSFORM_INVALID',
        detail: `Resolved target "${target.elementId}" has no accepted canonical layer facts to validate against.`,
        context: {
          role: resolution.role,
          elementId: target.elementId,
          reason: 'CANONICAL_UNAVAILABLE',
        },
      },
    ];
  }
  const derived = deriveNestedCanonicalChain({
    layoutItems: canonical.layoutItems,
    targetId: target.elementId,
    witnessId: witness.elementId,
    layoutId: canonical.expectedLayoutId,
  });
  if (!derived.ok) {
    return [nestedTypedProblem(derived.failure, resolution, target.elementId)];
  }
  const raw = (input.typedGeometry ?? {})[target.elementId];
  if (raw === undefined || raw === null) {
    return [
      {
        code: 'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        detail: `Resolved target "${target.elementId}" declares the nested-object geometry profile but the bridge published no typed geometry-v3 record.`,
        context: {
          role: resolution.role,
          elementId: target.elementId,
          reason: 'TYPED_GEOMETRY_MISSING',
        },
      },
    ];
  }
  const parsed = parseNestedGeometryV3({
    raw: (raw as { geometryV3?: unknown }).geometryV3,
    expected: {
      targetId: target.elementId,
      witnessId: witness.elementId,
      layoutId: canonical.expectedLayoutId,
      chain: derived.derivation.chain,
    },
  });
  if (!parsed.ok) {
    return [nestedTypedProblem(parsed.failure, resolution, target.elementId)];
  }
  const geometry: NestedObjectGeometryV3 = parsed.geometry;
  // ADR 0014 R8A: the precondition call is the pre-action authorization, so the
  // typed record must carry the accepted authorize-native-action authority. A
  // post-action observation record is never an action authorization.
  if (
    geometry.interaction.phase !== 'pre-action' ||
    geometry.interaction.authority !== 'action' ||
    geometry.interaction.status !== 'authorized'
  ) {
    return [
      {
        code: 'HIT_POINT_UNAVAILABLE',
        detail: `Resolved target "${target.elementId}" carries no accepted pre-action authorize-native-action interaction.`,
        context: {
          role: resolution.role,
          elementId: target.elementId,
          reason: 'INTERACTION_NOT_AUTHORIZED',
        },
      },
    ];
  }
  const agreement = evaluateNestedCameraAgreementV3(geometry);
  if (!cameraAgreementPasses(agreement)) {
    return [
      {
        code: 'GEOMETRY_CAMERA_MISMATCH',
        detail: `Resolved target "${target.elementId}" live Stage matrix does not agree with the canonical camera intent.`,
        context: {
          role: resolution.role,
          elementId: target.elementId,
          reason: 'CAMERA_DISAGREEMENT',
          panX: String(agreement.panX),
          panY: String(agreement.panY),
          scaleX: String(agreement.scaleX),
          scaleY: String(agreement.scaleY),
          rotation: String(agreement.rotation),
        },
      },
    ];
  }
  if (Math.abs(geometry.camera.canonical.zoom - 1) <= 1e-6) {
    return [
      {
        code: 'GEOMETRY_CAMERA_MISMATCH',
        detail: `Resolved target "${target.elementId}" auto-fit produced an identity zoom; the governed environment must produce a stable non-identity zoom.`,
        context: { role: resolution.role, elementId: target.elementId, reason: 'IDENTITY_ZOOM' },
      },
    ];
  }
  return [];
}

const OBJECT_SPECIALIZED_ADAPTER: SubjectAdapter = {
  adapterId: OBJECT_SPECIALIZED_ADAPTER_ID,
  compatibilityVersion: OBJECT_SPECIALIZED_COMPATIBILITY_VERSION,

  resolveTargets(input: AdapterResolveTargetsInput): readonly TargetResolution[] {
    const roles = rolesForPhase(input.roles, input.phase);
    const resolutions: TargetResolution[] = [];
    let resolvedTarget: ResolvedTarget | null = null;
    for (const role of roles) {
      if (role.role === 'witness') {
        continue;
      }
      const resolution = resolveTargetRole(role, input);
      if (resolution.status === 'resolved' && resolution.target !== null) {
        resolvedTarget = resolution.target;
      }
      resolutions.push(resolution);
    }
    for (const role of roles) {
      if (role.role !== 'witness') continue;
      resolutions.push(resolveWitnessRole(role, input, resolvedTarget));
    }
    return resolutions;
  },

  validatePreconditions(input: AdapterPreconditionInput): readonly AdapterPreconditionProblem[] {
    const problems: AdapterPreconditionProblem[] = [];
    const witnessResolution =
      input.resolutions.find((resolution) => resolution.role === 'witness') ?? null;
    for (const resolution of input.resolutions) {
      if (resolution.status !== 'resolved' || resolution.target === null) continue;
      const elementId = resolution.target.elementId;
      const geometry = input.geometry[elementId] ?? null;
      // The nested witness carries no separate generic geometry read: it is an
      // authority fact inside the pair-explicit typed geometry-v3 record, and
      // its mounted/visible status is authoritative from target resolution.
      if (resolution.role === 'witness') {
        if (geometry !== null && !geometry.visible) {
          problems.push({
            code: 'UNUSABLE_EVIDENCE',
            detail: `Resolved witness "${elementId}" is not visible.`,
            context: { role: resolution.role, elementId },
          });
        }
        continue;
      }
      if (geometry === null) {
        problems.push({
          code: 'UNUSABLE_EVIDENCE',
          detail: `No live geometry was read for resolved target "${elementId}".`,
          context: { role: resolution.role, elementId },
        });
        continue;
      }
      if (!geometry.mounted) {
        const rawTyped = (input.typedGeometry ?? {})[elementId] as
          | { geometryV3Failure?: { code?: unknown; reason?: unknown; detail?: unknown } }
          | undefined;
        const failure = rawTyped?.geometryV3Failure;
        if (failure && typeof failure.code === 'string') {
          problems.push({
            code: 'GEOMETRY_TRANSFORM_INVALID',
            detail: `Typed geometry-v3 projection failed for "${elementId}" (${String(
              failure.reason ?? failure.code,
            )}): ${String(failure.detail ?? '')}`,
            context: {
              role: resolution.role,
              elementId,
              reason: String(failure.reason ?? ''),
              failureCode: String(failure.code),
            },
          });
          continue;
        }
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
      if (!geometry.hasHitPoint) {
        problems.push({
          code: 'HIT_POINT_UNAVAILABLE',
          detail: `Resolved target "${elementId}" exposes no live typed hit point inside its listening region.`,
          context: { role: resolution.role, elementId },
        });
        continue;
      }
      problems.push(...typedGeometryProblems(resolution, witnessResolution, input));
    }
    return problems;
  },

  contributeReadiness(input: AdapterReadinessInput): AdapterReadinessContribution {
    const resolutions = input.resolutions;
    const targetIds = resolutions
      .filter((resolution) => resolution.status === 'resolved' && resolution.target !== null)
      .map((resolution) => (resolution.target as ResolvedTarget).elementId);
    return {
      profileId: NESTED_OBJECT_READINESS_PROFILE,
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
    for (const check of NESTED_OBJECT_REQUIRED_CHECKS) checks.add(check);
    return { capability, targets, requiredChecks: [...checks].sort() };
  },

  diagnostics(): AdapterDiagnostics {
    return {
      adapterId: OBJECT_SPECIALIZED_ADAPTER_ID,
      compatibilityVersion: OBJECT_SPECIALIZED_COMPATIBILITY_VERSION,
      targetRoles: ['target', 'witness'],
    };
  },
};

export function objectSpecializedAdapter(): SubjectAdapter {
  return OBJECT_SPECIALIZED_ADAPTER;
}
