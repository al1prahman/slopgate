import { SLOPGATE_VERSION } from '../version.js';
import type { Finding, ScanResult, Severity } from './types.js';

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const red = (text: string): string => paint('31', text);
const yellow = (text: string): string => paint('33', text);
const green = (text: string): string => paint('32', text);
const dim = (text: string): string => paint('2', text);

function verdictLine(result: ScanResult): string {
  const blocking = result.findings.filter((finding) => finding.severity === 'block').length;
  const warnings = result.findings.filter((finding) => finding.severity === 'warn').length;
  if (result.verdict === 'block') {
    return red(`commit blocked. ${blocking} blocking finding(s).`);
  }
  if (result.verdict === 'warn') {
    return yellow(`${warnings} warning(s). commit allowed.`);
  }
  return green('clean. commit allowed.');
}

export function formatPretty(result: ScanResult, options: { quiet?: boolean } = {}): string {
  if (options.quiet) {
    return verdictLine(result);
  }

  const lines: string[] = [
    `slopgate: scanned ${result.filesScanned} file(s), +${result.linesAdded} added line(s), ${result.durationMs}ms`,
  ];

  if (result.findings.length === 0) {
    lines.push('  no findings.');
  }

  for (const finding of result.findings) {
    const glyph = finding.severity === 'block' ? red('✗') : yellow('⚠');
    const tag = finding.severity === 'block' ? red('[BLOCK]') : yellow('[WARN]');
    lines.push(`  ${glyph} ${finding.rule}  ${finding.file}:${finding.line}  ${tag}`);
    lines.push(`      ${finding.message}`);
    if (finding.suggestion) {
      lines.push(`      → did you mean '${finding.suggestion}'?`);
    }
    if (finding.evidence) {
      lines.push(dim(`      evidence: ${finding.evidence}`));
    }
  }

  lines.push(verdictLine(result));
  return lines.join('\n');
}

export function formatJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2);
}

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFORMATION_URI = 'https://github.com/al1prahman/slopgate';

const RULE_DESCRIPTIONS: Record<string, string> = {
  secret: 'A credential or secret pattern was found in an added line',
  'dep.not-found': 'The dependency does not exist in its registry — probable hallucination',
  'dep.typosquat': 'The package exists but is a young look-alike of a popular one',
  'dep.registry-error': 'The registry could not be reached; the check failed open',
  'import.not-found': 'The import maps to a package that does not exist in its registry',
  'import.unmapped': 'The import has no known package mapping and its own name was not found',
  'import.registry-error': 'The registry could not be reached; the check failed open',
};

function ruleName(ruleId: string): string {
  return ruleId
    .split(/[.-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function ruleDescription(ruleId: string): string {
  return (
    RULE_DESCRIPTIONS[ruleId] ??
    RULE_DESCRIPTIONS[ruleId.split('.')[0]!] ??
    'slopgate finding'
  );
}

function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'block') {
    return 'error';
  }
  if (severity === 'warn') {
    return 'warning';
  }
  return 'note';
}

function sarifMessage(finding: Finding): string {
  return finding.suggestion
    ? `${finding.message} (did you mean '${finding.suggestion}'?)`
    : finding.message;
}

/**
 * SARIF 2.1.0 output for github/codeql-action/upload-sarif — findings land as
 * inline annotations on the PR diff.
 */
export function formatSarif(result: ScanResult): string {
  const rules = [...new Set(result.findings.map((finding) => finding.rule))].sort();
  return JSON.stringify(
    {
      $schema: SARIF_SCHEMA,
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'slopgate',
              version: SLOPGATE_VERSION,
              informationUri: INFORMATION_URI,
              rules: rules.map((id) => ({
                id,
                name: ruleName(id),
                shortDescription: { text: ruleDescription(id) },
              })),
            },
          },
          results: result.findings.map((finding) => ({
            ruleId: finding.rule,
            level: sarifLevel(finding.severity),
            message: { text: sarifMessage(finding) },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: finding.file.replace(/\\/g, '/') },
                  region: { startLine: finding.line },
                },
              },
            ],
          })),
        },
      ],
    },
    null,
    2,
  );
}
