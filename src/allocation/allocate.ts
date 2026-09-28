import { existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';

import type { RunAllocation, RunAllocationResult, RunOwnershipRecord } from '../contracts/runtime';
import type { AllocationFailureReason } from '../contracts/discriminants';
import { RUN_OWNERSHIP_RECORD_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  DEFAULT_ENVIRONMENT_CELL_ID,
  EnvironmentCatalogueError,
  loadEnvironmentCatalogue,
} from '../runtime/environment';
import {
  isSafeRunId,
  repoRelativeDistDir,
  resolveRepoRoot,
  resolveSkillRoot,
} from '../runtime/paths';
import { resolveEvidenceRoot } from '../runtime/evidence-root';
import { resolveAppRoot } from '../runtime/product-meaning-provider';
import {
  evidenceRootFor,
  expectedDistDirFor,
  isProcessGroupAlive,
  ownershipRecordIsVerifiable,
  ownershipRecordPathFor,
  readOwnershipRecord,
  scratchRootFor,
  writeOwnershipRecord,
} from './lease';
import {
  holdRunPortReservation,
  type PortReservationResult,
  releaseRunPortReservation,
  reserveLoopbackPort,
} from './port-reservation';

/**
 * Enforceable exclusive run resource allocation (specification 10, Gate D).
 *
 * Allocation happens before any launch. Every resource is either derived from
 * the immutable run id (namespaced `distDir`, scratch root, route/storage
 * namespace, evidence root) or reserved from the operating system (loopback
 * port). An external allocation failure is `ENVIRONMENT_FAILURE` before launch;
 * an unknown, non-empty, or live-owned collision is refused without ever
 * touching, killing, or deleting the current owner.
 */

export interface AllocateRunInput {
  runId: string;
  environmentCellId?: string;
  /**
   * Explicit, validated application root (ADR 0118). When supplied it becomes
   * the allocation's `repoRoot` and the base for the owned Next.js `distDir`, so
   * the owned launch runs against the supplied application rather than the
   * toolkit checkout. Diagnostic preflight always supplies it; other callers
   * that predate the standalone toolkit keep the legacy repository-root
   * resolution. An unverifiable root fails closed before any resource is
   * reserved.
   */
  appRoot?: string;
  /** Test/diagnostic override: reserve exactly this loopback port. */
  requestedPort?: number;
  /** Test/diagnostic override: skill root containing the environment catalogue. */
  rootDir?: string;
  /** Test/diagnostic override: persist the ownership record through this writer. */
  recordWriter?: (record: RunOwnershipRecord) => void;
}

/**
 * Reserves and holds one loopback port for a run. The default implementation
 * keeps a real listening socket until launch handoff or cleanup; a reservation
 * failure is an external allocation failure, never a harness-contract failure.
 */
export type PortReserver = (requestedPort: number | null) => Promise<PortReservationResult>;

/**
 * External allocation failures are `ENVIRONMENT_FAILURE` before launch; an
 * invalid contract or an unknown/live-owned collision is `HARNESS_BLOCKED`.
 */
export function allocationFailureCliStatus(
  reason: AllocationFailureReason,
): 'ENVIRONMENT_FAILURE' | 'HARNESS_BLOCKED' {
  switch (reason) {
    case 'ENVIRONMENT_CATALOGUE_INVALID':
    case 'ENVIRONMENT_CELL_UNKNOWN':
    case 'PORT_INVALID':
    case 'PORT_UNAVAILABLE':
      return 'ENVIRONMENT_FAILURE';
    default:
      return 'HARNESS_BLOCKED';
  }
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Resolve the run's owned application repository root from the explicit input.
 *
 * The app root is never inferred from the toolkit/skill location and an
 * unusable explicit root fails closed before any catalogue, port, or filesystem
 * lease is touched. Absent input preserves the legacy toolkit-root behavior for
 * callers that predate the standalone app-root contract.
 */
function resolveAllocationRepositoryRoot(
  appRoot: string | undefined,
): { ok: true; root: string } | { ok: false; detail: string } {
  if (appRoot === undefined) {
    return { ok: true, root: resolveRepoRoot() };
  }
  const resolved = resolveAppRoot(appRoot);
  if (!resolved.ok) return { ok: false, detail: resolved.detail };
  return { ok: true, root: resolved.appRoot };
}

export async function allocateRun(
  input: AllocateRunInput,
  reservePort: PortReserver = reserveLoopbackPort,
): Promise<RunAllocationResult> {
  const { runId } = input;
  if (!isSafeRunId(runId)) {
    return {
      ok: false,
      reason: 'RUN_ID_INVALID',
      detail: `Run id must be a single safe path segment: ${JSON.stringify(runId)}`,
    };
  }

  // The optional adapter-owned evidence root is validated before any resource
  // is reserved or created: an invalid/relative/symlink value refuses as
  // `EVIDENCE_ROOT_INVALID` (HARNESS_BLOCKED) with no port, scratch lease, build
  // output, or evidence artifact. An unset variable keeps the toolkit default.
  const evidenceResolution = resolveEvidenceRoot();
  if (!evidenceResolution.ok) {
    return { ok: false, reason: 'EVIDENCE_ROOT_INVALID', detail: evidenceResolution.problem };
  }

  const repoRoot = resolveAllocationRepositoryRoot(input.appRoot);
  if (!repoRoot.ok) {
    return { ok: false, reason: 'APP_ROOT_INVALID', detail: repoRoot.detail };
  }
  const skillRoot = resolveSkillRoot();
  const scratchRoot = scratchRootFor(runId);
  const evidenceRoot = evidenceRootFor(runId);
  const distDir = expectedDistDirFor(runId, repoRoot.root);
  const relativeDistDir = repoRelativeDistDir(runId);

  let environmentCellId: string;
  try {
    const catalogue = loadEnvironmentCatalogue(
      input.rootDir === undefined ? {} : { rootDir: input.rootDir },
    );
    const wanted = input.environmentCellId ?? DEFAULT_ENVIRONMENT_CELL_ID;
    const cell = catalogue.cells.find((entry) => entry.cellId === wanted);
    if (!cell) {
      return {
        ok: false,
        reason: 'ENVIRONMENT_CELL_UNKNOWN',
        detail: `Environment cell "${wanted}" is not declared in the catalogue.`,
      };
    }
    environmentCellId = cell.cellId;
  } catch (error) {
    if (error instanceof EnvironmentCatalogueError) {
      return { ok: false, reason: 'ENVIRONMENT_CATALOGUE_INVALID', detail: error.message };
    }
    throw error;
  }

  // A live owner of this exact run id must be cleaned up, never attached to.
  const existing = readOwnershipRecord(runId);
  const liveOwned =
    ownershipRecordIsVerifiable(existing, repoRoot.root) &&
    existing?.state === 'launched' &&
    existing.processGroupId !== null &&
    isProcessGroupAlive(existing.processGroupId);

  if (existsSync(scratchRoot)) {
    return {
      ok: false,
      reason: 'SCRATCH_ROOT_OCCUPIED',
      detail: liveOwned
        ? `Run ${runId} is still live-owned (process group ${existing?.processGroupId}). Run cleanup first.`
        : `Run scratch root already exists for run id ${runId} (${ownershipRecordPathFor(runId)}). Run cleanup first.`,
    };
  }

  if (existsSync(evidenceRoot)) {
    return {
      ok: false,
      reason: 'EVIDENCE_ROOT_OCCUPIED',
      detail: `Evidence already exists for run id ${runId}. Choose a new run id; evidence is never overwritten.`,
    };
  }

  if (existsSync(distDir)) {
    return {
      ok: false,
      reason: 'DIST_DIR_OCCUPIED',
      detail: `Owned distDir ${relativeDistDir} already exists and is not bound to a clean allocation. Refusing to attach to or delete it.`,
    };
  }

  if (input.requestedPort !== undefined) {
    if (
      !Number.isInteger(input.requestedPort) ||
      input.requestedPort <= 0 ||
      input.requestedPort > 65_535
    ) {
      return {
        ok: false,
        reason: 'PORT_INVALID',
        detail: `Invalid requested port: ${String(input.requestedPort)}`,
      };
    }
  }

  // The reservation is a real held listener, not a probe: it stays open in this
  // process until the launch handoff or until this allocation (or a later
  // cleanup) releases it.
  const reserved = await reservePort(input.requestedPort ?? null);
  if (!reserved.ok) {
    return {
      ok: false,
      reason: 'PORT_UNAVAILABLE',
      detail:
        input.requestedPort === undefined
          ? `No free loopback port could be reserved from the operating system. ${reserved.detail}`
          : `Requested loopback port ${input.requestedPort} is not available. ${reserved.detail}`,
    };
  }
  const port = reserved.reservation.port;
  holdRunPortReservation(runId, reserved.reservation);

  // The filesystem is the lease: a non-recursive mkdir fails with EEXIST rather
  // than attaching to an owner. This closes the cross-process race between the
  // existence check above and record creation.
  try {
    mkdirSync(scratchRoot);
  } catch (error) {
    await releaseRunPortReservation(runId);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        ok: false,
        reason: 'SCRATCH_ROOT_OCCUPIED',
        detail: `Owned scratch root is already leased for run id ${runId}. Run cleanup first.`,
      };
    }
    return {
      ok: false,
      reason: 'SCRATCH_ROOT_OCCUPIED',
      detail: `Owned scratch root could not be created for run id ${runId}: ${(error as Error).message}`,
    };
  }

  const now = new Date().toISOString();
  const allocation: RunAllocation = {
    runId,
    repoRoot: repoRoot.root,
    skillRoot,
    repoRelativeDistDir: relativeDistDir,
    distDir,
    scratchRoot,
    evidenceRoot,
    routeNamespace: `verify:${runId}:routes`,
    storageNamespace: `verify:${runId}:storage`,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    environmentCellId,
  };

  const record: RunOwnershipRecord = {
    schemaVersion: RUN_OWNERSHIP_RECORD_SCHEMA_VERSION,
    owner: 'verify-artwork-editor',
    state: 'allocated',
    createdAt: now,
    updatedAt: now,
    processPid: null,
    processGroupId: null,
    ownedCommand: null,
    serverLogPath: `${evidenceRoot}/server.log`,
    repoConfigSnapshot: null,
    activeCase: null,
    ...allocation,
  };

  const recordError = persistOwnershipRecord(record, input.recordWriter, runId);
  if (recordError !== null) {
    return { ok: false, reason: 'OWNERSHIP_RECORD_INVALID', detail: recordError };
  }

  return { ok: true, allocation };
}

/**
 * Persists the ownership record and, on any failure, releases the run's port
 * reservation and removes the scratch lease this allocation just created so a
 * failed allocation never leaves owned state behind. Returns an error detail
 * instead of throwing.
 */
function persistOwnershipRecord(
  record: RunOwnershipRecord,
  writer: ((record: RunOwnershipRecord) => void) | undefined,
  runId: string,
): string | null {
  const persist = writer ?? writeOwnershipRecord;
  try {
    persist(record);
    return null;
  } catch (error) {
    void releaseRunPortReservation(runId);
    rmSync(record.scratchRoot, { recursive: true, force: true });
    return `Owned ownership record could not be written for run id ${runId}: ${(error as Error).message}`;
  }
}
