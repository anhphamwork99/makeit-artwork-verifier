## Sub-features

- Shift-select several layers.
- Marquee select.
- Transform a multi-selection.
- Create an Object/Group from selected layers.
- Enter a group and select nested children.
- Ungroup while preserving visible geometry.

## How to get to it (user POV)

Open an Artwork containing at least two layers, select them with Shift or marquee, then use the Object/group controls shown for the selection.

## Driving it with Playwright

Create two layers through public UI, use native Shift-click or marquee input, and inspect selected semantic ids. For grouping, verify that the resulting Object node owns the original ids as children and that live Konva geometry remains visually stable.

## Gotchas

- Multi-selection is grouped by Layout; multi-Layout chrome is a separate path.
- Nested children use group-local coordinates.
- Double-click group entry performs hit testing in Object-local coordinates.
- This feature is mapped but not yet the canonical live proof.

