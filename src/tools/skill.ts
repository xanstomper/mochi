import type { Tool } from './types.js';
import { loadAllSkills, readSkillBody } from '../skills.js';
import type { Skill } from '../skills.js';

// The `skill` tool lets the model load a reusable, task-specific instruction
// file on demand (agentskills.io spec). Along with listing available skills in
// the system prompt, this closes the gap where Mochi had to guess a workflow a
// codebase already documents. List + load a skill by name; its body becomes
// targeted context for the current task.

function findSkill(projectDir: string, name: string): Skill | undefined {
  const { skills } = loadAllSkills(projectDir);
  return skills.find((s) => s.name === name);
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
    const body = readSkillBody(skill, ctx.cwd);
    return `# ${skill.name}\n${body}`.slice(0, 20000);
  },
};