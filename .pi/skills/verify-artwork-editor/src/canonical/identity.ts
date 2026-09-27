import type {
  CaseIntent,
  ExecutionPlan,
  MaterializedCase,
  ResolvedFixtureBinding,
} from '../contracts/case-model';
import type { SemanticResourceRef } from '../contracts/case-model';
import { IDENTITY_DOMAINS, identityDigest } from './canonicalize';

/**
 * Four-level identity model (decision 0007 N5–N7).
 *
 * 1. `caseId` — semantic requested pre-state, action, transition, and expected
 *    product meaning. It excludes contract implementation versions, manifest
 *    identity and order, profile, release credit, diagnostic reason, evidence
 *    depth, runtime allocation, and generated ids.
 * 2. `materializationFingerprint` — resolved correctness contracts and
 *    implementation versions.
 * 3. `planFingerprint` — the immutable closed operation graph, excluding
 *    ephemeral allocation.
 * 4. `executionInstanceId` — one concrete attempt (owned by the runtime, not
 *    derivable from the plan).
 */

function sortResources(resources: readonly SemanticResourceRef[]): SemanticResourceRef[] {
  return [...resources]
    .map((resource) => ({
      resourceId: resource.resourceId,
      contentDigest: resource.contentDigest,
    }))
    .sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1));
}

/** Exactly the values that can change requested pre-state, action, transition, or expected meaning. */
export function semanticProjection(
  intent: CaseIntent,
  fixture?: ResolvedFixtureBinding,
): Readonly<Record<string, unknown>> {
  return {
    subjectId: intent.subjectId,
    capability: intent.capability,
    variant: intent.variant,
    scenario: intent.scenario,
    preState: intent.preState,
    // Operation order is meaningful: it is the ordered action sequence.
    operations: intent.operations.map((operation) => ({
      discriminant: operation.discriminant,
      parameters: operation.parameters,
    })),
    expected: intent.expected,
    resources: sortResources(intent.resources),
    // A resolved fixture is semantic pre-state (ADR 0013 → ADR 0015 B16): a
    // fixture/constructor revision must change the case identity rather than
    // silently reuse the old one.
    ...(fixture === undefined
      ? {}
      : {
          fixture: {
            fixtureId: fixture.fixtureId,
            constructorId: fixture.constructorId,
            constructorVersion: fixture.constructorVersion,
            inputsFingerprint: fixture.inputsFingerprint,
          },
        }),
  };
}

export function deriveCaseId(intent: CaseIntent, fixture?: ResolvedFixtureBinding): string {
  return identityDigest(IDENTITY_DOMAINS.caseId, semanticProjection(intent, fixture));
}

export function deriveMaterializationFingerprint(materializedCase: MaterializedCase): string {
  return identityDigest(IDENTITY_DOMAINS.materialization, materializedCase);
}

export function derivePlanFingerprint(plan: ExecutionPlan): string {
  return identityDigest(IDENTITY_DOMAINS.plan, plan);
}

/** Canonical fingerprint of one resolved fixture's declared constructor inputs. */
export function deriveFixtureInputsFingerprint(inputs: unknown): string {
  return identityDigest(IDENTITY_DOMAINS.fixtureInputs, inputs);
}

/**
 * Canonical fingerprint of one fixture's complete declared semantic target-role
 * contract (ADR 0018 CR4). Role name, kind, layout role, resolution timing, and
 * declared geometry/semantic profile all participate, so a role-timing change
 * moves the materialization/plan identity even when the requested product
 * meaning and pre-state are unchanged.
 */
export function deriveTargetRoleContractFingerprint(
  roles: readonly import('../contracts/adapter').SemanticTargetRole[],
): string {
  return identityDigest(IDENTITY_DOMAINS.targetRoleContract, roles);
}
