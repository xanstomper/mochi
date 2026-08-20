// UNIX-pipe composability (spec Pillar 2): mochi review / mochi fix over
// stdin. Pure helpers here are unit-tested; Runtime.review / Runtime.fix run
// the actual agent work.
//
// Workflows:
//   git diff | mochi review --strict --json
//   cat crash.log | mochi fix --auto-commit
//   mochi review --diff-only          # print the raw unified diff
import { readFileSync } from 'node:fs';

export interface ReviewFinding {
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  file: string;
  line?: number;
  message: string;
  rule?: string;
}

const MAX_STDIN_BYTES = 1_000_000;

/** Read piped stdin (false when stdin is a TTY or has nothing to give). */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  if ('isTTY' in stream && (stream as any).isTTY) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_STDIN_BYTES) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a review summary into structured findings ([HIGH] file:line msg). */
export function parseFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[(HIGH|MEDIUM|LOW|INFO)\]\s*(.*)$/i);
    if (!m) continue;
    const severity = m[1].toUpperCase() as ReviewFinding['severity'];
    let rest = m[2].trim();
    // Strip an optional leading dash/em-dash separator ("file — msg").
    rest = rest.replace(/^\s*(?:[-—–]|:\s*)\s*/, '');
    const token = rest.split(/\s+/)[0] ?? '';
    // A file looks like a path: contains /, \, .ext, or a colon line ref.
    const fileMatch = token.match(/^([^\s:]+):(\d+)/);
    if (fileMatch) {
      findings.push({ severity, file: fileMatch[1], line: Number(fileMatch[2]), message: rest.replace(fileMatch[0], '').trim().slice(0, 400) });
      continue;
    }
    if (/[/\\]|\.\w{1,5}$/.test(token)) {
      const message = rest.replace(token, '').trim();
      findings.push({ severity, file: token, message: (message || token).slice(0, 400) });
      continue;
    }
    findings.push({ severity, file: '(unknown)', message: rest.slice(0, 400) });
  }
  return findings;
}

/** Render findings as NDJSON (one JSON object per line) for CI/CD. */
export function findingsToNdjson(findings: ReviewFinding[]): string {
  return findings.map((f) => JSON.stringify(f)).join('\n');
}

/** Print a human table of findings. */
export function renderFindings(findings: ReviewFinding[]): string {
  if (!findings.length) return '';
  return findings
    .map((f) => {
      const loc = f.file + (f.line ? `:${f.line}` : '');
      return `[${f.severity}] ${loc} — ${f.message}`;
    })
    .join('\n');
}

/** Count findings by severity. */
export function countBySeverity(findings: ReviewFinding[]): Record<ReviewFinding['severity'], number> {
  const out: Record<ReviewFinding['severity'], number> = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

/** Load a diff from files in argv order ([base, head]) or the working tree. */
export function loadDiff(files: string[], cwd: string): string {
  if (files.length >= 2) {
    let base = files[0];
    let head = files[1];
    if (head === '--cached' || head === '--staged') {
      return runGit(cwd, ['diff', '--cached', ...files.slice(2)]);
    }
    if (base === '--cached' || base === '--staged') {
      return runGit(cwd, ['diff', '--cached', ...files.slice(1)]);
    }
    if (base === 'HEAD') {
      return runGit(cwd, ['diff', 'HEAD', ...files.slice(2)]);
    }
    return runGit(cwd, ['diff', base, head, ...files.slice(2)]);
  }
  if (files.length === 1) {
    if (files[0] === '--cached' || files[0] === '--staged') return runGit(cwd, ['diff', '--cached']);
    return runGit(cwd, ['diff', files[0]]);
  }
  return runGit(cwd, ['diff']);
}

function runGit(cwd: string, args: string[]): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return execFileSync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    throw new Error(`git ${args.join(' ')} failed${stderr ? ': ' + stderr.trim() : ''}`);
  }
}

/** Read a local file into the prompt (bounded). */
export function readLocalInput(file: string): string {
  const raw = readFileSync(file, 'utf8');
  return raw.length > MAX_STDIN_BYTES ? raw.slice(0, MAX_STDIN_BYTES) : raw;
}