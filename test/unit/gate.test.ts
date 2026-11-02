import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runScan } from '../../src/core/gate.js';
import { defaultConfig } from '../../src/core/config.js';
import type { SlopgateConfig } from '../../src/core/config.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slopgate-gate-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

function commitBase(repo: string): void {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ dependencies: { commander: '^15.0.0' } }));
  writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'base');
}

// Registry fake: only these names are "missing".
function registryFake(missing: string[]): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const raw = String(url).replace(/\/json$/, '').replace(/\/$/, '');
    const name = decodeURIComponent(raw.split('/').pop() ?? '');
    const normalized = name.replace(/%2f/gi, '/').toLowerCase();
    const isMissing = missing.some((m) => normalized === m.toLowerCase());
    return new Response(null, { status: isMissing ? 404 : 200 });
  }) as unknown as typeof fetch;
}

// Registry fake with package ages (PyPI-shaped packuments). Names without an
// age entry exist but expose no creation date.
function registryFakeWithAges(ages: Record<string, string>, missing: string[] = []): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const raw = String(url).replace(/\/json$/, '').replace(/\/$/, '');
    const name = decodeURIComponent(raw.split('/').pop() ?? '');
    const normalized = name.replace(/%2f/gi, '/').toLowerCase();
    if (missing.some((m) => normalized === m.toLowerCase())) {
      return new Response(null, { status: 404 });
    }
    const created = ages[normalized];
    const body = created
      ? JSON.stringify({ releases: { '1.0.0': [{ upload_time_iso_8601: created }] } })
      : null;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function configWith(overrides: Partial<SlopgateConfig>): SlopgateConfig {
  return { ...defaultConfig(), ...overrides };
}

describe('runScan', () => {
  it('blocks a commit that adds a hallucinated dependency', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFake(['reqeusts']),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('block');
    const finding = result.findings.find((f) => f.rule === 'dep.not-found');
    expect(finding).toBeDefined();
    expect(finding!.file).toBe('requirements.txt');
    expect(finding!.suggestion).toBe('requests');
  });

  it('passes when all dependencies exist', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nflask>=2.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFake([]),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  it('blocks a leaked Anthropic key', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'src.ts'), "const key = 'sk-ant-api03-AbCd\u0045f1234567890AbCdEf';\n");
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'ai.ts'), "const key = 'sk-ant-api03-AbCd\u0045f1234567890AbCdEf';\n");
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFake([]),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('block');
    expect(result.findings.some((f) => f.rule === 'secret.anthropic-key')).toBe(true);
  });

  it('suppresses findings for allowlisted packages', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nmy-internal-lib==1.0.0\n');
    git(repo, 'add', '-A');

    const config = configWith({});
    config.deps.allowlist = ['my-internal-lib'];

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config,
      fetchFn: registryFake(['my-internal-lib']),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
  });

  it('suppresses secrets in ignored paths', async () => {
    const repo = makeRepo();
    commitBase(repo);
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'fixture.ts'), "const key = 'sk-ant-api03-AbCd\u0045f1234567890AbCdEf';\n");
    git(repo, 'add', '-A');

    const config = configWith({});
    config.secrets.ignore = ['**/fixture.ts'];

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config,
      fetchFn: registryFake([]),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
  });

  it('honors inline ignore-file comments', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(
      join(repo, 'legacy.ts'),
      "// slopgate:ignore-file\nconst key = 'sk-ant-api03-AbCd\u0045f1234567890AbCdEf';\n",
    );
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFake([]),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
  });

  it('fails open with a warning when the registry errors', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nbrand-new-pkg==1.0.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('warn');
    expect(result.findings.some((f) => f.rule === 'dep.registry-error')).toBe(true);
  });

  it('downgrades blocks to warnings in warn mode', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: configWith({ mode: 'warn' }),
      fetchFn: registryFake(['reqeusts']),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('warn');
    expect(result.findings.every((f) => f.severity !== 'block')).toBe(true);
  });

  it('serves registry verdicts from cache on the second run', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');
    const cachePath = join(repo, '.slopgate', 'cache.db');

    const first = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFake(['reqeusts']),
      cachePath,
    });
    expect(first.verdict).toBe('block');
    expect(first.cacheHits).toBe(0);

    // Second run: registry is DOWN, but the negative verdict is cached.
    const second = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
      cachePath,
    });
    expect(second.verdict).toBe('block');
    expect(second.cacheHits).toBeGreaterThan(0);
  });

  it('reports file and line counts', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFake([]),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.filesScanned).toBe(1);
    expect(result.linesAdded).toBeGreaterThanOrEqual(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('warns when an existing package is a fresh look-alike of a popular one', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFakeWithAges({ reqeusts: daysAgo(10) }),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('warn');
    const finding = result.findings.find((f) => f.rule === 'dep.typosquat');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
    expect(finding!.suggestion).toBe('requests');
    expect(finding!.message).toMatch(/2 edit/);
    expect(finding!.message).toMatch(/10 day/);
  });

  it('does not warn when the look-alike is older than the window', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFakeWithAges({ reqeusts: '2020-01-01T00:00:00.000Z' }),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  it('does not warn when the name is far from anything popular', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nbrand-new-pkg==1.0.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFakeWithAges({ 'brand-new-pkg': daysAgo(1) }),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  it('does not warn when the registry exposes no creation date', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFakeWithAges({}), // exists, but no age in the packument
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
  });

  it('warns on cache hits too — the age survives the cache', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');
    const cachePath = join(repo, '.slopgate', 'cache.db');

    const first = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: registryFakeWithAges({ reqeusts: daysAgo(10) }),
      cachePath,
    });
    expect(first.verdict).toBe('warn');
    expect(first.cacheHits).toBe(0);

    // Second run: registry is DOWN, but the verdict and age are cached.
    const second = await runScan({
      repoRoot: repo,
      staged: true,
      config: defaultConfig(),
      fetchFn: vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
      cachePath,
    });
    expect(second.verdict).toBe('warn');
    expect(second.cacheHits).toBeGreaterThan(0);
    expect(second.findings.some((f) => f.rule === 'dep.typosquat')).toBe(true);
  });

  it('suppresses the typosquat warning for allowlisted packages', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const config = configWith({});
    config.deps.allowlist = ['reqeusts'];

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config,
      fetchFn: registryFakeWithAges({ reqeusts: daysAgo(10) }),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
  });

  it('typosquat can be disabled via config', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const config = configWith({});
    config.deps.typosquat.enabled = false;

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config,
      fetchFn: registryFakeWithAges({ reqeusts: daysAgo(10) }),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  it('honors a custom max-age-days window', async () => {
    const repo = makeRepo();
    commitBase(repo);
    writeFileSync(join(repo, 'requirements.txt'), 'requests==2.31.0\nreqeusts==1.0.0\n');
    git(repo, 'add', '-A');

    const config = configWith({});
    config.deps.typosquat.maxAgeDays = 5;

    const result = await runScan({
      repoRoot: repo,
      staged: true,
      config,
      fetchFn: registryFakeWithAges({ reqeusts: daysAgo(10) }),
      cachePath: join(repo, '.slopgate', 'cache.db'),
    });

    expect(result.verdict).toBe('pass'); // 10 days old, window is 5
  });
});
