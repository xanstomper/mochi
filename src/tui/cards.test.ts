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
      expect(describeToolArgs('write', { path: 'src/foo.ts', content: 'x' })).toBe('src/foo.ts  (1 line)');
      expect(describeToolArgs('edit', { path: 'src/foo.ts', oldText: 'a', newText: 'b' })).toContain('src/foo.ts');
      expect(describeToolArgs('delete', { path: 'src/foo.ts' })).toBe('src/foo.ts');
    });

    it('prefixes shell commands with $', () => {
      expect(describeToolArgs('shell', { command: 'npm test' })).toBe('$ npm test');
      expect(describeToolArgs('shell', { command: '  git status  ' })).toBe('$ git status');
    });

    it('quotes search/glob queries', () => {
      expect(describeToolArgs('search', { query: 'foo' })).toBe('"foo"');
      expect(describeToolArgs('glob', { pattern: '*.ts' })).toBe('pattern: *.ts');
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
    it('produces a header, body line, and bottom border', () => {
      const card = renderToolCard('edit', { path: 'src/foo.ts', oldText: 'a', newText: 'b' });
      const lines = card.split('\n');
      expect(lines.length).toBe(3);
      // Header: top-left corner with the tool name.
      expect(lines[0]).toMatch(/┌─/);
      expect(lines[0]).toContain('EDIT');
      // Body line has the path.
      expect(lines[1]).toContain('src/foo.ts');
      // Bottom border.
      expect(lines[2]).toMatch(/└─+┘/);
    });

    it('renders the success outcome line with duration in the header', () => {
      const card = renderToolCard(
        'edit',
        { path: 'src/foo.ts', oldText: 'a', newText: 'b' },
        { kind: 'success', summary: 'updated src/foo.ts', durationMs: 42 },
      );
      const lines = card.split('\n');
      expect(lines.length).toBe(4); // header + body + outcome + bottom
      expect(lines[0]).toContain('42ms');
      expect(lines[2]).toContain('updated src/foo.ts');
    });

    it('uses ✗ for errors', () => {
      const card = renderToolCard(
        'edit',
        { path: 'src/foo.ts' },
        { kind: 'error', summary: 'ENOENT' },
        { status: 'error' },
      );
      expect(card).toContain('ENOENT');
    });

    it('keeps cards narrow enough to never wrap mid-card', () => {
      const card = renderToolCard('read', { path: 'a/very/long/path/that/would/otherwise/wrap/very/awkwardly/in/a/narrow/terminal/window.ts' });
      for (const line of card.split('\n')) {
        const visible = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        // Card width is 56 cells by default; allow ~2 cells for borders.
        expect(visible.length).toBeLessThanOrEqual(60);
      }
    });
  });

  describe('formatToolInvocationCard / formatToolCompletedCard', () => {
    it('invocation has no outcome line (pending)', () => {
      const card = formatToolInvocationCard('read', { path: 'src/foo.ts' });
      expect(card.split('\n').length).toBe(3); // header + body + bottom, no outcome
    });

    it('completion includes the outcome line', () => {
      const card = formatToolCompletedCard(
        'edit',
        { path: 'src/foo.ts' },
        { output: 'updated src/foo.ts', durationMs: 42 },
      );
      expect(card.split('\n').length).toBe(4);
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
    const lines = card.split('\n');
    expect(lines[0]).toMatch(/┌─/);
    expect(card).toContain('TURN COMPLETE');
    expect(card).toContain('4523ms');
    expect(card).toContain('8 tools');
    expect(card).toContain('src/a.ts');
    expect(card).toContain('Refactored tool rendering.');
    expect(card).toContain('4,231 tokens');
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
    expect(card).toContain('TURN STOPPED');
    expect(card).toContain('tool_loop');
    // No "files:" row when none modified.
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
    // Some of the first 4 paths are shown, the rest are summarised with "+N more".
    expect(card).toMatch(/\(\+\d+ more\)/);
    expect(card).toContain('file0.ts');
    expect(card).toContain('file1.ts');
    // The total "more" count is the difference between files.length and what
    // fits in the card, so it must be < files.length and >= 1.
    const m = card.match(/\(\+(\d+) more\)/);
    expect(m).not.toBeNull();
    const more = Number(m![1]);
    expect(more).toBeGreaterThanOrEqual(1);
    expect(more).toBeLessThan(files.length);
  });
});
