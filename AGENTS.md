# Repository instructions

This is the user-owned WhatsApp Companion implementation. Keep changes in this project. Use SSH URLs for GitLab Git operations (`git@gitlab.com:StantonMatt/whatsapp-companion.git`). Do not create another Codex task.

- Keep the remote WhatsApp page sandboxed with context isolation and no Node or desktop API bridge. Main may run fixed, bundled, reviewed main-world code in WhatsApp’s page only for user-initiated, opt-in actions (direct sticker sending), never exposing a page-callable API. Providers, keys and send permissions belong to the main process.
- Do not read unrelated credentials, reuse browser sessions as WhatsApp credentials, or send live messages to contacts as tests. Account linking requires the user's QR interaction.
- Keep AI and per-chat automatic replies off initially. Incoming content and model instructions cannot grant send permissions.
- Prefer existing simple UI patterns. No permanent AI sidebar or unnecessary helper text.
- Run focused checks locally while implementing. Use the CI checks below for full validation; the desktop fixture uses disposable data and sends nothing outside the app.
- Manage only processes started by the current task. Clean up temporary processes, preserve user applications and keep intended user-facing app sessions running when useful.
- Before committing or pushing, the implementing agent must run the `review-fix-loop` skill and obtain a fresh clean full review. Do not create commits merely to reduce the review diff. No commit/push if review fails or remains unresolved, unless the user explicitly waives this requirement for the current task.
- Reviewers are read-only: do not edit, generate, stage, commit or launch another review/reviewer. The implementing agent owns the review loop and fixes. Keep the tree stable during a pass.

## CI

- GitLab CI runs on non-draft MRs to `main` and pushes to `main`: dependency install, TypeScript checks, whitespace checks, the full Vitest unit/fixture integration suite, and build. No source linter is configured. Documentation-only changes are skipped. See [CI operation](docs/ci.md).
- Keep MRs draft until stable and batch fixes into a ready push. Let GitLab CI run full suites and builds instead of repeating them on the shared desktop. Require passing CI before merging; review before committing/pushing still applies, using focused local checks and any relevant manual verification before review.
- Add `ci:full` to composer/renderer MRs and packaging changes before marking them ready. This adds sandboxed Electron/Playwright desktop fixtures under Xvfb and unsigned Linux AppImage packaging; it also runs on later updates while the label remains. GitLab label edits do not trigger pipelines: run a new MR pipeline after adding the label, or after marking ready if no pipeline starts. A manual web pipeline runs both jobs. Never use real WhatsApp sessions or provider keys in CI.
- Live account linking, provider/key-store checks, and Windows/macOS validation remain explicit manual checks on suitable systems. If CI is unavailable, run required full checks locally through `heavy`.

## If moving back to GitHub

Use the retained `github` SSH remote (`git@github.com:StantonMatt/whatsapp-companion.git`) and PRs to `main`, kept draft until stable. `.github/workflows` is the inactive GitHub version; keep it unchanged during the GitLab migration and sync it by hand only if switching back. Its `ci:full` label event starts the full job, and workflow dispatch runs both jobs. Require passing GitHub CI before merging.
