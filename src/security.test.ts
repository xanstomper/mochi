import { describe, expect, it } from 'vitest';
import { redact, redactObject, classifyCommand, ApprovalQueue } from './security.js';
import { shellTool } from './tools/shell.js';

describe('redact (from Horus)', () => {
  it('redacts OpenAI / Anthropic / Google / GitHub / AWS keys', () => {
    expect(redact('key=sk-proj-ABCDEFGHIJKLMNOPQRST body')).not.toContain('sk-proj');
    expect(redact('auth sk-ant-api03-VERYLONGSECRETKEY12345 end')).not.toContain('sk-ant');
    expect(redact('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij here')).not.toContain('AIza');
    expect(redact('ghp_12345678901234567890123456 repo')).not.toContain('ghp_');
    expect(redact('AKIA1234567890ABCDEF').includes('AKIA')).toBe(false);
  });

  it('redacts bearer tokens and JWTs', () => {
    const out = redact('Authorization: Bearer abc.def.ghi.jkl.mno.pqr.stu.vwx.yz');
    expect(out).not.toMatch(/[A-Za-z0-9._~+/-]{20,}/);
    expect(out).toContain('redacted');
  });

  it('redacts string values inside structured data by key name', () => {
    const out = redactObject({ model: { apiKey: 'sk-12345678901234567890', baseUrl: 'https://x' }, list: ['sk-abcdefghijklmnop'] });
    expect(JSON.stringify(out)).not.toContain('sk-');
    expect((out as any).model.apiKey).toBe('[secret-redacted]');
  });

  it('leaves normal text untouched', () => {
    expect(redact('just a normal verification failure')).toBe('just a normal verification failure');
  });
});

describe('classifyCommand (from Horus)', () => {
  it('flags destructive commands', () => {
    expect(classifyCommand('rm -rf /tmp/x')).toBe('destructive');
    expect(classifyCommand('git push origin main')).toBe('destructive');
    expect(classifyCommand('git reset --hard HEAD')).toBe('destructive');
    expect(classifyCommand('drop database foo')).toBe('destructive');
    expect(classifyCommand('sudo apt update')).toBe('destructive');
  });

  it('flags network / install commands', () => {
    expect(classifyCommand('npm install lodash')).toBe('network');
    expect(classifyCommand('git clone https://x')).toBe('network');
    expect(classifyCommand('curl -s https://x')).toBe('network');
  });

  it('treats ordinary commands as low risk', () => {
    expect(classifyCommand('echo hello')).toBe('low');
    expect(classifyCommand('node test.js')).toBe('low');
    expect(classifyCommand('python3 -m pytest')).toBe('low');
  });
});

describe('shell risk gate', () => {
  it('blocks destructive commands in safe mode', async () => {
    const mkCtx = (mode: string) => ({
      cwd: process.cwd(),
      config: { safety: { mode, commandTimeoutSeconds: 5 } },
      events: { emit: () => {} },
      agentId: 't',
    });
    await expect(
      shellTool.execute({ command: 'rm -rf /tmp/nope' }, mkCtx('safe') as any),
    ).rejects.toThrow(/Blocked by safety/);
  });

  it('runs ordinary commands in safe mode', async () => {
    const out = await shellTool.execute({ command: 'echo ok' }, {
      cwd: process.cwd(),
      config: { safety: { mode: 'safe', commandTimeoutSeconds: 5 } },
      events: { emit: () => {} },
      agentId: 'a',
    } as any);
    expect(out).toContain('exit_code: 0');
    expect(out).toContain('ok');
  });
});

describe('ApprovalQueue (from Horus)', () => {
  it('requests, lists, and decides approvals', () => {
    const q = new ApprovalQueue();
    const a = q.request('run git push');
    expect(a.status).toBe('pending');
    expect(q.pending()).toHaveLength(1);
    q.decide(a.id, 'denied');
    expect(q.pending()).toHaveLength(0);
  });
});