import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import { isGovernanceTiming } from '../contracts/governance-timing';
import {
  RELEASE_BUDGET_METHOD,
  RELEASE_BUDGET_METHOD_VERSION,
  RELEASE_LEDGER_SCHEMA_VERSION_V2,
  type ReleaseLedgerRecord,
  type ReleaseLedgerRecordV1,
  type ReleaseLedgerRecordV2,
  type ReleaseLifecycleEventV1,
  type ReleaseRunEventV1,
  type ReleaseRunEventV2,
  type ReleaseRuntimeFailureCode,
  type VerifiedBudgetPreflightV1,
} from '../contracts/release-runtime';
import {
  BROWSER_KINDS,
  ENVIRONMENT_CELL_CLASSIFICATIONS,
  type EnvironmentCell,
} from '../contracts/runtime';
import { isSafeRunId } from '../runtime/paths';

const MAX_BYTES = 8 * 1024 * 1024;
const EVENT = /^event-(\d{6})\.json$/;
const BUDGET_POLICY_ID = /^budget-policy-[0-9a-f]{64}$/;
const BUDGET_SET_ID = /^bset-[0-9a-f]{64}$/;

const PREFLIGHT_KEYS = [
  'releaseCredit',
  'policyApprovalId',
  'policyDigest',
  'approvalDigest',
  'reviewDigest',
  'measurementSetId',
  'measurementSetContentDigest',
  'method',
  'methodVersion',
  'ceilings',
  'limitations',
  'manifestId',
  'manifestFingerprint',
  'requiredCellId',
  'sourceProvenanceDigest',
  'basis',
] as const;
const BASIS_KEYS = [
  'measurementSetContentDigest',
  'retentionAuditId',
  'retentionAuditDigest',
] as const;
const CEILING_KEYS = [
  'releaseDurationMs',
  'releaseEvidenceBytes',
  'qualificationDurationMs',
  'qualificationEvidenceBytes',
  'retainedEvidenceBytes',
  'imageTornRecaptures',
] as const;
const SLOT_KEYS = ['order', 'entryId', 'cell', 'instanceId', 'runId'] as const;

export class ReleaseLedgerError extends Error {
  constructor(readonly code: ReleaseRuntimeFailureCode) {
    super('Release governance ledger refused.');
  }
}

function safeDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(directory) === directory;
  } catch {
    return false;
  }
}

function ensure(root: string, relative: string): string {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || !safeDirectory(root))
    throw new ReleaseLedgerError('LEDGER_INVALID');
  let current = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || part.includes('\\'))
      throw new ReleaseLedgerError('LEDGER_INVALID');
    current = path.join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new ReleaseLedgerError('LEDGER_INVALID');
    }
    if (!safeDirectory(current)) throw new ReleaseLedgerError('LEDGER_INVALID');
  }
  return current;
}

function existing(root: string, relative: string): string {
  let current = root;
  if (!path.isAbsolute(root) || path.normalize(root) !== root || !safeDirectory(root))
    throw new ReleaseLedgerError('LEDGER_INVALID');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!safeDirectory(current)) throw new ReleaseLedgerError('LEDGER_INVALID');
  }
  return current;
}

function safeLedgerId(id: string): boolean {
  return /^[a-z][a-z0-9-]{0,95}$/.test(id);
}
function isLifecycleId(id: string): boolean {
  return /^manifest-[0-9a-f]{64}$/.test(id);
}
function baseDirectory(root: string, ledgerId: string, create: boolean): string {
  if (!safeLedgerId(ledgerId) || (ledgerId.startsWith('manifest-') && !isLifecycleId(ledgerId)))
    throw new ReleaseLedgerError('LEDGER_INVALID');
  const rel = isLifecycleId(ledgerId)
    ? `evidence/governance/manifest-lifecycle/${ledgerId}`
    : `evidence/governance/release-runs/${ledgerId}`;
  return create ? ensure(root, rel) : existing(root, rel);
}

function readFile(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES)
      throw new ReleaseLedgerError('LEDGER_INVALID');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    )
      throw new ReleaseLedgerError('LEDGER_INVALID');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function validCell(value: unknown): value is EnvironmentCell {
  if (
    !exact(value, [
      'cellId',
      'classification',
      'browserKind',
      'browserChannel',
      'playwrightVersion',
      'viewport',
      'deviceScaleFactor',
      'locale',
      'timezoneId',
      'colorScheme',
      'reducedMotion',
      'permissions',
      'geolocation',
      'storageState',
    ]) ||
    typeof value.cellId !== 'string' ||
    !value.cellId ||
    !ENVIRONMENT_CELL_CLASSIFICATIONS.includes(
      value.classification as EnvironmentCell['classification'],
    ) ||
    !BROWSER_KINDS.includes(value.browserKind as EnvironmentCell['browserKind']) ||
    typeof value.browserChannel !== 'string' ||
    typeof value.playwrightVersion !== 'string' ||
    !exact(value.viewport, ['width', 'height']) ||
    !Number.isSafeInteger(value.viewport.width) ||
    (value.viewport.width as number) < 1 ||
    !Number.isSafeInteger(value.viewport.height) ||
    (value.viewport.height as number) < 1 ||
    typeof value.deviceScaleFactor !== 'number' ||
    !Number.isFinite(value.deviceScaleFactor) ||
    value.deviceScaleFactor <= 0 ||
    typeof value.locale !== 'string' ||
    typeof value.timezoneId !== 'string' ||
    (value.colorScheme !== 'dark' && value.colorScheme !== 'light') ||
    (value.reducedMotion !== 'no-preference' && value.reducedMotion !== 'reduce') ||
    !Array.isArray(value.permissions) ||
    value.permissions.some((permission) => typeof permission !== 'string') ||
    (value.geolocation !== null &&
      (!exact(value.geolocation, ['latitude', 'longitude']) ||
        typeof value.geolocation.latitude !== 'number' ||
        !Number.isFinite(value.geolocation.latitude) ||
        typeof value.geolocation.longitude !== 'number' ||
        !Number.isFinite(value.geolocation.longitude))) ||
    value.storageState !== null
  )
    return false;
  return true;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function ascendingNonnegative(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (order, index) =>
        Number.isSafeInteger(order) &&
        (order as number) >= 0 &&
        (index === 0 || (order as number) > ((value as readonly number[])[index - 1] as number)),
    )
  );
}

function validSlot(value: unknown): boolean {
  return (
    exact(value, SLOT_KEYS) &&
    Number.isSafeInteger(value.order) &&
    (value.order as number) >= 0 &&
    typeof value.entryId === 'string' &&
    typeof value.instanceId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.instanceId) &&
    typeof value.runId === 'string' &&
    isSafeRunId(value.runId) &&
    validCell(value.cell)
  );
}

function validCeilings(value: unknown): boolean {
  if (!exact(value, CEILING_KEYS)) return false;
  return (
    Number.isFinite(value.releaseDurationMs) &&
    (value.releaseDurationMs as number) >= 0 &&
    Number.isSafeInteger(value.releaseEvidenceBytes) &&
    (value.releaseEvidenceBytes as number) >= 0 &&
    Number.isFinite(value.qualificationDurationMs) &&
    (value.qualificationDurationMs as number) >= 0 &&
    Number.isSafeInteger(value.qualificationEvidenceBytes) &&
    (value.qualificationEvidenceBytes as number) >= 0 &&
    Number.isSafeInteger(value.retainedEvidenceBytes) &&
    (value.retainedEvidenceBytes as number) >= 0 &&
    (value.imageTornRecaptures === null ||
      (Number.isSafeInteger(value.imageTornRecaptures) &&
        (value.imageTornRecaptures as number) >= 0))
  );
}

/**
 * Closed structural validation of one independently verified budget preflight.
 * This proves only that the value is well formed and internally consistent; it
 * is never re-authentication and it never grants Release credit.
 */
export function isVerifiedBudgetPreflight(value: unknown): value is VerifiedBudgetPreflightV1 {
  if (!exact(value, PREFLIGHT_KEYS)) return false;
  if (
    value.releaseCredit !== false ||
    typeof value.policyApprovalId !== 'string' ||
    !BUDGET_POLICY_ID.test(value.policyApprovalId) ||
    !digest(value.policyDigest) ||
    !digest(value.approvalDigest) ||
    !digest(value.reviewDigest) ||
    typeof value.measurementSetId !== 'string' ||
    !BUDGET_SET_ID.test(value.measurementSetId) ||
    !digest(value.measurementSetContentDigest) ||
    value.method !== RELEASE_BUDGET_METHOD ||
    value.methodVersion !== RELEASE_BUDGET_METHOD_VERSION ||
    !validCeilings(value.ceilings) ||
    !Array.isArray(value.limitations) ||
    value.limitations.some((entry) => !nonEmptyText(entry)) ||
    !nonEmptyText(value.manifestId) ||
    !digest(value.manifestFingerprint) ||
    !nonEmptyText(value.requiredCellId) ||
    !digest(value.sourceProvenanceDigest) ||
    !exact(value.basis, BASIS_KEYS)
  )
    return false;
  const basis = value.basis as Record<string, unknown>;
  return (
    basis.measurementSetContentDigest === value.measurementSetContentDigest &&
    digest(basis.measurementSetContentDigest) &&
    nonEmptyText(basis.retentionAuditId) &&
    digest(basis.retentionAuditDigest)
  );
}

function validV1Event(event: unknown): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const value = event as Record<string, unknown>;
  if (value.type === 'APPROVED_FROZEN')
    return (
      exact(value, [
        'type',
        'manifest',
        'draftBytesDigest',
        'batchId',
        'batchFingerprint',
        'qualificationLedgerDigest',
        'approvalId',
        'approvalBytesDigest',
        'proposalBytesDigest',
        'reviewBytesDigests',
        'work',
      ]) &&
      [
        'draftBytesDigest',
        'batchFingerprint',
        'qualificationLedgerDigest',
        'approvalBytesDigest',
        'proposalBytesDigest',
      ].every(
        (key) => typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key] as string),
      ) &&
      typeof value.batchId === 'string' &&
      /^qbatch-[0-9a-f-]{36}$/.test(value.batchId) &&
      typeof value.approvalId === 'string' &&
      /^[a-z][a-z0-9-]{0,95}$/.test(value.approvalId) &&
      Array.isArray(value.reviewBytesDigests) &&
      value.reviewBytesDigests.length > 0 &&
      value.reviewBytesDigests.every(
        (digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest),
      ) &&
      Array.isArray(value.work) &&
      value.work.length > 0 &&
      value.work.every(
        (item) =>
          exact(item, ['entryId', 'cellId']) &&
          typeof item.entryId === 'string' &&
          typeof item.cellId === 'string',
      )
    );
  if (value.type === 'ACTIVE')
    return (
      exact(value, ['type', 'frozenEventDigest']) &&
      typeof value.frozenEventDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(value.frozenEventDigest)
    );
  if (value.type === 'run-predeclared')
    return (
      exact(value, ['type', 'lifecycleId', 'activeEventDigest', 'slots', 'shardPlanFingerprint']) &&
      typeof value.lifecycleId === 'string' &&
      isLifecycleId(value.lifecycleId) &&
      digest(value.activeEventDigest) &&
      digest(value.shardPlanFingerprint) &&
      Array.isArray(value.slots) &&
      value.slots.length > 0 &&
      value.slots.every(validSlot)
    );
  if (value.type === 'run-started')
    return exact(value, ['type', 'lifecycleDigest']) && digest(value.lifecycleDigest);
  if (value.type === 'slot-started')
    return (
      exact(value, ['type', 'order', 'instanceId', 'runId']) &&
      Number.isSafeInteger(value.order) &&
      (value.order as number) >= 0 &&
      typeof value.instanceId === 'string' &&
      typeof value.runId === 'string' &&
      isSafeRunId(value.runId)
    );
  if (value.type === 'slot-finished')
    return (
      exact(
        value,
        Object.hasOwn(value, 'timing')
          ? [
              'type',
              'order',
              'instanceId',
              'runId',
              'outcome',
              'recordDigest',
              'evidenceDigest',
              'failureCode',
              'timing',
            ]
          : [
              'type',
              'order',
              'instanceId',
              'runId',
              'outcome',
              'recordDigest',
              'evidenceDigest',
              'failureCode',
            ],
      ) &&
      (!Object.hasOwn(value, 'timing') || isGovernanceTiming(value.timing)) &&
      Number.isSafeInteger(value.order) &&
      (value.order as number) >= 0 &&
      typeof value.instanceId === 'string' &&
      typeof value.runId === 'string' &&
      isSafeRunId(value.runId) &&
      (value.outcome === null ||
        value.outcome === 'PASS' ||
        value.outcome === 'BUG' ||
        value.outcome === 'HARNESS_BLOCKED' ||
        value.outcome === 'ENVIRONMENT_FAILURE') &&
      (value.recordDigest === null || digest(value.recordDigest)) &&
      (value.evidenceDigest === null || digest(value.evidenceDigest)) &&
      (value.failureCode === null || typeof value.failureCode === 'string')
    );
  if (value.type === 'run-assessed')
    return (
      exact(value, [
        'type',
        'state',
        'unstartedOrders',
        'releaseCreditGranted',
        ...(Object.hasOwn(value, 'timing') ? ['timing'] : []),
        ...(Object.hasOwn(value, 'timingFailureCode') ? ['timingFailureCode'] : []),
      ]) &&
      (!Object.hasOwn(value, 'timing') || isGovernanceTiming(value.timing)) &&
      (!Object.hasOwn(value, 'timingFailureCode') ||
        value.timingFailureCode === 'TIMING_INVALID') &&
      (value.state === 'COMPLETE_ALL_PASS' ||
        value.state === 'NON_CREDITABLE' ||
        value.state === 'INTERRUPTED') &&
      Array.isArray(value.unstartedOrders) &&
      value.unstartedOrders.every(
        (order) => Number.isSafeInteger(order) && (order as number) >= 0,
      ) &&
      new Set(value.unstartedOrders).size === value.unstartedOrders.length &&
      typeof value.releaseCreditGranted === 'boolean' &&
      value.releaseCreditGranted === (value.state === 'COMPLETE_ALL_PASS')
    );
  return false;
}

/**
 * V2 validation. Lifecycle and shared slot events keep their exact V1 closed
 * shape; `run-predeclared` must now carry a bound budget preflight and
 * `run-assessed` may additionally be the non-creditable `BUDGET_TERMINATED`.
 */
function validV2Event(event: unknown): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const value = event as Record<string, unknown>;
  if (value.type === 'run-predeclared')
    return (
      exact(value, [
        'type',
        'lifecycleId',
        'activeEventDigest',
        'slots',
        'shardPlanFingerprint',
        'budget',
      ]) &&
      typeof value.lifecycleId === 'string' &&
      isLifecycleId(value.lifecycleId) &&
      digest(value.activeEventDigest) &&
      digest(value.shardPlanFingerprint) &&
      Array.isArray(value.slots) &&
      value.slots.length > 0 &&
      value.slots.every(validSlot) &&
      isVerifiedBudgetPreflight(value.budget)
    );
  if (value.type === 'run-provisional')
    return (
      exact(value, [
        'type',
        'completedOrders',
        'unstartedOrders',
        'pending',
        'releaseCreditGranted',
      ]) &&
      // Both the completed prefix and the remaining suffix are strictly
      // ascending ordered slot orders. The provisional record is explicitly
      // pending and can never grant credit (ADR 0113).
      ascendingNonnegative(value.completedOrders) &&
      ascendingNonnegative(value.unstartedOrders) &&
      value.pending === true &&
      value.releaseCreditGranted === false
    );
  if (value.type === 'run-assessed')
    return (
      exact(value, [
        'type',
        'state',
        'unstartedOrders',
        'releaseCreditGranted',
        ...(Object.hasOwn(value, 'timing') ? ['timing'] : []),
        ...(Object.hasOwn(value, 'timingFailureCode') ? ['timingFailureCode'] : []),
      ]) &&
      (!Object.hasOwn(value, 'timing') || isGovernanceTiming(value.timing)) &&
      (!Object.hasOwn(value, 'timingFailureCode') ||
        value.timingFailureCode === 'TIMING_INVALID') &&
      (value.state === 'COMPLETE_ALL_PASS' ||
        value.state === 'NON_CREDITABLE' ||
        value.state === 'INTERRUPTED' ||
        value.state === 'BUDGET_TERMINATED') &&
      Array.isArray(value.unstartedOrders) &&
      value.unstartedOrders.every(
        (order) => Number.isSafeInteger(order) && (order as number) >= 0,
      ) &&
      new Set(value.unstartedOrders).size === value.unstartedOrders.length &&
      // V2 exact remaining slots must be strictly ascending: they are a suffix of
      // the immutable manifest order, never an arbitrary or reordered set.
      value.unstartedOrders.every(
        (order, index) =>
          index === 0 ||
          (order as number) > ((value.unstartedOrders as readonly number[])[index - 1] as number),
      ) &&
      typeof value.releaseCreditGranted === 'boolean' &&
      // A structurally complete run is *not* automatically credit. Terminal
      // credit is derived at readback by independently corroborating the bound
      // authority (see `verifyReleaseRun`), so this structural check only keeps
      // the safe direction: credit may never be recorded for a non-complete /
      // terminated state. It must not infer credit from `state`.
      (value.releaseCreditGranted === false || value.state === 'COMPLETE_ALL_PASS')
    );
  return validV1Event(event);
}

export function readReleaseLedger(root: string, ledgerId: string): readonly ReleaseLedgerRecord[] {
  const directory = baseDirectory(root, ledgerId, false);
  const events = path.join(directory, 'events');
  if (!safeDirectory(events)) throw new ReleaseLedgerError('LEDGER_INVALID');
  const names = readdirSync(events).sort();
  const output: ReleaseLedgerRecord[] = [];
  let previous: string | null = null;
  let version: 1 | typeof RELEASE_LEDGER_SCHEMA_VERSION_V2 | null = null;
  for (let i = 0; i < names.length; i += 1) {
    const match = EVENT.exec(names[i] ?? '');
    if (!match || Number(match[1]) !== i + 1) throw new ReleaseLedgerError('LEDGER_INVALID');
    const bytes = readFile(path.join(events, names[i] as string));
    const value: unknown = JSON.parse(bytes);
    if (`${canonicalize(value)}\n` !== bytes) throw new ReleaseLedgerError('LEDGER_INVALID');
    if (
      !exact(value, [
        'schemaVersion',
        'ledgerId',
        'sequence',
        'previousDigest',
        'event',
        'digest',
      ]) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== RELEASE_LEDGER_SCHEMA_VERSION_V2) ||
      value.ledgerId !== ledgerId ||
      value.sequence !== i + 1 ||
      value.previousDigest !== previous ||
      typeof value.digest !== 'string'
    )
      throw new ReleaseLedgerError('LEDGER_INVALID');
    // A chain has exactly one version; any silent mixed-version append refuses.
    if (version === null)
      version = value.schemaVersion as 1 | typeof RELEASE_LEDGER_SCHEMA_VERSION_V2;
    else if (value.schemaVersion !== version) throw new ReleaseLedgerError('LEDGER_INVALID');
    const valid = version === 1 ? validV1Event(value.event) : validV2Event(value.event);
    if (!valid) throw new ReleaseLedgerError('LEDGER_INVALID');
    const digest = sha256Hex(
      canonicalize({
        schemaVersion: version,
        ledgerId,
        sequence: i + 1,
        previousDigest: previous,
        event: value.event,
      }),
    );
    if (digest !== value.digest) throw new ReleaseLedgerError('LEDGER_INVALID');
    output.push(value as unknown as ReleaseLedgerRecord);
    previous = digest;
  }
  if (output.length === 0) throw new ReleaseLedgerError('LEDGER_INVALID');
  return output;
}

export function createReleaseLedger(
  root: string,
  ledgerId: string,
  event: ReleaseLedgerRecordV1['event'],
): ReleaseLedgerRecordV1 {
  if (!validV1Event(event)) throw new ReleaseLedgerError('LEDGER_INVALID');
  return create(root, ledgerId, 1, event) as ReleaseLedgerRecordV1;
}

/** Create one new V2 budget-bearing run ledger. */
export function createReleaseLedgerV2(
  root: string,
  ledgerId: string,
  event: ReleaseLifecycleEventV1 | ReleaseRunEventV2,
): ReleaseLedgerRecordV2 {
  if (!validV2Event(event)) throw new ReleaseLedgerError('LEDGER_INVALID');
  return create(root, ledgerId, RELEASE_LEDGER_SCHEMA_VERSION_V2, event) as ReleaseLedgerRecordV2;
}

export function appendReleaseEvent(
  root: string,
  ledgerId: string,
  event: ReleaseLedgerRecordV1['event'],
): ReleaseLedgerRecordV1 {
  if (!validV1Event(event)) throw new ReleaseLedgerError('LEDGER_INVALID');
  return append(root, ledgerId, 1, event) as ReleaseLedgerRecordV1;
}

/** Append one event to an existing V2 run ledger; a V1 chain refuses. */
export function appendReleaseEventV2(
  root: string,
  ledgerId: string,
  event: ReleaseLifecycleEventV1 | ReleaseRunEventV2,
): ReleaseLedgerRecordV2 {
  if (!validV2Event(event)) throw new ReleaseLedgerError('LEDGER_INVALID');
  return append(root, ledgerId, RELEASE_LEDGER_SCHEMA_VERSION_V2, event) as ReleaseLedgerRecordV2;
}

function create(
  root: string,
  ledgerId: string,
  version: 1 | typeof RELEASE_LEDGER_SCHEMA_VERSION_V2,
  event: ReleaseLifecycleEventV1 | ReleaseRunEventV1 | ReleaseRunEventV2,
): ReleaseLedgerRecord {
  const directory = baseDirectory(root, ledgerId, true);
  const events = path.join(directory, 'events');
  try {
    mkdirSync(events, { mode: 0o700 });
  } catch {
    throw new ReleaseLedgerError('LEDGER_INVALID');
  }
  if (!safeDirectory(events)) throw new ReleaseLedgerError('LEDGER_INVALID');
  return writeEvent(events, ledgerId, version, 1, null, event);
}

function append(
  root: string,
  ledgerId: string,
  version: 1 | typeof RELEASE_LEDGER_SCHEMA_VERSION_V2,
  event: ReleaseLifecycleEventV1 | ReleaseRunEventV1 | ReleaseRunEventV2,
): ReleaseLedgerRecord {
  const records = readReleaseLedger(root, ledgerId);
  const previous = records.at(-1);
  if (!previous) throw new ReleaseLedgerError('LEDGER_INVALID');
  if (previous.schemaVersion !== version) throw new ReleaseLedgerError('LEDGER_INVALID');
  const events = path.join(baseDirectory(root, ledgerId, false), 'events');
  return writeEvent(events, ledgerId, version, records.length + 1, previous.digest, event);
}

export function claimReleaseRun(root: string, runId: string, fingerprint: string): void {
  if (!isSafeRunId(runId)) throw new ReleaseLedgerError('LEDGER_INVALID');
  const directory = baseDirectory(root, runId, false);
  try {
    const fd = openSync(
      path.join(directory, 'run-once.lock'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, `${fingerprint}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new ReleaseLedgerError('RUN_CONSUMED');
  }
}

export function verifyReleaseRunClaim(
  root: string,
  runId: string,
  predeclarationDigest: string,
): boolean {
  if (!isSafeRunId(runId) || !digest(predeclarationDigest)) return false;
  try {
    const file = path.join(baseDirectory(root, runId, false), 'run-once.lock');
    const bytes = readFile(file);
    return bytes === `${predeclarationDigest}\n`;
  } catch {
    return false;
  }
}

function writeEvent(
  events: string,
  ledgerId: string,
  version: 1 | typeof RELEASE_LEDGER_SCHEMA_VERSION_V2,
  sequence: number,
  previousDigest: string | null,
  event: ReleaseLifecycleEventV1 | ReleaseRunEventV1 | ReleaseRunEventV2,
): ReleaseLedgerRecord {
  const unsigned = { schemaVersion: version, ledgerId, sequence, previousDigest, event };
  const record: ReleaseLedgerRecord = {
    ...unsigned,
    digest: sha256Hex(canonicalize(unsigned)),
  } as ReleaseLedgerRecord;
  const file = path.join(events, `event-${String(sequence).padStart(6, '0')}.json`);
  const bytes = `${canonicalize(record)}\n`;
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new ReleaseLedgerError('LEDGER_INVALID');
  }
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}
