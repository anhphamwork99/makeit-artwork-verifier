/**
 * Generic observation cursor contract (bridge v3; WP5 Slice 5-A).
 *
 * This is the toolkit's structural view of the bridge's document-correlated
 * monotonic observation cursor. It carries only identity and currentness facts —
 * never a product mutation, a store handle, or a renderer object.
 */

export const WAKE_SOURCES = ['store-signal', 'already-advanced', 'poll-fallback', 'none'] as const;
export type WakeSource = (typeof WAKE_SOURCES)[number];

export interface ObservationCursor {
  schemaVersion: number;
  documentId: string;
  documentEpoch: number;
  bridgeVersion: number;
  bridgeGeneration: number;
  revision: number;
}

export type WaitForChangeStatus = 'changed' | 'timeout' | 'invalidated';

export interface WaitForChangeOutcome {
  status: WaitForChangeStatus;
  cursor: ObservationCursor | null;
  /** Present only for `changed`; `store-signal` is reserved for a real signal. */
  wakeSource?: 'store-signal' | 'already-advanced';
  /** Present only for `invalidated`. */
  reason?: string;
  waitedMs: number;
}

/** True when two cursors address the same document, generation and revision. */
export function cursorsEqual(left: ObservationCursor, right: ObservationCursor): boolean {
  return (
    left.documentId === right.documentId &&
    left.documentEpoch === right.documentEpoch &&
    left.bridgeVersion === right.bridgeVersion &&
    left.bridgeGeneration === right.bridgeGeneration &&
    left.revision === right.revision
  );
}

/** Stable, loggable key for one cursor. */
export function cursorKey(cursor: ObservationCursor): string {
  return `${cursor.documentId}:${cursor.documentEpoch}:${cursor.bridgeVersion}:${cursor.bridgeGeneration}:${cursor.revision}`;
}
