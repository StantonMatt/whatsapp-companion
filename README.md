# WhatsApp Companion

A Linux-first Electron + React + TypeScript desktop app around an isolated, persistent WhatsApp Web session. It adds searchable sticker metadata and discreet writing assistance without rebuilding the messaging client. This is an independent project, not an official WhatsApp or Meta application.

The first functional implementation is available. Build, unit and desktop-fixture checks are recorded in [implementation notes](docs/implementation.md). Linked-account suggestion generation and Tab acceptance have been tested on the current WhatsApp Web layout; remaining limits are listed below.

## Run

Requires Node.js 22.12+ and npm. On Kubuntu, `kdialog` handles API-key entry and KWallet6 protects saved keys. Chromium’s sandbox remains enabled.

```bash
npm ci
npm run dev                  # build and open the real application
npm start                    # open an already-built application
npm run demo                 # separate local fixture; no WhatsApp or provider calls
```

Scan the QR code in the **application** with WhatsApp on your phone. Its session is separate from Chrome and Whatsie. No browser cookies or unrelated credentials are imported. Account linking and live suggestions have been verified. The current WhatsApp Web layout uses opaque message IDs. Companion recognizes observed conversations locally so reply and style overrides work; automatic sending still requires a WhatsApp peer identifier.

Open the **AI settings** gear in the left sidebar, then **Providers**. Select OpenAI or Anthropic and add your own key through the OS password dialog. **Model ID** shows a short list of current general-purpose text models available to your key: GPT-6 Astra, Sol and Luna for OpenAI; Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5 for Anthropic. Older generations, specialist models and duplicate dated snapshots are excluded. **Refresh models** checks account availability again. A saved model outside this list is retained in your configuration and identified separately until you choose a current model. Selections are saved separately for each provider; new installations default to GPT-6 Luna and Claude Sonnet 5.5. Model-list access requires Models read permission on restricted keys.

The **Reasoning effort** slider saves separately for each model and applies to suggestions, refinements and connection checks. Luna/Sol offer None through Max; Astra and current Claude reasoning models offer Low through Max. Haiku has no adjustable effort. The initial setting favors speed: None for Luna/Sol and Low for reasoning models. Higher effort can take longer and use more tokens. **Test connection** sends synthetic text with the selected model and effort. A dedicated OpenAI key is securely configured on the development machine and has passed live checks. No key is included in this repository or packages. Anthropic has request/response fixture coverage but no live-key test yet.

Saved credentials require working OS encryption (KWallet/Secret Service on Linux, Keychain on macOS, DPAPI on Windows). A session-only option keeps the key in main-process memory. The app refuses `basic_text`. If Electron does not detect KDE correctly, start once with:

```bash
npm start -- --password-store=kwallet6
```

The secure backend is remembered when saving a key. Native key entry on Windows/macOS is implemented but not tested on those systems.

## Use

The Companion top bar is gone. **Sticker library** and **AI settings** live in WhatsApp’s left navigation rail. Global settings open over the chat list; the **Chat AI settings** sliders button in each conversation header opens a right-hand panel for that chat. Panels follow the WhatsApp light/dark appearance. Use the back arrow or Escape to close them. **Companion → AI settings** (Ctrl+,) remains available before linking or when navigation cannot be detected.

Settings dropdowns follow the same theme, with padded options, selected checkmarks and consistent row spacing. Arrow keys and typing navigate options; Enter selects. Escape closes an open dropdown first, then the settings panel on a second press.

- **Suggestions:** enable context sharing and inline suggestions for the desired scope in AI settings → Replies. An empty composer prepares a reply as soon as the chat is ready; a partial draft gets a continuation after a short typing pause. Suggestions stay visible when you click, scroll or switch focus. Focus the composer with the caret at the end to accept with Tab. Tab accepts without sending; Escape dismisses. Normal Tab navigation returns without a suggestion. Shift+Tab, Enter, Shift+Enter and input methods retain their roles. Typing, message changes, chat changes, composer replacement and input-method composition invalidate stale suggestions; ordinary focus or caret movement does not restart the provider request. Empty-composer suggestions work after either person’s last message; after your own message, they suggest a follow-up. Group context preserves observed sender labels so the model distinguishes the person sharing photos/news from other participants and from you. Recognized quoted messages are kept separate from the current author’s words. Missing attribution stays uncertain; it is never silently assigned to you. Image-only messages can suggest a neutral acknowledgement; the model receives the attachment type, not its contents. With no draft or suggestion, use ✦ → Suggest reply to request one explicitly.
- **Refine:** click **✦** beside the composer to work on your entire written draft. If the composer is empty, it works on the visible suggestion instead. The compact menu identifies its target and offers **Shorter**, **Warmer**, **More direct**, **Translate…** (enter a language), and one field for your own instruction. The result appears in a small preview: **Use text** or Tab puts it into the composer without sending. Escape or the close button dismisses it; changes to the draft or conversation cancel stale work.
- **Stickers:** open WhatsApp’s sticker picker, including the favorites star, and wait for loading. Observed WebP stickers are indexed progressively. Click/right-click a sticker in Companion’s Stickers panel to edit one **Search terms** field containing words, synonyms and captions in either language. Existing tags and keywords migrate together without dropping text. Search combines terms and supports quoted phrases. **Drag a sticker into the open chat** to preview it, then choose **Send sticker** or **Cancel**. The app finds the byte-identical original in WhatsApp’s open sticker pack, Favorites or Recent stickers and activates that native sticker only after confirmation. Animations stay intact; it does not upload an image/GIF or use the sticker creator. WhatsApp’s picker stays clear of Companion panels during resizing and its opening animation. Beside chat settings in a narrow window, it can extend over the uncovered chat list to remain usable. A picker opened for a preview closes when you cancel, finish sending or the lookup fails; a picker you already had open stays open. The first lookup may wait for WhatsApp to load and scroll its picker. If an older indexed sticker is no longer available there, open its pack or favorite it in WhatsApp and try again. Switching chats cancels the preview; an existing text draft is preserved. “Locate in WhatsApp” highlights a currently loaded sticker; feedback appears beside the button in the sticker editor, and it never sends one.
- **Inheritance:** global → individual conversation. Global reply and style settings apply to all people and groups. Change a field under **Chat AI settings** to override it for that chat; each field shows whether it uses the global setting or a custom value. **Reset all to global settings** removes its overrides. Switching chats closes that panel and clears unsaved examples. The former direct-message/group defaults are retained on disk for compatibility but no longer applied. Provider, model, reasoning and credentials are global.
- **Style:** off by default. Choose general or conversation style. Learn locally from at least five selected examples, explicitly selected loaded sent messages, or opted-in observation in conversation style mode. Inspect/edit/reset aggregate traits in Settings → Style. Conversation profiles never cross chats. Sparse chats fall back only to an approved general profile. Unsaved examples are cleared when the active chat changes. Raw examples are not persisted or sent to providers. Edited profiles are preserved. Resetting a conversation profile also stops observation.
- **Automatic replies:** separately off by default, with explicit per-chat permission. Requires shared context, a recognized active chat, empty composer, and new incoming text after arming. Fresh messages can finish rendering or scrolling into view for up to a minute before becoming eligible. Set local permitted hours, daily attempt limit, cooldown and a 15–120 second cancellation window. Typing, clicking, scrolling and opening controls in WhatsApp or Companion cancel/pause; restarting pauses sending. Resume explicitly. Editing schedules or limits preserves any pause; it cannot grant permission to send. Only the active chat is eligible. A discreet button above the composer offers cancellation while queued. Attempts reserve durable budget before dispatch and are never retried automatically. The connector waits up to two seconds for an enabled Send control and rechecks context and user activity throughout. Delivery/read receipts remain WhatsApp’s responsibility.

## Feature status

| Component | Implemented / verified | Remaining live validation |
| --- | --- | --- |
| Desktop / session | Sandboxed WebContentsView, dedicated persistent partition; linked personal session works | Extended reconnect testing |
| Composer | DOM adapter, ghost text, refinement, stale cancellation; live OpenAI continuation/empty reply and Tab acceptance verified | Actual IMEs, broader layouts/languages and live refinement |
| Stickers | Content hashes, persistent search terms, editor/locator, drag preview and guarded native sticker sending; 95 indexed stickers visually tagged and given English/Spanish equivalents, including 67 animations; restart tested | Only observed stickers are searchable; future discoveries need their own terms |
| Providers | Real OpenAI Responses and Anthropic Messages adapters; timeout/cancellation/errors; live synthetic OpenAI check | Anthropic key/model access |
| Settings / style | Inheritance, persistence, local aggregate extraction, scope, reset, sparse fallback | Richer language/tone estimation beyond initial aggregate heuristics |
| Auto replies | Main-process permissions/budget and guarded dispatch; local rules/countdown tests | Live sending deliberately not tested against contacts |
| Packaging | Linux build and packaging commands; Windows/macOS targets configured | Windows/macOS builds/dialogs, signing/notarization |

The replaceable connector uses a narrow DOM contract, not private WhatsApp stores or a complete messaging SDK. Only loaded text context (up to 30 messages, 4,000 characters each) and drafts are considered. Drafts over 8,000 characters or containing structured mentions or unreadable embedded content are left unchanged with an explanation; they are not refined from a truncated prefix. Image-based emoji count as draft content. Observed image, sticker, audio and video types are included as attachment markers; their bytes, URLs and contents are not sent to AI. Suggestions cannot describe unseen attachments. Media-only arrivals do not trigger automatic sending. Conflicting peer IDs disable assistance. For opaque message IDs, the main process recognizes conversations by overlap with up to 200 saved message-ID hashes per conversation (at most 2,000 conversations), never by names or message text. Reply/style overrides survive renames and restarts when a known message is loaded. If history has no overlap (for example after clearing it or a long absence), a new local identity starts with global settings; existing private settings are not guessed or merged. Conflicting local identities use global settings. Automatic sending requires a real WhatsApp peer ID and remains unavailable on the current opaque-ID layout. Unknown message authors remain labelled unknown rather than guessed. WhatsApp changes may require selector updates.

Sticker discovery recognizes loaded images marked as stickers (English/Spanish/Portuguese hints and test IDs), accepts blob/data WebP sources up to 1 MiB (including larger animated favorites), and retains at most 2,000 stickers / about 50 MB of encoded images. Search terms survive recents changes and duplicate observation. Byte-identical stickers share identity; alternate encodings may create separate entries. Favorites are **not assumed inaccessible**: click the star and wait. Complete library enumeration/synchronization, uploading indexed files as new stickers, and complete cross-language discovery are not claimed.

Ordinary messaging, attachments, emoji, playback and other media stay with WhatsApp Web. Downloads use a save dialog; notifications and microphone/camera permissions go through the shell. Calling/native-client parity is not established. Unofficial personal-account automation can break or be restricted by WhatsApp.

Use one personal account per application data directory. Account switching does not migrate Companion metadata; use a fresh directory for another account. A mobile companion remains future work.

## Verify and package

Linux desktop checks require `xvfb` and `xdotool` (`sudo apt install xvfb xdotool`). The sticker drag test uses real mouse input across the two native views under X11.

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

WhatsApp fills the entire content area. Settings are a separate trusted native view overlaid beside the rail or at the right; they do not shrink WhatsApp. Resizing, maximizing and restoring update both views. Local controls keep a fixed zoom level. Reloading them closes the panel.

Desktop tests never connect to WhatsApp or a provider. They exercise acceptance/dismissal, refinement, incoming/chat changes, simulated composition, keyboard behavior, renderer isolation, settings reset, sticker editing/search, dragging and confirming/cancelling native stickers, pause-and-edit races, native layout after resize/zoom/reload, and restart persistence. Unit tests cover inheritance, style boundaries, staleness, persistence failure, provider contracts/errors, credential storage and automatic sending decisions/countdown cancellation. Automatic-send authorization expires within two seconds of main-process dispatch and before permitted hours end. Cancellation invalidates queued commands locally; immediately before clicking Send, the isolated preload also rechecks permission with main so a local-settings pause cannot be overtaken by queued work. Fixture screenshots are written under ignored `.local/screenshots/`.

The unpacked Linux executable is `release/linux-unpacked/whatsapp-companion`. Distribution builds are unsigned. Do not disable Chromium’s sandbox to work around host setup; use a properly installed package / host configuration.

The app uses a custom emerald chat/handset icon with a mint Companion sparkle. Linux window and launcher icons, Windows ICO and macOS ICNS exports are included. See [icon assets and regeneration](assets/README.md); `npm run icons:export` regenerates platform sizes from the saved master. Normal builds use the checked-in exports.

## Releases

This desktop application is distributed as a Linux AppImage; it has no hosted web deployment or automatic updater. Release artifacts contain application code and assets, never the development machine's account data, sticker library or API keys. Download the AppImage from the repository's GitHub Releases, make it executable, and launch it:

```bash
chmod +x 'WhatsApp Companion-0.1.0.AppImage'
./'WhatsApp Companion-0.1.0.AppImage'
```

To prepare a release, run the verification commands above and `npm run package:linux -- --publish never`, then complete the repository's required review-fix-loop before committing or pushing. Publish the reviewed commit on `main`, create the matching version tag, and attach the AppImage plus its SHA-256 checksum to that tag's GitHub release. Releases are unsigned; Windows/macOS packages are not yet validated. A source push by itself does not deploy an update to installed applications.

## Data and security

The main process owns providers, credentials, persistence, permissions and budgets. The local sandboxed React renderer uses a small validated IPC API. The remote sandboxed preload observes DOM and implements guarded composer commands, with **no exposed desktop API**. Automatic replies and confirmed sticker sends recheck one-use main-process authorization immediately before native activation; cancelling in local controls revokes queued permission. Sender, origin and main-frame checks protect IPC. WhatsApp may define its own browser-side `require` loader; it has no Node integration. Keys never cross IPC, enter an app renderer or appear in logs. Provider HTTPS destinations are fixed, redirects are refused, and raw error bodies are not shown.

Data normally lives in `~/.config/WhatsApp Companion/` on Linux, `%APPDATA%/WhatsApp Companion/` on Windows, and `~/Library/Application Support/WhatsApp Companion/` on macOS. `companion.json` holds settings, aggregate style traits, hashed conversation anchors, sticker images/metadata and attempt budgets; `credentials.json` holds OS-encrypted keys and backend selection. Files are atomically replaced with owner-only permissions. WhatsApp session data stays in `Partitions/whatsapp`. **Metadata/session files are not additionally encrypted by Companion**; use disk encryption. Conversation text, sender labels and quote context are transient and not stored by Companion; WhatsApp maintains its own browser storage. OpenAI uses `store: false`; provider retention follows your account policies.

Invalid state is preserved and startup stops instead of overwriting it. For recovery, close the app, back up the data directory and inspect/restore `companion.json`. Renaming it creates fresh defaults and loses metadata unless restored. Do not delete the WhatsApp partition unless you intend to log out. For isolated development, use `npm start -- --data-dir=/absolute/test-directory`; packaged apps ignore this development flag. Demo data is separate and cannot access the real provider key.

See [architecture and verification](docs/implementation.md) and the [product brief](docs/product-brief.md).
