## Sub-features

- Undo and redo canvas mutations.
- Recover a newer local draft.
- Save a new Artwork.
- Update an existing Artwork.
- Reload persisted content.

## How to get to it (user POV)

Undo and Redo are in the bottom canvas toolbar. Save is in the top navigation. Draft recovery appears when a newer local draft conflicts with server content.

## Driving it with Playwright

For the deterministic no-backend recipe, perform a real drag, click visible Undo, verify the original content coordinates, click Redo, and verify the moved coordinates. Persistence recipes must use an owned backend fixture, verify the API side effect independently, reload `/artwork/editor/[id]`, and compare normalized content.

## Gotchas

- Camera, clipboard, and panel state are not undo snapshot content.
- Mutations auto-commit after a short debounce; gesture end commits explicitly.
- New-Artwork Save and existing-Artwork load require backend ownership and are outside the first proven slice.
- Never claim persistence from dirty-state or toast evidence alone.

