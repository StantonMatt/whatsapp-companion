# WhatsApp Companion: product brief

Created September 28, 2026 from the project planning conversation.

## Purpose

Build a personal WhatsApp application that feels close to WhatsApp for Mac while running on Linux first. Ordinary messaging should feel smooth and familiar. Personal additions should improve sticker discovery and help the user write replies without turning the interface into a separate AI chat application.

Implementation was authorized on September 28, 2026, superseding the original planning-only scope. A first Electron + React + TypeScript application now exists. This document retains the product discussion and corrections; [README](../README.md) and [implementation notes](implementation.md) describe actual behavior, verification and limitations.

## User requirements and preferences

### Platforms and account

- Linux is the first target.
- Ideally support Windows and macOS as well.
- Preserve a path to mobile use; a mobile companion is acceptable as an architectural possibility, not a confirmed implementation.
- Use a personal WhatsApp account first, rather than a business messaging workflow.
- WhatsApp for Mac is the reference for appearance, interaction, responsiveness, emoji, and sticker behavior.

### Sticker browsing and search

- Add editable search terms to stickers to find the right reaction quickly. The September 29 correction combines tags, keywords and phrases into one field, with English and Spanish equivalents for the indexed collection.
- Search alongside favorites, packs, and recently used stickers where those collections are available.
- Drag from the library into an open chat, show a preview with Send/Cancel, and send the original native sticker only after confirmation. Preserve animation; never substitute an image or GIF.
- Preserve personal metadata independently of the recent-sticker list.
- Provide a convenient way to edit tags, such as a context menu.
- Associate metadata with the same sticker across conversations when its identity can be established.

Important correction from hands-on observation: the user initially saw mostly recent stickers in WhatsApp Web and Whatsie on Linux. After selecting the favorites star and waiting, more stickers loaded. Whatsie appeared to load more than the browser. Do not assume favorites are inaccessible, that Linux cannot render the stickers, or that a new sticker synchronization system is already necessary. Loading progress, caching, session differences, and actual collection completeness remain unverified.

Search can cover only stickers the application has indexed. Determine how the available collection can be enumerated and progressively indexed before promising complete library search or automatic import.

### Discreet AI assistance

- Support user-configured LLM APIs, initially OpenAI and Anthropic.
- Suggest replies in the existing message composer as faint inline text.
- Tab accepts a visible suggestion into the composer; acceptance does not send the message.
- Escape dismisses a suggestion; Tab retains its ordinary navigation behavior when there is no suggestion.
- Preserve the user's configured Enter/send behavior and avoid interfering with input methods or ongoing typing.
- An empty composer may show a suggested response. A partially written draft may receive a continuation.
- Recognize when an image or document has already been shared, retain its sender and visible document filename, and avoid asking for the same attachment again. Attachment contents are not currently read; suggestions must not pretend they have seen or read them.
- Keep suggestions relevant when new messages arrive or the user switches conversations. Preserve individual group senders and distinguish attachment ownership: if Mum posts photos and a sibling praises them, draft as a fellow recipient rather than thanking them as the photographer. Keep quoted content separate from the current speaker.
- Provide a small, discreet pop-up for refining the draft, with actions such as shorter, warmer, more direct, translation, and a free-form instruction.
- Avoid a permanent AI sidebar as the default experience.
- Include settings for AI behavior and optional custom/system instructions.

### Writing-style adaptation

The user explicitly requested an option for the AI to observe their writing and responses and imitate that style. The style should be configurable globally or adapt to the person or group, reflecting differences between friends and professional relationships.

Proposed settings:

- Match my writing style: off, use my general style, or adapt to this conversation.
- Global style defaults and overrides for a specific person or group. The later UI request removes the intermediate direct-message/group layer.
- Learn from the user's own outgoing messages or user-selected examples within an explicitly enabled scope.
- Capture tone, reply length, vocabulary, punctuation, emoji habits, and language preferences.
- Allow the user to inspect, correct, refresh, or reset the inferred style profile.
- Use approved general-style examples when a conversation has insufficient history; do not invent a confidently inferred contact-specific style.
- Keep contact-specific facts and examples scoped appropriately. Style reuse should not leak private details from one conversation into another.

This is a product requirement for style adaptation, not a decision to fine-tune a model. Begin by evaluating style profiles and selected examples supplied as context. Provider-specific implementation and history access are still to be validated.

### Settings inheritance

Implemented order, following the later correction: global defaults, then a specific person or group. The intermediate direct-message/group layer is no longer applied. Global AI settings and Stickers belong in the WhatsApp left navigation rail, without a Companion toolbar. Each chat header has a button for overrides. Settings use WhatsApp-like colors, rows, switches and back navigation.

- Show whether a setting is inherited or overridden.
- Provide an easy reset to inherited defaults.
- Include tone, length, language, emoji use, suggestion behavior, style adaptation, and custom instructions.
- Treat a group as its own conversation context. Do not silently apply one participant's private-chat preferences to the entire group.

### Optional automatic replies

- The user wants the possibility of automatic replies, in addition to suggestions.
- Automatic sending is a separate, explicit per-chat setting, disabled initially.
- Proposed controls include permitted hours, reply limits, a cancellation window, and pausing when the user takes over.
- Enforce sending permissions in application logic. Conversation text and custom tone instructions must not grant sending authority or access to other chats.

## Initial technical direction

- Fresh Electron, React, and TypeScript application; do not fork Whatsie by default.
- Use the existing WhatsApp Web interface as the initial integration baseline, then validate targeted customization of the composer and sticker picker.
- Keep the WhatsApp connector, AI/provider logic, local storage, and interface separate.
- Prefer local storage for settings, sticker metadata, and style profiles, with secure operating-system storage for API credentials.
- Keep WhatsApp's remote page isolated from privileged desktop APIs and credentials.
- Send only the configured conversation context and style material to the selected model provider. Style learning and context sharing need understandable controls.
- Select a connector only after testing the personal-account session, message/context access, media access, and composer interaction.

Whatsie is an MIT-licensed Qt/C++ desktop client with useful existing desktop integrations. Its current bridge is not a complete message-reading and sending API. A fork could accelerate a Qt-focused desktop implementation, but would not directly provide the reusable browser/mobile interface or AI integration discussed here.

## Constraints and open questions

- Meta's official Cloud API targets business accounts; it is not a general API for the user's personal inbox.
- Personal-account automation through unofficial integrations has compatibility, maintenance, and account-restriction risks.
- An Electron wrapper cannot automatically fix behavior inherited from WhatsApp Web.
- Existing favorites appear to load on Linux, but collection completeness and delay need measurement.
- Rebuilding the complete chat interface creates substantial work for history, synchronization, attachments, reactions, accessibility, and calling. Do not promise native-client feature parity before verifying it.
- A mobile web interface cannot directly control the installed WhatsApp app. A companion design may depend on a running desktop or server connection; Electron itself is desktop-only.
- Decide the initial scope of outgoing-message history used for style learning, retention controls, and the fallback for sparse conversations.
- Verify that inline suggestions work with multiline drafts, keyboard navigation, input methods, and WhatsApp composer updates.

## Implementation milestones and status

1. Real isolated WhatsApp Web links successfully. Live suggestion generation and acceptance are verified on the observed layout; favorites completeness and media remain unverified.
2. Linux shell, persistent session partition and isolated local controls implemented and run.
3. Observed-sticker indexing, persistent tags/phrases, search and editor implemented and fixture-tested across restart.
4. OpenAI Responses, inline suggestions and refinement implemented. A dedicated user-authorized key is securely configured on the development machine and passed a synthetic request. Composer behavior is verified in Electron fixtures and a linked personal account for suggestions and Tab acceptance. The current opaque message-ID layout supports global assistance and locally recognized chat reply/style overrides. Recognition requires overlap with saved message-ID hashes; automatic sending still requires a real WhatsApp peer identifier.
5. Settings inheritance, scoped aggregate style profiles and Anthropic Messages implemented. Anthropic live-key checks remain open.
6. Per-chat automatic-send permissions, limits, countdown, takeover pause and guarded dispatch implemented. Rules and cancellation tested locally; no contact received a test message.
7. Linux packaging implemented; Windows/macOS targets configured but not platform-verified. Mobile remains future work.

## Reference sources checked during planning

- Whatsie repository: https://github.com/keshavbhatt/whatsie
- WhatsApp for Mac announcement: https://blog.whatsapp.com/new-whatsapp-app-for-mac-now-with-group-calling
- WhatsApp Business platform overview: https://developers.facebook.com/docs/whatsapp/cloud-api/overview
- whatsapp-web.js documentation and limitations: https://docs.wwebjs.dev/
- Electron security guidance: https://www.electronjs.org/docs/latest/tutorial/security

References provide context; library versions, API behavior, and compatibility should be checked again during implementation.
