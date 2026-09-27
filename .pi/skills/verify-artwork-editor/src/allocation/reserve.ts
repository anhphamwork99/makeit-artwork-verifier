import type {
  AllocationResult,
  EphemeralResources,
  ExecutionAllocation,
  PlanIdentity,
} from '../contracts/execution';
import type { AllocationFailureReason } from '../contracts/discriminants';
import { EXECUTION_ALLOCATION_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Attempt-specific Ownership Reservation / Execution Allocation (decision 0007
 * N9, specification 10).
 *
 * Ports, process groups, scratch paths, `distDir`s, evidence roots, and setup
 * authorization identifiers are ephemeral. They are never part of
 * `planFingerprint`; allocation binds to already-derived identities and can
 * never change them.
 *
 * An invalid reservation is not a harness contract failure. A valid plan that an
 * external allocation mechanism cannot reserve is `ENVIRONMENT_FAILURE` with
 * `launchAttempted: false`.
 *
 * Residual uncertainty (deferred to the owned-runtime Work Package): this
 * module proves reservation validity and in-process ledger exclusivity. Lease
 * backing across processes and the refusal of unknown externally-owned
 * collisions at launch belong to the runtime ownership implementation.
 */

export interface ResourceValidationFailure {
  ok: false;
  reason: AllocationFailureReason;
  detail: string;
}

export type ResourceValidation = { ok: true } | ResourceValidationFailure;

export function validateEphemeralResources(resources: EphemeralResources): ResourceValidation {
  if (!Number.isInteger(resources.port) || resources.port <= 0 || resources.port > 65_535) {
    return {
      ok: false,
      reason: 'PORT_INVALID',
      detail: `Invalid reserved port: ${String(resources.port)}`,
    };
  }
  if (!Number.isInteger(resources.processGroupId) || resources.processGroupId <= 0) {
    return {
      ok: false,
      reason: 'PROCESS_GROUP_INVALID',
      detail: `Invalid reserved process group: ${String(resources.processGroupId)}`,
    };
  }
  if (resources.distDir.trim().length === 0) {
    return { ok: false, reason: 'DIST_DIR_INVALID', detail: 'Empty distDir reservation' };
  }
  if (resources.evidenceRoot.trim().length === 0) {
    return {
      ok: false,
      reason: 'EVIDENCE_ROOT_INVALID',
      detail: 'Empty evidence root reservation',
    };
  }
  return { ok: true };
}

export function reserveAllocation(
  identity: PlanIdentity,
  executionInstanceId: string,
  ephemeral: EphemeralResources,
): AllocationResult {
  const validation = validateEphemeralResources(ephemeral);
  if (!validation.ok) {
    return {
      status: 'ENVIRONMENT_FAILURE',
      launchAttempted: false,
      reason: validation.reason,
      detail: validation.detail,
    };
  }

  const allocation: ExecutionAllocation = {
    schemaVersion: EXECUTION_ALLOCATION_SCHEMA_VERSION,
    allocationId: `alloc:${executionInstanceId}`,
    executionInstanceId,
    boundTo: { ...identity },
    ephemeral: { ...ephemeral },
  };

  return { status: 'RESERVED', launchAttempted: false, allocation };
}

export interface AllocationLedger {
  reserve(
    identity: PlanIdentity,
    executionInstanceId: string,
    ephemeral: EphemeralResources,
  ): AllocationResult;
  release(executionInstanceId: string): void;
  owned(): readonly EphemeralResources[];
}

function conflicts(candidate: EphemeralResources, owned: EphemeralResources): string | null {
  if (candidate.port === owned.port) return `port ${candidate.port}`;
  if (candidate.processGroupId === owned.processGroupId) {
    return `process group ${candidate.processGroupId}`;
  }
  if (candidate.distDir === owned.distDir) return `distDir ${candidate.distDir}`;
  if (candidate.evidenceRoot === owned.evidenceRoot)
    return `evidence root ${candidate.evidenceRoot}`;
  return null;
}

/**
 * In-process exclusive allocation ledger.
 *
 * A colliding attempt is refused as `ENVIRONMENT_FAILURE` because the external
 * allocation mechanism could not supply the reserved resource; the current owner
 * is never attached to, killed, or deleted (specification 10).
 */
export function createAllocationLedger(): AllocationLedger {
  const held = new Map<string, EphemeralResources>();

  return {
    reserve(identity, executionInstanceId, ephemeral) {
      const validation = validateEphemeralResources(ephemeral);
      if (!validation.ok) {
        return {
          status: 'ENVIRONMENT_FAILURE',
          launchAttempted: false,
          reason: validation.reason,
          detail: validation.detail,
        };
      }

      for (const [owner, owned] of held) {
        const conflict = conflicts(ephemeral, owned);
        if (conflict !== null) {
          return {
            status: 'ENVIRONMENT_FAILURE',
            launchAttempted: false,
            reason: 'RESOURCE_ALREADY_OWNED',
            detail: `Reserved resource ${conflict} is already owned by ${owner}`,
          };
        }
      }

      held.set(executionInstanceId, { ...ephemeral });
      return reserveAllocation(identity, executionInstanceId, ephemeral);
    },
    release(executionInstanceId) {
      held.delete(executionInstanceId);
    },
    owned() {
      return [...held.values()].map((entry) => ({ ...entry }));
    },
  };
}
