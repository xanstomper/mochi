import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PluginRegistry, readManifest } from './plugins.js';

function makeProject(dir: string) {
  mkdirSync(resolve(dir, '.mochi'), { recursive: true });
  return dir;
}

function makeReg(project: string) {
  return new PluginRegistry(resolve(project, '.mochi', 'plugins'), resolve(project, '.user-plugins'));
}

describe('PluginRegistry', () => {
  it('installs a plugin from a source dir, copying the manifest', () => {
    const project = makeProject(mkdtempSync(resolve(tmpdir(), 'mochi-plug-')) );
    const source = makeSource('audit-logger');
    const reg = makeReg(project);
    const rec = reg.install(source);
    expect(rec.name).toBe('audit-logger');
    expect(rec.scope).toBe('project');
    expect(readFileSync(resolve(rec.dir, 'plugin.json'), 'utf8')).toContain('audit-logger');
    expect(existsSync(resolve(rec.dir, 'index.js'))).toBe(true);
    rmSync(source, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('lists installed plugins with their hooks', () => {
    const project = makeProject(mkdtempSync(resolve(tmpdir(), 'mochi-plug-')) );
    const reg = makeReg(project);
    reg.install(makeSource('p-one', { before_edit: 'echo guard' }));
    reg.install(makeSource('p-two', { on_error: 'echo oops' }));
    const records = reg.list();
    expect(records.map((r) => r.name).sort()).toEqual(['p-one', 'p-two']);
    const p1 = records.find((r) => r.name === 'p-one')!;
    expect(p1.hooks).toEqual(['before_edit']);
    rmSync(project, { recursive: true, force: true });
  });

  it('rejects an install when the plugin already exists without --force', () => {
    const project = makeProject(mkdtempSync(resolve(tmpdir(), 'mochi-plug-')));
    const reg = makeReg(project);
    reg.install(makeSource('dup'));
    expect(() => reg.install(makeSource('dup'))).toThrow(/already installed/);
    expect(() => reg.install(makeSource('dup'), { overwrite: true })).not.toThrow();
    rmSync(project, { recursive: true, force: true });
  });

  it('removes a plugin by name', () => {
    const project = makeProject(mkdtempSync(resolve(tmpdir(), 'mochi-plug-')));
    const reg = makeReg(project);
    reg.install(makeSource('gone'));
    expect(reg.has('gone')).toBe(true);
    expect(reg.remove('gone')).toBe(true);
    expect(reg.has('gone')).toBe(false);
    expect(reg.remove('gone')).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it('merges hooks from all plugins into a single HookConfig', () => {
    const project = makeProject(mkdtempSync(resolve(tmpdir(), 'mochi-plug-')));
    const reg = makeReg(project);
    reg.install(makeSource('a', { before_tool: 'echo A', after_tool: 'echo A2' }));
    reg.install(makeSource('b', { after_tool: ['echo B1', 'echo B2'] }));
    const merged = reg.mergedHooks();
    expect(merged.before_tool).toEqual(['echo A']);
    expect(merged.after_tool).toEqual(['echo A2', 'echo B1', 'echo B2']);
    rmSync(project, { recursive: true, force: true });
  });

  it('syncToHooksFile appends plugin hooks to the workspace hooks.json', () => {
    const project = makeProject(mkdtempSync(resolve(tmpdir(), 'mochi-plug-')));
    const reg = makeReg(project);
    reg.install(makeSource('watcher', { after_tool: 'echo watched' }));
    const hooksFile = resolve(project, '.mochi', 'hooks.json');
    reg.syncToHooksFile(hooksFile, { before_tool: 'echo existing' });
    const parsed = JSON.parse(readFileSync(hooksFile, 'utf8'));
    expect(parsed.before_tool).toEqual(['echo existing']);
    expect(parsed.after_tool).toEqual(['echo watched']);
    rmSync(project, { recursive: true, force: true });
  });

  it('merged hooks run through HookManager after_tool', async () => {
    const project = makeProject(mkdtempSync(resolve(tmpdir(), 'mochi-plug-')));
    const marker = resolve(project, 'ran.txt');
    const reg = makeReg(project);
    reg.install(makeSource('hooker', { after_tool: `echo ran >> ${marker.replace(/\\/g, '\\\\')}` }));
    const hooksFile = resolve(project, '.mochi', 'hooks.json');
    reg.syncToHooksFile(hooksFile);
    const { HookManager } = await import('./hooks.js');
    const hooks = new HookManager(resolve(project, '.mochi'));
    const results = await hooks.runAfter('after_tool', { tool: 'read' });
    expect(results[0].exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8').trim()).toBe('ran');
    rmSync(project, { recursive: true, force: true });
  });

  it('throws on a malformed manifest', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-plug-'));
    writeFileSync(resolve(dir, 'plugin.json'), '{"version":"1"}');
    expect(() => readManifest(dir)).toThrow(/missing name/);
    rmSync(dir, { recursive: true, force: true });
  });
});

function makeSource(name: string, hooks?: Record<string, string | string[]>) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-plugin-src-'));
  writeFileSync(
    resolve(dir, 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'test', hooks: hooks ?? { after_tool: 'echo hi' } }),
  );
  writeFileSync(resolve(dir, 'index.js'), 'exports.x = 1;\n');
  return dir;
}