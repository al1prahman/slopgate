import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli.js';
import { SLOPGATE_VERSION } from '../../src/version.js';

// Commander actions are async (dynamic import + spawned git); poll for the
// effect instead of guessing a sleep duration.
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('cli skeleton', () => {
  it('exposes the package name and version', () => {
    const program = createProgram();
    expect(program.name()).toBe('slopgate');
    expect(program.version()).toBe(SLOPGATE_VERSION);
  });

  it('registers the init and scan commands', () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(['init', 'scan', 'cache']));
  });

  it('scan defaults to pretty output', () => {
    const program = createProgram();
    const scan = program.commands.find((command) => command.name() === 'scan');
    expect(scan).toBeDefined();
    const defaults = scan?.options.filter((option) => option.defaultValue !== undefined);
    expect(defaults?.map((option) => option.attributeName())).toContain('format');
  });

  it('rejects an unknown cache action through run() with exit 1', async () => {
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    try {
      const { run } = await import('../../src/cli.js');
      run(['node', 'slopgate', 'cache', 'bogus']);
      await waitFor(() => process.exitCode === 1);
      expect(process.exitCode).toBe(1);
      const err = errorSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(err).toContain('unknown cache action');
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('runs the init action against the current working directory', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'slopgate-cli-init-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previous = process.cwd();
    process.chdir(repo);
    try {
      const { run } = await import('../../src/cli.js');
      run(['node', 'slopgate', 'init']);
      await waitFor(() => existsSync(join(repo, '.git', 'hooks', 'pre-commit')));
      expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(true);
      expect(existsSync(join(repo, '.slopgate.yml'))).toBe(true);
    } finally {
      process.chdir(previous);
      stdoutSpy.mockRestore();
    }
  });

  it('runs the scan action and propagates the exit code', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'slopgate-cli-scan-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'fetch.ts'), `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    const previous = process.cwd();
    process.chdir(repo);
    try {
      const { run } = await import('../../src/cli.js');
      run(['node', 'slopgate', 'scan', '--staged']);
      await waitFor(() => process.exitCode === 2);
      expect(process.exitCode).toBe(2);
      const out = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(out).toContain('commit blocked');
    } finally {
      process.chdir(previous);
      process.exitCode = previousExitCode;
      stdoutSpy.mockRestore();
    }
  });
});
