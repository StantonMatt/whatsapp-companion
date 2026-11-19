# Data and privacy

What WhatsApp Companion keeps on your computer, what it sends to an AI provider when AI features are on, and how to recover your data. Using the app is covered in the [user guide](user-guide.md).

- [Where data lives](#where-data-lives)
- [What your AI provider receives](#what-your-ai-provider-receives)
- [Keys and security design](#keys-and-security-design)
- [Local usage counts](#local-usage-counts)
- [Diagnostics](#diagnostics)
- [Sticker library migration](#sticker-library-migration)
- [Recovery](#recovery)

## Where data lives

Data normally lives in:

| System | Folder |
| --- | --- |
| Linux | `~/.config/WhatsApp Companion/` |
| Windows | `%APPDATA%/WhatsApp Companion/` |
| macOS | `~/Library/Application Support/WhatsApp Companion/` |

- `companion.json` holds settings, aggregate style traits, hashed conversation anchors, sticker metadata and attempt budgets.
- `stickers/<sha256>.webp` holds the original sticker bytes.
- `credentials.json` holds OS-encrypted keys and backend selection.
- WhatsApp session data stays in `Partitions/whatsapp`.
- Files are atomically replaced with owner-only permissions (sticker folder 0700, files 0600). On Linux, writes flush both the file and its containing directory.
- Sticker images are served only to the local controls session through `companion-sticker://<sha256>`; the WhatsApp session cannot resolve that scheme.
- **Metadata/session files are not additionally encrypted by Companion**; use disk encryption.
- Conversation text, sender labels, document filenames and quote context are transient and not stored by Companion; WhatsApp maintains its own browser storage.
- Only aggregate writing habits are saved for [writing style](user-guide.md#writing-style); raw examples are not persisted or sent to providers for learning.

## What your AI provider receives

Nothing is sent to an AI provider while **AI features** is off. With it on, requests go to the provider you selected (OpenAI or Anthropic) with your own key. Provider account retention and billing policies apply. OpenAI requests use `store: false`.

### Suggestions and refinement

- Only loaded text context (up to 30 messages, 4,000 characters each) and drafts are considered.
- Drafts over 8,000 characters or containing structured mentions or unreadable embedded content are left unchanged with an explanation; they are not refined from a truncated prefix.
- Group context includes observed sender labels; recognized quoted messages are kept separate from the current author's words.
- Observed image, sticker, audio, video and document types are included as attachment markers. Document cards include their visible filename (up to 255 characters), including quoted documents; filenames are untrusted labels, not proof of file contents.
- Attachment bytes, preview images, download URLs and contents are not sent to AI. The model receives types, filenames, captions and surrounding text, not image or file contents.

### Sticker tagging

- Sticker tagging sends the sticker image to the configured OpenAI or Anthropic provider, plus its animation flag, existing group names and up to five examples of library search terms. Editor suggestions also send the current search terms.
- It never sends chat messages, contact names or conversation records.
- Animated stickers use up to three still PNG frames (a single frame when further decoding is unavailable); static stickers use WebP for OpenAI and a PNG for Anthropic.
- **Tag new stickers automatically** is off initially; when on, it sends only stickers indexed afterward.
- The desktop fixture uses deterministic local suggestions and makes no tagging network requests.

## Keys and security design

- The main process owns providers, credentials, persistence, permissions and budgets. The local sandboxed React renderer uses a small validated IPC API. Sender, origin and main-frame checks protect IPC.
- The remote sandboxed preload observes DOM and implements guarded composer commands, with **no exposed desktop API**. WhatsApp may define its own browser-side `require` loader; it has no Node integration.
- A pasted key travels once from the local sandboxed settings renderer to main through validated IPC. Main validates and OS-encrypts it; status returns only presence booleans. Only unsaved pasted text is held temporarily in the local settings field, and fields clear on successful save, Cancel/Escape and page/panel close.
- Keys never enter WhatsApp, status, diagnostics or logs. Provider HTTPS destinations are fixed, redirects are refused, and raw error bodies are not shown.
- Automatic replies and native card sticker sends recheck one-use main-process authorization immediately before native activation. Automatic-send authorization expires within two seconds of main-process dispatch and before permitted hours end.
- For the opt-in direct sticker route, main executes one fixed bundled main-world function with bounded, validated arguments, binds the active chat's exact WID to the local-click ticket, and consumes one attempt before dispatch. No main-world callable API or preload bridge is installed. A returned sticker model with ack ≥ 1 and the bound destination confirms the send.
- Sticker cancellation revokes finding and preparing tickets. Maker image disclosure and its final Send click have separate one-use authorizations; the isolated connector retains destination continuity only for the app-owned editor transition. Once clicked, sending finishes and reports its result.
- Incoming messages and custom instructions cannot grant permission to send.

## Local usage counts

Provider HTTP dispatch counts are saved locally in `request-counts.json` in the app's data directory, separately from `companion.json`.

- The owner-only JSON file aggregates the last 30 local calendar days by provider/model, request reason and completed/error/timeout/aborted outcome.
- Model-list GETs are counted separately from generation POSTs.
- Writes are batched every 30 seconds and flushed on quit.
- It contains no messages, prompts, chat identities or keys; dispatch counts are not billing totals.

Suggestion decisions are counted separately in `suggestion-decisions.json`, using only local day, allowlisted reason and count. Counts track changes in eligibility and display rejection rather than every poll. This uses the same 30-day retention, owner-only permissions and batched writes as request counts.

## Diagnostics

Diagnostic files live under `diagnostics/` in the data directory, with owner-only permissions.

### Sticker picker layout capture

Open WhatsApp's native sticker picker, then choose **Companion → Capture sticker picker layout**. The app saves a JSON file under `diagnostics/` and reveals it in your file manager. Send that file when requested to investigate the picker markup. If the picker is closed, the app asks you to open it first.

- The capture reads only the open expressions panel and a minimal ancestor chain.
- Labels and visible text become lengths and recognized UI words; image URLs become schemes and sizes, and classes become counts. It retains structural attributes and layout measurements, with truncation marked at depth 40 or 6,000 elements.
- It does not capture conversations, account details or image bytes, and does not click, focus, scroll or send anything.

### Sticker send log

Each sticker send appends a privacy-limited JSON line to `diagnostics/sticker-sends.log`: route, animation flag, outcome/reason, elapsed time and fixed category loading timings, plus structural version information. It contains no sticker identifiers, images, chat names or messages. The log rotates at 256 KB with one backup.

### Startup log

Startup and shutdown timings are saved asynchronously to owner-only `diagnostics/startup.log`, rotated at 256 KiB with one previous file. Earlier interrupted launches remain visible.

- The log contains timestamps, structural phase/progress codes, visibility, bounded timing/bounds/version metadata and watchdog decisions.
- While running, local startup page load rejections record `base-load-failed` or `controls-load-failed` with only a bounded numeric error code when available, and do not abort remote startup. Controls retry once if their URL has not committed; `controls-loaded` follows the attempts only when the controls URL is present. Once closing begins, pending startup loads stop quietly without retries, failure diagnostics or a startup error dialog.
- Remote load recovery records `load-failed` with a bounded numeric code/attempt, plus `load-retry`, `navigation-stalled` and one-time `relaunch` events with attempt counts. The first startup asset failure per navigation records only its script/stylesheet kind.
- A one-time loading-screen signature records allowlisted standard progress/ancestor tags and attribute-presence flags; ancestor IDs and test IDs retain only explicitly allowlisted WhatsApp structural identifiers, with other tags and attribute values replaced by `other`. The signature waits for visible progress or a known splash marker, or for an unknown document to complete the startup grace period.
- It excludes URLs, error messages, DOM text, account identifiers, QR data and credentials.
- Quitting stops command intake immediately, drains sticker intake and closes both views even if a frame was disposed. Nonessential sticker GC runs after navigation begins; migration remains durable before the window opens.

## Sticker library migration

On the first startup with schema v1, Companion:

1. validates the complete inline library,
2. durably saves `companion.v1-backup.json` without overwriting an existing backup,
3. writes and verifies each original WebP,
4. then replaces `companion.json` with schema v2 metadata.

An interrupted migration resumes on restart; failures preserve the inline manifest and stop startup. No sticker is re-encoded or merged during migration.

Missing/damaged image files retain their card metadata and offer Retry; sending fails with a recovery message. Deleting saves each tombstone before deleting the blob. Deferred startup cleanup removes only recognized unreferenced sticker files after successful state validation/migration, using the current reference set when cleanup runs.

## Recovery

Invalid state is preserved and startup stops instead of overwriting it. If the app says it could not start:

1. Close the app.
2. Back up the data directory.
3. Inspect/restore `companion.json`.

**Back up and restore `companion.json` together with the `stickers/` folder.**

- To restore the pre-migration state, preserve the current directory first, then copy `companion.v1-backup.json` over `companion.json`; the next startup migrates again. This loses settings, labels, additions and forgets made after that backup; schema v2 does not support opening the manifest in an older app.
- A corrupt existing blob must be restored or moved aside before retrying migration.
- Renaming `companion.json` creates fresh defaults and loses metadata unless restored.
- Do not delete the WhatsApp partition unless you intend to log out.
- For isolated development, use a separate data directory; see [Development](development.md#run-from-source). Demo data is separate and cannot access the real provider key.
