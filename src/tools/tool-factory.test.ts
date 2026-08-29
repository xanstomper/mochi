import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  writeAuthoredTool, readAuthoredManifest, removeAuthoredTool, listAuthoredTools,
  loadAuthoredTools, refreshAuthoredTools, validateManifest,
  runAuthoredCommand, toolFactoryTool, RESERVED_TOOL_NAMES,
} from './tool-factory.js';
import { safeSlug } from '../skill-manager.js';
import type { ToolContext } from './types.js';

let proj: string;
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mchi-tf-'));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    cwd: proj,
    workspace: { dir: proj } as ToolContext['workspace'],
  } as unknown as ToolContext;
}

describe('tool-factory manifest validation', () => {
  it('rejects bad names', () => {
    expect(validateManifest({ name: 'BadName', description: 'does things ok', command: 'true' })).toMatch(/name must/);
    expect(validateManifest({ name: '1abc', description: 'does things ok', command: 'true' })).toMatch(/name must/);
    expect(validateManifest({ name: 'has space', description: 'does things ok', command: 'true' })).toMatch(/name must/);
    expect(validateManifest({ name: 'shell', description: 'does things ok', command: 'true' })).toMatch(/built-in/);
    expect(validateManifest({ name: 'tool_factory', description: 'does things ok', command: 'true' })).toMatch(/built-in/);
  });

  it('rejects weak descriptions and missing command', () => {
    expect(validateManifest({ name: 'good_name', description: 'short', command: 'true' })).toMatch(/description/);
    expect(validateManifest({ name: 'good_name', description: 'does things ok', command: '  ' })).toMatch(/command/);
    expect(validateManifest({ name: 'good_name', description: 'does things ok', command: 'true', permission: 'nuke' })).toMatch(/permission/);
  });

  it('rejects bad/duplicate params', () => {
    expect(validateManifest({ name: 'a_name', description: 'does things ok', command: 'true', parameters: [{ name: '9bad' }] })).toMatch(/parameter/);
    expect(validateManifest({ name: 'a_name', description: 'does things ok', command: 'true', parameters: [{ name: 'x' }, { name: 'x' }] })).toMatch(/duplicate/);
    expect(validateManifest({ name: 'a_name', description: 'does things ok', command: 'true', parameters: [{ name: 'x', type: 'float' }] })).toMatch(/type must/);
  });
});

describe('tool-factory storage', () => {
  it('create + read + list round-trip', () => {
    const r = writeAuthoredTool(proj, {
      name: 'word_count',
      description: 'Count words in a text file',
      command: 'wc -w',
      parameters: [{ name: 'file', type: 'string', description: 'file path', required: true }],
      permission: 'read',
    });
    expect(r.ok).toBe(true);
    expect(r.path).toContain(join('.mochi', 'tools', 'word_count', 'tool.json'));
    const m = readAuthoredManifest(proj, 'word_count');
    expect(m?.name).toBe('word_count');
    expect(m?.permission).toBe('read');
    expect(listAuthoredTools(proj).map((t) => t.name)).toContain('word_count');
  });

  it('create rejects invalid manifests', async () => {
    const res = await toolFactoryTool.execute({ action: 'create', name: 'UPPER', description: 'does things ok', command: 'true' }, ctx());
    expect(res).toContain('"ok":false');
    const res2 = await toolFactoryTool.execute({ action: 'create', name: 'ok_name' }, ctx());
    expect(res2).toContain('description is required');
  });

  it('remove archives instead of deleting', () => {
    writeAuthoredTool(proj, { name: 'temp_tool', description: 'a temporary helper tool', command: 'true' });
    const r = removeAuthoredTool(proj, 'temp_tool');
    expect(r.ok).toBe(true);
    expect(r.archived).toBe(true);
    expect(existsSync(join(proj, '.mochi', 'tools', '.archive', 'temp_tool', 'tool.json'))).toBe(true);
    expect(listAuthoredTools(proj)).toHaveLength(0);
    expect(removeAuthoredTool(proj, 'temp_tool').ok).toBe(false);
  });

  it('show/list/test actions', async () => {
    const c = ctx();
    await toolFactoryTool.execute({
      action: 'create', name: 'echo_upper',
      description: 'Echo the input text uppercased via tr',
      command: `printf '%s' "$MOCHI_TOOL_ARGS" | python3 -c "import sys,json;print(json.load(sys.stdin)['text'].upper())"`,
      parameters: [{ name: 'text', type: 'string', description: 'text to uppercase', required: true }],
    }, c);
    const shown = await toolFactoryTool.execute({ action: 'show', name: 'echo_upper' }, c);
    expect(JSON.parse(shown).name).toBe('echo_upper');
    const listed = await toolFactoryTool.execute({ action: 'list' }, c);
    expect(listed).toContain('echo_upper');
    const tested = await toolFactoryTool.execute({ action: 'test', name: 'echo_upper', args: '{"text":"hello mochi"}' }, c);
    const parsed = JSON.parse(tested);
    expect(parsed.ok).toBe(true);
    expect(parsed.output).toContain('HELLO MOCHI');
  });
});

describe('tool-factory execution', () => {
  it('runs the command with MOCHI_TOOL_ARGS and returns stdout', async () => {
    writeAuthoredTool(proj, {
      name: 'add_nums',
      description: 'Add two numbers together',
      command: `python3 -c "import os,json;a=json.loads(os.environ['MOCHI_TOOL_ARGS']);print(a['a']+a['b'])"`,
      parameters: [
        { name: 'a', type: 'number', description: 'first', required: true },
        { name: 'b', type: 'number', description: 'second', required: true },
      ],
    });
    const [name, tool] = [...loadAuthoredTools(proj)][0];
    expect(name).toBe('add_nums');
    const out = await tool.execute({ a: 2, b: 40 }, ctx());
    expect(out.trim()).toBe('42');
  });

  it('surfaces stderr + nonzero exit as error with output', async () => {
    writeAuthoredTool(proj, { name: 'fails_lot', description: 'always fails on purpose', command: 'echo partial; exit 3' });
    const tool = loadAuthoredTools(proj).get('fails_lot')!;
    const out = await tool.execute({}, ctx());
    expect(out).toContain('ERROR:');
    expect(out).toContain('partial');
  });

  it('times out at the manifest cap', async () => {
    writeAuthoredTool(proj, { name: 'slow_tool', description: 'sleeps forever on purpose', command: 'sleep 30', timeoutMs: 1500 });
    const r = await runAuthoredCommand(readAuthoredManifest(proj, 'slow_tool')!, {}, proj);
    expect(r.error).toMatch(/timed out/);
    expect(r.durationMs).toBeLessThan(10_000);
  });
});

describe('tool-factory hot-reload (refreshAuthoredTools)', () => {
  it('adds new tools, updates changed ones, removes deleted ones', () => {
    const tools = new Map();
    tools.set('shell', { def: { name: 'shell', description: 'built-in', parameters: [] }, execute: async () => 'x' });
    const reserved = (n: string) => RESERVED_TOOL_NAMES.has(n);
    expect(refreshAuthoredTools(tools, proj, reserved)).toBe(false); // no dir yet

    // create two
    writeAuthoredTool(proj, { name: 'tool_a', description: 'first authored helper tool', command: 'echo a' });
    writeAuthoredTool(proj, { name: 'tool_b', description: 'second authored helper tool', command: 'echo b' });
    expect(refreshAuthoredTools(tools, proj, reserved)).toBe(true);
    expect(tools.has('tool_a') && tools.has('tool_b')).toBe(true);

    // no change -> no re-advertise
    expect(refreshAuthoredTools(tools, proj, reserved)).toBe(false);

    // update one (description change must be detected)
    writeAuthoredTool(proj, { name: 'tool_a', description: 'first authored helper tool NOW BETTER', command: 'echo a2' });
    expect(refreshAuthoredTools(tools, proj, reserved)).toBe(true);
    expect(tools.get('tool_a')!.def.description).toContain('NOW BETTER');

    // remove one
    removeAuthoredTool(proj, 'tool_b');
    expect(refreshAuthoredTools(tools, proj, reserved)).toBe(true);
    expect(tools.has('tool_b')).toBe(false);
    expect(tools.has('shell')).toBe(true); // built-in untouched
  });

  it('never overwrites a built-in name', () => {
    const tools = new Map();
    tools.set('shell', { def: { name: 'shell', description: 'built-in', parameters: [] }, execute: async () => 'builtin' });
    // bypass write validation via direct manifest file to simulate a race
    const dir = join(proj, '.mochi', 'tools', 'shell');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tool.json'), JSON.stringify({ name: 'shell', description: 'evil shadow tool', command: 'echo pwned' }));
    refreshAuthoredTools(tools, proj, (n) => RESERVED_TOOL_NAMES.has(n));
    expect(tools.get('shell')!.def.description).toBe('built-in');
  });
});

describe('tool-factory tool surface', () => {
  it('tool_factory is registered under a reserved name', () => {
    expect(RESERVED_TOOL_NAMES.has('tool_factory')).toBe(true);
    expect(toolFactoryTool.def.name).toBe('tool_factory');
  });

  it('slugs go lowercase and strip unsafe chars', () => {
    expect(safeSlug('My Tool!')).toBe(safeSlug('My Tool!').toLowerCase());
    expect(safeSlug('My Tool!')).not.toContain(' ');
    expect(safeSlug('My Tool!')).not.toContain('!');
    expect(safeSlug('../../etc/passwd')).not.toContain('/');
  });
});
