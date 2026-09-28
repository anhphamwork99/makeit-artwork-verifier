import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCliResultEnvelope } from '../../src/cli/output';
import { runCli } from '../../src/cli/main';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = realpathSync(mkdtempSync(path.join(tmpdir(), 'release-cli-test-')));
  roots.push(value);
  return value;
}

describe('release CLI dispatcher', () => {
  it.each([
    ['release'],
    ['release', 'approve', '--manifest', 'x'],
    ['release', 'activate', '--manifest', 'x', '--batch', 'qbatch-1', '--approval', 'a', '--retry'],
    [
      'release',
      'activate',
      '--manifest',
      'x',
      '--batch',
      'qbatch-1',
      '--batch',
      'qbatch-2',
      '--approval',
      'a',
    ],
    ['release', 'run', '--manifest', 'x', '--entry', 'entry-1'],
    ['release', 'run', '--manifest', 'x', '--resume'],
    ['release', 'run', '--manifest', 'x', '--shard', '0'],
  ])('rejects forbidden argv before loading runtime inputs: %j', async (...argv) => {
    const loadContext = vi.fn();
    const output: string[] = [];
    const code = await runCli(argv, {
      stdout: (chunk) => output.push(chunk),
      release: { skillRoot: root(), loadContext },
    });
    expect(code).toBe(64);
    expect(loadContext).not.toHaveBeenCalled();
    const envelope = parseCliResultEnvelope(JSON.parse(output.join('')) as unknown);
    expect(envelope.command).toBe('release');
    expect(envelope.subcommand).toBeNull();
    expect(envelope.status).toBe('USAGE');
    expect(JSON.stringify(envelope)).not.toContain(roots.at(-1));
  });

  it('routes release to its real handler and returns a sanitized refusal for unavailable authority', async () => {
    const owned = root();
    const output: string[] = [];
    const code = await runCli(
      [
        'release',
        'run',
        '--manifest',
        path.join(owned, 'cases/selection-manifests/drafts/draft-missing.json'),
      ],
      {
        stdout: (chunk) => output.push(chunk),
        release: { skillRoot: owned, repoRoot: owned },
      },
    );
    const envelope = parseCliResultEnvelope(JSON.parse(output.join('')) as unknown);
    expect(code).toBe(2);
    expect(envelope.command).toBe('release');
    expect(envelope.subcommand).toBe('run');
    expect(envelope.status).toBe('HARNESS_BLOCKED');
    expect(envelope.launchAttempted).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain(owned);
  });
});
