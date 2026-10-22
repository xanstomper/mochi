// Hermetic live proofs for Wave M (browser + general-automation depth).
//
// Everything runs against a LOCAL fixture site (node:http on an ephemeral
// port) — no external network, no real credentials. The suite is gated
// on the browser driver being able to run (playwright + a browser in the
// standard locations, or MOCHI_BROWSER_NODE_MODULES pointing at an
// install); without it the suite skips, matching the repo's live-test
// philosophy. Proofs:
//   (a) login-persist: log in under a named profile in one "run"; a new
//       run (fresh driver process) starts already authenticated;
//       revoking the profile makes the next run start logged out.
//   (b) a multi-step form flow driven by a11y observation + network-idle
//       class waits (response:, ::state:, ::text:), with the session
//       request log captured via netlog.
//   (c) a durable automation killed with SIGKILL mid-run resumes via the
//       run journal and completes exactly once — the fixture counts the
//       side effect, and it fires exactly one time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTool, driverScript } from './browser.js';
import { EventBus } from '../events.js';
import { addAutomation, listAutomations, runAutomation } from '../daemon/automation.js';
import type { ToolContext } from './types.js';

// ── Fixture site ─────────────────────────────────────────────────────────

interface Fixture { server: Server; base: string; counter: () => number; requests: string[] }

async function startFixture(): Promise<Fixture> {
  let count = 0;
  const requests: string[] = [];
  const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    requests.push(`${req.method} ${url.pathname}`);
    const send = (code: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    if (url.pathname === '/login') {
      return send(200, page(`<h1>Sign in</h1>
        <form method="post" action="/do-login">
          <label for="username">Username</label><input id="username" name="username" type="text">
          <label for="password">Password</label><input id="password" name="password" type="password">
          <button type="submit">Sign in</button>
        </form>`));
    }
    if (url.pathname === '/do-login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('username') === 'alice' && form.get('password') === 'wonderland') {
          return send(302, '', { location: '/home', 'set-cookie': 'session=alice; Path=/; HttpOnly' });
        }
        return send(401, page('<p>Invalid credentials</p>'));
      });
      return;
    }
    if (url.pathname === '/home') {
      const authed = (req.headers.cookie ?? '').includes('session=alice');
      return send(200, page(authed
        ? '<h1>Welcome, alice</h1><p>Your dashboard.</p>'
        : '<h1>You are logged out</h1><a href="/login">Sign in</a>'));
    }
    if (url.pathname === '/form') {
      return send(200, page(`<h1>Application</h1>
        <div id="step1">
          <label for="f-name">Full name</label><input id="f-name" type="text">
          <label for="f-email">Email</label><input id="f-email" type="email">
          <button id="next1" type="button">Next</button>
        </div>
        <div id="step2" style="display:none">
          <label for="f-plan">Plan</label>
          <select id="f-plan"><option value="basic">Basic</option><option value="pro">Pro</option></select>
          <label for="f-agree">I agree to the terms</label><input id="f-agree" type="checkbox">
          <button id="submit2" type="button" disabled>Submit application</button>
        </div>
        <p id="status" role="status"></p>
        <script>
          document.getElementById('next1').addEventListener('click', async () => {
            const name = document.getElementById('f-name').value;
            const email = document.getElementById('f-email').value;
            if (!name || !email) return;
            const r = await fetch('/api/step', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({name, email}) });
            if (r.ok) {
              document.getElementById('step1').style.display = 'none';
              document.getElementById('step2').style.display = 'block';
            }
          });
          document.getElementById('f-agree').addEventListener('change', (e) => {
            document.getElementById('submit2').disabled = !e.target.checked;
          });
          document.getElementById('submit2').addEventListener('click', async () => {
            const r = await fetch('/api/submit', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({plan: document.getElementById('f-plan').value}) });
            const data = await r.json();
            document.getElementById('status').textContent = 'Application complete ' + data.ref;
          });
        </script>`));
    }
    if (url.pathname === '/api/step' && req.method === 'POST') {
      // Real latency so the response: wait has something to wait for.
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 300);
    }
    if (url.pathname === '/api/submit' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ref: 'REF-42' }));
    }
    if (url.pathname === '/counter' && req.method === 'POST') {
      count++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ count }));
    }
    if (url.pathname === '/counter') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ count }));
    }
    return send(404, page('<h1>not found</h1>'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}`, counter: () => count, requests };
}

// ── Driver availability gate ─────────────────────────────────────────────

function probeDriverSync(): boolean {
  try {
    const stdout = execFileSync(process.execPath, [driverScript(), 'probe'], { timeout: 20_000, encoding: 'utf8' });
    const data = JSON.parse(String(stdout).trim()) as { playwright?: boolean; browsers?: string[] };
    return Boolean(data.playwright) && Array.isArray(data.browsers) && data.browsers.length > 0;
  } catch { return false; }
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

let fixture: Fixture;
// Probed synchronously at collection time: the describe-vs-skip decision
// is made when the suite is defined, before any hook runs.
const live = probeDriverSync();
let profilesDir: string;
let prevProfilesEnv: string | undefined;

const ctx = (): ToolContext => ({
  cwd: repoRoot,
  workspace: undefined as never,
  config: {} as never,
  events: new EventBus(),
  agentId: 'wave-m-proof',
});
const browse = (args: Record<string, unknown>) => browserTool.execute(args, ctx());

beforeAll(async () => {
  fixture = await startFixture();
  profilesDir = mkdtempSync(resolve(tmpdir(), 'mochi-proof-profiles-'));
  prevProfilesEnv = process.env.MOCHI_BROWSER_PROFILES_DIR;
  process.env.MOCHI_BROWSER_PROFILES_DIR = profilesDir;
}, 60_000);

afterAll(async () => {
  if (prevProfilesEnv === undefined) delete process.env.MOCHI_BROWSER_PROFILES_DIR;
  else process.env.MOCHI_BROWSER_PROFILES_DIR = prevProfilesEnv;
  rmSync(profilesDir, { recursive: true, force: true });
  await new Promise<void>((r) => fixture.server.close(() => r()));
});

const suite = (name: string, fn: () => void) => (live ? describe : describe.skip)(name, fn);

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── (a) login persistence across runs + revocation ──────────────────────

suite('proof (a): named-profile login persistence', () => {
  it('login persists into a new run; revocation returns the next run to logged-out', async () => {
    const profile = 'fixture-login';
    // Run 1: first use mints the profile — loudly, not silently. The
    // login itself is ONE batch: multiple actions on one page must share
    // a session (separate calls reopen the page, losing form state).
    const first = await browse({
      command: 'batch', profile,
      js: JSON.stringify([
        { command: 'navigate', args: [`${fixture.base}/login`] },
        { command: 'fill', args: ['#username', 'alice'] },
        { command: 'fill', args: ['#password', 'wonderland'] },
        { command: 'click', args: ['button[type=submit]'] },
        { command: 'waitfor', args: ['url:home'] },
      ]),
    });
    expect(first).toContain('created new profile "fixture-login"');
    expect(first).toContain('Welcome, alice');

    // Run 2: a brand-new driver process (every tool call is one) with the
    // same profile name starts ALREADY authenticated — no login steps.
    // (And it must be the PERSISTENT path — an ephemeral fallback is
    // reported loudly by the driver and would fail this proof visibly.)
    const run2 = await browse({ command: 'navigate', url: `${fixture.base}/home`, profile });
    expect(run2).not.toContain('ephemeral');
    expect(run2).toContain('Welcome, alice');
    expect(run2).not.toContain('created new profile');

    // The registry lists the credential store and where it has been.
    const listing = await browse({ command: 'profiles' });
    expect(listing).toContain('fixture-login');
    expect(listing).toContain('127.0.0.1');

    // Revoke: stored logins are destroyed; the next run starts logged out.
    const revoked = await browse({ command: 'revokeprofile', profile });
    expect(revoked).toContain('revoked');
    const run3 = await browse({ command: 'navigate', url: `${fixture.base}/home`, profile: 'post-revoke-check' });
    expect(run3).toContain('You are logged out');
    // And the revoked name itself is hard-blocked, not silently recreated.
    const blocked = await browse({ command: 'navigate', url: `${fixture.base}/home`, profile });
    expect(blocked).toContain('revoked');
  }, 120_000);
});

// ── (b) a11y + network waits + request log ──────────────────────────────

suite('proof (b): multi-step form via a11y observation and network waits', () => {
  it('completes the two-step form using response:/::state:/::text: waits, netlog captures the API calls', async () => {
    const profile = 'fixture-form';
    // Observe first via the accessibility tree (not DOM selectors) —
    // navigate + a11y in one session.
    const observe = await browse({
      command: 'batch', profile,
      js: JSON.stringify([
        { command: 'navigate', args: [`${fixture.base}/form`] },
        { command: 'a11y', args: [] },
      ]),
    });
    expect(observe).toContain('Full name');
    expect(observe).toContain('Next');

    // The whole flow in one session: fill step 1, click, wait on the
    // NETWORK for the fetch that renders step 2, observe step 2 via
    // a11y, then a selector-state wait for the button that enables only
    // after agreement, submit, and a text wait for completion.
    const flow = await browse({
      command: 'batch', profile,
      js: JSON.stringify([
        { command: 'fill', args: ['#f-name', 'Ada Lovelace'] },
        { command: 'fill', args: ['#f-email', 'ada@example.test'] },
        { command: 'click', args: ['#next1'] },
        { command: 'waitfor', args: ['response:/api/step'] },
        { command: 'a11y', args: [] },
        { command: 'select', args: ['#f-plan', 'pro'] },
        { command: 'click', args: ['#f-agree'] },
        { command: 'waitfor', args: ['#submit2::state:enabled'] },
        { command: 'click', args: ['#submit2'] },
        { command: 'waitfor', args: ['#status::text:Application complete'] },
      ]),
    });
    expect(flow).toContain('waited: response:/api/step');
    expect(flow).toContain('Plan');
    expect(flow).toContain('Submit application');
    expect(flow).toContain('waited: #submit2::state:enabled');
    expect(flow).toContain('Application complete REF-42');

    // The session's network log captured both API calls with statuses.
    const log = await browse({ command: 'netlog', profile });
    expect(log).toContain('/api/step');
    expect(log).toContain('/api/submit');
    expect(log).toContain('-> 200');
    // And the fixture agrees the flow really happened server-side.
    expect(fixture.requests).toContain('POST /api/step');
    expect(fixture.requests).toContain('POST /api/submit');
  }, 120_000);
});

// ── (c) SIGKILL mid-run -> journal resume -> exactly once ───────────────

describe('proof (c): SIGKILLed automation resumes via the journal, exactly once', () => {
  it('completes the killed slot with the counted side effect firing exactly one time', async () => {
    const ws = mkdtempSync(resolve(tmpdir(), 'mochi-proof-kill9-'));
    const marker = resolve(ws, 'gate-started');
    const slot = 'kill9-slot';
    try {
      const { id } = addAutomation(ws, {
        name: 'kill9-proof',
        trigger: { type: 'schedule', schedule: 'every 1h' },
        steps: [
          // The counted side effect: one POST per REAL execution.
          { id: 'hit', kind: 'shell', command: `node -e "fetch('${fixture.base}/counter',{method:'POST'}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"` },
          // The gate: first execution marks itself and hangs (the kill
          // lands here); a resume sees the marker and returns at once.
          { id: 'gate', kind: 'shell', command: `node -e "const fs=require('node:fs');if(!fs.existsSync('${marker}')){fs.writeFileSync('${marker}','1');setTimeout(()=>{},30000)}"` },
          { id: 'read', kind: 'fetch', url: `${fixture.base}/counter` },
        ],
      });
      expect(id).toBeTruthy();

      // Child process: runs the automation for real, gets SIGKILLed
      // mid-gate. Driven through tsx so it executes the same TS sources
      // (.mts: a bare .ts outside a type:module package compiles to CJS
      // under tsx and top-level await fails).
      const childScript = resolve(ws, 'child.mts');
      const automationUrl = pathToFileURL(resolve(repoRoot, 'src/daemon/automation.ts')).href;
      writeFileSync(childScript, [
        `import { listAutomations, runAutomation } from '${automationUrl}';`,
        `const [dir, slot] = process.argv.slice(2);`,
        `const auto = listAutomations(dir)[0];`,
        `await runAutomation(dir, auto, slot, {});`,
        `console.log('CHILD-COMPLETED');`,
      ].join('\n'));
      const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
      const child: ChildProcess = spawn(process.execPath, [tsxCli, childScript, ws, slot], { stdio: ['ignore', 'pipe', 'pipe'] });
      let childErr = '';
      child.stderr?.on('data', (d) => { childErr += String(d); });
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      // Wait until step 1's effect is counted AND step 2 has started —
      // step 1's journal append is fsynced before step 2 begins, so the
      // kill below lands strictly after 'hit' is durable.
      try {
        await waitFor(() => fixture.counter() >= 1 && existsSync(marker), 60_000, 'child to pass step 1 and enter the gate');
      } catch (e) {
        throw new Error(`${(e as Error).message}; child stderr: ${childErr.slice(-800)}`);
      }
      child.kill('SIGKILL');
      await exited;
      expect(fixture.counter()).toBe(1);
      // The resume handle survived the kill.
      expect(listAutomations(ws)[0].activeSlot).toBe(slot);

      // Resume in this process: 'hit' must REPLAY (counter stays 1),
      // the gate re-runs (marker present -> instant), 'read' executes.
      const result = await runAutomation(ws, listAutomations(ws)[0], slot, {});
      expect(result.replayed).toContain('hit');
      expect(result.executed).toEqual(['gate', 'read']);
      expect(fixture.counter()).toBe(1); // exactly once
      const rec = listAutomations(ws)[0];
      expect(rec.activeSlot).toBeNull();
      expect(rec.runs).toBe(1);
      expect(rec.lastSlot).toBe(slot);
      void childErr;
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);
});
