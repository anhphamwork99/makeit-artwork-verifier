import { createHash } from 'node:crypto';

import { IDENTITY_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Stable canonical serialization and domain-separated SHA-256 identities
 * (decision 0007 N6).
 *
 * The canonical form is deterministic under object authoring order and rejects
 * every value that has no unambiguous representation — including `undefined`,
 * non-finite numbers, sparse arrays, functions, symbols, `bigint`, and
 * non-plain objects such as `Date`, `Map`, or class instances. Rejecting is
 * deliberate: silently coercing such a value would let two semantically
 * different contracts collapse onto one fingerprint.
 *
 * Identity preimages are domain- and version-separated so the same value can
 * never be replayed across artifact kinds or identity-schema versions. The
 * preimage remains auditable through {@link buildIdentityPreimage}.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

/** Named identity domains. Every artifact kind derives under its own domain. */
export const IDENTITY_DOMAINS = {
  caseId: 'case-id',
  materialization: 'materialization',
  plan: 'plan',
  subjectRegistry: 'subject-registry',
  applicationInventory: 'application-inventory',
  approvedOperationCatalogue: 'approved-operation-catalogue',
  adapterCatalogue: 'adapter-catalogue',
  workflowCatalogue: 'workflow-catalogue',
  coverageModel: 'coverage-model',
  coverageSelection: 'coverage-selection',
  resourceManifest: 'resource-manifest',
  fixtureInputs: 'fixture-inputs',
  targetRoleContract: 'target-role-contract',
  diagnosticSuite: 'diagnostic-suite',
  // Package 7 Slice A correctness-contract components (ADR 0023). Each
  // component type derives under its own domain so the same value can never be
  // replayed between a readiness declaration, a capture declaration, an Oracle
  // declaration, a tolerance, a visual authority, a normalization declaration,
  // a composed required-check set, and a resolved correctness profile.
  readinessDeclaration: 'readiness-declaration',
  captureDeclaration: 'capture-declaration',
  oracleDeclaration: 'oracle-declaration',
  capabilityBaseline: 'capability-baseline',
  subjectAddition: 'subject-addition',
  routeProfileSelection: 'route-profile-selection',
  requiredCheckSet: 'required-check-set',
  toleranceDeclaration: 'tolerance-declaration',
  visualAuthority: 'visual-authority',
  normalizationDeclaration: 'normalization-declaration',
  resolvedCorrectnessProfile: 'resolved-correctness-profile',
  // P7-B B1-G command-context authority (Doctor and production-absence). A
  // command authority is a distinct artifact kind: it must never collide with a
  // compiled correctness profile or with another command context.
  commandStatusAuthority: 'command-status-authority',
  // P7-C completeness ledger (gap-plan §5 P7-C; ADR 0039). The ledger is its
  // own artifact kind: its identity must never replay as a correctness profile,
  // coverage selection, or suite aggregate.
  package7CompletenessLedger: 'package7-completeness-ledger',
} as const;
export type IdentityDomain = (typeof IDENTITY_DOMAINS)[keyof typeof IDENTITY_DOMAINS];

export const CANONICAL_NAMESPACE = 'makeit.verify-artwork-editor';

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`Non-finite number is not canonicalizable: ${value}`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return canonicalizeObject(value);
    case 'undefined':
      throw new CanonicalizationError('Undefined is not canonicalizable');
    default:
      throw new CanonicalizationError(`Unsupported canonical value type: ${typeof value}`);
  }
}

function canonicalizeObject(value: object): string {
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      parts.push(canonicalizeDefined(value[index], `[${index}]`));
    }
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(value)) {
    throw new CanonicalizationError(
      `Non-plain object is not canonicalizable: ${Object.prototype.toString.call(value)}`,
    );
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of Object.keys(record).sort()) {
    parts.push(`${JSON.stringify(key)}:${canonicalizeDefined(record[key], key)}`);
  }

  return `{${parts.join(',')}}`;
}

function canonicalizeDefined(value: unknown, path: string): string {
  if (value === undefined) {
    throw new CanonicalizationError(`Undefined is not canonicalizable at ${path}`);
  }
  return canonicalize(value);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The full canonical preimage for an identity. Kept addressable so a digest is
 * never the only available diagnosis (decision 0007 N6).
 */
export function buildIdentityPreimage(
  domain: IdentityDomain,
  schemaVersion: number,
  value: unknown,
): string {
  return `${CANONICAL_NAMESPACE}/${domain}/v${schemaVersion}\n${canonicalize(value)}`;
}

export function domainSeparatedDigest(
  domain: IdentityDomain,
  schemaVersion: number,
  value: unknown,
): string {
  return sha256Hex(buildIdentityPreimage(domain, schemaVersion, value));
}

/** Convenience wrapper for the identity-schema version shared by all four levels. */
export function identityDigest(domain: IdentityDomain, value: unknown): string {
  return domainSeparatedDigest(domain, IDENTITY_SCHEMA_VERSION, value);
}
