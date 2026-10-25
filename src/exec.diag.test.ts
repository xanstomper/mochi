// DIAGNOSTIC (probe only): what happens on this platform when a spawn fails
// under an ALREADY-aborted signal?
import { describe, it, expect } from 'vitest';
import { runShellString } from './exec.js';

describe('diagnostic: aborted-signal + failing spawn', () => {
  it('reports the outcome', async () => {
    const c = new AbortController();
    c.abort();
    const started = Date.now();
    const outcome = await Promise.race([
      runShellString('echo never-runs', { timeoutMs: 20_000, signal: c.signal, cwd: '/definitely/not/a/real/dir' })
        .then((r) => `resolved code=${r.code} cancelled=${r.cancelled}`)
        .catch((e) => `rejected ${String(e?.message ?? e).slice(0, 80)}`),
      new Promise<string>((res) => setTimeout(() => res('HUNG (no settle in 8s)'), 8000)),
    ]);
    console.log('[diag57]', process.platform, 'SHELL=' + process.env.SHELL, outcome, 'after', Date.now() - started, 'ms');
    expect(true).toBe(true);
  }, 30_000);

  it('reports the outcome with a missing shell binary', async () => {
    const c = new AbortController();
    c.abort();
    const started = Date.now();
    const outcome = await Promise.race([
      runShellString('echo never-runs', { timeoutMs: 20_000, signal: c.signal, shellBin: '/definitely/not/a/real/shell' })
        .then((r) => `resolved code=${r.code} cancelled=${r.cancelled}`)
        .catch((e) => `rejected ${String(e?.message ?? e).slice(0, 80)}`),
      new Promise<string>((res) => setTimeout(() => res('HUNG (no settle in 8s)'), 8000)),
    ]);
    console.log('[diag57b]', process.platform, outcome, 'after', Date.now() - started, 'ms');
    expect(true).toBe(true);
  }, 30_000);
});
