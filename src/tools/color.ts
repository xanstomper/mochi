// Native tool: color
// Terminal color/styling utilities: strip ANSI, palette, demo, convert.

import type { Tool } from './types.js';

// ANSI escape strip regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const PALETTE = [
  { name: 'reset',   hex: '#ffffff', ansi: '\x1b[0m' },
  { name: 'black',   hex: '#000000', ansi: '\x1b[30m' },
  { name: 'red',     hex: '#cc0000', ansi: '\x1b[31m' },
  { name: 'green',   hex: '#00cc00', ansi: '\x1b[32m' },
  { name: 'yellow',  hex: '#cccc00', ansi: '\x1b[33m' },
  { name: 'blue',    hex: '#0000cc', ansi: '\x1b[34m' },
  { name: 'magenta', hex: '#cc00cc', ansi: '\x1b[35m' },
  { name: 'cyan',    hex: '#00cccc', ansi: '\x1b[36m' },
  { name: 'white',   hex: '#cccccc', ansi: '\x1b[37m' },
  { name: 'gray',    hex: '#888888', ansi: '\x1b[90m' },
  // bright
  { name: 'bright-red',     hex: '#ff4444', ansi: '\x1b[91m' },
  { name: 'bright-green',   hex: '#44ff44', ansi: '\x1b[92m' },
  { name: 'bright-yellow',  hex: '#ffff44', ansi: '\x1b[93m' },
  { name: 'bright-blue',    hex: '#4444ff', ansi: '\x1b[94m' },
  { name: 'bright-magenta', hex: '#ff44ff', ansi: '\x1b[95m' },
  { name: 'bright-cyan',    hex: '#44ffff', ansi: '\x1b[96m' },
  { name: 'bright-white',   hex: '#ffffff', ansi: '\x1b[97m' },
  // mochi theme
  { name: 'mochi-orange',   hex: '#ff7043', ansi: '\x1b[38;2;255;112;67m' },
  { name: 'mochi-violet',   hex: '#7c4dff', ansi: '\x1b[38;2;124;77;255m' },
  { name: 'mochi-teal',     hex: '#00bcd4', ansi: '\x1b[38;2;0;188;212m' },
];

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function rgbToAnsi(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

export const colorTool: Tool = {
  def: {
    name: 'color',
    description: 'Terminal color utilities: strip ANSI codes, show palette, demo all colors, or convert between hex/rgb/ansi.',
    parameters: [
      { name: 'action', type: 'string', description: "'strip' | 'palette' | 'demo' | 'convert'", required: true },
      { name: 'input', type: 'string', description: 'String to strip ANSI from (for strip), or color value to convert', required: false },
      { name: 'format', type: 'string', description: "Target format for convert: 'hex' | 'rgb' | 'ansi'", required: false },
    ],
    permission: 'read',
  },
  async execute(args) {
    const action = String(args.action || '').toLowerCase();

    switch (action) {
      case 'strip': {
        const input = String(args.input ?? '');
        return input.replace(ANSI_RE, '');
      }

      case 'palette': {
        return JSON.stringify(PALETTE, null, 2);
      }

      case 'demo': {
        const reset = '\x1b[0m';
        return PALETTE.filter(p => p.name !== 'reset').map(p =>
          `${p.ansi}${p.name.padEnd(20)}${reset}  ${p.hex}`
        ).join('\n');
      }

      case 'convert': {
        const input = String(args.input ?? '').trim();
        const format = String(args.format ?? 'ansi').toLowerCase();

        // detect input type
        if (input.startsWith('#') || /^[0-9a-f]{6}$/i.test(input)) {
          const rgb = hexToRgb(input);
          if (!rgb) throw new Error(`Invalid hex color: ${input}`);
          const [r, g, b] = rgb;
          if (format === 'rgb') return `rgb(${r}, ${g}, ${b})`;
          if (format === 'ansi') return rgbToAnsi(r, g, b) + `■${reset}\x1b[0m (${input})`;
          return input.startsWith('#') ? input : `#${input}`;
        }

        const rgbMatch = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(input);
        if (rgbMatch) {
          const [r, g, b] = rgbMatch.slice(1).map(Number) as [number, number, number];
          if (format === 'hex') return rgbToHex(r, g, b);
          if (format === 'ansi') return rgbToAnsi(r, g, b) + `■\x1b[0m`;
          return input;
        }

        // named palette lookup
        const found = PALETTE.find(p => p.name === input.toLowerCase());
        if (found) {
          if (format === 'hex') return found.hex;
          if (format === 'rgb') { const rgb = hexToRgb(found.hex); return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : found.hex; }
          return found.ansi + `■\x1b[0m (${found.name})`;
        }

        throw new Error(`Cannot parse color: "${input}". Use #hex, rgb(r,g,b), or a palette name.`);
      }

      default:
        throw new Error(`Unknown color action: ${action}. Use strip|palette|demo|convert.`);
    }
  },
};

const reset = '\x1b[0m';
