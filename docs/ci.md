# CI operation

GitHub is the primary host: `git@github.com:StantonMatt/whatsapp-companion.git`.
GitLab is a read-only mirror with CI/CD and schedules disabled. CI never uses
provider keys or real WhatsApp sessions and never deploys or restarts the service.

- Non-draft PRs targeting `main` run `fast`; source pushes to `main` run `fast`.
  Other branch pushes, tag pushes and draft PR updates do not run checks.
- `fast` tests the CI path filter, installs dependencies without the Electron
  binary, checks TypeScript and whitespace across the whole PR/push diff, runs
  the full unit/fixture integration suite with two workers, and builds. Unit
  fixtures use `/dev/shm` for disposable temporary profiles.
- Documentation-only main pushes (`**/*.md` and `docs/**`) are filtered before
  the workflow starts. Ready PRs always get a successful `fast` check; for
  documentation-only PRs, the diff step skips dependency installation and the
  remaining checks. Missing diff revisions fail closed.
- `ci:full` adds `full` after `fast` on source PRs. It runs sandboxed Electron
  desktop fixtures under Xvfb (15-minute limit), then packages an unsigned Linux
  AppImage with `--publish never`. Keep the label on composer/renderer and
  packaging PRs. Adding the label starts CI, and later updates keep running both
  jobs while it remains. Marking a PR ready also starts CI.
- **Actions → CI → Run workflow** runs both jobs on a selected branch or tag,
  even for documentation-only changes. Tag pushes do not trigger CI.
- New commits cancel superseded runs. Unrelated label events cannot cancel
  checks. Jobs time out after 10 and 20 minutes. Desktop diagnostics are
  collected after success or failure and retained for seven days; the fixture's
  screenshots are kept for 14 days as `desktop-screenshots`. Cancellation or a
  hard timeout can still interrupt upload.

Both jobs use Node.js 22 with npm download caching. The full job also caches
Electron and packaging downloads. Every job uses
`${{ fromJSON(vars.CI_LIGHT_RUNS_ON || '"ubuntu-latest"') }}`. Leave the variable
unset for now: Boat is not enabled for this repository. There are no matrix jobs
or automatic release/publish jobs, to keep private-repository minutes lean.

The full job installs desktop libraries and a root-owned setuid `chrome-sandbox`,
then runs Electron as the hosted runner's unprivileged user. Never disable the
sandbox to make a fixture pass. Package and profile data are disposable;
packaging never publishes a release.

Require passing CI before merging. The current GitHub plan does not provide
branch protection for this private repository, so the merge owner must verify
checks rather than relying on a server-enforced gate. Keep PRs draft until
stable, batch fixes before pushing, and complete review-fix-loop before
committing or pushing. If CI is unavailable, run required full checks locally
through `heavy`. Live account linking, key-store behavior and Windows/macOS
checks remain manual. Releases and their AppImage/checksum assets are published
manually on GitHub.
