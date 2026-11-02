import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRangeDiff, getStagedDiff, gitConfig, readFileAtRef } from '../../src/core/git.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slopgate-git-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

describe('git helpers', () => {
  it('getStagedDiff returns only staged changes', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');

    writeFileSync(join(repo, 'a.txt'), 'one\nstaged\n');
    writeFileSync(join(repo, 'b.txt'), 'unstaged\n');
    git(repo, 'add', 'a.txt');

    const diff = getStagedDiff(repo);
    expect(diff).toContain('+staged');
    expect(diff).not.toContain('unstaged');
  });

  it('getRangeDiff returns the diff for a commit range', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');

    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'second');

    expect(getRangeDiff(repo, 'HEAD~1..HEAD')).toContain('+two');
  });

  it('readFileAtRef returns content at a ref and null when missing', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');

    expect(readFileAtRef(repo, 'HEAD', 'a.txt')).toBe('one\n');
    expect(readFileAtRef(repo, 'HEAD', 'missing.txt')).toBeNull();
  });

  it('gitConfig returns empty string for unset keys and the value when set', () => {
    const repo = makeRepo();
    expect(gitConfig(repo, 'core.hooksPath')).toBe('');
    git(repo, 'config', 'core.hooksPath', '.husky');
    expect(gitConfig(repo, 'core.hooksPath')).toBe('.husky');
  });
});
