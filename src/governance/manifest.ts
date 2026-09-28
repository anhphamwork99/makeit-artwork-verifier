import {
  deriveGovernanceIdentity,
  GOVERNANCE_IDENTITY_DOMAINS,
} from '../canonical/governance-identity';
import {
  MANIFEST_LIFECYCLE_SCHEMA_VERSION,
  MANIFEST_STATES,
  MANIFEST_TRANSITIONS,
  type ManifestIssueCode,
  type ManifestValidation,
  type SelectionManifestContent,
} from '../contracts/manifest-lifecycle';

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,179}$/;
const FROZEN_STATES = new Set(['APPROVED_FROZEN', 'ACTIVE', 'SUPERSEDED', 'REVOKED']);

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null ? (value as RecordValue) : undefined;
}
function closed(value: RecordValue, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}
function safe(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REFERENCE.test(value);
}
function issueResult(issues: Iterable<ManifestIssueCode>): ManifestValidation {
  const unique = [...new Set(issues)];
  return { valid: unique.length === 0, issues: unique, releaseCredit: false };
}

/** Membership arrays are sets; execution entries are ordered and never sorted. */
export function deriveSelectionManifestFingerprint(content: SelectionManifestContent): string {
  return deriveGovernanceIdentity(GOVERNANCE_IDENTITY_DOMAINS.selectionManifest, {
    schemaVersion: content.schemaVersion,
    bindings: [...content.bindings].sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
    requiredCells: [...content.requiredCells].sort((a, b) => a.cellId.localeCompare(b.cellId)),
    entries: [...content.entries],
  });
}

/** Validates authoring data; a state label or approval reference is never authority. */
export function validateSelectionManifest(input: unknown): ManifestValidation {
  const issues: ManifestIssueCode[] = [];
  try {
    const envelope = record(input);
    if (
      !envelope ||
      !closed(envelope, [
        'schemaVersion',
        'manifestId',
        'revision',
        'state',
        'content',
        'contentFingerprint',
        'approvalReference',
      ])
    )
      return issueResult(['MANIFEST_SHAPE']);
    if (envelope.schemaVersion !== MANIFEST_LIFECYCLE_SCHEMA_VERSION)
      issues.push('MANIFEST_SCHEMA');
    if (!safe(envelope.manifestId)) issues.push('MANIFEST_REFERENCE');
    if (!Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 1)
      issues.push('MANIFEST_REVISION');
    if (!MANIFEST_STATES.includes(envelope.state as never)) issues.push('MANIFEST_STATE');

    const content = record(envelope.content);
    if (!content || !closed(content, ['schemaVersion', 'bindings', 'requiredCells', 'entries'])) {
      issues.push('MANIFEST_SHAPE');
      return issueResult(issues);
    }
    if (content.schemaVersion !== MANIFEST_LIFECYCLE_SCHEMA_VERSION) issues.push('MANIFEST_SCHEMA');
    if (
      !Array.isArray(content.bindings) ||
      !Array.isArray(content.requiredCells) ||
      !Array.isArray(content.entries)
    ) {
      issues.push('MANIFEST_SHAPE');
      return issueResult(issues);
    }
    const bindings = new Set<string>();
    const cells = new Set<string>();
    const entries = new Set<string>();
    const pairs = new Set<string>();
    for (const value of content.bindings) {
      const item = record(value);
      if (
        !item ||
        !closed(item, ['bindingId', 'modelFingerprint']) ||
        !safe(item.bindingId) ||
        typeof item.modelFingerprint !== 'string' ||
        !HEX_256.test(item.modelFingerprint)
      ) {
        issues.push('MANIFEST_COVERAGE');
        continue;
      }
      if (bindings.has(item.bindingId)) issues.push('MANIFEST_DUPLICATE');
      bindings.add(item.bindingId);
    }
    for (const value of content.requiredCells) {
      const item = record(value);
      if (
        !item ||
        !closed(item, ['cellId', 'classification']) ||
        !safe(item.cellId) ||
        item.classification !== 'required-credit'
      ) {
        issues.push('MANIFEST_COVERAGE');
        continue;
      }
      if (cells.has(item.cellId)) issues.push('MANIFEST_DUPLICATE');
      cells.add(item.cellId);
    }
    if (!bindings.size || !cells.size || !content.entries.length) issues.push('MANIFEST_COVERAGE');
    for (const [position, value] of content.entries.entries()) {
      const item = record(value);
      if (
        !item ||
        !closed(item, ['entryId', 'bindingId', 'cellId', 'order']) ||
        !safe(item.entryId) ||
        !safe(item.bindingId) ||
        !safe(item.cellId) ||
        !Number.isSafeInteger(item.order)
      ) {
        issues.push('MANIFEST_SHAPE');
        continue;
      }
      if (item.order !== position) issues.push('MANIFEST_ORDER');
      if (entries.has(item.entryId)) issues.push('MANIFEST_DUPLICATE');
      entries.add(item.entryId);
      if (!bindings.has(item.bindingId) || !cells.has(item.cellId))
        issues.push('MANIFEST_COVERAGE');
      const pair = `${item.bindingId}\u0000${item.cellId}`;
      if (pairs.has(pair)) issues.push('MANIFEST_DUPLICATE');
      pairs.add(pair);
    }
    // Every selected binding × required-credit cell pair must appear exactly once.
    // `bindings` are this manifest's selected required binding identities and
    // `requiredCells` the cells in which they are required, so the required
    // assignment is their full cross product; a sparse pairing is not accepted.
    for (const binding of bindings) {
      for (const cell of cells) {
        if (!pairs.has(`${binding}\u0000${cell}`)) issues.push('MANIFEST_COVERAGE');
      }
    }
    if (envelope.approvalReference !== undefined) {
      const approval = record(envelope.approvalReference);
      if (
        !approval ||
        !closed(approval, ['authority', 'reference', 'digest']) ||
        !safe(approval.authority) ||
        !safe(approval.reference) ||
        typeof approval.digest !== 'string' ||
        !HEX_256.test(approval.digest)
      ) {
        issues.push('MANIFEST_APPROVAL_REFERENCE');
      }
    }
    if (FROZEN_STATES.has(envelope.state as string) && envelope.approvalReference === undefined) {
      issues.push('MANIFEST_APPROVAL_REFERENCE');
    }
    if (
      typeof envelope.contentFingerprint !== 'string' ||
      !HEX_256.test(envelope.contentFingerprint)
    ) {
      issues.push('MANIFEST_FINGERPRINT');
    } else if (
      !issues.some((issue) =>
        [
          'MANIFEST_SHAPE',
          'MANIFEST_SCHEMA',
          'MANIFEST_COVERAGE',
          'MANIFEST_DUPLICATE',
          'MANIFEST_ORDER',
        ].includes(issue),
      )
    ) {
      if (
        deriveSelectionManifestFingerprint(content as unknown as SelectionManifestContent) !==
        envelope.contentFingerprint
      ) {
        issues.push('MANIFEST_FINGERPRINT');
      }
    }
    return issueResult(issues);
  } catch {
    // Proxy/getter/cyclic/noncanonical input cannot escape the closed validator.
    return issueResult([...issues, 'MANIFEST_SHAPE']);
  }
}

/** Describes a permitted next label, without changing state or authenticating it. */
export function validateManifestTransition(previous: unknown, next: unknown): ManifestValidation {
  const prior = validateSelectionManifest(previous);
  const candidate = validateSelectionManifest(next);
  const issues = [...prior.issues, ...candidate.issues];
  if (!prior.valid || !candidate.valid) return issueResult(issues);
  const from = previous as {
    state: keyof typeof MANIFEST_TRANSITIONS;
    revision: number;
    contentFingerprint: string;
  };
  const to = next as { state: string; revision: number; contentFingerprint: string };
  if (
    !(MANIFEST_TRANSITIONS[from.state] as readonly string[]).includes(to.state) ||
    to.revision !== from.revision + 1
  ) {
    issues.push('MANIFEST_TRANSITION');
  }
  if (FROZEN_STATES.has(from.state) && to.contentFingerprint !== from.contentFingerprint) {
    issues.push('MANIFEST_FROZEN_MUTATION');
  }
  return issueResult(issues);
}
