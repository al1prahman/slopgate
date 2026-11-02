import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  globToRegExp,
  isIgnoredPath,
  loadConfig,
  parseInlineIgnore,
} from '../../src/core/config.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'slopgate-config-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('defaultConfig', () => {
  it('blocks by default with both ecosystems enabled', () => {
    const config = defaultConfig();
    expect(config.mode).toBe('block');
    expect(config.secrets.enabled).toBe(true);
    expect(config.deps.enabled).toBe(true);
    expect(config.deps.ecosystems).toEqual(['npm', 'pypi']);
    expect(config.deps.registries.npm).toBe('https://registry.npmjs.org');
    expect(config.deps.registries.pypi).toBe('https://pypi.org/pypi');
  });

  it('enables the typosquat check with sensible defaults', () => {
    expect(defaultConfig().deps.typosquat).toEqual({
      enabled: true,
      maxDistance: 2,
      maxAgeDays: 90,
    });
  });

  it('enables import scanning by default', () => {
    expect(defaultConfig().imports.enabled).toBe(true);
  });
});

describe('loadConfig', () => {
  it('returns defaults when .slopgate.yml is missing', () => {
    expect(loadConfig(repoRoot)).toEqual(defaultConfig());
  });

  it('merges a partial config over defaults', () => {
    writeFileSync(
      join(repoRoot, '.slopgate.yml'),
      ['mode: warn', 'secrets:', '  ignore:', "    - '**/*.test.ts'"].join('\n'),
    );

    const config = loadConfig(repoRoot);
    expect(config.mode).toBe('warn');
    expect(config.secrets.ignore).toEqual(['**/*.test.ts']);
    // untouched sections keep defaults
    expect(config.deps.ecosystems).toEqual(['npm', 'pypi']);
    expect(config.python.unmappedImports).toBe('warn');
  });

  it('reads a full config', () => {
    writeFileSync(
      join(repoRoot, '.slopgate.yml'),
      [
        'mode: block',
        'deps:',
        '  ecosystems: [npm]',
        '  allowlist: [my-internal-pkg]',
        '  custom-index: [https://npm.internal.co]',
        'imports:',
        '  enabled: false',
      ].join('\n'),
    );

    const config = loadConfig(repoRoot);
    expect(config.deps.ecosystems).toEqual(['npm']);
    expect(config.deps.allowlist).toEqual(['my-internal-pkg']);
    expect(config.deps.customIndex).toEqual(['https://npm.internal.co']);
    expect(config.imports.enabled).toBe(false);
  });

  it('throws a helpful error on malformed YAML', () => {
    writeFileSync(join(repoRoot, '.slopgate.yml'), 'mode: [block\n  bad: yaml');
    expect(() => loadConfig(repoRoot)).toThrow(/\.slopgate\.yml/);
  });

  it('returns defaults for an empty config file', () => {
    writeFileSync(join(repoRoot, '.slopgate.yml'), '');
    expect(loadConfig(repoRoot)).toEqual(defaultConfig());
  });

  it('throws when the top level is not a mapping', () => {
    writeFileSync(join(repoRoot, '.slopgate.yml'), '- one\n- two\n');
    expect(() => loadConfig(repoRoot)).toThrow(/must contain a YAML mapping/);
  });

  it('accepts camelCase aliases for kebab-case keys', () => {
    writeFileSync(
      join(repoRoot, '.slopgate.yml'),
      ['deps:', '  customIndex: [https://npm.internal.co]', 'python:', '  unmappedImports: ignore'].join(
        '\n',
      ),
    );

    const config = loadConfig(repoRoot);
    expect(config.deps.customIndex).toEqual(['https://npm.internal.co']);
    expect(config.python.unmappedImports).toBe('ignore');
  });

  it('ignores config values of the wrong type', () => {
    writeFileSync(
      join(repoRoot, '.slopgate.yml'),
      ['mode: 123', 'deps:', '  registries:', '    npm: 456'].join('\n'),
    );

    const config = loadConfig(repoRoot);
    expect(config.mode).toBe('block'); // invalid mode falls back to default
    expect(config.deps.registries.npm).toBe('https://registry.npmjs.org');
  });

  it('reads typosquat settings (kebab-case and camelCase)', () => {
    writeFileSync(
      join(repoRoot, '.slopgate.yml'),
      [
        'deps:',
        '  typosquat:',
        '    enabled: false',
        '    max-distance: 1',
        '    maxAgeDays: 30',
      ].join('\n'),
    );

    const config = loadConfig(repoRoot);
    expect(config.deps.typosquat).toEqual({ enabled: false, maxDistance: 1, maxAgeDays: 30 });
  });

  it('ignores out-of-range typosquat values', () => {
    writeFileSync(
      join(repoRoot, '.slopgate.yml'),
      ['deps:', '  typosquat:', '    max-distance: 99', '    max-age-days: -5'].join('\n'),
    );

    const config = loadConfig(repoRoot);
    expect(config.deps.typosquat.maxDistance).toBe(2); // falls back to default
    expect(config.deps.typosquat.maxAgeDays).toBe(90);
  });
});

describe('globToRegExp / isIgnoredPath', () => {
  it('matches ** across directories', () => {
    expect(isIgnoredPath(['**/*.test.ts'], 'src/deep/app.test.ts')).toBe(true);
  });

  it('single * does not cross directory separators', () => {
    const re = globToRegExp('*.md');
    expect(re.test('README.md')).toBe(true);
    expect(re.test('docs/README.md')).toBe(false);
  });

  it('** matches whole subtrees', () => {
    expect(isIgnoredPath(['**/fixtures/**'], 'test/fixtures/secrets.txt')).toBe(true);
    expect(isIgnoredPath(['**/fixtures/**'], 'test/unit/app.test.ts')).toBe(false);
  });

  it('matches exact paths', () => {
    expect(isIgnoredPath(['CHANGELOG.md'], 'CHANGELOG.md')).toBe(true);
    expect(isIgnoredPath(['CHANGELOG.md'], 'docs/CHANGELOG.md')).toBe(false);
  });

  it('returns false when no patterns match', () => {
    expect(isIgnoredPath(['**/*.test.ts'], 'src/app.ts')).toBe(false);
    expect(isIgnoredPath([], 'src/app.ts')).toBe(false);
  });

  it('? matches exactly one character', () => {
    const re = globToRegExp('a?c.txt');
    expect(re.test('abc.txt')).toBe(true);
    expect(re.test('a/c.txt')).toBe(false);
  });
});

describe('parseInlineIgnore', () => {
  it('extracts a rule-specific ignore', () => {
    expect(parseInlineIgnore('const k = 1; // slopgate:ignore secret.anthropic-key')).toEqual([
      'secret.anthropic-key',
    ]);
  });

  it('extracts a file-level ignore', () => {
    expect(parseInlineIgnore('// slopgate:ignore-file')).toBe('file');
  });

  it('returns null for ordinary lines', () => {
    expect(parseInlineIgnore('const k = 1; // regular comment')).toBeNull();
  });
});
