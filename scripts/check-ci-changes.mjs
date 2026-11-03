import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const script = resolve(import.meta.dirname, 'ci-changes.sh');

test('CI diff gate skips only documentation and fails closed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'companion-ci-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (path, content = 'text\n') => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
    git('add', '.');
    git('commit', '--quiet', '-m', path);
    return git('rev-parse', 'HEAD');
  };
  const run = (source, base, head) => spawnSync('bash', ['-c', 'source "$1"; echo "CHECKS:$CI_CHECK_BASE"', 'ci-test', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CI_PIPELINE_SOURCE: source, CI_COMMIT_SHA: head,
      CI_COMMIT_BEFORE_SHA: base, CI_MERGE_REQUEST_DIFF_BASE_SHA: base },
  });
  const check = (source, base, head, needed) => {
    const result = run(source, base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('CHECKS:'), needed, result.stdout);
    if (needed) assert.match(result.stdout.trim(), /^CHECKS:[0-9a-f]{40}$/);
  };
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    const root = commit('src/app.ts');
    const markdown = commit('README.md');
    const nested = commit('src/notes.md');
    const docs = commit('docs/diagram.svg');
    const source = commit('src/other.ts');
    const laterDocs = commit('docs/final.md');
    check('push', root, markdown, false);
    check('push', markdown, nested, false);
    check('push', nested, docs, false);
    check('push', docs, source, true);
    check('push', root, laterDocs, true); // Mixed multi-commit push.
    check('merge_request_event', root, laterDocs, true); // Entire MR, not last commit.
    check('merge_request_event', source, laterDocs, false);
    check('push', '0'.repeat(40), root, true);
    check('web', root, markdown, true);
    check('web', '', root, true); // Root commit also has a whitespace base.
    const error = run('merge_request_event', 'missing-revision', source);
    assert.notEqual(error.status, 0);
    assert.ok(!error.stdout.includes('CHECKS:'));
    assert.notEqual(run('schedule', root, source).status, 0);
    git('mv', 'src/app.ts', 'docs/app.md');
    git('commit', '--quiet', '-m', 'move source to docs');
    check('push', laterDocs, git('rev-parse', 'HEAD'), true); // Deletion remains checked.
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
