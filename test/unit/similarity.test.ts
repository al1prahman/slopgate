import { describe, expect, it } from 'vitest';
import { findNearest, levenshtein } from '../../src/core/similarity.js';
import { normalizePypiName } from '../../src/core/registry/index.js';

describe('levenshtein', () => {
  it('computes known distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('flank', 'flanks')).toBe(1);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('stops early once the distance exceeds the cutoff', () => {
    expect(levenshtein('abcdefghij', 'klmnopqrst', 2)).toBeGreaterThan(2);
  });
});

describe('findNearest', () => {
  const candidates = ['requests', 'beautifulsoup4', 'flask', 'django', 'numpy'];

  it('finds the typo target within distance 2', () => {
    expect(findNearest('reqeusts', candidates, { maxDistance: 2 })).toContain('requests');
  });

  it('finds near-misses of longer names within distance 3', () => {
    expect(findNearest('beaufitulsoup', candidates, { maxDistance: 3 })).toContain(
      'beautifulsoup4',
    );
  });

  it('returns nothing when no candidate is close enough', () => {
    expect(findNearest('zzzzzzzzzz', candidates)).toEqual([]);
  });

  it('ranks closer candidates first', () => {
    expect(findNearest('flaske', ['flask', 'flasks'], { maxDistance: 2 })[0]).toBe('flask');
  });
});

describe('normalizePypiName', () => {
  it('lowercases and collapses separators per PEP 503', () => {
    expect(normalizePypiName('Flask_SQLAlchemy')).toBe('flask-sqlalchemy');
    expect(normalizePypiName('A.B--c')).toBe('a-b-c');
  });
});
