import { statSync } from 'node:fs';
import type { Tool } from './types.js';
import { loadAllSkills, readSkillBody, recordSkillUsage } from '../skills.js';
import type { Skill } from '../skills.js';

// The `skill` tool lets the model load a reusable, task-specific instruction
// file on demand (agentskills.io spec). Along with listing available skills in
// the system prompt, this closes the gap where Mochi had to guess a workflow a
// codebase already documents. List + load a skill by name; its body becomes
// targeted context for the current task.
//
// Phase 6 (VNext): skill bodies are static text, so loading the same skill
// twice in a session is pure token waste. Bodies are cached per process and
// re-served with a short reminder instead of the full text; loads are counted
// for telemetry (surfaced via perf stats).

function findSkill(projectDir: string, name: string): Skill | undefined {
  const { skills } = loadAllSkills(projectDir);
  return skills.find((s) => s.name === name);
}

// Module-level: shared across agents in one process, matching the skill
// source's lifetime (skills change across processes, not within one).
const skillBodyCache = new Map<string, { body: string; path: string; mtimeNs: bigint; size: bigint }>();
const loadedByAgent = new Set<string>();
const skillLoadCounts = new Map<string, number>();

export function getSkillLoadCounts(): ReadonlyMap<string, number> {
  return skillLoadCounts;
}

export function resetSkillCache(): void {
  skillBodyCache.clear();
  loadedByAgent.clear();
  skillLoadCounts.clear();
}

export const skillTool: Tool = {
  def: {
    name: 'skill',
    description:
      'Load a reusable project skill by name and return its full instructions. Skills are markdown guides (e.g. "how we release", "how to fix a flaky test"). Use `skill list` to see available skills, or `skill` with a name to load one.',
    parameters: [
      { name: 'name', type: 'string', description: 'Skill name, or "list" to enumerate available skills', required: true },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const name = String(args.name ?? '').trim();
    if (name === '' || name === 'list') {
      const { skills } = loadAllSkills(ctx.cwd);
      if (skills.length === 0) return '(no skills found)';
      return skills.map((s) => `${s.name}${s.disableModelInvocation ? ' (explicit only)' : ''}: ${s.description}`).join('\n');
    }
    const skill = findSkill(ctx.cwd, name);
    if (!skill) return `No skill named '${name}'. Run \`skill list\` to see available skills.`;
    skillLoadCounts.set(name, (skillLoadCounts.get(name) ?? 0) + 1);
    // MCH-40: persist the load so usage-ranked relevance can boost skills
    // that actually get used. Best-effort; never blocks the load.
    try {
      recordSkillUsage(ctx.cwd, name);
    } catch { /* stats optional */ }
    const cacheKey = `${ctx.cwd}::${name}`;
    const previous = skillBodyCache.get(cacheKey);
    let stat: { mtimeNs: bigint; size: bigint } | undefined;
    try { stat = statSync(skill.path, { bigint: true }); } catch { /* readSkillBody provides fallback */ }
    const unchanged = previous !== undefined
      && previous.path === skill.path
      && previous.mtimeNs === stat?.mtimeNs
      && previous.size === stat?.size;
    const body = unchanged
      ? previous.body
      : `# ${skill.name}\n${readSkillBody(skill, ctx.cwd)}`.slice(0, 20000);
    // A disk-cache hit does not mean this agent has received the instructions.
    const hasIdentity = typeof ctx.agentId === 'string' && ctx.agentId.length > 0;
    const receiptKey = hasIdentity
      ? JSON.stringify([ctx.cwd, ctx.agentId, name, skill.path, stat?.mtimeNs.toString(), stat?.size.toString()])
      : '';
    const cached = unchanged && hasIdentity && loadedByAgent.has(receiptKey) ? body : undefined;
    if (hasIdentity) loadedByAgent.add(receiptKey);
    // Serve the cached reminder ONLY when it is actually shorter than the
    // full body (tiny skills would otherwise cost MORE via the note overhead).
    const reminder = cached !== undefined
      ? `# ${name} (cached — loaded earlier this session)\n${cached.slice(0, 600)}\n[... previously loaded in full; apply from memory ...]`
      : undefined;
    if (cached !== undefined && reminder!.length < cached.length) {
      return reminder!;
    }
    if (stat) {
      skillBodyCache.set(cacheKey, { body, path: skill.path, mtimeNs: stat.mtimeNs, size: stat.size });
    } else {
      skillBodyCache.delete(cacheKey);
    }
    return body;
  },
};
