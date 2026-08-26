import { describe, it, expect } from 'vitest';
import {
  renderToolCard,
  formatToolInvocationCard,
  formatToolCompletedCard,
  describeToolArgs,
  describeToolOutcome,
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