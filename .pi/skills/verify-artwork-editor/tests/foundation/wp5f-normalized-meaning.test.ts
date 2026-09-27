/**
 * WP5 Slice 5-F — product-owned normalized meaning (ADR 0019 R5/R6/R7/R15).
 *
 * These tests exercise the pure product seam against the real product
 * serializer (`snapshotToCreateDto`) and the real product restorer
 * (`artworkResponseToSnapshot`). They are the persistence-loss detector: a
 * semantic value the serializer drops must surface as a normalized mismatch
 * rather than being silently projected away.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ArtworkResponseDto, CreateArtworkDto } from '@/lib/api/types.gen';
import { artworkResponseToSnapshot, snapshotToCreateDto } from '@/lib/artwork/artworkSerialization';
import {
  NORMALIZED_MEANING_PROFILE_ID,
  NORMALIZED_MEANING_SCHEMA_VERSION,
  NORMALIZED_MEANING_UNUSABLE_CODE,
  NormalizedMeaningUnusableError,
  canonicalizeNormalizedMeaning,
  extractRawCrosswordSemanticPayload,
  fingerprintNormalizedMeaning,
  normalizeArtworkProductMeaning,
} from '@/lib/artwork/verification/normalizedMeaningCore';
import { normalizeArtworkResponseMeaning } from '@/lib/artwork/verification/normalizedMeaningResponse';
import { createDefaultArtworkCrosswordLayer } from '@/stores/artwork/crosswordLayerSlice';
import { createDefaultArtworkImageLayer } from '@/stores/artwork/imageLayer';
import { createDefaultArtworkTextLayer } from '@/stores/artwork/textLayerSlice';
import type {
  ArtworkEditorSnapshot,
  ArtworkLayoutItem,
  ArtworkPersistedLayer,
} from '@/stores/artworkEditorStore';
import { CANVAS_LAYOUT_ID, DEFAULT_LAYOUT_BACKGROUND } from '@/stores/artworkEditorStore';
import { generateCrosswordLayout } from '@/lib/artwork/crosswordEngine/layout';

const MODULE_PATH = path.resolve(
  process.cwd(),
  'src/lib/artwork/verification/normalizedMeaningCore.ts',
);
const ADAPTER_MODULE_PATH = path.resolve(
  process.cwd(),
  'src/lib/artwork/verification/normalizedMeaningResponse.ts',
);

/** All import statements (including multi-line) with a type-only flag and specifier. */
function importStatements(source: string): { typeOnly: boolean; module: string }[] {
  return [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)].map((match) => ({
    typeOnly: match[1] !== undefined,
    module: match[2] as string,
  }));
}

const CROSSWORD_SEED = 424242;
const CROSSWORD_WORDS = ['MAKEIT', 'CROSSWORD', 'HELLO'];

function canvasLayout(): ArtworkLayoutItem {
  return {
    id: CANVAS_LAYOUT_ID,
    name: 'Canvas',
    xCoordinate: 0,
    yCoordinate: 0,
    width: 0,
    height: 0,
    zCoordinate: 0,
    background: { ...DEFAULT_LAYOUT_BACKGROUND },
    hidden: false,
    locked: false,
    isCanvas: true,
  };
}

function textLayer(overrides: Partial<ArtworkPersistedLayer> = {}): ArtworkPersistedLayer {
  return {
    ...createDefaultArtworkTextLayer({ id: 'text-1', x: 10, y: 20, zCoordinate: 1 }),
    ...overrides,
  } as ArtworkPersistedLayer;
}

function placeholderImageLayer(): ArtworkPersistedLayer {
  return {
    ...createDefaultArtworkImageLayer({
      x: 30,
      y: 40,
      zCoordinate: 2,
      src: 'data:image/png;base64,PLACEHOLDER',
    }),
    name: 'Image',
    config: { placeholder: true, name: 'Placeholder', allowUpload: true },
  } as unknown as ArtworkPersistedLayer;
}

function crosswordLayer(): ArtworkPersistedLayer {
  const layer = createDefaultArtworkCrosswordLayer({ x: 50, y: 60, zCoordinate: 3 });
  return {
    ...layer,
    crossword: {
      ...layer.crossword,
      words: [...CROSSWORD_WORDS],
      generationSeed: CROSSWORD_SEED,
      layout: generateCrosswordLayout(CROSSWORD_WORDS, CROSSWORD_SEED),
    },
  } as unknown as ArtworkPersistedLayer;
}

function objectLayerWithChild(): ArtworkPersistedLayer {
  return {
    id: 'object-1',
    type: 'OBJECT',
    mode: 'object',
    objectRole: 'group',
    name: 'Group',
    xCoordinate: 70,
    yCoordinate: 80,
    width: 50,
    height: 60,
    naturalWidth: 50,
    naturalHeight: 60,
    zCoordinate: 4,
    rotation: 0,
    opacity: 100,
    transform: { flipX: false, flipY: false },
    layers: [textLayer({ id: 'nested-text-1', zCoordinate: 1 })],
  } as unknown as ArtworkPersistedLayer;
}

function baseSnapshot(): ArtworkEditorSnapshot {
  return {
    layoutItems: [
      canvasLayout(),
      {
        id: 'layout-a',
        name: 'Layout Alpha',
        xCoordinate: 100,
        yCoordinate: 120,
        width: 500,
        height: 500,
        zCoordinate: 1,
        background: { ...DEFAULT_LAYOUT_BACKGROUND },
        hidden: false,
        locked: false,
        layers: [textLayer(), placeholderImageLayer(), crosswordLayer(), objectLayerWithChild()],
      },
      {
        id: 'layout-b',
        name: 'Layout Beta',
        xCoordinate: 700,
        yCoordinate: 120,
        width: 500,
        height: 500,
        zCoordinate: 2,
        background: { ...DEFAULT_LAYOUT_BACKGROUND },
        hidden: false,
        locked: false,
        layers: [textLayer({ id: 'text-2', xCoordinate: 200, yCoordinate: 210 })],
      },
    ],
    activeLayoutId: 'layout-a',
    selectedLayoutIds: [],
  };
}

/** Deterministic frontend-only route fulfillment (ADR 0019 R8): ids + metadata only. */
function toGeneratedResponse(payload: CreateArtworkDto): ArtworkResponseDto {
  let layoutId = 1000;
  let layerId = 5000;
  const createdAt = '2026-09-18T00:00:00.000Z';
  return {
    id: 77,
    shopId: 3,
    type: 'ARTWORK',
    name: payload.name,
    renderOrder: 0,
    visible: true,
    locked: false,
    createdAt,
    updatedAt: createdAt,
    layouts: (payload.layouts ?? []).map((layout) => {
      const id = layoutId++;
      return {
        id,
        name: layout.name,
        artworkId: 77,
        createdAt,
        updatedAt: createdAt,
        layers: (layout.layers ?? []).map((layer) => ({
          ...layer,
          id: layerId++,
          ownerType: 'LAYOUT' as const,
          ownerId: id,
          hidden: false,
          locked: false,
          createdAt,
          updatedAt: createdAt,
        })),
      };
    }),
  } as ArtworkResponseDto;
}

function roundtrip(snapshot: ArtworkEditorSnapshot): {
  source: ReturnType<typeof normalizeArtworkProductMeaning>;
  restored: ReturnType<typeof normalizeArtworkResponseMeaning>;
  payload: CreateArtworkDto;
  response: ArtworkResponseDto;
} {
  const payload = snapshotToCreateDto(snapshot, 'Roundtrip Artwork');
  const response = toGeneratedResponse(payload);
  return {
    source: normalizeArtworkProductMeaning(snapshot),
    restored: normalizeArtworkResponseMeaning(response),
    payload,
    response,
  };
}

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (value === null || typeof value !== 'object') return keys;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

function withMutatedLayer(
  mutator: (layer: Record<string, unknown>) => void,
): ArtworkEditorSnapshot {
  const snapshot = baseSnapshot();
  const layout = snapshot.layoutItems[1] as ArtworkLayoutItem;
  mutator((layout.layers as unknown as Record<string, unknown>[])[0] as Record<string, unknown>);
  return snapshot;
}

describe('WP5 Slice 5-F — normalized product meaning module surface', () => {
  it('exposes the versioned profile constants and pure functions (core module smoke)', async () => {
    const module = await import('@/lib/artwork/verification/normalizedMeaningCore');
    expect(NORMALIZED_MEANING_SCHEMA_VERSION).toBe(1);
    expect(NORMALIZED_MEANING_PROFILE_ID).toBe('artwork-product-meaning-v1');
    expect(NORMALIZED_MEANING_UNUSABLE_CODE).toBe('NORMALIZED_MEANING_UNUSABLE');
    for (const name of [
      'normalizeArtworkProductMeaning',
      'canonicalizeNormalizedMeaning',
      'fingerprintNormalizedMeaning',
      'extractRawCrosswordSemanticPayload',
    ] as const) {
      expect(typeof module[name]).toBe('function');
    }
    // The core is the designated Node interface: it must NOT own response
    // normalization (that composes the browser/product restorer, ADR 0021 N1).
    expect('normalizeArtworkResponseMeaning' in module).toBe(false);
  });

  it('core has exactly the approved runtime import and no runtime store/browser/global/network dependency', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    const statements = importStatements(source);

    // The store dependency must be syntactically type-only (ADR 0021 N1.3).
    const storeImports = statements.filter(
      (entry) => entry.module === '@/stores/artworkEditorStore',
    );
    expect(storeImports).toHaveLength(1);
    expect(storeImports[0]?.typeOnly).toBe(true);

    // The only runtime product edge is the import-free constant leaf.
    const runtimeModules = statements
      .filter((entry) => !entry.typeOnly)
      .map((entry) => entry.module);
    expect(runtimeModules).toEqual(['@/lib/artwork/virtualCanvasLayout']);
    expect(
      statements.some((entry) => entry.module.includes('artworkSerialization')),
      'core must not import the serializer',
    ).toBe(false);

    for (const forbidden of [
      'globalThis.',
      'fetch(',
      'getState(',
      '.hydrate(',
      'XMLHttpRequest',
      'localStorage',
      'useArtworkEditorStore.',
      'artworkVerificationBridge',
      'artworkSetupBoundary',
    ]) {
      expect(source.includes(forbidden), `source must not reference ${forbidden}`).toBe(false);
    }
    // `document.`/`window.` must not be dereferenced (the words may appear in prose).
    expect(/\bdocument\s*\.\s*[A-Za-z_$]/.test(source)).toBe(false);
    expect(/\bwindow\s*\.\s*[A-Za-z_$]/.test(source)).toBe(false);

    // Normalizing a frozen snapshot must not mutate it.
    const snapshot = baseSnapshot();
    const before = JSON.stringify(snapshot);
    Object.freeze(snapshot);
    for (const layout of snapshot.layoutItems) Object.freeze(layout);
    normalizeArtworkProductMeaning(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('response adapter composes exactly the core and the real product restorer and copies no projection logic', () => {
    const source = readFileSync(ADAPTER_MODULE_PATH, 'utf8');
    const runtimeModules = importStatements(source)
      .filter((entry) => !entry.typeOnly)
      .map((entry) => entry.module);
    expect(runtimeModules).toEqual([
      '@/lib/artwork/artworkSerialization',
      './normalizedMeaningCore',
    ]);
    expect(source).toContain('artworkResponseToSnapshot');
    expect(source).toContain('normalizeArtworkProductMeaning');
    // No copied private normalizer/canonicalizer/hash helpers.
    for (const forbidden of [
      'DROPPED_KEYS',
      'projectValue',
      'projectLayer',
      'compareSiblings',
      'FNV1A64',
      'crosswordConfigOf',
      'canonicalizeNormalizedMeaning',
      'fingerprintNormalizedMeaning',
      'isVirtualCanvasLayout',
    ]) {
      expect(source.includes(forbidden), `adapter must not copy ${forbidden}`).toBe(false);
    }
  });
});

describe('WP5 Slice 5-F — closed normalized shape', () => {
  it('produces the exact closed top-level key set and virtual-canvas-free layouts', () => {
    const normalized = normalizeArtworkProductMeaning(baseSnapshot());
    expect(Object.keys(normalized).sort()).toEqual(['layouts', 'profileId', 'schemaVersion']);
    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.profileId).toBe(NORMALIZED_MEANING_PROFILE_ID);
    expect(normalized.layouts).toHaveLength(2);
    for (const layout of normalized.layouts) {
      expect(Object.keys(layout).sort()).toEqual([
        'background',
        'height',
        'hidden',
        'layers',
        'locked',
        'name',
        'width',
        'xCoordinate',
        'yCoordinate',
        'zCoordinate',
      ]);
    }
  });

  it('keeps the virtual canvas in the raw payload but out of normalized meaning', () => {
    const { payload, source } = roundtrip(baseSnapshot());
    const rawLayoutNames = (payload.layouts ?? []).map((layout) => layout.name);
    expect(rawLayoutNames).toContain('Canvas');
    expect(JSON.stringify(payload)).toContain('isCanvas');
    expect(JSON.stringify(source)).not.toContain('Canvas');
    expect(collectKeys(source).has('isCanvas')).toBe(false);
  });

  it('contains no raw config key anywhere and no volatile id key', () => {
    const { source, restored } = roundtrip(baseSnapshot());
    for (const normalized of [source, restored]) {
      const keys = collectKeys(normalized);
      expect(keys.has('config')).toBe(false);
      expect(keys.has('serverId')).toBe(false);
      expect(keys.has('assetId')).toBe(false);
      expect(keys.has('ownerId')).toBe(false);
      expect(keys.has('createdAt')).toBe(false);
      expect(keys.has('updatedAt')).toBe(false);
      // Only a Star Map element id may survive as a semantic role; none here.
      expect(keys.has('id')).toBe(false);
    }
  });

  it('gives snapshot and response normalizers the same closed output shape', () => {
    const { source, restored } = roundtrip(baseSnapshot());
    expect(canonicalizeNormalizedMeaning(restored)).toBe(canonicalizeNormalizedMeaning(source));
    expect(fingerprintNormalizedMeaning(restored)).toBe(fingerprintNormalizedMeaning(source));
  });

  it('is stable under changed volatile client and server ids and timestamps', () => {
    const first = roundtrip(baseSnapshot());
    const second = roundtrip(baseSnapshot());
    // Same semantic content, different deterministic server ids/timestamps.
    second.response = {
      ...second.response,
      id: 999,
      shopId: 12,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      layouts: second.response.layouts?.map((layout, index) => ({
        ...layout,
        id: 9000 + index,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        layers: layout.layers?.map((layer, layerIndex) => ({
          ...layer,
          id: 7000 + layerIndex,
          ownerId: 9000 + index,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        })),
      })),
    };
    const shifted = normalizeArtworkResponseMeaning(second.response);
    expect(canonicalizeNormalizedMeaning(shifted)).toBe(
      canonicalizeNormalizedMeaning(first.restored),
    );
  });

  it('normalizes -0 to 0', () => {
    const snapshot = withMutatedLayer((layer) => {
      layer.xCoordinate = -1 * 0;
    });
    const normalized = normalizeArtworkProductMeaning(snapshot);
    const text = normalized.layouts[0]?.layers.find((layer) => layer.type === 'TEXT');
    expect(text?.xCoordinate).toBe(0);
    expect(Object.is(text?.xCoordinate, -0)).toBe(false);
  });
});

describe('WP5 Slice 5-F — included semantic surface', () => {
  it('includes Text, Image, Crossword, and nested Object meaning', () => {
    const normalized = normalizeArtworkProductMeaning(baseSnapshot());
    const layers = normalized.layouts[0]?.layers ?? [];
    expect(layers.map((layer) => layer.type).sort()).toEqual([
      'CROSSWORD',
      'IMAGE',
      'OBJECT',
      'TEXT',
    ]);

    const text = layers.find((layer) => layer.type === 'TEXT') as Record<string, unknown>;
    expect(text.content).toBeDefined();
    expect(text.font).toBeDefined();
    expect(text.warp).toBeDefined();

    const image = layers.find((layer) => layer.type === 'IMAGE') as Record<string, unknown>;
    expect(image.src).toBe('data:image/png;base64,PLACEHOLDER');
    expect(image.placeholder).toBe(true);
    expect(image.allowUpload).toBe(true);
    expect(image.name).toBe('Placeholder');

    const crossword = layers.find((layer) => layer.type === 'CROSSWORD') as Record<string, unknown>;
    const crosswordConfig = crossword.crossword as Record<string, unknown>;
    expect(crosswordConfig.generationSeed).toBe(CROSSWORD_SEED);
    expect(crosswordConfig.words).toEqual(CROSSWORD_WORDS);
    expect(crosswordConfig.layout).toBeDefined();

    const object = layers.find((layer) => layer.type === 'OBJECT') as {
      layers: Record<string, unknown>[];
    };
    expect(object.layers).toHaveLength(1);
    expect(object.layers[0]?.type).toBe('TEXT');
  });

  it('detects a difference for every included typed semantic field', () => {
    const baseline = fingerprintNormalizedMeaning(normalizeArtworkProductMeaning(baseSnapshot()));
    const mutations: Array<[string, (layer: Record<string, unknown>) => void]> = [
      ['xCoordinate', (layer) => (layer.xCoordinate = 999)],
      ['zCoordinate', (layer) => (layer.zCoordinate = 42)],
      ['rotation', (layer) => (layer.rotation = 15)],
      ['opacity', (layer) => (layer.opacity = 40)],
      ['transform.flipX', (layer) => ((layer.transform as Record<string, unknown>).flipX = true)],
      ['content.text', (layer) => ((layer.content as Record<string, unknown>).text = 'changed')],
      ['font.weight', (layer) => ((layer.font as Record<string, unknown>).weight = 900)],
      ['layout.align', (layer) => ((layer.layout as Record<string, unknown>).align = 'left')],
      ['fill.color', (layer) => ((layer.fill as Record<string, unknown>).color = '#123456')],
      ['stroke.enabled', (layer) => ((layer.stroke as Record<string, unknown>).enabled = true)],
      ['shadow.blur', (layer) => ((layer.shadow as Record<string, unknown>).blur = 33)],
      ['pattern.scale', (layer) => ((layer.pattern as Record<string, unknown>).scale = 250)],
      ['name', (layer) => (layer.name = 'Renamed')],
    ];
    for (const [label, mutate] of mutations) {
      const snapshot = withMutatedLayer(mutate);
      const fingerprint = fingerprintNormalizedMeaning(normalizeArtworkProductMeaning(snapshot));
      expect(fingerprint, `mutation ${label} must change normalized meaning`).not.toBe(baseline);
    }
  });

  it('detects persistence loss instead of normalizing it away', () => {
    const snapshot = baseSnapshot();
    const payload = snapshotToCreateDto(snapshot, 'Lossy Artwork');
    const response = toGeneratedResponse(payload);
    const restored = normalizeArtworkResponseMeaning(response);
    const source = normalizeArtworkProductMeaning(snapshot);
    expect(canonicalizeNormalizedMeaning(restored)).toBe(canonicalizeNormalizedMeaning(source));

    // A layer-level `hidden` flag is included product meaning, but the current
    // persistence mapping only round-trips it for synthetic background layers.
    // The loss must surface as a normalized mismatch, never be projected away.
    const lossySource = withMutatedLayer((layer) => {
      layer.hidden = true;
    });
    const lossyPayload = snapshotToCreateDto(lossySource, 'Lossy Artwork');
    const lossyRestored = normalizeArtworkResponseMeaning(toGeneratedResponse(lossyPayload));
    expect(canonicalizeNormalizedMeaning(lossyRestored)).not.toBe(
      canonicalizeNormalizedMeaning(normalizeArtworkProductMeaning(lossySource)),
    );

    // A tampered included response field is likewise a mismatch, not a repair.
    const tampered = structuredClone(response);
    const textLayerResponse = (tampered.layouts ?? [])
      .flatMap((layout) => layout.layers ?? [])
      .find((layer) => layer.type === 'TEXT');
    expect(textLayerResponse).toBeDefined();
    (textLayerResponse?.config as Record<string, unknown>).content = { text: 'Tampered' };
    expect(canonicalizeNormalizedMeaning(normalizeArtworkResponseMeaning(tampered))).not.toBe(
      canonicalizeNormalizedMeaning(source),
    );
  });

  it('keeps equal-z sibling ordering deterministic and id-independent', () => {
    const make = (idA: string, idB: string): ArtworkEditorSnapshot => ({
      layoutItems: [
        canvasLayout(),
        {
          ...(baseSnapshot().layoutItems[1] as ArtworkLayoutItem),
          layers: [
            textLayer({ id: idA, zCoordinate: 5, name: 'Zulu' }),
            textLayer({ id: idB, zCoordinate: 5, name: 'Alpha' }),
          ],
        },
        baseSnapshot().layoutItems[2] as ArtworkLayoutItem,
      ],
      activeLayoutId: 'layout-a',
      selectedLayoutIds: [],
    });
    const first = normalizeArtworkProductMeaning(make('text-b', 'text-a'));
    const second = normalizeArtworkProductMeaning(make('text-a', 'text-b'));
    const names = (first.layouts[0]?.layers ?? []).map((layer) => layer.name);
    expect(names).toEqual(['Alpha', 'Zulu']);
    expect(canonicalizeNormalizedMeaning(first)).toBe(canonicalizeNormalizedMeaning(second));
  });
});

describe('WP5 Slice 5-F — normalized meaning refusals', () => {
  it('refuses non-finite numbers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const snapshot = withMutatedLayer((layer) => {
        layer.xCoordinate = value;
      });
      expect(() => normalizeArtworkProductMeaning(snapshot)).toThrowError(
        NormalizedMeaningUnusableError,
      );
      try {
        normalizeArtworkProductMeaning(snapshot);
      } catch (error) {
        expect((error as NormalizedMeaningUnusableError).code).toBe(
          NORMALIZED_MEANING_UNUSABLE_CODE,
        );
      }
    }
  });

  it('refuses cyclic values', () => {
    const snapshot = baseSnapshot();
    const layer = (snapshot.layoutItems[1]?.layers as unknown as Record<string, unknown>[])[0];
    (layer as Record<string, unknown>).self = layer;
    expect(() => normalizeArtworkProductMeaning(snapshot)).toThrowError(
      /Cyclic value at layout\.layers\.0\.self/,
    );
  });

  it('refuses prohibited transient blob sources', () => {
    const snapshot = withMutatedLayer((layer) => {
      (layer as Record<string, unknown>).src = 'blob:http://127.0.0.1:3000/abcd';
      (layer as Record<string, unknown>).type = 'IMAGE';
    });
    expect(() => normalizeArtworkProductMeaning(snapshot)).toThrowError(/Transient blob source/);
  });

  it('refuses a malformed snapshot and the outer response envelope', () => {
    expect(() =>
      normalizeArtworkProductMeaning({} as unknown as ArtworkEditorSnapshot),
    ).toThrowError(NormalizedMeaningUnusableError);
    expect(() =>
      normalizeArtworkResponseMeaning({
        data: { layouts: [] },
        message: 'ok',
        timestamp: 'now',
      } as unknown as ArtworkResponseDto),
    ).toThrowError(/outer response envelope/);
  });
});

describe('WP5 Slice 5-F — raw Crossword extraction', () => {
  it('extracts the exact raw seed, ordered words, and layout', () => {
    const snapshot = baseSnapshot();
    const payload = snapshotToCreateDto(snapshot, 'Raw Artwork');
    const extracted = extractRawCrosswordSemanticPayload(payload);
    expect(extracted).not.toBeNull();
    expect(extracted?.marker).toBe(true);
    expect(extracted?.generationSeed).toBe(CROSSWORD_SEED);
    expect(extracted?.words).toEqual(CROSSWORD_WORDS);
    expect(extracted?.layout).toEqual(generateCrosswordLayout(CROSSWORD_WORDS, CROSSWORD_SEED));

    const response = toGeneratedResponse(payload);
    const restoredRaw = extractRawCrosswordSemanticPayload(response);
    expect(restoredRaw?.generationSeed).toBe(CROSSWORD_SEED);
    expect(restoredRaw?.words).toEqual(CROSSWORD_WORDS);
    expect(canonicalizeNormalizedMeaning(restoredRaw?.layout)).toBe(
      canonicalizeNormalizedMeaning(extracted?.layout),
    );
  });

  it('returns null when no Crossword layer or no layouts are present', () => {
    expect(extractRawCrosswordSemanticPayload(null)).toBeNull();
    expect(extractRawCrosswordSemanticPayload({ layouts: [] })).toBeNull();
    const snapshot = baseSnapshot();
    const layout = snapshot.layoutItems[1] as ArtworkLayoutItem;
    layout.layers = [layout.layers?.[0] as ArtworkPersistedLayer];
    const payload = snapshotToCreateDto(snapshot, 'No Crossword');
    expect(extractRawCrosswordSemanticPayload(payload)).toBeNull();
  });

  it('resolves the restored typed Crossword seed, words, and layout', () => {
    const { response } = roundtrip(baseSnapshot());
    const restoredSnapshot = artworkResponseToSnapshot(response);
    const restoredLayers = restoredSnapshot.layoutItems[1]?.layers ?? [];
    const crossword = restoredLayers.find((layer) => layer.type === 'CROSSWORD') as unknown as {
      crossword: { generationSeed: number; words: string[]; layout: unknown };
    };
    expect(crossword.crossword.generationSeed).toBe(CROSSWORD_SEED);
    expect(crossword.crossword.words).toEqual(CROSSWORD_WORDS);
    expect(crossword.crossword.layout).toEqual(
      generateCrosswordLayout(CROSSWORD_WORDS, CROSSWORD_SEED),
    );
  });
});
