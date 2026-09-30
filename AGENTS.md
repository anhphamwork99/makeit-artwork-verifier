# AGENTS.md — MakeIt Artwork Verifier

Entry contract cho mọi agent harness làm việc trong repository này.

## Mục tiêu

Repository sở hữu:

1. installable verifier package cho Artwork Editor Diagnostic correctness;
2. agent-neutral skill để chạy và diễn giải verification;
3. MakeIt FE Integration Kit để maintainer tích hợp Host Adapter vào official
   frontend;
4. maintenance workflow để cập nhật contracts/runtime khi Product thay đổi.

Không claim exhaustive coverage, Release Credit, backend, mobile hoặc
cross-browser.

## Authority

Đọc theo thứ tự:

1. `AGENTS.md`;
2. `README.md`;
3. `integrations/makeit-fe/README.md` cho frontend integration;
4. `agents/verify-artwork-editor/SKILL.md`;
5. `agents/verify-artwork-editor/references/cold-agent.md`;
6. `.planning/maintain-verification-skills/PROJECT.md`;
7. `governance/authorities/` — immutable reviewed trust inputs.

Nếu conflict, dừng và báo rõ; không chọn authority thuận tiện.

## Current architecture

### Verifier repository

Writable target:

```text
https://github.com/anhphamwork99/makeit-artwork-verifier.git
branch: main
```

Sở hữu CLI, runtime, contracts, catalogues, cases, fixtures, evidence integrity,
skill, package provenance và Integration Kit.

### Official FE host

`MakeIT-POD/fe-editor:dev` sở hữu product code và app-specific Host Adapter:
provider, bridge, geometry/setup helpers, wrapper scripts và production-safe
wiring. Team member nhận Host Adapter qua official Git history và verifier qua
normal package install.

Official repository là read-only trong workspace này. Không push, force-push
hoặc tự mở prototype PR/MR vào `MakeIT-POD/*`. Candidate được xây từ exact
official baseline, đẩy tới authorized prototype branch chỉ để handoff; maintainer
FE áp dụng `integrations/makeit-fe/` qua workflow chính thức.

Prototype `makeit-demo` không phải installation dependency hay runtime
requirement.

## Package distribution

Active consumer contract:

```text
makeit-artwork-verifier private Git tag
→ package.json + pnpm-lock.yaml
→ pnpm install --frozen-lockfile
```

Không dùng Git submodule, gitlink hoặc `.tooling/makeit-artwork-verifier` trong
active architecture. Không publish public registry; `UNLICENSED` không cấp
quyền phân phối.

Mỗi release tag phải:

- immutable;
- giữ package/skill/source version parity;
- có current `provenance/package-snapshot.json`;
- cài được không cần lifecycle-script approval;
- pass portable contract/refusal/typecheck/transfer gates.

## Skill convention

- Canonical skill: `agents/verify-artwork-editor/SKILL.md`.
- Compatibility projection: `.agents/skills/verify-artwork-editor` →
  `../../agents/verify-artwork-editor`.
- Không tạo active `.pi` skill.
- Skill chỉ chứa instruction/reference; executable source nằm ở package root.

## Bắt buộc

### 1. Không duplicate product meaning

- Live command nhận explicit `--app-root`.
- Không infer adjacent checkout hoặc repository identity.
- Không vendor/reimplement product normalization, canonicalization, fingerprint
  hoặc Crossword core.
- Product code không được sửa chỉ để làm verification PASS.

### 2. Fail closed

Closed outcomes: `PASS`, `BUG`, `HARNESS_BLOCKED`, `ENVIRONMENT_FAILURE`,
`USAGE`. Verification gap là maintenance input, không phải product outcome.
Planning PASS không chứng minh behavior PASS.

### 3. Evidence và provenance

- Browser behavior dùng native input; Host Adapter chỉ đọc.
- Mỗi run bind candidate, application source, environment, scope, cleanup và
  verifier identity.
- Standalone development checkout dùng Git provenance.
- Installed package dùng immutable package snapshot và hash-check từng governed
  file; không phụ thuộc `.git` metadata trong `node_modules`.
- Behavior chỉ được gọi PASS khi independent evidence verification PASS.
- Generated/historical `evidence/` không commit vào verifier repository.

### 4. Exact ownership và cleanup

Chỉ cleanup exact process group, port, scratch root, distDir và app root đã ghi
nhận. Không kill theo process name, broad port sweep hoặc shared server.

### 5. Integration Kit

Current kit: `integrations/makeit-fe/`.

Khi Host Adapter/package contract đổi:

1. verifier change + tests;
2. immutable private tag;
3. update kit patch/metadata/docs/MR body;
4. clean official-baseline candidate;
5. adapter + focused + live + build + production-absence proofs;
6. maintainer FE review/merge.

Không để kit trỏ tag chưa push. Không dùng patch conflict resolution mù quáng.

### 6. Security/privacy

- Không commit `.env*`, credential, token, private key, dependency tree, cache
  hoặc generated evidence.
- Sanitize URL credential/query/fragment và private document body.
- Chạy `pnpm verify:transfer --strict` trước verifier commit.
- Không public package/repository hoặc thêm collaborator nếu chưa có owner
  authorization.

## Development gates

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm test:contract
pnpm test:refusal
pnpm typecheck
pnpm build:package-snapshot
pnpm verify:transfer --strict
node bin/verify-artwork.mjs --help
```

Browser/runtime/host changes phải có focused live proof và failure/diagnostic
surface. Integration changes phải chạy exact commands trong
`integrations/makeit-fe/README.md`.

Trước push:

```bash
git diff --check
git status --short
git remote -v
```

Push verifier chỉ tới private `origin/main` và immutable tags.

## Planning boundary

Tracked planning duy nhất dưới `.planning/` là:

```text
.planning/maintain-verification-skills/
```

Các planning/provenance khác phải ignored. Historical files có thể mô tả
submodule/prototype architecture trước đây; không sửa history để giả vờ quyết
định đó chưa từng tồn tại. Active docs phải chỉ rõ nó đã superseded.

## Không được làm

- Không sửa/push official upstream.
- Không dùng prototype repo làm prerequisite cho team.
- Không reintroduce submodule distribution.
- Không sửa installed package trong `node_modules`.
- Không bịa Oracle/authority để chạy unsupported case.
- Không rewrite release tag hoặc immutable governance input.
- Không deploy Vercel/Railway từ verifier repository.
- Không mở rộng claim ngoài evidence thực tế.
