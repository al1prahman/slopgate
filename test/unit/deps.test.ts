import { describe, expect, it } from 'vitest';
import { extractDepCandidates, parseRequirement } from '../../src/core/deps.js';
import type { ChangedFile } from '../../src/core/types.js';

function changedFile(path: string, ...contents: string[]): ChangedFile {
  return {
    path,
    addedLines: contents.map((content, index) => ({ line: index + 1, content })),
    isBinary: false,
    isNew: false,
    isDeleted: false,
  };
}

describe('parseRequirement', () => {
  it('extracts a plain name', () => {
    expect(parseRequirement('requests==2.31.0')).toBe('requests');
  });

  it('strips extras, version specifiers and markers', () => {
    expect(parseRequirement('uvicorn[standard]>=0.20')).toBe('uvicorn');
    expect(parseRequirement('flask>=2.0 ; python_version >= "3.8"')).toBe('flask');
    expect(parseRequirement('numpy~=1.24')).toBe('numpy');
  });

  it('keeps the name from direct URL references', () => {
    expect(parseRequirement('torch @ https://download.pytorch.org/whl/cpu/torch.whl')).toBe('torch');
  });

  it('ignores comments, options and blank lines', () => {
    expect(parseRequirement('# comment')).toBeNull();
    expect(parseRequirement('-r base.txt')).toBeNull();
    expect(parseRequirement('--index-url https://pypi.org/simple')).toBeNull();
    expect(parseRequirement('-e .')).toBeNull();
    expect(parseRequirement('')).toBeNull();
    expect(parseRequirement('   ')).toBeNull();
  });

  it('strips inline comments', () => {
    expect(parseRequirement('requests==2.31.0  # http client')).toBe('requests');
  });
});

describe('extractDepCandidates', () => {
  const reader = {
    read: () => null,
    readAtRef: () => null,
  };

  it('extracts candidates from added requirements.txt lines', () => {
    const files = [changedFile('requirements.txt', 'requests==2.31.0', 'flask>=2.0')];
    const candidates = extractDepCandidates(files, reader);
    expect(candidates).toEqual([
      { name: 'requests', ecosystem: 'pypi', file: 'requirements.txt', line: 1 },
      { name: 'flask', ecosystem: 'pypi', file: 'requirements.txt', line: 2 },
    ]);
  });

  it('reports only newly added package.json dependencies', () => {
    const head = JSON.stringify({
      dependencies: { react: '^18.0.0', lodash: '^4.17.0' },
    });
    const current = JSON.stringify({
      dependencies: { react: '^18.0.0', lodash: '^4.17.0', reqeusts: '^1.0.0' },
    });
    const files = [changedFile('package.json', '    "reqeusts": "^1.0.0"')];
    const candidates = extractDepCandidates(files, {
      read: () => current,
      readAtRef: () => head,
    });
    expect(candidates).toEqual([
      { name: 'reqeusts', ecosystem: 'npm', file: 'package.json', line: 1 },
    ]);
  });

  it('reports changed versions of existing dependencies', () => {
    const head = JSON.stringify({ devDependencies: { vitest: '^1.0.0' } });
    const current = JSON.stringify({ devDependencies: { vitest: '^2.0.0' } });
    const files = [changedFile('package.json', '    "vitest": "^2.0.0"')];
    const candidates = extractDepCandidates(files, {
      read: () => current,
      readAtRef: () => head,
    });
    expect(candidates.map((c) => c.name)).toEqual(['vitest']);
  });

  it('reports all dependencies when no HEAD version exists (new manifest)', () => {
    const current = JSON.stringify({ dependencies: { commander: '^15.0.0', yaml: '^2.0.0' } });
    const files = [changedFile('package.json', '{', '  "dependencies": {', '  }', '}')];
    const candidates = extractDepCandidates(files, {
      read: () => current,
      readAtRef: () => null,
    });
    expect(candidates.map((c) => c.name).sort()).toEqual(['commander', 'yaml']);
  });

  it('skips malformed package.json without crashing', () => {
    const files = [changedFile('package.json', '{ not json')];
    expect(() =>
      extractDepCandidates(files, { read: () => '{ not json', readAtRef: () => null }),
    ).not.toThrow();
  });

  it('ignores non-manifest files', () => {
    const files = [changedFile('src/index.ts', "import x from 'yaml';")];
    expect(extractDepCandidates(files, reader)).toEqual([]);
  });
});
