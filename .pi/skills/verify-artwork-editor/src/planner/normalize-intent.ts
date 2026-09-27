import { canonicalize } from '../canonical/canonicalize';
import type {
  CaseIntent,
  CaseIntentOperation,
  CaseRequest,
  SemanticResourceRef,
} from '../contracts/case-model';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import {
  isCapability,
  isCaseProvenance,
  isEvidenceDepth,
  isExecutionProfile,
  isSubjectId,
} from '../contracts/discriminants';
import { CASE_REQUEST_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Case Intent normalization (decision 0007 stage 3, specification 8.3).
 *
 * The request and intent are closed contracts: every declared key is validated
 * and any additional key is rejected, so a case can never smuggle a behavior or
 * policy override (adapter selection, workflow override, tolerance, deadline,
 * retry policy, or expected-result algorithm) into the planner.
 *
 * A valid request contains only deterministically canonicalizable values, so an
 * ambiguous value such as `NaN` fails closed instead of silently collapsing
 * onto another case's identity.
 */

export type IntentNormalizeResult =
  | { ok: true; intent: CaseIntent }
  | { ok: false; finding: DiagnosticRecord };

export type NormalizeResult =
  | { ok: true; request: CaseRequest }
  | { ok: false; finding: DiagnosticRecord };

const REQUEST_KEYS = new Set(['schemaVersion', 'profile', 'provenance', 'evidenceDepth', 'intent']);
const INTENT_KEYS = new Set([
  'subjectId',
  'capability',
  'variant',
  'scenario',
  'preState',
  'operations',
  'expected',
  'resources',
]);
const OPERATION_KEYS = new Set(['discriminant', 'parameters']);
const RESOURCE_KEYS = new Set(['resourceId', 'contentDigest']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestMalformed(detail: string): NormalizeResult {
  return { ok: false, finding: createDiagnostic('MALFORMED_CASE_REQUEST', detail) };
}

function intentMalformed(detail: string, subjectId?: string): IntentNormalizeResult {
  return {
    ok: false,
    finding: createDiagnostic('MALFORMED_CASE_INTENT', detail, subjectId ? { subjectId } : {}),
  };
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): string | null {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length === 0) return null;
  return `${label} declares unsupported field(s): ${unknown.join(', ')}`;
}

/** True when the value has exactly one deterministic canonical form. */
function isCanonicalizable(value: unknown): boolean {
  try {
    canonicalize(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeResources(raw: unknown): SemanticResourceRef[] | string {
  if (!Array.isArray(raw)) return 'intent.resources must be an array';
  const resources: SemanticResourceRef[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return `intent.resources[${index}] must be an object`;
    const unknown = rejectUnknownKeys(entry, RESOURCE_KEYS, `intent.resources[${index}]`);
    if (unknown) return unknown;
    if (typeof entry.resourceId !== 'string' || entry.resourceId.trim().length === 0) {
      return `intent.resources[${index}].resourceId must be a non-empty string`;
    }
    if (typeof entry.contentDigest !== 'string' || entry.contentDigest.trim().length === 0) {
      return `intent.resources[${index}].contentDigest must be a non-empty string`;
    }
    resources.push({ resourceId: entry.resourceId, contentDigest: entry.contentDigest });
  }

  const ids = resources.map((resource) => resource.resourceId);
  if (new Set(ids).size !== ids.length) {
    return 'intent.resources declares the same logical resource more than once';
  }

  return resources.sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1));
}

function normalizeOperations(raw: unknown): CaseIntentOperation[] | string {
  if (!Array.isArray(raw)) return 'intent.operations must be an array';
  const operations: CaseIntentOperation[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return `intent.operations[${index}] must be an object`;
    const unknown = rejectUnknownKeys(entry, OPERATION_KEYS, `intent.operations[${index}]`);
    if (unknown) return unknown;
    if (typeof entry.discriminant !== 'string' || entry.discriminant.trim().length === 0) {
      return `intent.operations[${index}].discriminant must be a non-empty string`;
    }
    if (!isRecord(entry.parameters)) {
      return `intent.operations[${index}].parameters must be an object`;
    }
    operations.push({ discriminant: entry.discriminant, parameters: entry.parameters });
  }
  return operations;
}

export function normalizeCaseIntent(raw: unknown): IntentNormalizeResult {
  if (!isRecord(raw)) return intentMalformed('Case Intent must be an object');

  const unknown = rejectUnknownKeys(raw, INTENT_KEYS, 'Case Intent');
  if (unknown) return intentMalformed(unknown);

  if (!isSubjectId(raw.subjectId)) {
    return intentMalformed(
      `intent.subjectId must be an immutable lowercase slash-namespaced identity: ${String(raw.subjectId)}`,
    );
  }
  const subjectId = raw.subjectId;

  if (!isCapability(raw.capability)) {
    return intentMalformed(
      `intent.capability is not a declared Capability: ${String(raw.capability)}`,
      subjectId,
    );
  }

  if (raw.variant !== null && (typeof raw.variant !== 'string' || raw.variant.length === 0)) {
    return intentMalformed('intent.variant must be a non-empty string or null', subjectId);
  }

  if (typeof raw.scenario !== 'string' || raw.scenario.trim().length === 0) {
    return intentMalformed('intent.scenario must be a non-empty string', subjectId);
  }

  if (!isRecord(raw.preState)) {
    return intentMalformed('intent.preState must be an object', subjectId);
  }
  if (!isRecord(raw.expected)) {
    return intentMalformed('intent.expected must be an object', subjectId);
  }

  const resources = normalizeResources(raw.resources);
  if (typeof resources === 'string') return intentMalformed(resources, subjectId);
  const operations = normalizeOperations(raw.operations);
  if (typeof operations === 'string') return intentMalformed(operations, subjectId);

  const intent: CaseIntent = {
    subjectId,
    capability: raw.capability,
    variant: raw.variant,
    scenario: raw.scenario.trim(),
    preState: raw.preState,
    operations,
    expected: raw.expected,
    resources,
  };

  if (!isCanonicalizable(intent)) {
    return intentMalformed(
      'intent contains a value with no deterministic canonical form (undefined, non-finite number, sparse array, or non-plain object)',
      subjectId,
    );
  }

  return { ok: true, intent };
}

export function normalizeCaseRequest(raw: unknown): NormalizeResult {
  if (!isRecord(raw)) return requestMalformed('Case Request must be an object');

  const unknown = rejectUnknownKeys(raw, REQUEST_KEYS, 'Case Request');
  if (unknown) return requestMalformed(unknown);

  if (raw.schemaVersion !== CASE_REQUEST_SCHEMA_VERSION) {
    return requestMalformed(
      `Unsupported Case Request schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (!isExecutionProfile(raw.profile)) {
    return requestMalformed(`Unsupported execution profile: ${String(raw.profile)}`);
  }
  if (!isCaseProvenance(raw.provenance)) {
    return requestMalformed(`Unsupported case provenance: ${String(raw.provenance)}`);
  }
  if (!isEvidenceDepth(raw.evidenceDepth)) {
    return requestMalformed(`Unsupported evidence depth: ${String(raw.evidenceDepth)}`);
  }

  // An intent failure keeps its own, more precise diagnostic code: the request
  // wrapper is valid, so it must not overwrite the finding.
  const normalizedIntent = normalizeCaseIntent(raw.intent);
  if (!normalizedIntent.ok) return { ok: false, finding: normalizedIntent.finding };

  return {
    ok: true,
    request: {
      schemaVersion: raw.schemaVersion,
      profile: raw.profile,
      provenance: raw.provenance,
      evidenceDepth: raw.evidenceDepth,
      intent: normalizedIntent.intent,
    },
  };
}
