# User guide

How to install and use WhatsApp Companion. What the app stores and sends is covered in [Data and privacy](data-and-privacy.md); running from source and releases are in [Development](development.md).

- [Install and update](#install-and-update)
- [Link your phone](#link-your-phone)
- [Finding your way around](#finding-your-way-around)
- [AI features](#ai-features)
- [Providers, models and reasoning](#providers-models-and-reasoning)
- [Secure key storage](#secure-key-storage)
- [Reply suggestions](#reply-suggestions)
- [Refine and translate](#refine-and-translate)
- [Stickers](#stickers)
- [Per-chat settings](#per-chat-settings)
- [Writing style](#writing-style)
- [Automatic replies](#automatic-replies)
- [Messaging, media and notifications](#messaging-media-and-notifications)
- [Tray and start at login](#tray-and-start-at-login)
- [Startup and loading](#startup-and-loading)
- [Limits](#limits)

## Install and update

WhatsApp Companion is distributed as a Linux AppImage. It has no hosted web deployment and no automatic updater. Release files contain application code and assets, never the development machine's account data, sticker library or API keys.

1. Download the AppImage from the [latest release](https://github.com/StantonMatt/whatsapp-companion/releases/latest). On GitHub the file is named `WhatsApp.Companion-<version>.AppImage` (GitHub replaces the space in the built file name `WhatsApp Companion-<version>.AppImage` with a dot).
2. Optionally check it against the release's `SHA256SUMS` file: download both into the same folder and run `sha256sum -c SHA256SUMS --ignore-missing`.
3. Install the FUSE 2 library that AppImages need. Kubuntu and Ubuntu 24.04 or newer don't include it: `sudo apt install libfuse2t64`. Without it the AppImage exits with "AppImages require FUSE to run".
4. Make it executable and start it:

   ```bash
   chmod +x WhatsApp.Companion-0.3.0.AppImage
   ./WhatsApp.Companion-0.3.0.AppImage
   ```

   In Dolphin you can instead right-click the file, choose **Properties → Permissions**, tick **Is executable**, and double-click it.

Keep the AppImage in a permanent folder (for example `~/Applications`): [start at login](#tray-and-start-at-login) points to the file where it is.

To update, download the newer AppImage from Releases and start it instead of the old one. Releases are unsigned. Only Linux x86_64 is tested (on Kubuntu); Windows and macOS packages are configured but not yet validated.

## Link your phone

Scan the QR code in the **application** with WhatsApp on your phone (Linked devices). Account linking always requires your QR interaction.

- The app's WhatsApp session is separate from Chrome, other browsers and other WhatsApp clients such as Whatsie. No browser cookies or unrelated credentials are imported.
- Use one personal account per application data directory. Account switching does not migrate Companion metadata; use a fresh data directory for another account.
- A mobile companion remains future work.

## Finding your way around

There is no Companion top bar.

- **Sticker library** and **Settings** live in WhatsApp's left navigation rail. Global settings open over the chat list.
- The **Chat AI settings** sliders button in each conversation header opens a right-hand panel for that chat.
- Panels follow the WhatsApp light/dark appearance. Use the back arrow or Escape to close them.
- **Companion → Settings** (Ctrl+,) remains available before linking or when navigation cannot be detected.

Settings dropdowns follow the same theme, with padded options, selected checkmarks and consistent row spacing. Arrow keys and typing navigate options; Enter selects. Escape closes an open dropdown first, then the settings panel on a second press.

Right-click the message field or a Companion input for Cut, Copy, Paste and Select all. Selected text outside editable fields offers Copy. Misspelled words offer available corrections and Add to dictionary when spellcheck is active. WhatsApp's own message and chat menus stay in control.

## AI features

**AI features** is off on a fresh profile. Open the **Settings** gear in the left sidebar and turn it on, then add a key under [Providers](#providers-models-and-reasoning).

- With AI features off, no AI controls appear and the app refuses AI work, including suggestions, style learning, sticker tagging, automatic replies, model lists and connection tests.
- Turning it off cancels work in flight without deleting keys, models, preferences, learned styles or chat rules. Turning it on restores those settings; enabled automatic replies remain paused until **Resume**.
- Existing profiles that lack the setting start with it on only if a provider key was already saved; that decision is persisted once.
- Sticker search, manual terms and groups, direct sending and **Reload WhatsApp** remain available with AI off.

## Providers, models and reasoning

Open **Settings → Providers**. Paste your key into its provider's masked field and click **Save**.

- Each saved key has **Test connection**, **Replace** and **Remove**; removal asks inline.
- **Get key** opens that provider's fixed API-key page in your system browser.
- A provider without a saved key cannot be selected.
- API usage is billed by your provider. No key is included in this repository or its packages.

**Model ID** shows a short list of current general-purpose text models available to your key:

- OpenAI: GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol and Luna.
- Anthropic: Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5.

Older generations, specialist models and duplicate dated snapshots are excluded. **Refresh models** checks account availability again. Model lists are cached in memory for ten minutes per provider and key; Refresh bypasses the cache. A saved model outside this list is retained in your configuration and identified separately until you choose a current model. Selections are saved separately for each provider; new installations default to GPT-6 Luna and Claude Sonnet 5.5. Model-list access requires Models read permission on restricted keys.

The **Reasoning effort** slider saves separately for each model and applies to suggestions, refinements and connection checks.

- GPT-6 Luna/Sol offer None through Max; GPT-6.1 Sol, Astra and current Claude reasoning models offer Low through Max. Haiku has no adjustable effort.
- The initial setting favors speed: None for GPT-6 Luna/Sol and Low for GPT-6.1 Sol, Astra and Claude reasoning models.
- Higher effort can take longer and use more tokens.

**Test connection** checks that button's provider with its saved model and effort using synthetic text. A dedicated OpenAI key is securely configured on the development machine and has passed live checks. Anthropic has request/response fixture coverage but no live-key test yet.

## Secure key storage

Saved credentials require working OS encryption: KWallet or Secret Service on Linux (KWallet6 on Kubuntu), Keychain on macOS, DPAPI on Windows.

- If storage is unavailable, unlock it and use **Check again** in Providers; saving stays disabled until secure storage is available.
- The app refuses Electron's unencrypted `basic_text` store.
- If Electron does not detect KDE correctly, start once with `--password-store=kwallet6`, for example `./WhatsApp.Companion-0.3.0.AppImage --password-store=kwallet6`, or from source `npm start -- --password-store=kwallet6`. The secure backend is remembered when saving a key.
- Windows/macOS secure storage still needs validation on those systems.

How keys travel and where they are kept is described in [Data and privacy](data-and-privacy.md#keys-and-security-design).

## Reply suggestions

Turn on **Share recent conversation context** and **Inline suggestions** for the desired scope in **Settings → Replies**. What the model receives is listed in [Data and privacy](data-and-privacy.md#what-your-ai-provider-receives).

### When suggestions appear

- An empty composer prepares a reply after one second of stable context when the latest message is incoming.
- Unchanged chat revisits reuse completed text or attach to an already-running request; dismissals stay remembered for that message. Switching chats does not abort an automatic empty-composer request.
- Failures stay live-only, so a later visit can try again. This memory-only cache holds up to 50 entries and resets when the app exits.
- Up to five empty-composer requests can remain in flight across chat switches; additional chats stay eligible on a later visit.
- A partial draft gets a continuation after a one-second typing pause and a meaningful edit; whitespace alone does not request again. Continuations are shown only for the live request's exact draft and latest message; they are never cached or restored after a revisit or refresh. **Try again** requests a fresh continuation for your current exact draft.
- Refinement and translation results and retry controls are live-only and disappear on navigation or refresh; results require the exact draft and latest message to match.
- Accepting a suggestion or applying a refinement waits for your next edit before offering a continuation.
- After your own message, click **✦** to request a follow-up explicitly. With no draft or suggestion, one click on **✦** requests a reply immediately. With a suggestion or draft, **✦** opens its refinement menu.

### Accepting and dismissing

- Suggestions stay visible when you click, scroll or switch focus.
- Focus the composer with the caret at the end to accept with Tab. Tab accepts without sending; Escape dismisses.
- Normal Tab navigation returns without a suggestion. Shift+Tab, Enter, Shift+Enter and input methods retain their roles. No new keyboard shortcut is added.
- Typing, message changes, chat changes, composer replacement and input-method composition invalidate stale suggestions; ordinary focus or caret movement does not restart the provider request.

### While a request runs

- Inline ghost dots cycle . → .. → ... every 400 ms where the text will appear; reduced motion keeps static "...".
- Draft continuation, refinement and translation dots follow the draft, with a thin gap unless it ends in whitespace. If the dots would be clipped or their line is scrolled out of view, they appear just left of **✦** until space returns. The empty-composer placeholder is hidden while dots show.
- The star's tooltip and accessible label are Suggest reply, Refine suggestion, Refine draft or Cancel. Screen readers announce Suggesting a reply or Refining once per request.
- Escape, typing, input-method composition and sending cancel pending work.
- **✦** cancels user-requested dots. During automatic continuation dots it cancels the continuation and opens Refine draft in one click, while automatic dots in an empty composer keep running.
- Automatic retries retain their initiating origin and normal star label; clicks elsewhere, scrolling and blur keep it running.

### Errors

- Temporary network, timeout and server failures retry once after two seconds for the same unchanged context.
- Persistent errors remove the dots and offer **Try again** above **✦**, beside the composer; retry brings the dots back.
- Invalid keys, quota and model-access errors require attention and do not retry automatically.

### Group chats, quotes and attachments

- Group context preserves observed sender labels so the model distinguishes the person sharing photos/news from other participants and from you.
- Recognized quoted messages are kept separate from the current author's words. Missing attribution stays uncertain; it is never silently assigned to you. Unknown message authors remain labelled unknown rather than guessed.
- Image-only messages can suggest a neutral acknowledgement.
- Shared PDFs and other document cards include an attachment marker and their visible filename, so the model knows who already shared the file. Prompts discourage requesting that same attachment again.
- Suggestions cannot describe unseen attachments.

## Refine and translate

Click **✦** beside the composer to work on your entire written draft. If the composer is empty, it works on the visible suggestion instead.

- The compact menu identifies its target and offers **Shorter**, **Longer**, **Warmer**, **Funnier**, **More formal**, **More casual**, **More direct**, **Fix spelling**, **Add emoji**, **Translate…** (enter a language), and one field for your own instruction.
- With an empty composer, the result updates the inline suggestion immediately; Tab accepts it into the draft as usual.
- A written draft is revised directly in the composer, with native Undo available. If you move to another field while it works, the revision waits until you return to the composer.
- There is no separate result box or **Use text** step. Nothing is sent.
- If native insertion fails, it restores your selection and waits for **Try again**.
- Refocusing while it works keeps the request running; Escape or the close button cancels it, and changes to the draft or conversation cancel stale work.
- Drafts over 8,000 characters or containing structured mentions or unreadable embedded content are left unchanged with an explanation; they are not refined from a truncated prefix. Image-based emoji count as draft content.

## Stickers

### Library and search

Open WhatsApp's sticker picker and wait for loading to index observed WebP stickers. In **Sticker library**, search saved words, synonyms and captions in either language, and use each card's **Send** or search-terms editor. **Locate in WhatsApp** highlights a loaded sticker and never sends one.

Favorites are **not assumed inaccessible**: click the star and wait. Only observed stickers are searchable; complete library enumeration/synchronization and complete cross-language discovery are not claimed.

### Sending

- With a provably empty composer, static indexed stickers send through **Attach → New sticker**, even when the original is no longer loaded.
- With a draft or uncertain composer, static stickers use the native picker and leave the draft untouched; if missing, send or clear your draft first.
- With direct sending off, animated stickers look up the byte-identical original to preserve animation. If it is missing, **Try again** starts a fresh animated lookup, or **Send still** explicitly uses the maker and loses animation, requiring an empty composer. With direct sending off, the maker re-encodes indexed stickers and explicit Send still flattens animations.
- These native routes do not automatically switch routes or capture/restore drafts.
- One send runs at a time. You can cancel while finding or preparing; changing chats, closing the panel or reloading also revokes preparation.
- During maker ownership, a visual shield blocks pointer input, keyboard/paste/IME input is blocked and focus stays on the local controls. If a draft appears, automation stops without closing or discarding the editor; check the chat before retrying if Send may have activated.
- Both native routes require an outgoing sticker message to confirm sending; uncertain sends are never retried automatically.
- Lookup-owned pickers and maker editors close afterwards when safe; a picker you already had open stays open.
- Stable picker categories finish promptly; loading categories are revisited up to a 15-second total lookup cap. Maker preparation takes at most five seconds and outgoing-message confirmation at most four seconds, followed by teardown.

### Direct sending (experimental)

Enable **Send stickers directly (experimental)** in global Settings to send any indexed static or animated sticker from its original stored WebP, with drafts untouched and no picker, sticker editor or shield. It is **off by default**.

- Unofficial use of WhatsApp internals may break with WhatsApp updates and carries some account risk. The guards below do not eliminate that risk.
- Missing/incompatible modules fall back to the existing native route only before upload or send starts. An uncertain attempt never falls back or retries; check the chat before choosing another send.
- Direct mode allows at most 10 page-side send invocations per rolling 60 seconds; the next sticker immediately uses the normal maker/picker route without queuing.
- It turns itself off if WhatsApp shows a QR/link-device or logout screen, displays an account warning, a dispatched direct send errors or remains unknown, or module shapes change after a successful direct send in this app session. Settings shows the saved reason. After resolving the issue, turn the toggle back on to clear the reason and re-enable direct sending.
- Turning the setting off immediately prevents new direct sends; an already dispatched attempt still reports its outcome.

### Deleting stickers

In Stickers, choose Edit to delete: select stickers with their circles, then use the bottom bar's trash button, or open a sticker's editor and use its trash button. Confirm with Delete or choose Keep. Delete/Backspace on a focused tile opens the same confirmation. Selections survive search and group filters, so the selected count can include hidden stickers. Bulk deletion saves the whole selection together.

**Delete** remembers the exact image hash across restarts and later discovery, without hiding another encoding or the original of a duplicate. The list retains the latest 5,000 forgotten hashes; older ones may be discovered again.

### How stickers are found

- Sticker discovery recognizes loaded images marked as stickers (English/Spanish/Portuguese hints and test IDs) and accepts blob/data WebP sources up to 1 MiB (including larger animated favorites).
- The library retains at most 2,000 stickers / 1 GiB of original WebP blob bytes (backups and temporary files excluded). The Stickers hint line reports capacity or save failures.
- Search terms survive recents changes and duplicate observation. Future discoveries need their own terms.
- Byte-identical stickers share identity. Near-identical re-encodings are suppressed using their first-frame appearance, retaining the existing entry and its search terms. A static copy matching an animated entry's first frame is also suppressed; an incoming animation is always kept separate from static entries. This approximate comparison can miss some copies or treat very similar images as duplicates; it does not remove existing library entries.
- Each image decode waits at most two seconds. Close/Quit allows at most three seconds for indexing before saving remaining observations by exact hash, so a stalled decoder cannot prevent closing.

### Tagging with AI

In **Edit stickers**, **✦ Tag N untagged** tags empty search terms in the current group/search view; the selection's ✦ tags only its untagged stickers.

- More than 20 asks for confirmation. The header shows progress and **Stop**; completed results stay saved, and **Try again** retries failed entries.
- The **Untagged** chip keeps its current tiles visible as results arrive. Typing or deleting withdraws that sticker from the tagging queue.
- Batch and automatic results fill empty terms and add existing groups without replacing curated terms or removing groups.
- In the editor, **✦** suggests an unsaved draft; **Save** accepts the terms and suggested groups, and **Discard** restores the original draft.

**Tag new stickers automatically** is off initially. Turning it on sends only stickers indexed afterward, without processing the existing library. Manual and automatic tagging share up to three simultaneous requests. Authentication, quota, connection and image-model errors stop the queue and pause automatic tagging for the session; toggle the setting off/on, replace the key, or complete a manual tag to resume. The pause reason is held in memory, and the setting is saved with the other preferences.

What tagging sends to the provider is listed in [Data and privacy](data-and-privacy.md#sticker-tagging).

## Per-chat settings

Settings inherit from global to individual conversation.

- Global reply and style settings apply to all people and groups.
- Change a field under **Chat AI settings** to override it for that chat; each field shows whether it uses the global setting or a custom value. **Reset all to global settings** removes its overrides.
- Switching chats closes that panel and clears unsaved examples.
- The former direct-message/group defaults are retained on disk for compatibility but no longer applied.
- Provider, model, reasoning and credentials are global.

## Writing style

**Settings → Style** contains matching and learning controls together. Choose Off (the default), General style, or conversation-specific style.

- **Learn from this chat** reads your loaded sent messages directly; the screen shows how many are available and requires at least five usable messages. Scroll up in WhatsApp to include older messages. This reads the loaded conversation, not your entire archive.
- Global Style can explicitly create a general profile from the open chat. **Learn automatically from my messages** opts into separate profiles as you open and scroll through chats in conversation mode.
- **Add examples manually** is optional; **View or edit saved style** lets you inspect, edit or reset the result.
- Learning does not turn matching on.
- Only aggregate writing habits are saved locally; raw examples are not persisted or sent to providers for learning.
- Conversation profiles stay scoped to their chat, with an approved general profile as fallback. Unsaved examples clear on chat changes.
- Selected/edited profiles are preserved until reset, and resetting a conversation profile stops automatic learning.
- **Use global style settings** resets only the style overrides, preserving other chat preferences.

## Automatic replies

Separately off by default, with explicit per-chat permission. **Automatic sending requires a real WhatsApp peer ID and is unavailable on the current WhatsApp Web layout** (see [Limits](#limits)).

- Requires shared context, a recognized active chat, an empty composer, and new incoming text after arming. Fresh messages can finish rendering or scrolling into view for up to a minute before becoming eligible. Media-only arrivals do not trigger automatic sending.
- Set local permitted hours, daily attempt limit, cooldown and a 15–120 second cancellation window.
- Typing, clicking, scrolling and opening controls in WhatsApp or Companion cancel/pause; restarting pauses sending. Resume explicitly.
- Editing schedules or limits preserves any pause; it cannot grant permission to send.
- Only the active chat is eligible. A discreet button above the composer offers cancellation while queued.
- Attempts reserve durable budget before dispatch and are never retried automatically.
- The connector waits up to two seconds for an enabled Send control and rechecks context and user activity throughout.
- Delivery/read receipts remain WhatsApp's responsibility.

## Messaging, media and notifications

Ordinary messaging, attachments, emoji, playback and other media stay with WhatsApp Web.

- Downloads use a save dialog; microphone/camera capture asks for permission.
- Links open in your browser after a confirmation. Tick **Don’t ask again in this chat** to open that chat’s links directly, or turn off **Ask before opening links** in Settings for all chats. **Ask in all chats** clears the per-chat exceptions.
- Once the signed-in chat list is ready and the window is visible, Companion asks once about desktop notifications and remembers Allow or Deny. Change that answer anytime with **Notifications** in the tray menu.
- WhatsApp's main frame can copy images and text through Chromium's sanitized clipboard-write permission without a shell prompt; clipboard reads and unsanitized writes remain denied.
- Calling/native-client parity is not established.
- Unofficial personal-account automation can break or be restricted by WhatsApp.

## Tray and start at login

The tray icon stays available while Companion runs.

- Closing the window hides it and removes its taskbar entry; WhatsApp stays connected. Click the tray icon or **Open WhatsApp Companion** to show it again.
- Clicking a notification brings Companion to the front, including from the tray or a minimized window; WhatsApp opens the notification's conversation.
- **Quit** in the tray or app menu (Ctrl+Q) exits completely.
- Launching Companion again brings the running window forward.

**Start at login** defaults on for packaged apps with a tray and starts hidden, loading WhatsApp in the background. Toggle it in the tray menu.

- Linux uses an XDG autostart entry pointing to the current AppImage or executable; development and fixture runs never change OS autostart. Windows and macOS use Electron login settings.
- If tray creation fails, hidden launches show the window, closing quits, and login startup is not enabled by default. Linux cannot reliably detect a missing tray host after successful tray construction.

## Startup and loading

Companion starts with a lightweight isolated detector and defers overlays, message observation and sticker discovery only while a recognized WhatsApp splash is present, for at most 20 seconds. Shell, login/QR, blocked and unknown screens activate the connector immediately, preserving logout and account-warning safety checks. Remote background throttling stays disabled so WhatsApp can receive messages and show permitted notifications while hidden.

If a recognized loading splash remains for at least 60 seconds with no phase or coarse progress change for at least 30 seconds, Companion can reload WhatsApp normally.

- Recovery requires fresh authenticated heartbeats, a visible, online window and no pending app action or permission dialog.
- It allows at most two automatic reloads per launch, at least 120 seconds apart. Unknown markup or missing heartbeats never trigger recovery.
- Reload preserves cookies and storage. After the budget is used, use **Reload WhatsApp** if needed.

If the app reports that it could not start, see [Recovery](data-and-privacy.md#recovery).

## Limits

- Only loaded text context and drafts are considered; see [what your AI provider receives](data-and-privacy.md#what-your-ai-provider-receives) for the exact limits.
- The current WhatsApp Web layout uses opaque message IDs. Companion recognizes observed conversations locally so reply and style overrides work: the app matches conversations by overlap with up to 200 saved message-ID hashes per conversation (at most 2,000 conversations), never by names or message text.
- Reply/style overrides survive renames and restarts when a known message is loaded. If history has no overlap (for example after clearing it or a long absence), a new local identity starts with global settings; existing private settings are not guessed or merged. Conflicting local identities use global settings. Conflicting peer IDs disable assistance.
- Automatic sending requires a real WhatsApp peer ID and remains unavailable on the current opaque-ID layout.
- Actual input methods (IMEs) and broader layouts/languages still need live validation.
- WhatsApp changes may require selector updates.
