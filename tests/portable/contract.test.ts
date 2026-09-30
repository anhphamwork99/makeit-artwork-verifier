import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH,
  PRODUCT_MEANING_PROVIDER_EXPORT_NAME,
  PRODUCT_MEANING_PROVIDER_PROFILE_ID,
  PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION,
  validateProductMeaningProvider,
  type ProductMeaningProviderV1,
} from '../../src/contracts/product-meaning-provider';
import { runCli } from '../../src/cli/main';
import { runWithCliStdout } from '../../src/cli/output';
import {
  loadProductMeaningProvider,
  productMeaningProviderEntryPath,
  resolveAppRoot,
} from '../../src/runtime/product-meaning-provider';
import { isVerifiableRepositoryRoot, resolveRepoRoot, resolveToolkitRoot } from '../../src/runtime/paths';
import { TOOLKIT_NAME, TOOLKIT_VERSION } from '../../src/version';

/**
 * Portable product-meaning provider contract (ADR 0118, WP2 C3/C4).
 *
 * This suite runs with no FE checkout present. It proves the toolkit-owned
 * contract, the scoped loader that reads exactly one provider module from an
 * explicit, caller-supplied app root, and the schema/version/profile
 * validators. A compatible synthetic provider app root under
 * `tests/portable/fixtures/` stands in for the FE-owned module so the loader can
 * be exercised without importing any application code.
 */

const PORTABLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(PORTABLE_ROOT, 'fixtures');
const APP_ROOT_COMPATIBLE = path.join(FIXTURES_ROOT, 'app-root-compatible');
const APP_ROOT_INCOMPATIBLE_SCHEMA = path.join(FIXTURES_ROOT, 'app-root-incompatible-schema');
const APP_ROOT_BAD_EXPORT = path.join(FIXTURES_ROOT, 'app-root-bad-export');
const APP_ROOT_LOAD_FAILURE = path.join(FIXTURES_ROOT, 'app-root-load-failure');
const APP_ROOT_NO_PROVIDER = path.join(FIXTURES_ROOT, 'app-root-no-provider');

function compatibleProvider(): ProductMeaningProviderV1 {
  return {
    schemaVersion: PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION,
    profileId: PRODUCT_MEANING_PROVIDER_PROFILE_ID,
    normalizeArtworkProductMeaning: (snapshot) => ({
      schemaVersion: PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION,
      profileId: PRODUCT_MEANING_PROVIDER_PROFILE_ID,
      layouts: Array.isArray((snapshot as { layouts?: unknown[] } | null)?.layouts)
        ? ((snapshot as { layouts: unknown[] }).layouts)
        : [],
    }),
    canonicalizeNormalizedMeaning: (value) => JSON.stringify(value),
    fingerprintNormalizedMeaning: (value) => `fp:${JSON.stringify(value)}`,
    extractRawCrosswordSemanticPayload: (value) =>
      value !== null && typeof value === 'object' && (value as { marker?: unknown }).marker === true
        ? { marker: true, generationSeed: 0, words: [], layout: null }
        : null,
  };
}

async function captureCli(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await runWithCliStdout((chunk) => {
    stdout += chunk;
  }, () => runCli(argv));
  return { code, stdout };
}

describe('[ADR 0118] product-meaning provider contract surface', () => {
  it('declares one closed schema, profile, entry path and export name', () => {
    expect(PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION).toBe(1);
    expect(PRODUCT_MEANING_PROVIDER_PROFILE_ID).toBe('artwork-product-meaning-v1');
    expect(PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH).toBe(
      'src/lib/artwork/verification/productMeaningProvider.mjs',
    );
    expect(PRODUCT_MEANING_PROVIDER_EXPORT_NAME).toBe('productMeaningProvider');
    // Relative, portable and never an absolute or toolkit-internal path.
    expect(PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH.startsWith('/')).toBe(false);
    expect(PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH.endsWith('.mjs')).toBe(true);
  });

  it('keeps the contract module pure data/type with no import and no FE alias', () => {
    const contractSource = readFileSync(
      path.join(resolveToolkitRoot(), 'src', 'contracts', 'product-meaning-provider.ts'),
      'utf8',
    );
    expect(/^\s*import\s/m.test(contractSource)).toBe(false);
    expect(contractSource).not.toContain('@/');
    expect(contractSource).not.toContain('normalizedMeaningCore');
  });

  it('keeps the scoped loader free of FE alias and vendored-core references', () => {
    const loaderSource = readFileSync(
      path.join(resolveToolkitRoot(), 'src', 'runtime', 'product-meaning-provider.ts'),
      'utf8',
    );
    expect(loaderSource).not.toContain('@/');
    expect(loaderSource).not.toContain('normalizedMeaningCore');
  });
});

describe('[ADR 0118] validateProductMeaningProvider fails closed', () => {
  it('accepts a structurally compatible provider', () => {
    const validated = validateProductMeaningProvider(compatibleProvider());
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.provider.profileId).toBe(PRODUCT_MEANING_PROVIDER_PROFILE_ID);
    }
  });

  it('rejects a non-object export as PROVIDER_CONTRACT_INVALID', () => {
    for (const candidate of [null, 'provider', 7, [], undefined]) {
      const validated = validateProductMeaningProvider(candidate);
      expect(validated.ok).toBe(false);
      if (!validated.ok) expect(validated.code).toBe('PROVIDER_CONTRACT_INVALID');
    }
  });

  it('rejects a non-integer schemaVersion as PROVIDER_CONTRACT_INVALID', () => {
    const validated = validateProductMeaningProvider({
      ...compatibleProvider(),
      schemaVersion: '1',
    });
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.code).toBe('PROVIDER_CONTRACT_INVALID');
  });

  it('rejects an unknown schemaVersion as PROVIDER_INCOMPATIBLE', () => {
    const validated = validateProductMeaningProvider({
      ...compatibleProvider(),
      schemaVersion: PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION + 1,
    });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.code).toBe('PROVIDER_INCOMPATIBLE');
      expect(validated.detail).toContain(String(PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION));
    }
  });

  it('rejects a foreign meaning profile as PROVIDER_INCOMPATIBLE', () => {
    const validated = validateProductMeaningProvider({
      ...compatibleProvider(),
      profileId: 'some-other-meaning-v9',
    });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.code).toBe('PROVIDER_INCOMPATIBLE');
      expect(validated.detail).toContain(PRODUCT_MEANING_PROVIDER_PROFILE_ID);
    }
  });

  it('rejects every missing required function as PROVIDER_CONTRACT_INVALID', () => {
    for (const name of [
      'normalizeArtworkProductMeaning',
      'canonicalizeNormalizedMeaning',
      'fingerprintNormalizedMeaning',
      'extractRawCrosswordSemanticPayload',
    ] as const) {
      const candidate: Record<string, unknown> = { ...compatibleProvider() };
      delete candidate[name];
      const validated = validateProductMeaningProvider(candidate);
      expect(validated.ok, `missing ${name} must be refused`).toBe(false);
      if (!validated.ok) {
        expect(validated.code).toBe('PROVIDER_CONTRACT_INVALID');
        expect(validated.detail).toContain(name);
      }
    }
  });
});

describe('[ADR 0118] resolveAppRoot validates the explicit app root', () => {
  it('refuses an absent or blank app root as APP_ROOT_MISSING', () => {
    for (const value of [undefined, '', '   ']) {
      const resolved = resolveAppRoot(value);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.code).toBe('APP_ROOT_MISSING');
    }
  });

  it('refuses a nonexistent path as APP_ROOT_UNRESOLVED', () => {
    const resolved = resolveAppRoot(path.join(FIXTURES_ROOT, 'does-not-exist'));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('APP_ROOT_UNRESOLVED');
  });

  it('refuses a file as APP_ROOT_NOT_DIRECTORY', () => {
    const resolved = resolveAppRoot(path.join(APP_ROOT_NO_PROVIDER, 'NOTE.txt'));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('APP_ROOT_NOT_DIRECTORY');
  });

  it('accepts a directory and resolves it to an absolute path', () => {
    const resolved = resolveAppRoot(APP_ROOT_COMPATIBLE);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.appRoot).toBe(path.resolve(APP_ROOT_COMPATIBLE));
  });

  it('derives the provider entry only under the supplied root', () => {
    expect(productMeaningProviderEntryPath('/explicit/app/root')).toBe(
      path.join('/explicit/app/root', 'src', 'lib', 'artwork', 'verification', 'productMeaningProvider.mjs'),
    );
  });
});

/**
 * ADR 0119 — the app root is canonical identity, not a path spelling.
 *
 * `realpathSync` is the only accepted identity: a symlinked root canonicalizes
 * to its real directory (so allocation binds the true checkout), and a recorded
 * root that is not its own canonical path is refused. The filesystem root is
 * never a valid application root.
 */
describe('[ADR 0119] resolveAppRoot canonicalizes and refuses non-identity roots', () => {
  it('canonicalizes a symlinked app root to its real directory', () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vt-contract-root-')));
    const realRoot = path.join(base, 'real-root');
    mkdirSync(realRoot);
    const link = path.join(base, 'link-root');
    symlinkSync(realRoot, link, 'dir');

    const resolved = resolveAppRoot(link);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.appRoot).toBe(realRoot);
      expect(resolved.appRoot).not.toBe(link);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses the filesystem root as an app root', () => {
    const resolved = resolveAppRoot(path.parse(process.cwd()).root);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('APP_ROOT_INVALID');
  });

  it('accepts only a canonical recorded root and refuses a symlink root', () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vt-contract-canon-')));
    const realRoot = path.join(base, 'real-root');
    mkdirSync(realRoot);
    const link = path.join(base, 'link-root');
    symlinkSync(realRoot, link, 'dir');

    expect(isVerifiableRepositoryRoot(realRoot)).toBe(true);
    expect(isVerifiableRepositoryRoot(link)).toBe(false);
    expect(isVerifiableRepositoryRoot(path.parse(process.cwd()).root)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('[ADR 0118] loadProductMeaningProvider loads solely from the supplied root', () => {
  it('loads and returns a usable compatible provider without any FE checkout', async () => {
    const loaded = await loadProductMeaningProvider(APP_ROOT_COMPATIBLE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.ref.appRoot).toBe(path.resolve(APP_ROOT_COMPATIBLE));
    expect(loaded.ref.entryPath).toBe(productMeaningProviderEntryPath(loaded.ref.appRoot));
    // The resolved entry is inside the caller-supplied root, never an inferred
    // adjacent checkout or the toolkit's own tree.
    expect(loaded.ref.entryPath.startsWith(`${loaded.ref.appRoot}${path.sep}`)).toBe(true);
    expect(loaded.ref.provider.profileId).toBe(PRODUCT_MEANING_PROVIDER_PROFILE_ID);
    expect(loaded.ref.provider.schemaVersion).toBe(PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION);

    const normalized = loaded.ref.provider.normalizeArtworkProductMeaning({
      layouts: [{ id: 'layout-a' }],
    });
    expect(normalized.profileId).toBe(PRODUCT_MEANING_PROVIDER_PROFILE_ID);
    expect(normalized.layouts).toEqual([{ id: 'layout-a' }]);

    // Canonicalization and fingerprinting are deterministic and key-order
    // independent: the loader injects the provider's real functions untouched.
    const left = { a: 1, b: [2, 3] };
    const right = { b: [2, 3], a: 1 };
    expect(loaded.ref.provider.canonicalizeNormalizedMeaning(left)).toBe(
      loaded.ref.provider.canonicalizeNormalizedMeaning(right),
    );
    expect(loaded.ref.provider.fingerprintNormalizedMeaning(left)).toBe(
      loaded.ref.provider.fingerprintNormalizedMeaning(right),
    );
    expect(loaded.ref.provider.fingerprintNormalizedMeaning(left)).not.toBe(
      loaded.ref.provider.fingerprintNormalizedMeaning({ a: 1, b: [2, 4] }),
    );

    expect(loaded.ref.provider.extractRawCrosswordSemanticPayload({ marker: false })).toBeNull();
    expect(
      loaded.ref.provider.extractRawCrosswordSemanticPayload({
        marker: true,
        generationSeed: 42,
        words: ['ALPHA'],
        layout: { id: 'l' },
      }),
    ).toEqual({ marker: true, generationSeed: 42, words: ['ALPHA'], layout: { id: 'l' } });
  });

  it('refuses a root with no provider entry as PROVIDER_ENTRY_MISSING', async () => {
    expect(existsSync(APP_ROOT_NO_PROVIDER)).toBe(true);
    const loaded = await loadProductMeaningProvider(APP_ROOT_NO_PROVIDER);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.code).toBe('PROVIDER_ENTRY_MISSING');
  });

  it('refuses a non-object provider export as PROVIDER_CONTRACT_INVALID', async () => {
    const loaded = await loadProductMeaningProvider(APP_ROOT_BAD_EXPORT);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.code).toBe('PROVIDER_CONTRACT_INVALID');
  });

  it('refuses an unsupported provider schema as PROVIDER_INCOMPATIBLE', async () => {
    const loaded = await loadProductMeaningProvider(APP_ROOT_INCOMPATIBLE_SCHEMA);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.code).toBe('PROVIDER_INCOMPATIBLE');
  });

  it('refuses a provider that throws while loading as PROVIDER_LOAD_FAILED', async () => {
    const loaded = await loadProductMeaningProvider(APP_ROOT_LOAD_FAILURE);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.code).toBe('PROVIDER_LOAD_FAILED');
      expect(loaded.detail).toContain('synthetic provider load failure');
    }
  });
});

describe('[WP2 C2] CLI surface is versioned and help is a documented USAGE', () => {
  it('answers --help as USAGE/exit 64 with the documented app-root schema', async () => {
    const { code, stdout } = await captureCli(['--help']);
    expect(code).toBe(64);
    const envelope = JSON.parse(stdout) as {
      schemaVersion: number;
      status: string;
      exitCode: number;
      launchAttempted: boolean;
      detail: string;
    };
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.status).toBe('USAGE');
    expect(envelope.exitCode).toBe(64);
      expect(envelope.launchAttempted).toBe(false);
      expect(envelope.detail).toContain('host doctor --app-root <path>');
      expect(envelope.detail).toContain('diagnostic --case <request.json> --app-root <path>');
      expect(envelope.detail).toContain('--app-root <path>');
    });

    it('inspects a compatible host contract without launching runtime resources', async () => {
      const { code, stdout } = await captureCli([
        'host',
        'doctor',
        '--app-root',
        APP_ROOT_COMPATIBLE,
      ]);
      expect(code).toBe(0);
      const envelope = JSON.parse(stdout) as {
        status: string;
        launchAttempted: boolean;
        details: {
          appRootValidated: boolean;
          providerEntryLoaded: boolean;
          providerProfileId: string;
          compatibility: { schemaVersion: number; bridgeVersion: number };
        };
      };
      expect(envelope.status).toBe('PASS');
      expect(envelope.launchAttempted).toBe(false);
      expect(envelope.details.appRootValidated).toBe(true);
      expect(envelope.details.providerEntryLoaded).toBe(true);
      expect(envelope.details.providerProfileId).toBe(PRODUCT_MEANING_PROVIDER_PROFILE_ID);
      expect(envelope.details.compatibility.schemaVersion).toBe(1);
      expect(envelope.details.compatibility.bridgeVersion).toBe(7);
    });

  it('answers no command as USAGE/exit 64', async () => {
    const { code, stdout } = await captureCli([]);
    expect(code).toBe(64);
    expect((JSON.parse(stdout) as { status: string }).status).toBe('USAGE');
  });

  it('answers --version as PASS/exit 0 with the toolkit identity', async () => {
    const { code, stdout } = await captureCli(['--version']);
    expect(code).toBe(0);
    const envelope = JSON.parse(stdout) as { status: string; detail: string };
    expect(envelope.status).toBe('PASS');
    expect(envelope.detail).toBe(`${TOOLKIT_NAME} ${TOOLKIT_VERSION}`);
  });

  it('keeps the package manifest version in lockstep with the toolkit identity', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(resolveRepoRoot(), 'package.json'), 'utf8'),
    ) as { name: string; version: string; bin: Record<string, string> };
    expect(manifest.name).toBe(TOOLKIT_NAME);
    expect(manifest.version).toBe(TOOLKIT_VERSION);
    expect(manifest.bin['verify-artwork']).toBe('./bin/verify-artwork.mjs');
  });
});
