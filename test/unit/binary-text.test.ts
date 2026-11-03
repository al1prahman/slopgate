import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeUtf16, hydrateUtf16NewFiles, rangeEndRef } from '../../src/core/binary-text.js';
import { parseDiff } from '../../src/core/diff.js';
import { getStagedDiff } from '../../src/core/git.js';
import { scanSecrets } from '../../src/core/secrets.js';

const SECRET_LINE = 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";';

function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

function utf16be(text: string): Buffer {
  const body = Buffer.from(text, 'utf16le');
  for (let i = 0; i + 1 < body.length; i += 2) {
    const low = body[i] as number;
    const high = body[i + 1] as number;
    body[i] = high;
    body[i + 1] = low;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
}

describe('decodeUtf16', () => {
  it('decodes a little-endian BOM', () => {
    expect(decodeUtf16(utf16le('hello\nworld'))).toBe('hello\nworld');
  });

  it('decodes a big-endian BOM', () => {
    expect(decodeUtf16(utf16be('hello\nworld'))).toBe('hello\nworld');
  });

  it('returns null without a BOM — that is indistinguishable from binary', () => {
    expect(decodeUtf16(Buffer.from('plain utf8', 'utf8'))).toBeNull();
    expect(decodeUtf16(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    expect(decodeUtf16(Buffer.alloc(0))).toBeNull();
  });
});

describe('rangeEndRef', () => {
  it('takes the right side of a two-dot range', () => {
    expect(rangeEndRef('HEAD~3..HEAD')).toBe('HEAD');
    expect(rangeEndRef('origin/main...feature')).toBe('feature');
  });

  it('treats a bare revision as its own end', () => {
    expect(rangeEndRef('HEAD~2')).toBe('HEAD~2');
  });

  it('falls back to HEAD for an empty tail', () => {
    expect(rangeEndRef('HEAD..')).toBe('HEAD');
  });
});

describe('hydrateUtf16NewFiles', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'slopgate-utf16-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git(['init', '-q', '.']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('recovers the lines of a new UTF-16 file so secrets are not skipped', () => {
    // git reports this file as binary: no numstat, no diff lines.
    writeFileSync(join(repo, 'probe.ts'), utf16le(`${SECRET_LINE}\nconst x = 1;\n`));
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });

    const files = parseDiff(getStagedDiff(repo));
    expect(files).toHaveLength(1);
    expect(files[0]?.isBinary).toBe(true);
    expect(files[0]?.addedLines).toHaveLength(0);

    const hydrated = hydrateUtf16NewFiles(files, repo, ':0');
    expect(hydrated[0]?.isBinary).toBe(false);
    expect(hydrated[0]?.addedLines.map((line) => line.content)).toEqual([
      SECRET_LINE,
      'const x = 1;',
    ]);

    // The point of the whole exercise: the scanner now sees it.
    const findings = scanSecrets(hydrated);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('secret.anthropic-key');
    expect(findings[0]?.file).toBe('probe.ts');
  });

  it('leaves genuinely binary files alone', () => {
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]));
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });

    const files = parseDiff(getStagedDiff(repo));
    const hydrated = hydrateUtf16NewFiles(files, repo, ':0');

    expect(hydrated[0]?.isBinary).toBe(true);
    expect(hydrated[0]?.addedLines).toHaveLength(0);
  });

  it('leaves modified UTF-16 files skipped — no line structure to recover', () => {
    writeFileSync(join(repo, 'mod.ts'), utf16le('const a = 1;\n'));
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'add utf16 file'], { cwd: repo, stdio: 'ignore' });

    writeFileSync(join(repo, 'mod.ts'), utf16le(`const a = 1;\n${SECRET_LINE}\n`));
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });

    const files = parseDiff(getStagedDiff(repo));
    expect(files[0]?.isNew).toBe(false);

    const hydrated = hydrateUtf16NewFiles(files, repo, ':0');
    expect(hydrated[0]?.isBinary).toBe(true);
  });
});
