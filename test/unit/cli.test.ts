import { describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli.js';
import { SLOPGATE_VERSION } from '../../src/version.js';

describe('cli skeleton', () => {
  it('exposes the package name and version', () => {
    const program = createProgram();
    expect(program.name()).toBe('slopgate');
    expect(program.version()).toBe(SLOPGATE_VERSION);
  });

  it('registers the init and scan commands', () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(['init', 'scan']));
  });

  it('scan defaults to pretty output', () => {
    const program = createProgram();
    const scan = program.commands.find((command) => command.name() === 'scan');
    expect(scan).toBeDefined();
    const defaults = scan?.options.filter((option) => option.defaultValue !== undefined);
    expect(defaults?.map((option) => option.attributeName())).toContain('format');
  });
});
