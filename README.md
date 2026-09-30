# MakeIt Artwork Verifier

Private, installable correctness toolkit cho MakeIt Artwork Editor. Repository
này là nguồn authority duy nhất cho CLI, planner, browser runtime, catalogues,
cases, evidence integrity, agent skill và MakeIt FE Integration Kit.

- **Package:** `makeit-artwork-verifier@0.3.4`
- **Git distribution tag:** `v0.3.4`
- **Branch:** `main`
- **License:** `UNLICENSED` — private, không cấp quyền public distribution.
- **Current profile:** representative Diagnostic correctness cho frontend
  Artwork Editor.
- **Không claim:** exhaustive coverage, Release Credit, mobile, backend hoặc
  cross-browser.

## Start here

1. [`AGENTS.md`](AGENTS.md) — repository rules và ownership boundary.
2. [`integrations/makeit-fe/README.md`](integrations/makeit-fe/README.md) — cách
   maintainer tích hợp Host Adapter vào official frontend.
3. [`agents/verify-artwork-editor/SKILL.md`](agents/verify-artwork-editor/SKILL.md)
   — agent-neutral verification workflow.
4. [`agents/verify-artwork-editor/references/cold-agent.md`](agents/verify-artwork-editor/references/cold-agent.md)
   — cold-start và evidence interpretation.
5. [`.planning/maintain-verification-skills/PROJECT.md`](.planning/maintain-verification-skills/PROJECT.md)
   — maintenance Project Home.

## Kiến trúc hiện tại

```text
makeit-artwork-verifier repository
├── installable package: CLI/runtime/cases/evidence
├── canonical agent skill
└── integrations/makeit-fe/ Integration Kit
                │
                │ one-time reviewed patch
                ▼
MakeIT-POD/fe-editor
├── version-pinned verifier dependency
├── app-specific Host Adapter
└── FE-owned local evidence/report workspace
```

### Ownership

| Thành phần | Nơi sở hữu |
|---|---|
| CLI, planner, browser drivers, Oracles | verifier repository |
| Cases, catalogues, fixtures, evidence contracts | verifier repository |
| Agent skill và maintenance Project Home | verifier repository |
| Integration Kit và MR handoff | verifier repository |
| Artwork state/store mapping | official frontend Host Adapter |
| Product-meaning provider | official frontend Host Adapter |
| Read-only observation seam | official frontend Host Adapter |
| Product source và production build | official frontend |

Prototype `makeit-demo` chỉ lưu candidate review branch trong giai đoạn bàn
giao. Nó không còn là dependency, installation source hoặc runtime requirement.
Team member không cần clone prototype repository.

## Distribution

Hiện tại package được cài từ private Git tag vì chưa có package-registry release
được phê duyệt:

```json
{
  "devDependencies": {
    "makeit-artwork-verifier": "github:anhphamwork99/makeit-artwork-verifier#v0.3.4"
  }
}
```

`pnpm-lock.yaml` khóa tag thành exact commit. Package dùng immutable
`provenance/package-snapshot.json` để evidence integrity không phụ thuộc vào
`.git` metadata hoặc Git submodule trong consumer checkout.

Không publish package ra public registry. Nếu chuyển sang private registry sau
này, giữ nguyên package name, host contract và provenance gates.

## MakeIt FE Integration Kit

```text
integrations/makeit-fe/
├── README.md
├── compatibility.json
├── host-adapter.patch
├── verify-integration.mjs
└── MERGE_REQUEST.md
```

Maintainer áp dụng kit một lần vào official FE rồi tạo MR qua workflow của team.
Sau khi merge, mọi member nhận Host Adapter bằng `git pull` và verifier package
bằng `pnpm install --frozen-lockfile`.

```bash
node integrations/makeit-fe/verify-integration.mjs --app-root <FE-checkout>
```

Xem [Integration Kit README](integrations/makeit-fe/README.md) để có exact
baseline, commands, acceptance và rollback.

## Runtime flow

```text
User/Agent
→ FE wrapper
→ installed verifier package
→ pre-allocation host compatibility
→ static plan
→ owned Next.js + Chromium
→ read-only Host Adapter observations
→ durable evidence
→ independent evidence verify
→ friendly report
```

Live commands luôn nhận explicit product app root. Repository name, remote URL
hoặc checkout location không cấp compatibility. Host phải cung cấp:

- `productMeaningProvider` schema 1;
- profile `artwork-product-meaning-v1`;
- observation bridge version 7;
- declared capability descriptor.

Thiếu hoặc incompatible contract trả `HARNESS_BLOCKED` trước launch.

## Sử dụng trong official FE sau merge

```bash
pnpm install --frozen-lockfile
pnpm verify:artwork:setup
pnpm verify:artwork:host
pnpm verify:artwork:capabilities
pnpm verify:artwork:run --case <request.json>
pnpm verify:artwork:run --suite representative
```

Không cần:

- `git clone --recurse-submodules`;
- `.tooling/makeit-artwork-verifier`;
- `pnpm verify:artwork:install`;
- prototype checkout.

## Standalone development

Từ verifier repository:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm cli --help
pnpm cli --version
pnpm cli plan --case cases/diagnostic/requests/layer-text-move-drag-ordinary.json --out ./out/plan
pnpm cli diagnostic --case <request.json> --app-root <compatible-fe-checkout>
pnpm cli evidence verify --run <run-id>
```

No-FE surface gồm help, version, plan, portable tests và typecheck. Live
Diagnostic cần một authorized compatible FE checkout.

## Outcome model

| Outcome | Ý nghĩa |
|---|---|
| `PASS` | Behavior checks và durable evidence integrity cùng đạt |
| `BUG` | Native action chạy được nhưng product behavior sai expectation |
| `HARNESS_BLOCKED` | Thiếu trustworthy contract, fixture, target hoặc evidence |
| `ENVIRONMENT_FAILURE` | Package, browser, process, port, build hoặc runtime lỗi |
| `USAGE` | Argument hoặc request không hợp lệ |

Coverage là dimension riêng. Behavior PASS không cấp exhaustive coverage hoặc
Release Credit.

## Evidence ownership

Official FE wrapper bind generated artifacts vào ignored workspace:

```text
artwork-editor-verification/
├── evidence/{runs,suites}/
├── reports/
└── requests/
```

Chỉ kết luận **Đạt** khi behavior và independent evidence verification đều
`PASS`. Package-installed runs bind provenance bằng immutable package snapshot;
standalone verifier development runs tiếp tục dùng exact Git provenance.

## Production safety

Host Adapter chỉ hoạt động với explicit non-production verification gate.
Production-absence gate phải chứng minh:

- emitted artifact scan không có seam marker;
- browser initial/reload không có observation/setup globals hoặc Symbol slots;
- requested chunks đều map vào emitted output;
- exact owned cleanup hoàn tất.

Official FE Integration Kit thêm bounded `ARTWORK_VERIFY_DIST_DIR` support chỉ
cho `.next/verify-runs/<safe-id>`; normal production build không đổi `distDir`.

## Verification gates trước verifier commit

```bash
pnpm test
pnpm test:contract
pnpm test:refusal
pnpm typecheck
pnpm build:package-snapshot
pnpm verify:transfer --strict
node bin/verify-artwork.mjs --help
```

Khi thay đổi browser/runtime/host contract, chạy thêm Integration Kit host tests,
live representative proof, frontend build và production-absence.

## Change transaction

1. Hoàn thành verifier change và gates.
2. Tạo immutable private Git tag; không rewrite tag.
3. Update Integration Kit/package pin và compatibility metadata.
4. Build candidate từ exact official FE baseline.
5. Chạy host, focused, live, build và production-absence proofs.
6. Maintainer FE áp dụng kit và merge qua official review workflow.

Không update gitlink; kiến trúc active không còn Git submodule.

## Repository layout

```text
AGENTS.md
agents/verify-artwork-editor/                 # canonical skill
.agents/skills/verify-artwork-editor          # compatibility symlink
.planning/maintain-verification-skills/       # maintenance Project Home
integrations/makeit-fe/                       # official FE Integration Kit
bin/verify-artwork.mjs                        # package CLI
scripts/build-package-snapshot.mjs            # immutable package provenance
scripts/verify-transfer.mjs                   # privacy/inventory guard
src/                                          # toolkit implementation
tests/                                        # portable/browser/contract tests
cases/, catalogues/, fixtures/                # versioned inputs
governance/authorities/                       # immutable trust inputs
provenance/package-snapshot.json              # installed-package identity
```

Historical planning files may mô tả prototype/submodule architecture tại thời
điểm của chúng. Chúng là history, không phải current installation guidance.
Active guidance chỉ nằm trong README, AGENTS, canonical skill, cold-agent,
Integration Kit và current Project Home.
