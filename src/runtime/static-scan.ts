import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  isScannedArtifact,
  isSkippedDirectoryName,
  PRODUCTION_ABSENCE_MARKERS,
  PRODUCTION_ARTIFACT_SCAN_SCHEMA_VERSION,
  scanArtifactContent,
  type AbsenceMarker,
  type ProductionArtifactHit,
  type ProductionArtifactScan,
} from '../contracts/production-absence';

/**
 * Emitted-artifact production absence scan (specification 16 Gate C).
 *
 * The scan walks the owned production `distDir`, reads every emitted executable
 * client/server artifact and manifest, and reports every seam marker it reaches.
 * Build caches, dependency trees, and source maps are not emitted executable
 * output and are skipped, so a hit always names a file the production runtime
 * can actually load.
 */

export interface ScanProductionArtifactsInput {
  distDir: string;
  /** Test/diagnostic override; defaults to the closed contract vocabulary. */
  markers?: readonly AbsenceMarker[];
  /** Test-only seam: read the directory entries for `relativeDir`. */
  readDir?: (absoluteDir: string) => import('node:fs').Dirent[];
  /** Test-only seam: read one artifact as UTF-8. */
  readArtifact?: (absolutePath: string) => string;
}

interface WalkState {
  hits: ProductionArtifactHit[];
  scannedFiles: number;
  skippedFiles: number;
  skippedDirectories: string[];
}

function walk(
  absoluteDir: string,
  relativeDir: string,
  markers: readonly AbsenceMarker[],
  readDir: (absoluteDir: string) => import('node:fs').Dirent[],
  readArtifact: (absolutePath: string) => string,
  state: WalkState,
): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readDir(absoluteDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isSkippedDirectoryName(entry.name)) {
        state.skippedDirectories.push(relativePath);
        continue;
      }
      walk(path.join(absoluteDir, entry.name), relativePath, markers, readDir, readArtifact, state);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isScannedArtifact(relativePath)) {
      state.skippedFiles += 1;
      continue;
    }
    let content: string;
    try {
      content = readArtifact(path.join(absoluteDir, entry.name));
    } catch {
      continue;
    }
    state.scannedFiles += 1;
    state.hits.push(...scanArtifactContent(relativePath, content, markers));
  }
}

/**
 * Scans every emitted executable artifact and manifest under `distDir`.
 *
 * `clean` is true only when no scanned file contains a seam marker. The result
 * is a value object; it never throws for a missing directory and never mutates
 * the build output.
 */
export function scanProductionArtifacts(
  input: ScanProductionArtifactsInput,
): ProductionArtifactScan {
  const markers = input.markers ?? PRODUCTION_ABSENCE_MARKERS;
  const readDir =
    input.readDir ?? ((absoluteDir) => readdirSync(absoluteDir, { withFileTypes: true }));
  const readArtifact = input.readArtifact ?? ((absolutePath) => readFileSync(absolutePath, 'utf8'));

  const state: WalkState = { hits: [], scannedFiles: 0, skippedFiles: 0, skippedDirectories: [] };
  walk(input.distDir, '', markers, readDir, readArtifact, state);

  state.hits.sort((a, b) =>
    `${a.relativePath}:${a.marker}`.localeCompare(`${b.relativePath}:${b.marker}`),
  );

  return {
    schemaVersion: PRODUCTION_ARTIFACT_SCAN_SCHEMA_VERSION,
    distDir: input.distDir,
    scannedFiles: state.scannedFiles,
    hits: state.hits,
    skipped: { directories: state.skippedDirectories, files: state.skippedFiles },
    clean: state.hits.length === 0,
  };
}
