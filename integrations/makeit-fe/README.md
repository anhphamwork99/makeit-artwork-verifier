# MakeIt FE Artwork Verifier Integration Kit

Integration Kit này là artifact bàn giao một lần cho maintainer của
`MakeIT-POD/fe-editor`. Nó đưa Host Adapter vào official frontend và ghim
`makeit-artwork-verifier@v0.3.4` như một Git package dependency. Team member sau
khi merge chỉ cần làm việc trong official frontend; không cần prototype
repository và không cần Git submodule.

## Artifact

- `host-adapter.patch` — patch đầy đủ từ official baseline đã xác minh.
- `compatibility.json` — baseline, candidate, package và host-contract identity.
- `verify-integration.mjs` — kiểm tra static boundary và chạy focused host gates.
- `MERGE_REQUEST.md` — title/body/checklist sẵn để maintainer tạo MR.

## Ranh giới ownership

Verifier repository sở hữu CLI, browser runtime, cases, catalogues, evidence và
reporting. Official frontend chỉ sở hữu phần phụ thuộc trực tiếp vào product:

- product-meaning provider;
- read-only observation bridge và hook wiring;
- Artwork geometry/setup helpers cần product types;
- wrapper scripts bind app root/evidence root;
- package pin và production-safe `distDir` gate.

## Áp dụng vào official frontend

Bắt đầu từ exact baseline trong `compatibility.json`:

```bash
git clone https://github.com/MakeIT-POD/fe-editor.git
cd fe-editor
git checkout dev
git pull --ff-only
git checkout -b feat/artwork-verifier-host

git apply --check /path/to/makeit-artwork-verifier/integrations/makeit-fe/host-adapter.patch
git apply /path/to/makeit-artwork-verifier/integrations/makeit-fe/host-adapter.patch
pnpm install --frozen-lockfile
```

Nếu `dev` đã tiến xa khỏi baseline, không dùng `git apply --3way` một cách mù
quáng. Maintainer phải review conflict theo ownership table phía trên, giữ host
contract và chạy lại toàn bộ gates.

## Xác minh bắt buộc

```bash
node /path/to/makeit-artwork-verifier/integrations/makeit-fe/verify-integration.mjs \
  --app-root "$PWD"

pnpm exec vitest run \
  src/lib/artwork/verification/__tests__/affineProjection.test.ts \
  src/lib/artwork/verification/__tests__/nestedObjectGeometry.test.ts \
  src/lib/artwork/verification/__tests__/rasterEvidence.test.ts \
  src/lib/artwork/verification/__tests__/geometryProjection.test.ts \
  src/lib/artwork/__tests__/artworkVerificationBridge.test.ts \
  src/lib/artwork/verification/__tests__/artworkSetupBoundary.test.ts

pnpm verify:artwork:run \
  --case cases/diagnostic/requests/layer-text-move-drag-ordinary.json

pnpm build
pnpm verify:artwork production-absence --app-root "$(pwd -P)"
```

Acceptance:

- adapter tests PASS;
- host doctor PASS trước browser allocation;
- 137 focused product/geometry tests PASS;
- live Text move có behavior PASS và evidence integrity PASS;
- production build PASS;
- hostile production-absence PASS, không có verifier seam trong output/browser;
- cleanup hoàn tất và working tree chỉ chứa thay đổi dự kiến.

## Team member sau khi merge

```bash
git pull
pnpm install --frozen-lockfile
pnpm verify:artwork:setup
pnpm verify:artwork:host
pnpm verify:artwork:run --case <request.json>
```

Không chạy setup submodule, không clone `makeit-demo`, không sửa code bên trong
`node_modules/makeit-artwork-verifier`.

## Update và rollback

Update verifier bằng một frontend dependency PR riêng: đổi Git tag, cập nhật
lockfile, chạy lại gates. Rollback bằng cách revert frontend MR hoặc trả package
pin về tag trước; không rewrite tag verifier đã phát hành.
