import type {
  EvidenceArtifactEntry,
  EvidenceFinalManifest,
  EvidenceIntendedInventory,
  EvidenceReference,
  EvidenceTransactionKind,
} from '../contracts/evidence-transaction';

/**
 * Pure reference-graph validators (ADR 0041 P8-A1).
 *
 * Runs and suites share one integrity/reference/provenance core. The reference
 * graph relates logical artifact ids: an artifact's declared `consumedBy` list
 * becomes a consumer→artifact `consumes` edge, a `derives` edge records a
 * derived artifact, and a suite manifest's `child-manifest` edges name committed
 * child manifests in canonical order.
 *
 * Everything here is a pure function over already-parsed documents. No module
 * reads the filesystem, and no graph is repaired: an invalid graph is a hard,
 * enumerable failure.
 */

export const EVIDENCE_REFERENCE_FAILURE_CODES = [
  'REFERENCE_DANGLING',
  'REFERENCE_SELF',
  'REFERENCE_DUPLICATE',
  'REFERENCE_CYCLE',
  'REFERENCE_ORDER_INVALID',
  'REFERENCE_KIND_MISMATCH',
  'REFERENCE_REQUIRED_MISSING',
  'REFERENCE_REQUIRED_MISMATCH',
  'REFERENCE_INVENTORY_MISMATCH',
  'REFERENCE_UNKNOWN_ARTIFACT',
  'REFERENCE_TRANSACTION_MISMATCH',
] as const;
export type EvidenceReferenceFailureCode = (typeof EVIDENCE_REFERENCE_FAILURE_CODES)[number];

export interface EvidenceReferenceIssue {
  readonly code: EvidenceReferenceFailureCode;
  readonly detail: string;
}

function issue(code: EvidenceReferenceFailureCode, detail: string): EvidenceReferenceIssue {
  return { code, detail };
}

const edgeKey = (reference: EvidenceReference): string =>
  `${reference.fromArtifactId}\u0000${reference.toArtifactId}\u0000${reference.kind}`;

/**
 * Derive the consumer→artifact `consumes` edges declared by an inventory's
 * artifacts. The result is canonically sorted so the same inventory always
 * yields byte-identical edges.
 */
export function buildInventoryReferenceEdges(
  inventory: EvidenceIntendedInventory,
): readonly EvidenceReference[] {
  const edges: EvidenceReference[] = [];
  for (const artifact of inventory.artifacts) {
    for (const consumer of artifact.consumedBy) {
      edges.push({
        fromArtifactId: consumer,
        toArtifactId: artifact.artifactId,
        kind: 'consumes',
        order: null,
      });
    }
  }
  return edges.sort((left, right) => (edgeKey(left) < edgeKey(right) ? -1 : 1));
}

/**
 * Validate a reference list against the artifact ids that actually exist.
 * Detects dangling references, self-reference, duplicate edges, cycles among
 * `consumes`/`derives` edges, and (for a suite) a non-canonical child order.
 */
export function validateReferenceGraph(input: {
  readonly artifacts: readonly EvidenceArtifactEntry[];
  readonly references: readonly EvidenceReference[];
  readonly transactionKind: EvidenceTransactionKind;
}): readonly EvidenceReferenceIssue[] {
  const issues: EvidenceReferenceIssue[] = [];
  const ids = new Set(input.artifacts.map((artifact) => artifact.artifactId));
  const seen = new Set<string>();

  for (const reference of input.references) {
    if (!ids.has(reference.fromArtifactId) || !ids.has(reference.toArtifactId)) {
      issues.push(
        issue(
          'REFERENCE_DANGLING',
          'A reference names an artifact id the inventory does not declare.',
        ),
      );
      continue;
    }
    if (reference.fromArtifactId === reference.toArtifactId) {
      issues.push(issue('REFERENCE_SELF', 'An artifact cannot reference itself.'));
    }
    const key = edgeKey(reference);
    if (seen.has(key)) {
      issues.push(issue('REFERENCE_DUPLICATE', 'Duplicate reference edge.'));
    }
    seen.add(key);
    if (input.transactionKind === 'run' && reference.kind === 'child-manifest') {
      issues.push(
        issue(
          'REFERENCE_KIND_MISMATCH',
          'A run manifest cannot declare a child-manifest reference.',
        ),
      );
    }
    if (input.transactionKind === 'suite' && reference.kind !== 'child-manifest') {
      issues.push(
        issue(
          'REFERENCE_KIND_MISMATCH',
          'A suite manifest references only committed child manifests.',
        ),
      );
    }
  }

  issues.push(...validateChildManifestOrder(input.transactionKind, input.references));
  issues.push(...detectCycles(input.references));
  return issues;
}

function validateChildManifestOrder(
  transactionKind: EvidenceTransactionKind,
  references: readonly EvidenceReference[],
): EvidenceReferenceIssue[] {
  const children = references.filter((reference) => reference.kind === 'child-manifest');
  if (children.length === 0) return [];
  const issues: EvidenceReferenceIssue[] = [];
  const orders = children.map((child) => child.order);
  for (const order of orders) {
    if (order === null || !Number.isSafeInteger(order) || order < 1) {
      issues.push(
        issue(
          'REFERENCE_ORDER_INVALID',
          'A child-manifest reference requires a positive integer order.',
        ),
      );
    }
  }
  const numeric = orders.filter((order): order is number => typeof order === 'number');
  const unique = new Set(numeric);
  if (unique.size !== numeric.length) {
    issues.push(issue('REFERENCE_ORDER_INVALID', 'Child-manifest orders must be unique.'));
  }
  const sorted = [...unique].sort((left, right) => left - right);
  sorted.forEach((order, index) => {
    if (order !== index + 1) {
      issues.push(
        issue(
          'REFERENCE_ORDER_INVALID',
          'Child-manifest orders must be contiguous canonical 1..N.',
        ),
      );
    }
  });
  if (transactionKind === 'run' && children.length > 0) {
    issues.push(
      issue('REFERENCE_KIND_MISMATCH', 'A run manifest cannot reference child manifests.'),
    );
  }
  return issues;
}

function detectCycles(references: readonly EvidenceReference[]): EvidenceReferenceIssue[] {
  const adjacency = new Map<string, Set<string>>();
  for (const reference of references) {
    if (reference.kind === 'child-manifest') continue;
    const set = adjacency.get(reference.fromArtifactId) ?? new Set<string>();
    set.add(reference.toArtifactId);
    adjacency.set(reference.fromArtifactId, set);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const issues: EvidenceReferenceIssue[] = [];

  const visit = (node: string): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      issues.push(issue('REFERENCE_CYCLE', 'A reference cycle exists among consumed artifacts.'));
      return;
    }
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of adjacency.keys()) visit(node);
  return issues;
}

/**
 * Validate that a final manifest agrees with the inventory it commits: matching
 * transaction identity, exact inventory identity, all required-authoritative
 * artifacts committed byte-for-byte, and the derived reference edges replayed.
 */
export function validateInventoryManifestAgreement(
  inventory: EvidenceIntendedInventory,
  manifest: EvidenceFinalManifest,
  options: { readonly derivedInventoryIdentity?: string } = {},
): readonly EvidenceReferenceIssue[] {
  const issues: EvidenceReferenceIssue[] = [];
  if (inventory.transactionKind !== manifest.transactionKind) {
    issues.push(
      issue('REFERENCE_TRANSACTION_MISMATCH', 'Inventory and manifest transaction kinds differ.'),
    );
  }
  if (inventory.transactionId !== manifest.transactionId) {
    issues.push(
      issue('REFERENCE_TRANSACTION_MISMATCH', 'Inventory and manifest transaction ids differ.'),
    );
  }
  if (
    options.derivedInventoryIdentity !== undefined &&
    manifest.inventoryIdentity !== options.derivedInventoryIdentity
  ) {
    issues.push(
      issue(
        'REFERENCE_INVENTORY_MISMATCH',
        'manifest.inventoryIdentity does not match the inventory.',
      ),
    );
  }

  const committed = new Map(
    manifest.committedArtifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  const inventoryById = new Map(
    inventory.artifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  for (const artifact of inventory.artifacts) {
    const finalized = committed.get(artifact.artifactId);
    if (finalized === undefined) {
      if (artifact.role === 'required-authoritative') {
        issues.push(
          issue(
            'REFERENCE_REQUIRED_MISSING',
            'A required-authoritative artifact is not committed.',
          ),
        );
      }
      continue;
    }
    if (
      finalized.sha256 !== artifact.sha256 ||
      finalized.byteLength !== artifact.byteLength ||
      finalized.semanticDigest !== artifact.semanticDigest ||
      finalized.relativePath !== artifact.relativePath
    ) {
      issues.push(
        issue(
          artifact.role === 'required-authoritative'
            ? 'REFERENCE_REQUIRED_MISMATCH'
            : 'REFERENCE_INVENTORY_MISMATCH',
          'A committed artifact differs from its inventory declaration.',
        ),
      );
    }
  }
  for (const finalized of manifest.committedArtifacts) {
    if (!inventoryById.has(finalized.artifactId)) {
      issues.push(
        issue(
          'REFERENCE_UNKNOWN_ARTIFACT',
          'A committed artifact is not declared by the inventory.',
        ),
      );
    }
  }

  const derived = buildInventoryReferenceEdges(inventory);
  const declared = new Set(manifest.references.map(edgeKey));
  const expected = new Set(derived.map(edgeKey));
  for (const edge of derived) {
    if (!declared.has(edgeKey(edge))) {
      issues.push(
        issue('REFERENCE_INVENTORY_MISMATCH', 'The committed references omit an inventory edge.'),
      );
    }
  }
  for (const edge of manifest.references) {
    if (!expected.has(edgeKey(edge))) {
      issues.push(
        issue('REFERENCE_INVENTORY_MISMATCH', 'The manifest declares a non-inventory edge.'),
      );
    }
  }
  issues.push(
    ...validateReferenceGraph({
      artifacts: inventory.artifacts,
      references: manifest.references,
      transactionKind: inventory.transactionKind,
    }),
  );
  return issues;
}

/** Convenience predicate used by tests and transaction classification. */
export function isReferenceGraphValid(input: {
  readonly artifacts: readonly EvidenceArtifactEntry[];
  readonly references: readonly EvidenceReference[];
  readonly transactionKind: EvidenceTransactionKind;
}): boolean {
  return validateReferenceGraph(input).length === 0;
}
