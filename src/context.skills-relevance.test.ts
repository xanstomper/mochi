import { describe, it, expect } from 'vitest';
import { selectRelevantSkills, MAX_TASK_SKILLS } from './context.js';
import type { Skill } from './skills.js';

function skill(name: string, description: string): Skill {
  return { name, description, path: `/x/${name}/SKILL.md` } as Skill;
}

// Regression: Mochi used to dump ALL skills (incl. unrelated red-team / emulator
// frameworks) into every system prompt, which on flash/free-tier models caused
// off-task hallucinations (observed: a trivial IPv4 task derailed into
// "holyshit ledger / live Ollama endpoint" shell commands). The relevance gate
// must advertise only skills whose description overlaps the actual task.
describe('selectRelevantSkills', () => {
  it('returns an empty list when no task text is given (chat mode surface nothing)', () => {
    const skills = [skill('holyshit-mode', 'red-team framework with ledger and endpoint')];
    expect(selectRelevantSkills(skills, '', MAX_TASK_SKILLS)).toHaveLength(0);
  });

  it('excludes unrelated skills and includes the matching one', () => {
    const skills = [
      skill('holyshit-mode', 'HolyShit red-team engagement framework, ledger and multi-model dispatch'),
      skill('the-simon-game', 'retro Simon memory button game'),
      skill('arc-gis-satellite', 'geospatial satellite imagery landcover classification'),
      skill('python-debugging', 'debug Python with pdb, print tracing, and step through failures'),
    ];
    const got = selectRelevantSkills(skills, 'debug a Python traceback and fix the exception', MAX_TASK_SKILLS);
    const names = got.map((s) => s.name);
    expect(names).toContain('python-debugging');
    expect(names).not.toContain('holyshit-mode');
    expect(names).not.toContain('the-simon-game');
  });

  it('returns nothing when no skill overlaps the task (the IPv4 regression)', () => {
    const skills = [
      skill('holyshit-mode', 'HolyShit red-team engagement framework, ledger and endpoint'),
      skill('xbox-one-jailbreak', 'jailbreak an Xbox One via the Collateral vulnerability'),
    ];
    // The IPv4 task shares zero tokens with security/console skills.
    const got = selectRelevantSkills(skills, 'write a function that validates an IPv4 dotted-quad string', MAX_TASK_SKILLS);
    expect(got).toHaveLength(0);
  });

  it('caps the result at MAX_TASK_SKILLS', () => {
    const skills = Array.from({ length: 20 }, (_, i) => skill(`skill-${i}`, `typeScript compiler refactor tool number ${i}`));
    const got = selectRelevantSkills(skills, 'refactor a TypeScript compiler pass', MAX_TASK_SKILLS);
    expect(got.length).toBeLessThanOrEqual(MAX_TASK_SKILLS);
  });
});