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

// pyproject.toml is the modern Python manifest and was not read at all —
// a pyproject-based project had no slopsquatting protection. Found
// dogfooding a 30-commit Python monorepo.
// pyproject.toml is the modern Python manifest and was not read at all -
// a pyproject-based project had no slopsquatting protection. Found
// dogfooding a 30-commit Python monorepo.
describe('pyproject.toml dependency extraction', () => {
  // A realistic file: the dependency sections plus the tool config that
  // shares the same file and whose quoted strings look like dependencies.
  const PEP621 = [
    '[project]',
    'name = "curio-ai"',
    'version = "0.1.0"',
    'description = "CurioAI - Enterprise Knowledge & AI Intelligence Platform (RAG)"',
    'requires-python = ">=3.13"',
    'readme = "README.md"',
    'dependencies = [',
    '    "fastapi[standard]>=0.115.0",',
    '    "uvicorn[standard]>=0.32.0",',
    '    "reqeusts>=1.0.0",',
    '    "pytest",',
    ']',
    '',
    '[project.optional-dependencies]',
    'dev = ["ruff>=0.8.0", "mypy>=1.13.0"]',
    '',
    '[tool.ruff.lint]',
    'ignore = ["SIM", "B008"]',
    '',
    '[tool.mypy]',
    'overrides = [',
    '    { module = "app.api", disallow_untyped_defs = true },',
    ']',
    '',
    '[tool.pytest.ini_options]',
    'testpaths = ["tests"]',
  ].join("\n");

  const POETRY = [
    '[tool.poetry.dependencies]',
    'python = "^3.13"',
    'fastapi = "^0.115.0"',
    '',
    '[tool.poetry.group.dev.dependencies]',
    'pytest = "^8.0.0"',
  ].join("\n");

  function scan(content: string, ...added: string[]): { name: string; line: number }[] {
    const reader = { read: () => content, readAtRef: () => null };
    const file: ChangedFile = {
      path: 'pyproject.toml',
      addedLines: added.map((line, index) => ({ line: index + 1, content: line })),
      isBinary: false,
      isNew: false,
      isDeleted: false,
    };
    return extractDepCandidates([file], reader).map((c) => ({ name: c.name, line: c.line }));
  }

  function names(content: string, ...added: string[]): string[] {
    return scan(content, ...added).map((c) => c.name);
  }

  it('reads a PEP 621 array entry with extras and a specifier', () => {
    expect(names(PEP621, '    "fastapi[standard]>=0.115.0",')).toEqual(['fastapi']);
    expect(names(PEP621, '    "uvicorn[standard]>=0.32.0",')).toEqual(['uvicorn']);
    expect(names(PEP621, '    "reqeusts>=1.0.0",')).toEqual(['reqeusts']);
  });

  it('reads a bare name with no specifier', () => {
    expect(names(PEP621, '    "pytest",')).toEqual(['pytest']);
  });

  it('reads an optional-dependencies group entry', () => {
    expect(names(PEP621, 'dev = ["ruff>=0.8.0", "mypy>=1.13.0"]')).toEqual(['ruff', 'mypy']);
  });

  it('ignores comments and section headers', () => {
    expect(names(PEP621, '# Web framework', '[project]', 'dependencies = [')).toEqual([]);
  });

  it('does not mistake project metadata for a package', () => {
    expect(
      names(
        PEP621,
        'name = "curio-ai"',
        'version = "0.1.0"',
        'description = "CurioAI - Enterprise Knowledge & AI Intelligence Platform (RAG)"',
        'requires-python = ">=3.13"',
        'readme = "README.md"',
      ),
    ).toEqual([]);
  });

  it('does not mistake tool config for a package', () => {
    // The exact false positives dogfooding produced: a ruff ignore code, a
    // mypy error code, and a pytest directory.
    expect(names(PEP621, '    "SIM",')).toEqual([]);
    expect(names(PEP621, 'ignore = ["SIM", "B008"]')).toEqual([]);
    expect(names(PEP621, 'testpaths = ["tests"]')).toEqual([]);
  });

  it('does not mistake a URL for a package', () => {
    expect(
      names(PEP621, '    "https://files.pythonhosted.org/packages/e0/7c/tokenizers.tar.gz",'),
    ).toEqual([]);
  });

  it('reads poetry table entries, skipping the interpreter constraint', () => {
    expect(names(POETRY, 'fastapi = "^0.115.0"')).toEqual(['fastapi']);
    expect(names(POETRY, 'python = "^3.13"')).toEqual([]);
    expect(names(POETRY, 'pytest = "^8.0.0"')).toEqual(['pytest']);
  });

  it('does not read poetry table entries in a PEP 621 file', () => {
    expect(names(PEP621, 'version = "0.1.0"')).toEqual([]);
  });

  it('reports the line the dependency was added on', () => {
    const candidates = scan(PEP621, 'dependencies = [', '    "reqeusts>=1.0.0",', ']');
    expect(candidates[0]).toEqual({ name: 'reqeusts', line: 2 });
  });

  it('matches by name, so a moved line still resolves', () => {
    // A dependency added in an old commit sits at a different line by HEAD;
    // the diff line number is the old one, the name is unchanged.
    expect(scan(PEP621, '    "reqeusts>=1.0.0",')).toEqual([{ name: 'reqeusts', line: 1 }]);
  });
});

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

  it('skips file: and workspace: protocol refs (never on the public registry)', () => {
    const current = JSON.stringify({
      dependencies: {
        'local-pkg': 'file:../local-pkg',
        'monorepo-lib': 'workspace:*',
        commander: '^15.0.0',
      },
    });
    const files = [changedFile('package.json', '{', '  "dependencies": {', '  }', '}')];
    const candidates = extractDepCandidates(files, {
      read: () => current,
      readAtRef: () => null,
    });
    expect(candidates.map((c) => c.name)).toEqual(['commander']);
  });

  it('ignores non-manifest files', () => {
    const files = [changedFile('src/index.ts', "import x from 'yaml';")];
    expect(extractDepCandidates(files, reader)).toEqual([]);
  });
});
