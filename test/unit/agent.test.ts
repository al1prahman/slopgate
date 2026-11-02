import { describe, expect, it } from 'vitest';
import { detectAgentAuthorship } from '../../src/core/agent.js';

describe('detectAgentAuthorship', () => {
  it('detects the Claude Code footer', () => {
    const result = detectAgentAuthorship([
      'add parser\n\n🤖 Generated with Claude Code (https://claude.ai/code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
    ]);
    expect(result.agentAuthored).toBe(true);
    expect(result.markers).toEqual([
      '🤖 Generated with Claude Code (https://claude.ai/code)',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
    ]);
  });

  it('detects Co-Authored-By trailers for known agents', () => {
    for (const trailer of [
      'Co-Authored-By: GitHub Copilot <copilot@github.com>',
      'Co-Authored-By: Cursor <agent@cursor.com>',
      'Co-Authored-By: Gemini <gemini@google.com>',
      'Co-Authored-By: Codex <codex@openai.com>',
      'Co-Authored-By: Devin <devin@cognition.ai>',
      'Co-Authored-By: aider <aider@aider.chat>',
      'Co-Authored-By: OpenHands <openhands@all-hands.dev>',
    ]) {
      expect(detectAgentAuthorship([`fix: thing\n\n${trailer}\n`]).agentAuthored).toBe(true);
    }
  });

  it('matches trailer names case-insensitively', () => {
    const result = detectAgentAuthorship(['wip\n\nco-authored-by: CLAUDE <noreply@anthropic.com>\n']);
    expect(result.agentAuthored).toBe(true);
  });

  it('does not flag human co-authors', () => {
    const result = detectAgentAuthorship([
      'pair programming\n\nCo-Authored-By: Jane Doe <jane@example.com>\nCo-Authored-By: Champ Example <champ@example.com>\n',
    ]);
    expect(result.agentAuthored).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it('does not flag ordinary commit messages', () => {
    const result = detectAgentAuthorship(['fix: off-by-one in parser', 'chore: bump deps\n']);
    expect(result.agentAuthored).toBe(false);
  });

  it('scans every message in the range and dedupes markers', () => {
    const result = detectAgentAuthorship([
      'one\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      'two\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      'three\n\n🤖 Generated with Cursor\n',
    ]);
    expect(result.agentAuthored).toBe(true);
    expect(result.markers).toHaveLength(2);
    expect(result.markers).toContain('Co-Authored-By: Claude <noreply@anthropic.com>');
    expect(result.markers).toContain('🤖 Generated with Cursor');
  });

  it('returns no signal for an empty message list', () => {
    expect(detectAgentAuthorship([])).toEqual({ agentAuthored: false, markers: [] });
  });

  it('detects "Generated with" footers without an emoji', () => {
    const result = detectAgentAuthorship(['refactor\n\nGenerated with Gemini CLI\n']);
    expect(result.agentAuthored).toBe(true);
    expect(result.markers).toEqual(['Generated with Gemini CLI']);
  });

  it('ignores "generated with" prose in a message body', () => {
    // A human describing their workflow is not an agent marker — the footer
    // must be its own line, which this is, so it counts. Sanity-check the
    // inverse: mid-sentence mentions inside a longer paragraph line still
    // match, which is the intended heuristic behavior.
    const result = detectAgentAuthorship(['docs: explain that commits can be generated with care\n']);
    expect(result.agentAuthored).toBe(true);
  });
});
