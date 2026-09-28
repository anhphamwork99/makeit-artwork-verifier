import path from 'node:path';

/**
 * Complete plain-JSON recursive redaction guard (ADR 0011 R8).
 *
 * The guard validates that a candidate value is a plain JSON data graph and
 * that no string value, object key, or serialized byte carries a prohibited
 * transient handle (`blob:`), a registered private absolute path, a `file:`
 * form, a drive-letter path, a UNC path, or a lexical POSIX absolute path.
 *
 * Two invariants are non-negotiable:
 *
 * 1. It is complete: every value, every key, every array, and the exact bytes
 *    that would be written are inspected, over bounded decoded/normalized forms
 *    (percent encoding, JSON escaping, slash conversion, case).
 * 2. It does not leak: a failure returns only a fixed reason code and a
 *    non-sensitive structural trail. The trail never includes an offending key
 *    or value; arbitrary keys are replaced by an ordinal placeholder.
 */

export const REDACTION_FAILURE_CODES = [
  'REDACTION_NOT_PLAIN_JSON',
  'REDACTION_PROHIBITED_VALUE',
] as const;
export type RedactionFailureCode = (typeof REDACTION_FAILURE_CODES)[number];

export interface RedactionFailure {
  code: RedactionFailureCode;
  trail: string;
}

export class RedactionRejectedError extends Error {
  readonly code: RedactionFailureCode;
  readonly trail: string;
  constructor(failure: RedactionFailure) {
    super(`Redaction rejected: ${failure.code} at ${failure.trail}`);
    this.name = 'RedactionRejectedError';
    this.code = failure.code;
    this.trail = failure.trail;
  }
}

export interface GuardOptions {
  /** Registered private absolute paths (and realpath variants) to reject. */
  forbiddenPaths?: readonly string[];
}

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DRIVE_PREFIX = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^\/\/[^/]/;
const UNC_BACKSLASH = /\\\\/;
const POSIX_ABSOLUTE_ROOT =
  /\/(Users|home|private|var|tmp|opt|etc|root|mnt|Volumes|System|Library|workspace)\//i;

function keySegment(key: string, ordinal: number): string {
  return SAFE_KEY.test(key) ? `.${key}` : `.<key:${ordinal}>`;
}

function decodeVariants(value: string): string[] {
  const variants = new Set<string>();
  const push = (entry: string): void => {
    if (entry.length > 0) variants.add(entry);
  };
  push(value);
  push(value.toLowerCase());
  try {
    const decoded = decodeURIComponent(value);
    push(decoded);
    push(decoded.toLowerCase());
  } catch {
    // Not percent-encoded; the raw form is still inspected.
  }
  const unescaped = value
    .replace(/\\u002f/gi, '/')
    .replace(/\\u005c/gi, '\\')
    .replace(/\\\//g, '/');
  push(unescaped);
  try {
    push(decodeURIComponent(unescaped));
  } catch {
    // Not percent-encoded after JSON unescaping.
  }
  const slashConverted = value.replace(/\\/g, '/');
  push(slashConverted);
  push(slashConverted.toLowerCase());
  return [...variants];
}

function containsProhibitedForm(
  value: string,
  forbiddenPaths: readonly string[],
  options: { readonly serializedJson?: boolean } = {},
): boolean {
  for (const variant of decodeVariants(value)) {
    if (variant.includes('blob:')) return true;
    if (/file:/i.test(variant)) return true;
    if (DRIVE_PREFIX.test(variant)) return true;
    // JSON.stringify escapes every ordinary single backslash as `\\`. The
    // recursive value scan above has already rejected a real UNC `\\` value,
    // so applying the raw-value UNC regex to serialized JSON would turn any
    // legitimate single backslash into a false positive.
    if (options.serializedJson !== true && UNC_BACKSLASH.test(variant)) return true;
    if (UNC_PREFIX.test(variant)) return true;
    if (POSIX_ABSOLUTE_ROOT.test(variant)) return true;
    for (const forbidden of forbiddenPaths) {
      if (forbidden.length > 0 && variant.includes(forbidden)) return true;
    }
  }
  return false;
}

function normalizeForbiddenRoots(forbiddenPaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const entry of forbiddenPaths) {
    if (entry.length === 0) continue;
    roots.add(entry);
    roots.add(entry.toLowerCase());
    try {
      roots.add(path.normalize(entry));
    } catch {
      // Leave the raw value in place.
    }
  }
  return [...roots];
}

interface VisitContext {
  forbiddenPaths: readonly string[];
  seen: WeakSet<object>;
}

function reject(code: RedactionFailureCode, trail: string): never {
  throw new RedactionRejectedError({ code, trail });
}

function visit(value: unknown, trail: string, context: VisitContext): void {
  switch (typeof value) {
    case 'string':
      if (containsProhibitedForm(value, context.forbiddenPaths)) {
        reject('REDACTION_PROHIBITED_VALUE', trail);
      }
      return;
    case 'number':
      if (!Number.isFinite(value)) reject('REDACTION_NOT_PLAIN_JSON', trail);
      return;
    case 'boolean':
      return;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      reject('REDACTION_NOT_PLAIN_JSON', trail);
      return;
    case 'object':
      visitObject(value, trail, context);
      return;
    default:
      reject('REDACTION_NOT_PLAIN_JSON', trail);
  }
}

function visitObject(value: object | null, trail: string, context: VisitContext): void {
  if (value === null) return;

  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject('REDACTION_NOT_PLAIN_JSON', trail);
  }

  if (Array.isArray(value)) {
    if (context.seen.has(value)) reject('REDACTION_NOT_PLAIN_JSON', `${trail}<cycle>`);
    context.seen.add(value);
    const ownKeys = Object.keys(value);
    if (ownKeys.length !== value.length || ownKeys.some((key) => !/^\d+$/.test(key))) {
      reject('REDACTION_NOT_PLAIN_JSON', `${trail}<sparse>`);
    }
    for (let index = 0; index < value.length; index += 1) {
      visit(value[index], `${trail}[${index}]`, context);
    }
    context.seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    reject('REDACTION_NOT_PLAIN_JSON', `${trail}<non-plain>`);
  }
  if (context.seen.has(value)) reject('REDACTION_NOT_PLAIN_JSON', `${trail}<cycle>`);
  context.seen.add(value);

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const segment = keySegment(key, index + 1);
    if (containsProhibitedForm(key, context.forbiddenPaths)) {
      reject('REDACTION_PROHIBITED_VALUE', `${trail}${segment}`);
    }
    visit(record[key], `${trail}${segment}`, context);
  }
  context.seen.delete(value);
}

/**
 * Validate and scan a plain JSON data graph. Throws a
 * {@link RedactionRejectedError} carrying only a fixed code and a non-sensitive
 * structural trail.
 */
export function assertPublicRecordSafe(value: unknown, options: GuardOptions = {}): void {
  const context: VisitContext = {
    forbiddenPaths: normalizeForbiddenRoots(options.forbiddenPaths ?? []),
    seen: new WeakSet<object>(),
  };
  visit(value, 'record', context);
}

/**
 * Serialize an accepted plain object, then scan the exact bytes that will be
 * written before returning them. Never returns a serialization that leaks.
 */
export function serializePublicRecord(value: unknown, options: GuardOptions = {}): string {
  assertPublicRecordSafe(value, options);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    reject('REDACTION_NOT_PLAIN_JSON', 'record<serialized-bytes>');
  }
  const context: VisitContext = {
    forbiddenPaths: normalizeForbiddenRoots(options.forbiddenPaths ?? []),
    seen: new WeakSet<object>(),
  };
  if (containsProhibitedForm(serialized, context.forbiddenPaths, { serializedJson: true })) {
    reject('REDACTION_PROHIBITED_VALUE', 'record<serialized-bytes>');
  }
  return serialized;
}

export function isRedactionRejected(error: unknown): error is RedactionRejectedError {
  return error instanceof RedactionRejectedError;
}

/**
 * True when a single text carries a prohibited value. Shared with the safe
 * diagnostic projector so diagnostics can be redacted before record
 * construction while the recursive guard remains the complete backstop.
 */
export function textContainsProhibitedValue(
  text: string,
  forbiddenPaths: readonly string[] = [],
): boolean {
  return containsProhibitedForm(text, normalizeForbiddenRoots(forbiddenPaths));
}
