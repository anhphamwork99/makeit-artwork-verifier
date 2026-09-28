# MakeIt Artwork Editor verification feature map

**Product:** MakeIt Artwork Editor
**Primary surface:** desktop web editor
**Live harness:** Playwright Chromium plus the read-only development verification bridge

| Feature | User goal | Public entry point | Primary proof |
|---|---|---|---|
| [Layout management](layout-management.md) | Create, select, move, duplicate, arrange, and delete Layouts | `/artwork/editor` and selected-Layout toolbar | Visible Layout state plus content/Konva geometry |
| [Text layer creation and editing](text-layer-creation.md) | Add text and edit its visible design/personalization properties | Text tool → `Add text` | Selected Text layer plus visible property panels |
| [Layer selection and transform](layer-selection-transform.md) | Select, drag, resize, rotate, and move a layer across Layouts | Artwork canvas | Native pointer action plus content/Konva/visual evidence |
| [Multi-selection and grouping](multi-selection-grouping.md) | Select several layers, transform them together, and create/edit an Object/Group | Artwork canvas and Object controls | Selection membership, group tree, geometry, visible result |
| [Undo, redo, drafts, and persistence](undo-redo-persistence.md) | Recover or persist Artwork changes without losing content | Canvas toolbar and Save | State reversal/replay, draft/API side effects where applicable |

## Global prerequisites and isolation

- Run from `FE-build`.
- Node.js `>=20.11 <25`, pnpm 10, and installed Playwright Chromium are required.
- Use the skill helper so the port, process group, browser context, and scratch directory are owned.
- `/artwork/editor` is the deterministic no-backend fixture route.
- Existing-Artwork and Save recipes require separately owned backend data and are not covered by the first proof.
- Do not attach to a shared server.

