import type {
  CaseIntent,
  ExecutionPlan,
  PlanCorrectnessIdentity,
  PlanPhase,
  ResolvedFixtureBinding,
  ResolvedRoute,
} from '../contracts/case-model';
import { deriveAbsentCorrectnessProfileFingerprint } from '../catalogue/correctness';
import { EXECUTION_PLAN_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Closed phase-graph compilation (decision 0007 N8, specification 8.3 stage 9;
 * ADR 0023 §3).
 *
 * The graph is a closed declarative sequence of approved discriminants with all
 * node forms known at compile time. It contains no callbacks, no executable
 * predicates, no runtime graph mutation, and no unbounded loop; every phase is
 * present so a missing lifecycle stage is a compile-time fact rather than a
 * runtime accident.
 *
 * `requiredChecks` and `correctness` are the compiled closed correctness
 * projection. When a delivered route resolves a compiled profile they are the
 * profile's composed required-check set and resolved fingerprint; otherwise the
 * plan retains the declared route checks and records the explicit absent-profile
 * identity. Ephemeral allocation is never part of the graph.
 */

const CLEANUP_OPERATIONS = ['cleanup.release'] as const;

export interface CompilePlanInput {
  caseId: string;
  intent: CaseIntent;
  route: ResolvedRoute;
  fixture?: ResolvedFixtureBinding;
  /** The compiled correctness projection identity for a delivered route. */
  correctness?: PlanCorrectnessIdentity;
  /**
   * The compiled closed required-check set. When present it replaces the
   * declared route checks; the declared checks are always a retained subset.
   */
  requiredChecks?: readonly string[];
}

export function compilePlan(input: CompilePlanInput): ExecutionPlan {
  const phases: PlanPhase[] = [
    { phase: 'setup', operations: [] },
    { phase: 'precondition', operations: [] },
    { phase: 'action', operations: input.intent.operations.map((entry) => entry.discriminant) },
    { phase: 'evidence', operations: [] },
    { phase: 'cleanup', operations: [...CLEANUP_OPERATIONS] },
  ];

  const requiredChecks = [...(input.requiredChecks ?? input.route.checks)].sort();

  return {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    caseId: input.caseId,
    route: { ...input.route, checks: [...input.route.checks] },
    phases,
    requiredChecks,
    cleanup: [...CLEANUP_OPERATIONS],
    correctness: input.correctness ?? {
      profileId: null,
      resolvedFingerprint: deriveAbsentCorrectnessProfileFingerprint(
        input.route.subjectId,
        input.route.capability,
        null,
      ),
    },
    ...(input.fixture === undefined ? {} : { fixture: { ...input.fixture } }),
  };
}
