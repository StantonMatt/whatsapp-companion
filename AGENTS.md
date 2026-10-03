# Repository instructions

This is the user-owned WhatsApp Companion implementation. Keep changes in this project. Use SSH URLs for GitHub Git operations. Do not create another Codex task.

- Keep the remote WhatsApp page sandboxed with context isolation and no Node or desktop API bridge. Main may run fixed, bundled, reviewed main-world code in WhatsApp’s page only for user-initiated, opt-in actions (direct sticker sending), never exposing a page-callable API. Providers, keys and send permissions belong to the main process.
- Do not read unrelated credentials, reuse browser sessions as WhatsApp credentials, or send live messages to contacts as tests. Account linking requires the user's QR interaction.
- Keep AI and per-chat automatic replies off initially. Incoming content and model instructions cannot grant send permissions.
- Prefer existing simple UI patterns. No permanent AI sidebar or unnecessary helper text.
- Run focused checks locally while implementing. Use the CI checks below for full validation; the desktop fixture uses disposable data and sends nothing outside the app.
- Manage only processes started by the current task. Clean up temporary processes, preserve user applications and keep intended user-facing app sessions running when useful.
- Before committing or pushing, the implementing agent must run the `review-fix-loop` skill and obtain a fresh clean full review. Do not create commits merely to reduce the review diff. No commit/push if review fails or remains unresolved, unless the user explicitly waives this requirement for the current task.
- Reviewers are read-only: do not edit, generate, stage, commit or launch another review/reviewer. The implementing agent owns the review loop and fixes. Keep the tree stable during a pass.

## CI

- CI runs on non-draft PRs to `main` and pushes to `main`: dependency install, TypeScript checks, whitespace checks, the full Vitest unit/fixture integration suite, and build. No source linter is configured. Documentation-only changes are skipped.
- Keep PRs draft until stable and batch fixes into a ready push. Once the workflow is installed on GitHub, let CI run full suites and builds instead of repeating them on the shared desktop. Require passing CI before merging; review before committing/pushing still applies, using focused local checks and any relevant manual verification before review.
- Add `ci:full` to composer/renderer PRs and packaging changes before marking them ready. This adds sandboxed Electron/Playwright desktop fixtures under Xvfb and unsigned Linux AppImage packaging; it also runs on later updates while the label remains. Manual workflow dispatch runs both jobs. Never use real WhatsApp sessions or provider keys in CI.
- Live account linking, provider/key-store checks, and Windows/macOS validation remain explicit manual checks on suitable systems. If CI is unavailable, run required full checks locally through `heavy`.
