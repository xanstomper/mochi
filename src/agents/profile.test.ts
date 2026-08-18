import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AgentProfileService, parseProfileMarkdown } from './profile.js';

const sample = `---
name: debugger
description: Diagnose and repair software failures
tools:
  - read
  - search
  - edit
  - shell
  - git
model: reasoning
verification: required
maxIterations: 24
---
You diagnose failures, identify root causes, and apply minimal fixes.`;

describe('agent profiles', () => {
  it('parses profile frontmatter and body', () => {
    const p = parseProfileMarkdown(sample);
    expect(p?.name).toBe('debugger');
    expect(p?.tools).toEqual(['read', 'search', 'edit', 'shell', 'git']);
    expect(p?.model).toBe('reasoning');
    expect(p?.verification).toBe('required');
    expect(p?.maxIterations).toBe(24);
    expect(p?.systemPrompt).toContain('root causes');
  });

  it('loads built-in and user profiles', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-profiles-'));
    mkdirSync(resolve(dir, 'agents'), { recursive: true });
    writeFileSync(resolve(dir, 'agents/debugger.md'), sample);
    const service = new AgentProfileService(dir);
    expect(service.get('debugger')?.verification).toBe('required');
    expect(service.get('coder')?.defaultModel).toBe('coding');
    expect(service.list().length).toBeGreaterThanOrEqual(8);
  });

  it('overrides built-in profiles with user profiles', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-profiles-'));
    mkdirSync(resolve(dir, 'agents'), { recursive: true });
    writeFileSync(resolve(dir, 'agents/coder.md'), sample.replace('debugger', 'coder'));
    const service = new AgentProfileService(dir);
    expect(service.get('coder')?.tools).toContain('search');
  });
});
