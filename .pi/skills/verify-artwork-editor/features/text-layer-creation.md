## Sub-features

- Add plain Text.
- Add template Text.
- Enter text editing.
- Configure design and personalization properties.
- Apply plain, Circle, Distort, Wave, or Wrap rendering paths.

## How to get to it (user POV)

Open `/artwork/editor`, select a Layout, click the `Text` tool, then click `Add text` or a named template.

## Driving it with Playwright

Use public UI fixture steps. After `Add text`, wait for bridge idle, resolve `{ "kind": "text", "selected": true }`, and require exactly one result. Verify the Text property panel is visible and capture the generated live id for subsequent actions.

## Gotchas

- Generated ids are intentionally not known before creation.
- Text measurement and fonts can affect frame geometry; wait for `document.fonts.ready` and stable frames.
- Warp types use different Konva overlays and transform behavior.
- A selected Text layer can retain an optimistic-selection id while otherwise idle; stable content and inactive gestures are the readiness oracle.

