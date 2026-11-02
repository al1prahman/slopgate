import { describe, expect, it } from 'vitest';
import { loadBaseline, suggestPackage } from '../../src/core/baseline.js';

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
