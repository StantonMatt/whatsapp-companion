# Development

WhatsApp Companion is a Linux-first Electron + React + TypeScript desktop app around an isolated, persistent WhatsApp Web session. It adds searchable sticker metadata and discreet writing assistance without rebuilding the messaging client. Architecture decisions and the verification record are in [implementation notes](implementation.md); the original scope is in the [product brief](product-brief.md).

- [Run from source](#run-from-source)
- [Verify and package](#verify-and-package)
- [What the tests cover](#what-the-tests-cover)
- [Architecture notes](#architecture-notes)
- [Icon](#icon)
- [Releases](#releases)
- [CI](#ci)
- [Feature status](#feature-status)

## Run from source

Requires Node.js 22.12+ and npm. On Kubuntu, KWallet6 protects saved API keys. Chromium's sandbox remains enabled.

```bash
npm ci
npm run dev                  # build and open the real application
npm start                    # open an already-built application
npm run demo                 # separate local fixture; no WhatsApp or provider calls
```

Scan the QR code in the **application** with WhatsApp on your phone; see the [user guide](user-guide.md#link-your-phone).

- If Electron does not detect KDE correctly, start once with `npm start -- --password-store=kwallet6`. The secure backend is remembered when saving a key.
- For isolated development, use `npm start -- --data-dir=/absolute/test-directory`; packaged apps ignore this development flag. Demo data is separate and cannot access the real provider key.

## Verify and package

Linux desktop checks require `xvfb` (`sudo apt install xvfb`).

```bash
npm run build
npm test
npm run test:desktop                    # actual Electron with disposable fixture data
xvfb-run -a npm run test:desktop        # headless Linux
npm run package:dir                    # release/linux-unpacked on Linux
npm run package:linux                  # AppImage under release/
npm run package:win                    # run on Windows for NSIS
npm run package:mac                    # run on macOS for DMG
```

The unpacked Linux executable is `release/linux-unpacked/whatsapp-companion`. Distribution builds are unsigned. Do not disable Chromium's sandbox to work around host setup; use a properly installed package / host configuration.

## What the tests cover

Desktop tests never connect to WhatsApp or a provider. They exercise acceptance/dismissal, refinement, incoming/chat changes, simulated composition, keyboard behavior, renderer isolation, settings reset, sticker editing/search, animated picker lookup, stored-file sticker creation, explicit Send still and cancellation while finding/preparing, pause-and-edit races, native layout after resize/zoom/reload, and restart persistence.

Unit tests cover inheritance, style boundaries, staleness, persistence failure, provider contracts/errors, credential storage and automatic sending decisions/countdown cancellation. Automatic-send authorization expires within two seconds of main-process dispatch and before permitted hours end. Cancellation invalidates queued commands locally; immediately before clicking Send, the isolated preload also rechecks permission with main so a local-settings pause cannot be overtaken by queued work.

Fixture screenshots are written under ignored `.local/screenshots/`.

## Architecture notes

- WhatsApp fills the entire content area. Settings are a separate trusted native view overlaid beside the rail or at the right; they do not shrink WhatsApp. Resizing, maximizing and restoring update both views. Local controls keep a fixed zoom level. Reloading them closes the panel.
- The replaceable connector uses a narrow DOM contract. The optional direct sticker route additionally uses private WhatsApp modules; it is not a complete messaging SDK.
- The security design (process boundaries, IPC, keys and send authorization) is described in [Data and privacy](data-and-privacy.md#keys-and-security-design).

## Icon

The app icon is **Buddy**, a green chat bubble with a friendly face. Linux window and launcher icons, Windows ICO and macOS ICNS exports are included. See [icon assets and regeneration](../assets/README.md); `npm run icons:export` regenerates platform sizes from the saved master. Normal builds use the checked-in exports.

## Releases

This desktop application is distributed as a Linux AppImage; it has no hosted web deployment or automatic updater. Release artifacts contain application code and assets, never the development machine's account data, sticker library or API keys. Installing a release is described in the [user guide](user-guide.md#install-and-update).

To prepare a release:

1. Run the verification commands above and `npm run package:linux -- --publish never`. The local file is named `WhatsApp Companion-<version>.AppImage`.
2. Complete the repository's required review-fix-loop before committing or pushing.
3. Publish the reviewed commit on `main` and create the matching version tag.
4. Attach the AppImage and its SHA-256 checksum to the tag's GitHub release. GitHub stores the AppImage as `WhatsApp.Companion-<version>.AppImage` (the space becomes a dot); the v0.2.0 `SHA256SUMS` file lists that uploaded name.

The repository is public, so anyone can download releases. Releases are unsigned; Windows/macOS packages are not yet validated. A source push by itself does not deploy an update to installed applications.

## CI

CI runs through [GitHub Actions](https://github.com/StantonMatt/whatsapp-companion/actions); see [CI operation](ci.md).

## Feature status

Build, unit and desktop-fixture checks are recorded in [implementation notes](implementation.md). Account linking, live suggestion generation and Tab acceptance have been tested with a linked account on the current WhatsApp Web layout.

| Component | Implemented / verified | Remaining live validation |
| --- | --- | --- |
| Desktop / session | Sandboxed WebContentsView, dedicated persistent partition; linked personal session works | Extended reconnect testing |
| Composer | DOM adapter, ghost text, refinement, stale cancellation; live OpenAI continuation/empty reply, inline refinement, direct draft revision and Tab acceptance verified | Actual IMEs and broader layouts/languages |
| Stickers | Content hashes, persistent search terms, card editor/locator and guarded one-click native sticker sending; 95 indexed stickers visually tagged and given English/Spanish equivalents, including 67 animations; restart tested | Only observed stickers are searchable; future discoveries need their own terms |
| Providers | Real OpenAI Responses and Anthropic Messages adapters; timeout/cancellation/errors; live synthetic OpenAI check | Anthropic key/model access |
| Settings / style | Inheritance, persistence, local aggregate extraction, scope, reset, sparse fallback | Richer language/tone estimation beyond initial aggregate heuristics |
| Auto replies | Main-process permissions/budget and guarded dispatch; local rules/countdown tests | Live sending deliberately not tested against contacts |
| Packaging | Linux build and packaging commands; Windows/macOS targets configured | Windows/macOS builds/dialogs, signing/notarization |
