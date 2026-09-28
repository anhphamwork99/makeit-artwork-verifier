import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CURSOR_DISCRIMINANT_MARKER,
  DOCUMENT_ANCHOR_SYMBOL_KEY,
  GENERATED_VECTOR_AUTHORITY_MARKER,
  GENERATED_VECTOR_PROJECTION_METHOD_MARKER,
  RASTER_SCHEMA_DISCRIMINANT_MARKER,
  evaluateProductionAbsence,
  evaluateProductionBrowserAbsence,
  isScannedArtifact,
  OBSERVATION_GLOBAL_MARKER,
  PRODUCTION_ABSENCE_MARKERS,
  PRODUCTION_ABSENCE_ROUTE,
  PRODUCTION_ARTIFACT_SCAN_SCHEMA_VERSION,
  scanArtifactContent,
  seamRequestPaths,
  SETUP_ANCHOR_SYMBOL_KEY,
  SETUP_BROKER_SYMBOL_KEY,
  SETUP_GLOBAL_MARKER,
  SIGNAL_ANCHOR_SYMBOL_KEY,
  type ProductionBrowserObservation,
} from '../../src/contracts/production-absence';
import { scanProductionArtifacts } from '../../src/runtime/static-scan';

/**
 * Production seam-absence contract suite (specification 16 Gate C; TS-3).
 *
 * The negative controls are the point of this suite: an absence predicate that
 * cannot fail is not evidence. Every test below that claims "clean" is paired
 * with an injected-marker test that must report dirty, using the exact same
 * scanner and evaluator the live production proof runs.
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-artwork-absence-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cleanObservation(
  overrides: Partial<ProductionBrowserObservation> = {},
): ProductionBrowserObservation {
  return {
    attempt: 'initial',
    httpStatus: 200,
    finalUrl: `http://127.0.0.1:41234${PRODUCTION_ABSENCE_ROUTE}`,
    title: 'Editor - Artwork',
    observationGlobalType: 'undefined',
    setupGlobalType: 'undefined',
    brokerSlotPresent: false,
    setupAnchorSlotPresent: false,
    documentAnchorSlotPresent: false,
    signalAnchorSlotPresent: false,
    requestedPaths: [
      'http://127.0.0.1:41234/artwork/editor',
      'http://127.0.0.1:41234/_next/static/chunks/a.js',
    ],
    ...overrides,
  };
}

describe('production absence marker vocabulary', () => {
  it('declares every marker category with unique values', () => {
    const categories = new Set(PRODUCTION_ABSENCE_MARKERS.map((marker) => marker.category));
    expect([...categories].sort()).toEqual([
      'global',
      'module-path',
      'setup-discriminant',
      'signal-discriminant',
      'symbol-key',
    ]);

    const values = PRODUCTION_ABSENCE_MARKERS.map((marker) => marker.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(OBSERVATION_GLOBAL_MARKER);
    expect(values).toContain(SETUP_GLOBAL_MARKER);
    expect(values).toContain(SETUP_BROKER_SYMBOL_KEY);
    expect(values).toContain(SETUP_ANCHOR_SYMBOL_KEY);
    expect(values).toContain(DOCUMENT_ANCHOR_SYMBOL_KEY);
    expect(values).toContain(SIGNAL_ANCHOR_SYMBOL_KEY);
    expect(values).toContain(CURSOR_DISCRIMINANT_MARKER);
    expect(values).toContain(RASTER_SCHEMA_DISCRIMINANT_MARKER);
    expect(values).toContain(GENERATED_VECTOR_AUTHORITY_MARKER);
    expect(values).toContain(GENERATED_VECTOR_PROJECTION_METHOD_MARKER);
    expect(values).toContain('observationCursor');
    // ADR 0021 N9: the normalized-meaning seam markers are closed vocabulary.
    expect(values).toContain('verification/normalizedMeaning');
    expect(values).toContain('verification/normalizedMeaningCore');
    expect(values).toContain('verification/normalizedMeaningResponse');
    expect(values).toContain('artwork-product-meaning-v1');
    expect(values).toContain('NORMALIZED_MEANING_UNUSABLE');
    // No marker may be a generic word that could coincide with unrelated output.
    expect(values).not.toContain('cursor');
    expect(values).not.toContain('waitForChange');
    expect(values).not.toContain('change');
  });

  it('detects each declared marker in artifact content', () => {
    for (const marker of PRODUCTION_ABSENCE_MARKERS) {
      const hits = scanArtifactContent('static/chunks/x.js', `prefix ${marker.value} suffix`);
      expect(hits.map((hit) => hit.marker)).toContain(marker.value);
    }
  });

  it('detects the ADR 0021 normalized-meaning markers and seam chunk requests', () => {
    for (const marker of [
      'verification/normalizedMeaning',
      'verification/normalizedMeaningCore',
      'verification/normalizedMeaningResponse',
      'artwork-product-meaning-v1',
      'NORMALIZED_MEANING_UNUSABLE',
    ]) {
      const hits = scanArtifactContent('static/chunks/x.js', `prefix ${marker} suffix`);
      expect(hits.map((hit) => hit.marker)).toContain(marker);
    }
    expect(
      seamRequestPaths([
        '/_next/static/chunks/src_lib_artwork_verification_normalizedMeaningCore_ts.js',
      ]),
    ).toHaveLength(1);
    expect(seamRequestPaths(['/_next/static/chunks/x.js'])).toEqual([]);
  });

  it('classifies scanned artifact extensions without ever scanning a source map', () => {
    expect(isScannedArtifact('static/chunks/a.js')).toBe(true);
    expect(isScannedArtifact('server/chunks/x.mjs')).toBe(true);
    expect(isScannedArtifact('app-build-manifest.json')).toBe(true);
    expect(isScannedArtifact('static/chunks/a.js.map')).toBe(false);
    expect(isScannedArtifact('static/media/font.woff2')).toBe(false);
  });
});

describe('emitted-artifact static scan', () => {
  it('reports a clean tree when no executable artifact reaches a seam marker', () => {
    const distDir = tempDir();
    mkdirSync(path.join(distDir, 'static', 'chunks'), { recursive: true });
    writeFileSync(path.join(distDir, 'static', 'chunks', 'a.js'), 'const x = 1;\n');
    writeFileSync(path.join(distDir, 'BUILD_ID'), 'abc\n');
    writeFileSync(path.join(distDir, 'app-build-manifest.json'), '{"pages":{}}\n');

    const scan = scanProductionArtifacts({ distDir });

    expect(scan.schemaVersion).toBe(PRODUCTION_ARTIFACT_SCAN_SCHEMA_VERSION);
    expect(scan.clean).toBe(true);
    expect(scan.hits).toEqual([]);
    // Non-vacuous: the scanner actually read the emitted artifacts.
    expect(scan.scannedFiles).toBeGreaterThanOrEqual(2);
  });

  it('NEGATIVE CONTROL: fails when an emitted client chunk reaches a seam global', () => {
    const distDir = tempDir();
    mkdirSync(path.join(distDir, 'static', 'chunks'), { recursive: true });
    writeFileSync(path.join(distDir, 'static', 'chunks', 'clean.js'), 'const x = 1;\n');
    // The injected violation: exactly what a non-tree-shaken bridge chunk would
    // contain.
    writeFileSync(
      path.join(distDir, 'static', 'chunks', 'leak.js'),
      `window.${OBSERVATION_GLOBAL_MARKER} = {};\n`,
    );

    const scan = scanProductionArtifacts({ distDir });

    expect(scan.clean).toBe(false);
    const leakHits = scan.hits.filter((hit) => hit.relativePath.endsWith('leak.js'));
    expect(leakHits.map((hit) => hit.marker)).toContain(OBSERVATION_GLOBAL_MARKER);
    // The clean sibling is not falsely flagged.
    expect(scan.hits.some((hit) => hit.relativePath.endsWith('clean.js'))).toBe(false);
  });

  it('NEGATIVE CONTROL: fails when a server chunk reaches a setup Symbol slot', () => {
    const distDir = tempDir();
    mkdirSync(path.join(distDir, 'server', 'chunks'), { recursive: true });
    writeFileSync(
      path.join(distDir, 'server', 'chunks', 'x.js'),
      `Object.defineProperty(Symbol.for(${JSON.stringify(SETUP_BROKER_SYMBOL_KEY)}));\n`,
    );

    const scan = scanProductionArtifacts({ distDir });

    expect(scan.clean).toBe(false);
    expect(scan.hits.map((hit) => hit.marker)).toContain(SETUP_BROKER_SYMBOL_KEY);
  });

  it('NEGATIVE CONTROL: fails when a manifest references a seam module path', () => {
    const distDir = tempDir();
    writeFileSync(
      path.join(distDir, 'app-build-manifest.json'),
      '{"chunks":["_next/static/chunks/artworkSetupBoundary.js"]}\n',
    );

    const scan = scanProductionArtifacts({ distDir });

    expect(scan.clean).toBe(false);
    expect(scan.hits.map((hit) => hit.marker)).toContain('artworkSetupBoundary');
  });

  it('is specific: a benign product marker never trips the scanner', () => {
    const distDir = tempDir();
    mkdirSync(path.join(distDir, 'static'), { recursive: true });
    writeFileSync(
      path.join(distDir, 'static', 'a.js'),
      'const ARTWORK_LAYER_REGISTRY = {}; const MAKEIT = "brand";\n',
    );

    const scan = scanProductionArtifacts({ distDir });

    expect(scan.clean).toBe(true);
  });

  it('skips build caches and source maps so only reachable output can fail the scan', () => {
    const distDir = tempDir();
    mkdirSync(path.join(distDir, 'cache', 'webpack'), { recursive: true });
    writeFileSync(
      path.join(distDir, 'cache', 'webpack', 'stale.js'),
      `window.${SETUP_GLOBAL_MARKER} = {};\n`,
    );
    mkdirSync(path.join(distDir, 'static'), { recursive: true });
    writeFileSync(
      path.join(distDir, 'static', 'a.js.map'),
      JSON.stringify({ sourcesContent: [`window.${OBSERVATION_GLOBAL_MARKER}`] }),
    );

    const scan = scanProductionArtifacts({ distDir });

    expect(scan.clean).toBe(true);
    expect(scan.skipped.directories).toContain('cache');
  });
});

describe('browser absence evaluator', () => {
  it('accepts a 200 production document with no globals, slots, or seam requests', () => {
    expect(evaluateProductionBrowserAbsence(cleanObservation())).toEqual({
      clean: true,
      violations: [],
    });
  });

  it('NEGATIVE CONTROL: fails when the observation global is present', () => {
    const verdict = evaluateProductionBrowserAbsence(
      cleanObservation({ observationGlobalType: 'object' }),
    );
    expect(verdict.clean).toBe(false);
    expect(verdict.violations).toContain('initial:observation-global:object');
  });

  it('NEGATIVE CONTROL: fails when the setup global is present', () => {
    const verdict = evaluateProductionBrowserAbsence(
      cleanObservation({ setupGlobalType: 'object' }),
    );
    expect(verdict.violations).toContain('initial:setup-global:object');
  });

  it('NEGATIVE CONTROL: fails for each present registered-Symbol slot', () => {
    expect(
      evaluateProductionBrowserAbsence(cleanObservation({ brokerSlotPresent: true })).violations,
    ).toContain(`initial:symbol-slot:${SETUP_BROKER_SYMBOL_KEY}`);
    expect(
      evaluateProductionBrowserAbsence(cleanObservation({ setupAnchorSlotPresent: true }))
        .violations,
    ).toContain(`initial:symbol-slot:${SETUP_ANCHOR_SYMBOL_KEY}`);
    expect(
      evaluateProductionBrowserAbsence(cleanObservation({ documentAnchorSlotPresent: true }))
        .violations,
    ).toContain(`initial:symbol-slot:${DOCUMENT_ANCHOR_SYMBOL_KEY}`);
    expect(
      evaluateProductionBrowserAbsence(cleanObservation({ signalAnchorSlotPresent: true }))
        .violations,
    ).toContain(`initial:symbol-slot:${SIGNAL_ANCHOR_SYMBOL_KEY}`);
  });

  it('NEGATIVE CONTROL: fails when the bridge v3 cursor discriminant ships', () => {
    const distDir = tempDir();
    writeFileSync(
      path.join(distDir, 'chunk.js'),
      `const marker = ${JSON.stringify(CURSOR_DISCRIMINANT_MARKER)};\n`,
    );
    const scan = scanProductionArtifacts({ distDir });
    expect(scan.clean).toBe(false);
    expect(scan.hits.map((hit) => hit.marker)).toContain(CURSOR_DISCRIMINANT_MARKER);
  });

  it('NEGATIVE CONTROL: fails on a login redirect or a non-200 status', () => {
    const redirect = evaluateProductionBrowserAbsence(
      cleanObservation({ finalUrl: 'http://127.0.0.1:41234/login' }),
    );
    expect(redirect.violations).toContain('initial:final-url:http://127.0.0.1:41234/login');

    const unauthorised = evaluateProductionBrowserAbsence(cleanObservation({ httpStatus: 401 }));
    expect(unauthorised.violations).toContain('initial:http-status:401');
  });

  it('NEGATIVE CONTROL: fails when a seam module chunk is requested', () => {
    const verdict = evaluateProductionBrowserAbsence(
      cleanObservation({
        requestedPaths: ['http://127.0.0.1:41234/_next/static/chunks/artworkVerificationBridge.js'],
      }),
    );
    expect(verdict.clean).toBe(false);
    expect(
      verdict.violations.some((violation) => violation.startsWith('initial:seam-request:')),
    ).toBe(true);
    expect(seamRequestPaths(['/_next/static/chunks/x.js'])).toEqual([]);
  });
});

describe('combined production absence proof', () => {
  const cleanScan = { clean: true as const, hits: [] };

  it('requires both a clean scan and both a clean initial load and reload', () => {
    const verdict = evaluateProductionAbsence({
      scan: cleanScan,
      observations: [
        cleanObservation({ attempt: 'initial' }),
        cleanObservation({ attempt: 'reload' }),
      ],
    });
    expect(verdict).toEqual({ clean: true, violations: [] });
  });

  it('NEGATIVE CONTROL: a dirty scan fails even when both browser loads look clean', () => {
    const verdict = evaluateProductionAbsence({
      scan: {
        clean: false,
        hits: [
          {
            relativePath: 'static/chunks/leak.js',
            category: 'global',
            marker: SETUP_GLOBAL_MARKER,
          },
        ],
      },
      observations: [
        cleanObservation({ attempt: 'initial' }),
        cleanObservation({ attempt: 'reload' }),
      ],
    });
    expect(verdict.clean).toBe(false);
    expect(
      verdict.violations.some((violation) =>
        violation.includes(`artifact:global:${SETUP_GLOBAL_MARKER}`),
      ),
    ).toBe(true);
  });

  it('NEGATIVE CONTROL: a clean initial load cannot rescue a dirty reload', () => {
    const verdict = evaluateProductionAbsence({
      scan: cleanScan,
      observations: [
        cleanObservation({ attempt: 'initial' }),
        cleanObservation({ attempt: 'reload', observationGlobalType: 'object' }),
      ],
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.violations).toContain('reload:observation-global:object');
  });

  it('NEGATIVE CONTROL: a missing reload observation is itself a violation', () => {
    const verdict = evaluateProductionAbsence({
      scan: cleanScan,
      observations: [cleanObservation({ attempt: 'initial' })],
    });
    expect(verdict.violations).toContain('browser:missing-reload-observation');
  });
});
