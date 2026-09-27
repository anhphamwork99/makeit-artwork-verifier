# Artwork Editor test-case contract (LEGACY — reference only)

> **Legacy document.** This file describes the archived Python driver's
> per-case JSON format (`id`, `fixture`, `action`, `expected`, `oracleDepth`,
> `evidence`). It is **not** the current CLI acceptance contract. The current
> Diagnostic Case Request schema lives in `references/cold-agent.md` and the
> checked-in examples under `cases/diagnostic/requests/`; the current CLI is
> `node bin/verify-artwork.mjs` (see `SKILL.md`). Kept only to explain the
> preserved legacy driver.

Use one JSON file per case. Keep the vocabulary close to visible Artwork behavior.

## Required shape

```json
{
  "id": "text-layer-drag",
  "title": "Drag a newly added text layer and preserve undo/redo",
  "fixture": {
    "route": "/artwork/editor",
    "layoutCount": 2,
    "layer": {
      "kind": "text",
      "creationAction": "Add text"
    }
  },
  "action": {
    "type": "drag",
    "delta": { "x": 80, "y": 40 }
  },
  "expected": {
    "minimumDelta": { "x": 40, "y": 20 },
    "undoRedo": true,
    "requireLiveKonvaMovement": true
  },
  "oracleDepth": ["content-state", "live-konva", "bounded-visual", "undo-redo"],
  "evidence": ["doctor", "actions", "bounded-screenshots", "diagnostics"]
}
```

## Meaning

- `fixture.route` must be `/artwork/editor` for the current deterministic no-backend flow.
- `fixture.layoutCount` currently supports `1` or `2`.
- `fixture.layer.kind` currently supports `text` in the proven driver.
- `fixture.layer.creationAction` must be the visible button label `Add text`.
- `action.type` currently supports `drag`.
- `action.delta` is the native pointer movement requested in CSS pixels.
- `expected.minimumDelta` is the minimum accepted change in Artwork Layout-local coordinates.
- `expected.undoRedo` requests visible Undo and Redo verification.
- `expected.requireLiveKonvaMovement` requires the mounted Konva node's viewport geometry to move.
- `oracleDepth` declares the evidence layers required by the case.
- `evidence` declares the durable bundle expected after cleanup.

## Classification

- An unmet declared expectation after the real action is `BUG`.
- A missing semantic element, no verified hit point, or bridge contract mismatch is `HARNESS_BLOCKED`.
- Launch/browser/runtime prerequisite failure is `ENVIRONMENT_FAILURE`.
- Only all declared expectations passing is `PASS`.

Do not add a new action or fixture field until a real mapped Artwork case proves that vocabulary is necessary.

