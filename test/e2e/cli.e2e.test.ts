import { execFileSync, spawnSync } from 'node:child_process';
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

function seedCache(entries: Record<string, boolean>, ecosystem: 'npm' | 'pypi' = 'pypi'): void {
  const cache = new RegistryCache(join(repo, '.slopgate', 'cache.db'));
  for (const [name, exists] of Object.entries(entries)) {
    cache.set(ecosystem, name, exists);
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

  it('blocks a staged hallucinated npm import', () => {
    stage('src/app.ts', "import x from 'reqeusts';\n");
    seedCache({ reqeusts: false }, 'npm');

    const run = cli(['scan', '--staged']);

    expect(run.status).toBe(2);
    expect(run.stdout).toContain('import.not-found');
    expect(run.stdout).toContain('import "reqeusts" not found on npm');
  });

  it('warns — exit 1 — on an unmapped Python import', () => {
    stage('app/main.py', 'import reqeusts\n');
    seedCache({ reqeusts: false });

    const run = cli(['scan', '--staged']);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('import.unmapped');
    expect(run.stdout).not.toContain('commit blocked');
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

  it('the hook works with no slopgate on PATH — the npx fallback', () => {
    // The documented flow: `npx slopgate init` in a repo that does not
    // depend on slopgate. No shim, no local install — the hook must
    // resolve the scoped package over npx and still block a bad commit.
    // This is the exact state a fresh dogfood repo is in.
    expect(cli(['init']).status).toBe(0);

    stage('requirements.txt', 'reqeusts==1.0.0\n');
    seedCache({ reqeusts: false });

    const commit = spawnSync('git', ['commit', '-m', 'add bad dep'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(commit.status).not.toBe(0);
    expect(commit.stdout + commit.stderr).toContain('commit blocked');
  });

  it('the hook prefers node_modules/.bin over npx', () => {
    // A repo that installed slopgate as a devDependency: the hook must
    // call the local binary directly (measured ~0.2s) instead of paying
    // the npx registry round-trip (~3-4s) on every commit. The shim drops
    // a marker file, which proves the local branch is the one that ran.
    expect(cli(['init']).status).toBe(0);

    const binDir = join(repo, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const marker = join(repo, 'local-bin-marker');
    writeFileSync(
      join(binDir, 'slopgate'),
      `#!/bin/sh\ntouch "${posix(marker)}"\nexec "${posix(process.execPath)}" "${posix(CLI)}" "$@"\n`,
    );
    chmodSync(join(binDir, 'slopgate'), 0o755);

    stage('requirements.txt', 'reqeusts==1.0.0\n');
    seedCache({ reqeusts: false });

    const commit = spawnSync('git', ['commit', '-m', 'add bad dep'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(existsSync(marker)).toBe(true);
    expect(commit.status).not.toBe(0);
    expect(commit.stdout + commit.stderr).toContain('commit blocked');
  });

  it('blocks a secret hidden in a UTF-16 file', () => {
    // git marks UTF-16 text as binary, so the diff carries no lines. A file
    // written by PowerShell redirection or Notepad's "Unicode" save lands
    // in exactly that shape — the secret must still be caught. The shim
    // puts the local build on PATH: the npx fallback would fetch the
    // published version, which predates this fix.
    const binDir = join(repo, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'slopgate');
    writeFileSync(shim, `#!/bin/sh\nexec "${posix(process.execPath)}" "${posix(CLI)}" "$@"\n`);
    chmodSync(shim, 0o755);

    const init = cli(['init']);
    expect(init.status).toBe(0);

    const secret = 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";';
    writeFileSync(
      join(repo, 'probe.ts'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${secret}\n`, 'utf16le')]),
    );
    execFileSync('git', ['add', 'probe.ts'], { cwd: repo, stdio: 'ignore' });

    const commit = spawnSync('git', ['commit', '-m', 'add utf16 secret'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });

    expect(commit.status).not.toBe(0);
    // The hook runs with --quiet, so only the verdict line comes back; the
    // rule-level assertion lives in the unit test.
    expect(commit.stdout + commit.stderr).toContain('commit blocked');
  });

  it('stays quiet on stderr in a repo with no commits yet', () => {
    // readFileAtRef runs `git show HEAD:package.json` — on a repo with no
    // commits git prints "fatal: invalid object name 'HEAD'" unless stderr
    // is suppressed.
    stage('package.json', '{\n  "dependencies": {\n    "commander": "^15.0.0"\n  }\n}\n');
    const run = cli(['scan', '--staged', '--offline']);

    expect(run.status).toBe(1); // registry unreachable → warn (fail-open)
    expect(run.stderr).not.toContain('fatal:');
    expect(run.stderr).not.toContain('ExperimentalWarning');
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

  it('flags an agent-authored commit in a range scan', () => {
    stage('src/base.ts', 'export const base = 1;\n');
    spawnSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' });
    stage('src/util.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    spawnSync(
      'git',
      [
        'commit',
        '-m',
        'add util\n\n🤖 Generated with Claude Code (https://claude.ai/code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      ],
      { cwd: repo, stdio: 'ignore' },
    );

    const run = cli(['scan', '--range', 'HEAD~1..HEAD', '--offline']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('agent-authored commit');
    expect(run.stdout).toContain('🤖 Generated with Claude Code');
    expect(run.stdout).toContain('clean. commit allowed.');
  });

  it('prints no agent banner for a human-authored range scan', () => {
    stage('src/base.ts', 'export const base = 1;\n');
    spawnSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' });
    stage('src/util.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    spawnSync('git', ['commit', '-m', 'add util\n\nCo-Authored-By: Jane Doe <jane@example.com>'], {
      cwd: repo,
      stdio: 'ignore',
    });

    const run = cli(['scan', '--range', 'HEAD~1..HEAD', '--offline']);

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('agent-authored');
  });
});
