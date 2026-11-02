import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { RegistryCache } from '../../src/core/registry/cache.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

if (!existsSync(CLI)) {
  throw new Error(`dist/cli.js not found at ${CLI} — run "npm run build" before the e2e suite`);
}

// Forward slashes keep paths valid inside the POSIX sh hook on Windows.
const posix = (value: string): string => value.replace(/\\/g, '/');

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'slopgate-e2e-'));
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'e2e@test');
  git('config', 'user.name', 'e2e');
});

function stage(path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  spawnSync('git', ['add', path], { cwd: repo, stdio: 'ignore' });
}

function seedCache(entries: Record<string, boolean>): void {
  const cache = new RegistryCache(join(repo, '.slopgate', 'cache.db'));
  for (const [name, exists] of Object.entries(entries)) {
    cache.set('pypi', name, exists);
  }
  cache.close();
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('slopgate e2e', () => {
  it('blocks a staged Anthropic key with exit 2 and no stderr noise', () => {
    stage('src/fetch.ts', `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    const run = cli(['scan', '--staged']);

    expect(run.status).toBe(2);
    expect(run.stdout).toContain('secret.anthropic-key');
    expect(run.stdout).toContain('commit blocked');
    // node:sqlite is experimental-labeled through Node 26; the CLI must not
    // leak that warning into hook stderr.
    expect(run.stderr).not.toContain('ExperimentalWarning');
  });

  it('blocks a hallucinated PyPI dep and suggests the real package', () => {
    stage('requirements.txt', 'reqeusts==1.0.0\n');
    seedCache({ reqeusts: false });
    const run = cli(['scan', '--staged']);

    expect(run.status).toBe(2);
    expect(run.stdout).toContain('"reqeusts" not found on PyPI');
    expect(run.stdout).toContain("did you mean 'requests'?");
  });

  it('passes a clean staged commit with exit 0', () => {
    stage('src/util.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    const run = cli(['scan', '--staged']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('clean. commit allowed.');
    expect(run.stderr).not.toContain('ExperimentalWarning');
  });

  it('exits 1 on warn-only findings (high-entropy credential)', () => {
    stage('src/config.ts', 'const credentials = load("xK9mP2qR7tY4wE6rT1yU3iO5pA8sD1fG");\n');
    const run = cli(['scan', '--staged']);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('secret.high-entropy');
    expect(run.stdout).toContain('commit allowed');
  });

  it('--json emits a parseable ScanResult', () => {
    stage('requirements.txt', 'reqeusts==1.0.0\n');
    seedCache({ reqeusts: false });
    const run = cli(['scan', '--staged', '--format', 'json']);

    expect(run.status).toBe(2);
    const parsed = JSON.parse(run.stdout) as {
      verdict: string;
      findings: { rule: string }[];
      filesScanned: number;
    };
    expect(parsed.verdict).toBe('block');
    expect(parsed.findings[0]?.rule).toBe('dep.not-found');
    expect(parsed.filesScanned).toBe(1);
  });

  it('fails open with a warning when the registry is unreachable (--offline)', () => {
    stage('requirements.txt', 'brand-new-package==1.0.0\n');
    const run = cli(['scan', '--staged', '--offline']);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('dep.registry-error');
    expect(run.stdout).toContain('fail-open');
  });

  it('cache stats and clear work against a real repo', () => {
    seedCache({ requests: true, reqeusts: false });

    const stats = cli(['cache']);
    expect(stats.status).toBe(0);
    expect(stats.stdout).toContain('entries: 2');
    expect(stats.stdout).toContain('1 found');
    expect(stats.stdout).toContain('1 not found');

    const clear = cli(['cache', 'clear']);
    expect(clear.status).toBe(0);
    expect(clear.stdout).toContain('cache cleared');
    expect(cli(['cache']).stdout).toContain('no cache yet');
  });

  it('rejects an unknown cache action with exit 1', () => {
    const run = cli(['cache', 'bogus']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown cache action');
  });

  it('the installed pre-commit hook blocks a real git commit', () => {
    // Put a shim named `slopgate` on PATH so the hook's `command -v` finds it.
    const binDir = join(repo, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'slopgate');
    writeFileSync(shim, `#!/bin/sh\nexec "${posix(process.execPath)}" "${posix(CLI)}" "$@"\n`);
    chmodSync(shim, 0o755);

    const init = cli(['init']);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain('pre-commit');

    stage('requirements.txt', 'reqeusts==1.0.0\n');
    seedCache({ reqeusts: false });

    const commit = spawnSync('git', ['commit', '-m', 'add bad dep'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });

    expect(commit.status).not.toBe(0);
    // git relays hook output on stderr to keep its own stdout scriptable.
    expect(commit.stdout + commit.stderr).toContain('commit blocked');
  });

  it('the installed pre-commit hook lets a clean commit through', () => {
    const binDir = join(repo, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'slopgate');
    writeFileSync(shim, `#!/bin/sh\nexec "${posix(process.execPath)}" "${posix(CLI)}" "$@"\n`);
    chmodSync(shim, 0o755);

    expect(cli(['init']).status).toBe(0);

    stage('src/util.ts', 'export const add = (a: number, b: number): number => a + b;\n');

    const commit = spawnSync('git', ['commit', '-m', 'add clean util'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });

    expect(commit.status).toBe(0);
    expect(commit.stdout + commit.stderr).toContain('clean. commit allowed.');
  });
});
