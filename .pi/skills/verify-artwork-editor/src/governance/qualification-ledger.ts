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
  isQualificationBatchId,
  QUALIFICATION_RUNTIME_SCHEMA_VERSION,
  type QualificationBatchV1,
  type QualificationLedgerEventV1,
  type QualificationLedgerRecordV1,
} from '../contracts/qualification-runtime';

const MAX_LEDGER_RECORD_BYTES = 8 * 1024 * 1024;
const EVENT_NAME = /^event-(\d{6})\.json$/;

export class QualificationLedgerError extends Error {
  constructor(readonly code: 'UNSAFE_ROOT' | 'UNSAFE_RECORD' | 'CHAIN_INVALID' | 'COLLISION') {
    super('Qualification ledger operation refused.');
    this.name = 'QualificationLedgerError';
  }
}

function hashRecord(record: Omit<QualificationLedgerRecordV1, 'digest'>): string {
  return sha256Hex(canonicalize(record));
}

function canonicalDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(directory) === directory;
  } catch {
    return false;
  }
}

function ensureDirectory(root: string, relative: string): string {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || !canonicalDirectory(root)) {
    throw new QualificationLedgerError('UNSAFE_ROOT');
  }
  let current = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    if (segment === '.' || segment === '..' || segment.includes('\\')) {
      throw new QualificationLedgerError('UNSAFE_ROOT');
    }
    current = path.join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new QualificationLedgerError('UNSAFE_ROOT');
      }
    }
    if (!canonicalDirectory(current)) throw new QualificationLedgerError('UNSAFE_ROOT');
  }
  return current;
}

function existingDirectory(root: string, relative: string): string {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || !canonicalDirectory(root)) {
    throw new QualificationLedgerError('UNSAFE_ROOT');
  }
  let current = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    if (segment === '.' || segment === '..' || segment.includes('\\')) {
      throw new QualificationLedgerError('UNSAFE_ROOT');
    }
    current = path.join(current, segment);
    if (!canonicalDirectory(current)) throw new QualificationLedgerError('UNSAFE_ROOT');
  }
  return current;
}

function batchDirectory(root: string, batchId: string): string {
  if (!isQualificationBatchId(batchId)) throw new QualificationLedgerError('UNSAFE_ROOT');
  const authority = existingDirectory(root, 'evidence/governance/qualification-authority/batches');
  const directory = path.join(authority, batchId);
  if (!canonicalDirectory(directory)) throw new QualificationLedgerError('UNSAFE_ROOT');
  return directory;
}

function readRegularFile(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new QualificationLedgerError('UNSAFE_RECORD');
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_LEDGER_RECORD_BYTES) {
      throw new QualificationLedgerError('UNSAFE_RECORD');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new QualificationLedgerError('UNSAFE_RECORD');
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function validateRecord(
  value: unknown,
  batchId: string,
  sequence: number,
  previousDigest: string | null,
): QualificationLedgerRecordV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QualificationLedgerError('CHAIN_INVALID');
  }
  const record = value as Partial<QualificationLedgerRecordV1>;
  if (
    !exactKeys(record as Record<string, unknown>, [
      'schemaVersion',
      'batchId',
      'sequence',
      'previousDigest',
      'event',
      'digest',
    ]) ||
    record.schemaVersion !== QUALIFICATION_RUNTIME_SCHEMA_VERSION ||
    record.batchId !== batchId ||
    record.sequence !== sequence ||
    record.previousDigest !== previousDigest ||
    typeof record.digest !== 'string' ||
    !record.event ||
    typeof record.event !== 'object' ||
    Array.isArray(record.event)
  ) {
    throw new QualificationLedgerError('CHAIN_INVALID');
  }
  const unsigned = {
    schemaVersion: record.schemaVersion,
    batchId: record.batchId,
    sequence: record.sequence,
    previousDigest: record.previousDigest,
    event: record.event,
  } as Omit<QualificationLedgerRecordV1, 'digest'>;
  if (hashRecord(unsigned) !== record.digest) throw new QualificationLedgerError('CHAIN_INVALID');
  if (!validateEvent(record.event, batchId)) throw new QualificationLedgerError('CHAIN_INVALID');
  if (sequence === 1 && record.event.type !== 'batch-predeclared') {
    throw new QualificationLedgerError('CHAIN_INVALID');
  }
  return record as QualificationLedgerRecordV1;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function validateEvent(event: QualificationLedgerEventV1, batchId: string): boolean {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return false;
  const value = event as unknown as Record<string, unknown>;
  switch (value.type) {
    case 'batch-predeclared':
      return (
        exactKeys(value, ['type', 'batch']) &&
        typeof value.batch === 'object' &&
        value.batch !== null &&
        !Array.isArray(value.batch) &&
        (value.batch as Record<string, unknown>).batchId === batchId
      );
    case 'batch-started':
      return (
        exactKeys(value, ['type', 'batchFingerprint']) &&
        typeof value.batchFingerprint === 'string' &&
        /^[0-9a-f]{64}$/.test(value.batchFingerprint)
      );
    case 'instance-started':
      return (
        exactKeys(value, ['type', 'ordinal', 'instanceId', 'runId']) &&
        Number.isSafeInteger(value.ordinal) &&
        (value.ordinal as number) > 0 &&
        typeof value.instanceId === 'string' &&
        typeof value.runId === 'string'
      );
    case 'instance-finished': {
      const keys = [
        'type',
        'ordinal',
        'instanceId',
        'runId',
        'outcome',
        'recordDigest',
        'evidenceDigest',
        'evidenceVerified',
        'cleanupVerified',
        'failureCode',
      ];
      const hasTiming = Object.hasOwn(value, 'timing');
      return (
        exactKeys(value, hasTiming ? [...keys, 'timing'] : keys) &&
        (!hasTiming || isGovernanceTiming(value.timing)) &&
        Number.isSafeInteger(value.ordinal) &&
        (value.ordinal as number) > 0 &&
        typeof value.instanceId === 'string' &&
        typeof value.runId === 'string' &&
        (value.outcome === null ||
          value.outcome === 'PASS' ||
          value.outcome === 'BUG' ||
          value.outcome === 'HARNESS_BLOCKED' ||
          value.outcome === 'ENVIRONMENT_FAILURE') &&
        (value.recordDigest === null ||
          (typeof value.recordDigest === 'string' && /^[0-9a-f]{64}$/.test(value.recordDigest))) &&
        (value.evidenceDigest === null ||
          (typeof value.evidenceDigest === 'string' &&
            /^[0-9a-f]{64}$/.test(value.evidenceDigest))) &&
        typeof value.evidenceVerified === 'boolean' &&
        typeof value.cleanupVerified === 'boolean' &&
        (value.failureCode === null || typeof value.failureCode === 'string')
      );
    }
    case 'batch-assessed': {
      const keys = ['type', 'state', 'failureCode', 'completedAttemptCount', 'releaseCredit'];
      const hasTiming = Object.hasOwn(value, 'timing');
      return (
        exactKeys(value, hasTiming ? [...keys, 'timing'] : keys) &&
        (!hasTiming || isGovernanceTiming(value.timing)) &&
        (value.state === 'REVIEW_READY' ||
          value.state === 'FAILED' ||
          value.state === 'INTERRUPTED') &&
        (value.failureCode === null || typeof value.failureCode === 'string') &&
        Number.isSafeInteger(value.completedAttemptCount) &&
        (value.completedAttemptCount as number) >= 0 &&
        value.releaseCredit === false
      );
    }
    default:
      return false;
  }
}

export function createQualificationBatchDirectory(root: string, batch: QualificationBatchV1): void {
  if (!isQualificationBatchId(batch.batchId)) throw new QualificationLedgerError('UNSAFE_ROOT');
  const authority = ensureDirectory(root, 'evidence/governance/qualification-authority/batches');
  const directory = path.join(authority, batch.batchId);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch {
    throw new QualificationLedgerError('COLLISION');
  }
  if (!canonicalDirectory(directory)) throw new QualificationLedgerError('UNSAFE_ROOT');
  const events = path.join(directory, 'events');
  mkdirSync(events, { mode: 0o700 });
  if (!canonicalDirectory(events)) throw new QualificationLedgerError('UNSAFE_ROOT');
  const unsigned = {
    schemaVersion: QUALIFICATION_RUNTIME_SCHEMA_VERSION,
    batchId: batch.batchId,
    sequence: 1,
    previousDigest: null,
    event: { type: 'batch-predeclared' as const, batch },
  } satisfies Omit<QualificationLedgerRecordV1, 'digest'>;
  const record: QualificationLedgerRecordV1 = { ...unsigned, digest: hashRecord(unsigned) };
  const file = path.join(events, 'event-000001.json');
  const bytes = `${canonicalize(record)}\n`;
  if (Buffer.byteLength(bytes) > MAX_LEDGER_RECORD_BYTES)
    throw new QualificationLedgerError('UNSAFE_RECORD');
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new QualificationLedgerError('COLLISION');
  }
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readQualificationLedger(
  root: string,
  batchId: string,
): readonly QualificationLedgerRecordV1[] {
  const directory = batchDirectory(root, batchId);
  const events = path.join(directory, 'events');
  if (!canonicalDirectory(events)) throw new QualificationLedgerError('UNSAFE_ROOT');
  const names = readdirSync(events).sort();
  const records: QualificationLedgerRecordV1[] = [];
  let previousDigest: string | null = null;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index] as string;
    const match = EVENT_NAME.exec(name);
    if (!match || Number(match[1]) !== index + 1)
      throw new QualificationLedgerError('CHAIN_INVALID');
    const value = JSON.parse(readRegularFile(path.join(events, name))) as unknown;
    const record = validateRecord(value, batchId, index + 1, previousDigest);
    records.push(record);
    previousDigest = record.digest;
  }
  if (records.length === 0) throw new QualificationLedgerError('CHAIN_INVALID');
  return records;
}

export function appendQualificationEvent(
  root: string,
  batchId: string,
  event: QualificationLedgerEventV1,
): QualificationLedgerRecordV1 {
  const records = readQualificationLedger(root, batchId);
  const previous = records[records.length - 1];
  if (!previous) throw new QualificationLedgerError('CHAIN_INVALID');
  const unsigned = {
    schemaVersion: QUALIFICATION_RUNTIME_SCHEMA_VERSION,
    batchId,
    sequence: records.length + 1,
    previousDigest: previous.digest,
    event,
  } satisfies Omit<QualificationLedgerRecordV1, 'digest'>;
  const record: QualificationLedgerRecordV1 = { ...unsigned, digest: hashRecord(unsigned) };
  const events = path.join(batchDirectory(root, batchId), 'events');
  const file = path.join(events, `event-${String(record.sequence).padStart(6, '0')}.json`);
  const bytes = `${canonicalize(record)}\n`;
  if (Buffer.byteLength(bytes) > MAX_LEDGER_RECORD_BYTES)
    throw new QualificationLedgerError('UNSAFE_RECORD');
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new QualificationLedgerError('COLLISION');
  }
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

/** A permanent exclusive marker makes an interrupted or completed batch one-shot. */
export function claimQualificationBatch(
  root: string,
  batchId: string,
  batchFingerprint: string,
): void {
  const directory = batchDirectory(root, batchId);
  const lock = path.join(directory, 'run-once.lock');
  try {
    const fd = openSync(
      lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, `${batchFingerprint}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new QualificationLedgerError('COLLISION');
  }
}
