import { describe, it, expect } from 'vitest';
import {
  T,
  gradientContextBar,
  gradientCacheBar,
  spinnerColored,
  spinnerSweep,
  splashFrame,
  contextBar,
  usageText,
  statusBarRow1,
  statusBarRow2,
  statusBarRow3,
  renderToolOutput,
  renderEntry,
  composerRow,
  composerBottomRule,
  renderDropdown,
  transcriptIndent,
  spinnerFrame,
  thinkingLine,
  ellipsize,
  visibleLen,
} from './view.js';

function baseStatus(over: Partial<Parameters<typeof statusBarRow1>[0]> = {}) {
  return {
    modelId: 'deepseek-v4-flash',
    totalTokens: 12345,
    totalCost: 0.42,
    maxInputTokens: 128000,
    mode: 'act' as const,
    workspaceName: 'mochi',
    gitBranch: 'main',
    gitDiff: { files: 3, additions: 120, deletions: 8 },
    autoApprove: false,
    ...over,
  };
}

describe('palette', () => {
  it('exposes cline accent colors', () => {
    expect(T.act).toContain('121;184;255'); // #79b8ff
    expect(T.plan).toContain('255;234;127'); // #ffea7f
    expect(T.success).toContain('153;232;155'); // #99e89b
  });
});

describe('contextBar', () => {
  it('builds a filled bar proportional to usage', () => {
    const half = contextBar(500, 1000, 6);
    expect(half.filled.length).toBeGreaterThanOrEqual(2);
    expect(half.filled.length + half.empty.length).toBe(6);
    expect(half.pct).toBe(0.5);
  });

  it('saturates at full usage', () => {
    expect(contextBar(2000, 1000, 6).filled).toBe('██████');
  });

  it('renders empty when no budget', () => {
    expect(contextBar(0, 0, 6).filled).toBe('');
  });
});

describe('usageText', () => {
  it('formats tokens with separators and cost', () => {
    expect(usageText(12345, 0.423)).toBe('(12,345) $0.42');
  });
});

describe('statusBar rows', () => {
  it('row1 shows model, usage, and Plan/Act toggle', () => {
    const row = statusBarRow1(baseStatus(), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('deepseek-v4-flash');
    expect(plain).toContain('(12,345) $0.42');
    expect(plain).toContain('○ Plan');
    expect(plain).toContain('● Act');
    expect(plain).toContain('(Tab)');
  });

  it('row1 highlights plan mode', () => {
    const row = statusBarRow1(baseStatus({ mode: 'plan' }), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('● Plan');
    expect(plain).toContain('○ Act');
  });

  it('row2 shows workspace, branch, and diff stats', () => {
    const row = statusBarRow2(baseStatus(), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('mochi (main)');
    expect(plain).toContain('3 files');
    expect(plain).toContain('+120');
    expect(plain).toContain('-8');
  });

  it('row3 shows auto-approve state', () => {
    expect(statusBarRow3(true, 80)).toMatch(/Auto-approve enabled/);
    expect(statusBarRow3(false, 80)).toMatch(/Auto-approve off/);
  });
});

describe('renderToolOutput', () => {
  it('collapses to first line plus a more-lines note', () => {
    const out = renderToolOutput('line1\nline2\nline3\nline4');
    const plain = out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('⌿ line1');
    expect(plain).toContain('… 3 more lines');
  });

  it('single line has no more-note', () => {
    const out = renderToolOutput('only line');
    expect(out).toHaveLength(1);
    const plain = out[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('⌿ only line');
  });
});

describe('renderEntry', () => {
  it('user entries get the ❯ accent', () => {
    const [row] = renderEntry({ kind: 'user', text: 'hello' });
    expect(row).toContain('❯');
    expect(row).toContain('hello');
  });

  it('errors get ✗', () => {
    const [row] = renderEntry({ kind: 'error', text: 'boom' });
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('✗ boom');
  });

  it('empty text renders nothing', () => {
    expect(renderEntry({ kind: 'assistant', text: '   ' })).toEqual([]);
  });
});

describe('composer', () => {
  it('composer row shows the ❯ prompt and text', () => {
    const row = composerRow('fix the bug', 60);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('❯');
    expect(plain).toContain('fix the bug');
  });

  it('bottom rule carries the hint', () => {
    const rule = composerBottomRule(60, '⏎ send · / commands · esc stop');
    const plain = rule.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('⏎ send');
  });
});

describe('dropdown', () => {
  it('renders items with selection marker', () => {
    const rows = renderDropdown(
      [
        { name: '/mode', hint: 'set mode' },
        { name: '/model', hint: 'pick model' },
      ],
      1,
      60,
    );
    const plain = rows.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('/mode');
    expect(plain).toContain('/model');
    expect(plain).toContain('❯ /model');
    expect(plain).not.toContain('❯ /mode ');
  });
});

describe('layout', () => {
  it('centers the transcript on wide terminals', () => {
    expect(transcriptIndent(120)).toBeGreaterThan(0);
    expect(transcriptIndent(60)).toBe(0);
  });

  it('spinner cycles braille dots', () => {
    expect(spinnerFrame(0)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(spinnerFrame(1)).not.toBe(spinnerFrame(0));
  });

  it('thinking line mentions esc', () => {
    expect(thinkingLine(0)).toContain('Thinking');
    expect(thinkingLine(0)).toContain('esc to cancel');
  });
});

describe('text utils', () => {
  it('visibleLen ignores ansi', () => {
    expect(visibleLen(`${T.act}abc${T.reset}`)).toBe(3);
  });

  it('ellipsize truncates to budget', () => {
    const out = ellipsize('abcdefghij', 5);
    expect(visibleLen(out)).toBe(5);
    expect(out.endsWith('…')).toBe(true);
  });
});
describe('gradient bars (jcode-style)', () => {
  it('context bar ramps lime→red as usage grows', () => {
    const low = gradientContextBar(1, 100, 10, 0);
    const high = gradientContextBar(99, 100, 10, 0);
    expect(low.pct).toBeLessThan(0.2);
    expect(high.pct).toBeGreaterThan(0.9);
    // low-usage filled cells are lime-ish (163,230,53 present)
    expect(low.text).toContain('38;2;163;230;53');
    // high-usage ramp reaches red family
    expect(high.text).toContain('38;2;248;81;73');
  });

  it('tick animates a white glow head while busy', () => {
    const idle = gradientContextBar(50, 100, 10, 0);
    const busy = gradientContextBar(50, 100, 10, 3);
    expect(busy.text).toContain('38;2;255;255;255');
    expect(idle.text).not.toContain('38;2;255;255;255');
  });

  it('cache bar full at rate 1 with lime gradient', () => {
    const full = gradientCacheBar(1, 8, 0);
    expect(full.pct).toBe(1);
    expect(full.text).not.toContain('░');
    expect(full.text).toContain('38;2;163;230;53');
  });

  it('cache bar empty at rate 0', () => {
    const empty = gradientCacheBar(0, 8, 0);
    expect(empty.text).not.toContain('38;2;163');
  });
});

describe('animated spinner', () => {
  it('cycles colored frames', () => {
    const a = spinnerColored(0);
    const b = spinnerColored(3);
    expect(a).not.toBe(b);
    expect(a).toMatch(/⠋/);
    expect(b).toMatch(/⠸/);
  });

  it('sweep line animates', () => {
    const a = spinnerSweep(0, 12);
    const b = spinnerSweep(5, 12);
    expect(a).not.toBe(b);
    expect(a).toContain('━');
  });

  it('thinking line includes the sweep and note', () => {
    const line = thinkingLine(2, 'running tests');
    expect(line).toContain('Thinking');
    expect(line).toContain('running tests');
    expect(line).toContain('━');
  });
});

describe('splash screen', () => {
  it('renders centered logo + version each tick', () => {
    const f = splashFrame(3, 100, '0.10.2');
    const plain = f.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('█');
    expect(plain).toContain('m o c h i');
    expect(plain).toContain('v0.10.2');
  });

  it('animates between ticks', () => {
    const a = splashFrame(2, 100, '1.0.0');
    const b = splashFrame(6, 100, '1.0.0');
    expect(a.join('|')).not.toBe(b.join('|'));
  });
});

describe('color coordination', () => {
  it('edit tools get violet accent, read tools cyan', () => {
    const edit = renderEntry({ kind: 'tool', text: 'write({"path":"a.ts"})' });
    expect(edit[0]).toContain('38;2;199;146;234');
    const read = renderEntry({ kind: 'tool', text: 'read({"path":"a.ts"})' });
    expect(read[0]).toContain('38;2;86;212;221');
  });

  it('errors are bold red with ✗', () => {
    const err = renderEntry({ kind: 'error', text: 'boom' });
    expect(err[0]).toContain('✗');
    expect(err[0]).toContain('38;2;248;81;73');
  });
});
