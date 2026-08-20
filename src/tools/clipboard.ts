import { execFile } from 'node:child_process';
import type { Tool } from './types.js';

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function clipboardRead(): Promise<string> {
  // Try in order: xclip, xsel, pbpaste, wl-paste
  for (const [cmd, cmdArgs] of [
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']],
    ['pbpaste', []],
    ['wl-paste', []],
  ] as [string, string[]][]) {
    try {
      return (await run(cmd, cmdArgs)).trimEnd();
    } catch {
      // try next
    }
  }
  return 'Error: No clipboard utility found. Install xclip, xsel, wl-paste, or use macOS pbpaste.';
}

async function clipboardWrite(text: string): Promise<void> {
  for (const [cmd, cmdArgs] of [
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
    ['pbcopy', []],
    ['wl-copy', []],
  ] as [string, string[]][]) {
    try {
      await run(cmd, cmdArgs, text);
      return;
    } catch {
      // try next
    }
  }
  throw new Error('No clipboard utility found. Install xclip, xsel, wl-copy, or use macOS pbcopy.');
}

export const clipboardTool: Tool = {
  def: {
    name: 'clipboard',
    description:
      'Read from or write to the system clipboard. ' +
      'Requires xclip, xsel, wl-copy, or pbcopy/pbpaste to be installed.',
    parameters: [
      { name: 'action', type: 'string', description: '"read" to read clipboard contents, "write" to set clipboard contents', required: true },
      { name: 'text', type: 'string', description: 'Text to write (required when action="write")', required: false },
    ],
    permission: 'shell',
  },
  async execute(args) {
    const action = String(args.action ?? '').toLowerCase();
    if (action === 'read') {
      return await clipboardRead();
    } else if (action === 'write') {
      const text = String(args.text ?? '');
      await clipboardWrite(text);
      return `Wrote ${text.length} character(s) to clipboard.`;
    } else {
      throw new Error('action must be "read" or "write"');
    }
  },
};
