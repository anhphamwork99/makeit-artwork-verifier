import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * P7-A remediation: the retained durable normalized typecheck comparison
 * artifact (ADR 0024 §7).
 *
 * The historical typecheck output was unavailable, so the remediation produces
 * a reconstructed, durable baseline anchored to ADR 0022 plus the P7-A
 * no-product-write proof. This test verifies the retained artifact's contract
 * and its accepted verdict: exactly four diagnostics, all under the previously
 * recorded product test file, zero toolkit diagnostics, and no additional
 * diagnostic anywhere.
 */

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  '.pi/skills/verify-artwork-editor/evidence/typecheck/p7a-typecheck-comparison.json',
);
const ACCEPTED_BASELINE_FILE = 'src/lib/artwork/warpText/distort/__tests__/distortEnvelope.test.ts';

interface DiagnosticTuple {
  file: string;
  code: string;
  line: number;
  column: number;
  span: string;
  message: string;
  messageDigest: string;
}

interface TypecheckArtifact {
  artifactSchemaVersion: number;
  artifactId: string;
  command: string;
  cwd: string;
  head: string;
  scopeManifest: { path: string; present: boolean };
  exitCode: number;
  typescriptVersion: string | null;
  acceptedBaseline: { file: string; expectedDiagnosticCount: number };
  diagnostics: DiagnosticTuple[];
  counts: {
    total: number;
    underProductSrc: number;
    underToolkit: number;
    other: number;
    outsideAcceptedBaselineFile: number;
  };
  verdict: string;
}

const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as TypecheckArtifact;

describe('[P7-A remediation] durable normalized typecheck comparison artifact (ADR 0024 §7)', () => {
  it('records the command, working directory, HEAD, manifest reference, exit code, and TypeScript version', () => {
    expect(artifact.artifactSchemaVersion).toBe(1);
    expect(artifact.command).toBe('pnpm typecheck');
    expect(artifact.cwd.endsWith('/FE-build')).toBe(true);
    expect(artifact.head).toMatch(/^[0-9a-f]{40}$/);
    expect(artifact.scopeManifest.path).toContain('p7a-scope-manifest.json');
    expect(artifact.scopeManifest.present).toBe(true);
    expect([0, 1, 2]).toContain(artifact.exitCode);
    expect(artifact.typescriptVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('records one normalized tuple per diagnostic with a stable span and a message digest', () => {
    for (const diagnostic of artifact.diagnostics) {
      expect(diagnostic.file).not.toContain('/Users/');
      expect(diagnostic.code).toMatch(/^TS\d+$/);
      expect(Number.isInteger(diagnostic.line)).toBe(true);
      expect(Number.isInteger(diagnostic.column)).toBe(true);
      expect(diagnostic.span).toBe(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`);
      expect(diagnostic.message.length).toBeGreaterThan(0);
      expect(diagnostic.messageDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('accepts exactly the four-error product baseline with zero toolkit diagnostics', () => {
    expect(artifact.verdict).toBe('accepted-four-error-product-baseline');
    expect(artifact.acceptedBaseline).toEqual({
      file: ACCEPTED_BASELINE_FILE,
      expectedDiagnosticCount: 4,
    });
    expect(artifact.counts).toEqual({
      total: 4,
      underProductSrc: 4,
      underToolkit: 0,
      other: 0,
      outsideAcceptedBaselineFile: 0,
    });
    for (const diagnostic of artifact.diagnostics) {
      expect(diagnostic.file).toBe(ACCEPTED_BASELINE_FILE);
    }
  });
});
