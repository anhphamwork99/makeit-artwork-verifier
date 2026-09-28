# Current-state audit — maintain verification skills

**Date:** 2026-09-28
**Scope:** private Artwork verifier và FE consumer
**Method:** read-only source inspection plus focused setup/adapter/toolkit checks

## What already exists

- FE consumer có canonical agent-neutral `verify-artwork-editor` skill.
- `verify:artwork:setup` initializes pinned private submodule, installs toolkit
  dependencies và scaffolds requests/evidence/reports workspace.
- `verify:artwork:run` executes Diagnostic behavior, cleanup, evidence readback
  và friendly report.
- Toolkit có versioned Subject, Operation, Adapter, Workflow, Coverage,
  Correctness, Environment và Suite catalogues.
- Host compatibility preflight fail-closes bridge/provider drift.
- Evidence records bind source commit, dirty state, lockfile digest, registry
  fingerprints, candidate identity, outcome và cleanup.
- Toolkit và FE repositories đều có private writable `origin`; official FE
  `upstream` có push URL disabled.

## Maintenance gap

Không có một repository-local workflow nào thực hiện đầy đủ:

```text
current FE change
→ source/behavior delta
→ verification impact
→ catalogue/runtime/skill update
→ live proof and failure-boundary proof
→ verifier commit/push
→ FE gitlink/bridge/skill update
→ FE commit/push
```

Generic verification-maintenance guidance hiện có chỉ nhắm một skill directory;
nó không có authority để sửa private toolkit, FE provider/bridge, submodule
gitlink hoặc thực hiện two-repository transaction.

## Key risks the project must settle

1. **False completeness:** source diff không đồng nghĩa user-visible behavior
   coverage.
2. **Self-confirming verifier:** cùng một change vừa tạo expectation vừa tự
   chứng minh expectation mà không có independent authority.
3. **Repository split-brain:** FE gitlink có thể trỏ tới verifier commit chưa
   push hoặc verifier có thể assume FE provider chưa tồn tại.
4. **Unsafe automation:** broad edits/pushes có thể chạm official upstream,
   credentials hoặc product code ngoài verification boundary.
5. **Natural-language ambiguity:** agent có thể chọn Subject/Capability/Oracle
   thuận tiện thay vì đúng nhu cầu user.
6. **Regression masking:** maintenance workflow có thể sửa product để làm case
   PASS thay vì báo BUG.
7. **Recovery:** verifier push thành công nhưng FE update/build/push thất bại cần
   một recoverable state, không rewrite history tùy tiện.

## Confirmed immediate improvements

Current FE follow-up implements the bounded intake foundation:

- setup probes/installs Chromium and runs CLI smoke checks;
- capability inventory exposes representative/modelled/gap bindings;
- canonical skill accepts path, URL, inline JSON and natural-language input;
- every authored request requires static planning before browser launch;
- unsupported behavior produces a structured verification-gap report.

These improvements create inputs for the maintenance project; they do not
implement autonomous verifier maintenance.
