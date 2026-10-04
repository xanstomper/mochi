// Tool usage telemetry for agent-authored tools. Mirrors skill-usage.json:
// a usage record per authored tool (calls, errors, totalMs, lastUsedAt) that
// the `list`/`show` actions surface, so the agent can see which of its own
// tools earn their keep.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AuthoredToolUsage {
  calls: number;
  errors: number;
  totalMs: number;
  lastUsedAt: number;
}

export type AuthoredToolUsageDB = Record<string, AuthoredToolUsage>;

const CAP = 500;

export function usageFilePath(projectDir: string): string {
  return resolve(projectDir, '.mochi', 'tools', 'usage.json');
}

export function loadToolUsage(projectDir: string): AuthoredToolUsageDB {
  try {
    return JSON.parse(readFileSync(usageFilePath(projectDir), 'utf8')) as AuthoredToolUsageDB;
  } catch {
    return {};
  }
}

export function saveToolUsage(projectDir: string, db: AuthoredToolUsageDB): void {
  mkdirSync(join(projectDir, '.mochi', 'tools'), { recursive: true });
  writeFileSync(usageFilePath(projectDir), JSON.stringify(db, null, 2));
}

/** Record one execution. Never throws — telemetry must not break tools. */
export function recordToolUsage(projectDir: string, name: string, opts: { error?: boolean; durationMs?: number }): void {
  try {
    const db = loadToolUsage(projectDir);
    const rec = db[name] ?? { calls: 0, errors: 0, totalMs: 0, lastUsedAt: 0 };
    rec.calls += 1;
    if (opts.error) rec.errors += 1;
    rec.totalMs += Math.max(0, opts.durationMs ?? 0);
    rec.lastUsedAt = Date.now();
    db[name] = rec;
    // Bound the file: drop the oldest half beyond CAP.
    const keys = Object.keys(db);
    if (keys.length > CAP) {
      keys.sort((a, b) => (db[a].lastUsedAt ?? 0) - (db[b].lastUsedAt ?? 0));
      for (const k of keys.slice(0, keys.length - CAP)) delete db[k];
    }
    saveToolUsage(projectDir, db);
  } catch { /* telemetry never breaks execution */ }
}

/** One-line usage summary for `tool_factory action="list"`. */
export function toolUsageLine(projectDir: string, name: string): string {
  const rec = loadToolUsage(projectDir)[name];
  if (!rec || rec.calls === 0) return 'never called';
  const errRate = rec.calls > 0 ? Math.round((rec.errors / rec.calls) * 100) : 0;
  return `${rec.calls} calls, ${errRate}% errors, avg ${Math.round(rec.totalMs / rec.calls)}ms`;
}
