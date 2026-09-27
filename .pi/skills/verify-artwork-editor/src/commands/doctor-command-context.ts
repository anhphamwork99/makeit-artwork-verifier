import type { CommandStatusAuthority } from '../contracts/command-check';
import {
  OBSERVATION_BRIDGE_READ_ONLY_METHODS,
  OBSERVATION_BRIDGE_VERSION,
  OBSERVATION_GLOBAL_NAME,
} from '../contracts/seam';
import { DOCTOR_RESULT_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  type CommandAuthorityDeclaration,
  type CommandCheckDeclaration,
  type CommandContextInput,
  type CommandContextResult,
  evaluateCommandContext,
  projectCommandStatusAuthority,
} from './command-context';

/**
 * P7-B B1-G inactive explicit-status Doctor command context (ADR 0028 §3 B1-G;
 * ADR 0026 "Doctor and production-absence rule").
 *
 * Doctor is read-only and validates instance identity, route/title, the live
 * observation bridge contract, the mounted Stage/state facts, the governed
 * environment cell, and run ownership before any drive (production
 * specification §10; WP5 Slice 5-A; TS-4/TS-5). It never consumes or fabricates
 * a `ResolvedCorrectnessProfile`: its versioned command authority below is the
 * complete, closed declaration of its required checks, dispositions, stable
 * expectations, and evidence roles.
 *
 * The declared required-check set mirrors the accepted Doctor result exactly
 * (same ids, same order, same expectation) so the atomic B2 cutover can replace
 * the inline boolean checks without changing the scenario, required-check
 * meaning, or the accepted command contract. Accepted meaning is preserved:
 *
 *  - a current, interpretable match after the declared required evidence was
 *    consumed is `PASS`;
 *  - a trustworthy product mismatch (wrong route/title, wrong bridge version
 *    or method surface, an unfrozen or mutating bridge, a mismatched cursor, an
 *    unbounded waiter, wrong geometry/raster schema, an un-mounted Stage,
 *    missing Stage layers, or fewer than two layouts) is `FAIL`;
 *  - an observed governed-environment mismatch is a trustworthy
 *    environment mismatch: the check is `FAIL` and the environment-failure
 *    precedence makes the *final* outcome `ENVIRONMENT_FAILURE` while the
 *    behavior outcome stays separately available;
 *  - absent bridge authority (`doctor.bridge.available`), an absent/malformed
 *    document identity (`doctor.bridge.document`), an absent scenegraph fact
 *    (`doctor.state.scenegraph`), or any missing/stale/torn/ambiguous/malformed/
 *    incomplete/unsupported authority is `UNUSABLE`.
 *
 * This module is deliberately inactive: nothing here is imported by the active
 * Doctor CLI, browser runner, classifier, writer, or public projection, and no
 * current record is emitted from it.
 */

export const DOCTOR_COMMAND_CONTEXT = 'doctor' as const;

/** The Doctor command-authority schema; it tracks the accepted Doctor result schema. */
export const DOCTOR_COMMAND_SCHEMA_VERSION = DOCTOR_RESULT_SCHEMA_VERSION;

/** The stable versioned Doctor command-authority identity. */
export const DOCTOR_COMMAND_AUTHORITY_ID = 'doctor-result-v7';

/** The observation bridge contract version Doctor requires. */
export const DOCTOR_COMMAND_EXPECTED_BRIDGE_VERSION = OBSERVATION_BRIDGE_VERSION;

/** The exact mounted Konva Stage layer names Doctor requires (accepted contract). */
export const DOCTOR_COMMAND_REQUIRED_STAGE_LAYERS = [
  'artwork-boards',
  'artwork-smart-guides',
  'artwork-warp-handles',
  'artwork-drag-overlay',
] as const;

/** The minimum accepted layout count Doctor requires. */
export const DOCTOR_COMMAND_MIN_LAYOUTS = 2;

/** Closed Doctor command evidence roles. */
export const DOCTOR_COMMAND_REQUIRED_EVIDENCE = [
  'doctor.browser-environment',
  'doctor.bridge-inspection',
  'doctor.instance-observation',
] as const;
export const DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE = [
  'doctor.console-errors',
  'doctor.failed-requests',
  'doctor.screenshot',
] as const;

/**
 * The closed Doctor required-check declaration. Every id, disposition, stable
 * expectation, and evidence role is declared exactly once; the declaration owns
 * the command contract instead of an executor-local boolean list.
 */
export const DOCTOR_COMMAND_CHECKS: readonly CommandCheckDeclaration[] = Object.freeze([
  Object.freeze({
    checkId: 'doctor.route',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ route: '/artwork/editor' }),
    requiredEvidence: Object.freeze(['doctor.instance-observation']),
  }),
  Object.freeze({
    checkId: 'doctor.title',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ title: 'Editor - Artwork' }),
    requiredEvidence: Object.freeze(['doctor.instance-observation']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.available',
    negativeDisposition: 'authority-unavailable' as const,
    expected: Object.freeze({ global: OBSERVATION_GLOBAL_NAME, available: true }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.version',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ bridgeVersion: DOCTOR_COMMAND_EXPECTED_BRIDGE_VERSION }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.document',
    negativeDisposition: 'authority-unavailable' as const,
    expected: Object.freeze({ documentIdentity: 'present' }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.methods',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ methods: OBSERVATION_BRIDGE_READ_ONLY_METHODS }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.frozen',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ frozen: true }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.cursor',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ cursorCurrent: true }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.cursor-stable',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ stableReads: 2 }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.waiter',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ waiterStatus: 'timeout' }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.geometry',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ geometrySchema: 2, mounted: true }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.raster',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ rasterSchema: 3, promise: true }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.bridge.no-mutation',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ mutationDetected: false }),
    requiredEvidence: Object.freeze(['doctor.bridge-inspection']),
  }),
  Object.freeze({
    checkId: 'doctor.stage.mounted',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ mounted: true }),
    requiredEvidence: Object.freeze(['doctor.instance-observation']),
  }),
  Object.freeze({
    checkId: 'doctor.stage.layers',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ layers: DOCTOR_COMMAND_REQUIRED_STAGE_LAYERS }),
    requiredEvidence: Object.freeze(['doctor.instance-observation']),
  }),
  Object.freeze({
    checkId: 'doctor.state.layouts',
    negativeDisposition: 'product-mismatch' as const,
    expected: Object.freeze({ minLayouts: DOCTOR_COMMAND_MIN_LAYOUTS }),
    requiredEvidence: Object.freeze(['doctor.instance-observation']),
  }),
  Object.freeze({
    checkId: 'doctor.state.scenegraph',
    negativeDisposition: 'authority-unavailable' as const,
    expected: Object.freeze({ scenegraphFact: 'present' }),
    requiredEvidence: Object.freeze(['doctor.instance-observation']),
  }),
  Object.freeze({
    checkId: 'doctor.environment.cell',
    negativeDisposition: 'environment-mismatch' as const,
    expected: Object.freeze({ comparedAgainst: 'governed-environment-cell' }),
    requiredEvidence: Object.freeze(['doctor.browser-environment']),
  }),
]);

/** The strict versioned Doctor command authority. */
export const DOCTOR_COMMAND_AUTHORITY: CommandAuthorityDeclaration = Object.freeze({
  schemaVersion: DOCTOR_COMMAND_SCHEMA_VERSION,
  command: DOCTOR_COMMAND_CONTEXT,
  commandAuthorityId: DOCTOR_COMMAND_AUTHORITY_ID,
  requiredChecks: DOCTOR_COMMAND_CHECKS,
  requiredAuthoritativeEvidence: Object.freeze([...DOCTOR_COMMAND_REQUIRED_EVIDENCE]),
  diagnosticOnlyEvidence: Object.freeze([...DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE]),
});

/** The projected `CommandStatusAuthority` identity of the Doctor command. */
export const DOCTOR_COMMAND_STATUS_AUTHORITY: CommandStatusAuthority =
  projectCommandStatusAuthority(DOCTOR_COMMAND_AUTHORITY);

/** Constructs the complete explicit-status Doctor command result from delivered facts. */
export function evaluateDoctorCommandChecks(input: CommandContextInput): CommandContextResult {
  return evaluateCommandContext(DOCTOR_COMMAND_AUTHORITY, input);
}
