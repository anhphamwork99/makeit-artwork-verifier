import { createDiagnostic, type DiagnosticCode, type DiagnosticRecord } from './diagnostics';
import type { Capability } from './discriminants';

/**
 * Subject adapter contract (specification 6.3; WP5 Slice 5-A; ADR 0017 CR5).
 *
 * An adapter owns the *semantic* interpretation of one Subject family for the
 * generic engine: it resolves a workflow's declared semantic target roles
 * against the live document at an explicit lifecycle phase, validates the
 * semantic preconditions a drive needs before any native input, contributes the
 * target ids the readiness profile must observe, and normalizes the accepted
 * observation for the Oracle.
 *
 * The adapter never branches on Subject identity, family, application kind, or
 * renderer flag *in the engine*: the engine selects exactly one adapter by
 * catalogue data and calls this closed contract. A `TargetResolution` is a
 * closed classification, so an ambiguous or unmounted target can never be
 * silently coerced into a `resolved` one.
 *
 * Create capabilities (ADR 0017 CR5/CR6): a role declares *when* it is expected
 * to exist with the closed `resolution` discriminant. The engine calls the
 * adapter once with `phase: 'pre-action'` (only `pre-action-existing` roles) and
 * once with `phase: 'post-action'` after the causal transition (only
 * `post-action-new` roles). The two successful resolution sets are then merged
 * by unique role name. This is a generic lifecycle, not a Subject branch.
 */

export const TARGET_RESOLUTION_STATUSES = [
  'resolved',
  'ambiguous',
  'unresolved',
  'unmounted',
] as const;
export type TargetResolutionStatus = (typeof TARGET_RESOLUTION_STATUSES)[number];

/** Semantic layout selector for a target role. */
export const TARGET_LAYOUT_ROLES = ['active', 'any'] as const;
export type TargetLayoutRole = (typeof TARGET_LAYOUT_ROLES)[number];

/**
 * Closed authoring discriminant for when a semantic target role is expected to
 * exist (ADR 0017 CR3). `pre-action-existing` roles are resolved before the
 * native action; `post-action-new` roles are resolved only after the causal
 * transition, from the exact active-host set difference.
 */
export const TARGET_RESOLUTION_TIMINGS = ['pre-action-existing', 'post-action-new'] as const;
export type SemanticTargetResolution = (typeof TARGET_RESOLUTION_TIMINGS)[number];

/** The two resolution phases an adapter may be invoked in. */
export const ADAPTER_RESOLUTION_PHASES = ['pre-action', 'post-action'] as const;
export type AdapterResolutionPhase = (typeof ADAPTER_RESOLUTION_PHASES)[number];

/** One declared semantic target role (authoring data, never a coordinate). */
export interface SemanticTargetRole {
  role: string;
  /** Application element kind the role matches (for example a Text layer). */
  kind: string;
  layoutRole: TargetLayoutRole;
  /**
   * Closed lifecycle discriminant: whether this role must already exist before
   * the native action (`pre-action-existing`) or is created by the claimed
   * capability (`post-action-new`). Always explicit in a parsed v2 catalogue.
   */
  resolution: SemanticTargetResolution;
  /**
   * Optional declared geometry representation profile for this role. When it is
   * `circle-control-envelope-quad-v1` the adapter requires the typed geometry
   * schema v2 evidence and contributes the `geometry.warp-envelope` check. The
   * value is authoring data routed through the adapter — never an engine branch
   * on Subject, scenario, or variant (R11).
   */
  geometryProfile?: string;
  /**
   * Optional declared generated-semantic profile for this role. When it is
   * `crossword-semantic-v1` the generated-specialized adapter requires the
   * generated-Crossword observation contract and contributes the six
   * `crossword-determinism-v1` checks. As with `geometryProfile`, the value is
   * authoring data routed through the adapter — never an engine branch on
   * Subject, scenario, or variant.
   */
  semanticProfile?: string;
}

/**
 * A minimal, read-only element fact the adapter resolves roles against. The
 * optional fields carry the live layout/selection facts a create lifecycle
 * needs (CR6) without introducing a Subject branch: they are plain bridge
 * facts, present only when the bridge publishes them.
 */
export interface AdapterElementFact {
  id: string;
  kind: string;
  parentId: string | null;
  mounted: boolean;
  /** True when the live element is hidden (`hidden`/`visible === false`). */
  hidden?: boolean;
  /** True when the live element is currently selected. */
  selected?: boolean;
  /** Direct child element ids, when the bridge publishes them. */
  children?: readonly string[];
}

/**
 * The sealed pre-action baseline a phase-aware adapter records and later
 * consumes for `post-action` resolution (ADR 0017 CR5). It is deliberately
 * minimal and serializable: role element ids, active-layout child ids by kind,
 * and the exact active layout id.
 */
export interface AdapterResolutionBaseline {
  activeLayoutId: string;
  elementIdsByRole: Readonly<Record<string, readonly string[]>>;
  activeLayoutChildIdsByKind: Readonly<Record<string, readonly string[]>>;
}

export interface AdapterResolveTargetsInput {
  /** The explicit lifecycle phase; never inferred from selection or timing. */
  phase: AdapterResolutionPhase;
  roles: readonly SemanticTargetRole[];
  elements: readonly AdapterElementFact[];
  activeLayoutId: string | null;
  /** Required for `post-action`; the sealed pre-action baseline. */
  baseline?: AdapterResolutionBaseline;
}

export interface ResolvedTarget {
  role: string;
  elementId: string;
  kind: string;
  parentId: string | null;
  /** Declared geometry representation profile for this role, if any. */
  geometryProfile?: string;
  /** Declared generated-semantic profile for this role, if any. */
  semanticProfile?: string;
}

export interface TargetResolution {
  role: string;
  status: TargetResolutionStatus;
  matchCount: number;
  matchedElementIds: readonly string[];
  target: ResolvedTarget | null;
  detail: string;
}

/** Live geometry facts a precondition is checked against, per resolved target. */
export interface TargetGeometryFacts {
  elementId: string;
  mounted: boolean;
  visible: boolean;
  listening: boolean;
  hasHitPoint: boolean;
}

export interface AdapterPreconditionInput {
  resolutions: readonly TargetResolution[];
  geometry: Readonly<Record<string, TargetGeometryFacts | null>>;
  /**
   * Role names the workflow actually pointer-targets. A resolved role that is
   * not pointer-targeted (for example a create host Layout) is not required to
   * expose a live hit point (ADR 0017 CR5/CR6).
   */
  pointerRoles?: readonly string[];
  /**
   * Raw typed bridge geometry v2 payloads per resolved target id, present only
   * when the role declares a typed geometry profile.
   */
  typedGeometry?: Readonly<Record<string, unknown>>;
  /**
   * Accepted snapshot `layoutItems` plus the expected parent Layout id, so a
   * typed profile can validate projection, control bounds, flips, and target /
   * Layout identity against the canonical source independently of the bridge.
   */
  canonical?: { layoutItems: unknown; expectedLayoutId: string };
}

export interface AdapterPreconditionProblem {
  code: DiagnosticCode;
  detail: string;
  context: Record<string, string>;
}

export interface AdapterReadinessContribution {
  profileId: string;
  targetIds: readonly string[];
  /** True when at least one resolved target is required for Gate E credit. */
  targetAware: boolean;
}

/**
 * Phase-aware readiness input (ADR 0017 CR5). The adapter must be able to
 * select the readiness/capture profile from the *declared* role contract before
 * a `post-action-new` role has a runtime id, so readiness never requires the
 * created target to exist.
 */
export interface AdapterReadinessInput {
  phase: AdapterResolutionPhase;
  roles: readonly SemanticTargetRole[];
  resolutions: readonly TargetResolution[];
  baseline?: AdapterResolutionBaseline;
}

export interface AdapterObservationVariable {
  role: string;
  elementId: string;
}

export interface AdapterNormalizedResult {
  capability: Capability;
  targets: readonly AdapterObservationVariable[];
  requiredChecks: readonly string[];
}

export interface AdapterDiagnostics {
  adapterId: string;
  compatibilityVersion: number;
  targetRoles: readonly string[];
}

export interface SubjectAdapter {
  adapterId: string;
  compatibilityVersion: number;
  resolveTargets(input: AdapterResolveTargetsInput): readonly TargetResolution[];
  validatePreconditions(input: AdapterPreconditionInput): readonly AdapterPreconditionProblem[];
  contributeReadiness(input: AdapterReadinessInput): AdapterReadinessContribution;
  normalizeResult(
    resolutions: readonly TargetResolution[],
    capability: Capability,
    requiredChecks: readonly string[],
  ): AdapterNormalizedResult;
  diagnostics(): AdapterDiagnostics;
}

/** Maps a target-resolution status to its blocking diagnostic code. */
export const TARGET_RESOLUTION_DIAGNOSTIC: Readonly<
  Record<TargetResolutionStatus, DiagnosticCode | null>
> = {
  resolved: null,
  ambiguous: 'TARGET_AMBIGUOUS',
  unresolved: 'TARGET_UNRESOLVED',
  unmounted: 'TARGET_NOT_MOUNTED',
};

/** Diagnostic for one non-resolved target resolution, or `null` when resolved. */
export function targetResolutionDiagnostic(
  resolution: TargetResolution,
  hints: { subjectId?: string } = {},
): DiagnosticRecord | null {
  const code = TARGET_RESOLUTION_DIAGNOSTIC[resolution.status];
  if (code === null) return null;
  return createDiagnostic(code, resolution.detail, {
    subjectId: hints.subjectId,
    context: { role: resolution.role, matchCount: String(resolution.matchCount) },
  });
}

/**
 * Generic role filter by lifecycle phase. Every adapter applies this so
 * `post-action` never evaluates a `pre-action-existing` role and vice versa.
 */
export function rolesForPhase(
  roles: readonly SemanticTargetRole[],
  phase: AdapterResolutionPhase | undefined,
): readonly SemanticTargetRole[] {
  // The engine always passes the explicit phase. An omitted phase or an omitted
  // `resolution` on an in-memory role (test/utility callers) is interpreted as
  // the pre-action phase: the authoritative v2 catalogue parser never defaults
  // a missing resolution, so this only keeps the adapter boundary robust for
  // already-parsed objects.
  const effective = phase ?? 'pre-action';
  const wanted = effective === 'pre-action' ? 'pre-action-existing' : 'post-action-new';
  return roles.filter((role) => (role.resolution ?? 'pre-action-existing') === wanted);
}

/**
 * True when a fixture declares a `post-action-new` role (ADR 0018 CR8), which
 * selects the sequential three-child generated drive. The discriminant is the
 * closed role-timing field, so the generic engine never branches on Subject,
 * scenario, or word literals.
 */
export function fixtureHasPostActionRoles(fixture: {
  semanticTargetRoles: readonly SemanticTargetRole[];
}): boolean {
  return rolesForPhase(fixture.semanticTargetRoles, 'post-action').length > 0;
}

/**
 * Builds the sealed pre-action baseline from the pre-action resolutions and the
 * live element facts (ADR 0017 CR5/CR6). The generic engine owns this so the
 * baseline is produced once, carried in memory, and later handed back to the
 * same adapter for `post-action` resolution.
 */
export function buildAdapterResolutionBaseline(input: {
  resolutions: readonly TargetResolution[];
  elements: readonly AdapterElementFact[];
  activeLayoutId: string;
}): AdapterResolutionBaseline {
  const elementIdsByRole: Record<string, readonly string[]> = {};
  for (const resolution of input.resolutions) {
    elementIdsByRole[resolution.role] = [...resolution.matchedElementIds];
  }
  const childIdsByKind: Record<string, string[]> = {};
  for (const element of input.elements) {
    if (element.parentId !== input.activeLayoutId) continue;
    const bucket = childIdsByKind[element.kind] ?? [];
    bucket.push(element.id);
    childIdsByKind[element.kind] = bucket;
  }
  const activeLayoutChildIdsByKind: Record<string, readonly string[]> = {};
  for (const [kind, ids] of Object.entries(childIdsByKind)) {
    activeLayoutChildIdsByKind[kind] = [...ids].sort();
  }
  return {
    activeLayoutId: input.activeLayoutId,
    elementIdsByRole,
    activeLayoutChildIdsByKind,
  };
}
