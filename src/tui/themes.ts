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
    id: 'cyber-void',
    name: 'Cyber Void',
    description: 'Dark purple/black with neon cyan, hot pink, and lime green',
    colors: {
      act: '\x1b[38;2;0;255;255m',
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
    splashStops: [
      [0, 255, 255],
      [255, 0, 255],
      [57, 255, 20],
      [255, 20, 147],
      [138, 43, 226],
    ],
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    description: '80s aesthetic: Teal, magenta, peach, and lavender',
    colors: {
      act: '\x1b[38;2;0;255;204m',
      plan: '\x1b[38;2;255;182;193m',
      success: '\x1b[38;2;152;251;152m',
      error: '\x1b[38;2;255;105;180m',
      warning: '\x1b[38;2;255;160;122m',
      gray: '\x1b[38;2;169;169;169m',
      grayDark: '\x1b[38;2;105;105;105m',
      fg: '\x1b[38;2;224;255;255m',
      bgUser: '\x1b[48;2;40;20;60m',
      rule: '\x1b[38;2;255;0;255m',
      pink: '\x1b[38;2;255;192;203m',
      magenta: '\x1b[38;2;255;0;255m',
      violet: '\x1b[38;2;216;191;216m',
      cyan: '\x1b[38;2;0;255;204m',
      lime: '\x1b[38;2;144;238;144m',
      orange: '\x1b[38;2;255;160;122m',
      teal: '\x1b[38;2;32;178;170m',
    },
    splashStops: [
      [0, 255, 204],
      [255, 0, 255],
      [255, 182, 193],
      [216, 191, 216],
      [255, 160, 122],
    ],
  },
  {
    id: 'solar-flare',
    name: 'Solar Flare',
    description: 'Deep space black with intense orange, sunburst yellow, and red',
    colors: {
      act: '\x1b[38;2;255;215;0m',
      plan: '\x1b[38;2;255;140;0m',
      success: '\x1b[38;2;255;255;0m',
      error: '\x1b[38;2;255;69;0m',
      warning: '\x1b[38;2;255;99;71m',
      gray: '\x1b[38;2;112;128;144m',
      grayDark: '\x1b[38;2;47;79;79m',
      fg: '\x1b[38;2;255;250;240m',
      bgUser: '\x1b[48;2;10;0;0m',
      rule: '\x1b[38;2;139;0;0m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;220;20;60m',
      violet: '\x1b[38;2;138;43;226m',
      cyan: '\x1b[38;2;0;206;209m',
      lime: '\x1b[38;2;173;255;47m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    splashStops: [
      [255, 69, 0],
      [255, 140, 0],
      [255, 215, 0],
      [255, 255, 0],
      [220, 20, 60],
    ],
  },
  {
    id: 'deep-sea',
    name: 'Deep Sea',
    description: 'Bioluminescent aqua, sea green, and coral on dark blue',
    colors: {
      act: '\x1b[38;2;0;255;255m',
      plan: '\x1b[38;2;64;224;208m',
      success: '\x1b[38;2;46;139;87m',
      error: '\x1b[38;2;255;127;80m',
      warning: '\x1b[38;2;255;160;122m',
      gray: '\x1b[38;2;119;136;153m',
      grayDark: '\x1b[38;2;47;79;79m',
      fg: '\x1b[38;2;240;255;255m',
      bgUser: '\x1b[48;2;0;0;30m',
      rule: '\x1b[38;2;0;139;139m',
      pink: '\x1b[38;2;255;182;193m',
      magenta: '\x1b[38;2;218;112;214m',
      violet: '\x1b[38;2;147;112;219m',
      cyan: '\x1b[38;2;0;255;255m',
      lime: '\x1b[38;2;0;250;154m',
      orange: '\x1b[38;2;255;127;80m',
      teal: '\x1b[38;2;32;178;170m',
    },
    splashStops: [
      [0, 255, 255],
      [64, 224, 208],
      [46, 139, 87],
      [255, 127, 80],
      [0, 250, 154],
    ],
  },
  {
    id: 'autumn-leaves',
    name: 'Autumn Leaves',
    description: 'Warm browns, burnt orange, goldenrod, and olive green',
    colors: {
      act: '\x1b[38;2;218;165;32m',
      plan: '\x1b[38;2;205;133;63m',
      success: '\x1b[38;2;107;142;35m',
      error: '\x1b[38;2;178;34;34m',
      warning: '\x1b[38;2;255;140;0m',
      gray: '\x1b[38;2;139;137;137m',
      grayDark: '\x1b[38;2;85;85;85m',
      fg: '\x1b[38;2;255;248;220m',
      bgUser: '\x1b[48;2;40;20;10m',
      rule: '\x1b[38;2;139;69;19m',
      pink: '\x1b[38;2;219;112;147m',
      magenta: '\x1b[38;2;199;21;133m',
      violet: '\x1b[38;2;139;0;139m',
      cyan: '\x1b[38;2;72;209;204m',
      lime: '\x1b[38;2;154;205;50m',
      orange: '\x1b[38;2;255;69;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    splashStops: [
      [218, 165, 32],
      [255, 140, 0],
      [178, 34, 34],
      [107, 142, 35],
      [205, 133, 63],
    ],
  },
  {
    id: 'retro-arcade',
    name: 'Retro Arcade',
    description: 'True black with bright arcade pacman colors',
    colors: {
      act: '\x1b[38;2;255;255;0m',
      plan: '\x1b[38;2;0;255;255m',
      success: '\x1b[38;2;57;255;20m',
      error: '\x1b[38;2;255;0;0m',
      warning: '\x1b[38;2;255;165;0m',
      gray: '\x1b[38;2;128;128;128m',
      grayDark: '\x1b[38;2;64;64;64m',
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
    splashStops: [
      [255, 255, 0],
      [255, 0, 0],
      [0, 255, 255],
      [57, 255, 20],
      [255, 165, 0],
    ],
  },
  {
    id: 'cotton-candy',
    name: 'Cotton Candy',
    description: 'Very light pastel pink and blue background with soft white',
    colors: {
      act: '\x1b[38;2;135;206;235m',
      plan: '\x1b[38;2;255;182;193m',
      success: '\x1b[38;2;152;251;152m',
      error: '\x1b[38;2;255;99;71m',
      warning: '\x1b[38;2;255;218;185m',
      gray: '\x1b[38;2;169;169;169m',
      grayDark: '\x1b[38;2;105;105;105m',
      fg: '\x1b[38;2;255;250;250m',
      bgUser: '\x1b[48;2;70;50;80m',
      rule: '\x1b[38;2;216;191;216m',
      pink: '\x1b[38;2;255;192;203m',
      magenta: '\x1b[38;2;255;105;180m',
      violet: '\x1b[38;2;221;160;221m',
      cyan: '\x1b[38;2;175;238;238m',
      lime: '\x1b[38;2;144;238;144m',
      orange: '\x1b[38;2;255;160;122m',
      teal: '\x1b[38;2;64;224;208m',
    },
    splashStops: [
      [255, 182, 193],
      [135, 206, 235],
      [221, 160, 221],
      [152, 251, 152],
      [255, 218, 185],
    ],
  },
  {
    id: 'hacker-terminal',
    name: 'Hacker Terminal',
    description: 'True black with varied shades of phosphor green',
    colors: {
      act: '\x1b[38;2;0;255;0m',
      plan: '\x1b[38;2;173;255;47m',
      success: '\x1b[38;2;50;205;50m',
      error: '\x1b[38;2;255;69;0m',
      warning: '\x1b[38;2;255;215;0m',
      gray: '\x1b[38;2;105;105;105m',
      grayDark: '\x1b[38;2;47;79;79m',
      fg: '\x1b[38;2;144;238;144m',
      bgUser: '\x1b[48;2;0;10;0m',
      rule: '\x1b[38;2;0;100;0m',
      pink: '\x1b[38;2;255;20;147m',
      magenta: '\x1b[38;2;139;0;139m',
      violet: '\x1b[38;2;148;0;211m',
      cyan: '\x1b[38;2;0;255;255m',
      lime: '\x1b[38;2;127;255;0m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    splashStops: [
      [0, 255, 0],
      [50, 205, 50],
      [173, 255, 47],
      [127, 255, 0],
      [144, 238, 144],
    ],
  },
  {
    id: 'midnight-jazz',
    name: 'Midnight Jazz',
    description: 'Deep indigo with smooth gold, silver, and plum accents',
    colors: {
      act: '\x1b[38;2;218;165;32m',
      plan: '\x1b[38;2;192;192;192m',
      success: '\x1b[38;2;102;205;170m',
      error: '\x1b[38;2;220;20;60m',
      warning: '\x1b[38;2;255;165;0m',
      gray: '\x1b[38;2;112;128;144m',
      grayDark: '\x1b[38;2;47;79;79m',
      fg: '\x1b[38;2;230;230;250m',
      bgUser: '\x1b[48;2;25;25;112m',
      rule: '\x1b[38;2;72;61;139m',
      pink: '\x1b[38;2;219;112;147m',
      magenta: '\x1b[38;2;139;0;139m',
      violet: '\x1b[38;2;147;112;219m',
      cyan: '\x1b[38;2;72;209;204m',
      lime: '\x1b[38;2;152;251;152m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;139;139m',
    },
    splashStops: [
      [218, 165, 32],
      [192, 192, 192],
      [221, 160, 221],
      [147, 112, 219],
      [139, 0, 139],
    ],
  },
  {
    id: 'desert-sand',
    name: 'Desert Sand',
    description: 'Sandy beige with terracotta, sage green, and twilight blue',
    colors: {
      act: '\x1b[38;2;70;130;180m',
      plan: '\x1b[38;2;222;184;135m',
      success: '\x1b[38;2;143;188;143m',
      error: '\x1b[38;2;205;92;92m',
      warning: '\x1b[38;2;210;105;30m',
      gray: '\x1b[38;2;139;137;137m',
      grayDark: '\x1b[38;2;105;105;105m',
      fg: '\x1b[38;2;255;248;220m',
      bgUser: '\x1b[48;2;60;50;40m',
      rule: '\x1b[38;2;188;143;143m',
      pink: '\x1b[38;2;255;182;193m',
      magenta: '\x1b[38;2;205;92;92m',
      violet: '\x1b[38;2;147;112;219m',
      cyan: '\x1b[38;2;95;158;160m',
      lime: '\x1b[38;2;189;183;107m',
      orange: '\x1b[38;2;244;164;96m',
      teal: '\x1b[38;2;47;79;79m',
    },
    splashStops: [
      [210, 105, 30],
      [222, 184, 135],
      [143, 188, 143],
      [70, 130, 180],
      [205, 92, 92],
    ],
  },
  {
    id: 'arctic-aurora',
    name: 'Arctic Aurora',
    description: 'Ice blue with vibrant aurora borealis greens and purples',
    colors: {
      act: '\x1b[38;2;0;255;255m',
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
    splashStops: [
      [0, 255, 255],
      [0, 250, 154],
      [138, 43, 226],
      [186, 85, 211],
      [127, 255, 0],
    ],
  },
  {
    id: 'ruby-rose',
    name: 'Ruby Rose',
    description: 'Rich burgundy with crimson, blush pink, and gold',
    colors: {
      act: '\x1b[38;2;255;182;193m',
      plan: '\x1b[38;2;255;215;0m',
      success: '\x1b[38;2;152;251;152m',
      error: '\x1b[38;2;255;0;0m',
      warning: '\x1b[38;2;255;140;0m',
      gray: '\x1b[38;2;169;169;169m',
      grayDark: '\x1b[38;2;128;0;0m',
      fg: '\x1b[38;2;255;240;245m',
      bgUser: '\x1b[48;2;40;0;10m',
      rule: '\x1b[38;2;139;0;0m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;220;20;60m',
      violet: '\x1b[38;2;199;21;133m',
      cyan: '\x1b[38;2;175;238;238m',
      lime: '\x1b[38;2;144;238;144m',
      orange: '\x1b[38;2;255;165;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    splashStops: [
      [220, 20, 60],
      [255, 182, 193],
      [255, 105, 180],
      [255, 215, 0],
      [199, 21, 133],
    ],
  },
  {
    id: 'neon-city',
    name: 'Neon City',
    description: 'Dark grey with electric blue, toxic yellow, blood red',
    colors: {
      act: '\x1b[38;2;0;191;255m',
      plan: '\x1b[38;2;173;255;47m',
      success: '\x1b[38;2;0;250;154m',
      error: '\x1b[38;2;220;20;60m',
      warning: '\x1b[38;2;255;140;0m',
      gray: '\x1b[38;2;169;169;169m',
      grayDark: '\x1b[38;2;105;105;105m',
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
    splashStops: [
      [0, 191, 255],
      [173, 255, 47],
      [220, 20, 60],
      [255, 20, 147],
      [0, 250, 154],
    ],
  },
  {
    id: 'pastel-goth',
    name: 'Pastel Goth',
    description: 'Charcoal black with bright pastel pink, purple, and mint',
    colors: {
      act: '\x1b[38;2;221;160;221m',
      plan: '\x1b[38;2;152;251;152m',
      success: '\x1b[38;2;175;238;238m',
      error: '\x1b[38;2;250;128;114m',
      warning: '\x1b[38;2;255;218;185m',
      gray: '\x1b[38;2;169;169;169m',
      grayDark: '\x1b[38;2;105;105;105m',
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
    splashStops: [
      [221, 160, 221],
      [152, 251, 152],
      [255, 182, 193],
      [175, 238, 238],
      [238, 130, 238],
    ],
  },
  {
    id: 'obsidian-gold',
    name: 'Obsidian Gold',
    description: 'Pure black with metallic gold, silver, and bronze',
    colors: {
      act: '\x1b[38;2;218;165;32m',
      plan: '\x1b[38;2;192;192;192m',
      success: '\x1b[38;2;184;134;11m',
      error: '\x1b[38;2;178;34;34m',
      warning: '\x1b[38;2;205;133;63m',
      gray: '\x1b[38;2;128;128;128m',
      grayDark: '\x1b[38;2;64;64;64m',
      fg: '\x1b[38;2;245;245;220m',
      bgUser: '\x1b[48;2;15;15;15m',
      rule: '\x1b[38;2;105;105;105m',
      pink: '\x1b[38;2;255;105;180m',
      magenta: '\x1b[38;2;218;112;214m',
      violet: '\x1b[38;2;186;85;211m',
      cyan: '\x1b[38;2;72;209;204m',
      lime: '\x1b[38;2;154;205;50m',
      orange: '\x1b[38;2;255;140;0m',
      teal: '\x1b[38;2;0;128;128m',
    },
    splashStops: [
      [218, 165, 32],
      [192, 192, 192],
      [184, 134, 11],
      [205, 133, 63],
      [255, 215, 0],
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
