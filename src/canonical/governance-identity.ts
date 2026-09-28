import { CANONICAL_NAMESPACE, canonicalize, sha256Hex } from './canonicalize';

/** Isolated from the accepted Package-8 and generic engine identity domains. */
export const GOVERNANCE_IDENTITY_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_IDENTITY_DOMAINS = {
  selectionManifest: 'selection-manifest',
  qualificationBatch: 'qualification-batch',
} as const;
export type GovernanceIdentityDomain =
  (typeof GOVERNANCE_IDENTITY_DOMAINS)[keyof typeof GOVERNANCE_IDENTITY_DOMAINS];

export function deriveGovernanceIdentity(domain: GovernanceIdentityDomain, value: unknown): string {
  return sha256Hex(
    `${CANONICAL_NAMESPACE}/gate-g/governance-identity/v${GOVERNANCE_IDENTITY_SCHEMA_VERSION}/${domain}\n${canonicalize(value)}`,
  );
}
