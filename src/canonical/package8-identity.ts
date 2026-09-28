import type {
  EvidenceFinalManifest,
  EvidenceIntendedInventory,
  EvidenceProvenance,
  EvidenceProvenanceIdentity,
  EvidenceReference,
  EvidenceTransactionKind,
} from '../contracts/evidence-transaction';
import { CANONICAL_NAMESPACE, canonicalize, sha256Hex } from './canonicalize';

/**
 * Package-8 canonical identities (ADR 0041 P8-A1).
 *
 * Every Package-8 document derives under its own domain- and version-separated
 * SHA-256 identity built from the shared canonical serializer (decision 0007
 * N6), so the same value can never be replayed across an intended inventory, a
 * final manifest, a provenance record, a reference graph, or an artifact content
 * record. Object authoring order never moves an identity; a semantic value
 * change always does.
 *
 * This module is pure and dormant: it imports no filesystem/CLI/runtime module.
 */

/** Package-8 identity-schema version, separate from the four-level identity core. */
export const PACKAGE8_IDENTITY_SCHEMA_VERSION = 1;

/** Named Package-8 identity domains. */
export const PACKAGE8_IDENTITY_DOMAINS = {
  provenance: 'evidence-provenance',
  intendedInventory: 'evidence-intended-inventory',
  finalManifest: 'evidence-final-manifest',
  referenceGraph: 'evidence-reference-graph',
  transactionState: 'evidence-transaction-state',
  artifactContent: 'evidence-artifact-content',
} as const;
export type Package8IdentityDomain =
  (typeof PACKAGE8_IDENTITY_DOMAINS)[keyof typeof PACKAGE8_IDENTITY_DOMAINS];

/** The full canonical preimage for a Package-8 identity, kept auditable. */
export function buildPackage8IdentityPreimage(
  domain: Package8IdentityDomain,
  value: unknown,
): string {
  return `${CANONICAL_NAMESPACE}/${domain}/v${PACKAGE8_IDENTITY_SCHEMA_VERSION}\n${canonicalize(value)}`;
}

export function package8IdentityDigest(domain: Package8IdentityDomain, value: unknown): string {
  return sha256Hex(buildPackage8IdentityPreimage(domain, value));
}

function sortIdentities(
  identities: readonly EvidenceProvenanceIdentity[],
): EvidenceProvenanceIdentity[] {
  return [...identities]
    .map((entry) => ({ id: entry.id, digest: entry.digest }))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

/**
 * Provenance identity projection. Provenance identity lists are normalized to
 * their canonical sorted order so irrelevant authoring order can never move the
 * identity, while every digest field still participates.
 */
function provenanceProjection(provenance: EvidenceProvenance): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: provenance.schemaVersion,
    policyVersion: provenance.policyVersion,
    repositoryRevision: provenance.repositoryRevision,
    dirtyPolicy: provenance.dirtyPolicy,
    dirtyTreeDigest: provenance.dirtyTreeDigest,
    lockfileDigest: provenance.lockfileDigest,
    cliBootstrapDigest: provenance.cliBootstrapDigest,
    runnerDigest: provenance.runnerDigest,
    evidenceWriterDigest: provenance.evidenceWriterDigest,
    verifierDigest: provenance.verifierDigest,
    runtimeEngineDigest: provenance.runtimeEngineDigest,
    catalogueIdentities: sortIdentities(provenance.catalogueIdentities),
    profileIdentities: sortIdentities(provenance.profileIdentities),
  };
}

export function deriveProvenanceIdentity(provenance: EvidenceProvenance): string {
  return package8IdentityDigest(
    PACKAGE8_IDENTITY_DOMAINS.provenance,
    provenanceProjection(provenance),
  );
}

export function deriveIntendedInventoryIdentity(inventory: EvidenceIntendedInventory): string {
  return package8IdentityDigest(PACKAGE8_IDENTITY_DOMAINS.intendedInventory, {
    schemaVersion: inventory.schemaVersion,
    label: inventory.label,
    transactionKind: inventory.transactionKind,
    transactionId: inventory.transactionId,
    sealedStrictSchemas: inventory.sealedStrictSchemas,
    provenance: provenanceProjection(inventory.provenance),
    artifacts: [...inventory.artifacts],
    createdAtUtc: inventory.createdAtUtc,
  });
}

export function deriveFinalManifestIdentity(manifest: EvidenceFinalManifest): string {
  return package8IdentityDigest(PACKAGE8_IDENTITY_DOMAINS.finalManifest, {
    schemaVersion: manifest.schemaVersion,
    label: manifest.label,
    transactionKind: manifest.transactionKind,
    transactionId: manifest.transactionId,
    inventoryIdentity: manifest.inventoryIdentity,
    provenanceIdentity: manifest.provenanceIdentity,
    sealedStrictSchemas: manifest.sealedStrictSchemas,
    behaviorOutcome: manifest.behaviorOutcome,
    transactionResult: manifest.transactionResult,
    committedArtifacts: [...manifest.committedArtifacts],
    references: [...manifest.references],
    committedAtUtc: manifest.committedAtUtc,
  });
}

export function deriveReferenceGraphIdentity(references: readonly EvidenceReference[]): string {
  return package8IdentityDigest(PACKAGE8_IDENTITY_DOMAINS.referenceGraph, [...references]);
}

export interface EvidenceTransactionStateIdentityInput {
  readonly state: string;
  readonly transactionKind: EvidenceTransactionKind | null;
  readonly transactionId: string | null;
  readonly failureClass: string | null;
}

export function deriveTransactionStateIdentity(
  input: EvidenceTransactionStateIdentityInput,
): string {
  return package8IdentityDigest(PACKAGE8_IDENTITY_DOMAINS.transactionState, {
    state: input.state,
    transactionKind: input.transactionKind,
    transactionId: input.transactionId,
    failureClass: input.failureClass,
  });
}

export interface EvidenceArtifactContentIdentityInput {
  readonly artifactId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly semanticDigest: string | null;
}

export function deriveArtifactContentIdentity(input: EvidenceArtifactContentIdentityInput): string {
  return package8IdentityDigest(PACKAGE8_IDENTITY_DOMAINS.artifactContent, {
    artifactId: input.artifactId,
    byteLength: input.byteLength,
    sha256: input.sha256,
    semanticDigest: input.semanticDigest,
  });
}
