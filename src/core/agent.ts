/**
 * F12: agent-commit heuristic.
 *
 * Agent-written commits carry recognizable markers — Claude Code appends a
 * "Generated with" footer plus a Co-Authored-By trailer, and Cursor, Copilot,
 * Codex and friends add their own. The signal is informational: it tells a
 * reviewer (and the report) that machine-speed code landed in this diff, so
 * the detectors' verdicts deserve extra scrutiny. It never blocks on its own
 * and never changes the verdict.
 *
 * This is a heuristic, not an identity check: a human contributor genuinely
 * named "Claude" co-authoring a commit would trip it. The cost of that false
 * positive is one dim line in the report, which is the right trade.
 */

// Known agent identities that show up in Co-Authored-By trailers. Matched
// case-insensitively with word boundaries against the whole trailer value
// (name + email), so "Champ Example" does not trip the "amp" entry.
const AGENT_COAUTHOR_NAMES = [
  'claude',
  'copilot',
  'cursor',
  'codex',
  'gemini',
  'devin',
  'aider',
  'openhands',
  'openclaw',
  'windsurf',
  'codeium',
  'tabnine',
  'cody',
  'continue',
  'junie',
  'jules',
  'chatgpt',
  'openai',
  'anthropic',
  'gpt',
] as const;

const AGENT_COAUTHOR_PATTERNS = AGENT_COAUTHOR_NAMES.map(
  (name) => new RegExp(`\\b${name}\\b`, 'i'),
);

// "Generated with X" footers (Claude Code, Cursor, Gemini CLI, ...).
const GENERATED_WITH_RE = /\bgenerated with\b/i;

export interface AgentSignal {
  readonly agentAuthored: boolean;
  readonly markers: readonly string[];
}

export function detectAgentAuthorship(messages: readonly string[]): AgentSignal {
  const markers: string[] = [];

  for (const message of messages) {
    for (const rawLine of message.split('\n')) {
      const line = rawLine.trim();
      if (line === '') {
        continue;
      }
      const trailer = /^co-authored-by:\s*(.+)$/i.exec(line);
      if (trailer) {
        const value = trailer[1]!;
        if (AGENT_COAUTHOR_PATTERNS.some((pattern) => pattern.test(value))) {
          markers.push(line);
        }
        continue;
      }
      if (GENERATED_WITH_RE.test(line)) {
        markers.push(line);
      }
    }
  }

  const unique = [...new Set(markers)];
  return { agentAuthored: unique.length > 0, markers: unique };
}
