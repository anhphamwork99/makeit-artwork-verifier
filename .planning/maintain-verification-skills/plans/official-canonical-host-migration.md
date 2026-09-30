> **Historical plan — superseded.** This plan records the prior submodule/gitlink
> migration approach. Do not execute its commands. The active architecture uses
> the package-based Integration Kit documented in `../../../../integrations/makeit-fe/README.md`
> and the current Project Home `../PROJECT.md`.

# Official canonical host migration

**Status:** Owner-approved implementation
**Accepted direction:** `MakeIT-POD/fe-editor` becomes the canonical verifier
host; `makeit-demo` remains a secondary consumer during transition.
**Official baseline:** `MakeIT-POD/fe-editor:dev@31dfece80c61f29eed32b203a096049c7c775b6f`
**Verifier baseline:** `makeit-artwork-verifier:main@1e1b440287e889be40beae7013a3d25b5449ab61`
**Demo baseline:** `makeit-demo:main@ca401e4dce14e5ed718c9558dc958cbd56ec9922`

## Objective

Deliver a versioned, repository-neutral verifier host contract and a reviewed
frontend integration candidate based on the exact official `dev` source. A
developer working in the official frontend must receive the canonical skill,
consumer wrapper, pinned private toolkit and FE-owned verification seams after
the team applies the candidate through its official merge workflow.

## Non-negotiable boundaries

1. Never commit, push or open a prototype PR against `MakeIT-POD/*`.
2. Push verifier changes only to
   `anhphamwork99/makeit-artwork-verifier:main`.
3. Build the official-host candidate from exact `upstream/dev`; push it only to
   a dedicated branch of `anhphamwork99/makeit-demo`.
4. Keep explicit `--app-root`, exact verifier pin, clean-checkout validation,
   fail-closed preflight, read-only observation and production seam absence.
5. Do not vendor, duplicate or shim frontend product meaning inside the
   verifier.
6. Do not claim the official repository is migrated until the team applies and
   merges the candidate.

## Work graph

### WP1 — Host-neutral verifier contract

**Write set:** verifier repository only.

- Replace `makeit-demo`-exclusive ownership language with compatible-host
  terminology.
- Add a machine-readable/read-only host doctor command that checks the
  provider entry and versioned host contract without launching a browser.
- Preserve existing Diagnostic behavior and refusal codes.
- Add portable contract/refusal tests.

**Verification:** focused tests, full contract/refusal suites, typecheck,
strict transfer guard and CLI smoke.

### WP2 — Official-source integration candidate

**Base:** exact official baseline above.
**Write set:** isolated FE worktree/branch only.

- Port the minimal consumer layer: submodule pin, canonical skill, wrappers,
  readiness/capability/gap/report commands and package scripts.
- Adapt the FE-owned provider, compatibility declaration, setup boundary,
  observation bridge and integration hooks to current official source.
- Preserve non-production flag gating and production absence.
- Add focused integration tests.

**Verification:** install, adapter tests, host doctor, typecheck, focused tests,
production build, one live representative case and one expected refusal.

### WP3 — Secondary consumer alignment

**Write set:** `makeit-demo:main` only after WP1 is pushed.

- Update verifier gitlink to the pushed WP1 commit.
- Update documentation to mark demo as secondary consumer.
- Keep current behavior working; do not pull official candidate product changes
  into demo main unless required by the versioned host contract.

**Verification:** adapter tests, setup, typecheck, build and focused live proof.

### WP4 — Independent review and delivery packet

- Review verifier and candidate diffs independently.
- Produce exact commit identities, verification commands/results, known gaps
  and application instructions for the official team.
- Confirm every push target before push.

## Acceptance criteria

1. Compatibility decisions depend on provider/bridge/capability versions, not
   repository identity.
2. From the official-source candidate root, the canonical skill is discoverable
   and `pnpm verify:artwork:setup` reaches `READY`.
3. Host doctor succeeds for the compatible candidate and fails without launch
   for missing/incompatible provider contracts.
4. A focused live Diagnostic completes with behavior and evidence verification
   `PASS`; an incompatible-host probe is refused before allocation.
5. Production build passes and verification seams remain absent in production.
6. `makeit-demo:main` remains usable as a secondary consumer.
7. Official merge remains explicitly team-owned and is never represented as
   completed by prototype-only delivery.
