import {
  QUARANTINE_FINAL_APPROVAL_AUTHORITY,
  QUARANTINE_OUTCOMES,
  QUARANTINE_SCHEMA_VERSION,
  type InstabilityEvidenceReference,
  type ObligationRef,
  type QuarantineAssessment,
  type QuarantineIssueCode,
  type QuarantineManifestReference,
  type QuarantineOutcome,
  type ReinstatementAssessment,
  type ReplacementAssessment,
} from '../contracts/quarantine';

/**
 * Pure, immutable, non-mutating, no-credit static assessment of externally
 * supplied quarantine/replacement/reinstatement proposals (production
 * specification §13.5, §13.8, §13.10).
 *
 * Nothing here derives identity, authenticates approval, mutates history or a
 * manifest, performs an actual quarantine, admits a replacement, applies a
 * reinstatement, narrows scope, executes anything, or grants Release credit.
 * Every caller value is untrusted input, every output is deeply frozen, and a
 * positive-shaped proposal still leaves its obligation unresolved with
 * `releaseCredit: false`.
 */

const HEX_256 = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,179}$/;
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const QUARANTINE_INPUT_FIELDS = [
  'schemaVersion',
  'proposalId',
  'manifest',
  'fingerprint',
  'affectedObligation',
  'evidence',
  'proposedAtUtc',
  'assertedEffects',
] as const;
const REPLACEMENT_INPUT_FIELDS = [
  'schemaVersion',
  'proposalId',
  'quarantineReference',
  'lostObligations',
  'replacementManifest',
  'qualification',
  'mapping',
  'approvals',
  'assertedEffects',
] as const;
const REINSTATEMENT_INPUT_FIELDS = [
  'schemaVersion',
  'proposalId',
  'quarantineReference',
  'affectedObligation',
  'cause',
  'correction',
  'nonWeakeningProof',
  'qualification',
  'manifest',
  'releaseRun',
  'approvals',
  'proposedAtUtc',
  'assertedEffects',
] as const;
const MANIFEST_FIELDS = ['manifestId', 'contentFingerprint'] as const;
const OBLIGATION_FIELDS = ['obligationId', 'manifestId', 'contentFingerprint'] as const;
const INSTABILITY_FIELDS = [
  'evidenceId',
  'executionInstanceId',
  'digest',
  'outcome',
  'obligation',
] as const;
const EVIDENCE_FIELDS = ['evidenceId', 'digest', 'complete', 'valid'] as const;
const APPROVAL_FIELDS = ['authority', 'reference', 'digest'] as const;
const QUALIFICATION_FIELDS = ['batchId', 'manifestId', 'contentFingerprint', 'admitted'] as const;
const PAIR_FIELDS = ['lostObligation', 'replacementObligation'] as const;
const RELEASE_RUN_FIELDS = ['runId', 'executedAtUtc', 'outcome', 'complete', 'manifest'] as const;
const ASSERTED_EFFECT_FIELDS = [
  'mutatesHistory',
  'mutatesManifest',
  'narrowsScope',
  'clearsObligations',
  'diagnosticPass',
  'grantsReleaseCredit',
] as const;
const DIAGNOSTIC_PASS_FIELDS = ['runId'] as const;

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

function hex(value: unknown): value is string {
  return typeof value === 'string' && HEX_256.test(value);
}

/** Bounded, trimmed, nonempty human-readable text (cause/correction). */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500 && value.trim().length > 0;
}

/** `proposalId` local reference shape: 1..256 UTF-16 code units. Never identity. */
function proposalIdShape(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * A syntactically valid UTC string must denote a real instant; a non-existent
 * calendar date or wall-clock time is denied rather than silently normalized.
 */
function utcInstantExists(value: string): boolean {
  const match = UTC_INSTANT.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = month === 2 && isLeapYear(Number(match[1])) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= daysInMonth;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as RecordValue)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(issues: readonly QuarantineIssueCode[]): QuarantineIssueCode[] {
  return [...new Set(issues)].sort();
}

function parseManifestRef(value: unknown): QuarantineManifestReference | undefined {
  const candidate = record(value);
  if (
    !candidate ||
    !closed(candidate, MANIFEST_FIELDS) ||
    !safe(candidate.manifestId) ||
    !hex(candidate.contentFingerprint)
  ) {
    return undefined;
  }
  return deepFreeze({
    manifestId: candidate.manifestId,
    contentFingerprint: candidate.contentFingerprint,
  });
}

function parseObligationRef(value: unknown): ObligationRef | undefined {
  const candidate = record(value);
  if (
    !candidate ||
    !closed(candidate, OBLIGATION_FIELDS) ||
    !safe(candidate.obligationId) ||
    !safe(candidate.manifestId) ||
    !hex(candidate.contentFingerprint)
  ) {
    return undefined;
  }
  return deepFreeze({
    obligationId: candidate.obligationId,
    manifestId: candidate.manifestId,
    contentFingerprint: candidate.contentFingerprint,
  });
}

function obligationKey(obligation: ObligationRef): string {
  return `${obligation.manifestId}\u0000${obligation.contentFingerprint}\u0000${obligation.obligationId}`;
}

function sameObligation(left: ObligationRef, right: ObligationRef): boolean {
  return obligationKey(left) === obligationKey(right);
}

function sortObligations(obligations: readonly ObligationRef[]): ObligationRef[] {
  return [...obligations].sort((left, right) => {
    const a = obligationKey(left);
    const b = obligationKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Reports an asserted effect and fails closed instead of applying it. */
function validateAssertedEffects(value: unknown, issues: QuarantineIssueCode[]): void {
  if (value === undefined) return;
  const effects = record(value);
  if (!effects || !closed(effects, ASSERTED_EFFECT_FIELDS)) {
    issues.push('QUARANTINE_SHAPE');
    return;
  }
  for (const field of ['mutatesHistory', 'mutatesManifest', 'narrowsScope'] as const) {
    if (effects[field] !== undefined && typeof effects[field] !== 'boolean') {
      issues.push('QUARANTINE_SHAPE');
    }
  }
  if (effects.mutatesHistory === true || effects.mutatesManifest === true) {
    issues.push('QUARANTINE_MUTATION');
  }
  const clears = effects.clearsObligations;
  if (clears !== undefined && (!Array.isArray(clears) || clears.some((entry) => !safe(entry)))) {
    issues.push('QUARANTINE_SHAPE');
  } else if (Array.isArray(clears) && clears.length > 0) {
    issues.push('QUARANTINE_SCOPE');
  }
  if (effects.narrowsScope === true) issues.push('QUARANTINE_SCOPE');
  if (effects.grantsReleaseCredit === true) issues.push('QUARANTINE_CREDIT');
  if (effects.diagnosticPass !== undefined) {
    const diagnostic = record(effects.diagnosticPass);
    if (!diagnostic || !closed(diagnostic, DIAGNOSTIC_PASS_FIELDS) || !safe(diagnostic.runId)) {
      issues.push('QUARANTINE_SHAPE');
    }
    issues.push('QUARANTINE_PROMOTION');
  }
}

/**
 * §13.10 action-scoped approval: at least one well-formed reference from the
 * applicable final-approval authority. Structural presence is never
 * authentication, and no universal four-role matrix is required.
 */
function validateFinalApproval(value: unknown, issues: QuarantineIssueCode[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('QUARANTINE_APPROVAL');
    return;
  }
  let finalAuthority = false;
  for (const item of value) {
    const approval = record(item);
    if (
      !approval ||
      !closed(approval, APPROVAL_FIELDS) ||
      !safe(approval.authority) ||
      !safe(approval.reference) ||
      !hex(approval.digest)
    ) {
      issues.push('QUARANTINE_APPROVAL');
      continue;
    }
    if (approval.authority === QUARANTINE_FINAL_APPROVAL_AUTHORITY) finalAuthority = true;
  }
  if (!finalAuthority) issues.push('QUARANTINE_APPROVAL');
}

function validateQualification(
  value: unknown,
  expected: QuarantineManifestReference | undefined,
  issues: QuarantineIssueCode[],
): void {
  const candidate = record(value);
  if (
    !candidate ||
    !closed(candidate, QUALIFICATION_FIELDS) ||
    !safe(candidate.batchId) ||
    !safe(candidate.manifestId) ||
    !hex(candidate.contentFingerprint) ||
    typeof candidate.admitted !== 'boolean' ||
    // An untrusted claim; `false` is never admission.
    candidate.admitted !== true
  ) {
    issues.push('QUARANTINE_QUALIFICATION');
    return;
  }
  if (
    expected &&
    (candidate.manifestId !== expected.manifestId ||
      candidate.contentFingerprint !== expected.contentFingerprint)
  ) {
    issues.push('QUARANTINE_QUALIFICATION');
  }
}

function validateEvidenceList(value: unknown, issues: QuarantineIssueCode[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('QUARANTINE_EVIDENCE');
    return;
  }
  for (const item of value) {
    const evidence = record(item);
    if (
      !evidence ||
      !closed(evidence, EVIDENCE_FIELDS) ||
      !safe(evidence.evidenceId) ||
      !hex(evidence.digest) ||
      typeof evidence.complete !== 'boolean' ||
      typeof evidence.valid !== 'boolean' ||
      evidence.complete !== true ||
      evidence.valid !== true
    ) {
      issues.push('QUARANTINE_EVIDENCE');
    }
  }
}

function parseObligationList(value: unknown, issues: QuarantineIssueCode[]): ObligationRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('QUARANTINE_OBLIGATION');
    return [];
  }
  const obligations: ObligationRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const obligation = parseObligationRef(item);
    if (!obligation) {
      issues.push('QUARANTINE_OBLIGATION');
      continue;
    }
    const key = obligationKey(obligation);
    if (seen.has(key)) {
      issues.push('QUARANTINE_OBLIGATION');
      continue;
    }
    seen.add(key);
    obligations.push(obligation);
  }
  return obligations;
}

/**
 * Two comparable instability observations for the same obligation/fingerprint,
 * with distinct execution instances, distinct evidence identities, distinct
 * evidence digests, and contradictory outcomes. Repeated evidence ID (even with
 * differing digests), repeated digest (even with differing IDs), same-outcome,
 * malformed, or cross-obligation/fingerprint pairs fail closed; shape never
 * proves the observations are true.
 */
function validateInstabilityPair(
  value: unknown,
  affected: ObligationRef | undefined,
  issues: QuarantineIssueCode[],
): void {
  if (!Array.isArray(value) || value.length !== 2) {
    issues.push('QUARANTINE_EVIDENCE');
    return;
  }
  const parsed: InstabilityEvidenceReference[] = [];
  for (const item of value) {
    const candidate = record(item);
    if (
      !candidate ||
      !closed(candidate, INSTABILITY_FIELDS) ||
      !safe(candidate.evidenceId) ||
      !safe(candidate.executionInstanceId) ||
      !hex(candidate.digest) ||
      !QUARANTINE_OUTCOMES.includes(candidate.outcome as never)
    ) {
      issues.push('QUARANTINE_EVIDENCE');
      continue;
    }
    const obligation = parseObligationRef(candidate.obligation);
    if (!obligation) {
      issues.push('QUARANTINE_EVIDENCE');
      continue;
    }
    parsed.push({
      evidenceId: candidate.evidenceId,
      executionInstanceId: candidate.executionInstanceId,
      digest: candidate.digest,
      outcome: candidate.outcome as QuarantineOutcome,
      obligation,
    });
  }
  if (parsed.length !== 2 || !affected) return;
  const [first, second] = parsed as [InstabilityEvidenceReference, InstabilityEvidenceReference];
  if (!sameObligation(first.obligation, affected) || !sameObligation(second.obligation, affected)) {
    issues.push('QUARANTINE_INSTABILITY');
  }
  if (first.executionInstanceId === second.executionInstanceId) {
    issues.push('QUARANTINE_INSTABILITY');
  }
  if (first.evidenceId === second.evidenceId) {
    issues.push('QUARANTINE_INSTABILITY');
  }
  if (first.digest === second.digest) {
    issues.push('QUARANTINE_INSTABILITY');
  }
  if (first.outcome === second.outcome) issues.push('QUARANTINE_INSTABILITY');
}

/**
 * Total, one-to-one lost→replacement mapping. Each lost obligation occurs
 * exactly once as a source and each replacement obligation exactly once as a
 * target, with no missing, extra, or duplicate endpoint. The mapping transfers,
 * discharges, and narrows nothing.
 */
function validateMapping(
  value: unknown,
  lost: readonly ObligationRef[],
  replacementManifest: QuarantineManifestReference | undefined,
  issues: QuarantineIssueCode[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('QUARANTINE_MAPPING');
    return;
  }
  const lostKeys = new Set(lost.map(obligationKey));
  const sourceKeys = new Set<string>();
  const targetKeys = new Set<string>();
  for (const item of value) {
    const pair = record(item);
    const lostRef = pair ? parseObligationRef(pair.lostObligation) : undefined;
    const replacementRef = pair ? parseObligationRef(pair.replacementObligation) : undefined;
    if (!pair || !closed(pair, PAIR_FIELDS) || !lostRef || !replacementRef) {
      issues.push('QUARANTINE_MAPPING');
      continue;
    }
    const lostKey = obligationKey(lostRef);
    const targetKey = obligationKey(replacementRef);
    if (
      !lostKeys.has(lostKey) ||
      sourceKeys.has(lostKey) ||
      targetKeys.has(targetKey) ||
      (replacementManifest !== undefined &&
        (replacementRef.manifestId !== replacementManifest.manifestId ||
          replacementRef.contentFingerprint !== replacementManifest.contentFingerprint))
    ) {
      issues.push('QUARANTINE_MAPPING');
      continue;
    }
    sourceKeys.add(lostKey);
    targetKeys.add(targetKey);
  }
  if (lostKeys.size !== sourceKeys.size) issues.push('QUARANTINE_MAPPING');
}

function validateNewManifest(
  manifest: QuarantineManifestReference | undefined,
  affected: ObligationRef | undefined,
  issues: QuarantineIssueCode[],
): void {
  if (!manifest) {
    issues.push('QUARANTINE_MANIFEST');
    return;
  }
  // A reinstatement must change the frozen fingerprint; the same one is no change.
  if (affected && manifest.contentFingerprint === affected.contentFingerprint) {
    issues.push('QUARANTINE_FINGERPRINT');
  }
}

/**
 * A later complete all-`PASS` Release Run reference. The run's outcome,
 * completeness, identity, timing, and manifest are untrusted claims checked for
 * shape and internal consistency only; they never repair the earlier result.
 */
function validateReleaseRun(
  value: unknown,
  expected: QuarantineManifestReference | undefined,
  proposedAtUtc: unknown,
  issues: QuarantineIssueCode[],
): void {
  const run = record(value);
  if (
    !run ||
    !closed(run, RELEASE_RUN_FIELDS) ||
    !safe(run.runId) ||
    typeof run.executedAtUtc !== 'string' ||
    !utcInstantExists(run.executedAtUtc) ||
    !QUARANTINE_OUTCOMES.includes(run.outcome as never) ||
    typeof run.complete !== 'boolean' ||
    run.complete !== true ||
    run.outcome !== 'PASS'
  ) {
    issues.push('QUARANTINE_EVIDENCE');
    return;
  }
  const runManifest = parseManifestRef(run.manifest);
  if (!runManifest) {
    issues.push('QUARANTINE_MANIFEST');
    return;
  }
  if (
    expected &&
    (runManifest.manifestId !== expected.manifestId ||
      runManifest.contentFingerprint !== expected.contentFingerprint)
  ) {
    issues.push('QUARANTINE_FINGERPRINT');
  }
  if (
    typeof proposedAtUtc !== 'string' ||
    !utcInstantExists(proposedAtUtc) ||
    Date.parse(run.executedAtUtc) <= Date.parse(proposedAtUtc)
  ) {
    issues.push('QUARANTINE_TIMING');
  }
}

function quarantineAssessment(
  issues: readonly QuarantineIssueCode[],
  obligations: readonly ObligationRef[],
): QuarantineAssessment {
  const codes = sortedUnique(issues);
  return deepFreeze({
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    decision: codes.length === 0 ? 'QUARANTINE_PROPOSED' : 'QUARANTINE_REJECTED',
    valid: codes.length === 0,
    issues: codes,
    unresolvedObligations: sortObligations(obligations),
    releaseCredit: false,
  });
}

function replacementAssessment(
  issues: readonly QuarantineIssueCode[],
  obligations: readonly ObligationRef[],
): ReplacementAssessment {
  const codes = sortedUnique(issues);
  return deepFreeze({
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    decision: codes.length === 0 ? 'REPLACEMENT_PROPOSED' : 'REPLACEMENT_REJECTED',
    valid: codes.length === 0,
    issues: codes,
    unresolvedObligations: sortObligations(obligations),
    releaseCredit: false,
  });
}

function reinstatementAssessment(
  issues: readonly QuarantineIssueCode[],
  obligations: readonly ObligationRef[],
): ReinstatementAssessment {
  const codes = sortedUnique(issues);
  return deepFreeze({
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    decision: codes.length === 0 ? 'REINSTATEMENT_PROPOSED' : 'REINSTATEMENT_REJECTED',
    valid: codes.length === 0,
    issues: codes,
    unresolvedObligations: sortObligations(obligations),
    releaseCredit: false,
  });
}

/**
 * Statically assesses an untrusted quarantine proposal. `valid` means only that
 * the shape and internal consistency are well formed; it never means the
 * evidence is true, the quarantine is applied, or any obligation is resolved.
 */
export function createQuarantineProposal(input: unknown): QuarantineAssessment {
  const issues: QuarantineIssueCode[] = [];
  try {
    const envelope = record(input);
    if (!envelope) {
      issues.push('QUARANTINE_SHAPE');
      return quarantineAssessment(issues, []);
    }
    if (!closed(envelope, QUARANTINE_INPUT_FIELDS)) {
      // An unknown root key fails closed, but a parseable affected obligation is
      // still retained unresolved rather than silently dropped; nothing is inferred.
      issues.push('QUARANTINE_SHAPE');
      const retained = parseObligationRef(envelope.affectedObligation);
      return quarantineAssessment(issues, retained ? [retained] : []);
    }
    if (envelope.schemaVersion !== QUARANTINE_SCHEMA_VERSION) issues.push('QUARANTINE_SCHEMA');
    if (!proposalIdShape(envelope.proposalId)) issues.push('QUARANTINE_IDENTITY');

    const manifest = parseManifestRef(envelope.manifest);
    if (!manifest) {
      issues.push('QUARANTINE_MANIFEST');
    }
    if (!hex(envelope.fingerprint)) {
      issues.push('QUARANTINE_FINGERPRINT');
    } else if (manifest && envelope.fingerprint !== manifest.contentFingerprint) {
      issues.push('QUARANTINE_FINGERPRINT');
    }

    const affected = parseObligationRef(envelope.affectedObligation);
    if (!affected) {
      issues.push('QUARANTINE_OBLIGATION');
    } else if (
      manifest &&
      (affected.manifestId !== manifest.manifestId ||
        affected.contentFingerprint !== manifest.contentFingerprint)
    ) {
      issues.push('QUARANTINE_OBLIGATION');
    }

    validateInstabilityPair(envelope.evidence, affected, issues);

    if (typeof envelope.proposedAtUtc !== 'string' || !utcInstantExists(envelope.proposedAtUtc)) {
      issues.push('QUARANTINE_TIMING');
    }
    validateAssertedEffects(envelope.assertedEffects, issues);

    return quarantineAssessment(issues, affected ? [affected] : []);
  } catch {
    return quarantineAssessment([...issues, 'QUARANTINE_SHAPE'], []);
  }
}

/**
 * Statically assesses an untrusted replacement proposal. The lost obligations
 * are always retained unresolved: the mapping is a shape/consistency check that
 * neither satisfies, discharges, transfers, nor narrows any obligation.
 */
export function assessReplacementProposal(input: unknown): ReplacementAssessment {
  const issues: QuarantineIssueCode[] = [];
  try {
    const envelope = record(input);
    if (!envelope) {
      issues.push('QUARANTINE_SHAPE');
      return replacementAssessment(issues, []);
    }
    if (!closed(envelope, REPLACEMENT_INPUT_FIELDS)) {
      // An unknown root key fails closed, but every parseable lost obligation is
      // still retained unresolved rather than silently dropped; nothing is inferred.
      issues.push('QUARANTINE_SHAPE');
      const lost = parseObligationList(envelope.lostObligations, issues);
      return replacementAssessment(issues, lost);
    }
    if (envelope.schemaVersion !== QUARANTINE_SCHEMA_VERSION) issues.push('QUARANTINE_SCHEMA');
    if (!proposalIdShape(envelope.proposalId)) issues.push('QUARANTINE_IDENTITY');
    if (!safe(envelope.quarantineReference)) issues.push('QUARANTINE_SHAPE');

    const lost = parseObligationList(envelope.lostObligations, issues);
    const replacementManifest = parseManifestRef(envelope.replacementManifest);
    if (!replacementManifest) issues.push('QUARANTINE_MANIFEST');

    validateQualification(envelope.qualification, replacementManifest, issues);
    validateMapping(envelope.mapping, lost, replacementManifest, issues);
    validateFinalApproval(envelope.approvals, issues);
    validateAssertedEffects(envelope.assertedEffects, issues);

    return replacementAssessment(issues, lost);
  } catch {
    return replacementAssessment([...issues, 'QUARANTINE_SHAPE'], []);
  }
}

/**
 * Statically assesses an untrusted reinstatement proposal. It authenticates no
 * approval, applies no reinstatement, repairs no earlier failure, and keeps the
 * affected obligation unresolved with `releaseCredit: false`.
 */
export function assessReinstatementProposal(input: unknown): ReinstatementAssessment {
  const issues: QuarantineIssueCode[] = [];
  try {
    const envelope = record(input);
    if (!envelope) {
      issues.push('QUARANTINE_SHAPE');
      return reinstatementAssessment(issues, []);
    }
    if (!closed(envelope, REINSTATEMENT_INPUT_FIELDS)) {
      // An unknown root key fails closed, but a parseable affected obligation is
      // still retained unresolved rather than silently dropped; nothing is inferred.
      issues.push('QUARANTINE_SHAPE');
      const retained = parseObligationRef(envelope.affectedObligation);
      return reinstatementAssessment(issues, retained ? [retained] : []);
    }
    if (envelope.schemaVersion !== QUARANTINE_SCHEMA_VERSION) issues.push('QUARANTINE_SCHEMA');
    if (!proposalIdShape(envelope.proposalId)) issues.push('QUARANTINE_IDENTITY');
    if (!safe(envelope.quarantineReference)) issues.push('QUARANTINE_SHAPE');

    const affected = parseObligationRef(envelope.affectedObligation);
    if (!affected) issues.push('QUARANTINE_OBLIGATION');

    if (!text(envelope.cause)) issues.push('QUARANTINE_EVIDENCE');
    if (!text(envelope.correction)) issues.push('QUARANTINE_EVIDENCE');
    validateEvidenceList(envelope.nonWeakeningProof, issues);
    const newManifest = parseManifestRef(envelope.manifest);
    validateQualification(envelope.qualification, newManifest, issues);
    validateNewManifest(newManifest, affected, issues);
    validateReleaseRun(envelope.releaseRun, newManifest, envelope.proposedAtUtc, issues);
    validateFinalApproval(envelope.approvals, issues);
    validateAssertedEffects(envelope.assertedEffects, issues);

    return reinstatementAssessment(issues, affected ? [affected] : []);
  } catch {
    return reinstatementAssessment([...issues, 'QUARANTINE_SHAPE'], []);
  }
}
