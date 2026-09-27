---
name: verify-artwork-editor
description: Standalone private toolkit that verifies the MakeIt Artwork Editor Diagnostic profile through an explicitly supplied, separately authorized application checkout and real browser input, producing reproducible behavior evidence and a closed outcome classification.
version: 0.1.0
---

<objective>
Run the approved Artwork Editor Diagnostic correctness cases from this
standalone toolkit, resolve Layouts and layers semantically against an explicit,
validated application root, drive user behavior with native browser input when a
live application is available, collect current state plus bounded visual
evidence, classify the result into a closed outcome, and clean every
verification-owned process and scratch resource.

This skill documents one CLI implementation, `makeit-artwork-verifier@0.1.0`.
It contains no executable engine of its own: the `bin/` launcher inside this
skill delegates to the same TypeScript entry point as the toolkit-root CLI. The
skill never vendors, reimplements, or shims the product normalization,
canonicalization, fingerprint, or Crossword core.
</objective>

<prerequisites>
- Node.js `>=20.11 <25` and pnpm `10.33.0` (declared `packageManager`).
- `pnpm install --frozen-lockfile` at the toolkit root.
- For a live `diagnostic` run only: a separate, authorized `FE-build` checkout
  passed explicitly as `--app-root`.
- No login, shared server, production environment, or conversation-only fixture
  state is required. The verification bridge is compiled out of production
  behavior by its explicit public flag and the non-production `NODE_ENV` gate.

The no-FE surface (help, `plan`, portable contract/refusal tests, typecheck)
runs without any application checkout.
</prerequisites>

<launch>
Run from the **toolkit root** (this repository), not from an application root.
The stable entry point is `bin/verify-artwork.mjs`; it is also exposed through
the `cli` package script:

```sh
node bin/verify-artwork.mjs --help
pnpm cli -- --help          # documented command surface as a schema-versioned JSON envelope
pnpm cli -- --version       # makeit-artwork-verifier 0.1.0
```

`--help` is the first command for a cold agent. It prints `schemaVersion: 2`
with `status: "USAGE"` and `exitCode: 64`, listing every command and the
`--app-root <path>` flag.

Currently usable commands:

```sh
pnpm cli -- plan --case <request.json> --out <dir>
pnpm cli -- validate --all
pnpm cli -- diagnostic --case <request.json> --app-root <FE-checkout>
pnpm cli -- diagnostic --suite representative --app-root <FE-checkout>
pnpm cli -- evidence verify --run <run-id>
pnpm cli -- cleanup --run-id <run-id>
```

`qualify`, `release`, `budget`, and `retention` are deferred and fail closed with
`NOT_IMPLEMENTED`; they are not part of the correctness phase.

**FE wrapper status:** the `FE-build` convenience wrapper is planned but **not
yet implemented** (WP3). It is expected to expose `pnpm verify:artwork --help`,
`pnpm verify:artwork diagnostic --case ...`, and
`pnpm verify:artwork evidence verify --run ...` by forwarding to this CLI. Do
not use those wrapper commands until WP3 lands; use the toolkit-root CLI above.

The authoritative current Case Request examples and fixture ownership contract
are in `cases/diagnostic/requests/`, `catalogues/`, and `references/cold-agent.md`.
The cold-agent walkthrough, command examples, ownership rules, and evidence
reader contract are in `references/cold-agent.md`. The older
`references/test-case-contract.md` and the Python helper describe the preserved
legacy driver and are explicitly **not** the current CLI acceptance contract.
</launch>

<app-root>
The Diagnostic profile loads a narrow, versioned **product-meaning provider**
only from the explicit `--app-root` you supply during preflight. The application
root is mandatory, must be an existing directory, and is validated before
allocation, process launch, browser creation, or evidence creation.

The root must expose `src/lib/artwork/verification/productMeaningProvider.mjs`
exporting `productMeaningProvider` with `schemaVersion: 1`,
`profileId: 'artwork-product-meaning-v1'`, and the required functions
(`normalizeArtworkProductMeaning`, `canonicalizeNormalizedMeaning`,
`fingerprintNormalizedMeaning`, `extractRawCrosswordSemanticPayload`). The
generated-Crossword source contract is likewise read from the explicit root.

Refusals stay distinct from product defects:

- absent/blank app root → `USAGE` (`CLI_USAGE_INVALID`, exit 64);
- missing/non-directory root, missing/invalid/incompatible provider, or
  generated-Crossword source drift → `HARNESS_BLOCKED` (exit 2);
- never a product `BUG`.

Reaching a live application requires separate, authorized private access to the
`FE-build` checkout. This toolkit does not vendor, copy, or infer product source.

**Current limitation:** the `FE-build` provider export is not implemented yet,
so a live `diagnostic`/`doctor` run cannot currently be claimed from this
toolkit. `plan`, `validate`, help, and the portable tests remain fully usable.
</app-root>

<diagnostic>
For a single case:

```sh
pnpm cli -- diagnostic --case .pi/skills/verify-artwork-editor/cases/diagnostic/requests/layer-text-move-drag-ordinary.json --app-root <FE-checkout>
```

The command compiles and validates the request before allocation, validates the
explicit app root and provider, chooses an unused loopback port unless `--port`
is supplied, starts an owned Next.js instance with `NEXT_PUBLIC_MOCK_API=true`
and `NEXT_PUBLIC_ARTWORK_VERIFICATION=true`, records the exact process group,
and refuses to reuse a shared server. `--suite representative` runs the named
eight-case representative scope and reports each child plus aggregate coverage;
it does not claim exhaustive coverage.
</diagnostic>

<doctor>
The run helper waits for `/artwork/editor` to return HTTP success, then opens
Chromium and requires:

- final route `/artwork/editor`;
- document title `Editor - Artwork`;
- `window.__MAKEIT_ARTWORK_VERIFICATION__` version `1`;
- a mounted Konva Stage;
- Stage Layers `artwork-boards`, `artwork-smart-guides`, `artwork-warp-handles`, and `artwork-drag-overlay`;
- at least one ordinary Layout plus the virtual Canvas Layout;
- fonts no longer loading;
- no active canvas gesture or pan.

Doctor evidence is saved as `doctor.json` and `doctor.png`. A missing or wrong
bridge is `HARNESS_BLOCKED`. A server/browser/runtime prerequisite failure is
`ENVIRONMENT_FAILURE`.
</doctor>

<drive>
Use current Diagnostic Case Request JSON files under
`cases/diagnostic/requests/`. Their authoritative schema is described in
`references/cold-agent.md` and the request examples themselves.

The proven case is
`cases/diagnostic/requests/layer-text-move-drag-ordinary.json`. Fixture setup
uses public UI only:

1. select `Layout #1` with a native mouse click at a bridge-verified hit point;
2. click `Create new layout`;
3. dismiss `Got it` when onboarding appears;
4. click `Text`;
5. click `Add text`.

The read-only bridge resolves the selected Text layer by semantic kind and live
selection, then supplies a Konva-verified viewport hit point. The behavior under
test is driven with Playwright mouse down, stepped move, and mouse up. Undo and
redo use the visible toolbar controls.

Do not use bridge methods to mutate Artwork state. The bridge is read-only. Test
behavior must use native browser input; fixture setup must use public UI actions
unless a future feature file explicitly documents another production boundary.
</drive>

<evidence>
Each Diagnostic run receives a durable directory:

`.pi/skills/verify-artwork-editor/evidence/runs/$RUN_ID/`

It contains:

- `run-record.json` — strict v4 current-source record: candidate/plan/source/environment identities, outcome, coverage, required checks, and cleanup;
- `final-manifest.json` — sealed evidence transaction and artifact integrity references;
- `intended-inventory.json` — declared artifacts and scope references;
- `server.log` — owned Next.js process output;
- bounded observation and visual artifacts declared by the final manifest;
- failure artifacts when the harness cannot complete the case.

Outcomes:

- `PASS` — required state, live Konva geometry, visible movement, and requested undo/redo checks pass.
- `BUG` — the real user action completed but one or more declared expectations failed.
- `HARNESS_BLOCKED` — a semantic element, verified hit point, bridge/provider contract, fixture, or driver precondition could not be established.
- `ENVIRONMENT_FAILURE` — launch, browser, package, port, or runtime prerequisites failed.

Coverage is a separate `complete`/`partial`/`incomplete` dimension. A run that
reaches `PASS`, `BUG`, `HARNESS_BLOCKED`, or `ENVIRONMENT_FAILURE` never claims
mobile, backend, cross-browser, exhaustive, Release Credit, or production-safety
coverage.

The known `scenegraphNodes` mirror can lag coordinate-only `layoutItems` updates.
The bridge exposes `scenegraphInSync` and both representations so this
discrepancy is visible; it does not silently repair product state. Live behavior
assertions use current content derived from `layoutItems` plus live Konva geometry.
</evidence>

<cleanup>
Cleanup runs in a `finally` block after every pass or failure.

The helper sends termination only to the process group it created, waits,
escalates only that same group when necessary, verifies the owned port is
closed, removes the run's temporary ownership directory, and preserves the
evidence directory.

To clean a previously interrupted owned run, use the current CLI surface:

```sh
pnpm cli -- cleanup --run-id $RUN_ID
```

Cleanup is exact-id and fail-closed: an unknown or colliding run is refused.
Never kill by process name, broad port sweep, or shared development-server port.
</cleanup>

<cold-agent>
The documented correctness profile is Diagnostic correctness with a closed
outcome and separate coverage. Read `references/cold-agent.md` before
interpreting a run, and use
`pnpm cli -- evidence verify --run $RUN_ID` to independently verify the durable
record after cleanup. Treat a toolkit-only checkout as unable to produce a live
`PASS`: the FE provider export and wrapper are WP3 work.
</cold-agent>

<transfer-boundary>
This repository is a private toolkit-only snapshot. `.planning/` provenance,
historical or generated `evidence/`, dependencies, credentials/environment
files, and build caches are outside the boundary and must never be committed.
Run `pnpm verify:transfer` before staging; it checks ignore rules, the tracked
file set, WP1 manifest provenance, and added-material secret signatures.
</transfer-boundary>

<helpers>
- `scripts/verify_artwork.py` — legacy owned launch/doctor/drive orchestration; preserved for reference, not the current CLI acceptance path.
- `scripts/drive-case.mjs` — legacy Playwright doctor and real-browser case driver; preserved for reference.
- `scripts/verify-engine-branching.mjs` — toolkit self-check helper.

Both legacy drivers manipulate only their selected owned port, exact process
group, temporary run state, and the run evidence directory.
</helpers>

<success_criteria>
- The help envelope is a documented `USAGE` (exit 64) without launching anything.
- The explicit app root and product-meaning provider are validated before allocation.
- Fixture setup uses visible product controls.
- The tested manipulation uses native browser input at a live Konva-verified hit point.
- Result evidence includes current Artwork content state, live Konva geometry, bounded pixels, undo/redo when requested, and diagnostics.
- A failed expectation produces a readable `BUG` bundle rather than only a timeout.
- Cleanup closes the owned port and removes scratch state.
- Evidence remains readable after cleanup.
</success_criteria>
