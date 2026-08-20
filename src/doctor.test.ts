// mochi doctor: health self-inspection report + formatting.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { doctorReport, formatDoctor } from './doctor.js';
import { addJob } from './cron.js';

let dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(resolve(tmpdir(), 'mochi-doctor-'));
  dirs.push(d);
  return d;
}

describe('doctorReport', () => {
  it('flags a missing API key', async () => {
    const r = await doctorReport({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: null, workspaceDir: tmp() });
    expect(r.model.keySet).toBe(false);
    expect(r.problems.some((p) => p.includes('API key'))).toBe(true);
  });

  it('reports the active provider and model', async () => {
    const r = await doctorReport({ provider: 'freeinference', baseUrl: 'https://freeinference.org/v1', model: 'deepseek-v4-flash', apiKey: 'sk-test', workspaceDir: tmp() });
    expect(r.model.provider).toBe('freeinference');
    expect(r.model.model).toBe('deepseek-v4-flash');
    expect(r.model.keySet).toBe(true);
  });

  it('reports daemon running state', async () => {
    const r = await doctorReport({ provider: 'openai', baseUrl: 'x', model: 'gpt', apiKey: 'k', workspaceDir: tmp(), daemon: { running: true, port: 9470 } });
    expect(r.daemon.running).toBe(true);
    expect(r.daemon.port).toBe(9470);
  });

  it('counts cron jobs from the workspace', async () => {
    const d = tmp();
    addJob(d, 'say hi', 'every 1m');
    addJob(d, 'say bye', 'every 5m');
    const r = await doctorReport({ provider: 'openai', baseUrl: 'x', model: 'gpt', apiKey: 'k', workspaceDir: d });
    expect(r.cron.jobs).toBe(2);
    expect(r.daemon.jobs).toBe(2);
  });

  it('warns when jobs exist but the daemon is down', async () => {
    const d = tmp();
    addJob(d, 'say hi', 'every 1m');
    const r = await doctorReport({ provider: 'openai', baseUrl: 'x', model: 'gpt', apiKey: 'k', workspaceDir: d, daemon: { running: false } });
    expect(r.problems.some((p) => p.includes('daemon is not running'))).toBe(true);
  });

  it('formatDoctor is human-readable and marks problems', async () => {
    const r = await doctorReport({ provider: 'openai', baseUrl: 'x', model: '', apiKey: null, workspaceDir: tmp() });
    const out = formatDoctor(r);
    expect(out).toContain('Mochi doctor');
    expect(out).toContain('api key');
    expect(out).toMatch(/MISS/);
  });
});