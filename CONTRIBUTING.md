# Contributing (private)

This is a private, work-package-governed toolkit. Changes are accepted only
inside the approved boundary described below. There is no public contribution
process, no release process, and no license is granted by this repository.

## Prerequisites

- Node.js `>=20.11 <25`
- pnpm `10.33.0`
- Install exactly from the lockfile: `pnpm install --frozen-lockfile`

## Local workflow

```sh
pnpm install --frozen-lockfile
pnpm test          # portable no-FE suite
pnpm test:contract # contract surface
pnpm test:refusal  # pre-allocation refusal matrix
pnpm typecheck
pnpm verify:transfer
node bin/verify-artwork.mjs --help
```

All six must pass before a change is proposed. A change that only compiles is
not complete: it must preserve the Diagnostic outcome/coverage/evidence
contract and keep preflight refusal honest (`launchAttempted: false`, no
allocation, no evidence) for malformed/missing/incompatible inputs.

## Boundary rules

- **No application coupling.** Never import `@/` product modules, rely on an
  `FE-build` `node_modules`/`tsx`, or infer an application root. The app root is
  an explicit `--app-root` input, validated before allocation. The only
  product-owned dependency is the versioned product-meaning provider loaded
  from that explicit root.
- **No product/engine duplication.** Do not vendor, reimplement, or shim the
  product normalization/canonicalization/fingerprint/Crossword core.
- **Do not transfer excluded content.** The only tracked planning path is
  `.planning/maintain-verification-skills/`. Other `.planning/` provenance,
  historical or generated `evidence/`, `.env*`, credentials, dependencies, and
  build caches are outside the boundary. `.gitignore` blocks them;
  `pnpm verify:transfer` re-checks.
- **Preserve honest scope.** Do not expand claims to Release Credit, mobile,
  backend, cross-browser, exhaustive coverage, or production safety. Do not
  delete, rewrite, or relabel tests to make the historical suite look green.
- **No Release/license/dependency expansion.** Do not add a license, publish to
  a registry, or broadly upgrade dependencies without owner authorization.

## Allowlisted snapshot and provenance

The toolkit source is an allowlisted transfer of 414 files recorded in
`.planning/source-manifest.sha256` (never committed). WP2 intentionally edited a
small set of allowlisted files and added authorized toolkit files. The guard
reports edited allowlisted files as *informational* (edits are expected); it
fails only on unaccounted files, forbidden paths, missing allowlisted files, or
high-confidence secret signatures in new/changed material.

Run it before staging:

```sh
pnpm verify:transfer
pnpm verify:transfer --json   # machine-readable PASS/FAIL summary
```

## Staging discipline

- Stage only the declared write set; never `git add -A` blindly.
- Confirm the staged inventory contains no planning path except
  `.planning/maintain-verification-skills/`, and no `evidence/`, env, or
  dependency paths.
- Keep ignored extraction provenance, `evidence/`, and `node_modules/`
  untracked.
- Commit only when the current work package authorizes it.
