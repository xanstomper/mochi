import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from './config.js';
import { detectPolicy, parsePermissionSlashCommand } from './permission.js';
import { maybeRedact } from './security.js';
import { normalizeToolArgs, buildTools, executeTool } from './tools/index.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { EventBus } from './events.js';

describe('Uncensored Harness', () => {
  it('validates safety mode "uncensored" with zero problems', () => {
    const problems = validateConfig(loadConfig({ safety: { mode: 'uncensored' } }));
    expect(problems).toHaveLength(0);
  });

  it('automatically grants all permissions when safety.mode is uncensored', () => {
    const cfg = loadConfig({ safety: { mode: 'uncensored' } });
    expect(cfg.permissions.admin).toBe(true);
    expect(cfg.permissions.gitDestructive).toBe(true);
    expect(cfg.permissions.shell).toBe(true);
    expect(cfg.permissions.network).toBe(true);
    expect(cfg.permissions.read).toBe(true);
    expect(cfg.permissions.write).toBe(true);
  });

  it('detects policy as yolo when MOCHI_UNCENSORED=1 or --uncensored/-u is provided', () => {
    expect(detectPolicy({ uncensored: true })).toBe('yolo');
    expect(detectPolicy({ u: true })).toBe('yolo');

    const prev = process.env.MOCHI_UNCENSORED;
    try {
      process.env.MOCHI_UNCENSORED = '1';
      expect(detectPolicy({})).toBe('yolo');
    } finally {
      if (prev !== undefined) process.env.MOCHI_UNCENSORED = prev;
      else delete process.env.MOCHI_UNCENSORED;
    }
  });

  it('handles /uncensored and /admin slash commands', () => {
    const res = parsePermissionSlashCommand('/uncensored', 'strict');
    expect(res).toBeDefined();
    expect(res?.newPolicy).toBe('yolo');
    expect(res?.message).toContain('UNCENSORED');

    const resAdmin = parsePermissionSlashCommand('/admin', 'strict');
    expect(resAdmin?.newPolicy).toBe('yolo');

    const resOff = parsePermissionSlashCommand('/uncensored off', 'yolo');
    expect(resOff?.newPolicy).toBe('strict');
  });

  it('bypasses secret redaction when MOCHI_UNCENSORED=1', () => {
    const raw = 'Config: {"api_key":"sk-proj-ABCdefGHIJKLMNOP"}';
    const prev = process.env.MOCHI_UNCENSORED;
    try {
      process.env.MOCHI_UNCENSORED = '1';
      expect(maybeRedact(raw)).toBe(raw);
    } finally {
      if (prev !== undefined) process.env.MOCHI_UNCENSORED = prev;
      else delete process.env.MOCHI_UNCENSORED;
    }
  });

  it('normalizes ~ and ~/ paths in normalizeToolArgs', () => {
    const home = homedir();
    const args1 = normalizeToolArgs('read', { path: '~' });
    expect(args1.path).toBe(home);

    const args2 = normalizeToolArgs('read', { path: '~/AGENTS.md' });
    expect(args2.path).toBe(resolve(home, 'AGENTS.md'));

    const args3 = normalizeToolArgs('glob', { pattern: '~/test/*.ts' });
    expect(args3.path).toBe(home);
    expect(args3.pattern).toBe('test/*.ts');

    const args4 = normalizeToolArgs('search', { dir: '~', query: 'foo' });
    expect(args4.path).toBe(home);
  });

  it('executes tools without permission refusal in uncensored mode', async () => {
    const cfg = loadConfig({ safety: { mode: 'uncensored' }, permissions: { admin: false, shell: false } });
    // Even if permissions had false configured, uncensored mode overrides
    const tools = buildTools(cfg);
    const ctx: any = {
      cwd: process.cwd(),
      config: cfg,
      events: new EventBus(),
      agentId: 'test-agent',
    };
    // chameleonTool or thinkTool
    const res = await executeTool('think', { thought: 'testing uncensored authority' }, ctx, tools);
    expect(res.error).toBeUndefined();
    expect(res.output).toBe('[acknowledged]');
  });
});
