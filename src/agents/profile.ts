import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentProfile, AgentRole, ModelProfile } from '../types.js';
import { getProfile, listRoles } from '../teams/roles.js';

export interface ParsedProfile {
  name: string;
  description: string;
  tools: string[];
  model: ModelProfile | undefined;
  verification: AgentProfile['verification'];
  systemPrompt: string;
  maxIterations: number | undefined;
}

export function parseProfileMarkdown(text: string): ParsedProfile | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  const [, frontmatter, body] = match;

  const values: Record<string, string | string[]> = {};
  let lastKey = '';
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (/^\s{2,}-\s+/.test(rawLine)) {
      const item = rawLine.trim().slice(2).trim();
      const current = values[lastKey];
      if (typeof current === 'string' && current === '') values[lastKey] = [item];
      else if (typeof current === 'string') values[lastKey] = [current, item];
      else if (Array.isArray(current)) current.push(item);
      else values[lastKey] = [item];
      continue;
    }
    const kv = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    lastKey = kv[1];
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    values[lastKey] = value;
  }

  const name = String(values.name ?? '').trim();
  if (!name) return undefined;
  const model = values.model ? String(values.model) as ModelProfile : undefined;
  const tools = Array.isArray(values.tools) ? values.tools.map(String) : values.tools ? String(values.tools).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const verification = String(values.verification ?? 'optional') as NonNullable<AgentProfile['verification']>;

  return {
    name,
    description: String(values.description ?? ''),
    tools,
    model,
    verification: ['none', 'optional', 'required'].includes(verification) ? verification : 'optional',
    systemPrompt: body.trim(),
    maxIterations: typeof values.maxIterations === 'string' ? Number(values.maxIterations) : undefined,
  };
}

export class AgentProfileService {
  private cache = new Map<string, AgentProfile>();

  constructor(private projectDir: string) {
    const builtins = listRoles();
    for (const role of builtins) {
      const profile = getProfile(role);
      this.cache.set(role, profile);
      this.cache.set(profile.name.toLowerCase(), profile);
    }
    this.loadUserProfiles();
  }

  private loadUserProfiles() {
    const dir = resolve(this.projectDir, 'agents');
    if (!existsSync(dir)) return;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const path = resolve(dir, file);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseProfileMarkdown(text);
      if (!parsed) continue;
      const role = parsed.name.toLowerCase() as AgentRole;
      const profile: AgentProfile = {
        role,
        name: parsed.name,
        description: parsed.description,
        systemPrompt: parsed.systemPrompt || getProfile(role).systemPrompt,
        defaultModel: parsed.model,
        tools: parsed.tools,
        verification: parsed.verification,
        maxIterations: parsed.maxIterations,
      };
      this.cache.set(role, profile);
      this.cache.set(profile.name.toLowerCase(), profile);
    }
  }

  get(role: string): AgentProfile | undefined {
    return this.cache.get(role.toLowerCase());
  }

  list(): AgentProfile[] {
    return [...new Map(this.cache.entries()).values()];
  }
}

export function loadDefaultProfiles(): AgentProfile[] {
  return listRoles().map(getProfile);
}
