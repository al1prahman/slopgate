import type { ChangedFile, Finding, Severity } from './types.js';

interface SecretPattern {
  readonly rule: string;
  readonly label: string;
  readonly regex: RegExp;
  readonly severity: Severity;
}

// Order matters: specific providers first so a key is not double-reported by
// a broader pattern. Overlapping match ranges are deduped below.
const PATTERNS: readonly SecretPattern[] = [
  {
    rule: 'secret.anthropic-key',
    label: 'Anthropic API key',
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    severity: 'block',
  },
  {
    rule: 'secret.openai-key',
    label: 'OpenAI API key',
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    severity: 'block',
  },
  {
    rule: 'secret.aws-access-key-id',
    label: 'AWS access key ID',
    regex: /AKIA[0-9A-Z]{16}/g,
    severity: 'block',
  },
  {
    rule: 'secret.github-token',
    label: 'GitHub token',
    regex: /(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{36,})/g,
    severity: 'block',
  },
  {
    rule: 'secret.stripe-key',
    label: 'Stripe live secret key',
    regex: /[sr]k_live_[A-Za-z0-9]{16,}/g,
    severity: 'block',
  },
  {
    rule: 'secret.slack-token',
    label: 'Slack token',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    severity: 'block',
  },
  {
    rule: 'secret.npm-token',
    label: 'npm access token',
    regex: /npm_[A-Za-z0-9]{36}/g,
    severity: 'block',
  },
  {
    rule: 'secret.google-api-key',
    label: 'Google API key',
    regex: /AIza[0-9A-Za-z_-]{35}/g,
    severity: 'block',
  },
  {
    rule: 'secret.private-key',
    label: 'Private key block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    severity: 'block',
  },
  {
    rule: 'secret.db-url',
    label: 'Database URL with inline credentials',
    regex: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s/]+@/g,
    severity: 'block',
  },
  {
    rule: 'secret.jwt',
    label: 'JSON Web Token',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    severity: 'block',
  },
  {
    rule: 'secret.generic-credential',
    label: 'Hardcoded credential',
    regex: /(?:api[_-]?key|apikey|secret|password|passwd|pwd|credentials?)\s*[:=]\s*["']?([A-Za-z0-9/_+.=-]{16,})/gi,
    severity: 'block',
  },
];

const GENERIC_NAME = /(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|credentials?)/i;
const CANDIDATE_TOKEN = /["'`]([^"'`\s]{20,})["'`]|(?<![A-Za-z0-9/_+.-])([A-Za-z0-9/_+.-]{20,})/g;
const PLACEHOLDER = /^(?:your[_-]|xxx+|changeme|placeholder|example|dummy|fake|todo|none|null|undefined)/i;

interface Claim {
  start: number;
  end: number;
}

function overlaps(claims: readonly Claim[], start: number, end: number): boolean {
  return claims.some((claim) => start < claim.end && end > claim.start);
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function redactSecret(value: string): string {
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || /example/i.test(value);
}

function scanLine(path: string, lineNumber: number, content: string): Finding[] {
  const findings: Finding[] = [];
  const claims: Claim[] = [];

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of content.matchAll(pattern.regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(claims, start, end)) {
        continue;
      }
      claims.push({ start, end });
      const secret = match[1] ?? match[0];
      if (pattern.rule === 'secret.generic-credential' && isPlaceholder(secret)) {
        continue;
      }
      findings.push({
        severity: pattern.severity,
        rule: pattern.rule,
        file: path,
        line: lineNumber,
        message: `${pattern.label} detected`,
        evidence: redactSecret(secret),
      });
    }
  }

  if (GENERIC_NAME.test(content)) {
    CANDIDATE_TOKEN.lastIndex = 0;
    for (const match of content.matchAll(CANDIDATE_TOKEN)) {
      const token = match[1] ?? match[2];
      if (!token || token.length < 20) {
        continue;
      }
      const start = match.index + (match[0].length - token.length);
      const end = start + token.length;
      if (overlaps(claims, start, end) || isPlaceholder(token)) {
        continue;
      }
      if (shannonEntropy(token) < 4.5) {
        continue;
      }
      claims.push({ start, end });
      findings.push({
        severity: 'warn',
        rule: 'secret.high-entropy',
        file: path,
        line: lineNumber,
        message: 'High-entropy string assigned to a credential-like name',
        evidence: redactSecret(token),
      });
    }
  }

  return findings;
}

export function scanSecrets(files: readonly ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.isBinary || file.isDeleted) {
      continue;
    }
    for (const added of file.addedLines) {
      findings.push(...scanLine(file.path, added.line, added.content));
    }
  }
  return findings;
}
