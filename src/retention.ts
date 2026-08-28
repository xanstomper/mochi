// Disk retention / GC (master rebuild hygiene): bounded cleanup of session state
// (.mochi/state) and trace files (.mochi/traces) so long-lived agents don't
// accumulate unbounded disk usage.
import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RetentionResult {
  deletedFiles: number;
  freedBytes: number;
  remainingFiles: number;
}

const DEFAULT_AGE_DAYS = 14;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB cap per category (advisory)

function pruneDir(dirPath: string, maxAgeMs: number): RetentionResult {
  const res: RetentionResult = { deletedFiles: 0, freedBytes: 0, remainingFiles: 0 };
  if (!existsSync(dirPath)) return res;
  try {
    const files = readdirSync(dirPath);
    for (const f of files) {
      // Only handle session/traces artifacts (not subdirectories or hidden files)
      if (f.startsWith('.')) continue;
      const fp = resolve(dirPath, f);
      try {
        const s = statSync(fp);
        if (!s.isFile()) continue;
        const age = Date.now() - s.mtimeMs;
        if (age > maxAgeMs) {
          const size = s.size;
          unlinkSync(fp);
          res.deletedFiles++;
          res.freedBytes += size;
        } else {
          res.remainingFiles++;
        }
      } catch {
        // File deleted between readdir and stat: ignore.
      }
    }
  } catch {
    // Directory unreadable: skip (e.g. permissions changed).
  }
  return res;
}

export function runRetention(opts: {
  workspaceDir: string;
  maxAgeDays?: number;
}): { state: RetentionResult; traces: RetentionResult; logPath: string } {
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const workspaceDir = resolve(opts.workspaceDir);
  const stateDir = resolve(workspaceDir, 'state');
  const tracesDir = resolve(workspaceDir, 'traces');
  const stateRes = pruneDir(stateDir, maxAgeMs);
  const tracesRes = pruneDir(tracesDir, maxAgeMs);
  const logDir = resolve(workspaceDir, 'logs');
  try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  const logPath = resolve(logDir, 'retention.log');
  const line = `[${new Date().toISOString()}] retention: state deleted=${stateRes.deletedFiles} freed=${stateRes.freedBytes} remaining=${stateRes.remainingFiles}; traces deleted=${tracesRes.deletedFiles} freed=${tracesRes.freedBytes} remaining=${tracesRes.remainingFiles}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // Best-effort log: never fail repair because of a log write failure.
  }
  return { state: stateRes, traces: tracesRes, logPath };
}
