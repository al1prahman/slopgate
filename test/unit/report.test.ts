import { describe, expect, it } from 'vitest';
import { formatJson, formatPretty } from '../../src/core/report.js';
import type { Finding, ScanResult } from '../../src/core/types.js';

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    findings: [],
    filesScanned: 1,
    linesAdded: 1,
    cacheHits: 0,
    durationMs: 5,
    verdict: 'pass',
    ...overrides,
  };
}

const blockFinding: Finding = {
  severity: 'block',
  rule: 'dep.not-found',
  file: 'requirements.txt',
  line: 4,
  message: '"reqeusts" not found on PyPI',
  suggestion: 'requests',
  evidence: 'req***ts',
};

describe('formatPretty', () => {
  it('prints a clean verdict', () => {
    expect(formatPretty(result())).toContain('clean. commit allowed.');
  });

  it('prints one line per finding with rule, location, and suggestion', () => {
    const out = formatPretty(result({ verdict: 'block', findings: [blockFinding] }));
    expect(out).toContain('dep.not-found');
    expect(out).toContain('requirements.txt:4');
    expect(out).toContain('[BLOCK]');
    expect(out).toContain("did you mean 'requests'?");
    expect(out).toContain('commit blocked. 1 blocking finding(s).');
  });

  it('marks warnings and still allows the commit', () => {
    const warn: Finding = { ...blockFinding, severity: 'warn', rule: 'secret.high-entropy' };
    const out = formatPretty(result({ verdict: 'warn', findings: [warn] }));
    expect(out).toContain('[WARN]');
    expect(out).toContain('commit allowed');
    expect(out).not.toContain('commit blocked');
  });

  it('quiet mode prints only the verdict line', () => {
    const out = formatPretty(result({ verdict: 'block', findings: [blockFinding] }), { quiet: true });
    expect(out).toBe('commit blocked. 1 blocking finding(s).');
  });

  it('emits no ANSI escapes when stdout is not a TTY', () => {
    const out = formatPretty(result({ verdict: 'block', findings: [blockFinding] }));
    expect(out).not.toContain('\u001b[');
  });
});

describe('formatJson', () => {
  it('round-trips the scan result', () => {
    const value = result({ verdict: 'block', findings: [blockFinding] });
    expect(JSON.parse(formatJson(value))).toEqual(value);
  });
});
