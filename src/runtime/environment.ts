import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { EnvironmentCatalogue, EnvironmentCell } from '../contracts/runtime';
import { ENVIRONMENT_CELL_CATALOGUE_SCHEMA_VERSION } from '../contracts/schema-versions';
import { resolveToolkitRoot } from './paths';

/**
 * Governed environment cell catalogue (specification 9.3).
 *
 * The initial matrix contains exactly one governed Chromium desktop cell. Every
 * value is explicit, and any structural deviation fails closed so a run can
 * never launch under an undeclared environment.
 */

export const ENVIRONMENT_CATALOGUE_FILE = 'catalogues/environments/chromium-desktop.v1.json';
export const DEFAULT_ENVIRONMENT_CELL_ID = 'chromium-desktop-1440x1000';

export class EnvironmentCatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentCatalogueError';
  }
}

function fail(message: string): never {
  throw new EnvironmentCatalogueError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array of strings`);
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function parseCell(raw: unknown, index: number): EnvironmentCell {
  const label = `cells[${index}]`;
  if (!isRecord(raw)) fail(`${label} must be an object`);

  const browserKind = requireString(raw.browserKind, `${label}.browserKind`);
  if (browserKind !== 'chromium') {
    fail(`${label}.browserKind "${browserKind}" is not implemented in the initial matrix`);
  }
  const classification = requireString(raw.classification, `${label}.classification`);
  if (
    classification !== 'required-credit' &&
    classification !== 'diagnostic-only' &&
    classification !== 'excluded-with-reason'
  ) {
    fail(`${label}.classification is not a declared environment cell classification`);
  }
  const colorScheme = requireString(raw.colorScheme, `${label}.colorScheme`);
  if (colorScheme !== 'light' && colorScheme !== 'dark') {
    fail(`${label}.colorScheme must be "light" or "dark"`);
  }
  const reducedMotion = requireString(raw.reducedMotion, `${label}.reducedMotion`);
  if (reducedMotion !== 'no-preference' && reducedMotion !== 'reduce') {
    fail(`${label}.reducedMotion must be "no-preference" or "reduce"`);
  }
  if (raw.storageState !== null) {
    fail(`${label}.storageState must be null: the initial cell uses a fresh context`);
  }
  const viewport = raw.viewport;
  if (!isRecord(viewport)) fail(`${label}.viewport must be an object`);

  const geolocation = raw.geolocation;
  if (geolocation !== null && !isRecord(geolocation)) {
    fail(`${label}.geolocation must be an object or null`);
  }

  return {
    cellId: requireString(raw.cellId, `${label}.cellId`),
    classification,
    browserKind,
    browserChannel: requireString(raw.browserChannel, `${label}.browserChannel`),
    playwrightVersion: requireString(raw.playwrightVersion, `${label}.playwrightVersion`),
    viewport: {
      width: requireFiniteNumber(viewport.width, `${label}.viewport.width`),
      height: requireFiniteNumber(viewport.height, `${label}.viewport.height`),
    },
    deviceScaleFactor: requireFiniteNumber(raw.deviceScaleFactor, `${label}.deviceScaleFactor`),
    locale: requireString(raw.locale, `${label}.locale`),
    timezoneId: requireString(raw.timezoneId, `${label}.timezoneId`),
    colorScheme,
    reducedMotion,
    permissions: requireStringArray(raw.permissions, `${label}.permissions`),
    geolocation:
      geolocation === null
        ? null
        : {
            latitude: requireFiniteNumber(geolocation.latitude, `${label}.geolocation.latitude`),
            longitude: requireFiniteNumber(geolocation.longitude, `${label}.geolocation.longitude`),
          },
    storageState: null,
  };
}

export function parseEnvironmentCatalogue(raw: unknown): EnvironmentCatalogue {
  if (!isRecord(raw)) fail('Environment catalogue must be an object');
  if (raw.schemaVersion !== ENVIRONMENT_CELL_CATALOGUE_SCHEMA_VERSION) {
    fail(`Unsupported environment catalogue schema version: ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.cells) || raw.cells.length === 0) {
    fail('Environment catalogue must declare at least one cell');
  }
  const cells = raw.cells.map(parseCell);
  const cellIds = cells.map((cell) => cell.cellId);
  if (new Set(cellIds).size !== cellIds.length) {
    fail('Environment catalogue declares a duplicate cellId');
  }
  cells.sort((left, right) => (left.cellId < right.cellId ? -1 : 1));
  return { schemaVersion: raw.schemaVersion, cells };
}

export function loadEnvironmentCatalogue(options: { rootDir?: string } = {}): EnvironmentCatalogue {
  const rootDir = options.rootDir ?? resolveToolkitRoot();
  const absolutePath = path.join(rootDir, ENVIRONMENT_CATALOGUE_FILE);
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch {
    fail(`Environment catalogue is unavailable: ${ENVIRONMENT_CATALOGUE_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`Environment catalogue is not valid JSON: ${ENVIRONMENT_CATALOGUE_FILE}`);
  }
  return parseEnvironmentCatalogue(parsed);
}

export function resolveEnvironmentCell(
  catalogue: EnvironmentCatalogue,
  cellId: string = DEFAULT_ENVIRONMENT_CELL_ID,
): EnvironmentCell {
  const cell = catalogue.cells.find((entry) => entry.cellId === cellId);
  if (!cell) fail(`Environment cell "${cellId}" is not declared in the catalogue`);
  return cell;
}
