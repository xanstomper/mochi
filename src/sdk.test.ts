// SDK surface: in-process prompt/branch/sessions against a fake provider.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Mochi } from './sdk.js';
import { startFakeOpenAI, type FakeOpenAI } from './testutil/fake-openai.js';
import type { MochiConfig } from './types.js';

function makeConfig(url: string): Partial<MochiConfig> {
  return { model: { provider: 'openai', baseUrl: url, apiKey: 'k', model: 'fake-model' } as MochiConfig['model'] };
}

let fake: FakeOpenAI | null = null;
let dir = '';
async function setup(replies: Array<Record<string, unknown>>): Promise<Mochi> {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-sdk-'));
  execSync('git init -q ' + dir);
  writeFileSync(resolve(dir, 'README.md'), '# t');
  fake = await startFakeOpenAI(replies as never);
  return Mochi.create({ cwd: dir, config: makeConfig(fake.url) });
}
afterEach(async () => { await fake?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); fake = null; dir = ''; });

describe('Mochi SDK (in-process mode)', () => {
  it('runs a prompt end-to-end and returns a structured result', async () => {
    const mochi = await setup([{ content: 'Created the file and ran tests. All pass.', finishReason: 'stop' }]);
    const r = await mochi.prompt('Create greeting file and verify. fix tests too');
    expect(r.success).toBe(true);
    expect(r.summary).toContain('Created the file');
    expect(r.tokensUsed).toBeGreaterThanOrEqual(0);
  });

  it('branches the session and the branch copies the transcript', async () => {
    const mochi = await setup([{ content: 'did the work', finishReason: 'stop' }]);
    await mochi.prompt('Create greeting file and verify. fix tests too');
    const b = mochi.branchSession('test branch');
    expect(b).toContain('Branched session');
    const sessions = mochi.sessions(5);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it('plan returns text without executing changes', async () => {
    const mochi = await setup([{ content: 'plan text', finishReason: 'stop' }]);
    const p = await mochi.plan('restructure the auth module');
    expect(p.length).toBeGreaterThan(0);
  });
});
