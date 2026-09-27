import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main';
import { parseCliResultEnvelope } from '../../src/cli/output';
import type { RetentionCommandDetails } from '../../src/cli/retention';
import { readAndVerifyRetentionAudit } from '../../src/governance/retention';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'retention-cli-')));
  roots.push(root);
  return root;
}

async function invoke(argv: readonly string[], root: string) {
  const output: string[] = [];
  const code = await runCli(argv, {
    stdout: (chunk) => output.push(chunk),
    retention: { skillRoot: root },
  });
  const envelope = parseCliResultEnvelope<RetentionCommandDetails>(JSON.parse(output.join('')));
  expect(envelope.launchAttempted).toBe(false);
  expect(envelope.outcome).toBeNull();
  expect(output.join('')).not.toContain(root);
  return { code, envelope };
}

describe('retention CLI', () => {
  it.each([
    ['retention'],
    ['retention', 'prune'],
    ['retention', 'delete'],
    ['retention', 'audit', '--root', '/private/path'],
    ['retention', 'audit', '--approve'],
    ['retention', 'audit', 'audit'],
  ])('rejects unsupported grammar without writes: %j', async (...argv) => {
    const root = makeRoot();
    const { code, envelope } = await invoke(argv, root);
    expect(code).toBe(64);
    expect(envelope.details?.failureCode).toBe('ARGUMENTS_INVALID');
    expect(readdirSync(root)).toEqual([]);
  });

  it('routes to real append and readback, preserving malformed historical bytes', async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'evidence/governance'), { recursive: true });
    mkdirSync(path.join(root, 'evidence/runs/old-run'), { recursive: true });
    const file = path.join(root, 'evidence/runs/old-run/run-record.json');
    const bytes = '{old incomplete record';
    writeFileSync(file, bytes);
    const { code, envelope } = await invoke(['retention', 'audit'], root);
    expect(code).toBe(0);
    expect(envelope.details).toMatchObject({
      policy: 'PRESERVE_ALL',
      fileCount: 1,
      byteCount: Buffer.byteLength(bytes),
      releaseCredit: false,
      failureCode: null,
    });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    const auditId = envelope.details?.auditId;
    expect(auditId).toMatch(/^retention-[a-f0-9]{64}$/);
    const verified = readAndVerifyRetentionAudit(root, auditId as string);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value.snapshot.artifacts[0]?.rawContentStatus).toBe('JSON_PARSE_FAILED');
    }
    expect(readdirSync(path.join(root, 'evidence/governance/retention-audit'))).toEqual([
      `${auditId}.json`,
    ]);
  });

  it('reports missing governance parent and unsafe evidence without leaking paths', async () => {
    const root = makeRoot();
    const missing = await invoke(['retention', 'audit'], root);
    expect(missing.code).toBe(2);
    expect(missing.envelope.details?.failureCode).toBe('AUDIT_WRITE_REFUSED');
    expect(readdirSync(root)).toEqual([]);
    mkdirSync(path.join(root, 'evidence/governance'), { recursive: true });
    const outside = path.join(root, 'private-record');
    writeFileSync(outside, 'private contents');
    mkdirSync(path.join(root, 'evidence/runs'), { recursive: true });
    symlinkSync(outside, path.join(root, 'evidence/runs/linked.json'));
    const unsafe = await invoke(['retention', 'audit'], root);
    expect(unsafe.code).toBe(2);
    expect(unsafe.envelope.details?.failureCode).toBe('UNSAFE_FILESYSTEM_OBJECT');
    expect(JSON.stringify(unsafe.envelope)).not.toContain('private contents');
    expect(readdirSync(path.join(root, 'evidence/governance'))).toEqual([]);
  });
});
