# AGENTS.md — MakeIt Artwork Verifier

File này là entry contract cho mọi agent harness làm việc trong repository.
Không giả định Pi, Claude, Codex hoặc một host cụ thể.

## Mục tiêu repository

Xây dựng và duy trì:

1. **skills** để agent có thể hiểu, chạy và diễn giải verification cho Artwork
   Editor;
2. **tools** để static-plan, chạy browser behavior, phân loại outcome, kiểm tra
   evidence và cleanup tài nguyên do verifier sở hữu;
3. **maintenance workflow** để verifier tiến hóa an toàn khi Artwork Editor có
   behavior mới hoặc thay đổi.

Phạm vi hiện tại là **Diagnostic correctness** cho frontend Artwork Editor trên
environment cell đã khai báo. Repository không cấp Release Credit, không chứng
minh exhaustive coverage, không đại diện cho backend, mobile, cross-browser
hoặc production safety.

## Nguồn authority

Đọc theo thứ tự:

1. `AGENTS.md` — repository-wide rules và routing.
2. `README.md`, `CONTRIBUTING.md`, `SECURITY.md` — package, contribution và
   security boundaries.
3. `agents/verify-artwork-editor/SKILL.md` — cách agent chạy verification.
4. `agents/verify-artwork-editor/references/cold-agent.md` — cold-start runbook.
5. `.planning/maintain-verification-skills/PROJECT.md` — Project Home cho việc
   thiết kế maintenance workflow.
6. `governance/authorities/` — immutable reviewed trust inputs; không rewrite để
   làm test pass.

Nếu các nguồn mâu thuẫn, dừng và báo rõ conflict; không tự chọn authority thuận
tiện.

## Convention cho skills

- Canonical, agent-neutral skill:
  `agents/verify-artwork-editor/SKILL.md`.
- Cross-harness compatibility projection:
  `.agents/skills/verify-artwork-editor` →
  `../../agents/verify-artwork-editor`.
- Không tạo lại `.pi/skills/verify-artwork-editor`.
- Không đặt executable source, tests, cases, catalogues, fixtures, evidence
  hoặc planning artifacts bên trong skill. Skill chỉ chứa instruction và
  reference cần thiết để invoke toolkit.
- Harness không hỗ trợ skill discovery phải đọc canonical `SKILL.md` trực tiếp.

## Repository boundaries

### Private verifier — repository này

Sở hữu CLI, runtime, contracts, catalogues, cases, tests, trust authorities và
canonical standalone verification skill.

Writable delivery target:

```text
https://github.com/anhphamwork99/makeit-artwork-verifier.git
branch: main
```

### FE consumer

FE prototype sở hữu product code, verification bridge/provider, consumer
adapter, user-facing skill và gitlink pin tới repository này.

```text
https://github.com/anhphamwork99/makeit-demo.git
branch: main
common local workspace: ../makeit/FE-build
```

Repository official `MakeIT-POD/*` là read-only upstream. Không commit, push,
open prototype PR hoặc sửa history của official repositories.

## Quy tắc bắt buộc

### 1. Không duplicate product meaning

- Live Diagnostic phải nhận explicit `--app-root`.
- Không infer adjacent checkout.
- Không import trực tiếp product modules vào portable toolkit.
- Không vendor, reimplement hoặc shim normalization, canonicalization,
  fingerprint hoặc Crossword product core.
- Product code không được sửa chỉ để làm verification PASS.

### 2. Fail closed và phân loại trung thực

Outcome hiện hành:

- `PASS`
- `BUG`
- `HARNESS_BLOCKED`
- `ENVIRONMENT_FAILURE`
- `USAGE`

Verification gap là maintenance input, không phải product outcome. Thiếu
Subject/Capability/Scenario/Workflow/Fixture/Oracle authority thì không launch
browser và không suy diễn thành PASS hoặc BUG.

Planning PASS chỉ chứng minh case có launch contract; nó không chứng minh
behavior đã PASS.

### 3. Evidence và cleanup

- Browser action phải dùng native user input trên real product behavior.
- Observation bridge chỉ đọc; không dùng bridge để mutate Artwork state.
- Mỗi run phải bind candidate, source, environment, scope, coverage và cleanup.
- Chỉ kết luận behavior PASS khi required checks và independent evidence
  verification đều PASS.
- Cleanup chỉ được tác động exact process group, port, scratch root và app root
  đã ghi nhận. Không kill theo process name, broad port sweep hoặc shared dev
  server.
- Generated/historical `evidence/` không được commit vào repository này.
- Legacy `.pi/skills/verify-artwork-editor` path chỉ được chấp nhận khi đọc
  historical records; nó không phải active skill authority.

### 4. Planning boundary

Tracked planning duy nhất được phép dưới `.planning/` là:

```text
.planning/maintain-verification-skills/
```

Đây là Project Home để thiết kế workflow maintain skills và tools. Extraction
inventory, machine-local provenance và planning khác vẫn phải ignored. Không nới
allowlist `.planning` thành wildcard.

### 5. Security và privacy

- Không commit `.env*`, token, credential, private key, dependency tree, cache
  hoặc machine-local absolute path khi có thể tránh.
- Không persist URL credentials, query, fragment hoặc private document body vào
  case, evidence hay report.
- Không publish package; `UNLICENSED` không cấp quyền phân phối.
- Chạy `pnpm verify:transfer --strict` trước commit.

### 6. Two-repository transaction

Khi verifier change yêu cầu FE pin/adapter change:

1. hoàn thành và verify verifier;
2. commit + push verifier `origin/main`;
3. update FE gitlink đúng pushed commit;
4. verify FE setup, adapter, typecheck và behavior/failure surface liên quan;
5. commit + push FE `origin/main`.

Không để FE gitlink trỏ tới verifier commit chưa push. Không force-push hoặc
rewrite history để recovery. Nếu phase sau fail, giữ commit phase trước và báo
recoverable state.

## Workflow phát triển

Prerequisites:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Minimum verification trước commit:

```bash
pnpm test
pnpm test:contract
pnpm test:refusal
pnpm typecheck
pnpm verify:transfer --strict
node bin/verify-artwork.mjs --help
```

Change browser/runtime behavior phải chạy focused live proof bằng authorized FE
checkout, đồng thời kiểm tra ít nhất một expected failure/diagnostic surface.
Compile hoặc typecheck đơn lẻ không phải Definition of Done.

Trước push:

```bash
git diff --check
git status --short
git remote -v
```

Push chỉ tới `origin/main` của private verifier sau khi target đã được xác nhận.

## Maintenance project

Project Home:

```text
.planning/maintain-verification-skills/PROJECT.md
```

Project hiện đang ở discovery/wayfinding. Nó thiết kế workflow để biến:

```text
FE source/behavior delta
→ verification impact
→ catalogue/runtime/skill update
→ live proof + failure-boundary proof
→ verifier commit/push
→ FE gitlink/bridge/skill update
→ FE commit/push
```

Không claim maintenance skill đã implemented trước khi Project Home có
engineering specification được owner phê duyệt và implementation gates đã
pass.

## Không được làm

- Không sửa official upstream.
- Không sửa product để che regression.
- Không thêm unsupported case bằng cách bịa Oracle hoặc authority.
- Không rewrite immutable governance inputs hoặc historical evidence.
- Không di chuyển prototype code vào repository này.
- Không deploy Vercel/Railway từ repository này.
- Không mở rộng scope claim ngoài evidence thực tế.
