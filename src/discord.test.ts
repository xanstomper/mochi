import { describe, expect, it, vi } from 'vitest';
import { handleDiscordMessage, loadDiscordConfig, type DiscordConfig } from './discord.js';

describe('Discord Gateway', () => {
  it('loads Discord configuration from environment', () => {
    const orig = process.env.DISCORD_BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = 'test-token-123';
    process.env.DISCORD_ALLOW_ALL_USERS = 'true';

    const cfg = loadDiscordConfig('/tmp');
    expect(cfg).not.toBeNull();
    expect(cfg?.token).toBe('test-token-123');
    expect(cfg?.allowAllUsers).toBe(true);

    if (orig) process.env.DISCORD_BOT_TOKEN = orig;
    else delete process.env.DISCORD_BOT_TOKEN;
  });

  it('rejects unauthorized users when allowAllUsers is false', async () => {
    const cfg: DiscordConfig = {
      token: 'tok',
      allowAllUsers: false,
      allowedUserIds: ['user-1'],
    };
    const runtime = {} as any;

    const res = await handleDiscordMessage(
      { authorId: 'unauthorized-user', content: '!mochi test', channelId: 'c1' },
      cfg,
      runtime
    );
    expect(res).toContain('Unauthorized');
  });

  it('handles help and status commands cleanly', async () => {
    const cfg: DiscordConfig = {
      token: 'tok',
      allowAllUsers: true,
      prefix: '!mochi',
    };
    const runtime: any = {
      config: { model: { model: 'deepseek-v4' } },
      cwd: '/home/user/app',
      usage: {
        total: () => ({ tokensIn: 100, tokensOut: 50, costUsd: 0.002 }),
      },
    };

    const helpRes = await handleDiscordMessage(
      { authorId: 'u1', content: '!mochi help', channelId: 'c1' },
      cfg,
      runtime
    );
    expect(helpRes).toContain('Mochi Discord Gateway');

    const statusRes = await handleDiscordMessage(
      { authorId: 'u1', content: '!mochi status', channelId: 'c1' },
      cfg,
      runtime
    );
    expect(statusRes).toContain('deepseek-v4');
    expect(statusRes).toContain('Tokens Used');
  });

  it('routes user goal to runtime and returns formatted response', async () => {
    const cfg: DiscordConfig = {
      token: 'tok',
      allowAllUsers: true,
      prefix: '!mochi',
    };
    const runtime: any = {
      goal: vi.fn().mockResolvedValue('Created src/index.ts and passed all tests.'),
    };

    const goalRes = await handleDiscordMessage(
      { authorId: 'u1', content: '!mochi write a hello world script', channelId: 'c1' },
      cfg,
      runtime
    );
    expect(goalRes).toContain('Task Completed');
    expect(goalRes).toContain('Created src/index.ts');
  });
});
