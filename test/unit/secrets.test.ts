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

  it('does not flag a settings attribute read as a credential', () => {
    // Found dogfooding a Python repo: `api_key=settings.QDRANT_API_KEY`
    // and `self._api_key = settings.LLM_API_KEY` both blocked. They read
    // from configuration — there is no literal on the line.
    for (const line of [
      '            api_key=settings.QDRANT_API_KEY or None,',
      '        self._api_key = settings.LLM_API_KEY',
      'token = config.API_TOKEN',
    ]) {
      expect(rulesFor(fileWith('svc.py', line))).not.toContain('secret.generic-credential');
    }
  });

  it('does not flag a shell interpolation default', () => {
    // docker-compose.yml: `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-curio_dev_password}`
    const line = '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-curio_dev_password}';
    expect(rulesFor(fileWith('docker-compose.yml', line))).not.toContain(
      'secret.generic-credential',
    );
  });

  it('does not run the generic rule inside example env files', () => {
    // .env.example exists to hold example values; the specific key-format
    // rules still apply there.
    for (const path of ['.env.example', 'backend/.env.sample', '.env.template']) {
      expect(rulesFor(fileWith(path, 'POSTGRES_PASSWORD=curio_dev_password'))).not.toContain(
        'secret.generic-credential',
      );
    }
    // A real env file still gets flagged.
    expect(rulesFor(fileWith('.env', 'POSTGRES_PASSWORD=curio_dev_password'))).toContain(
      'secret.generic-credential',
    );
  });

  it('does not run the entropy heuristic on lockfiles', () => {
    // uv.lock is hash soup: 25 warnings on a real repo's lockfile alone.
    // The real line is a package URL (high entropy from the domain and
    // path) whose filename carries the trigger word "tokenizers".
    const lockLine =
      'sdist = { url = "https://files.pythonhosted.org/packages/e0/7c/tokenizers-0.23.3.tar.gz", hash = "sha256:cded33237c77caeef62944d32aa9a7ef42bdce2b3497e18d137e072a8c4be438", size = 385286 }';
    for (const path of ['backend/uv.lock', 'package-lock.json', 'yarn.lock', 'Cargo.lock']) {
      expect(rulesFor(fileWith(path, lockLine))).not.toContain('secret.high-entropy');
    }
    // The heuristic itself stays alive: a real high-entropy credential in a
    // source file still warns, and the same line in a lockfile does not.
    // (A bare token, not `name = value` — that shape belongs to the generic
    // rule, which is precise enough to keep running on lockfiles.)
    const credential = '# token rotation note Xk9mP2vQ7wLzR4tY8bN3cF6hJ1dG5sA0';
    expect(rulesFor(fileWith('src/settings.py', credential))).toContain('secret.high-entropy');
    expect(rulesFor(fileWith('uv.lock', credential))).not.toContain('secret.high-entropy');
  });

  it('does not treat a URL as a secret', () => {
    // A Pydantic settings default:
    // DATABASE_URL: str = "postgresql+asyncpg://curio:curio_dev_password@localhost:5432/curio_ai"
    const line =
      '    DATABASE_URL: str = "postgresql+asyncpg://curio:curio_dev_password@localhost:5432/curio_ai"';
    expect(rulesFor(fileWith('config.py', line))).not.toContain('secret.high-entropy');
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
