import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTWORK_SETUP_ANCHOR_KEY,
  ARTWORK_SETUP_BOUNDARY_VERSION,
  ARTWORK_SETUP_BROKER_KEY,
  ARTWORK_SETUP_GLOBAL_NAME,
  ARTWORK_SETUP_REFUSAL_CODES,
  ARTWORK_SETUP_ROUTE,
  ARTWORK_SETUP_SCOPE_DIMENSIONS as PRODUCT_SCOPE_DIMENSIONS,
  type ArtworkSetupSurface,
  installArtworkSetupBoundary,
  listArtworkSetupConstructors,
} from '@/lib/artwork/verification/artworkSetupBoundary';

import {
  buildSetupCapabilityDeliveryScript,
  buildSetupConstructorInvocationScript,
  buildSetupSealRecordScript,
  buildSetupStatusScript,
  buildSetupTransportScanScript,
  createSetupAuthorization,
} from '../../src/browser/seam';
import { DIAGNOSTIC_SEVERITY, diagnosticSeverity } from '../../src/contracts/diagnostics';
import { EVIDENCE_ROLES } from '../../src/contracts/discriminants';
import {
  OBSERVATION_GLOBAL_NAME,
  SETUP_AUTHORIZATION_STATES,
  SETUP_AUTHORIZATION_TOKEN_PATTERN,
  SETUP_BOUNDARY_STATES,
  SETUP_BROKER_KEY_DESCRIPTION,
  SETUP_CONSTRUCTOR_IDS,
  SETUP_CONSTRUCTION_LIFECYCLE_TRACE,
  SETUP_EVIDENCE_ROLE,
  SETUP_FORBIDDEN_TRANSPORT_CHANNELS,
  SETUP_GLOBAL_NAME,
  SETUP_LIFECYCLE_STATES,
  SETUP_REFUSAL_CODES,
  SETUP_ROUTE,
  SETUP_SCOPE_DIMENSIONS,
  SETUP_SEAM_SCHEMA_VERSION,
  type SetupRefusal,
  type SetupSealRecord,
  type SetupStatusFacts,
  isSetupRefusalCode,
  looksLikeSetupAuthorizationToken,
  setupFactsProvideCapabilityEvidence,
  setupRefusalDiagnostic,
  setupSealRecordViolations,
  setupTransportLeaks,
} from '../../src/contracts/seam';

/**
 * Toolkit-side setup-seam contract tests (TS-3, Gate C).
 *
 * Layer 1/3: the versioned seam contract is asserted against the product's own
 * published vocabularies, and the harness delivery script is executed against
 * the real product boundary in jsdom, so the two sides cannot drift apart
 * without a failing test.
 */

type WindowWithSeams = Window & { __MAKEIT_ARTWORK_SETUP__?: ArtworkSetupSurface };
const windowWithSeams = window as unknown as WindowWithSeams;

const ORIGIN = 'http://127.0.0.1:53328';

let cleanup: (() => void) | undefined;

/**
 * Runs a harness page script in the jsdom window realm, exactly as Playwright
 * runs it in a real page. Executing the real scripts is the behavior under test.
 */
function runInPageRealm<T>(script: string): T {
  // biome-ignore lint/security/noGlobalEval: the delivery/read-back scripts are page-realm contracts; running them in the window realm is the assertion.
  return window.eval(script) as T;
}

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  delete windowWithSeams[ARTWORK_SETUP_GLOBAL_NAME];
  delete (window as unknown as Record<symbol, unknown>)[ARTWORK_SETUP_BROKER_KEY];
  // A reload replaces the browser Document, so the Document-scoped lifecycle
  // anchor is dropped between tests exactly as a real navigation would drop it.
  delete (window as unknown as Record<symbol, unknown>)[ARTWORK_SETUP_ANCHOR_KEY];
  process.env.NEXT_PUBLIC_ARTWORK_VERIFICATION = undefined;
});

function token(): string {
  return 'a'.repeat(64);
}

/** A record shaped exactly like the product's seal record, with no secret. */
function sampleSealRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    boundaryVersion: 1,
    outcome: 'constructed',
    route: SETUP_ROUTE,
    origin: ORIGIN,
    authorization: { id: 'a2d0e5f7-0000-4000-8000-000000000000', consumed: true },
    scope: { runId: 'run-1', caseId: 'case-1' },
    document: { documentId: 'doc-1:/artwork/editor', documentEpoch: 1 },
    constructor: {
      id: 'artwork.two-layout-text.v1',
      version: 1,
      fixtureId: 'artwork.fixture.two-layout-text',
      fixtureVersion: 1,
    },
    fingerprints: {
      algorithm: 'fnv1a64',
      content: '0123456789abcdef',
      layoutItems: 'fedcba9876543210',
    },
    environmentFingerprint: '0011223344556677',
    semanticPrecondition: {
      layoutCount: 3,
      layerCount: 2,
      nodeCount: 5,
      activeLayoutId: 'layout-a',
      selectedLayoutIds: [],
    },
    historyBaseline: { pastDepth: 0, futureDepth: 0, baselineClean: true },
    mutationSummary: { constructCalls: 1, hydrateCalls: 1 },
    sealedAt: '2026-09-17T00:00:00.000Z',
    sealedAtEpochMs: 1_789_000_000_000,
  };
}

describe('setup seam contract vocabulary', () => {
  it('is versioned and separate from the observation bridge', () => {
    expect(SETUP_SEAM_SCHEMA_VERSION).toBe(1);
    expect(SETUP_GLOBAL_NAME).toBe(ARTWORK_SETUP_GLOBAL_NAME);
    expect(SETUP_GLOBAL_NAME).toBe('__MAKEIT_ARTWORK_SETUP__');
    expect(SETUP_GLOBAL_NAME).not.toBe(OBSERVATION_GLOBAL_NAME);
    expect(SETUP_ROUTE).toBe(ARTWORK_SETUP_ROUTE);
    expect(SETUP_BROKER_KEY_DESCRIPTION).toBe(String(ARTWORK_SETUP_BROKER_KEY).slice(7, -1));
    expect(SETUP_BOUNDARY_STATES).toEqual(['SETUP_OPEN', 'SETUP_COMPLETE', 'SEALED']);
    expect(SETUP_LIFECYCLE_STATES).toEqual([
      'ALLOCATED',
      'SETUP_OPEN',
      'SETUP_COMPLETE',
      'SEALED',
      'TESTING',
      'OBSERVING',
      'CLEANUP',
    ]);
    expect(SETUP_CONSTRUCTION_LIFECYCLE_TRACE).toEqual(['SETUP_OPEN', 'SETUP_COMPLETE', 'SEALED']);
    expect(SETUP_AUTHORIZATION_STATES).toEqual(['absent', 'available', 'consumed']);
    expect(ARTWORK_SETUP_BOUNDARY_VERSION).toBe(1);
  });

  it('mirrors the product refusal vocabulary exactly, all blocking', () => {
    expect([...SETUP_REFUSAL_CODES].sort()).toEqual([...ARTWORK_SETUP_REFUSAL_CODES].sort());
    expect([...SETUP_SCOPE_DIMENSIONS].sort()).toEqual([...PRODUCT_SCOPE_DIMENSIONS].sort());
    for (const code of SETUP_REFUSAL_CODES) {
      expect(isSetupRefusalCode(code)).toBe(true);
      expect(DIAGNOSTIC_SEVERITY[code]).toBe('blocking');
      expect(diagnosticSeverity(code)).toBe('blocking');
    }
    expect(isSetupRefusalCode('SETUP_NOT_A_CODE')).toBe(false);
  });

  it('mirrors the product constructor registry exactly', () => {
    expect(listArtworkSetupConstructors().map((entry) => entry.id)).toEqual([
      ...SETUP_CONSTRUCTOR_IDS,
    ]);
    expect(listArtworkSetupConstructors()).toEqual([
      {
        id: 'artwork.two-layout-text.v1',
        version: 1,
        fixtureId: 'artwork.fixture.two-layout-text',
        fixtureVersion: 1,
      },
      {
        id: 'artwork.two-layout-text.v2',
        version: 2,
        fixtureId: 'artwork.fixture.two-layout-text',
        fixtureVersion: 2,
      },
      {
        id: 'artwork.two-layout-image.v1',
        version: 1,
        fixtureId: 'artwork.fixture.two-layout-image',
        fixtureVersion: 1,
      },
      {
        id: 'artwork.nested-object.v2',
        version: 2,
        fixtureId: 'artwork.fixture.nested-object',
        fixtureVersion: 2,
      },
      {
        id: 'artwork.nested-object.normalization-negative.v1',
        version: 1,
        fixtureId: 'artwork.fixture.nested-object.normalization-negative',
        fixtureVersion: 1,
      },
    ]);
  });

  it('recognizes the raw capability shape', () => {
    expect(looksLikeSetupAuthorizationToken(token())).toBe(true);
    expect(looksLikeSetupAuthorizationToken('short')).toBe(false);
    expect(SETUP_AUTHORIZATION_TOKEN_PATTERN.test(token())).toBe(true);
  });
});

describe('setup evidence is never capability evidence', () => {
  it('never earns check or coverage credit', () => {
    expect(setupFactsProvideCapabilityEvidence()).toBe(false);
    expect([...EVIDENCE_ROLES]).not.toContain(SETUP_EVIDENCE_ROLE);
    expect(SETUP_EVIDENCE_ROLE).toBe('setup-only');
  });

  it('maps a refusal onto a blocking diagnostic without leaking the capability', () => {
    const refusal: SetupRefusal = {
      ok: false,
      outcome: 'refused',
      code: 'SETUP_SCOPE_MISMATCH',
      detail: 'Setup authorization does not cover the requested document scope.',
      context: { dimension: 'document' },
      mutationApplied: false,
      authorizationConsumed: true,
      lifecycle: 'SEALED',
      at: '2026-09-17T00:00:00.000Z',
    };
    const diagnostic = setupRefusalDiagnostic(refusal, { runId: 'run-1', caseId: 'case-1' });
    expect(diagnostic.code).toBe('SETUP_SCOPE_MISMATCH');
    expect(diagnostic.severity).toBe('blocking');
    expect(diagnostic.detail).toBe(refusal.detail);
    expect(diagnostic.context).toEqual({
      dimension: 'document',
      runId: 'run-1',
      caseId: 'case-1',
      mutationApplied: 'false',
      lifecycle: 'SEALED',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(token());
  });
});

describe('seal record and transport sanitization', () => {
  it('accepts a non-sensitive seal record and rejects sensitive or unknown keys', () => {
    const record = sampleSealRecord();
    expect(setupSealRecordViolations(record)).toEqual([]);
    expect(setupSealRecordViolations(record, token())).toEqual([]);

    expect(setupSealRecordViolations({ ...record, token: token() })).toContain(
      'forbidden-key:token',
    );
    expect(setupSealRecordViolations({ ...record, capability: 'raw' })).toContain(
      'forbidden-key:capability',
    );
    expect(setupSealRecordViolations({ ...record, surpriseKey: 1 })).toContain(
      'unknown-key:surpriseKey',
    );
    expect(setupSealRecordViolations({ ...record, origin: `leak:${token()}` }, token())).toContain(
      'raw-capability-value',
    );
    // A nested forbidden key is caught even when the top-level shape is clean.
    const nestedScope: Record<string, unknown> = {
      ...(record.scope as Record<string, unknown>),
      token: token(),
    };
    expect(setupSealRecordViolations({ ...record, scope: nestedScope }, token())).toContain(
      'raw-capability-value',
    );
  });

  it('scans every forbidden channel for the raw capability', () => {
    const raw = token();
    const clean = {
      cookie: 'session=1',
      environment: 'NEXT_PUBLIC_ARTWORK_VERIFICATION=true',
      evidence: '{}',
      indexedDb: '[]',
      localStorage: 'draft=abc',
      log: 'ready in 800ms',
      query: '?x=1',
      sealRecord: JSON.stringify(sampleSealRecord()),
      sessionStorage: '',
      setupRecord: '{}',
      url: `${ORIGIN}${SETUP_ROUTE}`,
    };
    expect(setupTransportLeaks(clean, raw)).toEqual([]);
    for (const channel of SETUP_FORBIDDEN_TRANSPORT_CHANNELS) {
      expect(setupTransportLeaks({ ...clean, [channel]: `prefix-${raw}` }, raw)).toEqual([channel]);
    }
  });
});

describe('harness delivery scripts', () => {
  it('delivers exactly one non-enumerable Symbol-keyed closure broker', () => {
    const authorization = createSetupAuthorization({
      runId: 'run-1',
      caseId: 'case-1',
      origin: ORIGIN,
      documentId: 'doc-1:/artwork/editor',
    });
    const script = buildSetupCapabilityDeliveryScript(authorization);

    expect(script).toContain(`Symbol.for(${JSON.stringify(SETUP_BROKER_KEY_DESCRIPTION)})`);
    expect(script).toContain('Object.defineProperty');
    expect(script).toContain('enumerable: false');
    expect(script).toContain('configurable: true');
    expect(script).toContain('writable: false');
    expect(script).toContain('let pending =');
    // One-shot: the closure nulls the pending value on take.
    expect(script.match(/take:/g)).toHaveLength(1);
    expect(script.match(/pending = null/g)).toHaveLength(1);
    // The delivery never mutates the setup global and never persists the value.
    expect(script).not.toContain(SETUP_GLOBAL_NAME);
    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('sessionStorage');
    expect(script).not.toContain('document.cookie');
    expect(script).not.toContain('indexedDB');
    expect(script).not.toContain('addInitScript');
  });

  it('invokes the published construct exactly once and reports an absent boundary', () => {
    const script = buildSetupConstructorInvocationScript({
      constructorId: 'artwork.two-layout-text.v1',
      constructorVersion: 1,
      scope: { runId: 'run-1', caseId: 'case-1' },
      inputs: {},
    });
    expect(script.match(/surface\.construct\(/g)).toHaveLength(1);
    expect(script).toContain('setup boundary is not installed');
    expect(script).toContain(JSON.stringify(SETUP_GLOBAL_NAME));
  });

  it('scans the browser channels without writing them', () => {
    const script = buildSetupTransportScanScript();
    for (const channel of [
      'cookie',
      'localStorage',
      'sessionStorage',
      'indexedDb',
      'url',
      'query',
    ]) {
      expect(script).toContain(channel);
    }
    expect(script).not.toContain('.setItem(');
    expect(script).not.toContain('document.cookie =');
  });
});

describe('harness delivery against the real product boundary', () => {
  it('delivers, constructs, seals, and reads back a sanitized seal record', () => {
    process.env.NEXT_PUBLIC_ARTWORK_VERIFICATION = 'true';
    window.history.replaceState({}, '', SETUP_ROUTE);

    cleanup = installArtworkSetupBoundary();
    const surface = windowWithSeams[SETUP_GLOBAL_NAME];
    if (!surface) throw new Error('setup boundary was not installed');

    const status = surface.status();
    const authorization = createSetupAuthorization({
      runId: 'run-1',
      caseId: 'case-1',
      origin: status.environment.origin,
      documentId: status.document.documentId,
    });
    // The harness script runs in the page exactly as Playwright would run it.
    runInPageRealm(buildSetupCapabilityDeliveryScript(authorization));

    const outcome = surface.construct({
      constructorId: 'artwork.two-layout-text.v1',
      constructorVersion: 1,
      scope: { runId: 'run-1', caseId: 'case-1' },
      inputs: {
        artworkWidth: 500,
        artworkHeight: 500,
        layouts: [
          { id: 'layout-a', name: 'Layout A', x: 0, y: 0, text: 'Alpha' },
          { id: 'layout-b', name: 'Layout B', x: 560, y: 0, text: 'Beta' },
        ],
      },
    });
    if (!outcome.ok) throw new Error(`expected a construction, got ${outcome.code}`);
    expect(outcome.outcome).toBe('constructed');
    expect(outcome.lifecycle).toBe('SEALED');

    // Read back through the harness scripts, exactly as the browser proof does.
    const readBackStatus = runInPageRealm<SetupStatusFacts>(buildSetupStatusScript());
    const readBackSeal = runInPageRealm<SetupSealRecord>(buildSetupSealRecordScript());
    expect(readBackStatus.lifecycle).toBe('SEALED');
    expect(readBackStatus.lifecycleTrace).toEqual(['SETUP_OPEN', 'SETUP_COMPLETE', 'SEALED']);
    expect(readBackStatus.authorization).toBe('consumed');
    expect(readBackSeal.authorization.id).toBe(authorization.authorizationId);
    expect(readBackSeal.mutationSummary).toEqual({ constructCalls: 1, hydrateCalls: 1 });
    expect(
      setupSealRecordViolations(
        readBackSeal as unknown as Record<string, unknown>,
        authorization.token,
      ),
    ).toEqual([]);
    expect(JSON.stringify(readBackSeal)).not.toContain(authorization.token);
  });

  it('refuses a capability bound to another document without mutation', () => {
    process.env.NEXT_PUBLIC_ARTWORK_VERIFICATION = 'true';
    window.history.replaceState({}, '', SETUP_ROUTE);

    cleanup = installArtworkSetupBoundary();
    const surface = windowWithSeams[SETUP_GLOBAL_NAME];
    if (!surface) throw new Error('setup boundary was not installed');

    const status = surface.status();
    const authorization = createSetupAuthorization({
      runId: 'run-1',
      caseId: 'case-1',
      origin: status.environment.origin,
      documentId: 'stale-document-id:/artwork/editor',
    });
    runInPageRealm(buildSetupCapabilityDeliveryScript(authorization));

    const stale = surface.construct({
      constructorId: 'artwork.two-layout-text.v1',
      constructorVersion: 1,
      scope: { runId: 'run-1', caseId: 'case-1' },
      inputs: {
        artworkWidth: 500,
        artworkHeight: 500,
        layouts: [
          { id: 'layout-a', name: 'Layout A', x: 0, y: 0, text: 'Alpha' },
          { id: 'layout-b', name: 'Layout B', x: 560, y: 0, text: 'Beta' },
        ],
      },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('expected a refusal');
    expect(stale.code).toBe('SETUP_SCOPE_MISMATCH');
    expect(stale.context.dimension).toBe('document');
    expect(setupRefusalDiagnostic(stale).severity).toBe('blocking');
    expect(surface.sealRecord()).toBeNull();
    // One-shot: the refused attempt ended the SETUP_OPEN phase for this Document.
    expect(surface.status().lifecycle).toBe('SEALED');
  });
});
