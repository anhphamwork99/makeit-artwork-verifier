## Sub-features

- Click selection and Shift multi-selection.
- Drag within a Layout.
- Cross-Layout movement and virtual Canvas movement.
- Resize and rotate with selection chrome.
- Locked/hidden behavior.
- Nested child transforms inside Object/Group.

## How to get to it (user POV)

Create or load an Artwork with a visible layer, then click the layer on the canvas and manipulate its selection frame.

## Driving it with Playwright

Resolve the semantic layer through the bridge, request its live geometry, and require a verified hit point. Use native `mouse.down`, stepped `mouse.move`, and `mouse.up`. Assert current content coordinates, live Konva viewport geometry, bounded before/after pixels, and requested undo/redo.

The proven recipe is `cases/text-layer-drag.json`.

## Gotchas

- Never guess coordinates from stored Layout-local values alone.
- Nested Object children require ancestor transforms.
- Culling can make a valid content node unmounted.
- Transparent or irregular layers need a verified hit point, not only a bounding-box center.
- The legacy `scenegraphNodes` mirror can lag coordinate-only updates; retain that diagnostic without replacing content and live-Konva oracles.

