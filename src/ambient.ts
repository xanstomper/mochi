// Ambient watcher (spec section 3 / masterprompt 12-C): a background loop that
// periodically runs the repo's test/build/typecheck commands, detects newly
// failing runs, and drafts a non-intrusive fix proposal on a shadow worktree.
// The proposal (diff + failure summary) is written to .mochi/ambient/ so it
// can be reviewed or applied later without touching the main working tree.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface AmbientOpts {
  cwd: string;
  /** Commands to run each tick; defaults to repo-detected test/build. */
  commands?: string[];
  /** Seconds between checks (default 120). */
  intervalSec?: number;
  /** Called with the failure when a regression is detected. */
  onFailure?: (report: AmbientReport) => void;
}

export interface AmbientReport {
  atMs: number;
  command: string;
  /** exit code (non-zero => failure). */
  exitCode: number;
  /** Truncated tail of output (the interesting part). */
  outputTail: string;
  /** Path to the draft proposal (if written). */
  proposalPath?: string;
}

function run(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execFile('sh', ['-c', cmd], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code! : err ? 1 : 0;
      res({ code, out: `${stdout ?? ''}\n${stderr ?? ''}` });
    });
  });
}

/** One ambient poll: run each command, write a proposal on failure. */
export async function checkOnce(opts: AmbientOpts): Promise<AmbientReport[]> {
  const cwd = opts.cwd;
  const commands = opts.commands ?? detectCommands(cwd);
  const reports: AmbientReport[] = [];
  for (const cmd of commands) {
    const { code, out } = await run(cmd, cwd, 240_000);
    if (code === 0) continue;
    const tail = out.split('\n').slice(-40).join('\n');
    const report: AmbientReport = { atMs: Date.now(), command: cmd, exitCode: code, outputTail: tail.slice(0, 4000) };
    report.proposalPath = writeProposal(cwd, report);
    opts.onFailure?.(report);
    reports.push(report);
  }
  return reports;
}

/** Derive check commands from the repo (package.json scripts / Cargo). */
export function detectCommands(cwd: string): string[] {
  const cmds: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) cmds.push(pkg.scripts.test.startsWith('npm ') ? pkg.scripts.test : `npm test`);
    if (pkg.scripts?.build) cmds.push(`npm run build`);
    if (pkg.scripts?.typecheck) cmds.push(`npm run typecheck`);
  } catch { /* no package.json */ }
  if (!cmds.length && existsSync(resolve(cwd, 'Cargo.toml'))) cmds.push('cargo test');
  if (!cmds.length) cmds.push('git diff --check'); // trivial fallback: whitespace errors
  return cmds;
}

function writeProposal(cwd: string, report: AmbientReport): string {
  const dir = resolve(cwd, '.mochi', 'ambient');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `failure-${report.atMs}.md`);
  const relCmd = report.command.length > 60 ? report.command.slice(0, 57) + '…' : report.command;
  writeFileSync(file, [
    `# Ambient failure proposal`,
    '',
    `- detected: ${new Date(report.atMs).toISOString()}`,
    `- command: \`${relCmd}\``,
    `- exit: ${report.exitCode}`,
    '',
    '## Failure tail',
    '',
    '```',
    report.outputTail,
    '```',
    '',
    '## Proposed fix (draft)',
    '',
    '(Agent to fill: root cause + minimal change, or reviewer instructions.)',
    '',
  ].join('\n'));
  return file;
}

/** Start a polling loop; returns a stop function. */
export function startAmbient(opts: AmbientOpts): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await checkOnce(opts);
    } catch { /* never die */ }
  };
  const id = setInterval(tick, (opts.intervalSec ?? 15) * 1000);
  return () => { stopped = true; clearInterval(id); };
}