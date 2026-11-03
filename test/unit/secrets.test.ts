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
    const file = fileWith('src/ai.ts', "const key = 'sk-ant-api03-AbCd\u0045f1234567890AbCdEf';");
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
    expect(rulesFor(fileWith('a.ts', 'aws_key = AKIAIOSFOD\u004eN7EXAMPLE'))).toContain(
      'secret.aws-access-key-id',
    );
  });

  it('detects GitHub tokens', () => {
    expect(rulesFor(fileWith('a.ts', 'token: ghp_1234567890abcdef\u0067hijklmnopqrstuvwxyz'))).toContain(
      'secret.github-token',
    );
    expect(
      rulesFor(fileWith('a.ts', 'pat: github_pat_11ABCDEFG0abcdefghijkl_12345678\u00390abcdefghijklmnopqrstuvwxyz1234567890abcd')),
    ).toContain('secret.github-token');
  });

  it('detects Stripe live keys', () => {
    expect(rulesFor(fileWith('a.ts', "const s = 'sk_live_4eC39HqL\u0079jWDarjtT1zdp7dc';"))).toContain(
      'secret.stripe-key',
    );
  });

  it('detects Slack tokens', () => {
    expect(
      rulesFor(fileWith('a.ts', 'SLACK=xoxb-\u0031234567890-12345678901\u00323-AbCdEfGhIjKlMnOpQrStUvWx')),
    ).toContain('secret.slack-token');
  });

  it('detects private key headers', () => {
    expect(rulesFor(fileWith('a.ts', '-----BEGIN RSA \u0050RIVATE KEY-----'))).toContain(
      'secret.private-key',
    );
  });

  it('detects database URLs with inline credentials', () => {
    expect(
      rulesFor(fileWith('a.ts', 'DATABASE_URL=postgres://admin:s3cur3p4ss@db.internal:5432/prod')),
    ).toContain('secret.db-url');
  });

  it('does not flag a placeholder password in a database URL', () => {
    // Found dogfooding: a CI fixture with
    // `postgresql://postgres:placeholder@localhost:5432/postgres` blocked a
    // range scan of an otherwise clean repo. No credential, no finding.
    for (const line of [
      'DATABASE_URL: postgresql://postgres:placeholder@localhost:5432/postgres',
      'DATABASE_URL: postgres://admin:changeme@db.internal:5432/prod',
      'DATABASE_URL: postgres://admin:***@db.internal:5432/prod',
      'DATABASE_URL: postgres://admin:your-password@db.internal:5432/prod',
      // Bracket-wrapped placeholders, as .env.example files ship them.
      'DATABASE_URL=postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-ap.pooler.supabase.com:5432/postgres',
      'DATABASE_URL=postgresql://postgres:<your-password>@db.internal:5432/prod',
      'DATABASE_URL=postgresql://postgres:{YOUR_PASSWORD}@db.internal:5432/prod',
    ]) {
      expect(rulesFor(fileWith('ci.yml', line))).not.toContain('secret.db-url');
    }
  });

  it('does not flag a database URL pointing at a loopback host', () => {
    for (const line of [
      'DATABASE_URL: postgres://postgres:realpass@localhost:5432/db',
      'DATABASE_URL: postgres://postgres:realpass@127.0.0.1:5432/db',
      'DATABASE_URL: postgres://postgres:realpass@0.0.0.0:5432/db',
      'DATABASE_URL: postgres://postgres:realpass@[::1]:5432/db',
    ]) {
      expect(rulesFor(fileWith('ci.yml', line))).not.toContain('secret.db-url');
    }
  });

  it('detects npm tokens', () => {
    expect(rulesFor(fileWith('a.ts', 'npm_1234567890abcdef\u0067hijklmnopqrstuvwxyz'))).toContain(
      'secret.npm-token',
    );
  });

  it('detects Google API keys', () => {
    expect(rulesFor(fileWith('a.ts', 'key=AIzaSyA1234567890ab\u0063defghijklmnopqrstuv'))).toContain(
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
    const file = fileWith('a.ts', "const key = 'sk-ant-api03-AbCd\u0045f1234567890AbCdEf';");
    const rules = rulesFor(file);
    expect(rules).toContain('secret.anthropic-key');
    expect(rules).not.toContain('secret.openai-key');
  });

  it('redacts the middle of detected secrets in evidence', () => {
    const file = fileWith('a.ts', "const key = 'sk-ant-api03-AbCd\u0045f1234567890AbCdEf';");
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
      addedLines: [{ line: 1, content: 'AKIAIOSFOD\u004eN7EXAMPLE' }],
      isBinary: true,
      isNew: false,
      isDeleted: false,
    };
    const deleted: ChangedFile = {
      path: 'gone.ts',
      addedLines: [{ line: 1, content: 'AKIAIOSFOD\u004eN7EXAMPLE' }],
      isBinary: false,
      isNew: false,
      isDeleted: true,
    };
    expect(scanSecrets([binary, deleted])).toEqual([]);
  });

  it('reports multiple findings across files with correct locations', () => {
    const a = fileWith('a.ts', 'const ok = 1;', 'const k = "ghp_1234567890abcdef\u0067hijklmnopqrstuvwxyz";');
    const b = fileWith('b.ts', '-----BEGIN OPENSS\u0048 PRIVATE KEY-----');
    const findings = scanSecrets([a, b]);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.file).toBe('a.ts');
    expect(findings[0]!.line).toBe(2);
    expect(findings[1]!.file).toBe('b.ts');
    expect(findings[1]!.line).toBe(1);
  });
});
