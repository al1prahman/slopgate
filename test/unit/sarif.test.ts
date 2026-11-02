import { describe, expect, it } from 'vitest';
import { formatSarif } from '../../src/core/report.js';
import type { Finding, ScanResult } from '../../src/core/types.js';

function scanResult(findings: Finding[]): ScanResult {
  const verdict = findings.some((f) => f.severity === 'block')
    ? 'block'
    : findings.some((f) => f.severity === 'warn')
      ? 'warn'
      : 'pass';
  return {
    findings,
    filesScanned: 2,
    linesAdded: 40,
    cacheHits: 1,
    durationMs: 12,
    verdict,
  };
}

const notFound: Finding = {
  severity: 'block',
  rule: 'dep.not-found',
  file: 'requirements.txt',
  line: 4,
  message: '"reqeusts" not found on PyPI',
  suggestion: 'requests',
};

const typosquat: Finding = {
  severity: 'warn',
  rule: 'dep.typosquat',
  file: 'requirements.txt',
  line: 7,
  message: '"reqeusts" exists but is 2 edit(s) from popular "requests" and only 10 day(s) old',
  suggestion: 'requests',
};

const unmapped: Finding = {
  severity: 'warn',
  rule: 'import.unmapped',
  file: 'app/main.py',
  line: 3,
  message: 'import "cv2" has no known package mapping and "cv2" was not found on PyPI',
};

describe('formatSarif', () => {
  it('emits a SARIF 2.1.0 envelope with the tool driver', () => {
    const sarif = JSON.parse(formatSarif(scanResult([notFound])));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-2.1.0');
    const driver = sarif.runs[0].tool.driver;
    expect(driver.name).toBe('slopgate');
    expect(driver.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(driver.informationUri).toContain('github.com');
  });

  it('maps block/warn/info onto error/warning/note', () => {
    const sarif = JSON.parse(
      formatSarif(
        scanResult([
          notFound,
          typosquat,
          { ...unmapped, severity: 'info', rule: 'dep.registry-error' },
        ]),
      ),
    );
    const levels = sarif.runs[0].results.map((r: { level: string }) => r.level);
    expect(levels).toEqual(['error', 'warning', 'note']);
  });

  it('dedupes rules, keeps them sorted, and names them', () => {
    const sarif = JSON.parse(
      formatSarif(scanResult([notFound, typosquat, { ...notFound, line: 9 }])),
    );
    const rules = sarif.runs[0].tool.driver.rules;
    expect(rules.map((r: { id: string }) => r.id)).toEqual(['dep.not-found', 'dep.typosquat']);
    expect(rules[0].name).toBe('DepNotFound');
    expect(rules[0].shortDescription.text.length).toBeGreaterThan(10);
  });

  it('carries the location, line, and suggestion into the result', () => {
    const sarif = JSON.parse(formatSarif(scanResult([notFound])));
    const [result] = sarif.runs[0].results;
    expect(result.ruleId).toBe('dep.not-found');
    expect(result.message.text).toContain("did you mean 'requests'?");
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('requirements.txt');
    expect(result.locations[0].physicalLocation.region.startLine).toBe(4);
  });

  it('normalizes Windows path separators in artifact URIs', () => {
    const sarif = JSON.parse(formatSarif(scanResult([{ ...notFound, file: 'src\\app.ts' }])));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
      'src/app.ts',
    );
  });

  it('emits an empty run for a clean scan', () => {
    const sarif = JSON.parse(formatSarif(scanResult([])));
    expect(sarif.runs[0].results).toEqual([]);
    expect(sarif.runs[0].tool.driver.rules).toEqual([]);
  });

  it('describes every rule the scanner can emit', () => {
    const rules = [
      'secret.anthropic-key',
      'secret.openai-key',
      'secret.aws-access-key-id',
      'secret.github-token',
      'secret.stripe-key',
      'secret.slack-token',
      'secret.npm-token',
      'secret.google-api-key',
      'secret.private-key',
      'secret.db-url',
      'secret.jwt',
      'secret.generic-credential',
      'secret.high-entropy',
      'dep.not-found',
      'dep.typosquat',
      'dep.registry-error',
      'import.not-found',
      'import.unmapped',
      'import.registry-error',
    ];
    const sarif = JSON.parse(
      formatSarif(
        scanResult(
          rules.map((rule, index) => ({
            severity: 'warn' as const,
            rule,
            file: 'f.txt',
            line: index + 1,
            message: 'x',
          })),
        ),
      ),
    );
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect(rule.shortDescription.text).not.toBe('slopgate finding');
    }
  });
});
