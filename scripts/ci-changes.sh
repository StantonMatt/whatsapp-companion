#!/usr/bin/env bash
# Sourced by the Actions diff step; exit leaves its needed output unset.
set -euo pipefail

case "${GITHUB_EVENT_NAME:?}" in
  pull_request|push) CI_CHECK_BASE=${CI_BASE_SHA:?} ;;
  workflow_dispatch) CI_CHECK_BASE=$(git rev-parse --verify "${GITHUB_SHA:?}^" 2>/dev/null || git hash-object -t tree /dev/null) ;;
  *) echo 'Unsupported pipeline source' >&2; exit 1 ;;
esac
if [[ "$CI_CHECK_BASE" =~ ^0+$ ]]; then
  CI_CHECK_BASE=$(git hash-object -t tree /dev/null)
fi
export CI_CHECK_BASE

# A manual dispatch always runs both jobs, even for documentation changes.
if [[ "$GITHUB_EVENT_NAME" != workflow_dispatch ]]; then
  if git diff --quiet "$CI_CHECK_BASE" "${GITHUB_SHA:?}" -- . ':(glob,exclude)**/*.md' ':(glob,exclude)docs/**'; then
    echo 'Documentation-only changes: skipping checks.'
    exit 0
  else
    status=$?
    # A missing revision or other diff error must fail, never skip validation.
    if [[ "$status" != 1 ]]; then exit "$status"; fi
  fi
fi
