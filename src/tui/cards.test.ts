import { describe, it, expect } from 'vitest';
import {
  renderToolCard,
  formatToolInvocationCard,
  formatToolCompletedCard,
  describeToolArgs,
  describeToolOutcome,
  renderTurnSummaryCard,
} from './cards.js';

describe('tool cards', () => {
  describe('describeToolArgs', () => {
    it('shows path for file tools', () => {
      expect(describeToolArgs('read', { path: 'src/foo.ts' })).toBe('src/foo.ts');
      expect(describeToolArgs('write', { path: 'src/foo.ts', content: 'x' })).toContain('src/foo.ts');
      expect(describeToolArgs('write', { path: 'src/foo.ts', content: 'x' })).toContain('1 line');
      expect(describeToolArgs('edit', { path: 'src/foo.ts', oldText: 'a', newText: 'b' })).toContain('src/foo.ts');
      expect(describeToolArgs('delete', { path: 'src/foo.ts' })).toBe('src/foo.ts');
    });

    it('prefixes shell commands with $', () => {
      expect(describeToolArgs('shell', { command: 'npm test' })).toBe('$ npm test');
      expect(describeToolArgs('shell', { command: '  git status  ' })).toBe('$ git status');
    });

    it('quotes search/glob queries', () => {
      expect(describeToolArgs('search', { query: 'foo' })).toBe('"foo"');
      expect(describeToolArgs('glob', { pattern: '*.ts' })).toBe('*.ts');
    });

    it('shows subagent role + prompt preview', () => {
      expect(describeToolArgs('subagent', { role: 'tester', prompt: 'Run the tests' })).toContain('[tester]');
      expect(describeToolArgs('subagent', { role: 'tester', prompt: 'Run the tests' })).toContain('Run the tests');
    });

    it('counts parallel subtasks', () => {
      expect(describeToolArgs('subagent', { tasks: [{}, {}, {}] })).toBe('3 parallel subtasks');
      expect(describeToolArgs('subagent', { tasks: [{}] })).toBe('1 parallel subtask');
    });
  });

  describe('describeToolOutcome', () => {
    it('classifies error results', () => {
      const r = describeToolOutcome('shell', { error: 'boom', durationMs: 12 });
      expect(r.kind).toBe('error');
      expect(r.summary).toContain('boom');
      expect(r.durationMs).toBe(12);
    });

    it('uses the first non-metadata line for success', () => {
      const r = describeToolOutcome('shell', { output: 'exit_code: 0\nTests passed', durationMs: 5 });
      expect(r.kind).toBe('success');
      expect(r.summary).toBe('Tests passed');
      expect(r.durationMs).toBe(5);
    });

    it('falls back to "completed (no output)" when output is empty', () => {
      const r = describeToolOutcome('edit', { output: '   \n  ' });
      expect(r.kind).toBe('success');
      expect(r.summary).toContain('no output');
    });
  });

  describe('renderToolCard', () => {
    it('produces a compact semantic row + inline diff (no boxes)', () => {
      const card = renderToolCard('edit', { path: 'src/foo.ts', oldText: 'a', newText: 'b' });
      const lines = card.split('\n');
      expect(lines[0]).toContain('edit');
      expect(lines[0]).toContain('src/foo.ts');
      expect(card).not.toMatch(/┌|└|─+┐/);
    });

    it('renders the success duration in the primary row and diff summary', () => {
      const card = renderToolCard(
        'edit',
        { path: 'src/foo.ts', oldText: 'a', newText: 'b' },
        { kind: 'success', summary: 'updated src/foo.ts', durationMs: 42 },
      );
      const lines = card.split('\n');
      expect(lines[0]).toContain('✓');
      expect(lines[0]).toContain('42ms');
      expect(card).toContain('1 change');
    });

    it('uses × for errors', () => {
      const card = renderToolCard(
        'edit',
        { path: 'src/foo.ts' },
        { kind: 'error', summary: 'ENOENT' },
        { status: 'error' },
      );
      expect(card).toContain('×');
      expect(card).toContain('ENOENT');
    });

    it('keeps rows narrow enough to never wrap mid-row', () => {
      const card = renderToolCard('read', { path: 'a/very/long/path/that/would/otherwise/wrap/very/awkwardly/in/a/narrow/terminal/window.ts' });
      for (const line of card.split('\n')) {
        const visible = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        expect(visible.length).toBeLessThanOrEqual(104);
      }
    });
  });

  describe('formatToolInvocationCard / formatToolCompletedCard', () => {
    it('invocation is a single pending row (no outcome line)', () => {
      const card = formatToolInvocationCard('read', { path: 'src/foo.ts' });
      expect(card.split('\n').length).toBe(1);
      expect(card).toContain('read');
      expect(card).not.toContain('↳');
    });

    it('completion includes the outcome line', () => {
      const card = formatToolCompletedCard(
        'read',
        { path: 'src/foo.ts' },
        { output: 'updated src/foo.ts', durationMs: 42 },
      );
      expect(card).toContain('✓');
      expect(card).toContain('updated src/foo.ts');
      expect(card).toContain('42ms');
    });
  });
});

describe('renderTurnSummaryCard', () => {
  it('renders a success summary with files modified and tool count', () => {
    const card = renderTurnSummaryCard({
      success: true,
      stopReason: 'completed',
      durationMs: 4523,
      toolCallsTotal: 8,
      tokensUsed: 4231,
      filesModified: ['src/a.ts', 'src/b.ts'],
      summary: 'Refactored tool rendering.',
    });
    expect(card).toContain('Done');
    expect(card).toContain('4.5s');
    expect(card).toContain('8 tools');
    expect(card).toContain('src/a.ts');
    expect(card).toContain('Refactored tool rendering.');
    expect(card).toContain('4,231 tokens');
    expect(card).not.toContain('TURN COMPLETE');
  });

  it('renders a failure summary showing the stop reason', () => {
    const card = renderTurnSummaryCard({
      success: false,
      stopReason: 'tool_loop',
      durationMs: 12000,
      toolCallsTotal: 14,
      tokensUsed: 8000,
      filesModified: [],
      summary: 'Model got stuck in a loop.',
    });
    expect(card).toContain('Stopped');
    expect(card).toContain('Model got stuck in a loop.');
    expect(card).not.toContain('files:');
  });

  it('omits the files row when nothing was modified', () => {
    const card = renderTurnSummaryCard({
      success: true,
      durationMs: 100,
      toolCallsTotal: 1,
      filesModified: [],
      summary: 'Read-only task',
    });
    expect(card).not.toContain('files:');
    expect(card).toContain('Read-only task');
  });

  it('caps the file list and shows a count of the rest', () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`);
    const card = renderTurnSummaryCard({
      success: true,
      durationMs: 100,
      toolCallsTotal: 8,
      filesModified: files,
      summary: 'Refactor',
    });
    expect(card).toMatch(/\(\+\d+ more\)/);
    expect(card).toContain('file0.ts');
    expect(card).toContain('file1.ts');
    const m = card.match(/\(\+(\d+) more\)/);
    expect(m).not.toBeNull();
    const more = Number(m![1]);
    expect(more).toBeGreaterThanOrEqual(1);
    expect(more).toBeLessThan(files.length);
  });
});
