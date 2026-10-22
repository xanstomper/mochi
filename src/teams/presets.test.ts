import { describe, it, expect } from 'vitest';
import {
  SPAWN_PRESETS,
  MUTATING_TOOL_NAMES,
  resolvePreset,
  listPresetNames,
} from './presets.js';
import { getProfile } from './roles.js';

describe('spawn presets', () => {
  it('ships the four required presets plus coder', () => {
    expect(listPresetNames()).toEqual(
      expect.arrayContaining(['researcher', 'pr-reviewer', 'tester', 'explorer', 'coder']),
    );
  });

  it('read-only presets contain no mutating tool — scoping is real, not prompt-deep', () => {
    for (const name of ['researcher', 'pr-reviewer', 'explorer']) {
      const preset = SPAWN_PRESETS[name];
      expect(preset.access).toBe('read-only');
      for (const tool of preset.tools) {
        expect(MUTATING_TOOL_NAMES.has(tool), `${name} must not include mutating tool ${tool}`).toBe(false);
      }
      // The core observation tools are all present.
      expect(preset.tools).toEqual(expect.arrayContaining(['read', 'search', 'glob']));
    }
  });

  it('researcher can use web/browser but not shell', () => {
    const p = SPAWN_PRESETS['researcher'];
    expect(p.tools).toEqual(expect.arrayContaining(['fetch', 'web_search', 'browser']));
    expect(p.tools).not.toContain('shell');
    expect(p.tools).not.toContain('write');
  });

  it('tester and coder are worktree-isolated and can execute', () => {
    expect(SPAWN_PRESETS['tester'].access).toBe('worktree');
    expect(SPAWN_PRESETS['tester'].tools).toEqual(expect.arrayContaining(['shell', 'write', 'verify']));
    expect(SPAWN_PRESETS['coder'].access).toBe('worktree');
    expect(SPAWN_PRESETS['coder'].tools).toEqual(expect.arrayContaining(['shell', 'write', 'edit']));
  });

  it('every preset role resolves to a real role profile', () => {
    for (const preset of Object.values(SPAWN_PRESETS)) {
      expect(getProfile(preset.role), `${preset.name} role ${preset.role}`).toBeTruthy();
    }
  });

  it('resolvePreset accepts hyphen and underscore spellings', () => {
    expect(resolvePreset('pr-reviewer')?.role).toBe('pr_reviewer');
    expect(resolvePreset('pr_reviewer')?.role).toBe('pr_reviewer');
    expect(resolvePreset('Researcher')?.name).toBe('researcher');
    expect(resolvePreset('nope')).toBeUndefined();
    expect(resolvePreset(undefined)).toBeUndefined();
  });
});
