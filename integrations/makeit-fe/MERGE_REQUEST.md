# MR: Install canonical Artwork verifier Host Adapter

## Suggested title

`feat: install canonical artwork verifier host adapter`

## Summary

- Install `makeit-artwork-verifier` from private verifier tag `v0.3.4` via
  `package.json`/`pnpm-lock.yaml`.
- Add the MakeIt-specific read-only Host Adapter, product-meaning provider and
  production-safe observation seams.
- Add frontend commands for setup, host compatibility, capability inventory,
  live verification, evidence verification and report generation.
- Keep generated requests/evidence/reports outside tracked product source.
- Remove the prior submodule distribution mechanism; team members need only the
  official frontend checkout and normal `pnpm install` access.

## Why

The verifier must be usable by all authorized FE members without depending on a
prototype repository. The verifier engine is now distributed from its own
repository; official FE retains only the app-specific adapter required to map
Artwork state and geometry into the versioned host contract.

## Verification evidence

- `pnpm test:verify:adapter`: 21/21 PASS.
- Focused Host Adapter/product geometry suites: 137/137 PASS.
- `pnpm verify:artwork:host`: PASS without browser launch.
- Live `layer-text-move-drag-ordinary`: behavior PASS + evidence integrity PASS.
- `pnpm build`: PASS.
- `pnpm verify:artwork production-absence --app-root "$(pwd -P)"`: PASS;
  955 emitted files scanned, zero seam hits, 80/80 requested chunks resolved,
  browser initial/reload absence PASS and cleanup complete.

## Review focus

1. Product-side bridge is read-only and only wired under the explicit
   non-production verification gate.
2. `next.config.mjs` accepts only owned `.next/verify-runs/<safe-id>` paths.
3. Production output contains no observation/setup globals or Symbol slots.
4. `package.json` and lockfile pin verifier tag `v0.3.4`.
5. No `.gitmodules` or `.tooling/makeit-artwork-verifier` remains.

## Rollback

Revert this MR. No database migration or persisted production data is involved.
Generated verification evidence is local-only and ignored.

## Maintainer checklist

- [ ] Confirm access policy for the private verifier repository.
- [ ] Run Integration Kit verification from a clean official FE checkout.
- [ ] Review package lock and Host Adapter ownership boundary.
- [ ] Confirm production-absence PASS before merge.
- [ ] Merge through the normal official FE review path.
