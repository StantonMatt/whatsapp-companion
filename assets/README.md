# Application icon

A familiar green chat bubble and handset, with a mint four-point sparkle completing the upper-right arc. The emerald-to-teal tile distinguishes Companion in launchers and taskbars. This is an independent application's icon, not an official WhatsApp asset.

- `icon-source.png`: original generated RGBA master, 1254 × 1254 pixels, with transparent corners and margin.
- `icons/`: Linux PNG exports from 16 to 512 pixels. The 512-pixel export is copied to `dist/icon.png` for the Electron window.
- `icon.ico`: Windows multi-resolution icon.
- `icon.icns`: macOS icon.

Run `npm ci`, then `npm run icons:export` after replacing the master. The script uses the electron-builder icon converter pinned by the project lockfile; its first run may download the converter. Exports preserve transparency and are included as source assets so normal builds need no image tools. Package configuration selects the corresponding platform export.

Generated with the built-in image-generation tool (`logo-brand`, new image, transparent background), September 28, 2026. The tool returned 1254 pixels despite the requested 1024; platform exports provide standard sizes. No provider key was used from this project.

## Generation prompt

```text
Use case: logo-brand
Asset type: finished desktop application icon for "WhatsApp Companion", a personal WhatsApp companion app.
Primary request: a beautiful, recognizable twist on the original WhatsApp logo, unique but immediately identifiable as related to WhatsApp.
Create ONE production-ready icon, not a presentation sheet or mockup. Square 1024 x 1024 canvas with true transparency outside the icon.
Design: a bold rounded-square emerald green app tile, centered with a small equal transparent margin. A crisp white circular speech-bubble outline with the familiar lower-left tail encloses a white diagonal telephone handset. Preserve the instantly recognizable WhatsApp visual language. The distinctive Companion twist is one clean four-point mint-white sparkle integrated into a small opening in the upper-right arc of the speech bubble, as though it completes the ring. The sparkle is intentional, balanced, and legible at small sizes, not a notification badge. The handset remains the dominant inner symbol.
Style: premium, minimal vector-like geometry, optically balanced, smooth curves, substantial strokes, restrained very subtle emerald-to-teal depth in the tile. Confident and uncluttered. Modern native desktop app icon.
Palette: rich WhatsApp-inspired emerald green, subtly deeper teal at the lower edge, white main mark and pale mint sparkle.
Constraints: no text, letters, watermark, extra icons, multiple bubbles, framing device or surrounding scenery. No phone/device mockup, no glossy plastic, no bevels, no busy details. No detached external badge. The entire tile fits within the canvas; corners and everything outside the rounded-square tile are genuinely transparent. This is the actual icon asset, front-on and straight, ready to use.
```
