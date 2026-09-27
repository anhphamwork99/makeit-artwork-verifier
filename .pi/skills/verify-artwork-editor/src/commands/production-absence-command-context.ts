import {
  PRODUCTION_ABSENCE_ROUTE,
  PRODUCTION_ABSENCE_SCHEMA_VERSION,
} from '../contracts/production-absence';
import type { CommandStatusAuthority } from '../contracts/command-check';
import {
  type CommandAuthorityDeclaration,
  type CommandCheckDeclaration,
  type CommandContextInput,
  type CommandContextResult,
  evaluateCommandContext,
  projectCommandStatusAuthority,
} from './command-context';

/**
 * P7-B B1-G inactive explicit-status production-absence command context
 * (ADR 0028 §3 B1-G; ADR 0026 "Doctor and production-absence rule").
 *
 * Production absence is proven by (1) a static scan of the emitted production
 * JavaScript/manifests for every reachable observation/setup seam marker and (2)
 * a real-Chromium visit of the production document, twice, proving the globals,
 * registered-Symbol slots, and seam chunk requests are absent on load and stay
 * absent across a reload (specification 16 Gate C; TS-3/TS-4). It never consumes
 * or fabricates a `ResolvedCorrectnessProfile`: its versioned command authority
 * below is the complete, closed declaration of its required checks,
 * dispositions, stable expectations, and evidence roles.
 *
 * The declared required-check set mirrors the accepted production-absence
 * checks exactly (same ids, same order, same expectation). Accepted meaning is
 * preserved:
 *
 *  - a clean scan and a clean hydrated initial/reload observation with the
 *    declared required evidence consumed is `PASS`;
 *  - a seam marker present in an emitted artifact, or a live seam global,
 *    Symbol slot, or seam request observed on a hydrated production document, is
 *    a trustworthy product/build mismatch → `FAIL`;
 *  - a requested production chunk that is not a reconciled emitted artifact, or
 *    any missing/stale/torn/ambiguous/malformed/incomplete/unsupported
 *    authority, is `UNUSABLE` (it cannot establish a trustworthy product claim);
 *  - diagnostic-only evidence (the bounded screenshot) can never satisfy a
 *    required check.
 *
 * This module is deliberately inactive: nothing here is imported by the active
 * production-absence CLI, static scan, browser proof, classifier, writer, or
 * public projection, and no current record is emitted from it.
 */

export const PRODUCTION_ABSENCE_COMMAND_CONTEXT = 'production-absence' as const;

/** The production-absence command-authority schema. */
export const PRODUCTION_ABSENCE_COMMAND_SCHEMA_VERSION = PRODUCTION_ABSENCE_SCHEMA_VERSION;

/** The stable versioned production-absence command-authority identity. */
export const PRODUCTION_ABSENCE_COMMAND_AUTHORITY_ID = 'production-absence-v1';

/** The declared production-absence route contract. */
export const PRODUCTION_ABSENCE_COMMAND_ROUTE = PRODUCTION_ABSENCE_ROUTE;

/** Closed production-absence command evidence roles. */
export const PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE = [
  'production.artifact-scan',
  'production.browser-observation.initial',
  'production.browser-observation.reload',
  'production.chunk-reconciliation',
] as const;
export const PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE = ['production.screenshot'] as const;

/**
 * The closed production-absence required-check declaration. Every id,
 * disposition, stable expectation, and evidence role is declared exactly once.
 */
export const PRODUCTION_ABSENCE_COMMAND_CHECKS: readonly CommandCheckDeclaration[] = Object.freeze([
  Object.freeze({
    checkId: 'production.artifact-absence',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ markers: 'none' }),
    requiredEvidence: Object.freeze(['production.artifact-scan']),
  }),
  Object.freeze({
    checkId: 'production.browser-absence.initial',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ attempt: 'initial', violations: 'none' }),
    requiredEvidence: Object.freeze(['production.browser-observation.initial']),
  }),
  Object.freeze({
    checkId: 'production.browser-absence.reload',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ attempt: 'reload', violations: 'none' }),
    requiredEvidence: Object.freeze(['production.browser-observation.reload']),
  }),
  Object.freeze({
    checkId: 'production.chunk-reconciliation',
    negativeDisposition: 'authority-unavailable' as const,
    expected: Object.freeze({ unresolved: 'none' }),
    requiredEvidence: Object.freeze(['production.chunk-reconciliation']),
  }),
]);

/** The strict versioned production-absence command authority. */
export const PRODUCTION_ABSENCE_COMMAND_AUTHORITY: CommandAuthorityDeclaration = Object.freeze({
  schemaVersion: PRODUCTION_ABSENCE_COMMAND_SCHEMA_VERSION,
  command: PRODUCTION_ABSENCE_COMMAND_CONTEXT,
  commandAuthorityId: PRODUCTION_ABSENCE_COMMAND_AUTHORITY_ID,
  requiredChecks: PRODUCTION_ABSENCE_COMMAND_CHECKS,
  requiredAuthoritativeEvidence: Object.freeze([...PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE]),
  diagnosticOnlyEvidence: Object.freeze([...PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE]),
});

/** The projected `CommandStatusAuthority` identity of the production-absence command. */
export const PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY: CommandStatusAuthority =
  projectCommandStatusAuthority(PRODUCTION_ABSENCE_COMMAND_AUTHORITY);

/** Constructs the complete explicit-status production-absence result from delivered facts. */
export function evaluateProductionAbsenceCommandChecks(
  input: CommandContextInput,
): CommandContextResult {
  return evaluateCommandContext(PRODUCTION_ABSENCE_COMMAND_AUTHORITY, input);
}
