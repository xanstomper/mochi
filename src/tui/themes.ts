// 20 unique, handcrafted color themes for Mochi TUI.
// Each theme provides distinct foregrounds, accents, rule borders,
// background highlights, and splash gradient stops.
//
// Color strategy (two layers):
//   1. PALETTE TOKENS — the raw hex slots (act, plan, error, pink, cyan, ...).
//      Themes assign values; used by generic surfaces (status bar, gradient
//      bars, splash, autocomplete borders) where only "do these harmonize"
//      matters.
//   2. ROLE COLORS — semantic roles (assistantGutter, toolWriteName, ...).
//      Defaults are derived from palette tokens so themes that only customize
//      the palette still look correct. Themes can OPTIONALLY provide a
//      `roleColors` override to remap roles to specific hex values when the
//      palette alone doesn't produce the look they want (e.g. Tokyo Night
//      wants tool names to be yellow, not the default cyan). This is what
//      makes each theme genuinely distinct rather than the same rainbow.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface ThemeColors {
  act: string;
  /** Selection-bar background for menus/dropdowns (opencode-style filled row). */
  actBg: string;
  /** Foreground to pair with actBg (readable on the accent background). */
  bgText: string;
  plan: string;
  success: string;
  error: string;
  warning: string;
  gray: string;
  grayDark: string;
  fg: string;
  bgUser: string;
  rule: string;
  pink: string;
  magenta: string;
  violet: string;
  cyan: string;
  lime: string;
  orange: string;
  teal: string;
}

/** Semantic role colors. Each role is the visual marker for one logical
 *  thing in the UI (a transcript line kind, a code token class, a tool verb
 *  group, a chrome element). Themes MAY provide a partial override — any
 *  field left undefined falls back to a sensible palette-token default. */
export interface RoleColors {
  // Transcript gutter markers
  assistantGutter: string;     // ▌ on every assistant line  (default: cyan)
  assistantText: string;       // assistant body text color  (default: fg)
  toolMarker: string;          // ▷ on tool lines            (default: lime)
  userGutter: string;          // ❯ on user lines            (default: magenta)
  userFg: string;              // user message text color    (default: fg)
  userBg: string;              // user message bg highlight  (default: bgUser)
  thoughtGutter: string;       // ◇ on thought lines         (default: grayDark)
  thoughtText: string;         // thought body text color    (default: gray)
  errorMark: string;           // ! on error lines           (default: error)
  errorText: string;           // error body text color      (default: error)
  systemMark: string;          // ◆ on system lines          (default: grayDark)
  systemText: string;          // system body text color     (default: gray)
  taskMark: string;            // ★ on task lines            (default: cyan)
  taskText: string;            // task body text color       (default: fg)
  goalMark: string;            // ◉ on goal lines            (default: pink)
  goalText: string;            // goal body text color       (default: fg)

  // Code syntax highlight (markdown code fences + shell output)
  codeKeyword: string;         // const/let/return/if/...     (default: magenta)
  codeString: string;          // string literals             (default: lime)
  codeNumber: string;          // numbers, true/false/null    (default: orange)
  codeComment: string;         // // and /* */ comments       (default: gray)
  codePunct: string;           // ; , { } ( ) brackets        (default: teal)
  codeType: string;            // type names / capitalized    (default: violet)
  codeFn: string;              // function names              (default: cyan)

  // Markdown
  mdHeading: string;           // # ## ### prefix color       (default: pink)
  mdBold: string;              // **bold**                    (default: fg)
  mdItalic: string;            // *italic*                    (default: fg)
  mdLink: string;              // [text](url)                 (default: cyan)

  // Chrome / chrome-adjacent
  thinkingLabel: string;       // "Thinking…" word            (default: cyan)
  reasoningBadge: string;      // [REASON: HIGH] badge        (default: cyan)
  reasonBadge: { low: string; medium: string; high: string; max: string };
  toolWriteName: string;       // write/edit/delete/patch     (default: violet)
  toolReadName: string;        // read/search/glob/...        (default: cyan)
  toolShellName: string;       // shell/git                   (default: orange)
  toolTestName: string;        // test/verify                 (default: lime)
  toolGenericName: string;     // default fallback            (default: violet)

  // Context bar / progress (overrides gradient when set)
  contextLow: string;          // 0–60% usage                 (default: lime)
  contextMid: string;          // 60–85%                      (default: orange)
  contextHigh: string;         // 85%+                        (default: error)
}

export interface MochiTheme {
  id: string;
  name: string;
  description: string;
  colors: ThemeColors;
  /** Optional per-role override. Any field undefined falls back to a
   *  sensible palette-token default so themes can opt-in to fine control. */
  roleColors?: Partial<RoleColors>;
  splashStops: Array<[number, number, number]>;
}

/** Nearest xterm-256 index for an RGB triple. */
function rgbTo256(r: number, g: number, b: number): number {
  const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  const cr = cube(r), cg = cube(g), cb = cube(b);
  const cubeIdx = 16 + 36 * cr + 6 * cg + cb;
  const gray = Math.round((r + g + b) / 3);
  const grayIdx = gray < 8 ? 16 : gray > 248 ? 231 : Math.round((gray - 8) / 247 * 24) + 232;
  const cubeRgb = (i: number): [number, number, number] => {
    const c = Math.floor((i - 16) / 36), rem = (i - 16) % 36;
    const g2 = Math.floor(rem / 6), b2 = rem % 6;
    const comp = (x: number) => x === 0 ? 0 : x === 1 ? 95 : 95 + 40 * (x - 1);
    return [comp(c), comp(g2), comp(b2)];
  };
  const dist = (a: [number, number, number]) => (a[0]-r)**2 + (a[1]-g)**2 + (a[2]-b)**2;
  const cubeDist = dist(cubeRgb(cubeIdx));
  const grayDist = (gray - r)**2 + (gray - g)**2 + (gray - b)**2;
  return grayDist < cubeDist ? grayIdx : cubeIdx;
}

/** Rewrite a color string's 24-bit codes as 256-color codes. */
function downgradeColorCodes(s: string): string {
  return s.replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (_m, r: string, g: string, b: string) =>
    `\x1b[38;5;${rgbTo256(Number(r), Number(g), Number(b))}m`);
}

/** True when the terminal advertises 24-bit color support. */
export function supportsTruecolor(): boolean {
  const ct = (process.env.COLORTERM ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return true;
  const term = (process.env.TERM ?? '').toLowerCase();
  return term.includes('truecolor') || term.includes('24bit');
}

/** Downgrade all theme colors to xterm-256 when the terminal lacks truecolor
 *  support so semantic colors still render instead of being stripped/ignored. */
export function adaptThemeColors(t: MochiTheme): MochiTheme {
  if (supportsTruecolor()) return t;
  const downgradeEntries = (obj: Record<string, unknown>) => Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? downgradeColorCodes(v) : v]),
  );
  return {
    ...t,
    colors: downgradeEntries(t.colors as unknown as Record<string, unknown>) as unknown as ThemeColors,
    roleColors: t.roleColors
      ? (downgradeEntries(t.roleColors as unknown as Record<string, unknown>) as Partial<RoleColors>)
      : undefined,
  };
}

export const THEMES: MochiTheme[] = [
  {
    id: 'cyber-void',
    name: 'Cyber Void',
    description: 'Deep neon void — electric cyan, hot pink, lime; the default mochi look',
    colors: {
      act: '\x1b[38;2;0;255;255m',
      actBg: '\x1b[48;2;0;64;64m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;255;255;0m',
      success: '\x1b[38;2;57;255;20m',
      error: '\x1b[38;2;255;0;127m',
      warning: '\x1b[38;2;255;105;180m',
      gray: '\x1b[38;2;128;128;128m',
      grayDark: '\x1b[38;2;64;64;64m',
      fg: '\x1b[38;2;230;230;250m',
      bgUser: '\x1b[48;2;15;5;30m',
      rule: '\x1b[38;2;255;0;255m',
      pink: '\x1b[38;2;255;20;147m',
      magenta: '\x1b[38;2;255;0;255m',
      violet: '\x1b[38;2;138;43;226m',
      cyan: '\x1b[38;2;0;255;255m',
      lime: '\x1b[38;2;57;255;20m',
      orange: '\x1b[38;2;255;69;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;0;255;255m',
      toolMarker: '\x1b[38;2;191;255;0m',
      toolWriteName: '\x1b[38;2;255;20;147m',
      toolTestName: '\x1b[38;2;191;255;0m',
      mdHeading: '\x1b[38;2;255;0;255m',
    },
    splashStops: [
      [0, 255, 255], [255, 0, 255], [57, 255, 20], [255, 20, 147], [138, 43, 226],
    ],
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    description: '80s sunset — teal, magenta, peach, lavender, soft cream',
    colors: {
      act: '\x1b[38;2;0;255;204m',
      actBg: '\x1b[48;2;0;64;51m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;255;182;193m',
      success: '\x1b[38;2;152;251;152m',
      error: '\x1b[38;2;255;105;180m',
      warning: '\x1b[38;2;255;160;122m',
      gray: '\x1b[38;2;180;170;200m',
      grayDark: '\x1b[38;2;120;110;140m',
      fg: '\x1b[38;2;252;240;248m',
      bgUser: '\x1b[48;2;50;30;70m',
      rule: '\x1b[38;2;255;0;255m',
      pink: '\x1b[38;2;255;192;203m',
      magenta: '\x1b[38;2;255;0;255m',
      violet: '\x1b[38;2;216;191;216m',
      cyan: '\x1b[38;2;0;255;204m',
      lime: '\x1b[38;2;144;238;144m',
      orange: '\x1b[38;2;255;160;122m',
      teal: '\x1b[38;2;32;178;170m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;216;191;216m',
      userGutter: '\x1b[38;2;255;0;255m',
      toolMarker: '\x1b[38;2;255;182;193m',
      codeKeyword: '\x1b[38;2;255;105;180m',
      codeString: '\x1b[38;2;255;215;0m',
      mdHeading: '\x1b[38;2;0;255;204m',
    },
    splashStops: [
      [0, 255, 204], [255, 0, 255], [255, 182, 193], [216, 191, 216], [255, 160, 122],
    ],
  },
  {
    id: 'solar-flare',
    name: 'Solar Flare',
    description: 'Burning sun on black — intense orange, sunburst yellow, crimson',
    colors: {
      act: '\x1b[38;2;255;215;0m',
      actBg: '\x1b[48;2;64;54;0m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;255;140;0m',
      success: '\x1b[38;2;255;255;0m',
      error: '\x1b[38;2;255;69;0m',
      warning: '\x1b[38;2;255;99;71m',
      gray: '\x1b[38;2;180;130;80m',
      grayDark: '\x1b[38;2;120;80;40m',
      fg: '\x1b[38;2;255;245;225m',
      bgUser: '\x1b[48;2;40;15;0m',
      rule: '\x1b[38;2;255;140;0m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;220;20;60m',
      violet: '\x1b[38;2;186;85;211m',
      cyan: '\x1b[38;2;0;206;209m',
      lime: '\x1b[38;2;255;215;0m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;255;140;0m',
      userGutter: '\x1b[38;2;255;215;0m',
      toolMarker: '\x1b[38;2;255;255;0m',
      toolWriteName: '\x1b[38;2;255;69;0m',
      toolShellName: '\x1b[38;2;255;140;0m',
      codeKeyword: '\x1b[38;2;255;69;0m',
      mdHeading: '\x1b[38;2;255;215;0m',
    },
    splashStops: [
      [255, 69, 0], [255, 140, 0], [255, 215, 0], [255, 255, 0], [220, 20, 60],
    ],
  },
  {
    id: 'deep-sea',
    name: 'Deep Sea',
    description: 'Bioluminescent coral — aqua, sea green, salmon glow on midnight blue',
    colors: {
      act: '\x1b[38;2;0;255;255m',
      actBg: '\x1b[48;2;0;64;64m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;64;224;208m',
      success: '\x1b[38;2;46;139;87m',
      error: '\x1b[38;2;255;127;80m',
      warning: '\x1b[38;2;255;160;122m',
      gray: '\x1b[38;2;140;170;200m',
      grayDark: '\x1b[38;2;80;110;140m',
      fg: '\x1b[38;2;240;255;255m',
      bgUser: '\x1b[48;2;0;15;40m',
      rule: '\x1b[38;2;0;206;209m',
      pink: '\x1b[38;2;255;182;193m',
      magenta: '\x1b[38;2;186;85;211m',
      violet: '\x1b[38;2;138;43;226m',
      cyan: '\x1b[38;2;0;255;255m',
      lime: '\x1b[38;2;127;255;212m',
      orange: '\x1b[38;2;255;160;122m',
      teal: '\x1b[38;2;32;178;170m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;32;178;170m',
      userGutter: '\x1b[38;2;186;85;211m',
      toolMarker: '\x1b[38;2;127;255;212m',
      toolWriteName: '\x1b[38;2;255;127;80m',
      codeKeyword: '\x1b[38;2;64;224;208m',
      codeString: '\x1b[38;2;255;215;0m',
      mdHeading: '\x1b[38;2;0;255;255m',
    },
    splashStops: [
      [0, 255, 255], [32, 178, 170], [127, 255, 212], [186, 85, 211], [255, 127, 80],
    ],
  },
  {
    id: 'autumn-leaves',
    name: 'Autumn Leaves',
    description: 'Falling maple — burnt sienna, goldenrod, olive, plum, warm cream',
    colors: {
      act: '\x1b[38;2;218;165;32m',
      actBg: '\x1b[48;2;55;41;8m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;205;133;63m',
      success: '\x1b[38;2;107;142;35m',
      error: '\x1b[38;2;178;34;34m',
      warning: '\x1b[38;2;255;140;0m',
      gray: '\x1b[38;2;160;140;110m',
      grayDark: '\x1b[38;2;100;85;65m',
      fg: '\x1b[38;2;255;245;220m',
      bgUser: '\x1b[48;2;45;25;15m',
      rule: '\x1b[38;2;160;82;45m',
      pink: '\x1b[38;2;219;112;147m',
      magenta: '\x1b[38;2;199;21;133m',
      violet: '\x1b[38;2;139;0;139m',
      cyan: '\x1b[38;2;72;209;204m',
      lime: '\x1b[38;2;154;205;50m',
      orange: '\x1b[38;2;255;69;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;210;105;30m',
      userGutter: '\x1b[38;2;199;21;133m',
      toolMarker: '\x1b[38;2;154;205;50m',
      toolWriteName: '\x1b[38;2;178;34;34m',
      codeKeyword: '\x1b[38;2;199;21;133m',
      codeString: '\x1b[38;2;107;142;35m',
      mdHeading: '\x1b[38;2;160;82;45m',
    },
    splashStops: [
      [218, 165, 32], [255, 140, 0], [178, 34, 34], [107, 142, 35], [205, 133, 63],
    ],
  },
  {
    id: 'retro-arcade',
    name: 'Retro Arcade',
    description: 'Pacman fever — true black with primary yellow, red, cyan, lime',
    colors: {
      act: '\x1b[38;2;255;255;0m',
      actBg: '\x1b[48;2;64;64;0m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;0;255;255m',
      success: '\x1b[38;2;57;255;20m',
      error: '\x1b[38;2;255;0;0m',
      warning: '\x1b[38;2;255;165;0m',
      gray: '\x1b[38;2;160;160;160m',
      grayDark: '\x1b[38;2;90;90;90m',
      fg: '\x1b[38;2;255;255;255m',
      bgUser: '\x1b[48;2;0;0;0m',
      rule: '\x1b[38;2;0;0;255m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;255;0;255m',
      violet: '\x1b[38;2;138;43;226m',
      cyan: '\x1b[38;2;0;255;255m',
      lime: '\x1b[38;2;57;255;20m',
      orange: '\x1b[38;2;255;165;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;57;255;20m', // lime (pacman green)
      userGutter: '\x1b[38;2;255;255;0m',
      toolMarker: '\x1b[38;2;57;255;20m',
      toolWriteName: '\x1b[38;2;255;0;255m',
      codeKeyword: '\x1b[38;2;255;0;0m',
      codeString: '\x1b[38;2;57;255;20m',
      mdHeading: '\x1b[38;2;255;255;0m',
    },
    splashStops: [
      [255, 255, 0], [255, 0, 0], [0, 255, 255], [57, 255, 20], [255, 165, 0],
    ],
  },
  {
    id: 'cotton-candy',
    name: 'Cotton Candy',
    description: 'Pastel dreams — sky blue, blush pink, mint, lavender on warm cream',
    colors: {
      act: '\x1b[38;2;135;206;235m',
      actBg: '\x1b[48;2;34;52;59m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;255;182;193m',
      success: '\x1b[38;2;152;251;152m',
      error: '\x1b[38;2;255;99;71m',
      warning: '\x1b[38;2;255;218;185m',
      gray: '\x1b[38;2;190;180;200m',
      grayDark: '\x1b[38;2;150;140;160m',
      fg: '\x1b[38;2;60;50;70m',
      bgUser: '\x1b[48;2;240;220;240m',
      rule: '\x1b[38;2;216;191;216m',
      pink: '\x1b[38;2;255;192;203m',
      magenta: '\x1b[38;2;255;105;180m',
      violet: '\x1b[38;2;221;160;221m',
      cyan: '\x1b[38;2;135;206;250m',
      lime: '\x1b[38;2;144;238;144m',
      orange: '\x1b[38;2;255;160;122m',
      teal: '\x1b[38;2;64;224;208m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;221;160;221m',
      userGutter: '\x1b[38;2;255;105;180m',
      userBg: '\x1b[48;2;245;225;240m',
      userFg: '\x1b[38;2;80;50;90m',
      toolMarker: '\x1b[38;2;64;224;208m',
      codeKeyword: '\x1b[38;2;255;105;180m',
      codeString: '\x1b[38;2;152;251;152m',
      mdHeading: '\x1b[38;2;255;182;193m',
      thoughtText: '\x1b[38;2;150;140;160m',
      errorMark: '\x1b[38;2;220;20;60m',
      errorText: '\x1b[38;2;180;30;60m',
    },
    splashStops: [
      [255, 182, 193], [135, 206, 235], [221, 160, 221], [152, 251, 152], [255, 218, 185],
    ],
  },
  {
    id: 'hacker-terminal',
    name: 'Hacker Terminal',
    description: 'Phosphor screen — varied shades of green on black, amber warnings',
    colors: {
      act: '\x1b[38;2;0;255;0m',
      actBg: '\x1b[48;2;0;64;0m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;173;255;47m',
      success: '\x1b[38;2;50;205;50m',
      error: '\x1b[38;2;255;69;0m',
      warning: '\x1b[38;2;255;215;0m',
      gray: '\x1b[38;2;0;180;0m',
      grayDark: '\x1b[38;2;0;100;0m',
      fg: '\x1b[38;2;144;238;144m',
      bgUser: '\x1b[48;2;0;20;0m',
      rule: '\x1b[38;2;0;180;0m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;255;20;147m',
      violet: '\x1b[38;2;148;0;211m',
      cyan: '\x1b[38;2;127;255;212m',
      lime: '\x1b[38;2;127;255;0m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;255;127m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;0;255;127m',
      userGutter: '\x1b[38;2;173;255;47m',
      toolMarker: '\x1b[38;2;255;215;0m',
      toolWriteName: '\x1b[38;2;255;140;0m',
      codeKeyword: '\x1b[38;2;127;255;0m',
      codeString: '\x1b[38;2;255;215;0m',
      codeNumber: '\x1b[38;2;255;69;0m',
      mdHeading: '\x1b[38;2;173;255;47m',
      thoughtText: '\x1b[38;2;0;100;0m',
    },
    splashStops: [
      [0, 255, 0], [50, 205, 50], [173, 255, 47], [127, 255, 0], [144, 238, 144],
    ],
  },
  {
    id: 'midnight-jazz',
    name: 'Midnight Jazz',
    description: 'Smooth indigo lounge — gold, silver, plum on midnight blue, warm cream',
    colors: {
      act: '\x1b[38;2;218;165;32m',
      actBg: '\x1b[48;2;55;41;8m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;192;192;192m',
      success: '\x1b[38;2;102;205;170m',
      error: '\x1b[38;2;220;20;60m',
      warning: '\x1b[38;2;255;165;0m',
      gray: '\x1b[38;2;160;150;190m',
      grayDark: '\x1b[38;2;100;90;120m',
      fg: '\x1b[38;2;245;240;225m',
      bgUser: '\x1b[48;2;25;25;75m',
      rule: '\x1b[38;2;72;61;139m',
      pink: '\x1b[38;2;219;112;147m',
      magenta: '\x1b[38;2;139;0;139m',
      violet: '\x1b[38;2;147;112;219m',
      cyan: '\x1b[38;2;72;209;204m',
      lime: '\x1b[38;2;152;251;152m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;139;139m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;218;165;32m',
      userGutter: '\x1b[38;2;192;192;192m',
      toolMarker: '\x1b[38;2;147;112;219m',
      toolWriteName: '\x1b[38;2;220;20;60m',
      codeKeyword: '\x1b[38;2;147;112;219m',
      codeString: '\x1b[38;2;152;251;152m',
      mdHeading: '\x1b[38;2;218;165;32m',
    },
    splashStops: [
      [218, 165, 32], [192, 192, 192], [221, 160, 221], [147, 112, 219], [139, 0, 139],
    ],
  },
  {
    id: 'desert-sand',
    name: 'Desert Sand',
    description: 'Sun-bleached earth — terracotta, sage, twilight blue, sandy beige',
    colors: {
      act: '\x1b[38;2;70;130;180m',
      actBg: '\x1b[48;2;18;33;45m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;222;184;135m',
      success: '\x1b[38;2;143;188;143m',
      error: '\x1b[38;2;205;92;92m',
      warning: '\x1b[38;2;210;105;30m',
      gray: '\x1b[38;2;180;165;140m',
      grayDark: '\x1b[38;2;120;105;85m',
      fg: '\x1b[38;2;255;245;220m',
      bgUser: '\x1b[48;2;80;55;40m',
      rule: '\x1b[38;2;188;143;143m',
      pink: '\x1b[38;2;255;182;193m',
      magenta: '\x1b[38;2;205;92;92m',
      violet: '\x1b[38;2;147;112;219m',
      cyan: '\x1b[38;2;95;158;160m',
      lime: '\x1b[38;2;189;183;107m',
      orange: '\x1b[38;2;244;164;96m',
      teal: '\x1b[38;2;47;79;79m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;70;130;180m',
      userGutter: '\x1b[38;2;205;92;92m',
      toolMarker: '\x1b[38;2;189;183;107m',
      toolWriteName: '\x1b[38;2;210;105;30m',
      codeKeyword: '\x1b[38;2;205;92;92m',
      codeString: '\x1b[38;2;143;188;143m',
      mdHeading: '\x1b[38;2;222;184;135m',
    },
    splashStops: [
      [210, 105, 30], [222, 184, 135], [143, 188, 143], [70, 130, 180], [205, 92, 92],
    ],
  },
  {
    id: 'arctic-aurora',
    name: 'Arctic Aurora',
    description: 'Ice-blue dawn — vivid aurora greens, royal purples, cyan, gold',
    colors: {
      act: '\x1b[38;2;0;255;255m',
      actBg: '\x1b[48;2;0;64;64m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;138;43;226m',
      success: '\x1b[38;2;0;250;154m',
      error: '\x1b[38;2;220;20;60m',
      warning: '\x1b[38;2;255;215;0m',
      gray: '\x1b[38;2;176;196;222m',
      grayDark: '\x1b[38;2;112;128;144m',
      fg: '\x1b[38;2;240;255;255m',
      bgUser: '\x1b[48;2;10;20;40m',
      rule: '\x1b[38;2;70;130;180m',
      pink: '\x1b[38;2;255;192;203m',
      magenta: '\x1b[38;2;186;85;211m',
      violet: '\x1b[38;2;148;0;211m',
      cyan: '\x1b[38;2;0;255;255m',
      lime: '\x1b[38;2;127;255;0m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;32;178;170m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;127;255;0m',
      userGutter: '\x1b[38;2;138;43;226m',
      toolMarker: '\x1b[38;2;186;85;211m',
      toolWriteName: '\x1b[38;2;220;20;60m',
      codeKeyword: '\x1b[38;2;138;43;226m',
      codeString: '\x1b[38;2;0;250;154m',
      mdHeading: '\x1b[38;2;255;215;0m',
    },
    splashStops: [
      [0, 255, 255], [0, 250, 154], [138, 43, 226], [186, 85, 211], [127, 255, 0],
    ],
  },
  {
    id: 'ruby-rose',
    name: 'Ruby Rose',
    description: 'Velvet burgundy — crimson, blush pink, gold, ivory on wine',
    colors: {
      act: '\x1b[38;2;255;182;193m',
      actBg: '\x1b[48;2;64;46;48m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;255;215;0m',
      success: '\x1b[38;2;152;251;152m',
      error: '\x1b[38;2;255;0;0m',
      warning: '\x1b[38;2;255;140;0m',
      gray: '\x1b[38;2;200;160;170m',
      grayDark: '\x1b[38;2;128;0;0m',
      fg: '\x1b[38;2;255;240;245m',
      bgUser: '\x1b[48;2;50;10;20m',
      rule: '\x1b[38;2;139;0;0m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;220;20;60m',
      violet: '\x1b[38;2;199;21;133m',
      cyan: '\x1b[38;2;175;238;238m',
      lime: '\x1b[38;2;144;238;144m',
      orange: '\x1b[38;2;255;165;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;255;215;0m',
      userGutter: '\x1b[38;2;255;105;180m',
      toolMarker: '\x1b[38;2;255;182;193m',
      toolWriteName: '\x1b[38;2;220;20;60m',
      toolShellName: '\x1b[38;2;255;140;0m',
      codeKeyword: '\x1b[38;2;199;21;133m',
      codeString: '\x1b[38;2;152;251;152m',
      mdHeading: '\x1b[38;2;255;215;0m',
    },
    splashStops: [
      [220, 20, 60], [255, 182, 193], [255, 105, 180], [255, 215, 0], [199, 21, 133],
    ],
  },
  {
    id: 'neon-city',
    name: 'Neon City',
    description: 'Cyberpunk rain-slick street — electric blue, toxic lime, blood red, hot pink',
    colors: {
      act: '\x1b[38;2;0;191;255m',
      actBg: '\x1b[48;2;0;48;64m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;173;255;47m',
      success: '\x1b[38;2;0;250;154m',
      error: '\x1b[38;2;220;20;60m',
      warning: '\x1b[38;2;255;140;0m',
      gray: '\x1b[38;2;160;160;175m',
      grayDark: '\x1b[38;2;90;90;100m',
      fg: '\x1b[38;2;255;255;255m',
      bgUser: '\x1b[48;2;30;30;30m',
      rule: '\x1b[38;2;128;128;128m',
      pink: '\x1b[38;2;255;20;147m',
      magenta: '\x1b[38;2;255;0;255m',
      violet: '\x1b[38;2;138;43;226m',
      cyan: '\x1b[38;2;0;255;255m',
      lime: '\x1b[38;2;50;205;50m',
      orange: '\x1b[38;2;255;69;0m',
      teal: '\x1b[38;2;0;206;209m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;0;191;255m',
      userGutter: '\x1b[38;2;255;20;147m',
      toolMarker: '\x1b[38;2;173;255;47m',
      toolWriteName: '\x1b[38;2;255;0;255m',
      codeKeyword: '\x1b[38;2;255;20;147m',
      codeString: '\x1b[38;2;173;255;47m',
      mdHeading: '\x1b[38;2;255;140;0m',
    },
    splashStops: [
      [0, 191, 255], [173, 255, 47], [220, 20, 60], [255, 20, 147], [0, 250, 154],
    ],
  },
  {
    id: 'pastel-goth',
    name: 'Pastel Goth',
    description: 'Charcoal with pastel pink, mint, lavender, sky — sweet meets dark',
    colors: {
      act: '\x1b[38;2;221;160;221m',
      actBg: '\x1b[48;2;55;40;55m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;152;251;152m',
      success: '\x1b[38;2;175;238;238m',
      error: '\x1b[38;2;250;128;114m',
      warning: '\x1b[38;2;255;218;185m',
      gray: '\x1b[38;2;180;175;190m',
      grayDark: '\x1b[38;2;120;115;135m',
      fg: '\x1b[38;2;240;248;255m',
      bgUser: '\x1b[48;2;40;40;45m',
      rule: '\x1b[38;2;119;136;153m',
      pink: '\x1b[38;2;255;182;193m',
      magenta: '\x1b[38;2;238;130;238m',
      violet: '\x1b[38;2;216;191;216m',
      cyan: '\x1b[38;2;224;255;255m',
      lime: '\x1b[38;2;144;238;144m',
      orange: '\x1b[38;2;255;160;122m',
      teal: '\x1b[38;2;32;178;170m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;175;238;238m',
      userGutter: '\x1b[38;2;238;130;238m',
      toolMarker: '\x1b[38;2;152;251;152m',
      toolWriteName: '\x1b[38;2;221;160;221m',
      codeKeyword: '\x1b[38;2;238;130;238m',
      codeString: '\x1b[38;2;144;238;144m',
      mdHeading: '\x1b[38;2;255;182;193m',
    },
    splashStops: [
      [221, 160, 221], [152, 251, 152], [255, 182, 193], [175, 238, 238], [238, 130, 238],
    ],
  },
  {
    id: 'obsidian-gold',
    name: 'Obsidian Gold',
    description: 'Black mirror with gold accents — precious metals on volcanic glass',
    colors: {
      act: '\x1b[38;2;218;165;32m',
      actBg: '\x1b[48;2;55;41;8m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;192;192;192m',
      success: '\x1b[38;2;184;134;11m',
      error: '\x1b[38;2;178;34;34m',
      warning: '\x1b[38;2;205;133;63m',
      gray: '\x1b[38;2;160;150;130m',
      grayDark: '\x1b[38;2;80;75;65m',
      fg: '\x1b[38;2;245;235;210m',
      bgUser: '\x1b[48;2;25;20;15m',
      rule: '\x1b[38;2;139;119;85m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;218;112;214m',
      violet: '\x1b[38;2;186;85;211m',
      cyan: '\x1b[38;2;72;209;204m',
      lime: '\x1b[38;2;154;205;50m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;218;165;32m',
      userGutter: '\x1b[38;2;192;192;192m',
      toolMarker: '\x1b[38;2;255;215;0m',
      toolWriteName: '\x1b[38;2;184;134;11m',
      codeKeyword: '\x1b[38;2;255;215;0m',
      codeString: '\x1b[38;2;184;134;11m',
      mdHeading: '\x1b[38;2;218;165;32m',
    },
    splashStops: [
      [218, 165, 32], [192, 192, 192], [184, 134, 11], [205, 133, 63], [255, 215, 0],
    ],
  },
  {
    // Dracula — soft purple bg, pink/cyan/green/yellow accents.
    id: 'dracula',
    name: 'Dracula',
    description: 'Classic Dracula — soft purple bg, pink/cyan/green/yellow accents',
    colors: {
      act: '\x1b[38;2;80;250;123m',
      actBg: '\x1b[48;2;20;63;31m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;255;184;108m',
      success: '\x1b[38;2;80;250;123m',
      error: '\x1b[38;2;255;85;85m',
      warning: '\x1b[38;2;241;250;140m',
      gray: '\x1b[38;2;98;114;164m',
      grayDark: '\x1b[38;2;68;71;90m',
      fg: '\x1b[38;2;248;248;242m',
      bgUser: '\x1b[48;2;40;42;54m',
      rule: '\x1b[38;2;98;114;164m',
      pink: '\x1b[38;2;255;121;198m',
      magenta: '\x1b[38;2;255;121;198m',
      violet: '\x1b[38;2;189;147;249m',
      cyan: '\x1b[38;2;139;233;253m',
      lime: '\x1b[38;2;80;250;123m',
      orange: '\x1b[38;2;255;184;108m',
      teal: '\x1b[38;2;139;233;253m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;189;147;249m',
      userGutter: '\x1b[38;2;255;121;198m',
      toolMarker: '\x1b[38;2;139;233;253m',
      toolWriteName: '\x1b[38;2;255;121;198m',
      toolReadName: '\x1b[38;2;139;233;253m',
      toolShellName: '\x1b[38;2;241;250;140m',
      toolTestName: '\x1b[38;2;80;250;123m',
      toolGenericName: '\x1b[38;2;189;147;249m',
      codeKeyword: '\x1b[38;2;255;121;198m',
      codeString: '\x1b[38;2;241;250;140m',
      codeNumber: '\x1b[38;2;189;147;249m',
      codeComment: '\x1b[38;2;98;114;164m',
      mdHeading: '\x1b[38;2;255;121;198m',
      mdLink: '\x1b[38;2;139;233;253m',
      thinkingLabel: '\x1b[38;2;139;233;253m',
      reasoningBadge: '\x1b[38;2;189;147;249m',
      reasonBadge: { low: '\x1b[38;2;139;233;253m', medium: '\x1b[38;2;80;250;123m', high: '\x1b[38;2;255;184;108m', max: '\x1b[38;2;255;121;198m' },
    },
    splashStops: [
      [255, 121, 198], [189, 147, 249], [139, 233, 253], [80, 250, 123], [241, 250, 140],
    ],
  },
  {
    // Tokyo Night — soft blue-purple night, yellow tool names.
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Tokyo Night — soft blue-purple night, yellow tool names, cyan accents',
    colors: {
      act: '\x1b[38;2;122;162;247m',
      actBg: '\x1b[48;2;31;41;62m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;224;175;104m',
      success: '\x1b[38;2;158;206;106m',
      error: '\x1b[38;2;247;118;142m',
      warning: '\x1b[38;2;224;175;104m',
      gray: '\x1b[38;2;86;95;137m',
      grayDark: '\x1b[38;2;59;66;97m',
      fg: '\x1b[38;2;192;202;245m',
      bgUser: '\x1b[48;2;26;27;38m',
      rule: '\x1b[38;2;86;95;137m',
      pink: '\x1b[38;2;173;142;230m',
      magenta: '\x1b[38;2;173;142;230m',
      violet: '\x1b[38;2;173;142;230m',
      cyan: '\x1b[38;2;125;207;255m',
      lime: '\x1b[38;2;158;206;106m',
      orange: '\x1b[38;2;224;175;104m',
      teal: '\x1b[38;2;125;207;255m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;122;162;247m',
      userGutter: '\x1b[38;2;224;175;104m',
      toolMarker: '\x1b[38;2;125;207;255m',
      toolWriteName: '\x1b[38;2;224;175;104m',
      toolReadName: '\x1b[38;2;125;207;255m',
      toolShellName: '\x1b[38;2;158;206;106m',
      toolTestName: '\x1b[38;2;158;206;106m',
      toolGenericName: '\x1b[38;2;122;162;247m',
      codeKeyword: '\x1b[38;2;173;142;230m',
      codeString: '\x1b[38;2;158;206;106m',
      codeNumber: '\x1b[38;2;224;175;104m',
      codeType: '\x1b[38;2;125;207;255m',
      codeFn: '\x1b[38;2;122;162;247m',
      codeComment: '\x1b[38;2;86;95;137m',
      mdHeading: '\x1b[38;2;224;175;104m',
      mdLink: '\x1b[38;2;125;207;255m',
      thinkingLabel: '\x1b[38;2;125;207;255m',
      reasoningBadge: '\x1b[38;2;224;175;104m',
      reasonBadge: { low: '\x1b[38;2;125;207;255m', medium: '\x1b[38;2;158;206;106m', high: '\x1b[38;2;224;175;104m', max: '\x1b[38;2;247;118;142m' },
    },
    splashStops: [
      [122, 162, 247], [125, 207, 255], [224, 175, 104], [173, 142, 230], [158, 206, 106],
    ],
  },
  {
    // Catppuccin Mocha — warm latte palette, mauve/peach/sky/green.
    id: 'catppuccin-mocha',
    name: 'Catppuccin',
    description: 'Catppuccin Mocha — warm latte palette, mauve/peach/sky/green',
    colors: {
      act: '\x1b[38;2;166;218;149m',
      actBg: '\x1b[48;2;42;55;37m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;250;179;135m',
      success: '\x1b[38;2;166;218;149m',
      error: '\x1b[38;2;237;135;150m',
      warning: '\x1b[38;2;238;212;159m',
      gray: '\x1b[38;2;108;112;134m',
      grayDark: '\x1b[38;2;69;71;90m',
      fg: '\x1b[38;2;205;214;244m',
      bgUser: '\x1b[48;2;30;30;46m',
      rule: '\x1b[38;2;108;112;134m',
      pink: '\x1b[38;2;245;194;231m',
      magenta: '\x1b[38;2;245;194;231m',
      violet: '\x1b[38;2;203;166;247m',
      cyan: '\x1b[38;2;137;220;235m',
      lime: '\x1b[38;2;166;218;149m',
      orange: '\x1b[38;2;250;179;135m',
      teal: '\x1b[38;2;148;226;213m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;203;166;247m',
      userGutter: '\x1b[38;2;250;179;135m',
      toolMarker: '\x1b[38;2;148;226;213m',
      toolWriteName: '\x1b[38;2;250;179;135m',
      toolReadName: '\x1b[38;2;137;220;235m',
      toolShellName: '\x1b[38;2;238;212;159m',
      toolTestName: '\x1b[38;2;166;218;149m',
      toolGenericName: '\x1b[38;2;203;166;247m',
      codeKeyword: '\x1b[38;2;245;194;231m',
      codeString: '\x1b[38;2;166;218;149m',
      codeNumber: '\x1b[38;2;250;179;135m',
      codeComment: '\x1b[38;2;108;112;134m',
      mdHeading: '\x1b[38;2;245;194;231m',
      mdLink: '\x1b[38;2;137;220;235m',
      thinkingLabel: '\x1b[38;2;203;166;247m',
      reasoningBadge: '\x1b[38;2;250;179;135m',
      reasonBadge: { low: '\x1b[38;2;137;220;235m', medium: '\x1b[38;2;166;218;149m', high: '\x1b[38;2;250;179;135m', max: '\x1b[38;2;245;194;231m' },
    },
    splashStops: [
      [203, 166, 247], [245, 194, 231], [137, 220, 235], [250, 179, 135], [166, 218, 149],
    ],
  },
  {
    // Gruvbox — warm retro earth tones: orange/green/purple/yellow on dark.
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'Gruvbox — warm retro earth tones: orange/green/purple/yellow on dark',
    colors: {
      act: '\x1b[38;2;184;187;38m',
      actBg: '\x1b[48;2;46;47;10m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;250;189;47m',
      success: '\x1b[38;2;184;187;38m',
      error: '\x1b[38;2;251;73;52m',
      warning: '\x1b[38;2;250;189;47m',
      gray: '\x1b[38;2;146;131;116m',
      grayDark: '\x1b[38;2;80;73;69m',
      fg: '\x1b[38;2;235;219;178m',
      bgUser: '\x1b[48;2;40;40;40m',
      rule: '\x1b[38;2;146;131;116m',
      pink: '\x1b[38;2;251;73;52m',
      magenta: '\x1b[38;2;211;134;155m',
      violet: '\x1b[38;2;211;134;155m',
      cyan: '\x1b[38;2;142;192;124m',
      lime: '\x1b[38;2;184;187;38m',
      orange: '\x1b[38;2;250;189;47m',
      teal: '\x1b[38;2;142;192;124m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;250;189;47m',
      userGutter: '\x1b[38;2;142;192;124m',
      toolMarker: '\x1b[38;2;254;128;25m',
      toolWriteName: '\x1b[38;2;251;73;52m',
      toolReadName: '\x1b[38;2;142;192;124m',
      toolShellName: '\x1b[38;2;250;189;47m',
      toolTestName: '\x1b[38;2;184;187;38m',
      toolGenericName: '\x1b[38;2;211;134;155m',
      codeKeyword: '\x1b[38;2;251;73;52m',
      codeString: '\x1b[38;2;184;187;38m',
      codeNumber: '\x1b[38;2;211;134;155m',
      codeComment: '\x1b[38;2;146;131;116m',
      mdHeading: '\x1b[38;2;250;189;47m',
      mdLink: '\x1b[38;2;142;192;124m',
      thinkingLabel: '\x1b[38;2;250;189;47m',
      reasoningBadge: '\x1b[38;2;254;128;25m',
      reasonBadge: { low: '\x1b[38;2;142;192;124m', medium: '\x1b[38;2;184;187;38m', high: '\x1b[38;2;250;189;47m', max: '\x1b[38;2;251;73;52m' },
    },
    splashStops: [
      [251, 73, 52], [250, 189, 47], [184, 187, 38], [211, 134, 155], [142, 192, 124],
    ],
  },
  {
    // One Dark (Atom) — classic editor: blue/purple/cyan/green on charcoal.
    id: 'one-dark',
    name: 'One Dark',
    description: 'One Dark — classic editor: blue, purple, cyan, green on charcoal',
    colors: {
      act: '\x1b[38;2;97;175;239m',
      actBg: '\x1b[48;2;24;44;60m',
      bgText: '\x1b[38;2;245;245;250m',
      plan: '\x1b[38;2;229;192;123m',
      success: '\x1b[38;2;152;195;121m',
      error: '\x1b[38;2;224;108;117m',
      warning: '\x1b[38;2;229;192;123m',
      gray: '\x1b[38;2;92;99;112m',
      grayDark: '\x1b[38;2;60;63;72m',
      fg: '\x1b[38;2;171;178;191m',
      bgUser: '\x1b[48;2;40;44;52m',
      rule: '\x1b[38;2;92;99;112m',
      pink: '\x1b[38;2;198;120;221m',
      magenta: '\x1b[38;2;198;120;221m',
      violet: '\x1b[38;2;198;120;221m',
      cyan: '\x1b[38;2;86;182;194m',
      lime: '\x1b[38;2;152;195;121m',
      orange: '\x1b[38;2;229;192;123m',
      teal: '\x1b[38;2;86;182;194m',
    },
    roleColors: {
      assistantGutter: '\x1b[38;2;97;175;239m',
      userGutter: '\x1b[38;2;198;120;221m',
      toolMarker: '\x1b[38;2;152;195;121m',
      toolWriteName: '\x1b[38;2;224;108;117m',
      toolReadName: '\x1b[38;2;86;182;194m',
      toolShellName: '\x1b[38;2;229;192;123m',
      toolTestName: '\x1b[38;2;152;195;121m',
      toolGenericName: '\x1b[38;2;198;120;221m',
      codeKeyword: '\x1b[38;2;198;120;221m',
      codeString: '\x1b[38;2;152;195;121m',
      codeNumber: '\x1b[38;2;229;192;123m',
      codeType: '\x1b[38;2;229;192;123m',
      codeFn: '\x1b[38;2;97;175;239m',
      codeComment: '\x1b[38;2;92;99;112m',
      mdHeading: '\x1b[38;2;198;120;221m',
      mdLink: '\x1b[38;2;86;182;194m',
      thinkingLabel: '\x1b[38;2;97;175;239m',
      reasoningBadge: '\x1b[38;2;229;192;123m',
      reasonBadge: { low: '\x1b[38;2;86;182;194m', medium: '\x1b[38;2;152;195;121m', high: '\x1b[38;2;229;192;123m', max: '\x1b[38;2;224;108;117m' },
    },
    splashStops: [
      [97, 175, 239], [198, 120, 221], [86, 182, 194], [152, 195, 121], [229, 192, 123],
    ],
  },
];

/** Compute the default RoleColors for a theme's palette, so themes that
 *  don't provide roleColors still get coherent defaults derived from the
 *  palette. Themes can override any subset. */
export function defaultRoleColors(p: ThemeColors): RoleColors {
  return {
    assistantGutter: p.cyan,
    assistantText: p.fg,
    toolMarker: p.lime,
    userGutter: p.magenta,
    userFg: p.fg,
    userBg: p.bgUser,
    thoughtGutter: p.grayDark,
    thoughtText: p.gray,
    errorMark: p.error,
    errorText: p.error,
    systemMark: p.grayDark,
    systemText: p.gray,
    taskMark: p.cyan,
    taskText: p.fg,
    goalMark: p.pink,
    goalText: p.fg,
    codeKeyword: p.magenta,
    codeString: p.lime,
    codeNumber: p.orange,
    codeComment: p.gray,
    codePunct: p.teal,
    codeType: p.violet,
    codeFn: p.cyan,
    mdHeading: p.pink,
    mdBold: p.fg,
    mdItalic: p.fg,
    mdLink: p.cyan,
    thinkingLabel: p.cyan,
    reasoningBadge: p.cyan,
    reasonBadge: { low: p.cyan, medium: p.lime, high: p.orange, max: p.pink },
    toolWriteName: p.violet,
    toolReadName: p.cyan,
    toolShellName: p.orange,
    toolTestName: p.lime,
    toolGenericName: p.violet,
    contextLow: p.lime,
    contextMid: p.orange,
    contextHigh: p.error,
  };
}

/** Merge a theme's palette + optional roleColors into the resolved role
 *  colors used by the renderer. Themes that don't customize roles get the
 *  palette-derived defaults. */
export function resolveRoleColors(theme: MochiTheme): RoleColors {
  const base = defaultRoleColors(theme.colors);
  if (!theme.roleColors) return base;
  return {
    ...base,
    ...theme.roleColors,
    reasonBadge: { ...base.reasonBadge, ...(theme.roleColors.reasonBadge ?? {}) },
  };
}

function getThemeConfigPaths(): string[] {
  return [
    resolve(homedir(), '.config', 'mochi', 'theme.json'),
    resolve(homedir(), '.mochi', 'theme.json'),
    resolve(process.cwd(), '.mochi', 'theme.json'),
  ];
}

function loadSavedTheme(): MochiTheme {
  const envTheme = process.env.MOCHI_THEME;
  if (envTheme) {
    const found = getTheme(envTheme);
    if (found) return found;
  }
  for (const p of getThemeConfigPaths()) {
    try {
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        if (data?.theme) {
          const found = getTheme(data.theme);
          if (found) return found;
        }
      }
    } catch {}
  }
  // Check main config.json
  try {
    const cfgPath = resolve(homedir(), '.config', 'mochi', 'config.json');
    if (existsSync(cfgPath)) {
      const data = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (data?.theme) {
        const found = getTheme(data.theme);
        if (found) return found;
      }
    }
  } catch {}
  return THEMES[0];
}

let currentTheme: MochiTheme = loadSavedTheme();

export function getTheme(id: string): MochiTheme | undefined {
  const norm = id.toLowerCase().trim();
  return THEMES.find((t) => t.id === norm || t.name.toLowerCase() === norm);
}

export function getAllThemes(): MochiTheme[] {
  return THEMES;
}

export function getCurrentTheme(): MochiTheme {
  if (!currentTheme) {
    currentTheme = loadSavedTheme();
  }
  return currentTheme;
}

export function applyTheme(id: string): MochiTheme {
  const found = getTheme(id);
  if (found) {
    currentTheme = found;
    process.env.MOCHI_THEME = found.id;
    for (const p of getThemeConfigPaths()) {
      try {
        const dir = dirname(p);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(p, JSON.stringify({ theme: found.id, name: found.name }, null, 2));
      } catch {}
    }
    // Also save to main config.json
    try {
      const cfgPath = resolve(homedir(), '.config', 'mochi', 'config.json');
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        cfg.theme = found.id;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      }
    } catch {}
  }
  return currentTheme;
}

/** Render a 4-block color swatch for a theme. */
export function themeSwatch(t: MochiTheme): string {
  return `${t.colors.magenta}■${t.colors.cyan}■${t.colors.lime}■${t.colors.act}■\x1b[0m`;
}
