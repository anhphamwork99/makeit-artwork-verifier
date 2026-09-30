# Maintain Verification Skills

**Owner:** Product Owner
**Tracker:** local Markdown
**Lifecycle:** Approved implementation
**Current phase:** Integration Kit maintenance
**Status:** active

## Purpose

Thiết kế và duy trì workflow để verifier tiến hóa an toàn khi Artwork Editor có
behavior mới hoặc thay đổi. Workflow phải phân biệt rõ:

```text
verifier package change
→ private immutable tag
→ Integration Kit/Host Adapter impact
→ exact official-baseline candidate
→ live + failure + production-absence proof
→ maintainer-owned official FE merge
```

Project này khác với việc chạy một Diagnostic case. Runtime verification tiếp
tục fail-closed; Project Home này điều phối cách contracts, package, skill và
Host Adapter được maintain.

## Accepted architecture

- Verifier repository là nguồn duy nhất cho engine, cases, catalogues, evidence,
  skill và Integration Kit.
- Official `MakeIT-POD/fe-editor` sở hữu app-specific Host Adapter.
- Verifier được phân phối bằng private immutable Git tag qua
  `package.json`/`pnpm-lock.yaml`; không dùng submodule/gitlink.
- `integrations/makeit-fe/` là handoff authority cho official frontend.
- Team member không cần prototype repository.
- Workspace hiện tại vẫn coi `MakeIT-POD/*` là read-only; maintainer FE mới là
  người áp dụng kit, tạo/review/merge MR vào official repo.
- Candidate có thể được đẩy lên authorized prototype branch để review artifact,
  nhưng prototype không phải consumer authority hoặc runtime dependency.
- Compatibility dựa trên versioned provider/bridge/capability contract, không
  dựa repository name, remote URL hoặc path.
- Product code không sửa chỉ để verifier PASS.
- Unsupported behavior tạo verification gap, không suy diễn thành BUG/PASS.

## Primary repositories

| Responsibility | Repository/workspace | Branch |
|---|---|---|
| Package, runtime, cases, Integration Kit | repository này | `main` + immutable tags |
| Canonical product host | `MakeIT-POD/fe-editor` | `dev`, maintainer-owned merge |
| Review candidate transport | `anhphamwork99/makeit-demo` | dedicated exact-baseline branch only |
| Product decisions/historical acceptance | MakeIt docs repository | `main` |

## Active implementation

Current delivered artifacts:

- `integrations/makeit-fe/README.md`;
- `integrations/makeit-fe/compatibility.json`;
- `integrations/makeit-fe/host-adapter.patch`;
- `integrations/makeit-fe/verify-integration.mjs`;
- `integrations/makeit-fe/MERGE_REQUEST.md`;
- package-installed immutable provenance support.

The previous
[`official-canonical-host-migration.md`](plans/official-canonical-host-migration.md)
is a completed historical migration plan. Its submodule/gitlink steps are
superseded by this Project Home and must not be used as current instructions.

## Maintenance deliverables

1. Source delta và behavior-impact map.
2. Verifier package changes with portable/failure tests.
3. Immutable package snapshot và private Git tag.
4. Updated Integration Kit patch + compatibility metadata + MR body.
5. Exact official-baseline frontend candidate.
6. Host contract, focused product tests, live case, evidence integrity, build và
   production-absence proof.
7. Recovery/rollback instructions and owner-facing report.

## Required gates

Verifier:

```bash
pnpm test
pnpm test:contract
pnpm test:refusal
pnpm typecheck
pnpm build:package-snapshot
pnpm verify:transfer --strict
```

Official FE candidate:

```bash
pnpm install --frozen-lockfile
node <verifier>/integrations/makeit-fe/verify-integration.mjs --app-root "$PWD"
pnpm test:verify:adapter
pnpm verify:artwork:run --case <representative-case>
pnpm build
pnpm verify:artwork production-absence --app-root "$(pwd -P)"
```

## Non-goals

- Không thay Product discovery.
- Không tự sửa product regression.
- Không push/merge official upstream từ workspace read-only.
- Không deploy Vercel/Railway.
- Không publish public package.
- Không cấp Release Credit hoặc exhaustive coverage.
- Không duy trì secondary submodule consumer.

## Routing

Project được truy cập qua file này. Active integration instructions nằm trong
`integrations/makeit-fe/README.md`. Historical plans/decisions chỉ cung cấp
provenance; khi mâu thuẫn với current Project Home, current architecture thắng.
