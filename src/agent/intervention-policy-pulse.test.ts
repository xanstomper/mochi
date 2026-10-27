// InterventionPolicy — pulse() conditions + delivery through the policy.
// pulse() is stateless about delivery (no throttle flag): a suppressed pulse
// re-fires on its own schedule, so routing it through the gate loses
// nothing. These tests pin the three message conditions, the two abort
// conditions, and queue/flush delivery of a pulse nudge on a bare agent.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import type { MochiConfig } from '../types.js';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model', speculative: { preflight: false } },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeBareAgent() {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-pulse-'));
  const config = makeConfig(dir, 'http://localhost:0');
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(config, dir);
  const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
  return { agent, dir };
}

/** Read all messages from the context (public getter). */
function messagesOf(agent: unknown) {
  return (agent as any).context.messages as Array<{ role: string; content: string }>;
}

/**
 * Mirror the loop's policy flush (before the model packet): drain the
 * queued soft nudge into context, advancing the struggle throttle on
 * actual injection exactly as the production flush site does.
 */
function flushSoft(agent: any, iter: number) {
  const won = agent.interventions.flush();
  if (won) {
    agent.context.addMessage({ role: 'system', content: won.content });
    if (won.tag === 'struggle') agent.lastStruggleInjectIter = iter;
  }
}

describe('pulse() through the intervention policy', () => {
  it('three identical errors produce a pulse nudge that flushes to the model', () => {
    const { agent, dir } = makeBareAgent();
    try {
      (agent as any).errors = ['boom', 'boom', 'boom'];
      const pulse = (agent as any).pulse(5, {});
      expect(pulse.abort).toBe(false);
      expect(pulse.message).toContain('last 3 errors were the same');
      expect(pulse.message).toContain('boom');
      expect((agent as any).interventions.queue('pulse', pulse.message)).toBe('queued');
      flushSoft(agent, 5);
      const msgs = messagesOf(agent).filter(
        (m) => m.role === 'system' && m.content.includes('Pulse:'),
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toContain('Try a different strategy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the heartbeat fires at multiples of 12 iterations and not otherwise', () => {
    const { agent, dir } = makeBareAgent();
    try {
      (agent as any).errors = [];
      expect((agent as any).pulse(12, {}).message).toContain('Pulse: 12 iterations');
      expect((agent as any).pulse(24, {}).message).toContain('Pulse: 24 iterations');
      expect((agent as any).pulse(5, {}).message).toBeUndefined();
      expect((agent as any).pulse(0, {}).message).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a queued pulse loses to a competing struggle and is counted suppressed', () => {
    const { agent, dir } = makeBareAgent();
    try {
      (agent as any).errors = [];
      const pulse = (agent as any).pulse(12, {});
      expect((agent as any).interventions.queue('pulse', pulse.message)).toBe('queued');
      expect((agent as any).interventions.queue('struggle', 'STRUGGLE STATE', 2)).toBe('queued');
      flushSoft(agent, 12);
      const contents = messagesOf(agent).map((m) => m.content);
      expect(contents.some((c) => c.includes('STRUGGLE STATE'))).toBe(true);
      expect(contents.some((c) => c.includes('Pulse: 12 iterations'))).toBe(false);
      expect((agent as any).interventions.stats.suppressedByTag.pulse).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the abort conditions still return abort (never queued)', () => {
    const { agent, dir } = makeBareAgent();
    try {
      (agent as any).errors = ['a', 'b'];
      (agent as any).consecutiveToolErrorsCount = 8;
      (agent as any).fileChanged = false;
      const toolFail = (agent as any).pulse(5, {});
      expect(toolFail.abort).toBe(true);
      expect(toolFail.reason).toContain('Too many consecutive tool failures');
      (agent as any).consecutiveToolErrorsCount = 0;
      (agent as any).fileChanged = true;
      (agent as any).scopeVetoCount = 5;
      const veto = (agent as any).pulse(5, {});
      expect(veto.abort).toBe(true);
      expect(veto.reason).toContain('Stalled on guardrails');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no message when nothing is wrong', () => {
    const { agent, dir } = makeBareAgent();
    try {
      (agent as any).errors = ['a', 'b'];
      const pulse = (agent as any).pulse(5, {});
      expect(pulse).toEqual({ abort: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
