import type { ScanResult } from './types.js';

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
