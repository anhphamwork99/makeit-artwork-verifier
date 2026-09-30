# Maintain Verification Skills

**Owner:** Product Owner
**Tracker:** local Markdown
**Lifecycle:** Approved implementation
**Current phase:** official-host migration
**Status:** active

## Purpose

Thiết kế một maintenance workflow để agent có thể nhận yêu cầu “cập nhật
verification cho tính năng Artwork mới”, tự xác định source delta, đánh giá
verification impact, cập nhật đúng repository, chứng minh behavior/failure
surfaces, rồi commit và push an toàn vào các prototype origins.

Project này tách riêng khỏi việc chạy một Diagnostic test case. Runtime
verification hiện tại tiếp tục fail-closed; project này xác định cách verifier
được mở rộng khi Product thay đổi.

## Destination

Một engineering specification được Product Owner phê duyệt, đủ rõ để triển
khai repository-local, agent-neutral maintenance skill với:

1. baseline và current-source identity rõ ràng;
2. source-delta discovery và behavior-impact map;
3. verification-gap intake từ file, URL và natural-language test case;
4. update compiler cho catalogue, request, adapter, workflow, fixture, Oracle,
   evidence contract và user-facing skill;
5. verification gates cho toolkit và FE host;
6. atomic two-repository commit/push transaction với rollback/recovery;
7. owner-facing report phân biệt clean, changed và blocked.

## Accepted boundaries

- FE prototype checkout đã tồn tại; maintenance workflow không clone FE.
- Workflow mới không phụ thuộc Pi. Canonical skill contract là agent-neutral.
- Official `MakeIT-POD/*` repositories luôn read-only.
- Verifier changes chỉ push vào
  `anhphamwork99/makeit-artwork-verifier:main`.
- Official `MakeIT-POD/fe-editor:dev` là canonical target host. Vì official
  remote là read-only trong workspace này, implementation candidate được xây
  trên exact `upstream/dev` và chỉ push tới một branch của
  `anhphamwork99/makeit-demo`; team áp dụng candidate bằng official review/merge
  workflow của họ.
- `anhphamwork99/makeit-demo:main` tiếp tục là secondary consumer trong giai
  đoạn chuyển đổi và không còn là compatibility authority duy nhất.
- Compatibility được xác định bằng versioned host contract, không bằng
  repository name, remote URL hoặc machine-local checkout path.
- Product code không được sửa chỉ để làm verification PASS.
- Unsupported hoặc ambiguous behavior tạo verification gap; không được suy
  diễn thành PASS hay product BUG.
- Release Credit, deployment và production-safety claim nằm ngoài destination
  của project này.

## Primary repositories

| Responsibility | Repository/workspace | Branch |
|---|---|---|
| Verifier CLI, catalogues, runtime, cases, tests | repository này (`anhphamwork99/makeit-artwork-verifier`) | `main` |
| Canonical FE host target | `MakeIT-POD/fe-editor` | `dev`, read-only source; team-owned merge |
| Official-host implementation candidate | `anhphamwork99/makeit-demo` | dedicated branch based on exact `upstream/dev` |
| Secondary FE consumer | `anhphamwork99/makeit-demo` | `main` |
| Project decisions/specification | `.planning/maintain-verification-skills/` trong repository này | `main` |

## Active implementation

[Official canonical host migration plan](plans/official-canonical-host-migration.md)

## Required deliverables

1. Wayfinding decision map được giải quyết hoàn chỉnh.
2. Normative maintenance specification.
3. Architecture và repository transaction contract.
4. Machine-readable maintenance result/gap schemas.
5. Work Packages có exact write sets và verification commands.
6. Independent review criteria và recovery/rollback playbook.

## Current evidence

- [Current maintenance gap](research/current-maintenance-gap.md)
- [Wayfinding map](wayfinding/map.md)
- [Decision tickets](wayfinding/issues/)

## Non-goals

- Không thay thế Product feature discovery.
- Không tự sửa product regressions.
- Không tự thay đổi official upstream.
- Không deploy Vercel/Railway.
- Không cấp Release Credit.
- Không hứa exhaustive test generation cho behavior chưa có observable
  contract.

## Routing

Project được truy cập qua file này trong private verifier repository. Wayfinding
map chỉ là index các decision tickets; implementation tickets và specification
sẽ được thêm sau khi frontier đã được giải quyết. Không duy trì một Project Home
cạnh tranh trong FE hoặc MakeIt planning repository.
