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

/**
 * Image-specialized Subject adapter (specification 6.3; WP5 Slice 5-C).
 *
 * Compatibility version 2 contributes the raster-aware readiness profile and the
 * image upload/replace required checks. It reuses the common one-unambiguous
 * mounted-element role resolution and adds the empty-placeholder preconditions
 * the upload workflow depends on. It never branches on Subject family, scenario,
 * variant, resource id, or the image workflow: the catalogue selects it by data
 * and the declared checks route the Oracle.
 */

/** Readiness profile the image raster drive uses. */
export const IMAGE_RASTER_READINESS_PROFILE = 'image-raster-action-cycle-v1';

/** Required checks this adapter contributes (B additionally requires distinctness). */
export const IMAGE_UPLOAD_REPLACE_CHECKS = [
  'image.semantic-transition',
  'image.raster-current',
  'image.frame-stable',
  'image.structural-visual',
] as const;

/** The extra check required only on the replacement checkpoint. */
export const IMAGE_CONTENT_DISTINCT_CHECK = 'image.content-distinct';

/**
 * Required intermediate check (supervisor R10): the exact Replace image control
 * must be present, visible, enabled, and unique after an accepted upload. It is
 * evaluated by the runtime from the control activation, not by the raster Oracle.
 */
export const IMAGE_REPLACE_CONTROL_READY_CHECK = 'image.replace-control-ready';

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

/**
 * Reads one canonical layer fact from the accepted `layoutItems` snapshot. Only
 * typed fields are read; no fingerprint or opaque value is parsed.
 */
export function findCanonicalImageLayer(
  layoutItems: unknown,
  elementId: string,
): {
  parentLayoutId: string;
  placeholder: boolean;
  testedWithImage: boolean;
  src: string | null;
  frame: { x: number; y: number; width: number; height: number; rotation: number };
  flipX: boolean;
  flipY: boolean;
  parentId: string | null;
} | null {
  if (!Array.isArray(layoutItems)) return null;
  for (const rawLayout of layoutItems) {
    if (typeof rawLayout !== 'object' || rawLayout === null) continue;
    const layout = rawLayout as Record<string, unknown>;
    const layers = Array.isArray(layout.layers) ? layout.layers : [];
    for (const rawLayer of layers) {
      if (typeof rawLayer !== 'object' || rawLayer === null) continue;
      const layer = rawLayer as Record<string, unknown>;
      if (layer.id !== elementId) continue;
      const config =
        typeof layer.config === 'object' && layer.config !== null
          ? (layer.config as Record<string, unknown>)
          : {};
      const transform =
        typeof layer.transform === 'object' && layer.transform !== null
          ? (layer.transform as Record<string, unknown>)
          : {};
      const numberOr = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
      return {
        parentLayoutId: typeof layout.id === 'string' ? layout.id : '',
        placeholder: config.placeholder === true,
        testedWithImage: config.testedWithImage === true,
        src: typeof layer.src === 'string' && layer.src.length > 0 ? layer.src : null,
        frame: {
          x: numberOr(layer.xCoordinate ?? layer.x, Number.NaN),
          y: numberOr(layer.yCoordinate ?? layer.y, Number.NaN),
          width: numberOr(layer.width, Number.NaN),
          height: numberOr(layer.height, Number.NaN),
          rotation: numberOr(layer.rotation, 0),
        },
        flipX: transform.flipX === true,
        flipY: transform.flipY === true,
        parentId: typeof layout.id === 'string' ? layout.id : null,
      };
    }
  }
  return null;
}

const IMAGE_SPECIALIZED_ADAPTER: SubjectAdapter = {
  adapterId: 'image-specialized',
  compatibilityVersion: 2,

  resolveTargets(input: AdapterResolveTargetsInput): readonly TargetResolution[] {
    return rolesForPhase(input.roles, input.phase).map((role) => resolveOne(role, input));
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
          detail: `Resolved target "${elementId}" is not visible and listening.`,
          context: { role: resolution.role, elementId },
        });
        continue;
      }
      if (!geometry.hasHitPoint) {
        problems.push({
          code: 'HIT_POINT_UNAVAILABLE',
          detail: `Resolved target "${elementId}" exposes no live hit point inside its listening region.`,
          context: { role: resolution.role, elementId },
        });
        continue;
      }
      const canonical = input.canonical;
      if (canonical) {
        const layer = findCanonicalImageLayer(canonical.layoutItems, elementId);
        if (layer === null || layer.parentLayoutId !== canonical.expectedLayoutId) {
          problems.push({
            code: 'TARGET_UNRESOLVED',
            detail: `The accepted snapshot does not resolve "${elementId}" as an Image child of Layout "${canonical.expectedLayoutId}".`,
            context: { role: resolution.role, elementId, reason: 'CANONICAL_IMAGE_MISSING' },
          });
          continue;
        }
        // Before the first file action the target must be an exact empty
        // placeholder: no source, no tested flag (supervisor R2).
        if (!layer.placeholder || layer.src !== null || layer.testedWithImage) {
          problems.push({
            code: 'RASTER_AUTHORITY_UNUSABLE',
            detail: `Resolved target "${elementId}" is not an empty placeholder before upload (placeholder=${String(layer.placeholder)}, src=${String(layer.src !== null)}, testedWithImage=${String(layer.testedWithImage)}).`,
            context: { role: resolution.role, elementId, reason: 'PLACEHOLDER_PRECONDITION' },
          });
        }
      }
    }
    return problems;
  },

  contributeReadiness(input: AdapterReadinessInput): AdapterReadinessContribution {
    const resolutions = input.resolutions;
    const targetIds = resolutions
      .filter((resolution) => resolution.status === 'resolved' && resolution.target !== null)
      .map((resolution) => (resolution.target as ResolvedTarget).elementId);
    return {
      profileId: IMAGE_RASTER_READINESS_PROFILE,
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
    for (const check of IMAGE_UPLOAD_REPLACE_CHECKS) checks.add(check);
    return { capability, targets, requiredChecks: [...checks].sort() };
  },

  diagnostics(): AdapterDiagnostics {
    return {
      adapterId: 'image-specialized',
      compatibilityVersion: 2,
      targetRoles: ['target'],
    };
  },
};

export function imageSpecializedAdapter(): SubjectAdapter {
  return IMAGE_SPECIALIZED_ADAPTER;
}
