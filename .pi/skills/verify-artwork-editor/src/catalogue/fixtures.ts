import { BINDING_FIXTURE_CATALOGUE_SCHEMA_VERSION } from '../contracts/schema-versions';
import { isCapability } from '../contracts/discriminants';
import type { BindingFixture, BindingFixtureCatalogue } from '../contracts/fixtures';
import type { ResourceRef } from '../contracts/resources';
import type { SemanticTargetRole } from '../contracts/adapter';
import { TARGET_LAYOUT_ROLES, TARGET_RESOLUTION_TIMINGS } from '../contracts/adapter';
import { bindingFixtureKey } from '../contracts/fixtures';

/**
 * Fixture-binding catalogue parsing and resolution (specification 8.3 P5).
 *
 * Parsing is strict and closed: unknown keys, an unknown Capability, a duplicate
 * binding key, or a malformed target role fails structurally so an authoring
 * mistake can never become an implicit runtime default.
 */

export type FixtureCatalogueErrorCode =
  | 'FIXTURE_CATALOGUE_DUPLICATE'
  | 'FIXTURE_CATALOGUE_INVALID'
  | 'FIXTURE_CATALOGUE_SCHEMA_UNSUPPORTED';

export class FixtureCatalogueError extends Error {
  readonly code: FixtureCatalogueErrorCode;

  constructor(code: FixtureCatalogueErrorCode, message: string) {
    super(message);
    this.name = 'FixtureCatalogueError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: FixtureCatalogueErrorCode, message: string): never {
  throw new FixtureCatalogueError(code, message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('FIXTURE_CATALOGUE_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail('FIXTURE_CATALOGUE_INVALID', `${label} has unknown keys: ${unknown.join(', ')}`);
  }
}

function parseTargetRole(raw: unknown, label: string): SemanticTargetRole {
  if (!isRecord(raw)) fail('FIXTURE_CATALOGUE_INVALID', `${label} must be an object`);
  requireExactKeys(
    raw,
    ['role', 'kind', 'layoutRole', 'resolution', 'geometryProfile', 'semanticProfile'],
    label,
  );
  const layoutRole = requireString(raw.layoutRole, `${label}.layoutRole`);
  if (!(TARGET_LAYOUT_ROLES as readonly string[]).includes(layoutRole)) {
    fail(
      'FIXTURE_CATALOGUE_INVALID',
      `${label}.layoutRole must be one of ${TARGET_LAYOUT_ROLES.join(', ')}`,
    );
  }
  // ADR 0018 CR3: `resolution` is a closed, explicit discriminant. The v2
  // parser never defaults an omitted value; a missing or unknown value fails
  // closed so the authoring catalogue itself stays complete and auditable.
  if (raw.resolution === undefined) {
    fail('FIXTURE_CATALOGUE_INVALID', `${label}.resolution is required`);
  }
  const resolution = requireString(raw.resolution, `${label}.resolution`);
  if (!(TARGET_RESOLUTION_TIMINGS as readonly string[]).includes(resolution)) {
    fail(
      'FIXTURE_CATALOGUE_INVALID',
      `${label}.resolution must be one of ${TARGET_RESOLUTION_TIMINGS.join(', ')}`,
    );
  }
  if (raw.geometryProfile !== undefined && typeof raw.geometryProfile !== 'string') {
    fail('FIXTURE_CATALOGUE_INVALID', `${label}.geometryProfile must be a string when present`);
  }
  if (raw.semanticProfile !== undefined && typeof raw.semanticProfile !== 'string') {
    fail('FIXTURE_CATALOGUE_INVALID', `${label}.semanticProfile must be a string when present`);
  }
  return {
    role: requireString(raw.role, `${label}.role`),
    kind: requireString(raw.kind, `${label}.kind`),
    layoutRole: layoutRole as SemanticTargetRole['layoutRole'],
    resolution: resolution as SemanticTargetRole['resolution'],
    ...(raw.geometryProfile === undefined
      ? {}
      : { geometryProfile: raw.geometryProfile as string }),
    ...(raw.semanticProfile === undefined
      ? {}
      : { semanticProfile: raw.semanticProfile as string }),
  };
}

function parseResourceRef(raw: unknown, label: string): ResourceRef {
  if (!isRecord(raw)) fail('FIXTURE_CATALOGUE_INVALID', `${label} must be an object`);
  requireExactKeys(raw, ['logicalId', 'version', 'role'], label);
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('FIXTURE_CATALOGUE_INVALID', `${label}.version must be a positive integer`);
  }
  return {
    logicalId: requireString(raw.logicalId, `${label}.logicalId`),
    version,
    role: requireString(raw.role, `${label}.role`),
  };
}

function parseFixture(raw: unknown, index: number): BindingFixture {
  const label = `fixtures[${index}]`;
  if (!isRecord(raw)) fail('FIXTURE_CATALOGUE_INVALID', `${label} must be an object`);
  requireExactKeys(
    raw,
    [
      'fixtureId',
      'subjectId',
      'capability',
      'scenarioId',
      'constructorId',
      'constructorVersion',
      'inputs',
      'semanticTargetRoles',
      'resourceRefs',
    ],
    label,
  );
  if (!isCapability(raw.capability)) {
    fail('FIXTURE_CATALOGUE_INVALID', `${label}.capability is not a declared Capability`);
  }
  const constructorVersion = raw.constructorVersion;
  if (
    typeof constructorVersion !== 'number' ||
    !Number.isInteger(constructorVersion) ||
    constructorVersion < 1
  ) {
    fail('FIXTURE_CATALOGUE_INVALID', `${label}.constructorVersion must be a positive integer`);
  }
  if (!isRecord(raw.inputs)) {
    fail('FIXTURE_CATALOGUE_INVALID', `${label}.inputs must be an object`);
  }
  if (!Array.isArray(raw.semanticTargetRoles) || raw.semanticTargetRoles.length === 0) {
    fail(
      'FIXTURE_CATALOGUE_INVALID',
      `${label}.semanticTargetRoles must declare at least one role`,
    );
  }

  return {
    fixtureId: requireString(raw.fixtureId, `${label}.fixtureId`),
    subjectId: requireString(raw.subjectId, `${label}.subjectId`),
    capability: raw.capability,
    scenarioId: requireString(raw.scenarioId, `${label}.scenarioId`),
    constructorId: requireString(raw.constructorId, `${label}.constructorId`),
    constructorVersion,
    inputs: structuredClone(raw.inputs),
    semanticTargetRoles: raw.semanticTargetRoles.map((entry, roleIndex) =>
      parseTargetRole(entry, `${label}.semanticTargetRoles[${roleIndex}]`),
    ),
    ...(raw.resourceRefs === undefined
      ? {}
      : {
          resourceRefs: (() => {
            if (!Array.isArray(raw.resourceRefs)) {
              fail('FIXTURE_CATALOGUE_INVALID', `${label}.resourceRefs must be an array`);
            }
            const refs = raw.resourceRefs.map((entry, refIndex) =>
              parseResourceRef(entry, `${label}.resourceRefs[${refIndex}]`),
            );
            const roles = refs.map((ref) => ref.role);
            if (new Set(roles).size !== roles.length) {
              fail('FIXTURE_CATALOGUE_INVALID', `${label}.resourceRefs declares a duplicate role`);
            }
            return refs;
          })(),
        }),
  };
}

export function parseBindingFixtureCatalogue(raw: unknown): BindingFixtureCatalogue {
  if (!isRecord(raw)) fail('FIXTURE_CATALOGUE_INVALID', 'Fixture catalogue must be an object');
  if (raw.schemaVersion !== BINDING_FIXTURE_CATALOGUE_SCHEMA_VERSION) {
    fail(
      'FIXTURE_CATALOGUE_SCHEMA_UNSUPPORTED',
      `Unsupported fixture catalogue schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) {
    fail('FIXTURE_CATALOGUE_INVALID', 'Fixture catalogue must declare at least one fixture');
  }
  const fixtures = raw.fixtures.map(parseFixture);
  const keys = fixtures.map((fixture) =>
    bindingFixtureKey({
      subjectId: fixture.subjectId,
      capability: fixture.capability,
      scenarioId: fixture.scenarioId,
    }),
  );
  if (new Set(keys).size !== keys.length) {
    fail(
      'FIXTURE_CATALOGUE_DUPLICATE',
      'Fixture catalogue declares a duplicate subjectId × capability × scenarioId binding',
    );
  }
  return {
    schemaVersion: raw.schemaVersion,
    fixtures: fixtures.sort((left, right) => (left.fixtureId < right.fixtureId ? -1 : 1)),
  };
}

/** Exact binding lookup; a missing fixture is returned as `null`, never guessed. */
export function resolveBindingFixture(
  catalogue: BindingFixtureCatalogue,
  input: { subjectId: string; capability: BindingFixture['capability']; scenarioId: string },
): BindingFixture | null {
  const key = bindingFixtureKey(input);
  return (
    catalogue.fixtures.find(
      (fixture) =>
        bindingFixtureKey({
          subjectId: fixture.subjectId,
          capability: fixture.capability,
          scenarioId: fixture.scenarioId,
        }) === key,
    ) ?? null
  );
}
