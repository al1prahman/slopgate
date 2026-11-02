import { describe, expect, it } from 'vitest';
import { scanSecrets } from '../../src/core/secrets.js';
import type { ChangedFile } from '../../src/core/types.js';

function fileWith(path: string, ...contents: string[]): ChangedFile {
  return {
    path,
    addedLines: contents.map((content, index) => ({ line: index + 1, content })),
    isBinary: false,
    isNew: false,
    isDeleted: false,
  };
}

function rulesFor(file: ChangedFile): string[] {
  return scanSecrets([file]).map((finding) => finding.rule);
}

describe('scanSecrets', () => {
  it('detects an Anthropic API key', () => {
    const file = fileWith('src/ai.ts', "const key = 'sk-ant-\u0061pi03-AbCdEf1234567890AbCdEf';");
    const findings = scanSecrets([file]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('secret.anthropic-key');
    expect(findings[0]!.severity).toBe('block');
    expect(findings[0]!.file).toBe('src/ai.ts');
    expect(findings[0]!.line).toBe(1);
  });

  it('detects OpenAI keys including project-scoped', () => {
    expect(rulesFor(fileWith('a.ts', "const k = 'sk-proj-AbCdEf1234567890AbCdEf1234';"))).toContain(
      'secret.openai-key',
    );
  });

  it('detects AWS access key ids', () => {
    expect(rulesFor(fileWith('a.ts', 'aws_key = AKIA\u0049OSFODNN7EXAMPLE'))).toContain(
      'secret.aws-access-key-id',
    );
  });

  it('detects GitHub tokens', () => {
    expect(rulesFor(fileWith('a.ts', 'token: ghp_\u0031234567890abcdefghijklmnopqrstuvwxyz'))).toContain(
      'secret.github-token',
    );
    expect(
      rulesFor(fileWith('a.ts', 'pat: github_pat_\u00311ABCDEFG0abcdefghijkl_1234567890abcdefghijklmnopqrstuvwxyz1234567890abcd')),
    ).toContain('secret.github-token');
  });

  it('detects Stripe live keys', () => {
    expect(rulesFor(fileWith('a.ts', "const s = 'sk_live_\u0034eC39HqLyjWDarjtT1zdp7dc';"))).toContain(
      'secret.stripe-key',
    );
  });

  it('detects Slack tokens', () => {
    expect(
      rulesFor(fileWith('a.ts', 'SLACK=xoxb-\u0031234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx')),
    ).toContain('secret.slack-token');
  });

  it('detects private key headers', () => {
    expect(rulesFor(fileWith('a.ts', '-----BEGIN RSA \u0050RIVATE KEY-----'))).toContain(
      'secret.private-key',
    );
  });

  it('detects database URLs with inline credentials', () => {
    expect(
      rulesFor(fileWith('a.ts', 'DATABASE_URL=postgres://admin:s3cretpw@db.internal:5432/prod')),
    ).toContain('secret.db-url');
  });

  it('detects npm tokens', () => {
    expect(rulesFor(fileWith('a.ts', 'npm_\u0031234567890abcdefghijklmnopqrstuvwxyz'))).toContain(
      'secret.npm-token',
    );
  });

  it('detects Google API keys', () => {
    expect(rulesFor(fileWith('a.ts', 'key=AIza\u0053yA1234567890abcdefghijklmnopqrstuv'))).toContain(
      'secret.google-api-key',
    );
  });

  it('detects JWTs', () => {
    expect(
      rulesFor(
        fileWith(
          'a.ts',
          'ey\u004ahbGciOiJIUzI1NiJ9.ey\u004azdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        ),
      ),
    ).toContain('secret.jwt');
  });

  it('detects generic high-entropy assignments as warn-only', () => {
    const file = fileWith('a.ts', "MY_SERVICE_TOKEN = 'aB9xK2mP4qR7tU1vW3yZ5nL8';");
    const findings = scanSecrets([file]);
    expect(findings.map((f) => f.rule)).toContain('secret.high-entropy');
    expect(findings.find((f) => f.rule === 'secret.high-entropy')!.severity).toBe('warn');
  });

  it('does not double-report an Anthropic key as a generic OpenAI key', () => {
    const file = fileWith('a.ts', "const key = 'sk-ant-\u0061pi03-AbCdEf1234567890AbCdEf';");
    const rules = rulesFor(file);
    expect(rules).toContain('secret.anthropic-key');
    expect(rules).not.toContain('secret.openai-key');
  });

  it('redacts the middle of detected secrets in evidence', () => {
    const file = fileWith('a.ts', "const key = 'sk-ant-\u0061pi03-AbCdEf1234567890AbCdEf';");
    const finding = scanSecrets([file])[0]!;
    expect(finding.evidence).toBeDefined();
    expect(finding.evidence).not.toContain('AbCdEf1234567890AbCdEf');
  });

  it('ignores clean lines', () => {
    const file = fileWith(
      'a.ts',
      "const greeting = 'hello world';",
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
    );
    expect(scanSecrets([file])).toEqual([]);
  });

  it('ignores placeholder values', () => {
    const file = fileWith(
      'a.ts',
      "const apiKey = 'YOUR_API_KEY_HERE';",
      "const token = process.env['TOKEN'] ?? 'xxx';",
      'const secret = "changeme";',
    );
    expect(scanSecrets([file])).toEqual([]);
  });

  it('skips binary and deleted files', () => {
    const binary: ChangedFile = {
      path: 'img.png',
      addedLines: [{ line: 1, content: 'AKIA\u0049OSFODNN7EXAMPLE' }],
      isBinary: true,
      isNew: false,
      isDeleted: false,
    };
    const deleted: ChangedFile = {
      path: 'gone.ts',
      addedLines: [{ line: 1, content: 'AKIA\u0049OSFODNN7EXAMPLE' }],
      isBinary: false,
      isNew: false,
      isDeleted: true,
    };
    expect(scanSecrets([binary, deleted])).toEqual([]);
  });

  it('reports multiple findings across files with correct locations', () => {
    const a = fileWith('a.ts', 'const ok = 1;', 'const k = "ghp_\u0031234567890abcdefghijklmnopqrstuvwxyz";');
    const b = fileWith('b.ts', '-----BEGIN OPENSS\u0048 PRIVATE KEY-----');
    const findings = scanSecrets([a, b]);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.file).toBe('a.ts');
    expect(findings[0]!.line).toBe(2);
    expect(findings[1]!.file).toBe('b.ts');
    expect(findings[1]!.line).toBe(1);
  });
});
