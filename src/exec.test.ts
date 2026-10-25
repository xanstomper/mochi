// Central exec policy: timeouts, output caps, argv-vs-shell separation.
import { describe, it, expect } from 'vitest';
import { runArgv, runShellString, execArgvText } from './exec.js';

describe('exec policy', () => {
  it('runArgv captures stdout with exit code', async () => {
    const r = await runArgv('echo', ['hello']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
    expect(r.timedOut).toBe(false);
  });

  it('runArgv never invokes a shell (no interpolation)', async () => {
    const r = await runArgv('echo', ['a;touch /tmp/mochi-exec-probe-xyz']);
    expect(r.stdout).toContain('a;touch /tmp/mochi-exec-probe-xyz');
    const { existsSync } = await import('node:fs');
    expect(existsSync('/tmp/mochi-exec-probe-xyz')).toBe(false);
  });

  it('runShellString supports pipes (the feature shell mode exists for)', async () => {
    const r = await runShellString('echo hello | tr a-z A-Z');
    expect(r.stdout.trim()).toBe('HELLO');
  });

  it('times out and reports timedOut instead of hanging', async () => {
    const r = await runShellString('sleep 30', { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  }, 60_000);

  it('aborts on signal with cancelled=true', async () => {
    const c = new AbortController();
    const p = runShellString('sleep 30', { timeoutMs: 20_000, signal: c.signal });
    setTimeout(() => c.abort(), 100);
    const r = await p;
    expect(r.cancelled).toBe(true);
  }, 60_000);

  it('pre-aborted signal + failing spawn rejects (handled) instead of crashing on an unhandled error event', async () => {
    // The old early-return skipped 'error'/'close' listener attachment when
    // the signal was ALREADY aborted: a spawn failing under an aborted signal
    // (nonexistent cwd here → ENOENT) emitted 'error' with NO listener — an
    // unhandled 'error' event on a ChildProcess THROWS and can crash the
    // host process. Now the listeners exist first, so the failure arrives as
    // an ordinary handled rejection — consistent with the non-aborted path,
    // where a failed spawn also rejects.
    const c = new AbortController();
    c.abort();
    await expect(
      runShellString('echo never-runs', { timeoutMs: 20_000, signal: c.signal, cwd: '/definitely/not/a/real/dir' }),
    ).rejects.toThrow();
  }, 60_000);

  it.skipIf(process.platform === 'win32')('kills the whole process TREE on timeout, not just the direct child', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'mochi-exec-tree-'));
    const pidFile = join(dir, 'grandchild.pid');
    // The shell backgrounds a grandchild (`sleep`) that records its PID, then
    // waits. Before the group-kill fix, only the direct `bash` child was
    // signalled and this `sleep` was orphaned (still alive after the timeout).
    const r = await runShellString(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`, { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isFinite(grandchildPid)).toBe(true);
    await new Promise((res) => setTimeout(res, 1_000));
    let alive = true;
    try { process.kill(grandchildPid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 30_000);

  it('truncates firehose output at the cap — keeping BOTH ends', async () => {
    // seq 1 200000: the head alone is lines 1..N; the failure-summary tail
    // (here the LAST lines) must survive too — head-only truncation (the old
    // behavior) made models re-run failed commands to see the end.
    const r = await runShellString('seq 1 200000', { maxOutput: 4096, timeoutMs: 15_000 });
    expect(r.stdout.length).toBeLessThan(9000);
    expect(r.stdout).toContain('[truncated]');
    expect(r.stdout).toContain('200000'); // the tail survived
    expect(r.stdout.startsWith('1\n')).toBe(true); // the head survived
  }, 60_000);

  it('execArgvText resolves stdout and rejects on failure', async () => {
    await expect(execArgvText('echo', ['ok'])).resolves.toContain('ok');
    await expect(execArgvText('sh', ['-c', 'exit 3'])).rejects.toThrow();
  });

  it('audit hook fires exactly once per run', async () => {
    let calls = 0;
    await runArgv('true', [], { onAudit: () => { calls++; } });
    expect(calls).toBe(1);
  });
});

describe('bubblewrap sandbox', () => {
  it('builds a least-privilege argv (ro root, rw cwd/tmp/caches, dev+proc)', async () => {
    const { buildBubblewrapArgs } = await import('./exec.js');
    const argv = buildBubblewrapArgs('/usr/bin/bwrap', 'npm', ['test'], { cwd: '/work/proj' });
    expect(argv[0]).toBe('/usr/bin/bwrap');
    expect(argv).toContain('/');
    const roIdx = argv.indexOf('--ro-bind');
    expect(argv[roIdx + 1]).toBe('/');
    expect(argv).toContain('/work/proj');
    const bindIdx = argv.indexOf('--bind');
    expect(argv[bindIdx + 1]).toBe('/work/proj');
    expect(argv).toContain('--dev');
    expect(argv).toContain('--proc');
    expect(argv).toContain('--tmpfs');
    expect(argv.slice(-2)).toEqual(['npm', 'test']);
    expect(argv).not.toContain('--unshare-net'); // network shared by default
  });

  it('unshares network only when asked', async () => {
    const { buildBubblewrapArgs } = await import('./exec.js');
    expect(buildBubblewrapArgs('/usr/bin/bwrap', 'x', [], { network: false })).toContain('--unshare-net');
  });

  it('maybeSandbox passes through when off; forced mode needs bwrap', async () => {
    const { maybeSandbox, detectBubblewrap } = await import('./exec.js');
    expect(maybeSandbox('echo', ['hi'], {})).toEqual({ cmd: 'echo', args: ['hi'] });
    expect(maybeSandbox('echo', ['hi'], { sandbox: { mode: 'off' } })).toEqual({ cmd: 'echo', args: ['hi'] });
    if (detectBubblewrap()) {
      // Forced mode wraps through the real binary on this box.
      const w = maybeSandbox('echo', ['hi'], { sandbox: { mode: 'bubblewrap' } });
      expect(w.cmd).toContain('bwrap');
      expect(w.args.slice(-2)).toEqual(['echo', 'hi']);
    } else {
      // No bwrap: explicit request fails loudly, never silently unsandboxed.
      expect(() => maybeSandbox('echo', ['hi'], { sandbox: { mode: 'bubblewrap' } })).toThrow(/bwrap.*not found/);
    }
  });

  it('detectBubblewrap finds bwrap on PATH (or skips live tests)', async () => {
    const { detectBubblewrap } = await import('./exec.js');
    const found = detectBubblewrap('/nonexistent-dir-xyz');
    expect(found).toBeNull();
  });

  it('runs a real command inside bwrap when available', async () => {
    const { detectBubblewrap, runArgv } = await import('./exec.js');
    if (!detectBubblewrap()) return; // no bwrap on this box: unit coverage above suffices
    const r = await runArgv('echo', ['sandboxed-ok'], { sandbox: { mode: 'bubblewrap' }, timeoutMs: 20_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sandboxed-ok');
  }, 30_000);

  it('sandbox cannot see the real home dotfiles (ro-root proof)', async () => {
    const { detectBubblewrap, runArgv } = await import('./exec.js');
    if (!detectBubblewrap()) return;
    // $HOME itself is read-only inside: creating a file there must fail.
    const unique = `.mochi-sandbox-probe-${Date.now()}`;
    const r = await runArgv('sh', ['-c', `touch "$HOME/${unique}" 2>&1; echo "exit=$?"`], {
      sandbox: { mode: 'bubblewrap' },
      timeoutMs: 20_000,
    });
    expect(r.stdout).toContain('exit=1');
  });
});

describe('exec ceilings (W3-5, prlimit-backed)', () => {
  it('CPU ceiling kills a busy loop with a labeled result (signal kill, not a timeout)', async () => {
    // Live evidence for detectCeilingHit's attribution: prlimit --cpu=1s
    // (soft==hard) ends the busy child with SIGKILL. `sh -c` execs a single
    // simple command in-place, so the close event carries the SIGNAL
    // (code=null, signal SIGKILL) — the ceiling label is the visible truth.
    const r = await runShellString('node -e "const t=Date.now(); while(Date.now()-t<20000){}"', {
      cpuLimitSeconds: 1,
      timeoutMs: 30_000,
    });
    expect(r.ceilings?.applied).toBe(true);
    expect(r.ceilings?.ceilingHit).toBe('cpu');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBeNull(); // killed by signal (RLIMIT_CPU), not exited
  }, 30_000);

  it('memory ceiling kills a big allocator with a labeled result', async () => {
    const r = await runShellString('node -e "const a=[];for(let i=0;i<400;i++)a.push(new Array(64*1024*1024).fill(1))"', {
      memoryLimitMb: 256,
      timeoutMs: 30_000,
    });
    expect(r.ceilings?.applied).toBe(true);
    expect(r.ceilings?.ceilingHit).toBe('memory');
    expect(r.timedOut).toBe(false);
  }, 30_000);

  it('a command within the ceilings runs normally and stays unlabeled', async () => {
    const r = await runArgv('echo', ['ok'], { cpuLimitSeconds: 10, memoryLimitMb: 1024 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
    expect(r.ceilings?.applied).toBe(true);
    expect(r.ceilings?.ceilingHit).toBeUndefined();
  });

  it('no ceilings requested: result shape unchanged (no ceilings field)', async () => {
    const r = await runShellString('echo plain');
    expect(r.stdout.trim()).toBe('plain');
    expect(r.ceilings).toBeUndefined();
  });

  it('prlimit unavailable: ceilings reported NOT applied (never silent)', async () => {
    const { runArgv: argvExec, _resetExecCeilingProbeForTests } = await import('./exec.js');
    _resetExecCeilingProbeForTests();
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-mochi-probe-dir';
    try {
      // Absolute cmd so the spawn itself works despite the neutered PATH.
      const r = await argvExec('/bin/echo', ['hi'], { cpuLimitSeconds: 5 });
      expect(r.stdout.trim()).toBe('hi');
      expect(r.ceilings?.applied).toBe(false);
      expect(r.ceilings?.ceilingHit).toBeUndefined();
    } finally {
      process.env.PATH = origPath;
      _resetExecCeilingProbeForTests();
    }
  });
});
