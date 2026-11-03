import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { initCommand } from '../../src/commands/init.js';
import { defaultConfig, loadConfig } from '../../src/core/config.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slopgate-init-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

function hookPath(repo: string, name: string): string {
  return join(repo, '.git', 'hooks', name);
}

describe('initCommand', () => {
  it('installs pre-commit and pre-push hooks', () => {
    const repo = makeRepo();
    initCommand({ cwd: repo });

    expect(existsSync(hookPath(repo, 'pre-commit'))).toBe(true);
    expect(existsSync(hookPath(repo, 'pre-push'))).toBe(true);
    const preCommit = readFileSync(hookPath(repo, 'pre-commit'), 'utf8');
    expect(preCommit).toContain('slopgate scan --staged');
    const prePush = readFileSync(hookPath(repo, 'pre-push'), 'utf8');
    expect(prePush).toContain('slopgate scan');
    expect(prePush).toContain('--range');
  });

  it('scaffolds a .slopgate.yml with the agent section', () => {
    const repo = makeRepo();
    initCommand({ cwd: repo });

    const config = readFileSync(join(repo, '.slopgate.yml'), 'utf8');
    expect(config).toContain('agent:');
    expect(config).toContain('enabled: true');
  });

  it('scaffolds a .slopgate.yml that parses with no duplicate keys', () => {
    const repo = makeRepo();
    initCommand({ cwd: repo });

    // A duplicated top-level key (e.g. two deps: blocks) is a YAML error
    // that would break every scan in the consumer repo.
    const parsed = parseYaml(readFileSync(join(repo, '.slopgate.yml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed)).toEqual([
      'mode',
      'secrets',
      'deps',
      'python',
      'imports',
      'agent',
    ]);
    expect(loadConfig(repo)).toEqual(defaultConfig());
  });

  it('gitignores the cache dir, creating .gitignore when absent', () => {
    const repo = makeRepo();
    initCommand({ cwd: repo });

    expect(readFileSync(join(repo, '.gitignore'), 'utf8').split('\n')).toContain('.slopgate/');
  });

  it('appends to an existing .gitignore without touching its entries', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist\n');

    initCommand({ cwd: repo });

    const lines = readFileSync(join(repo, '.gitignore'), 'utf8').split('\n');
    expect(lines).toContain('node_modules');
    expect(lines).toContain('dist');
    expect(lines).toContain('.slopgate/');
  });

  it('does not duplicate the .gitignore entry on re-runs', () => {
    const repo = makeRepo();
    initCommand({ cwd: repo });
    const first = readFileSync(join(repo, '.gitignore'), 'utf8');
    initCommand({ cwd: repo });

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(first);
    expect(first.match(/\.slopgate\//g)).toHaveLength(1);
  });

  it('is idempotent — running twice does not duplicate the managed block', () => {
    const repo = makeRepo();
    initCommand({ cwd: repo });
    const first = readFileSync(hookPath(repo, 'pre-commit'), 'utf8');
    initCommand({ cwd: repo });
    const second = readFileSync(hookPath(repo, 'pre-commit'), 'utf8');
    expect(second).toBe(first);
    expect(second.match(/# >>> slopgate >>>/g)).toHaveLength(1);
  });

  it('preserves an existing custom hook by appending the managed block', () => {
    const repo = makeRepo();
    writeFileSync(hookPath(repo, 'pre-commit'), '#!/bin/sh\necho "custom hook runs"\n');
    initCommand({ cwd: repo });

    const content = readFileSync(hookPath(repo, 'pre-commit'), 'utf8');
    expect(content).toContain('echo "custom hook runs"');
    expect(content).toContain('slopgate scan --staged');
  });

  it('uninstall removes only the managed block', () => {
    const repo = makeRepo();
    writeFileSync(hookPath(repo, 'pre-commit'), '#!/bin/sh\necho "custom hook runs"\n');
    initCommand({ cwd: repo });
    initCommand({ cwd: repo, uninstall: true });

    const content = readFileSync(hookPath(repo, 'pre-commit'), 'utf8');
    expect(content).not.toContain('slopgate scan');
    expect(content).toContain('echo "custom hook runs"');
  });

  it('scaffolds .slopgate.yml only when missing', () => {
    const repo = makeRepo();
    initCommand({ cwd: repo });
    const configPath = join(repo, '.slopgate.yml');
    expect(existsSync(configPath)).toBe(true);

    writeFileSync(configPath, 'mode: warn\n');
    initCommand({ cwd: repo });
    expect(readFileSync(configPath, 'utf8')).toBe('mode: warn\n');
  });

  it('installs into .husky when husky is present', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.husky'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky');
    initCommand({ cwd: repo });

    expect(existsSync(join(repo, '.husky', 'pre-commit'))).toBe(true);
    const content = readFileSync(join(repo, '.husky', 'pre-commit'), 'utf8');
    expect(content).toContain('slopgate scan --staged');
  });
});
