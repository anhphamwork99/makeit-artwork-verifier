import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import {
  EVIDENCE_PROVENANCE_SCHEMA_VERSION,
  type EvidenceContractIssue,
  type EvidenceProvenance,
  type EvidenceProvenanceDirtyPolicy,
  type EvidenceProvenanceIdentity,
  isEvidenceProvenanceDirtyPolicy,
  isEvidenceSha256Digest,
  validateEvidenceProvenance,
} from '../contracts/evidence-transaction';

/**
 * Pure repository-relative provenance policy and validation (ADR 0041 P8-A1).
 *
 * Provenance binds the reviewed tree identity: repository revision, dirty
 * policy, a deterministic dirty-tree digest over the governed tracked/untracked
 * inputs, the lockfile, and the CLI/bootstrap/runner/evidence-writer/verifier/
 * runtime-engine content identities, plus the resolved Package-7
 * catalogue/profile identities.
 *
 * The dirty-tree digest is computed over an explicit versioned inclusion /
 * exclusion policy and is repository-relative: absolute and private paths are
 * prohibited and never persisted. Building the digest over an excluded or
 * prohibited path fails closed, so a volatile cache, generated artifact, or
 * secret file can never silently enter the reviewed-tree identity.
 *
 * This module never touches the filesystem; callers supply already-hashed
 * governed entries.
 */

export const EVIDENCE_PROVENANCE_POLICY_VERSION = 2;

export const PROVENANCE_PATH_CLASSES = ['included', 'excluded', 'prohibited'] as const;
export type ProvenancePathClass = (typeof PROVENANCE_PATH_CLASSES)[number];

/** Repository-relative governed input locations (included in the dirty digest). */
export const PROVENANCE_INCLUDED_PREFIXES: readonly string[] = Object.freeze([
  'src/',
  'tests/',
  'catalogues/',
  'cases/',
  'fixtures/',
  'governance/authorities/',
  'bin/',
  'scripts/',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.portable.json',
  'vitest.config.ts',
  'vitest.browser.config.ts',
  'vitest.portable.config.ts',
  'vitest.fe-hosted.config.ts',
  '.pi/skills/verify-artwork-editor/SKILL.md',
  '.pi/skills/verify-artwork-editor/references/',
]);

/** Volatile build output, caches, and evidence output excluded from the digest. */
export const PROVENANCE_EXCLUDED_PREFIXES: readonly string[] = Object.freeze([
  'node_modules/',
  '.next/',
  '.git/',
  '.turbo/',
  'dist/',
  'build/',
  'coverage/',
  'playwright-report/',
  'test-results/',
  'evidence/',
  'e2e/',
  'public/',
  'docs/',
]);

/** Volatile file names/suffixes excluded even under an included prefix. */
export const PROVENANCE_EXCLUDED_SUFFIXES: readonly string[] = Object.freeze([
  '.tsbuildinfo',
  '.log',
  '.tmp',
  '.DS_Store',
]);

export const PROVENANCE_EXCLUDED_FILE_NAMES: readonly string[] = Object.freeze([
  'next-env.d.ts',
  '.DS_Store',
]);

/** Secret/private file names whose presence is a hard policy failure. */
export const PROVENANCE_PROHIBITED_FILE_NAMES: readonly string[] = Object.freeze([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
]);

/** Secret/private file suffixes whose presence is a hard policy failure. */
export const PROVENANCE_PROHIBITED_SUFFIXES: readonly string[] = Object.freeze([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.keystore',
]);

export const PROVENANCE_POLICY_FAILURE_CODES = [
  'PROVENANCE_PATH_NOT_RELATIVE',
  'PROVENANCE_PATH_PROHIBITED',
  'PROVENANCE_DIGEST_INVALID',
  'PROVENANCE_IDENTITY_ORDER_INVALID',
  'PROVENANCE_POLICY_UNSUPPORTED',
] as const;
export type ProvenancePolicyFailureCode = (typeof PROVENANCE_POLICY_FAILURE_CODES)[number];

export class EvidenceProvenancePolicyError extends Error {
  readonly code: ProvenancePolicyFailureCode;
  constructor(code: ProvenancePolicyFailureCode, message: string) {
    super(message);
    this.name = 'EvidenceProvenancePolicyError';
    this.code = code;
  }
}

const LAST_SEGMENT = /([^/]+)$/;

/** Repository-relative identity syntax is broader than public artifact paths. */
export function isGovernedRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.toLowerCase().includes('file:') || value.toLowerCase().includes('blob:')) return false;
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Classify one repository-relative path under the governed inclusion/exclusion
 * policy. Absolute/private/non-relative forms are `prohibited`; governed inputs
 * are `included`; everything else (including volatile output) is `excluded`.
 */
export function classifyGovernedProvenancePath(relativePath: string): ProvenancePathClass {
  if (!isGovernedRepositoryRelativePath(relativePath)) return 'prohibited';
  const name = (LAST_SEGMENT.exec(relativePath)?.[1] ?? '') as string;
  if (PROVENANCE_PROHIBITED_FILE_NAMES.includes(name)) return 'prohibited';
  if (PROVENANCE_PROHIBITED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'prohibited';
  if (PROVENANCE_EXCLUDED_FILE_NAMES.includes(name)) return 'excluded';
  if (PROVENANCE_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'excluded';
  for (const prefix of PROVENANCE_EXCLUDED_PREFIXES) {
    if (relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix)) return 'excluded';
  }
  for (const prefix of PROVENANCE_INCLUDED_PREFIXES) {
    if (relativePath === prefix || relativePath.startsWith(prefix)) return 'included';
  }
  return 'excluded';
}

export function isGovernedProvenancePath(relativePath: string): boolean {
  return classifyGovernedProvenancePath(relativePath) === 'included';
}

export interface GovernedPathEntry {
  readonly path: string;
  readonly sha256: string;
}

/**
 * Select the governed entries that participate in the dirty-tree digest.
 * Throws on a prohibited path so a secret or private path can never enter the
 * reviewed-tree identity, and drops excluded volatile entries.
 */
export function selectGovernedProvenanceEntries(
  entries: readonly GovernedPathEntry[],
): readonly GovernedPathEntry[] {
  const governed: GovernedPathEntry[] = [];
  for (const entry of entries) {
    const pathClass = classifyGovernedProvenancePath(entry.path);
    if (pathClass === 'prohibited') {
      throw new EvidenceProvenancePolicyError(
        'PROVENANCE_PATH_PROHIBITED',
        'A prohibited repository path cannot enter the governed provenance digest.',
      );
    }
    if (!isEvidenceSha256Digest(entry.sha256)) {
      throw new EvidenceProvenancePolicyError(
        'PROVENANCE_DIGEST_INVALID',
        'A governed path entry must declare a lowercase SHA-256 digest.',
      );
    }
    if (pathClass === 'included') governed.push({ path: entry.path, sha256: entry.sha256 });
  }
  return governed.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Deterministic, order-stable digest over the governed tracked/untracked inputs.
 * Entries are sorted by repository-relative path and canonicalized; irrelevant
 * authoring order never moves the digest.
 */
export function buildGovernedTreeDigest(entries: readonly GovernedPathEntry[]): string {
  const governed = selectGovernedProvenanceEntries(entries);
  return sha256Hex(
    canonicalize({
      policyVersion: EVIDENCE_PROVENANCE_POLICY_VERSION,
      entries: governed.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    }),
  );
}

export interface BuildEvidenceProvenanceInput {
  readonly repositoryRevision: string;
  readonly dirtyPolicy: EvidenceProvenanceDirtyPolicy;
  readonly governedEntries: readonly GovernedPathEntry[];
  readonly lockfileDigest: string;
  readonly cliBootstrapDigest: string;
  readonly runnerDigest: string;
  readonly evidenceWriterDigest: string;
  readonly verifierDigest: string;
  readonly runtimeEngineDigest: string;
  readonly catalogueIdentities: readonly EvidenceProvenanceIdentity[];
  readonly profileIdentities: readonly EvidenceProvenanceIdentity[];
}

function sortIdentities(
  identities: readonly EvidenceProvenanceIdentity[],
): EvidenceProvenanceIdentity[] {
  return [...identities]
    .map((entry) => ({ id: entry.id, digest: entry.digest }))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

/**
 * Build one validated provenance record. Identity lists are canonically sorted;
 * the dirty-tree digest is computed over governed entries only; the assembled
 * record is validated against the closed contract before it is returned.
 */
export function buildEvidenceProvenance(input: BuildEvidenceProvenanceInput): EvidenceProvenance {
  if (!isEvidenceProvenanceDirtyPolicy(input.dirtyPolicy)) {
    throw new EvidenceProvenancePolicyError(
      'PROVENANCE_POLICY_UNSUPPORTED',
      'Unknown provenance dirty policy.',
    );
  }
  const provenance: EvidenceProvenance = {
    schemaVersion: EVIDENCE_PROVENANCE_SCHEMA_VERSION,
    policyVersion: EVIDENCE_PROVENANCE_POLICY_VERSION,
    repositoryRevision: input.repositoryRevision,
    dirtyPolicy: input.dirtyPolicy,
    dirtyTreeDigest: buildGovernedTreeDigest(input.governedEntries),
    lockfileDigest: input.lockfileDigest,
    cliBootstrapDigest: input.cliBootstrapDigest,
    runnerDigest: input.runnerDigest,
    evidenceWriterDigest: input.evidenceWriterDigest,
    verifierDigest: input.verifierDigest,
    runtimeEngineDigest: input.runtimeEngineDigest,
    catalogueIdentities: sortIdentities(input.catalogueIdentities),
    profileIdentities: sortIdentities(input.profileIdentities),
  };
  const issues = validateEvidenceProvenance(provenance);
  if (issues.length > 0) {
    throw new EvidenceProvenancePolicyError(
      'PROVENANCE_POLICY_UNSUPPORTED',
      `Assembled provenance is not a complete closed record: ${issues.map((entry) => entry.code).join(', ')}`,
    );
  }
  return provenance;
}

/** Validate a provenance record against the closed contract. */
export function validateGovernedProvenance(value: unknown): readonly EvidenceContractIssue[] {
  return validateEvidenceProvenance(value);
}
