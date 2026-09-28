import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  linkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendRetentionAudit,
  buildRetentionSnapshot,
  readAndVerifyRetentionAudit,
} from '../../src/governance/retention';

const CAPTURED_AT = '2026-09-26T12:00:00.000Z';

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retention-audit-')));
  mkdirSync(path.join(root, 'evidence', 'governance'), { recursive: true });
  return root;
}

function write(root: string, relative: string, contents: string): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function fileMap(root: string): Map<string, string> {
  const result = new Map<string, string>();
  function walk(directory: string, relative: string): void {
    if (!lstatSync(directory).isDirectory()) return;
    for (const name of readdirSync(directory)) {
      const child = path.join(directory, name);
      const next = relative ? `${relative}/${name}` : name;
      if (lstatSync(child).isDirectory()) walk(child, next);
      else if (lstatSync(child).isFile()) result.set(next, readFileSync(child, 'hex'));
    }
  }
  walk(root, '');
  return result;
}

describe('raw no-delete retention inventory', () => {
  it('inventories exact raw bytes while marking malformed, orphaned, and dangling history unverified', () => {
    const root = makeRoot();
    try {
      const childBytes = '{"artifactId":"child-1","references":["missing-artifact"]}\n';
      const malformedBytes = '{ broken legacy record';
      const legacyBytes = '{"artifactId":"old-record","schemaVersion":0}\n';
      write(root, 'evidence/runs/run-1/child.json', childBytes);
      write(root, 'evidence/governance/qualification-authority/batches/legacy.json', legacyBytes);
      write(root, 'evidence/suites/old.json', malformedBytes);

      const before = fileMap(root);
      const result = buildRetentionSnapshot(root, { capturedAt: CAPTURED_AT });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const snapshot = result.value;
      expect(snapshot.policy).toBe('PRESERVE_ALL');
      expect(snapshot.totalFileCount).toBe(3);
      expect(snapshot.totalByteCount).toBe(
        Buffer.byteLength(childBytes + legacyBytes + malformedBytes),
      );
      expect(snapshot.artifacts.map((artifact) => artifact.disposition)).toEqual([
        'PRESERVE_ALL',
        'PRESERVE_ALL',
        'PRESERVE_ALL',
      ]);
      const child = snapshot.artifacts.find(
        (artifact) => artifact.relativePath === 'run-1/child.json',
      );
      expect(child?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(child?.byteCount).toBe(Buffer.byteLength(childBytes));
      expect(child?.rawContentStatus).toBe('JSON_UNVERIFIED');
      expect(child?.referenceStatus).toBe('DANGLING_REFERENCES');
      expect(child?.referenceAnomalies.map((anomaly) => anomaly.code)).toContain(
        'DANGLING_REFERENCE',
      );

      const legacy = snapshot.artifacts.find(
        (artifact) => artifact.relativePath === 'batches/legacy.json',
      );
      expect(legacy?.rawContentStatus).toBe('JSON_UNVERIFIED');
      expect(legacy?.referenceStatus).toBe('UNREFERENCED_OBJECT');
      const malformed = snapshot.artifacts.find((artifact) => artifact.relativePath === 'old.json');
      expect(malformed?.rawContentStatus).toBe('JSON_PARSE_FAILED');
      expect(malformed?.referenceStatus).toBe('REFERENCE_STATUS_UNASSESSED');

      expect(
        snapshot.namespaceWatermarks.find((item) => item.namespace === 'budget-measurements'),
      ).toMatchObject({ presence: 'ABSENT', fileCount: 0, byteCount: 0 });
      expect(fileMap(root)).toEqual(before);
      expect(
        lstatSync(path.join(root, 'evidence', 'governance', 'retention-audit'), {
          throwIfNoEntry: false,
        }),
      ).toBeUndefined();
      expect(
        snapshot.artifacts.every(
          (artifact) => !('verified' in artifact) && !('eligible' in artifact),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends only the audit record and allows later append-only namespace growth', () => {
    const root = makeRoot();
    try {
      write(root, 'evidence/runs/run-1/record.json', '{"schemaVersion":4}\n');
      const before = fileMap(root);
      const result = appendRetentionAudit(root, { capturedAt: CAPTURED_AT });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.auditId).toBe(`retention-${result.value.snapshot.snapshotId}`);
      expect(
        result.value.snapshot.namespaceWatermarks.find(
          (item) => item.namespace === 'retention-audit',
        ),
      ).toMatchObject({ presence: 'ABSENT', fileCount: 0 });

      const after = fileMap(root);
      expect([...after.keys()].filter((name) => !before.has(name))).toEqual([
        `evidence/governance/retention-audit/${result.value.auditId}.json`,
      ]);
      for (const [name, bytes] of before) expect(after.get(name)).toBe(bytes);

      write(root, 'evidence/runs/run-2/later.json', '{"schemaVersion":"future"}\n');
      const verified = readAndVerifyRetentionAudit(root, result.value.auditId);
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(
          verified.value.snapshot.artifacts.some(
            (artifact) => artifact.relativePath === 'run-2/later.json',
          ),
        ).toBe(false);
      }

      const second = appendRetentionAudit(root, { capturedAt: '2026-09-26T12:01:00.000Z' });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(
          second.value.snapshot.namespaceWatermarks.find(
            (item) => item.namespace === 'retention-audit',
          ),
        ).toMatchObject({ presence: 'PRESENT', fileCount: 1 });
        expect(readAndVerifyRetentionAudit(root, result.value.auditId).ok).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when captured bytes or the digest-addressed audit record is tampered with', () => {
    const root = makeRoot();
    try {
      const captured = write(root, 'evidence/runs/run-1/record.json', '{"preserve":true}\n');
      const appended = appendRetentionAudit(root, { capturedAt: CAPTURED_AT });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;

      writeFileSync(captured, '{"preserve":false}\n');
      expect(readAndVerifyRetentionAudit(root, appended.value.auditId)).toEqual({
        ok: false,
        code: 'SNAPSHOT_CHANGED',
      });

      // Restore bytes so the saved audit record can be tested independently.
      writeFileSync(captured, '{"preserve":true}\n');
      const auditPath = path.join(
        root,
        'evidence/governance/retention-audit',
        `${appended.value.auditId}.json`,
      );
      const tampered = JSON.parse(readFileSync(auditPath, 'utf8')) as Record<string, unknown>;
      tampered.digest = '0'.repeat(64);
      writeFileSync(auditPath, `${JSON.stringify(tampered)}\n`);
      expect(readAndVerifyRetentionAudit(root, appended.value.auditId)).toEqual({
        ok: false,
        code: 'AUDIT_INVALID',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses symlinks, hard links, scan caps, and nested-parent symlink substitution', () => {
    const symlinkRoot = makeRoot();
    try {
      const target = write(symlinkRoot, 'outside/secret.json', '{"private":true}\n');
      const namespace = path.join(symlinkRoot, 'evidence', 'runs');
      mkdirSync(namespace, { recursive: true });
      symlinkSync(target, path.join(namespace, 'linked.json'));
      expect(buildRetentionSnapshot(symlinkRoot, { capturedAt: CAPTURED_AT })).toEqual({
        ok: false,
        code: 'UNSAFE_FILESYSTEM_OBJECT',
      });
      expect(
        lstatSync(path.join(symlinkRoot, 'evidence', 'governance', 'retention-audit'), {
          throwIfNoEntry: false,
        }),
      ).toBeUndefined();
    } finally {
      rmSync(symlinkRoot, { recursive: true, force: true });
    }

    const hardlinkRoot = makeRoot();
    try {
      const original = write(hardlinkRoot, 'outside/data.json', '{"x":1}\n');
      const linked = path.join(hardlinkRoot, 'evidence', 'runs', 'linked.json');
      mkdirSync(path.dirname(linked), { recursive: true });
      linkSync(original, linked);
      expect(buildRetentionSnapshot(hardlinkRoot, { capturedAt: CAPTURED_AT })).toEqual({
        ok: false,
        code: 'UNSAFE_FILESYSTEM_OBJECT',
      });
    } finally {
      rmSync(hardlinkRoot, { recursive: true, force: true });
    }

    const cappedRoot = makeRoot();
    try {
      write(cappedRoot, 'evidence/runs/a.json', 'a');
      write(cappedRoot, 'evidence/runs/b.json', 'b');
      expect(
        buildRetentionSnapshot(cappedRoot, {
          capturedAt: CAPTURED_AT,
          maxFiles: 1,
        }),
      ).toEqual({ ok: false, code: 'INVENTORY_LIMIT_EXCEEDED' });
    } finally {
      rmSync(cappedRoot, { recursive: true, force: true });
    }

    const ancestorRoot = makeRoot();
    try {
      write(ancestorRoot, 'evidence/runs/run-1/nested/record.json', '{"x":1}\n');
      const appended = appendRetentionAudit(ancestorRoot, { capturedAt: CAPTURED_AT });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;
      const nested = path.join(ancestorRoot, 'evidence', 'runs', 'run-1', 'nested');
      const saved = path.join(ancestorRoot, 'evidence', 'runs', 'run-1', 'saved');
      renameSync(nested, saved);
      symlinkSync(saved, nested, 'dir');
      expect(readAndVerifyRetentionAudit(ancestorRoot, appended.value.auditId)).toEqual({
        ok: false,
        code: 'UNSAFE_FILESYSTEM_OBJECT',
      });
    } finally {
      rmSync(ancestorRoot, { recursive: true, force: true });
    }
  });
});
