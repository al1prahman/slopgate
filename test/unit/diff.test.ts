import { describe, expect, it } from 'vitest';
import { parseDiff } from '../../src/core/diff.js';

describe('parseDiff', () => {
  it('extracts added lines with correct new-file line numbers', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index abc1234..def5678 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -10,0 +11,2 @@ export function main() {',
      '+const a = 1;',
      '+const b = 2;',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/app.ts');
    expect(files[0]!.addedLines).toEqual([
      { line: 11, content: 'const a = 1;' },
      { line: 12, content: 'const b = 2;' },
    ]);
  });

  it('tracks line numbers across multiple hunks in one file', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,0 +1,1 @@',
      '+first',
      '@@ -50,2 +52,2 @@',
      ' context',
      '+third',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.addedLines).toEqual([
      { line: 1, content: 'first' },
      { line: 53, content: 'third' },
    ]);
  });

  it('handles multiple files in one diff', () => {
    const diff = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1,0 +1,1 @@',
      '+one',
      'diff --git a/two.ts b/two.ts',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -1,0 +1,1 @@',
      '+two',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
    expect(files[1]!.addedLines).toEqual([{ line: 1, content: 'two' }]);
  });

  it('detects renames and uses the new path', () => {
    const diff = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 100%',
      'rename from old-name.ts',
      'rename to new-name.ts',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.path).toBe('new-name.ts');
    expect(files[0]!.oldPath).toBe('old-name.ts');
    expect(files[0]!.addedLines).toEqual([]);
  });

  it('marks new files (--- /dev/null)', () => {
    const diff = [
      'diff --git a/fresh.ts b/fresh.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/fresh.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.isNew).toBe(true);
    expect(files[0]!.isDeleted).toBe(false);
    expect(files[0]!.addedLines).toHaveLength(2);
  });

  it('marks deleted files (+++ /dev/null)', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-removed',
      '-also removed',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.isDeleted).toBe(true);
    expect(files[0]!.addedLines).toEqual([]);
  });

  it('flags binary files and extracts no lines', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'index abc1234..def5678 100644',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.isBinary).toBe(true);
    expect(files[0]!.addedLines).toEqual([]);
  });

  it('handles mode-change-only entries with no hunks', () => {
    const diff = [
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.addedLines).toEqual([]);
    expect(files[0]!.isBinary).toBe(false);
  });

  it('ignores the no-newline marker and removed lines', () => {
    const diff = [
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      '\\ No newline at end of file',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.addedLines).toEqual([{ line: 1, content: 'new line' }]);
  });

  it('preserves leading whitespace and empty added lines', () => {
    const diff = [
      'diff --git a/indent.py b/indent.py',
      '--- a/indent.py',
      '+++ b/indent.py',
      '@@ -1,0 +1,3 @@',
      '+def foo():',
      '+    return 1',
      '+',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.addedLines).toEqual([
      { line: 1, content: 'def foo():' },
      { line: 2, content: '    return 1' },
      { line: 3, content: '' },
    ]);
  });

  it('handles paths containing spaces', () => {
    const diff = [
      'diff --git a/my file.txt b/my file.txt',
      '--- a/my file.txt',
      '+++ b/my file.txt',
      '@@ -1,0 +1,1 @@',
      '+content',
    ].join('\n');

    const files = parseDiff(diff);
    expect(files[0]!.path).toBe('my file.txt');
  });

  it('returns an empty array for an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });
});
