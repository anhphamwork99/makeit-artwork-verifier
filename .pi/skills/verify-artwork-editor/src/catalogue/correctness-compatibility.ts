import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { CorrectnessCatalogue, ResolvedCorrectnessProfile } from '../contracts/correctness';
import type { RouteProfileSelectionDeclaration } from '../contracts/correctness';
import { compileResolvedCorrectnessProfile } from './correctness';
import {
  WP5_COMPATIBILITY_ORACLE,
  type Wp5CompatibilityNormalization,
  type Wp5CompatibilityProjection,
  type Wp5CompatibilityRoute,
} from './wp5-compatibility-oracle';
import { READINESS_PROFILE_REGISTRY } from '../readiness/profile-registry';
import { ORACLE_PROFILE_REGISTRY } from '../oracles/profile-registry';

/**
 * Exact-equality compatibility audit (ADR 0023 §7, ADR 0024 §4).
 *
 * Two independent compatibility sources are compared against the compiled
 * Package 7 Slice A catalogue output:
 *
 * 1. The runtime dispatch registries, which stay evaluator/implementation
 *    dispatch projections rather than policy authorities. Any divergence is
 *    blocking, so an independently authored policy literal can never silently
 *    override the catalogue.
 * 2. The route-level {@link WP5_COMPATIBILITY_ORACLE}, a hand-authored snapshot
 *    of the ADR 0022 accepted WP5 correctness meaning that is deliberately not
 *    generated from the new catalogues or compiled profiles.
 *
 * The oracle comparison covers the complete ADR 0024 §4 projection — readiness
 * (including schema version, declaration version, quiescence, stable-frame
 * applicability and complete currentness identities), capture sources and
 * sequencing, Oracle/check evaluator and expected/actual contracts, evidence
 * inventories, tolerance/visual/normalization policy, composition, and the
 * non-weakening result. A top-level profile-id / evaluator-kind comparison is
 * deliberately insufficient and is never treated as coverage.
 */

function divergence(detail: string): DiagnosticRecord {
  return createDiagnostic('CORRECTNESS_COMPATIBILITY_DIVERGENCE', detail);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function routeLabel(route: Wp5CompatibilityRoute): string {
  return `${route.subjectId}×${route.capability}@${route.variant ?? '∅'}`;
}

function sameRoute(
  left: Wp5CompatibilityRoute,
  right: { subjectId: string; capability: string; variant: string | null },
): boolean {
  return (
    left.subjectId === right.subjectId &&
    left.capability === right.capability &&
    left.variant === right.variant
  );
}

/**
 * Recursively compares two projection values and emits one blocking divergence
 * per differing leaf. This is what makes the comparison genuinely field-exact:
 * a mutation anywhere in the projection produces a named finding rather than
 * passing because some other field still matched.
 */
function compareValue(
  expected: unknown,
  actual: unknown,
  path: string,
  findings: DiagnosticRecord[],
): void {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      findings.push(
        divergence(`${path} type mismatch (expected array=${JSON.stringify(expected)})`),
      );
      return;
    }
    if (expected.length !== actual.length) {
      findings.push(
        divergence(
          `${path} length mismatch: compiled ${actual.length} vs oracle ${expected.length}`,
        ),
      );
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      compareValue(expected[index], actual[index], `${path}[${index}]`, findings);
    }
    return;
  }
  if (isPlainRecord(expected) || isPlainRecord(actual)) {
    if (!isPlainRecord(expected) || !isPlainRecord(actual)) {
      findings.push(
        divergence(`${path} type mismatch (expected object=${JSON.stringify(expected)})`),
      );
      return;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      compareValue(expected[key], actual[key], `${path}.${key}`, findings);
    }
    return;
  }
  if (!Object.is(expected, actual)) {
    findings.push(
      divergence(
        `${path} differs: compiled ${JSON.stringify(actual)} vs oracle ${JSON.stringify(expected)}`,
      ),
    );
  }
}

/** The compared projection derived from one compiled catalogue profile. */
export function compatibilityProjectionOfCompiledProfile(
  profile: ResolvedCorrectnessProfile,
  selection: RouteProfileSelectionDeclaration,
  declaredChecks: readonly string[],
): Wp5CompatibilityProjection {
  const normalization: Wp5CompatibilityNormalization = profile.normalization.applicable
    ? {
        applicable: true,
        normalizationId: profile.normalization.normalizationId,
        version: profile.normalization.version,
        applicability: profile.normalization.applicability,
        meaningRef: profile.normalization.meaningRef,
        evaluator: profile.normalization.evaluator,
      }
    : { applicable: false };
  return {
    route: {
      subjectId: profile.subjectId,
      capability: profile.capability,
      variant: profile.variant,
    },
    profileId: profile.profileId,
    readiness: profile.readiness,
    capture: profile.capture,
    oracle: profile.oracle,
    capabilityBaseline: profile.capabilityBaseline,
    subjectAddition: profile.subjectAddition,
    routeSelection: {
      readinessProfileId: selection.readinessProfileId,
      oracleProfileId: selection.oracleProfileId,
      checks: selection.checks,
    },
    declaredChecks: [...declaredChecks].sort(),
    requiredChecks: profile.requiredChecks.map((entry) => entry.checkId),
    tolerances: profile.tolerances,
    visuals: profile.visuals,
    normalization,
    nonWeakeningSatisfied: profile.nonWeakening.every((entry) => entry.satisfied),
  };
}

/**
 * Compares every delivered route's complete compiled projection against the
 * independent WP5 Compatibility Oracle and reports one blocking finding per
 * differing field. It also fails if a delivered route has no oracle entry or an
 * oracle entry has no delivered route, so neither side can silently drop
 * coverage.
 */
export function auditWp5Compatibility(catalogue: CorrectnessCatalogue): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];

  for (const entry of WP5_COMPATIBILITY_ORACLE) {
    const expected = entry.projection;
    const selection = catalogue.routeSelections.find((candidate) =>
      sameRoute(expected.route, candidate),
    );
    if (!selection) {
      findings.push(
        divergence(
          `WP5 compatibility oracle route ${routeLabel(expected.route)} (${entry.provenance}) has no matching catalogue route selection.`,
        ),
      );
      continue;
    }
    const compiled = compileResolvedCorrectnessProfile({
      catalogue,
      selection,
      declaredChecks: expected.declaredChecks,
    });
    if (!compiled.ok) {
      for (const finding of compiled.findings) {
        findings.push(
          divergence(
            `WP5 compatibility oracle route ${routeLabel(expected.route)} failed to compile: ${finding.detail}`,
          ),
        );
      }
      continue;
    }
    compareValue(
      expected,
      compatibilityProjectionOfCompiledProfile(
        compiled.profile,
        selection,
        expected.declaredChecks,
      ),
      `wp5[${expected.profileId}]`,
      findings,
    );
  }

  for (const selection of catalogue.routeSelections) {
    const covered = WP5_COMPATIBILITY_ORACLE.some((entry) =>
      sameRoute(entry.projection.route, selection),
    );
    if (!covered) {
      findings.push(
        divergence(
          `Catalogue route selection ${selection.subjectId}×${selection.capability}@${selection.variant ?? '∅'} has no independent WP5 compatibility oracle entry.`,
        ),
      );
    }
  }

  return findings;
}

export function auditCorrectnessCompatibility(catalogue: CorrectnessCatalogue): DiagnosticRecord[] {
  const findings: DiagnosticRecord[] = [];

  const catalogueReadinessIds = new Set(catalogue.readiness.map((entry) => entry.profileId));
  for (const profileId of Object.keys(READINESS_PROFILE_REGISTRY)) {
    if (!catalogueReadinessIds.has(profileId)) {
      findings.push(
        divergence(
          `Readiness registry exposes "${profileId}" but the correctness catalogue declares no such profile.`,
        ),
      );
    }
  }

  for (const declaration of catalogue.readiness) {
    const registration = READINESS_PROFILE_REGISTRY[declaration.profileId];
    if (!registration) {
      findings.push(
        divergence(
          `Correctness catalogue readiness profile "${declaration.profileId}" has no dispatching registry registration.`,
        ),
      );
      continue;
    }
    const profile = registration.profile;
    const comparisons: readonly [string, unknown, unknown][] = [
      ['profileId', declaration.profileId, profile.profileId],
      ['deadlineCategory', declaration.deadlineCategory, profile.timingCategory],
      ['deadlineMs', declaration.deadlineMs, profile.deadlineMs],
      ['signalWatchdogMs', declaration.signalWatchdogMs, profile.signalWatchdogMs],
      [
        'fallbackCadenceMs',
        JSON.stringify(declaration.fallbackCadenceMs),
        JSON.stringify(profile.fallbackCadenceMs),
      ],
      ['stableFrames', declaration.stableFrames, profile.stableFrames],
      ['captureProfileId', declaration.captureProfileId, registration.captureProfileId],
      ['oracleProfileId', declaration.oracleProfileId, registration.oracleProfileId],
    ];
    for (const [field, catalogueValue, registryValue] of comparisons) {
      if (catalogueValue !== registryValue) {
        findings.push(
          divergence(
            `Readiness "${declaration.profileId}" ${field} disagrees: catalogue ${JSON.stringify(catalogueValue)} vs registry ${JSON.stringify(registryValue)}.`,
          ),
        );
      }
    }
  }

  const catalogueOracleIds = new Set(catalogue.oracles.map((entry) => entry.oracleProfileId));
  for (const profileId of Object.keys(ORACLE_PROFILE_REGISTRY)) {
    if (!catalogueOracleIds.has(profileId)) {
      findings.push(
        divergence(
          `Oracle registry exposes "${profileId}" but the correctness catalogue declares no such profile.`,
        ),
      );
    }
  }

  for (const declaration of catalogue.oracles) {
    const registration = ORACLE_PROFILE_REGISTRY[declaration.oracleProfileId];
    if (!registration) {
      findings.push(
        divergence(
          `Correctness catalogue Oracle "${declaration.oracleProfileId}" has no dispatching registry registration.`,
        ),
      );
      continue;
    }
    const comparisons: readonly [string, unknown, unknown][] = [
      ['version', declaration.version, registration.version],
      ['schemaVersion', declaration.schemaVersion, registration.schemaVersion],
      ['evaluatorKind', declaration.evaluatorKind, registration.kind],
    ];
    for (const [field, catalogueValue, registryValue] of comparisons) {
      if (catalogueValue !== registryValue) {
        findings.push(
          divergence(
            `Oracle "${declaration.oracleProfileId}" ${field} disagrees: catalogue ${JSON.stringify(catalogueValue)} vs registry ${JSON.stringify(registryValue)}.`,
          ),
        );
      }
    }
  }

  findings.push(...auditWp5Compatibility(catalogue));

  return findings;
}
