import {
  CLEANUP_ORDER,
  PRESERVED_OWNERSHIP_KINDS,
  type OwnershipKind,
} from '../contracts/discriminants';
import type { ExecutionAllocation, PlanIdentity } from '../contracts/execution';
import type {
  OwnershipCleanupManifest,
  OwnershipProof,
  OwnershipRecord,
} from '../contracts/planner-outputs';
import { OWNERSHIP_CLEANUP_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Ownership and cleanup manifest (specification 8.5, 10).
 *
 * At plan time the manifest declares the expected owners, the exact cleanup
 * order, and the evidence that must survive cleanup. After allocation it binds
 * the concrete reserved resources and records the exclusivity proof. Cleanup
 * removes only recognized owned resources and never removes evidence.
 */

export { CLEANUP_ORDER, PRESERVED_OWNERSHIP_KINDS };

export interface OwnershipManifestInput {
  identity: PlanIdentity;
  executionInstanceId: string | null;
  allocation: ExecutionAllocation | null;
}

function bindingFor(
  ownerKind: OwnershipKind,
  input: OwnershipManifestInput,
): { bindingId: string; exclusive: boolean } {
  const { allocation, executionInstanceId } = input;
  if (!allocation || executionInstanceId === null) {
    return { bindingId: 'unreserved', exclusive: false };
  }

  switch (ownerKind) {
    case 'browser':
    case 'browser-context':
    case 'route-handler':
      return { bindingId: executionInstanceId, exclusive: true };
    case 'app-port':
      return { bindingId: String(allocation.ephemeral.port), exclusive: true };
    case 'app-process-group':
      return { bindingId: String(allocation.ephemeral.processGroupId), exclusive: true };
    case 'app-server':
      return { bindingId: String(allocation.ephemeral.port), exclusive: true };
    case 'next-dist-dir':
    case 'run-scratch':
      return { bindingId: allocation.ephemeral.distDir, exclusive: true };
    case 'evidence-root':
      return { bindingId: allocation.ephemeral.evidenceRoot, exclusive: true };
    default:
      return { bindingId: 'unreserved', exclusive: false };
  }
}

export function buildOwnershipCleanupManifest(
  input: OwnershipManifestInput,
): OwnershipCleanupManifest {
  const ownerKinds: OwnershipKind[] = [...CLEANUP_ORDER, ...PRESERVED_OWNERSHIP_KINDS];
  const expectedOwners: OwnershipRecord[] = ownerKinds.map((ownerKind) => ({
    ownerKind,
    ...bindingFor(ownerKind, input),
  }));

  const ownershipProofs: OwnershipProof[] = [
    {
      proofKind: 'plan-binding',
      bindingId: input.identity.planFingerprint,
      exclusive: false,
    },
  ];

  if (input.allocation) {
    ownershipProofs.push({
      proofKind: 'allocation-ledger-reservation',
      bindingId: input.allocation.allocationId,
      exclusive: true,
    });
  }

  return {
    schemaVersion: OWNERSHIP_CLEANUP_SCHEMA_VERSION,
    caseId: input.identity.caseId,
    executionInstanceId: input.executionInstanceId,
    expectedOwners,
    cleanupOrder: [...CLEANUP_ORDER],
    preserved: [...PRESERVED_OWNERSHIP_KINDS],
    ownershipProofs,
  };
}
