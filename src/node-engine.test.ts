// Engine preflight (P3 gun 4): refuse to boot on Node < 22 with one precise
// message and a non-zero exit — instead of the old mid-flight weirdness
// (auto-rebuild hangs, node:sqlite missing, JSON fallbacks) reproduced on
// Node 20.20.2. Also wires the guarantee: cli.ts must run the check before
// any dispatch, so `mochi <anything>` refuses fast on old engines.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_MAJOR, nodeEngineProblem } from './node-engine.js';

describe('node engine preflight', () => {
  it('rejects engines below the declared floor with a precise message', () => {
    for (const v of ['18.20.4', '20.20.2', '21.9.9', 'v20.11.1']) {
      const problem = nodeEngineProblem(v);
      expect(problem, `expected a problem for ${v}`).not.toBeNull();
      expect(problem).toContain(`Node ${MIN_NODE_MAJOR}+ is required`);
      // Names the found version (so the user can see WHICH engine ran)…
      expect(problem).toContain(v.replace(/^v/i, ''));
      // …and says what to do, without pretending a partial boot is possible.
      expect(problem).toContain('Install Node');
    }
  });

  it('accepts the floor and newer engines', () => {
    expect(nodeEngineProblem('22.0.0')).toBeNull();
    expect(nodeEngineProblem('22.12.0')).toBeNull();
    expect(nodeEngineProblem('26.12.1')).toBeNull();
  });

  it('fails closed on unparseable/unknown versions', () => {
    expect(nodeEngineProblem('')).not.toBeNull();
    expect(nodeEngineProblem('not-a-version')).not.toBeNull();
    expect(nodeEngineProblem()).toBeNull(); // this VM runs Node 26
  });

  it('is wired as the first action of the CLI entry — before any dispatch', () => {
    const src = readFileSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), 'utf8');
    const wired = src.indexOf('nodeEngineProblem()');
    expect(wired, 'cli.ts must call nodeEngineProblem()').toBeGreaterThan(-1);
    // Non-zero exit, not a console.warn-and-continue.
    const exit = src.indexOf('process.exit(1)', wired);
    expect(exit, 'the preflight must exit non-zero').toBeGreaterThan(-1);
    expect(exit - wired, 'the exit must be part of the preflight branch').toBeLessThan(200);
    // Before the work begins: the preflight call must precede argument parsing.
    const parseArgsCall = src.indexOf('parseArgs(process.argv');
    expect(parseArgsCall, 'preflight must run before argument parsing').toBeGreaterThan(wired);
  });
});
