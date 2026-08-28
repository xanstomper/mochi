// Native tool: tui_builder
// Returns terminal UI components as ANSI-formatted strings.

import type { Tool } from './types.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Box-drawing characters
const BOX = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  round:  { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
};

// ANSI colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
};

function progressBar(current: number, total: number, width = 30, label = '', color = 'green'): string {
  const pct = Math.min(1, current / total);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = (C[color as keyof typeof C] || C.green) + '█'.repeat(filled) + C.reset + '░'.repeat(empty);
  return `${label ? label + ' ' : ''}[${bar}] ${Math.round(pct * 100)}% (${current}/${total})`;
}

function table(headers: string[], rows: string[][], style: 'simple' | 'box' | 'minimal' = 'box'): string {
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] || '').length)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

  if (style === 'minimal') {
    const head = headers.map((h, i) => pad(h, colWidths[i])).join('  ');
    const sep = colWidths.map(w => '─'.repeat(w)).join('  ');
    const body = rows.map(r => r.map((c, i) => pad(c || '', colWidths[i])).join('  ')).join('\n');
    return `${C.bold}${head}${C.reset}\n${C.gray}${sep}${C.reset}\n${body}`;
  }

  if (style === 'simple') {
    const head = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
    const sep = '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |';
    const body = rows.map(r => '| ' + r.map((c, i) => pad(c || '', colWidths[i])).join(' | ') + ' |').join('\n');
    return [head, sep, body].join('\n');
  }

  // box style
  const b = BOX.single;
  const totalWidth = colWidths.reduce((s, w) => s + w + 3, 1);
  const hline = (l: string, m: string, r: string) => l + b.h.repeat(totalWidth - 2) + r;
  const row = (cells: string[]) => b.v + ' ' + cells.map((c, i) => pad(c, colWidths[i])).join(' ' + b.v + ' ') + ' ' + b.v;

  return [
    hline(b.tl, b.h, b.tr),
    row(headers.map(h => `${C.bold}${h}${C.reset}`)),
    hline('├', '┼', '┤'),
    ...rows.map(r => row(r.map(c => c || ''))),
    hline(b.bl, b.h, b.br),
  ].join('\n');
}

function spinner(frame = 0, label = ''): string {
  return `${C.cyan}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${C.reset} ${label}`;
}

function box(content: string, title = '', style: 'single' | 'double' | 'round' = 'round', color = 'cyan'): string {
  const b = BOX[style];
  const cc = C[color as keyof typeof C] || C.cyan;
  const lines = content.split('\n');
  const innerWidth = Math.max(title.length, ...lines.map(l => l.length)) + 2;
  const top = cc + b.tl + (title ? ` ${title} ` + b.h.repeat(innerWidth - title.length - 1) : b.h.repeat(innerWidth)) + b.tr + C.reset;
  const bottom = cc + b.bl + b.h.repeat(innerWidth) + b.br + C.reset;
  const rows = lines.map(l => cc + b.v + C.reset + ` ${l}${' '.repeat(Math.max(0, innerWidth - l.length - 1))}` + cc + b.v + C.reset);
  return [top, ...rows, bottom].join('\n');
}

function menu(items: string[], selected = 0): string {
  return items.map((item, i) =>
    i === selected
      ? `${C.cyan}❯${C.reset} ${C.bold}${item}${C.reset}`
      : `  ${C.dim}${item}${C.reset}`
  ).join('\n');
}

function banner(text: string): string {
  const line = '═'.repeat(text.length + 4);
  return `${C.cyan}╔${line}╗\n║  ${C.bold}${text}${C.reset}${C.cyan}  ║\n╚${line}╝${C.reset}`;
}

export const tuiBuilderTool: Tool = {
  def: {
    name: 'tui_builder',
    description: 'Generate terminal UI components: progress-bar, table, spinner, box, banner, menu — as ANSI-formatted strings.',
    parameters: [
      { name: 'component', type: 'string', description: "'progress-bar' | 'table' | 'spinner' | 'box' | 'banner' | 'menu'", required: true },
      { name: 'options', type: 'string', description: 'JSON-encoded component options object', required: false },
    ],
    permission: 'read',
  },
  async execute(args) {
    const component = String(args.component || '').toLowerCase();
    let opts: Record<string, unknown> = {};
    if (args.options != null && typeof args.options === 'object') {
      opts = args.options as Record<string, unknown>;
    } else if (typeof args.options === 'string' && args.options.trim()) {
      try { opts = JSON.parse(args.options) as Record<string, unknown>; } catch { opts = {}; }
    }

    switch (component) {
      case 'progress-bar':
        return progressBar(Number(opts.current ?? 0), Number(opts.total ?? 100), Number(opts.width ?? 30), String(opts.label ?? ''), String(opts.color ?? 'green'));
      case 'table':
        return table(opts.headers as string[] ?? [], opts.rows as string[][] ?? [], (opts.style ?? 'box') as 'simple' | 'box' | 'minimal');
      case 'spinner':
        return spinner(Number(opts.frame ?? 0), String(opts.label ?? ''));
      case 'box':
        return box(String(opts.content ?? ''), String(opts.title ?? ''), (opts.style ?? 'round') as 'single' | 'double' | 'round', String(opts.color ?? 'cyan'));
      case 'banner':
        return banner(String(opts.text ?? 'MOCHI'));
      case 'menu':
        return menu(opts.items as string[] ?? [], Number(opts.selected ?? 0));
      default:
        throw new Error(`Unknown component: ${component}. Use: progress-bar, table, spinner, box, banner, menu.`);
    }
  },
};
