import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  deriveIntendedInventoryIdentity,
  deriveProvenanceIdentity,
} from '../canonical/package8-identity';
import {
  EVIDENCE_FINAL_MANIFEST_FILE_NAME,
  EVIDENCE_INTENDED_INVENTORY_FILE_NAME,
  type EvidenceArtifactEntry,
  type EvidenceFinalManifest,
  type EvidenceIntendedInventory,
  isEvidenceRelativePath,
  validateEvidenceFinalManifest,
  validateEvidenceIntendedInventory,
} from '../contracts/evidence-transaction';
import { type SanitizedArtifactApproval, snapshotSanitizationApproval } from './sanitize';
import { validateInventoryManifestAgreement, validateReferenceGraph } from './reference-graph';
import {
  type EvidenceFinalizationEvaluation,
  type EvidenceFinalizationOutcome,
  type EvidenceFinalizationStep,
  type EvidenceTransactionFailureClass,
  evaluateFinalizationOutcomes,
  planFinalizationOrder,
} from './transaction';
import { RunRecordExistsError, RunRecordWriteError, writeExclusiveExactBytes } from './writer';

/**
 * Dormant opaque publication boundary (ADR 0041 / ADR 0042).
 *
 * Planning performs the complete transaction preflight without filesystem I/O
 * and returns a frozen, data-free handle. The executable payload is held only in
 * a module-private WeakMap. Execution accepts that authenticated handle only;
 * raw roots, steps, documents, and bytes are never executable inputs.
 */

export const EVIDENCE_PUBLICATION_FAILURE_CODES = [
  'PUBLICATION_PATH_UNSAFE',
  'PUBLICATION_TARGET_EXISTS',
  'PUBLICATION_IO_FAILURE',
  'PUBLICATION_BYTES_NOT_APPROVED',
  'PUBLICATION_BYTES_MISMATCH',
  'PUBLICATION_PLAN_INVALID',
  'PUBLICATION_PLAN_FORGED',
] as const;
export type EvidencePublicationFailureCode = (typeof EVIDENCE_PUBLICATION_FAILURE_CODES)[number];

export class EvidencePublicationError extends Error {
  readonly code: EvidencePublicationFailureCode;
  readonly cause: unknown;
  constructor(
    code: EvidencePublicationFailureCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'EvidencePublicationError';
    this.code = code;
    this.cause = options.cause;
  }
}

export class EvidencePublicationExistsError extends EvidencePublicationError {
  constructor(relativePath: string) {
    super(
      'PUBLICATION_TARGET_EXISTS',
      `A Package-8 evidence target already exists at ${relativePath}; refusing to overwrite it.`,
    );
    this.name = 'EvidencePublicationExistsError';
  }
}

export function isEvidencePublicationError(error: unknown): error is EvidencePublicationError {
  return error instanceof EvidencePublicationError;
}

export interface PublicationIo {
  writeExclusiveBytes(target: string, bytes: string | Uint8Array): void;
}

export const DEFAULT_PUBLICATION_IO: PublicationIo = Object.freeze({
  writeExclusiveBytes: writeExclusiveExactBytes,
});

export interface PublicationRecord {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface EvidenceArtifactPublication {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly approval: SanitizedArtifactApproval;
}

export interface EvidencePublicationPlanInput {
  readonly evidenceRoot: string;
  readonly inventory: EvidenceIntendedInventory;
  readonly manifest: EvidenceFinalManifest;
  readonly artifacts: readonly EvidenceArtifactPublication[];
}

type InternalPublicationStepKind = 'intended-inventory' | 'artifact' | 'final-manifest';

interface InternalPublicationStep extends EvidenceFinalizationStep {
  readonly kind: InternalPublicationStepKind;
  readonly target: string;
  readonly bytes: string | Uint8Array;
}

interface InternalValidatedPublicationPlan {
  readonly version: 1;
  readonly evidenceRoot: string;
  readonly steps: readonly InternalPublicationStep[];
}

declare const VALIDATED_EVIDENCE_PUBLICATION_PLAN_BRAND: unique symbol;

/** Opaque runtime-authenticated executable publication capability. */
export interface ValidatedEvidencePublicationPlan {
  readonly [VALIDATED_EVIDENCE_PUBLICATION_PLAN_BRAND]: true;
}

const VALIDATED_PLANS = new WeakMap<object, InternalValidatedPublicationPlan>();

export interface EvidencePublicationExecution {
  readonly records: readonly PublicationRecord[];
  readonly evaluation: EvidenceFinalizationEvaluation;
  readonly manifestCommitted: boolean;
}

function sha256Bytes(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function byteLength(bytes: string | Uint8Array): number {
  return typeof bytes === 'string' ? new TextEncoder().encode(bytes).byteLength : bytes.byteLength;
}

function serializeDocument(document: unknown): string {
  return JSON.stringify(document);
}

function planInvalid(detail: string): never {
  throw new EvidencePublicationError('PUBLICATION_PLAN_INVALID', detail);
}

function assertSafeRelativePath(relativePath: string): void {
  if (!isEvidenceRelativePath(relativePath)) {
    throw new EvidencePublicationError(
      'PUBLICATION_PATH_UNSAFE',
      'A Package-8 evidence target must be a safe repository-relative path.',
    );
  }
}

function resolveContainedTarget(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const target = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(prefix)) {
    throw new EvidencePublicationError(
      'PUBLICATION_PATH_UNSAFE',
      'A Package-8 evidence target must remain inside its bound evidence root.',
    );
  }
  return target;
}

function publishExclusiveExactBytes(
  step: InternalPublicationStep,
  io: PublicationIo,
): PublicationRecord {
  const outbound = typeof step.bytes === 'string' ? step.bytes : new Uint8Array(step.bytes);
  try {
    io.writeExclusiveBytes(step.target, outbound);
  } catch (error) {
    if (error instanceof RunRecordExistsError) {
      throw new EvidencePublicationExistsError(step.relativePath);
    }
    if (error instanceof EvidencePublicationError) throw error;
    if (error instanceof RunRecordWriteError) {
      throw new EvidencePublicationError('PUBLICATION_IO_FAILURE', 'Exclusive creation failed.', {
        cause: error,
      });
    }
    throw new EvidencePublicationError('PUBLICATION_IO_FAILURE', 'Exclusive creation failed.');
  }
  if (typeof step.bytes !== 'string') {
    const outboundBytes = outbound as Uint8Array;
    if (
      outboundBytes.byteLength !== step.bytes.byteLength ||
      outboundBytes.some((value, index) => value !== step.bytes[index])
    ) {
      throw new EvidencePublicationError(
        'PUBLICATION_BYTES_MISMATCH',
        'The injected I/O boundary mutated the exact approved byte sequence.',
      );
    }
  }
  return {
    relativePath: step.relativePath,
    byteLength: byteLength(step.bytes),
    sha256: sha256Bytes(step.bytes),
  };
}

const EXTERNAL_RESOURCE_CODES = new Set(['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EROFS']);

function originalFilesystemCode(error: unknown): string | null {
  if (!(error instanceof RunRecordWriteError)) return null;
  return error.code ?? (error.cause as NodeJS.ErrnoException | undefined)?.code ?? null;
}

function isAllowlistedExternalResourceFailure(error: unknown): boolean {
  const code = originalFilesystemCode(error);
  return code !== null && EXTERNAL_RESOURCE_CODES.has(code);
}

function assertContracts(
  inventory: EvidenceIntendedInventory,
  manifest: EvidenceFinalManifest,
): void {
  const inventoryIssues = validateEvidenceIntendedInventory(inventory);
  const manifestIssues = validateEvidenceFinalManifest(manifest);
  if (inventoryIssues.length > 0 || manifestIssues.length > 0) {
    planInvalid('Inventory or final manifest violates the closed Package-8 contract.');
  }

  const inventoryIdentity = deriveIntendedInventoryIdentity(inventory);
  if (manifest.inventoryIdentity !== inventoryIdentity) {
    planInvalid('Final manifest inventory identity does not match the intended inventory.');
  }
  if (manifest.provenanceIdentity !== deriveProvenanceIdentity(inventory.provenance)) {
    planInvalid('Final manifest provenance identity does not match the intended inventory.');
  }

  const agreement = validateInventoryManifestAgreement(inventory, manifest, {
    derivedInventoryIdentity: inventoryIdentity,
  });
  const graph = validateReferenceGraph({
    artifacts: inventory.artifacts,
    references: manifest.references,
    transactionKind: inventory.transactionKind,
  });
  if (agreement.length > 0 || graph.length > 0) {
    planInvalid('Inventory, final manifest, artifacts, or references do not agree.');
  }
}

function assertArtifactAgreement(
  declared: EvidenceArtifactEntry,
  committed: EvidenceFinalManifest['committedArtifacts'][number],
  publication: EvidenceArtifactPublication,
): Uint8Array {
  let state: ReturnType<typeof snapshotSanitizationApproval>;
  try {
    state = snapshotSanitizationApproval(publication.approval);
  } catch {
    planInvalid('Artifact publication does not carry a registered sanitizer approval.');
  }
  if (state.approval !== 'approved' || state.bytes === null || state.sha256 === null) {
    planInvalid('Only sanitizer-approved artifact bytes may enter a publication plan.');
  }
  if (
    publication.artifactId !== declared.artifactId ||
    state.artifactId !== declared.artifactId ||
    publication.relativePath !== declared.relativePath ||
    state.relativePath !== declared.relativePath ||
    state.role !== declared.role ||
    state.policy !== declared.sanitizationPolicy
  ) {
    planInvalid(
      'Sanitizer approval is bound to a different artifact identity, path, role, or policy.',
    );
  }

  const bytes = new Uint8Array(state.bytes);
  const digest = sha256Bytes(bytes);
  if (
    state.byteLength !== bytes.byteLength ||
    state.sha256 !== digest ||
    declared.byteLength !== bytes.byteLength ||
    declared.sha256 !== digest ||
    declared.semanticDigest !== state.semanticDigest ||
    declared.semanticDigestKind !== state.semanticDigestKind ||
    committed.relativePath !== declared.relativePath ||
    committed.byteLength !== bytes.byteLength ||
    committed.sha256 !== digest ||
    committed.semanticDigest !== state.semanticDigest
  ) {
    planInvalid('Approved bytes or semantic identity do not match inventory and final manifest.');
  }
  return bytes;
}

/**
 * Complete no-I/O preflight. Returns a frozen data-free handle whose immutable
 * executable payload is available only through the module-private WeakMap.
 */
export function planEvidencePublication(
  input: EvidencePublicationPlanInput,
): ValidatedEvidencePublicationPlan {
  if (typeof input !== 'object' || input === null) planInvalid('Publication input is missing.');
  if (typeof input.evidenceRoot !== 'string' || input.evidenceRoot.trim().length === 0) {
    planInvalid('Publication root must be a non-empty filesystem path.');
  }
  const evidenceRoot = path.resolve(input.evidenceRoot);
  assertContracts(input.inventory, input.manifest);
  if (!Array.isArray(input.artifacts)) {
    planInvalid('Publication artifacts must be an array of sanitizer approvals.');
  }

  const inventoryById = new Map(
    input.inventory.artifacts.map((entry) => [entry.artifactId, entry]),
  );
  const committedById = new Map(
    input.manifest.committedArtifacts.map((entry) => [entry.artifactId, entry]),
  );
  const publications = new Map<string, EvidenceArtifactPublication>();
  const publicationPaths = new Set<string>();
  for (const publication of input.artifacts) {
    if (publications.has(publication.artifactId)) planInvalid('Duplicate artifact publication id.');
    if (publicationPaths.has(publication.relativePath)) planInvalid('Duplicate artifact path.');
    publications.set(publication.artifactId, publication);
    publicationPaths.add(publication.relativePath);
  }

  const committedIds = new Set(input.manifest.committedArtifacts.map((entry) => entry.artifactId));
  if (publications.size !== committedIds.size) {
    planInvalid('Publication artifacts must exactly match final-manifest committed artifacts.');
  }
  for (const id of committedIds) {
    if (!publications.has(id)) planInvalid('A committed artifact has no approved publication.');
  }
  for (const id of publications.keys()) {
    if (!committedIds.has(id)) planInvalid('An undeclared artifact publication was supplied.');
  }

  const reservedPaths = new Set([
    EVIDENCE_INTENDED_INVENTORY_FILE_NAME,
    EVIDENCE_FINAL_MANIFEST_FILE_NAME,
  ]);
  const steps: InternalPublicationStep[] = [
    {
      kind: 'intended-inventory',
      relativePath: EVIDENCE_INTENDED_INVENTORY_FILE_NAME,
      target: resolveContainedTarget(evidenceRoot, EVIDENCE_INTENDED_INVENTORY_FILE_NAME),
      bytes: serializeDocument(input.inventory),
    },
  ];

  for (const declared of input.inventory.artifacts) {
    const publication = publications.get(declared.artifactId);
    if (publication === undefined) continue;
    const committed = committedById.get(declared.artifactId);
    if (committed === undefined || !inventoryById.has(declared.artifactId)) {
      planInvalid('Published artifact is absent from inventory or final manifest.');
    }
    assertSafeRelativePath(publication.relativePath);
    if (reservedPaths.has(publication.relativePath)) {
      planInvalid('Artifact path collides with a transaction document.');
    }
    const bytes = assertArtifactAgreement(declared, committed, publication);
    steps.push({
      kind: 'artifact',
      relativePath: declared.relativePath,
      target: resolveContainedTarget(evidenceRoot, declared.relativePath),
      bytes,
    });
  }

  steps.push({
    kind: 'final-manifest',
    relativePath: EVIDENCE_FINAL_MANIFEST_FILE_NAME,
    target: resolveContainedTarget(evidenceRoot, EVIDENCE_FINAL_MANIFEST_FILE_NAME),
    bytes: serializeDocument(input.manifest),
  });
  try {
    planFinalizationOrder(steps);
  } catch {
    planInvalid('Publication plan must be complete and commit the final manifest last.');
  }

  const payload: InternalValidatedPublicationPlan = Object.freeze({
    version: 1,
    evidenceRoot,
    steps: Object.freeze(
      steps.map((step) =>
        Object.freeze({
          ...step,
          bytes: typeof step.bytes === 'string' ? step.bytes : new Uint8Array(step.bytes),
        }),
      ),
    ),
  });
  const handle = Object.freeze(Object.create(null)) as ValidatedEvidencePublicationPlan;
  VALIDATED_PLANS.set(handle as object, payload);
  return handle;
}

/** Execute only a planner-created, runtime-authenticated publication plan. */
export function executeEvidencePublication(
  plan: ValidatedEvidencePublicationPlan,
  io: PublicationIo = DEFAULT_PUBLICATION_IO,
): EvidencePublicationExecution {
  if ((typeof plan !== 'object' && typeof plan !== 'function') || plan === null) {
    throw new EvidencePublicationError(
      'PUBLICATION_PLAN_FORGED',
      'Publication plan handle is not registered.',
    );
  }
  const payload = VALIDATED_PLANS.get(plan as object);
  if (payload === undefined || payload.version !== 1) {
    throw new EvidencePublicationError(
      'PUBLICATION_PLAN_FORGED',
      'Publication plan handle is not registered.',
    );
  }

  const records: PublicationRecord[] = [];
  const outcomes: EvidenceFinalizationOutcome[] = [];
  for (const step of payload.steps) {
    try {
      records.push(publishExclusiveExactBytes(step, io));
      outcomes.push({ kind: step.kind, relativePath: step.relativePath, result: 'ok' });
    } catch (error) {
      const failureClass: EvidenceTransactionFailureClass =
        error instanceof EvidencePublicationExistsError ||
        (error instanceof EvidencePublicationError &&
          !isAllowlistedExternalResourceFailure(error.cause) &&
          !isAllowlistedExternalResourceFailure(error))
          ? 'HARNESS_BLOCKED'
          : isAllowlistedExternalResourceFailure(error) ||
              (error instanceof EvidencePublicationError &&
                isAllowlistedExternalResourceFailure(error.cause))
            ? 'ENVIRONMENT_FAILURE'
            : 'HARNESS_BLOCKED';
      outcomes.push({
        kind: step.kind,
        relativePath: step.relativePath,
        result: 'failed',
        failureClass,
      });
      break;
    }
  }
  const evaluation = evaluateFinalizationOutcomes(outcomes);
  return { records, evaluation, manifestCommitted: evaluation.commitPointReached };
}
