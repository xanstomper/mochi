import { describe, it, expect } from 'vitest';
import { classifyTaskKind, kindHint } from './taskkind.js';

describe('classifyTaskKind', () => {
  it('classifies a bug-fix task as fix', () => {
    expect(classifyTaskKind({ title: 'Fix login bug', description: 'users see 500' })).toBe('fix');
    expect(classifyTaskKind({ title: 'Crash on startup', description: 'segfault in foo()' })).toBe('fix');
  });
  it('classifies refactor tasks', () => {
    expect(classifyTaskKind({ title: 'Refactor util module', description: 'split the helpers' })).toBe('refactor');
    expect(classifyTaskKind({ title: 'Rename Foo to Bar', description: 'across the codebase' })).toBe('refactor');
  });
  it('classifies test tasks', () => {
    expect(classifyTaskKind({ title: 'Add unit tests for parser', description: 'with vitest' })).toBe('test');
    expect(classifyTaskKind({ title: 'Improve coverage', description: 'target 90%' })).toBe('test');
  });
  it('classifies research/plan/document', () => {
    expect(classifyTaskKind({ title: 'Investigate the auth flow', description: 'how does the session live?' })).toBe('research');
    expect(classifyTaskKind({ title: 'Design the new schema', description: 'outline tables' })).toBe('plan');
    expect(classifyTaskKind({ title: 'Document the API', description: 'readme updates' })).toBe('document');
  });
  it('classifies conversational queries as chat', () => {
    expect(classifyTaskKind({ title: 'hello', description: 'hello' })).toBe('chat');
    expect(classifyTaskKind({ title: 'hey there', description: 'how are you doing?' })).toBe('chat');
    expect(classifyTaskKind({ title: 'who are you', description: 'who are you' })).toBe('chat');
  });
  it('falls back to implement for unknown shapes', () => {
    expect(classifyTaskKind({ title: 'Add export to foo', description: 'export const x' })).toBe('implement');
    expect(classifyTaskKind({ title: '', description: '' })).toBe('unknown');
  });
  it('honors the role field', () => {
    expect(classifyTaskKind({ title: 'Whatever', description: 'whatever', role: 'debugger' })).toBe('fix');
    expect(classifyTaskKind({ title: 'Whatever', description: 'whatever', role: 'tester' })).toBe('test');
    expect(classifyTaskKind({ title: 'Whatever', description: 'whatever', role: 'architect' })).toBe('plan');
  });
});

describe('kindHint', () => {
  it('returns a non-empty hint for every kind', () => {
    for (const k of ['fix', 'refactor', 'test', 'research', 'plan', 'document', 'implement', 'chat', 'unknown'] as const) {
      const h = kindHint(k);
      expect(h.length).toBeGreaterThan(20);
    }
  });
  it('debugging hint mentions reproducing the failure', () => {
    expect(kindHint('fix')).toMatch(/reproduc/i);
  });
  it('test hint lists the polyglot runners the agent must pick from', () => {
    const h = kindHint('test');
    expect(h).toMatch(/pytest|go test|cargo test|dotnet test/);
    expect(h.length).toBeGreaterThan(100);
  });
});
