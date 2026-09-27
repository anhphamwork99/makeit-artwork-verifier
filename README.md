# makeit-artwork-verifier (private)

Standalone, private correctness toolkit for the MakeIt Artwork Editor Diagnostic
profile. It runs the approved Diagnostic case requests, classifies the outcome,
and reads back the durable evidence record. This repository is a
toolkit-only snapshot: the Artwork Editor product, its verification bridge, and
the product-meaning provider all stay in the separate `FE-build` checkout.

- **Package:** `makeit-artwork-verifier@0.1.0`
- **License:** `UNLICENSED` — private, no license grant, no public distribution.
- **Status:** WP2 packaging/handoff complete; FE-build adapter (WP3) not started.
- **Coverage claim:** representative Diagnostic correctness only. No Release
  Credit, mobile, backend, cross-browser, exhaustive, or production-safety claim.

## Prerequisites

| Requirement | Value |
|---|---|
| Node.js | `>=20.11 <25` (enforced by `.npmrc` `engine-strict=true`) |
| pnpm | `10.33.0` (declared `packageManager`) |
| Lockfile | `pnpm-lock.yaml`; install with `pnpm install --frozen-lockfile` |

The no-FE surface (help, `plan`, portable contract/refusal tests, typecheck) runs
without any application checkout. A live `diagnostic` run additionally needs an
authorized, separate `FE-build` checkout passed explicitly through `--app-root`.

## Install

```sh
pnpm install --frozen-lockfile
```

## Command surface

The toolkit entry point is `bin/verify-artwork.mjs`. Run it directly or through
the `cli` package script. Every subcommand emits one schema-versioned JSON
envelope (`schemaVersion: 2`) on stdout and sets a meaningful exit code.

```sh
node bin/verify-artwork.mjs --help          # documented command surface (USAGE, exit 64)
pnpm cli -- --help                          # same, via the package script
pnpm cli -- --version                       # makeit-artwork-verifier 0.1.0 (PASS, exit 0)
```

Currently usable commands:

```sh
# Static planning of one Diagnostic case request (no app root, no launch)
# `--out` should point at a generated directory such as `./out/plan` (ignored by Git)
pnpm cli -- plan --case .pi/skills/verify-artwork-editor/cases/diagnostic/requests/layer-text-move-drag-ordinary.json --out ./out/plan

# Static catalogue validation
pnpm cli -- validate --all

# Diagnostics that own a local product instance (require an explicit app root)
pnpm cli -- diagnostic --case <request.json> --app-root <FE-checkout>
pnpm cli -- diagnostic --suite representative --app-root <FE-checkout>

# Evidence readback and cleanup (exact-id, exact-root, fail-closed)
pnpm cli -- evidence verify --run <run-id>
pnpm cli -- cleanup --run-id <run-id> --app-root <FE-checkout>
```

`qualify`, `release`, `budget`, and `retention` commands print on the deferred
TS-2 surface and fail closed with `NOT_IMPLEMENTED`; they are not part of the
current correctness phase.

### `validate --all` in a toolkit-only checkout

`validate --all` performs pre-launch static validation. With no `FE-build`
checkout and no historical evidence present it reports `HARNESS_BLOCKED`
(exit 2) with `CROSSWORD_SOURCE_DRIFT` (the generated-Crossword product source
lives in the application checkout) and `COMPLETENESS_ACCEPTED_SUITE_ABSENT` (no
accepted representative suite record is transferred). This is honest refusal,
not a toolkit defect.

## Explicit application root and private FE access

The Diagnostic profile loads a narrow, versioned **product-meaning provider**
from the application checkout you pass as `--app-root`. The root is mandatory,
validated before any port/process/browser allocation, and never inferred from
the toolkit or skill location.

The FE checkout must expose, relative to `--app-root`:

- `src/lib/artwork/verification/productMeaningProvider.mjs`, exporting
  `productMeaningProvider` with `schemaVersion: 1`,
  `profileId: 'artwork-product-meaning-v1'`, and the four required functions
  (`normalizeArtworkProductMeaning`, `canonicalizeNormalizedMeaning`,
  `fingerprintNormalizedMeaning`, `extractRawCrosswordSemanticPayload`).

An absent, non-directory, malformed, or incompatible root/provider refuses as
`USAGE` or `HARNESS_BLOCKED` before allocation — never as a product `BUG`.
Reaching the real product requires **separate, authorized private access** to
the `FE-build` checkout; this repository does not vendor product source.

The FE-owned provider export is implemented and the detached toolkit has passed
the named eight-case representative browser suite against an authorized FE
checkout. The `pnpm verify:artwork` convenience adapter remains a separate FE
integration step; toolkit-root commands above are authoritative until it lands.

When an application adapter installs this repository as a dependency, it may set
`MAKEIT_ARTWORK_EVIDENCE_ROOT` to an existing canonical absolute directory so
run and suite evidence survives dependency reinstalls. Direct toolkit users
should leave it unset; the default remains
`.pi/skills/verify-artwork-editor/evidence/`. The same value must be present for
the run, recovery cleanup, and `evidence verify`. Invalid, relative, or symlinked
values fail closed before evidence is written.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm test            # portable no-FE suite
pnpm test:contract   # request/result/evidence fingerprint contracts
pnpm test:refusal    # pre-allocation refusal matrix
pnpm typecheck
pnpm verify:transfer # transfer/inventory/provenance guard
```

`pnpm test:fe-hosted` and `pnpm test:browser` require a separate authorized FE
checkout (`MAKEIT_ARTWORK_APP_ROOT`) and belong to the WP3 integration surface.

## Transfer boundary

This repository must never contain `.planning/` provenance, historical or
generated `evidence/`, dependencies, credentials/environment files, or build
caches. `.gitignore` enforces the boundary and `pnpm verify:transfer` re-checks
ignore rules, the tracked file set, WP1 manifest provenance, and added-material
secret signatures. See `CONTRIBUTING.md` and `SECURITY.md`.

## Layout

```
bin/verify-artwork.mjs                       # CLI launcher (TS entry via tsx)
scripts/verify-transfer.mjs                  # transfer/inventory guard
.pi/skills/verify-artwork-editor/            # the bundled Pi skill + CLI implementation
  SKILL.md                                   # skill/CLI documentation
  references/                                # cold-agent guide and legacy notes
  src/, tests/, cases/, catalogues/, ...      # toolkit source, tests, approved data
package.json, pnpm-lock.yaml, tsconfig.portable.json, vitest.*.config.ts
```
