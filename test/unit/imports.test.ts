import { describe, expect, it } from 'vitest';
import { extractImportCandidates } from '../../src/core/imports.js';
import type { ChangedFile } from '../../src/core/types.js';

function jsFile(lines: string[], path = 'src/app.ts'): ChangedFile {
  return {
    path,
    isBinary: false,
    isNew: false,
    isDeleted: false,
    addedLines: lines.map((content, index) => ({ line: index + 1, content })),
  };
}

function pyFile(lines: string[], path = 'app/main.py'): ChangedFile {
  return jsFile(lines, path);
}

function names(candidates: ReturnType<typeof extractImportCandidates>): string[] {
  return candidates.map((candidate) => candidate.name);
}

describe('extractImportCandidates — JS/TS', () => {
  it('extracts package names from every import form', () => {
    const candidates = extractImportCandidates([
      jsFile([
        "import React from 'react';",
        "import { map } from 'lodash/fp';",
        "import 'side-effect';",
        "export * from 're-export';",
        "const yaml = require('js-yaml');",
        "const lazy = await import('dynamic-dep');",
      ]),
    ]);
    expect(names(candidates)).toEqual([
      'react',
      'lodash',
      'side-effect',
      're-export',
      'js-yaml',
      'dynamic-dep',
    ]);
    expect(candidates.every((c) => c.ecosystem === 'npm')).toBe(true);
    expect(candidates.every((c) => c.source === 'import')).toBe(true);
  });

  it('keeps scoped packages intact', () => {
    const candidates = extractImportCandidates([
      jsFile(["import { thing } from '@scope/pkg/sub/path';"]),
    ]);
    expect(names(candidates)).toEqual(['@scope/pkg']);
  });

  it('skips relative, absolute, node:, and URL specifiers', () => {
    const candidates = extractImportCandidates([
      jsFile([
        "import local from './local.js';",
        "import parent from '../parent.js';",
        "import fs from 'node:fs';",
        "import abs from '/abs/path.js';",
        "import remote from 'https://esm.sh/remote';",
      ]),
    ]);
    expect(candidates).toEqual([]);
  });

  it('skips a scoped specifier with no package segment', () => {
    const candidates = extractImportCandidates([jsFile(["import x from '@scope';"])]);
    expect(candidates).toEqual([]);
  });

  it('handles comma-separated imports with aliases', () => {
    const candidates = extractImportCandidates([pyFile(['import requests, numpy as np'])]);
    expect(names(candidates)).toEqual(['requests', 'numpy']);
  });

  it('ignores non-JS files and deleted/binary files', () => {
    const candidates = extractImportCandidates([
      jsFile(["import x from 'pkg-a';"], 'README.md'),
      jsFile(["import x from 'pkg-b';"], 'style.css'),
      { ...jsFile(["import x from 'pkg-c';"]), isDeleted: true },
      { ...jsFile(["import x from 'pkg-d';"]), isBinary: true },
    ]);
    expect(candidates).toEqual([]);
  });

  it('records the import line number', () => {
    const candidates = extractImportCandidates([
      jsFile(['const a = 1;', "import x from 'pkg';"]),
    ]);
    expect(candidates[0]!.line).toBe(2);
    expect(candidates[0]!.file).toBe('src/app.ts');
  });
});

describe('extractImportCandidates — Python', () => {
  it('extracts top-level modules from import and from-import forms', () => {
    const candidates = extractImportCandidates([
      pyFile([
        'import requests',
        'import numpy as np',
        'import os, sys.path',
        'from flask import Flask',
        'from aiohttp.web import Application',
      ]),
    ]);
    // os and sys are stdlib and skipped by the candidate stage.
    expect(names(candidates)).toEqual(['requests', 'numpy', 'flask', 'aiohttp']);
    expect(candidates.every((c) => c.ecosystem === 'pypi')).toBe(true);
  });

  it('skips relative imports', () => {
    const candidates = extractImportCandidates([
      pyFile(['from . import sibling', 'from ..pkg import thing', 'from .mod import name']),
    ]);
    expect(candidates).toEqual([]);
  });

  it('skips stdlib modules', () => {
    const candidates = extractImportCandidates([
      pyFile(['import os', 'import sys.path', 'from __future__ import annotations', 'import json']),
    ]);
    expect(candidates).toEqual([]);
  });

  it('maps aliased imports to their distribution and keeps the import name', () => {
    const candidates = extractImportCandidates([
      pyFile(['from bs4 import BeautifulSoup', 'import cv2', 'from PIL import Image']),
    ]);
    expect(names(candidates)).toEqual(['beautifulsoup4', 'opencv-python', 'pillow']);
    expect(candidates.map((c) => c.importName)).toEqual(['bs4', 'cv2', 'PIL']);
    expect(candidates.every((c) => !c.unmapped)).toBe(true);
  });

  it('marks imports with no alias entry as unmapped', () => {
    const candidates = extractImportCandidates([pyFile(['import reqeusts'])]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe('reqeusts');
    expect(candidates[0]!.unmapped).toBe(true);
  });

  it('does not mark aliased or JS imports as unmapped', () => {
    const candidates = extractImportCandidates([
      pyFile(['import reqeusts']),
      jsFile(["import reqeusts from 'reqeusts';"]),
    ]);
    const py = candidates.find((c) => c.ecosystem === 'pypi')!;
    const js = candidates.find((c) => c.ecosystem === 'npm')!;
    expect(py.unmapped).toBe(true);
    expect(js.unmapped).toBeUndefined();
  });
});
