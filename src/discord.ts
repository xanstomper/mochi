// Discord Gateway for Mochi Agent.
// Provides bidirectional communication between Discord channels and Mochi's Runtime engine.
// Supports goal execution, streaming progress updates, status reporting, and mobile notifications.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Runtime } from './runtime.js';

export interface DiscordConfig {
  token: string;
  channelId?: string;
  allowAllUsers?: boolean;
  allowedUserIds?: string[];
  prefix?: string;
}

/** Load Discord bot configuration from environment or .env files */
export function loadDiscordConfig(cwd: string): DiscordConfig | null {
  const envPaths = [
    resolve(cwd, '.env'),
    resolve(cwd, '.mochi', '.env'),
    resolve(homedir(), '.mochi', '.env'),
    resolve(homedir(), '.hermes', '.env'),
  ];

  const envMap = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) envMap.set(k, v);
  }

  for (const p of envPaths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const [k, ...vParts] = trimmed.split('=');
          const v = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
          if (k && v && !envMap.has(k.trim())) {
            envMap.set(k.trim(), v);
          }
        }
      } catch {}
    }
  }

  const token = envMap.get('DISCORD_BOT_TOKEN') || envMap.get('DISCORD_TOKEN');
  if (!token) return null;

  const channelId = envMap.get('DISCORD_CHANNEL_ID');
  const allowAllUsers = envMap.get('DISCORD_ALLOW_ALL_USERS') === 'true';
  const allowedUserIds = (envMap.get('DISCORD_ALLOWED_USERS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const prefix = envMap.get('DISCORD_PREFIX') || '!mochi';

  return { token, channelId, allowAllUsers, allowedUserIds, prefix };
}

/** Send a message to a Discord channel via standard Discord REST API */
export async function sendDiscordMessage(
  token: string,
  channelId: string,
  content: string,
  opts: { embed?: Record<string, unknown> } = {}
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      content: content.slice(0, 2000),
    };
    if (opts.embed) payload.embeds = [opts.embed];

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return res.ok;
  } catch {
    return false;
  }
}

/** Process a message event received from Discord webhook or gateway */
export async function handleDiscordMessage(
  msg: { authorId: string; content: string; channelId: string },
  config: DiscordConfig,
  runtime: Runtime
): Promise<string> {
  if (!config.allowAllUsers && config.allowedUserIds && !config.allowedUserIds.includes(msg.authorId)) {
    return 'Unauthorized: You do not have permission to invoke Mochi on this Discord server.';
  }

  const cleanText = msg.content.trim();
  const prefix = config.prefix || '!mochi';
  const prompt = cleanText.startsWith(prefix) ? cleanText.slice(prefix.length).trim() : cleanText;

  if (!prompt || prompt === 'help') {
    return `🍡 **Mochi Discord Gateway**
- \`${prefix} <goal>\` — Execute a coding goal or task.
- \`${prefix} status\` — Show active model, token usage, and daemon health.
- \`${prefix} doctor\` — Run workspace configuration diagnosis.
`;
  }

  if (prompt === 'status') {
    const usage = runtime.usage?.total?.();
    return `📊 **Mochi Status**
- **Model**: \`${runtime.config.model.model}\`
- **Workspace**: \`${runtime.cwd}\`
- **Tokens Used**: ${usage?.tokensIn ?? 0} in / ${usage?.tokensOut ?? 0} out
- **Estimated Cost**: $${(usage?.costUsd ?? 0).toFixed(4)} USD
`;
  }

  if (prompt === 'doctor') {
    const out = typeof runtime.inspect === 'function' ? String(await runtime.inspect('doctor')) : 'Doctor completed.';
    return `🩺 **Mochi Doctor**\n\`\`\`\n${out.slice(0, 1800)}\n\`\`\``;
  }

  // Execute goal through runtime
  try {
    const result = await runtime.goal(prompt);
    return `✅ **Task Completed**\n\n${result.slice(0, 1900)}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `❌ **Task Failed**: ${message.slice(0, 1800)}`;
  }
}
