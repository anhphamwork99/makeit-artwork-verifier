## Sub-features

- Select one or several Layouts.
- Create, rename, duplicate, arrange, move, hide, lock, and delete Layouts.
- Preserve the virtual Canvas Layout as a non-user board.
- Verify offscreen/culling behavior separately from persisted Layout existence.

## How to get to it (user POV)

Open `/artwork/editor`, click inside a visible Layout, then use the selected-Layout toolbar. `Create new layout` is the stable entry for the deterministic second Layout.

## Driving it with Playwright

Launch an owned skill run. Use bridge geometry for `layout-1`, click its verified hit point, and click the accessible `Create new layout` button. Expect a second ordinary Layout in content state and a visible `Layout #2`. Capture doctor data, action order, current Layout geometry, and a bounded screenshot.

## Gotchas

- The virtual Canvas Layout exists in state but is not an ordinary user board.
- Offscreen Layouts can be culled from Konva while remaining valid in content state.
- The current bottom Layout strip can render outside the viewport; use the selected-Layout toolbar.
- Stage zoom labels are not a coordinate oracle; use live Stage scale.

