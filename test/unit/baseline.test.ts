import { describe, expect, it } from 'vitest';
import { findTyposquatTarget, loadBaseline, suggestPackage } from '../../src/core/baseline.js';

describe('loadBaseline', () => {
  it('loads a substantial npm baseline', () => {
    const baseline = loadBaseline('npm');
    expect(baseline.size).toBeGreaterThan(150);
    expect(baseline.has('react')).toBe(true);
    expect(baseline.has('express')).toBe(true);
  });

  it('loads a substantial pypi baseline', () => {
    const baseline = loadBaseline('pypi');
    expect(baseline.size).toBeGreaterThan(150);
    expect(baseline.has('requests')).toBe(true);
  });

  it('caches across calls', () => {
    expect(loadBaseline('npm')).toBe(loadBaseline('npm'));
  });
});

describe('suggestPackage', () => {
  it('suggests the intended package for an npm typo', () => {
    expect(suggestPackage('expres', 'npm')).toBe('express');
  });

  it('suggests the intended package for a pypi typo, normalizing first', () => {
    expect(suggestPackage('Reqeusts', 'pypi')).toBe('requests');
  });

  it('returns null when nothing is close', () => {
    expect(suggestPackage('zzzzzzzzzzzz', 'npm')).toBeNull();
  });
});

describe('findTyposquatTarget', () => {
  it('finds the popular package a look-alike imitates', () => {
    expect(findTyposquatTarget('reqeusts', 'pypi', 2)).toEqual({
      name: 'requests',
      distance: 2,
    });
    expect(findTyposquatTarget('flsk', 'pypi', 2)).toEqual({ name: 'flask', distance: 1 });
  });

  it('returns null for a name that is itself popular', () => {
    expect(findTyposquatTarget('requests', 'pypi', 2)).toBeNull();
    expect(findTyposquatTarget('react', 'npm', 2)).toBeNull();
  });

  it('returns null when nothing popular is within range', () => {
    expect(findTyposquatTarget('zzzzzzzzzzzz', 'pypi', 2)).toBeNull();
  });

  it('normalizes pypi names before comparing', () => {
    expect(findTyposquatTarget('Flsk', 'pypi', 2)).toEqual({ name: 'flask', distance: 1 });
  });

  it('respects a tighter distance limit', () => {
    expect(findTyposquatTarget('reqeusts', 'pypi', 1)).toBeNull(); // 2 edits away
    expect(findTyposquatTarget('flsk', 'pypi', 1)).toEqual({ name: 'flask', distance: 1 });
  });

  it('matches the reference levenshtein on known pairs', () => {
    // spot-checks that the banded DP agrees with the full-matrix version
    expect(findTyposquatTarget('djanga', 'pypi', 2)).toEqual({ name: 'django', distance: 1 });
    expect(findTyposquatTarget('numpyy', 'pypi', 2)).toEqual({ name: 'numpy', distance: 1 });
  });
});
