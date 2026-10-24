// prompt-menus with scripted UI fns: every ask_question + approval path.
import { describe, it, expect } from 'vitest';
import { tuiPromptUser, tuiRequestApproval, type PromptMenuDeps } from './prompt-menus.js';
import type { LineKind } from './state.js';
import type { UserPromptQuestion } from '../tools/user-prompt.js';
import type { ApprovalDecision } from '../security/approval.js';

function deps(over: Partial<PromptMenuDeps> = {}): { d: PromptMenuDeps; lines: Array<{ kind: LineKind; text: string }>; menus: string[] } {
  const lines: Array<{ kind: LineKind; text: string }> = [];
  const menus: string[] = [];
  return {
    d: {
      openMenu: async (title: string) => { menus.push(title); return -1; },
      ask: async () => '',
      push: (kind: LineKind, text: string) => { lines.push({ kind, text }); },
      scheduleRender: () => {},
      setMenuSelected: () => {},
      ...over,
    },
    lines,
    menus,
  };
}

const q = (over: Partial<UserPromptQuestion> = {}): UserPromptQuestion => ({
  question: 'Which auth?',
  options: [{ label: 'JWT', description: 'stateless' }, { label: 'sessions' }],
  ...over,
});

describe('tuiPromptUser', () => {
  it('single pick returns the label', async () => {
    const { d, lines } = deps({ openMenu: async () => 0 });
    const res = await tuiPromptUser(d, { questions: [q()] });
    expect(res.answers[0].selected).toEqual(['JWT']);
    expect(res.answers[0].skipped).toBeUndefined();
    expect(lines.some((l) => l.text.includes('you chose: JWT'))).toBe(true);
  });

  it('custom answer flows through freeText', async () => {
    const { d } = deps({
      openMenu: async (_t: string, items: string[]) => items.length - 1,
      ask: async () => '  my own auth  ',
    });
    const res = await tuiPromptUser(d, { questions: [q()] });
    expect(res.answers[0].selected).toEqual([]);
    expect(res.answers[0].freeText).toBe('my own auth');
  });

  it('Esc skips honestly', async () => {
    const { d, lines } = deps({ openMenu: async () => -1 });
    const res = await tuiPromptUser(d, { questions: [q({ header: 'Auth' })] });
    expect(res.answers[0].skipped).toBe(true);
    expect(res.answers[0].selected).toEqual([]);
    expect(lines.some((l) => l.text.includes('skipped'))).toBe(true);
  });

  it('empty custom answer counts as skip', async () => {
    const { d } = deps({
      openMenu: async (_t: string, items: string[]) => items.length - 1,
      ask: async () => '   ',
    });
    const res = await tuiPromptUser(d, { questions: [q()] });
    expect(res.answers[0].skipped).toBe(true);
  });

  it('multi-select accumulates picks until Done', async () => {
    const picks = [0, 1, 2]; // A, B, Done (2 options + Done + Custom)
    const { d } = deps({ openMenu: async () => picks.shift() ?? -1 });
    const res = await tuiPromptUser(d, { questions: [q({ multiSelect: true })] });
    expect(res.answers[0].selected).toEqual(['JWT', 'sessions']);
    expect(res.answers[0].skipped).toBeUndefined();
  });

  it('multi-select immediate Done skips', async () => {
    const { d } = deps({ openMenu: async () => 2 }); // Done with nothing picked
    const res = await tuiPromptUser(d, { questions: [q({ multiSelect: true })] });
    expect(res.answers[0].skipped).toBe(true);
  });

  it('multi-select empty answer keeps picking instead of skipping', async () => {
    const picks = [3, 0, 2]; // custom (empty answer, keep picking) -> pick A -> Done
    const { d, lines } = deps({
      openMenu: async () => picks.shift() ?? -1,
      ask: async () => '   ',
    });
    const res = await tuiPromptUser(d, { questions: [q({ multiSelect: true })] });
    expect(res.answers[0].selected).toEqual(['JWT']);
    expect(res.answers[0].skipped).toBeUndefined();
    expect(lines.some((l) => l.text.includes('JWT'))).toBe(true);
  });

  it('multi-select custom text breaks out with freeText', async () => {
    const { d } = deps({
      openMenu: async (_t: string, items: string[]) => items.length - 1,
      ask: async () => 'both, phased',
    });
    const res = await tuiPromptUser(d, { questions: [q({ multiSelect: true })] });
    expect(res.answers[0].freeText).toBe('both, phased');
  });
});

describe('tuiRequestApproval', () => {
  const req = { tool: 'shell', summary: '$ rm -rf /tmp/x', risk: 'destructive', policy: 'strict' as const };

  it.each([
    [0, 'allow-once', 'allowed once'],
    [1, 'allow-always', 'allowed always'],
    [2, 'deny', 'denied'],
    [-1, 'deny', 'denied'],
  ] as Array<[number, ApprovalDecision, string]>)('idx %i resolves %s', async (idx, decision, lineBit) => {
    const { d, lines } = deps({ openMenu: async () => idx });
    expect(await tuiRequestApproval(d, req)).toBe(decision);
    expect(lines.some((l) => l.text.includes(lineBit))).toBe(true);
    expect(lines[0].text).toContain('wants to run');
  });

  it('omits the risk tag for low-risk calls', async () => {
    const { d, lines } = deps({ openMenu: async () => 0 });
    await tuiRequestApproval(d, { tool: 'shell', summary: '$ ls', risk: 'low', policy: 'workspace-safe' });
    expect(lines[0].text).not.toContain('[risk:');
  });

  // ── W3-4: per-hunk edit review ──────────────────────────────────────────
  const multiHunkEdit = {
    tool: 'write',
    summary: 'write: notes.md',
    policy: 'strict' as const,
    edit: {
      path: 'notes.md',
      diff: [
        'diff --git a/notes.md b/notes.md',
        '--- a/notes.md',
        '+++ b/notes.md',
        '@@ -1,2 +1,2 @@',
        ' top',
        '-old one',
        '+new one',
        '@@ -8,2 +8,2 @@',
        ' bottom top',
        '-old two',
        '+new two',
      ].join('\n'),
      hunks: [
        '@@ -1,2 +1,2 @@\n top\n-old one\n+new one',
        '@@ -8,2 +8,2 @@\n bottom top\n-old two\n+new two',
      ],
    },
  };

  it('multi-hunk edits show a diff preview then a hunk-review menu', async () => {
    const seq = [2]; // Apply accepted (default: every hunk accepted)
    const { d, lines, menus } = deps({ openMenu: async (title: string) => { menus.push(title); return seq.shift() ?? -1; } });
    const res = await tuiRequestApproval(d, multiHunkEdit);
    expect(res).toEqual({ decision: 'allow-once', acceptedHunks: [0, 1] });
    expect(lines.some((l) => l.text.includes('-old one'))).toBe(true); // diff preview shown
    expect(menus[0]).toContain('pick hunks');
    expect(lines.some((l) => l.text.includes('applying 2/2 hunks to notes.md'))).toBe(true);
  });

  it('toggling a hunk rejects it; apply-all memorizes allow-always', async () => {
    const seq = [0, 0, 3]; // reject hunk 0, re-accept hunk 0, then Apply all
    const { d, lines, menus } = deps({ openMenu: async (title: string) => { menus.push(title); return seq.shift() ?? -1; } });
    const res = await tuiRequestApproval(d, multiHunkEdit);
    expect(res).toBe('allow-always');
    expect(lines.some((l) => l.text.includes('allowed always this session: all 2 hunks'))).toBe(true);
  });

  it('Esc and Deny all refuse the whole edit', async () => {
    const { d, lines, menus } = deps({ openMenu: async (title: string) => { menus.push(title); return -1; } });
    expect(await tuiRequestApproval(d, multiHunkEdit)).toBe('deny');
    expect(lines.some((l) => l.text.includes('denied: write: notes.md'))).toBe(true);
    const { d: d2 } = deps({ openMenu: async (title: string, _items?: string[]) => { menus.push(title); return 4; } }); // ✗ Deny all row
    expect(await tuiRequestApproval(d2, multiHunkEdit)).toBe('deny');
  });

  it('applying with zero accepted hunks re-prompts instead of applying', async () => {
    const seq = [0, 1, 2, 4]; // reject both hunks, blocked apply (re-prompts), then Deny all
    const calls: string[] = [];
    const { d } = deps({ openMenu: async (title: string) => { calls.push(title); return seq.shift() ?? -1; } });
    const res = await tuiRequestApproval(d, multiHunkEdit);
    expect(res).toBe('deny');
    // openMenu: reject, reject, blocked apply → re-open, deny = 4 menus, all
    // the hunk-review menu.
    expect(calls.length).toBe(4);
    expect(calls.every((c) => c.includes('pick hunks'))).toBe(true);
  });

  it('single-hunk edits keep the plain allow menu but still preview the diff', async () => {
    const single = {
      tool: 'edit',
      summary: 'edit: one.txt',
      policy: 'strict' as const,
      edit: {
        path: 'one.txt',
        diff: 'diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1,1 +1,1 @@\n-a\n+b',
        hunks: ['@@ -1,1 +1,1 @@\n-a\n+b'],
      },
    };
    const { d, lines, menus } = deps({ openMenu: async (title: string) => { menus.push(title); return 0; } });
    expect(await tuiRequestApproval(d, single)).toBe('allow-once');
    expect(menus[0]).toContain('Allow edit?');
    expect(lines.some((l) => l.text.includes('-a'))).toBe(true);
  });

  it('non-edit requests render no review block', async () => {
    const { d, lines } = deps({ openMenu: async () => 0 });
    await tuiRequestApproval(d, { tool: 'shell', summary: '$ ls', risk: 'low', policy: 'strict' });
    expect(lines.some((l) => l.text.includes('reviewing '))).toBe(false);
  });
});
