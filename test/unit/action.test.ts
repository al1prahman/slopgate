import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

interface ActionStep {
  uses?: string;
  name?: string;
  id?: string;
  with?: Record<string, unknown>;
  shell?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
}

interface ActionFile {
  name: string;
  inputs: Record<string, { default?: string; description?: string }>;
  runs: { using: string; steps: ActionStep[] };
}

const action = parseYaml(
  readFileSync(new URL('../../action.yml', import.meta.url), 'utf8'),
) as ActionFile;

describe('action.yml', () => {
  it('is a composite action with documented inputs', () => {
    expect(action.runs.using).toBe('composite');
    for (const input of ['range', 'mode', 'comment', 'token', 'version']) {
      expect(action.inputs[input], `missing input: ${input}`).toBeDefined();
      expect(action.inputs[input]!.description!.length).toBeGreaterThan(10);
    }
  });

  it('checks out full history so range diffs resolve', () => {
    const checkout = action.runs.steps.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkout).toBeDefined();
    expect(checkout!.with!['fetch-depth']).toBe(0);
  });

  it('runs the scan with SARIF output and captures the exit code', () => {
    const scan = action.runs.steps.find((step) => step.id === 'scan');
    expect(scan).toBeDefined();
    expect(scan!.run).toContain('--format sarif');
    expect(scan!.run).toContain('GITHUB_OUTPUT');
    // A blocking scan exits 2; the step must not abort before the code is captured.
    expect(scan!.run).toContain('set +e');
    expect(scan!['continue-on-error']).toBe(true);
  });

  it('defaults the range to the PR merge-base', () => {
    const scan = action.runs.steps.find((step) => step.id === 'scan');
    expect(scan!.run).toContain('GITHUB_BASE_REF');
    expect(scan!.run).toContain('...HEAD');
  });

  it('uploads SARIF for inline PR annotations', () => {
    const upload = action.runs.steps.find((step) =>
      step.uses?.startsWith('github/codeql-action/upload-sarif'),
    );
    expect(upload).toBeDefined();
    expect(upload!.with!.sarif_file).toBe('results.sarif');
  });

  it('upserts a single PR comment behind a marker', () => {
    const comment = action.runs.steps.find((step) =>
      step.uses?.startsWith('actions/github-script'),
    );
    expect(comment).toBeDefined();
    expect(comment!.with!.script).toContain('slopgate-report');
    expect(comment!.with!.script).toContain('updateComment');
    expect(comment!.with!.script).toContain('createComment');
    expect(comment!.with!['github-token']).toContain('inputs.token');
  });

  it('fails the job when the scan blocks', () => {
    const gate = action.runs.steps.at(-1)!;
    expect(gate.run).toContain('"$CODE" = "2"');
    expect(gate.run).toContain('exit 1');
  });
});
