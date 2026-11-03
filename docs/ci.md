# CI operation

GitLab is the current host: `git@gitlab.com:StantonMatt/whatsapp-companion.git`.
`.gitlab-ci.yml` uses Node.js 22 in a Debian Bookworm container on the private
`ci-general` Docker runner. No provider keys or real WhatsApp sessions are used.

- Non-draft MRs targeting `main` run `fast`; pushes to `main` run `fast`.
  Other branch pushes, tag pushes, draft MR events and parent-project fork MR
  pipelines do not run. This avoids duplicate branch/MR pipelines.
- `fast` checks the CI path filter, installs dependencies without the Electron
  binary, checks TypeScript and whitespace across the MR/push diff, runs the full
  unit/fixture integration suite with two workers, and builds. Unit tests use
  `/dev/shm` for disposable temporary profiles so Docker OverlayFS fsync latency
  does not cause storage-fixture timeouts.
- `ci:full` adds `full` after `fast` on MRs. It runs the sandboxed Electron desktop
  fixtures under Xvfb (15-minute limit), then packages an unsigned Linux AppImage
  with `--publish never`. Keep the label on composer/renderer and packaging MRs.
- GitLab label changes do not generate a pipeline. After adding `ci:full`, use
  the MR's **Pipelines → Run pipeline** to evaluate the updated labels. After
  marking an MR ready, start an MR pipeline there if none starts automatically.
  Retrying an old job does not re-evaluate labels or draft status.
- **Build → Pipelines → New pipeline** on a branch or tag runs both jobs,
  including on a draft MR's branch; this is the equivalent of GitHub's workflow
  dispatch. Tag pushes still do not trigger CI.
- Documentation-only main pushes (`**/*.md` and `docs/**`) are filtered by
  workflow `rules:changes`. Ready MRs always get a pipeline so the successful
  pipeline merge gate can pass. The existing diff script exits successfully
  before dependency installation for a docs-only MR; it fails closed if the
  base cannot be read. Manual web pipelines always run checks.
- New commits cancel superseded interruptible work. Jobs time out after 10 and
  20 minutes respectively; the full job reserves one minute for artifact upload.
  Desktop diagnostics are collected regardless of the script result and retained
  for seven days from `.local/desktop-diagnostics/` and disposable profiles'
  `diagnostics/`. Cancellation can still interrupt the runner's upload.

The full job installs desktop libraries as root, then runs Electron and packaging
as the image's `node` user with a root-owned setuid `chrome-sandbox`. The runner
must permit Chromium's sandbox namespaces (for example, an appropriately isolated
privileged job container inside the disposable VM). Never disable the sandbox to
make a fixture pass. Package and profile data are disposable; packaging never
publishes a release.

Require a successful pipeline before merging. Keep MRs draft until stable, batch
fixes before pushing, and complete review-fix-loop before committing or pushing.
If CI is unavailable, run the required full checks locally through `heavy`.
Live account linking, key-store behavior and Windows/macOS checks remain manual.

## If moving back to GitHub

The `github` remote is `git@github.com:StantonMatt/whatsapp-companion.git`.
`.github/workflows` is the inactive GitHub version and stays untouched during the
migration. Sync it by hand only if a switch back happens. Restore GitHub branch
protection with passing CI required, use non-draft PRs to `main`, keep `ci:full`
on composer/renderer and packaging PRs (its label event triggers CI), and use
workflow dispatch to run both jobs manually. Disable GitLab CI when restoring
GitHub Actions to avoid running both systems.
