// Wave H3 (brief tests a + c): a scripted Agent run against the fake OpenAI
// wire with the deterministic fake display backend. For a vision-capable
// model, the request that follows a computer action must carry the captured
// frame as an inline image part (bytes decode to the fake frame) alongside
// the path text. For a text-only model the same run must stay path-only —
// the pre-H3 wire shape, byte for byte in the tool message.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { BudgetEngine } from '../budget.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { startFakeOpenAI, type FakeOpenAI } from '../testutil/fake-openai.js';
import { setDisplayBackendForTests } from '../computer/backend.js';
import { FakeDisplayBackend } from '../computer/fake-display.js';
import { decodePngRgba } from '../computer/png.js';
import type { MochiConfig } from '../types.js';

const SCREENSHOT_CALL = {
  toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'computer', arguments: '{"action":"screenshot"}' } }],
  finishReason: 'tool_calls',
};
const DONE = { content: 'Screenshot taken; the desktop is visible.', finishReason: 'stop' };

async function runScripted(fake: FakeOpenAI, model: string) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-shot-inline-'));
  const safety = {
    mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10,
    maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 8000,
  };
  const config = {
    model: { provider: 'openai', baseUrl: fake.url, model },
    safety,
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false, computer: true },
    telemetry: false, projectDir: dir, quiet: true,
  } as unknown as MochiConfig;
  const budget = new BudgetEngine(safety as never);
  budget.start();
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(config, dir);
  context.setGoal('look at the desktop');
  const events = new EventBus();
  // unattendedAllow: the computer tier is dangerous-by-default and a headless
  // run has no approver; this is the documented opt-in for unattended runs.
  const agent = new Agent({ id: 'shot-inline-agent', role: 'coder', config, workspace, events, cwd: dir, context, budget, unattendedAllow: true });
  await agent.run({
    id: 't1', title: 'Look at the desktop', description: 'Take a screenshot of the desktop and describe what you see.',
    role: 'coder', status: 'pending', priority: 1, dependencies: [], acceptanceCriteria: [],
    attempts: [], createdAt: 0, updatedAt: 0,
  } as never);
  return { dir };
}

/** The first wire request that carries the computer tool result. */
function toolTurnMessages(fake: FakeOpenAI): Array<Record<string, unknown>> {
  for (const req of fake.requests) {
    const messages = (req.body as { messages?: Array<Record<string, unknown>> }).messages ?? [];
    if (messages.some((m) => m.role === 'tool')) return messages;
  }
  throw new Error('no request carried a tool message');
}

describe('computer screenshots inline into the tool result (H3)', () => {
  const prevPreflight = process.env.MOCHI_SPECULATIVE_PREFLIGHT;
  const prevTools = process.env.MOCHI_TOOLS;
  beforeAll(() => {
    process.env.MOCHI_SPECULATIVE_PREFLIGHT = '0';
    process.env.MOCHI_TOOLS = 'full'; // keep the heavy computer tool in the map
    setDisplayBackendForTests(new FakeDisplayBackend(800, 600));
  });
  afterAll(() => {
    setDisplayBackendForTests(null);
    if (prevPreflight === undefined) delete process.env.MOCHI_SPECULATIVE_PREFLIGHT;
    else process.env.MOCHI_SPECULATIVE_PREFLIGHT = prevPreflight;
    if (prevTools === undefined) delete process.env.MOCHI_TOOLS;
    else process.env.MOCHI_TOOLS = prevTools;
  });

  it('vision model: tool turn carries the fake frame as an image part + the path text', async () => {
    const fake = await startFakeOpenAI([SCREENSHOT_CALL, DONE]);
    const { dir } = await runScripted(fake, 'gpt-4o');
    try {
      const messages = toolTurnMessages(fake);
      const toolIdx = messages.findIndex((m) => m.role === 'tool');
      const toolContent = messages[toolIdx].content as string;
      // Path text preserved (the OpenAI wire tool message stays a string).
      expect(toolContent).toContain('screenshot:');
      expect(toolContent).toMatch(/shot-\d+\.png/);
      // The path points at a real file the tool saved.
      const shotPath = /screenshot: (\S+shot-\d+\.png)/.exec(toolContent)![1];
      expect(existsSync(shotPath)).toBe(true);
      expect(readdirSync(resolve(dir, '.mochi', 'state', 'computer')).some((f) => f.endsWith('.png'))).toBe(true);
      // The follow-up user message carries the image part, and its bytes
      // decode to exactly the fake display's frame.
      const follow = messages[toolIdx + 1];
      expect(follow.role).toBe('user');
      const parts = follow.content as Array<{ type: string; image_url?: { url: string } }>;
      const imagePart = parts.find((p) => p.type === 'image_url');
      expect(imagePart).toBeDefined();
      const url = imagePart!.image_url!.url;
      expect(url.startsWith('data:image/png;base64,')).toBe(true);
      const decoded = decodePngRgba(Buffer.from(url.split(',')[1], 'base64'));
      expect(decoded.width).toBe(800);
      expect(decoded.height).toBe(600);
      const expected = await new FakeDisplayBackend(800, 600).captureRgba();
      expect(decoded.rgba.equals(expected)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.close?.();
    }
  }, 60_000);

  it('text-only model: path-only tool result, no image part anywhere', async () => {
    const fake = await startFakeOpenAI([SCREENSHOT_CALL, DONE]);
    const { dir } = await runScripted(fake, 'deepseek-chat');
    try {
      const messages = toolTurnMessages(fake);
      const toolMsg = messages.find((m) => m.role === 'tool')!;
      expect(typeof toolMsg.content).toBe('string');
      expect(toolMsg.content as string).toContain('screenshot:');
      expect(JSON.stringify(messages)).not.toContain('image_url');
      // The screenshot still exists on disk — only the inlining is gated.
      expect(readdirSync(resolve(dir, '.mochi', 'state', 'computer')).some((f) => f.endsWith('.png'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.close?.();
    }
  }, 60_000);
});
