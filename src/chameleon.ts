import { execFile } from 'node:child_process';

// Lazy Chameleon integration. The external `chameleon` CLI (Python) synthesizes
// "synthetic-parameter" reasoning context for a task. We shell out to it and
// return the context block, which Mochi injects into the agent's context to
// make a cheap model reason more like a frontier model.

export interface EnhanceOptions {
  task: string;
  mode?: string; // flash|turbo|easy|medium|hard|extreme|deep|genius|god|auto
  offline?: boolean;
  json?: boolean;
}

const CHAMELEON_BIN = process.env.CHAMELEON_BIN || 'chameleon';

/** Return the configured Chameleon binary path ('' when none configured). */
export function chameleonBin(): string {
  return CHAMELEON_BIN;
}

/** Real availability check: does an executable exist on PATH? */
export function chameleonAvailable(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('sh', ['-c', `command -v ${CHAMELEON_BIN}`], { timeout: 5000 }, (err) => {
      resolvePromise(!err);
    });
  });
}

/** Run `chameleon enhance` and return the generated context. */
export async function enhance(opts: EnhanceOptions): Promise<string> {
  const argv = ['enhance', opts.task, '--mode', opts.mode ?? 'auto'];
  if (opts.offline !== false) argv.push('--offline');
  if (opts.json) argv.push('--json');
  return new Promise((resolvePromise, reject) => {
    execFile(CHAMELEON_BIN, argv, { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const out = (stdout || '').trim();
        reject(new Error(out || `${err.message} ${String(stderr).trim()}`.trim() || 'chameleon unavailable'));
        return;
      }
      resolvePromise(String(stdout));
    });
  });
}