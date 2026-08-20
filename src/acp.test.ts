// ACP stdio server: JSON-RPC over newline-delimited JSON (editor protocol).
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

interface RpcClient {
  child: ChildProcessWithoutNullStreams;
  rl: Interface;
  nextId: number;
  requests: Map<number, (msg: any) => void>;
}

function connect(): Promise<RpcClient> {
  return new Promise((res) => {
    const child = spawn('node', [CLI, 'acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: child.stdout });
    const requests = new Map<number, (msg: any) => void>();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      const cb = requests.get(msg.id);
      if (cb) { requests.delete(msg.id); cb(msg); }
    });
    res({ child, rl, nextId: 1, requests });
  });
}

function send(client: RpcClient, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = client.nextId++;
  return new Promise((resolve2) => {
    client.requests.set(id, resolve2);
    client.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

async function close(client: RpcClient): Promise<void> {
  try { client.child.kill(); } catch { /* already gone */ }
  client.rl.close();
}

describe('ACP server', () => {
  it('initialize returns protocol metadata', async () => {
    const c = await connect();
    try {
      const r = await send(c, 'initialize');
      expect(r.result.protocolVersion).toBe(1);
      expect(r.result.capabilities).toContain('prompt');
    } finally { await close(c); }
  }, 30_000);

  it('session/new creates a session in a cwd', async () => {
    const c = await connect();
    try {
      const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-'));
      const r = await send(c, 'session/new', { cwd: dir });
      expect(r.result.sessionId).toBeTruthy();
      expect(r.result.cwd).toBe(resolve(dir));
      rmSync(dir, { recursive: true, force: true });
    } finally { await close(c); }
  }, 30_000);

  it('session/prompt with an unknown session errors cleanly', async () => {
    const c = await connect();
    try {
      const r = await send(c, 'session/prompt', { sessionId: 'nope', prompt: 'x' });
      expect(r.error.code).toBe(-32602);
    } finally { await close(c); }
  }, 30_000);

  it('unknown method returns -32601', async () => {
    const c = await connect();
    try {
      const r = await send(c, 'bogus/method');
      expect(r.error.code).toBe(-32601);
    } finally { await close(c); }
  }, 30_000);
});