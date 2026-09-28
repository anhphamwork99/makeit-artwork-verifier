import net from 'node:net';

/**
 * Run-scoped loopback port reservation (specification 10, Gate D).
 *
 * A run must own exactly one loopback port from allocation until launch
 * handoff. Probing a port by opening and immediately closing a socket proves
 * nothing: the port is released during allocation, long before the owned Next
 * process binds it. This module keeps a real listening reservation open in the
 * allocating process instead, so a second allocator cannot take the port while
 * the run still owns it.
 *
 * The reservation is intentionally released at exactly two points:
 *
 * - the launch handoff, immediately before the owned Next process is spawned,
 *   so it can bind the port; and
 * - cleanup or an allocation failure, so a run never leaks the reservation.
 *
 * Residual uncertainty after the handoff release is real and is never claimed
 * away: between the release and the owned process binding the port, an external
 * process could still take it. That residual race is classified as
 * `ENVIRONMENT_FAILURE` (readiness/launch failure) rather than reported as a
 * harness-internal impossibility.
 */

export interface PortReservation {
  port: number;
  /** Idempotent: closing an already-closed reservation still resolves. */
  release(): Promise<void>;
}

export interface PortReservationFailure {
  ok: false;
  detail: string;
}

export type PortReservationResult =
  | { ok: true; reservation: PortReservation }
  | PortReservationFailure;

/**
 * Binds a real loopback listener on `requestedPort` (or an OS-chosen port when
 * `null`) and returns it as a held reservation. The caller owns the release.
 */
export function reserveLoopbackPort(requestedPort: number | null): Promise<PortReservationResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const fail = (detail: string) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // The server never started listening; nothing to close.
      }
      resolve({ ok: false, detail });
    };

    server.once('error', (error) => {
      fail(
        `Loopback port ${requestedPort === null ? '(ephemeral)' : requestedPort} could not be reserved: ${(error as Error).message}`,
      );
    });

    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      if (port === null) {
        fail('Reserved loopback port did not report an address.');
        return;
      }
      settled = true;
      let released = false;
      const reservation: PortReservation = {
        port,
        release: () =>
          new Promise<void>((done) => {
            if (released) {
              done();
              return;
            }
            released = true;
            try {
              server.close(() => done());
            } catch {
              done();
            }
          }),
      };
      resolve({ ok: true, reservation });
    });

    try {
      server.listen(requestedPort === null ? 0 : requestedPort, '127.0.0.1');
    } catch (error) {
      fail(`Loopback port could not be reserved: ${(error as Error).message}`);
    }
  });
}

/**
 * In-process registry of held run reservations. Only the process that allocated
 * the run may hold its reservation; cross-process exclusivity is still enforced
 * by the filesystem scratch lease.
 */
const heldReservations = new Map<string, PortReservation>();

export function holdRunPortReservation(runId: string, reservation: PortReservation): void {
  const existing = heldReservations.get(runId);
  if (existing !== undefined && existing !== reservation) {
    void existing.release();
  }
  heldReservations.set(runId, reservation);
}

export function hasRunPortReservation(runId: string): boolean {
  return heldReservations.has(runId);
}

export function runPortReservationPort(runId: string): number | null {
  return heldReservations.get(runId)?.port ?? null;
}

/** Releases and forgets the run's reservation. Returns whether one was held. */
export async function releaseRunPortReservation(runId: string): Promise<boolean> {
  const reservation = heldReservations.get(runId);
  if (reservation === undefined) return false;
  heldReservations.delete(runId);
  await reservation.release();
  return true;
}

/** Test/teardown helper: releases every reservation held by this process. */
export async function releaseAllRunPortReservations(): Promise<void> {
  const reservations = [...heldReservations.values()];
  heldReservations.clear();
  await Promise.all(reservations.map((reservation) => reservation.release()));
}
