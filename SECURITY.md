# Security policy (private)

This repository is a private, internal correctness toolkit. It is not intended
for public disclosure, public distribution, packaging, or deployment. There is
no license grant and no public support channel.

## Reporting

Report suspected vulnerabilities, leaked credentials, or boundary violations
directly to the repository owner through the private channel used for this
project. Do not open a public issue, publish findings, or share repository
contents with unauthorized recipients.

## No secrets in the repository

- `.gitignore` excludes `.env`, `.env.*`, `*.pem`, `*.key`, credential stores,
  dependencies, and build caches; the exclusion is verified by ignore-rule
  self-checks in `pnpm verify:transfer`.
- New/changed material is scanned for high-confidence secret signatures
  (private-key headers, cloud/GitHub key IDs, JWT-like and `sk-`-style tokens)
  and for absolute home paths as warnings.
- Historical evidence and `.planning/` provenance — which may contain
  maintainer-local absolute paths — are never transferred or committed.
- Fixture PNGs are project-generated, contain no third-party content, and carry
  a fixture-level provenance declaration only; that declaration is **not** a
  repository license grant.

Run before every commit:

```sh
pnpm verify:transfer --strict
```

## Access and disclosure boundary

- Repository access stays private and limited to authorized collaborators.
- No remote, push, registry publish, or other distribution happens without
  separate explicit owner authorization.
- Live/browser verification requires separate, authorized private access to the
  `FE-build` application checkout; this toolkit does not vendor product source.
- A privacy/rights finding or uncertain third-party provenance is a
  stop-and-escalate condition: do not commit, push, or transfer until resolved.
