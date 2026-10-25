// DIAGNOSTIC probe: where exactly does the already-aborted-spawn path block?
import { describe, it, expect } from 'vitest';
import { runShellString } from './exec.js';

describe('diag', () => {
  it('prints before/after the aborted spawn', async () => {
    console.log('[diag] start platform=' + process.platform + ' SHELL=' + process.env.SHELL + ' pid=' + process.pid);
    const c = new AbortController();
    c.abort();
    console.log('[diag] calling runShellString');
    const p = runShellString('echo never-runs', {
      timeoutMs: 20_000,
      signal: c.signal,
      cwd: '/definitely/not/a/real/dir',
    });
    console.log('[diag] runShellString returned (promise created)');
    const outcome = await Promise.race([
      p.then((r) => 'resolved code=' + r.code, (e) => 'rejected ' + String(e?.message ?? e).slice(0, 60)),
      new Promise<string>((res) => setTimeout(() => res('HUNG'), 5000)),
    ]);
    console.log('[diag] outcome=' + outcome);
    expect(true).toBe(true);
  }, 30_000);
});
