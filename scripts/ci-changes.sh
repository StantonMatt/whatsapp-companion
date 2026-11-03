#!/usr/bin/env bash
# Sourced by GitLab's before_script; exit skips the entire documentation job.
set -euo pipefail

case "${CI_PIPELINE_SOURCE:?}" in
  merge_request_event) CI_CHECK_BASE=${CI_MERGE_REQUEST_DIFF_BASE_SHA:?} ;;
  push) CI_CHECK_BASE=${CI_COMMIT_BEFORE_SHA:?} ;;
  web) CI_CHECK_BASE=$(git rev-parse --verify "${CI_COMMIT_SHA:?}^" 2>/dev/null || git hash-object -t tree /dev/null) ;;
  *) echo 'Unsupported pipeline source' >&2; exit 1 ;;
esac
if [[ "$CI_CHECK_BASE" =~ ^0+$ ]]; then
  CI_CHECK_BASE=$(git hash-object -t tree /dev/null)
fi
export CI_CHECK_BASE

# A manual web pipeline always runs both jobs, even for documentation changes.
if [[ "$CI_PIPELINE_SOURCE" != web ]]; then
  if git diff --quiet "$CI_CHECK_BASE" "${CI_COMMIT_SHA:?}" -- . ':(glob,exclude)**/*.md' ':(glob,exclude)docs/**'; then
    echo 'Documentation-only changes: skipping checks.'
    exit 0
  else
    status=$?
    # A missing revision or other diff error must fail, never skip validation.
    if [[ "$status" != 1 ]]; then exit "$status"; fi
  fi
fi
