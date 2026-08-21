// 15 unique, handcrafted color themes for Mochi TUI.
// Each theme provides distinct foregrounds, accents, rule borders,
// background highlights, and splash gradient stops.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface ThemeColors {
  act: string;
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

export interface MochiTheme {
  id: string;
  name: string;
  description: string;
  colors: ThemeColors;
  splashStops: Array<[number, number, number]>;
}

export const THEMES: MochiTheme[] = [
  {
    id: 'classic',
    name: 'Mochi Classic',
    description: 'Signature candy pastel palette (magenta, violet, cyan, soft pink)',
    colors: {
      act: '\x1b[38;2;121;184;255m',
      plan: '\x1b[38;2;255;234;127m',
      success: '\x1b[38;2;153;232;155m',
      error: '\x1b[38;2;248;81;73m',
      warning: '\x1b[38;2;240;173;77m',
      gray: '\x1b[38;2;139;148;158m',
      grayDark: '\x1b[38;2;72;79;86m',
      fg: '\x1b[38;2;230;237;243m',
      bgUser: '\x1b[48;2;32;39;49m',
      rule: '\x1b[38;2;48;54;61m',
      pink: '\x1b[38;2;255;175;209m',
      magenta: '\x1b[38;2;255;110;199m',
      violet: '\x1b[38;2;199;146;234m',
      cyan: '\x1b[38;2;86;212;221m',
      lime: '\x1b[38;2;163;230;53m',
      orange: '\x1b[38;2;255;158;100m',
      teal: '\x1b[38;2;45;212;191m',
    },
    splashStops: [
      [255, 110, 199],
      [199, 146, 234],
      [86, 212, 221],
      [121, 184, 255],
      [255, 175, 209],
    ],
  },
  {
    id: 'sakura',
    name: 'Sakura Bloom',
    description: 'Soft rose, blush pink, and warm gold',
    colors: {
      act: '\x1b[38;2;255;128;191m',
      plan: '\x1b[38;2;255;209;102m',
      success: '\x1b[38;2;167;201;87m',
      error: '\x1b[38;2;230;57;70m',
      warning: '\x1b[38;2;244;162;97m',
      gray: '\x1b[38;2;163;155;168m',
      grayDark: '\x1b[38;2;92;80;97m',
      fg: '\x1b[38;2;253;240;245m',
      bgUser: '\x1b[48;2;48;32;42m',
      rule: '\x1b[38;2;107;77;94m',
      pink: '\x1b[38;2;255;183;197m',
      magenta: '\x1b[38;2;247;37;133m',
      violet: '\x1b[38;2;216;131;183m',
      cyan: '\x1b[38;2;144;224;239m',
      lime: '\x1b[38;2;181;228;140m',
      orange: '\x1b[38;2;243;156;18m',
      teal: '\x1b[38;2;128;206;214m',
    },
    splashStops: [
      [255, 183, 197],
      [255, 105, 180],
      [255, 223, 186],
      [255, 192, 203],
      [255, 240, 245],
    ],
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk 2077',
    description: 'High-voltage neon yellow, hot magenta, and laser cyan',
    colors: {
      act: '\x1b[38;2;0;240;255m',
      plan: '\x1b[38;2;254;231;21m',
      success: '\x1b[38;2;57;255;20m',
      error: '\x1b[38;2;255;0;60m',
      warning: '\x1b[38;2;255;153;0m',
      gray: '\x1b[38;2;128;128;144m',
      grayDark: '\x1b[38;2;58;58;76m',
      fg: '\x1b[38;2;255;255;255m',
      bgUser: '\x1b[48;2;25;20;35m',
      rule: '\x1b[38;2;255;0;127m',
      pink: '\x1b[38;2;255;0;127m',
      magenta: '\x1b[38;2;255;0;85m',
      violet: '\x1b[38;2;176;0;255m',
      cyan: '\x1b[38;2;0;240;255m',
      lime: '\x1b[38;2;57;255;20m',
      orange: '\x1b[38;2;255;94;0m',
      teal: '\x1b[38;2;0;255;216m',
    },
    splashStops: [
      [254, 231, 21],
      [255, 0, 127],
      [0, 240, 255],
      [178, 0, 255],
      [254, 231, 21],
    ],
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Gothic vampire slate, orchid purple, and neon pink',
    colors: {
      act: '\x1b[38;2;139;233;253m',
      plan: '\x1b[38;2;241;250;140m',
      success: '\x1b[38;2;80;250;123m',
      error: '\x1b[38;2;255;85;85m',
      warning: '\x1b[38;2;255;184;108m',
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
    splashStops: [
      [189, 147, 249],
      [255, 121, 198],
      [139, 233, 253],
      [80, 250, 123],
      [255, 184, 108],
    ],
  },
  {
    id: 'nord',
    name: 'Nordic Frost',
    description: 'Arctic polar night, glacial blues, and aurora green',
    colors: {
      act: '\x1b[38;2;136;192;208m',
      plan: '\x1b[38;2;235;203;139m',
      success: '\x1b[38;2;163;190;140m',
      error: '\x1b[38;2;191;97;106m',
      warning: '\x1b[38;2;208;135;112m',
      gray: '\x1b[38;2;123;136;161m',
      grayDark: '\x1b[38;2;67;76;94m',
      fg: '\x1b[38;2;236;239;244m',
      bgUser: '\x1b[48;2;46;52;64m',
      rule: '\x1b[38;2;76;86;106m',
      pink: '\x1b[38;2;180;142;173m',
      magenta: '\x1b[38;2;180;142;173m',
      violet: '\x1b[38;2;180;142;173m',
      cyan: '\x1b[38;2;136;192;208m',
      lime: '\x1b[38;2;163;190;140m',
      orange: '\x1b[38;2;208;135;112m',
      teal: '\x1b[38;2;143;188;187m',
    },
    splashStops: [
      [143, 188, 187],
      [136, 192, 208],
      [129, 161, 193],
      [94, 129, 172],
      [235, 203, 139],
    ],
  },
  {
    id: 'monokai',
    name: 'Monokai Pro',
    description: 'High-contrast charcoal with vivid yellow, magenta, and mint',
    colors: {
      act: '\x1b[38;2;120;220;232m',
      plan: '\x1b[38;2;255;216;102m',
      success: '\x1b[38;2;169;220;107m',
      error: '\x1b[38;2;255;97;136m',
      warning: '\x1b[38;2;252;152;103m',
      gray: '\x1b[38;2;147;146;147m',
      grayDark: '\x1b[38;2;64;62;65m',
      fg: '\x1b[38;2;252;252;250m',
      bgUser: '\x1b[48;2;45;42;46m',
      rule: '\x1b[38;2;91;89;92m',
      pink: '\x1b[38;2;255;97;136m',
      magenta: '\x1b[38;2;255;97;136m',
      violet: '\x1b[38;2;171;157;242m',
      cyan: '\x1b[38;2;120;220;232m',
      lime: '\x1b[38;2;169;220;107m',
      orange: '\x1b[38;2;252;152;103m',
      teal: '\x1b[38;2;120;220;232m',
    },
    splashStops: [
      [255, 216, 102],
      [255, 97, 136],
      [169, 220, 107],
      [120, 220, 232],
      [171, 157, 242],
    ],
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Midnight rain with electric indigo, sky cyan, and lavender',
    colors: {
      act: '\x1b[38;2;122;162;247m',
      plan: '\x1b[38;2;224;175;104m',
      success: '\x1b[38;2;158;206;106m',
      error: '\x1b[38;2;247;118;142m',
      warning: '\x1b[38;2;255;158;100m',
      gray: '\x1b[38;2;120;124;153m',
      grayDark: '\x1b[38;2;54;59;84m',
      fg: '\x1b[38;2;192;202;245m',
      bgUser: '\x1b[48;2;26;27;38m',
      rule: '\x1b[38;2;65;72;104m',
      pink: '\x1b[38;2;247;118;142m',
      magenta: '\x1b[38;2;187;154;247m',
      violet: '\x1b[38;2;187;154;247m',
      cyan: '\x1b[38;2;125;207;255m',
      lime: '\x1b[38;2;158;206;106m',
      orange: '\x1b[38;2;255;158;100m',
      teal: '\x1b[38;2;115;218;202m',
    },
    splashStops: [
      [122, 162, 247],
      [187, 154, 247],
      [125, 207, 255],
      [247, 118, 142],
      [115, 218, 202],
    ],
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    description: 'Soothing pastel mocha with lavender, mauve, and sapphire',
    colors: {
      act: '\x1b[38;2;137;180;250m',
      plan: '\x1b[38;2;249;226;175m',
      success: '\x1b[38;2;166;227;161m',
      error: '\x1b[38;2;243;139;168m',
      warning: '\x1b[38;2;250;179;135m',
      gray: '\x1b[38;2;147;153;178m',
      grayDark: '\x1b[38;2;69;71;90m',
      fg: '\x1b[38;2;205;214;244m',
      bgUser: '\x1b[48;2;30;30;46m',
      rule: '\x1b[38;2;88;91;112m',
      pink: '\x1b[38;2;245;194;231m',
      magenta: '\x1b[38;2;203;166;247m',
      violet: '\x1b[38;2;203;166;247m',
      cyan: '\x1b[38;2;137;220;235m',
      lime: '\x1b[38;2;166;227;161m',
      orange: '\x1b[38;2;250;179;135m',
      teal: '\x1b[38;2;148;226;213m',
    },
    splashStops: [
      [245, 194, 231],
      [203, 166, 247],
      [137, 180, 250],
      [148, 226, 213],
      [250, 179, 135],
    ],
  },
  {
    id: 'synthwave',
    name: 'Synthwave 84',
    description: 'Outrun neon grid with electric hot pink, cyan, and sunset gold',
    colors: {
      act: '\x1b[38;2;54;249;246m',
      plan: '\x1b[38;2;254;216;0m',
      success: '\x1b[38;2;114;241;184m',
      error: '\x1b[38;2;254;68;80m',
      warning: '\x1b[38;2;255;142;0m',
      gray: '\x1b[38;2;132;139;189m',
      grayDark: '\x1b[38;2;52;41;79m',
      fg: '\x1b[38;2;254;222;93m',
      bgUser: '\x1b[48;2;38;26;63m',
      rule: '\x1b[38;2;255;126;219m',
      pink: '\x1b[38;2;255;126;219m',
      magenta: '\x1b[38;2;254;68;80m',
      violet: '\x1b[38;2;157;78;221m',
      cyan: '\x1b[38;2;54;249;246m',
      lime: '\x1b[38;2;114;241;184m',
      orange: '\x1b[38;2;255;142;0m',
      teal: '\x1b[38;2;3;233;244m',
    },
    splashStops: [
      [255, 126, 219],
      [0, 249, 255],
      [254, 222, 93],
      [255, 110, 150],
      [130, 80, 223],
    ],
  },
  {
    id: 'solarized',
    name: 'Solarized Dark',
    description: 'Precision palette for terminal coders',
    colors: {
      act: '\x1b[38;2;38;139;210m',
      plan: '\x1b[38;2;181;137;0m',
      success: '\x1b[38;2;133;153;0m',
      error: '\x1b[38;2;220;50;47m',
      warning: '\x1b[38;2;203;75;22m',
      gray: '\x1b[38;2;131;148;150m',
      grayDark: '\x1b[38;2;7;54;66m',
      fg: '\x1b[38;2;147;161;161m',
      bgUser: '\x1b[48;2;7;54;66m',
      rule: '\x1b[38;2;88;110;117m',
      pink: '\x1b[38;2;211;54;130m',
      magenta: '\x1b[38;2;211;54;130m',
      violet: '\x1b[38;2;108;113;196m',
      cyan: '\x1b[38;2;42;161;152m',
      lime: '\x1b[38;2;133;153;0m',
      orange: '\x1b[38;2;203;75;22m',
      teal: '\x1b[38;2;42;161;152m',
    },
    splashStops: [
      [38, 139, 210],
      [42, 161, 152],
      [133, 153, 0],
      [181, 137, 0],
      [211, 54, 130],
    ],
  },
  {
    id: 'matrix',
    name: 'Matrix Phosphor',
    description: 'Pure CRT phosphor green cascade on void black',
    colors: {
      act: '\x1b[38;2;0;255;102m',
      plan: '\x1b[38;2;128;255;0m',
      success: '\x1b[38;2;0;255;65m',
      error: '\x1b[38;2;255;0;51m',
      warning: '\x1b[38;2;204;255;0m',
      gray: '\x1b[38;2;58;125;68m',
      grayDark: '\x1b[38;2;27;67;36m',
      fg: '\x1b[38;2;85;255;85m',
      bgUser: '\x1b[48;2;10;25;12m',
      rule: '\x1b[38;2;0;143;17m',
      pink: '\x1b[38;2;0;255;102m',
      magenta: '\x1b[38;2;0;255;65m',
      violet: '\x1b[38;2;57;255;20m',
      cyan: '\x1b[38;2;0;255;204m',
      lime: '\x1b[38;2;0;255;65m',
      orange: '\x1b[38;2;112;224;0m',
      teal: '\x1b[38;2;0;255;136m',
    },
    splashStops: [
      [0, 255, 65],
      [0, 200, 50],
      [100, 255, 150],
      [0, 143, 17],
      [0, 255, 100],
    ],
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    description: 'Warm retro groove with autumn amber, olive, and rust',
    colors: {
      act: '\x1b[38;2;131;165;152m',
      plan: '\x1b[38;2;250;189;47m',
      success: '\x1b[38;2;184;187;38m',
      error: '\x1b[38;2;251;73;52m',
      warning: '\x1b[38;2;254;128;25m',
      gray: '\x1b[38;2;146;131;116m',
      grayDark: '\x1b[38;2;80;73;69m',
      fg: '\x1b[38;2;235;219;178m',
      bgUser: '\x1b[48;2;40;40;40m',
      rule: '\x1b[38;2;102;92;84m',
      pink: '\x1b[38;2;211;134;155m',
      magenta: '\x1b[38;2;211;134;155m',
      violet: '\x1b[38;2;211;134;155m',
      cyan: '\x1b[38;2;142;192;124m',
      lime: '\x1b[38;2;184;187;38m',
      orange: '\x1b[38;2;254;128;25m',
      teal: '\x1b[38;2;142;192;124m',
    },
    splashStops: [
      [251, 73, 52],
      [250, 189, 47],
      [184, 187, 38],
      [142, 192, 124],
      [211, 134, 155],
    ],
  },
  {
    id: 'abyss',
    name: 'Midnight Abyss',
    description: 'Deep oceanic bioluminescence with sapphire and electric teal',
    colors: {
      act: '\x1b[38;2;0;210;255m',
      plan: '\x1b[38;2;58;123;213m',
      success: '\x1b[38;2;0;242;254m',
      error: '\x1b[38;2;255;75;114m',
      warning: '\x1b[38;2;247;183;49m',
      gray: '\x1b[38;2;87;101;116m',
      grayDark: '\x1b[38;2;34;47;62m',
      fg: '\x1b[38;2;200;214;229m',
      bgUser: '\x1b[48;2;12;20;38m',
      rule: '\x1b[38;2;46;134;222m',
      pink: '\x1b[38;2;84;160;255m',
      magenta: '\x1b[38;2;95;39;205m',
      violet: '\x1b[38;2;52;31;151m',
      cyan: '\x1b[38;2;72;219;251m',
      lime: '\x1b[38;2;29;209;161m',
      orange: '\x1b[38;2;255;159;67m',
      teal: '\x1b[38;2;0;210;211m',
    },
    splashStops: [
      [0, 195, 255],
      [0, 114, 255],
      [72, 52, 212],
      [0, 242, 254],
      [79, 172, 254],
    ],
  },
  {
    id: 'sunset',
    name: 'Sunset Horizon',
    description: 'Warm twilight glow with crimson, tangerine, and royal purple',
    colors: {
      act: '\x1b[38;2;255;121;121m',
      plan: '\x1b[38;2;249;202;36m',
      success: '\x1b[38;2;106;176;76m',
      error: '\x1b[38;2;235;77;75m',
      warning: '\x1b[38;2;240;147;43m',
      gray: '\x1b[38;2;149;175;192m',
      grayDark: '\x1b[38;2;66;49;76m',
      fg: '\x1b[38;2;245;246;250m',
      bgUser: '\x1b[48;2;48;25;52m',
      rule: '\x1b[38;2;190;46;221m',
      pink: '\x1b[38;2;255;121;121m',
      magenta: '\x1b[38;2;224;86;253m',
      violet: '\x1b[38;2;190;46;221m',
      cyan: '\x1b[38;2;34;166;179m',
      lime: '\x1b[38;2;106;176;76m',
      orange: '\x1b[38;2;255;190;118m',
      teal: '\x1b[38;2;126;214;223m',
    },
    splashStops: [
      [255, 94, 98],
      [255, 153, 102],
      [255, 206, 86],
      [238, 90, 111],
      [155, 89, 182],
    ],
  },
  {
    id: 'matcha',
    name: 'Matcha Latte',
    description: 'Serene Japanese tea house with matcha green and pistachio',
    colors: {
      act: '\x1b[38;2;168;218;220m',
      plan: '\x1b[38;2;233;196;106m',
      success: '\x1b[38;2;82;183;136m',
      error: '\x1b[38;2;231;111;81m',
      warning: '\x1b[38;2;244;162;97m',
      gray: '\x1b[38;2;141;153;174m',
      grayDark: '\x1b[38;2;61;64;53m',
      fg: '\x1b[38;2;244;241;222m',
      bgUser: '\x1b[48;2;28;36;26m',
      rule: '\x1b[38;2;88;129;87m',
      pink: '\x1b[38;2;221;161;94m',
      magenta: '\x1b[38;2;96;108;56m',
      violet: '\x1b[38;2;131;149;205m',
      cyan: '\x1b[38;2;116;198;157m',
      lime: '\x1b[38;2;149;213;178m',
      orange: '\x1b[38;2;188;108;37m',
      teal: '\x1b[38;2;45;106;79m',
    },
    splashStops: [
      [138, 171, 103],
      [184, 207, 139],
      [225, 238, 194],
      [92, 131, 64],
      [163, 197, 134],
    ],
  },
];

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
