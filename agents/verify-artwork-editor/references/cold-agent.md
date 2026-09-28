# Cold-agent correctness profile (standalone toolkit)

This is the self-contained launch and evidence guide for an agent with no
conversation history. Run every command from the **toolkit repository root**
(the `makeit-artwork-verifier` checkout), not from an application root.

## Prerequisites

1. Use Node.js `>=20.11 <25` and pnpm `10.33.0` (declared `packageManager`;
   `.npmrc` sets `engine-strict=true`).
2. Run `pnpm install --frozen-lockfile` if dependencies are not installed.
3. Confirm that Playwright Chromium is available to the installed package
   before attempting any live run.
4. For a live `diagnostic` run, obtain separate, authorized access to a
   `FE-build` checkout and pass it explicitly with `--app-root`.
5. Keep the verification source local. Diagnostic evidence records the commit,
   dirty state, lockfile digest, resolved **registry fingerprint**, and
   environment cell; it does not turn an uncommitted tree into a release claim.

The no-FE surface (help, `plan`, portable tests, typecheck) needs no application
checkout. The runner owns its browser, process group, loopback port, Next dist
directory, temporary scratch lease, route/storage namespaces, and evidence
directory. Do not start or attach to a shared development server.

## Toolkit-root command surface

```sh
pnpm cli --help     # schema-versioned JSON command surface (USAGE, exit 64)
pnpm cli --version  # makeit-artwork-verifier 0.1.0 (PASS, exit 0)
```

The FE prototype consumes this toolkit through a pinned submodule and exposes
`pnpm verify:artwork ...`. From a standalone toolkit checkout, use
`node bin/verify-artwork.mjs <command>` or `pnpm cli <command>`.

## Explicit application root

`diagnostic` requires `--app-root <path>`. The root is validated before
allocation and must expose the FE-owned product-meaning provider at
`src/lib/artwork/verification/productMeaningProvider.mjs` (export
`productMeaningProvider`, `schemaVersion: 1`, profile
`artwork-product-meaning-v1`). The generated-Crossword source contract is read
from the same explicit root. There is no implicit adjacent checkout and no
fallback: a missing, malformed, or incompatible provider is a harness refusal
(`HARNESS_BLOCKED`), never a product `BUG`.

> The FE prototype currently provides the accepted schema-1 product-meaning
> provider and bridge-v7 compatibility descriptor. A different app root must pass
> the same pre-allocation compatibility checks.


## Current Case Request shape

The current request is a strict JSON object. Use the checked-in examples as the
complete vocabulary and keep the following fields intact:

```json
{
  "schemaVersion": 1,
  "profile": "diagnostic",
  "provenance": "diagnostic-request",
  "evidenceDepth": "deep",
  "intent": {
    "subjectId": "layer/text",
    "capability": "move",
    "scenario": "drag-ordinary",
    "variant": "plain",
    "factors": {}
  }
}
```

`intent` is resolved against the versioned subject, operation, fixture,
workflow, readiness, Oracle, environment, and Coverage Model catalogues. Do not
add legacy `id`, `fixture`, `action`, `expected`, `oracleDepth`, or `evidence`
fields from the archived Python driver format. Fixture construction is owned by
the declared Diagnostic workflow and uses public UI controls; the read-only
observation bridge cannot mutate product state.

## Launch

Plan a case without any launch or application checkout:

```sh
pnpm cli plan \
  --case cases/diagnostic/requests/layer-text-move-drag-ordinary.json \
  --out ./out/plan
```

Run one current-source case against an authorized application checkout:

```sh
pnpm cli diagnostic \
  --case cases/diagnostic/requests/layer-text-move-drag-ordinary.json \
  --app-root <FE-checkout>
```

Use `diagnostic --suite representative --app-root <FE-checkout>` for the named
eight-case representative scope. The suite reports each child and aggregate
coverage; it does not claim exhaustive state-space coverage.

## Result interpretation

The JSON envelope is authoritative. `status`/`outcome` is one of:

- `PASS`: required behavior and oracles passed and owned cleanup completed.
- `BUG`: the native action completed, but a declared product expectation did
  not match authoritative current observations.
- `HARNESS_BLOCKED`: a contract, fixture, app-root/provider, semantic target,
  readiness, oracle, or ownership precondition was not trustworthy; no product
  defect is claimed.
- `ENVIRONMENT_FAILURE`: launch, browser, port, process, package, or host
  prerequisite failed; no product defect is claimed.

`details.source` binds the candidate to its source/application fingerprint,
resolved registry fingerprint, repository revision/dirty state, and lockfile
digest. `details.candidate` binds case, materialization, and plan identities.
`environmentCellId`, `details.scope`, `coverageStatus`, and the required-check
list define the exercised scope. Missing or unsupported bindings remain
partial/incomplete or unavailable; they must not be inferred as tested.

## Evidence and cleanup

Each direct-toolkit run preserves `run-record.json` under
`evidence/runs/<run-id>/` after cleanup. An FE
adapter may instead set `MAKEIT_ARTWORK_EVIDENCE_ROOT` to an existing canonical
absolute evidence base; keep the same value for the run, recovery cleanup, and
readback. Relative, missing, or symlinked configured roots fail closed. Read the
record without mutation through:

```sh
pnpm cli evidence verify --run <run-id>
```

The verifier checks the canonical record, integrity and semantic digests,
provenance identity, artifact references, sanitization, secret/path scans, and
post-finalization immutability. A **historical or legacy record** is labelled as
such and cannot be promoted to current-source proof.

Cleanup is **exact-id and fail-closed**:

```sh
pnpm cli cleanup --run-id <run-id> --app-root <FE-checkout>
```

It may terminate only the recorded process group, close only the recorded port,
remove only the recorded dist/scratch resources, and preserve evidence. The
`--app-root` is mandatory and must be the exact validated checkout the run was
allocated against; a missing root is a usage error and a wrong or tampered root
is refused with no kill, restore or deletion. An unknown or colliding run is
refused. If cleanup verification fails, retain the
evidence and treat the run as non-PASS until the ownership issue is resolved.

## Transfer boundary

The repository tracks only `.planning/maintain-verification-skills/` as its
maintenance Project Home. Other `.planning/` provenance, historical or generated
`evidence/`, dependencies, credentials/environment files, and build caches are
never committed. Run `pnpm verify:transfer` before staging.
