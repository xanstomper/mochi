import { describe, it, expect, beforeEach } from 'vitest';
import {
  T,
  R,
  setTheme,
  getAllThemes,
  gradientContextBar,
  gradientCacheBar,
  splashFrame,
  SPLASH_PHASES,
  contextBar,
  usageText,
  statusBarRow1,
  statusBarRow2,
  renderToolOutput,
  renderEntry,
  composerRow,
  composerPlaceholderRow,
  composerBottomRule,
  composerHintRow,
  renderDropdown,
  renderTaskStepper,
  transcriptIndent,
  spinnerFrame,
  sparkleFrame,
  spinnerColored,
  thinkingLine,
  doneLine,
  resolveVerb,
  movingDots,
  farewellFrame,
  formatDuration,
  ellipsize,
  visibleLen,
  maskSecretInput,
  highlightShellCommand,
  renderMetricGauge,
  renderMarkdown,
  parseTableCells,
  stripAnsi,
} from './view.js';
const m = { renderMarkdown };
import { formatToolInvocationCard } from './cards.js';

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
  beforeEach(() => {
    setTheme('cyber-void');
  });

  it('exposes accent colors', () => {
    expect(T.act).toBeDefined();
    expect(T.plan).toBeDefined();
    expect(T.success).toBeDefined();
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
  it('row1 shows model and usage; plan/act toggle moved to bars row (MCH-70)', () => {
    const row = statusBarRow1(baseStatus(), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('deepseek-v4-flash');
    expect(plain).toContain('(12,345) $0.42');
    expect(plain).not.toContain('(Tab)');
  });

  it('row1 keeps compact toggle at narrow width', () => {
    const row = statusBarRow1(baseStatus({ mode: 'plan' }), 60);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('● Plan');
  });

  it('row1 highlights plan mode via compact toggle at narrow width', () => {
    const row = statusBarRow1(baseStatus({ mode: 'plan' }), 60);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('● Plan');
  });

  it('row1 shows agent-mode overlay when active', () => {
    const row = statusBarRow1(baseStatus({ agentMode: 'security' }), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('[SECURITY]');
  });

  it('row1 hides normal agent-mode overlay', () => {
    const row = statusBarRow1(baseStatus({ agentMode: 'normal' }), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('[NORMAL]');
  });

  it('row1 displays active reasoning level next to model', () => {
    const row = statusBarRow1(baseStatus({ reasoningLevel: 'high' }), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('[REASON: HIGH]');
  });

  it('row1 displays token velocity speedometer when available', () => {
    const row = statusBarRow1(baseStatus({ tokenVelocity: 68 }), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('68 t/s ▲');
  });

  it('row1 keeps clean model name on the left without jumping bottom spinner', () => {
    const row = statusBarRow1(baseStatus(), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.startsWith('deepseek-v4-flash')).toBe(true);
    expect(plain).not.toContain('⠋');
  });

  it('row2 shows workspace, branch, and diff stats', () => {
    const row = statusBarRow2(baseStatus(), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('mochi (main)');
    expect(plain).toContain('3 files');
    expect(plain).toContain('+120');
    expect(plain).toContain('-8');
    expect(plain).toContain('Auto improve: OFF');
  });

  it('row1 shows the live turn count next to usage (W3-4)', () => {
    const row = statusBarRow1(baseStatus({ turns: 7 }), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('· 7 turns');
  });

  it('row1 singularizes a single turn', () => {
    const row = statusBarRow1(baseStatus({ turns: 1 }), 90);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    // `turn` followed by whitespace — 'turns' (plural) would NOT match.
    expect(plain).toMatch(/· 1 turn\s/);
  });

  it('row1 hides the turn count on narrow terminals', () => {
    const row = statusBarRow1(baseStatus({ turns: 7 }), 46);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('turn');
  });

  it('row1 shows the routing reason for the current model (W3-4)', () => {
    const row = statusBarRow1(
      baseStatus({ routingReason: 'routed deepseek-v4←default: cps $0.0021 · 91% solve · 14 runs' }),
      120,
    );
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('[route: routed deepseek-v4←default: cps $0.0021 · 91% solve · 14 runs]');
  });

  it('row1 compacts the routing badge to the evidence class at medium width', () => {
    const row = statusBarRow1(
      baseStatus({ routingReason: 'routed deepseek-v4←default: cps $0.0021 · 91% solve · 14 runs' }),
      80,
    );
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('[⇢ routed]');
    expect(plain).not.toContain('cps');
  });

  it('row1 hides the routing badge on narrow terminals', () => {
    const row = statusBarRow1(baseStatus({ routingReason: 'pinned' }), 60);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('pinned');
    expect(plain).not.toContain('⇢');
  });

  it('row1 never overflows width with a very long routing reason', () => {
    const row = statusBarRow1(baseStatus({ routingReason: 'routed x: ' + 'y'.repeat(160) }), 100);
    expect(visibleLen(row)).toBeLessThanOrEqual(100);
  });

  it('row1 shows no routing badge when no routing decision was made', () => {
    const row = statusBarRow1(baseStatus(), 120);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('[route:');
    expect(plain).not.toContain('⇢');
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

  it('errors get [ERR]', () => {
    const [row] = renderEntry({ kind: 'error', text: 'boom' });
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('[ERR] boom');
  });

  it('thought entries render with italic gutter bar', () => {
    const [row] = renderEntry({ kind: 'thought', text: 'analyzing AST' });
    expect(row).toContain('analyzing AST');
  });

  it('empty text renders nothing', () => {
    expect(renderEntry({ kind: 'assistant', text: '   ' })).toEqual([]);
  });

  // ---- Coordinated visual language (grid + gutter markers) ----------------
  it('most transcript entries start with a 2-space left gutter for grid alignment', () => {
    const kinds = ['user', 'thought', 'tool', 'error', 'system', 'task', 'goal'] as const;
    for (const kind of kinds) {
      const rows = renderEntry({ kind, text: 'x' });
      expect(rows.length).toBeGreaterThan(0);
      const plain = rows[0].replace(/\x1b\[[0-9;]*m/g, '');
      expect(plain.startsWith('  ')).toBe(true);
    }
  });

  it('user keeps ❯ accent and background fill', () => {
    const [row] = renderEntry({ kind: 'user', text: 'hi' });
    expect(row).toContain('❯');
    expect(row).toContain(T.bgUser);
    expect(row).toContain(T.fg);
  });

  it('thought renders as plain dim italic prose (no glyph gutters)', () => {
    const [row] = renderEntry({ kind: 'thought', text: 'analyzing AST' });
    expect(row).toContain('analyzing AST');
    expect(row).toContain(T.italic);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('◇');
  });

  it('tool rows pass through compact semantic card text', () => {
    const [row] = renderEntry({ kind: 'tool', text: '✓ edit src/a.ts' });
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('edit');
    expect(plain).toContain('src/a.ts');
  });

  it('system uses ◆ gutter and gray text', () => {
    const [row] = renderEntry({ kind: 'system', text: 'cached' });
    expect(row).toContain('◆');
    expect(row).toContain(R.systemText);
  });

  it('task uses ★ gutter and [TASK] tag', () => {
    const [row] = renderEntry({ kind: 'task', text: 'fix the bug' });
    expect(row).toContain('★');
    expect(row).toContain('[TASK]');
    expect(row).toContain(R.taskMark);
  });

  it('goal uses ◉ gutter and [GOAL] tag', () => {
    const [row] = renderEntry({ kind: 'goal', text: 'ship mochi 1.0' });
    expect(row).toContain('◉');
    expect(row).toContain('[GOAL]');
    expect(row).toContain(T.pink);
  });

  it('error uses ! gutter + [ERR] tag + T.error color', () => {
    const [row] = renderEntry({ kind: 'error', text: '[ERR] boom' });
    expect(row).toContain('!');
    expect(row).toContain('[ERR]');
    expect(row).toContain(T.error);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('[ERR] boom');
  });

  it('assistant markdown renders as terminal prose (no glyph rule)', () => {
    // Soft-wrapped paragraphs collapse to one logical line; hard line breaks
    // are preserved as separate output rows. The previous per-line `▌` rule
    // marker is gone; assistant text reads as plain terminal prose.
    const rows = renderEntry({ kind: 'assistant', text: 'hello world' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(plain).not.toContain('▌');
    expect(plain).toContain('hello world');
  });

  it('multi-line system entry repeats ◆ on every line', () => {
    const rows = renderEntry({ kind: 'system', text: 'first\nsecond\nthird' });
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r).toContain('◆');
  });
});

describe('composer', () => {
  it('maskSecretInput hides secrets char-for-char (lengths preserved for caret math)', () => {
    expect(maskSecretInput('sk-abc123')).toBe('*********');
    expect(maskSecretInput('').length).toBe(0);
    expect(maskSecretInput('a\nb').length).toBe(3);
    expect(maskSecretInput('sk-abc123')).not.toContain('sk-abc123');
  });

  it('composer row shows the ❯ prompt and text', () => {
    const row = composerRow('fix the bug', 60);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('❯');
    expect(plain).toContain('fix the bug');
  });

  it('composer placeholder row shows clean ❯ prompt and placeholder text', () => {
    const row = composerPlaceholderRow('Message mochi…', 60);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('❯');
    expect(plain).toContain('Message mochi…');
    expect(visibleLen(row.replace(/\x1b\[[0-9;]*m/g, ''))).toBe(60);
  });

  it('wrapped continuation rows do NOT repeat the ❯ prompt (no stacked symbols)', () => {
    const first = composerRow('line one', 60, true).replace(/\x1b\[[0-9;]*m/g, '');
    const cont = composerRow('line two', 60, false).replace(/\x1b\[[0-9;]*m/g, '');
    expect(first).toContain('❯');
    expect(cont).not.toContain('❯');
    // Continuation keeps the left border and grafts the text at the same column.
    expect(cont.startsWith('│')).toBe(true);
  });

  it('first and continuation rows have identical total width (box stays square)', () => {
    for (const w of [60, 40, 30]) {
      const first = composerRow('abc', w).replace(/\x1b\[[0-9;]*m/g, '');
      const cont = composerRow('def', w, false).replace(/\x1b\[[0-9;]*m/g, '');
      expect(visibleLen(first), `width ${w} first`).toBe(w);
      expect(visibleLen(cont), `width ${w} cont`).toBe(w);
      expect(visibleLen(first)).toBe(visibleLen(cont));
    }
  });

  it('bottom rule is a plain rule (hint moved above the box)', () => {
    const rule = composerBottomRule(60);
    const plain = rule.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toBe('└' + '─'.repeat(58) + '┘');
    expect(plain).not.toContain('send');
  });

  it('hint row is left-aligned above the composer box', () => {
    const row = composerHintRow('⏎ send · Tab → plan · esc stop', 60);
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('⏎ send · Tab → plan · esc stop');
    // left-aligned: starts at column 0, under the auto-approve row
    expect(plain.startsWith('⏎')).toBe(true);
    // fits any width without overflow math
    const cramped = composerHintRow('⏎ send · Tab → plan · esc stop', 10);
    expect(cramped.replace(/\x1b\[[0-9;]*m/g, '').length).toBeGreaterThan(0);
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

  it('renders category pills for raycast palette on wide viewports', () => {
    const rows = renderDropdown(
      [{ name: '/help', hint: 'show help' }],
      0,
      60,
    );
    const plain = rows.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('[All]');
    expect(plain).toContain('[Tools]');
    expect(plain).toContain('[Themes]');
    expect(plain).toContain('[Skills]');
  });
});

describe('task stepper', () => {
  it('renders borderless cyber stepper with status icons and connectors', () => {
    const tasks = [
      { id: '1', title: 'Audit Code', status: 'completed' },
      { id: '2', title: 'Patch view.ts', status: 'running' },
      { id: '3', title: 'Run Tests', status: 'pending' },
    ];
    const out = renderTaskStepper(tasks, 80);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('·✦·');
    expect(plain).toContain('[1/3 ✓');
    expect(plain).toContain('[2/3 ✦');
    expect(plain).toContain('[3/3 ○');
    expect(plain).toContain('──');
  });

  it('renders a compact stepper on narrow viewports (< 50 cols) without wrapping', () => {
    const tasks = [
      { id: '1', title: 'Audit', status: 'completed' },
      { id: '2', title: 'Patch', status: 'running' },
    ];
    const out = renderTaskStepper(tasks, 35);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visibleLen(out)).toBeLessThanOrEqual(35);
    expect(plain).toContain('[1 ✓]');
    expect(plain).toContain('[2 ✦]');
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

  it('ellipsize truncates to budget and preserves ANSI color', () => {
    const out = ellipsize('abcdefghij', 5);
    expect(visibleLen(out)).toBe(5);
    expect(out.endsWith('…')).toBe(true);

    const colored = `\x1b[38;2;255;0;0m■■■■\x1b[0m long text that exceeds`;
    const truncated = ellipsize(colored, 10);
    expect(truncated).toContain('\x1b[38;2;255;0;0m■■■■');
    expect(visibleLen(truncated)).toBe(10);
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

  it('empty tracks are near-black, never theme-gray (the grey-bars defect)', () => {
    const empty = gradientContextBar(0, 100, 12, 0);
    // 12 empty cells, zero filled cells
    expect((empty.text.match(/░/g) ?? []).length).toBe(12);
    expect(empty.text).not.toContain('█');
    // No theme-gray fg on the track: grayDark (112,104,144) must be gone.
    expect(empty.text).not.toContain('38;2;112;104;144');
    // Fixed dim track instead (58,54,70 — near-black on dark canvases).
    expect(empty.text).toContain('38;2;58;54;70');
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

describe('thinking spinner (OpenCode braille spinner)', () => {
  it('includes braille loading dot beside Thinking without star clutter or bar sweep', () => {
    const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const a = thinkingLine(0);
    const b = thinkingLine(3);
    expect(a).not.toBe(b); // still animates
    expect(plain(a)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/); // braille loading dot
    expect(plain(a)).not.toMatch(/[✦★✶✷✸✹]/); // no celestial star clutter
    expect(a).toContain('Thinking');
    expect(plain(a)).not.toContain('━'); // no bar rail
    expect(plain(a)).not.toContain('❬');
    const noted = thinkingLine(2, 'running tests');
    expect(noted).toContain('Thinking');
    expect(noted).toContain('running tests');
    expect(plain(noted)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(plain(noted)).not.toMatch(/[✦★✶✷✸✹]/);
  });

  it('cycles braille dot frames with smooth theme coloring', () => {
    const s0 = spinnerColored(0);
    const s1 = spinnerColored(1);
    expect(s0).not.toBe(s1);
    expect(s0).toContain('⠋');
    expect(s1).toContain('⠙');
  });

  it('animates moving dots (. -> .. -> ...) with invariant 3-cell width', () => {
    expect(movingDots(0)).toBe('.  ');
    expect(movingDots(4)).toBe('.. ');
    expect(movingDots(8)).toBe('...');
    expect(movingDots(12)).toBe('.  ');
    expect(visibleLen(movingDots(0))).toBe(3);
    expect(visibleLen(movingDots(4))).toBe(3);
    expect(visibleLen(movingDots(8))).toBe(3);
  });

  it('maps tools to contextual verbs: Thinking, Searching, Working, and Done', () => {
    expect(resolveVerb('', '')).toBe('Thinking');
    expect(resolveVerb('think', '')).toBe('Thinking');
    expect(resolveVerb('search', '')).toBe('Searching');
    expect(resolveVerb('read', '')).toBe('Searching');
    expect(resolveVerb('glob', '')).toBe('Searching');
    expect(resolveVerb('web_search', '')).toBe('Searching');
    expect(resolveVerb('edit', '')).toBe('Working');
    expect(resolveVerb('write', '')).toBe('Working');
    expect(resolveVerb('shell', '')).toBe('Working');
    expect(resolveVerb('exec', '')).toBe('Working');
    expect(resolveVerb('verify', '')).toBe('Working');
  });

  it('renders contextual verbs and moving dots in thinkingLine', () => {
    const searching = thinkingLine(0, 'src/tui/view.ts', '1.2s', 'Searching');
    expect(searching).toContain('Searching');
    expect(searching).toContain('.  ');
    expect(searching).toContain('src/tui/view.ts');

    const working = thinkingLine(4, 'compile', '2.5s', 'Working');
    expect(working).toContain('Working');
    expect(working).toContain('.. ');

    const done = thinkingLine(8, '', '3.1s', 'Done');
    expect(done).toContain('Done');
    expect(done).toContain('✓');
    expect(done).not.toContain('esc to cancel');
  });

  it('renders doneLine with green checkmark and duration', () => {
    const d = doneLine('4.2s');
    expect(d).toContain('Done');
    expect(d).toContain('✓');
    expect(d).toContain('4.2s');
  });
});

describe('splash screen', () => {
  it('renders MOCHI ascii art + version', () => {
    const f = splashFrame(3, 100, '0.10.2');
    const plain = f.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('█▀▄▀█');   // M block letters
    expect(plain).toContain('█▀▀█');
    expect(plain).toContain('▀▀▀▀');
    expect(plain).toContain('mochi v0.10.2');
  });

  it('shows loading phases and percent', () => {
    const f = splashFrame(3, 100, '1.0.0', 0.5);
    const plain = f.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('50%');
    expect(plain).toMatch(/warming|skills|indexing|connecting/);
  });

  it('loading bar fills with progress', () => {
    const barFilled = (p: number) => {
      const row = splashFrame(0, 100, '1.0.0', p).find((r) => r.includes('━')) ?? '';
      return (row.match(/━/g) || []).length;
    };
    expect(barFilled(0.95)).toBeGreaterThan(barFilled(0.1));
    expect(barFilled(1)).toBeGreaterThan(barFilled(0.5));
  });

  it('animates between ticks', () => {
    const a = splashFrame(2, 100, '1.0.0');
    const b = splashFrame(6, 100, '1.0.0');
    expect(a.join('|')).not.toBe(b.join('|'));
  });

  it('phase list ends at The Dongo is ready', () => {
    expect(SPLASH_PHASES[SPLASH_PHASES.length - 1]).toBe('The Dongo is ready');
  });
});

describe('farewell screen', () => {
  const base = {
    version: '0.23.1',
    sessionId: 'abc12345',
    tokens: 12345,
    costUsd: 0.42,
    durationMs: 125000,
    uiMode: 'act' as const,
    safetyMode: 'ask',
    uncensored: false,
  };
  it('renders logo + session id + stats', () => {
    const f = farewellFrame(base, 100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(f).toContain('█▀▄▀█');
    expect(f).toContain('session abc12345');
    expect(f).toContain('12.3k tokens');
    expect(f).toContain('$0.42');
    expect(f).toContain('2m05s');
    expect(f).toContain('mochi resume');
  });

  it('shows UNCENSORED admin badge when privileged', () => {
    const f = farewellFrame({ ...base, uncensored: true, safetyMode: 'uncensored' }, 100)
      .join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(f).toContain('UNCENSORED');
    expect(f).toContain('admin');
  });

  it('shows plain safety mode otherwise', () => {
    const f = farewellFrame(base, 100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(f).toContain('safety: ask');
    expect(f).not.toContain('UNCENSORED');
  });

  it('formats durations', () => {
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(125000)).toBe('2m05s');
    expect(formatDuration(3700000)).toBe('1h01m');
  });
});

describe('color coordination', () => {
  beforeEach(() => {
    setTheme('cyber-void');
  });

  it('edit tools use R.toolWriteName and read tools use R.toolReadName', () => {
    // Cyber Void's roleColors map write=hot-pink, read=cyan — distinct
    // colors that match the theme's intent. The compact card rows carry
    // these colors on the tool-name token.
    const edit = formatToolInvocationCard('write', { path: 'a.ts', content: 'x' });
    expect(edit).toContain(R.toolWriteName);
    const read = formatToolInvocationCard('read', { path: 'a.ts' });
    expect(read).toContain(R.toolReadName);
  });

  it('errors are bold red with [ERR]', () => {
    const err = renderEntry({ kind: 'error', text: 'boom' });
    expect(err[0]).toContain('[ERR]');
    expect(err[0]).toContain(T.error);
  });
});

describe('highlightShellCommand', () => {
  it('highlights binary, subcommands, flags, and paths', () => {
    const hl = highlightShellCommand('cargo build --release src/main.rs');
    expect(hl).toContain('cargo');
    expect(hl).toContain('build');
    expect(hl).toContain('--release');
    expect(hl).toContain('src/main.rs');
  });

  it('handles chained commands with && and |', () => {
    const hl = highlightShellCommand('git status && npm test');
    expect(hl).toContain('&&');
    expect(hl).toContain('npm');
  });
});

describe('renderMetricGauge', () => {
  it('renders a progress bar with percentage and token values', () => {
    const gauge = renderMetricGauge('Tokens', 4000, 8000, 'tok', 10);
    const plain = gauge.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Tokens:');
    expect(plain).toContain('50%');
    expect(plain).toContain('4.0k/8.0k tok');
  });
  it('paints the empty track near-black, never theme-gray', () => {
    const gauge = renderMetricGauge('Tokens', 0, 8000, 'tok', 10);
    // 10 empty cells, zero filled cells
    expect((gauge.match(/░/g) ?? []).length).toBe(10);
    expect(gauge).not.toContain('█');
    expect(gauge).toContain('38;2;58;54;70');
    expect(gauge).not.toContain('38;2;112;104;144');
  });
});

describe('renderMarkdown', () => {
  it('strips the ## sigil so headings do not print it literally', () => {
    const rows = m.renderMarkdown('## Next steps\n\nJust tell me what you need.');
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(plain.some((l) => l.includes('Next steps'))).toBe(true);
    // The literal "## Next steps" must NOT appear (the sigil is stripped).
    expect(plain.every((l) => !l.includes('## Next steps'))).toBe(true);
  });

  it('renders bullets as cyan • glyphs and keeps ordered lists numbered', () => {
    const rows = m.renderMarkdown('- one\n- two\n\n1. first\n2. second\n\n```ts\nconst x = 1;\n```\n');
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));
    // Unordered bullets get the cyan • glyph on the 2-space grid (distinct
    // from ordered lists — the old all-numbers look was confusing).
    expect(plain.some((l) => l.trimStart().startsWith('• one'))).toBe(true);
    expect(plain.some((l) => l.trimStart().startsWith('• two'))).toBe(true);
    // Ordered lists keep orange numbers on the same grid.
    expect(plain.some((l) => l.trimStart().startsWith('1. first'))).toBe(true);
    expect(plain.some((l) => l.trimStart().startsWith('2. second'))).toBe(true);
    // Nested bullet indents one level deeper.
    const nested = m.renderMarkdown('- a\n  - b\n', 80).map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));
    const aRow = nested.find((l) => l.includes('a'));
    const bRow = nested.find((l) => l.includes('b'));
    expect((bRow?.indexOf('•') ?? 99)).toBeGreaterThan((aRow?.indexOf('•') ?? 0));
  });

  it('wraps long paragraphs with hanging indents and no overflow', () => {
    const rows = m.renderMarkdown('- one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 50);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));
    // First row carries the marker; the continuation aligns under the text
    // (2-space hang past the marker column), and no row exceeds the width.
    for (const l of plain) expect([...l].length).toBeLessThanOrEqual(50);
    const cont = plain[1] ?? '';
    expect(cont).not.toBe('');
    expect(cont.startsWith('    ')).toBe(true); // 2 (indent) + 2 (hang)
  });

  it('renders links as clean label → url (no raw [..](..) sigils)', () => {
    const rows = m.renderMarkdown('See [the docs](https://example.com/rfc) for details.', 80);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('the docs → https://example.com/rfc');
    expect(plain).not.toContain('[the docs](https://example.com/rfc)');
  });

  it('renders blockquotes with a left bar on every line', () => {
    const rows = m.renderMarkdown('> caution line\n', 80);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('│');
    expect(plain).toContain('caution line');
  });

  it('collapses blank lines (clean single blank between paragraphs, no double blanks)', () => {
    const rows = m.renderMarkdown('Para one.\n\n\n\nPara two.');
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));
    // Exactly one empty row between paragraphs — clean readable spacing, no double blanks.
    const blanks = plain.filter((l) => l.trim() === '').length;
    expect(blanks).toBe(1);
    expect(plain.join('\n')).toContain('Para one.');
    expect(plain.join('\n')).toContain('Para two.');
  });

  it('renders markdown tables inside a Cline-style boxed matrix with borders', () => {
    const tableMd = [
      '| Project | Port | Service |',
      '|---|---|---|',
      '| Terminus | 9120 | terminus.service |',
      '| Hermes Dashboard | 9119 | hermes-dashboard.service |',
      '| Clash Royale | 9125 | clash-webui.service |',
    ].join('\n');

    const rows = m.renderMarkdown(tableMd, 80);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));

    // Top border contains box drawing characters
    expect(plain.some((l) => l.startsWith('┌') && l.endsWith('┐') && l.includes('┬'))).toBe(true);
    // Header row contains column names
    expect(plain.some((l) => l.includes('Project') && l.includes('Port') && l.includes('Service'))).toBe(true);
    // Separator line contains cross branches
    expect(plain.some((l) => l.startsWith('├') && l.endsWith('┤') && l.includes('┼'))).toBe(true);
    // Body rows contain data
    expect(plain.some((l) => l.includes('Terminus') && l.includes('9120'))).toBe(true);
    expect(plain.some((l) => l.includes('Hermes Dashboard') && l.includes('9119'))).toBe(true);
    // Bottom border closes the box
    expect(plain.some((l) => l.startsWith('└') && l.endsWith('┘') && l.includes('┴'))).toBe(true);

    // Invariant: no row exceeds given width
    for (const r of plain) {
      expect([...r].length).toBeLessThanOrEqual(80);
    }
  });

  it('preserves clean vertical spacing between paragraphs and tables', () => {
    const md = [
      'Here is the status:',
      '',
      '| Name | Status |',
      '|---|---|',
      '| worker | ok |',
      '',
      'All systems operational.',
    ].join('\n');

    const rows = m.renderMarkdown(md, 80);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));

    expect(plain[0]).toBe('Here is the status:');
    expect(plain[1]).toBe('');
    expect(plain[2].startsWith('┌')).toBe(true);
    expect(plain[plain.length - 1]).toBe('All systems operational.');
  });

  it('renders styled code block header with language and file pills', () => {
    const md = '```typescript:src/tui/view.ts\nconst x = 1;\n```';
    const rows = renderMarkdown(md, 80);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('✦ src/tui/view.ts · typescript');
  });
});

describe('renderMarkdown tables with status emoji (border-alignment guard)', () => {
  it('keeps every border row the same visible width when cells contain ✅/❌/⭐', () => {
    const md = [
      '| Gateway | Transport | Status |',
      '|---|---|---|',
      '| Discord | Zero-dependency Gateway v10 WebSocket | ✅ Live bot |',
      '| Telegram | Plain HTTP long-poll (getUpdates/sendMessage) | ✅ Live bot |',
      '| Slack | Polling plus Events API webhook server | ❌ Not configured |',
    ].join('\n');
    const rows = m.renderMarkdown(md, 100);
    const widths = rows.map((r) => visibleLen(r));
    // All rows (borders + content) share one width: no jagged right edge.
    expect(new Set(widths).size).toBe(1);
    // And that width fits the terminal.
    for (const w of widths) expect(w).toBeLessThanOrEqual(100);
  });

  it('aligns borders when cells mix CJK, emoji, and inline code', () => {
    const md = [
      '| Name | Note |',
      '|---|---|',
      '| 日本語テスト | `code` and ⭐ stars |',
      '| plain | ✅ done ❌ pending |',
    ].join('\n');
    const rows = m.renderMarkdown(md, 80);
    const widths = rows.map((r) => visibleLen(r));
    expect(new Set(widths).size).toBe(1);
  });
});

describe('composer box alignment', () => {
  it('starts continuation text at the same column as the first row', () => {
    const first = composerRow('hello world this is long', 40, true);
    const cont = composerRow('continuation row here', 40, false);
    const b1 = stripAnsi(first);
    const b2 = stripAnsi(cont);
    // Text starts at column 4 on both rows (│ + space + 2-cell prompt).
    expect(b1.indexOf('hello')).toBe(4);
    expect(b2.indexOf('continuation')).toBe(4);
    // Box stays square.
    expect(visibleLen(first)).toBe(40);
    expect(visibleLen(cont)).toBe(40);
  });

  it('strips CR from table cells', () => {
    expect(parseTableCells('| a\r | b\r\n |')).toEqual(['a', 'b']);
  });
});

describe('renderMarkdown adversarial sweep (nested-escape + overflow guard)', () => {
  // Permanent pin for the codeblock highlighter shred bug: 7 sequential
  // passes re-matched digits inside escapes emitted by earlier passes,
  // orphaning `\x1b[` and printing SGR params as text. The single-pass
  // tokenizer must never nest escapes, at any width.
  const ADVERSARIAL = [
    '✅❌⭐✨❤️🎉🔥💡📌📁🚀 status soup here',
    '日本語テスト mixed CJK and emoji ✅ together now',
    'tabs\there\tand\there',
    'a'.repeat(200),
    '\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m ANSI pasted',
    '`code with tick` and **bold** and *italic*',
    '> quote level one\n>> nested quote',
    '- item one\n  - nested two\n    - nested three',
    '1. first\n2. second\n3. third',
    '| a | b |\n|---|---|\n| x ✅ | y |\n| z | w ❌ |',
    '```ts\nconst x = 123;\nlet s = "hi";\n```',
    '# Big heading here\n\nSome paragraph text that wraps around a bit here.',
    '👨‍👩‍👧‍👦 family ZWJ sequence test here',
    '1️⃣ keycap sequence here now',
    '[label](https://example.com) link here',
  ];
  for (const W of [26, 40, 80, 110]) {
    it(`no nested escapes and no overflow at width ${W}`, () => {
      for (const text of ADVERSARIAL) {
        const rows = m.renderMarkdown(text, W);
        for (const r of rows) {
          expect(r, `nested ESC in ${JSON.stringify(text.slice(0, 40))}`).not.toMatch(/\x1b\[[0-9;?]*\x1b/);
          expect(visibleLen(r), `overflow in ${JSON.stringify(text.slice(0, 40))}`).toBeLessThanOrEqual(W);
        }
      }
    });
  }

  it('highlights code without shredding its own escapes', () => {
    const rows = m.renderMarkdown('```ts\nconst total = price * 1.2; // sum\n```', 60);
    const plain = rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('const total = price * 1.2; // sum');
    // No SGR parameters leak as text.
    expect(plain).not.toMatch(/\b38;2;\d/);
  });
});

describe('dropdown narrow-width guard', () => {
  it('never overflows at any width down to 10, with emoji/CJK/long hints', () => {
    const items = [
      { name: 'alpha ✅', hint: 'run things here' },
      { name: '日本語 beta gamma delta', hint: 'x'.repeat(100) },
      { name: 'c', hint: 'short' },
    ];
    for (const W of [10, 12, 16, 20, 26, 40, 80]) {
      for (const r of renderDropdown(items, 1, W)) {
        expect(visibleLen(r), `dropdown overflow at width ${W}`).toBeLessThanOrEqual(W);
      }
    }
  });

  it('ellipsize with zero budget emits nothing (no phantom ellipsis)', () => {
    expect(ellipsize('hello', 0)).toBe('');
    expect(ellipsize('hello', -3)).toBe('');
    expect(ellipsize('', 0)).toBe('');
  });
});
