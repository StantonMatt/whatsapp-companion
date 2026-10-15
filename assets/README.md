# Buddy application icon

**Buddy** is a green chat bubble with a friendly face, its tail at the lower right and a white four-point glint in the upper-right corner. This is an independent application's icon, not an official WhatsApp asset.

The artwork is hand-made vector art: SVG written directly as code on a 1024-unit grid, authored with an AI design assistant (Claude) and chosen by the project owner, October 2026. No image-generation model, stock art, font, or WhatsApp artwork was used. `icon/buddy.svg` is the master. `icon/buddy-16.svg`, `icon/buddy-24.svg`, `icon/buddy-32.svg` and `icon/buddy-48.svg` are pixel-aligned versions with simplified details for small sizes. Every PNG is rendered from its SVG at its exact size with Playwright's Chromium (`scripts/render-icons.cjs`), and `icon.ico` packs those PNGs unchanged.

- `icon-source.png`: 1024 × 1024 RGBA master render with transparent corners.
- `icons/`: Linux PNG exports at 16, 24, 32, 48, 64, 128, 256 and 512 pixels. The build copies `512x512.png` to `dist/icon.png` for the Electron window.
- `icon.ico`: Windows icon containing the unchanged PNG frames at 16 through 256 pixels.
- `icon.icns`: macOS icon converted from the 1024-pixel master render.

The 16 and 24 px artwork fills the canvas intentionally. The 32 and 48 px artwork retains a 1 px margin. Do not downsample the master to replace these tuned exports.

After `npm ci`, install Playwright's browser with `npx playwright install chromium`, then run `npm run icons:export` from the repository root. This renders the master and all PNG sizes from the SVG sources, packs the ICO, and uses the lockfile-pinned electron-builder converter **only for ICNS**. Its first run may download the converter. Ordinary builds use the checked-in exports and need no image tools or browser download.

To render PNGs and ICO into a separate directory without running the ICNS converter:

```sh
node scripts/render-icons.cjs assets/icon /path/to/output
```

This writes `icon-1024.png`, the eight `NxN.png` files and `icon.ico`. To rebuild only ICNS, use `runIconsTool` from `app-builder-lib/out/toolsets/icons.js` with `inputFile: 'assets/icon-source.png'`, `outputFormat: 'icns'` and `outDir: 'assets'`. Do not use the converter's `set` or `ico` formats: they would replace the tuned SVG renders.

The tray uses the designer-approved `tray/tray-22.svg`, with `tray-22.png` at 1× and `tray-44.png` at 2×. Both PNGs are copied to `dist/` and loaded as native image representations; there are no unread or monochrome variants.
