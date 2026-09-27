import type { SemanticTargetRole } from './adapter';
import type { Capability } from './discriminants';
import type { ResourceRef } from './resources';

/**
 * Fixture-binding catalogue contract (specification 8.3 P5; WP5 Slice 5-A).
 *
 * A fixture binds one `subjectId × capability × scenarioId` to the setup
 * constructor, its exact inputs, and the semantic target roles the adapter
 * resolves after the seal. `CaseIntent` stays closed, so fixture choice never
 * leaks into `caseId`: a semantic fixture change must be expressed as a new
 * `scenarioId` (and therefore a new `caseId`), while a version-only change moves
 * `materializationFingerprint` only.
 */

export interface BindingFixture {
  fixtureId: string;
  subjectId: string;
  capability: Capability;
  scenarioId: string;
  constructorId: string;
  constructorVersion: number;
  /** Constructor inputs; authoring data only, never a coordinate literal in code. */
  inputs: Readonly<Record<string, unknown>>;
  semanticTargetRoles: readonly SemanticTargetRole[];
  /**
   * Declared resource roles this fixture's workflow may consume (Slice 5-C).
   * A ref carries only a logical id, version, and role name; the exact bytes are
   * resolved from the content-addressed resource manifest.
   */
  resourceRefs?: readonly ResourceRef[];
}

export interface BindingFixtureCatalogue {
  schemaVersion: number;
  fixtures: readonly BindingFixture[];
}

/** Stable key of one binding fixture. */
export function bindingFixtureKey(input: {
  subjectId: string;
  capability: Capability;
  scenarioId: string;
}): string {
  return `${input.subjectId}::${input.capability}::${input.scenarioId}`;
}
