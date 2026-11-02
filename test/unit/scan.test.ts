import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scanCommand } from '../../src/commands/scan.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slopgate-scan-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

async function runCli(
  repo: string,
  options: Parameters<typeof scanCommand>[0],
): Promise<{ code: number; out: string }> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const code = await scanCommand(options, repo);
    const out = spy.mock.calls.map((call) => String(call[0])).join('');
    return { code, out };
  } finally {
    spy.mockRestore();
  }
}

describe('scanCommand', () => {
  it('returns 0 for a clean staged commit', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'util.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true });
    expect(code).toBe(0);
    expect(out).toContain('clean. commit allowed.');
  });

  it('returns 2 when a secret is staged', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'fetch.ts'), `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true });
    expect(code).toBe(2);
    expect(out).toContain('secret.anthropic-key');
    expect(out).toContain('commit blocked');
  });

  it('returns 1 on warn-only findings', async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, 'config.ts'),
      'const credentials = load("xK9mP2qR7tY4wE6rT1yU3iO5pA8sD1fG");\n',
    );
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true });
    expect(code).toBe(1);
    expect(out).toContain('secret.high-entropy');
  });

  it('--format json emits a parseable ScanResult on stdout', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'fetch.ts'), `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true, format: 'json' });
    expect(code).toBe(2);
    const parsed = JSON.parse(out) as { verdict: string; findings: { rule: string }[] };
    expect(parsed.verdict).toBe('block');
    expect(parsed.findings.some((finding) => finding.rule === 'secret.anthropic-key')).toBe(true);
  });

  it('--format sarif emits a parseable SARIF document on stdout', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'fetch.ts'), `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true, format: 'sarif' });
    expect(code).toBe(2);
    const sarif = JSON.parse(out) as {
      version: string;
      runs: { tool: { driver: { name: string } }; results: { ruleId: string; level: string }[] }[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]!.tool.driver.name).toBe('slopgate');
    expect(sarif.runs[0]!.results[0]!.ruleId).toBe('secret.anthropic-key');
    expect(sarif.runs[0]!.results[0]!.level).toBe('error');
  });

  it('--mode warn downgrades a block to a warning (exit 1)', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'fetch.ts'), `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true, mode: 'warn' });
    expect(code).toBe(1);
    expect(out).toContain('commit allowed');
    expect(out).not.toContain('commit blocked');
  });

  it('--mode off skips the scan entirely', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'fetch.ts'), `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true, mode: 'off' });
    expect(code).toBe(0);
    expect(out).toContain('clean');
  });

  it('--quiet prints only the verdict line', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'fetch.ts'), `const key = "sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}";\n`);
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true, quiet: true });
    expect(code).toBe(2);
    expect(out.trim()).toBe('commit blocked. 1 blocking finding(s).');
  });

  it('--offline fails open with a warning instead of blocking', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'requirements.txt'), 'brand-new-package==1.0.0\n');
    git(repo, 'add', '-A');

    const { code, out } = await runCli(repo, { staged: true, offline: true });
    expect(code).toBe(1);
    expect(out).toContain('dep.registry-error');
    expect(out).toContain('fail-open');
  });
});
