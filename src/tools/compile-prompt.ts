// Native tool: compile_prompt
// Transforms small / vague prompts into high-density, multi-phase executable specifications.

import type { Tool } from './types.js';
import { promptCompiler } from '../prompt/prompt-compiler.js';
import { detectRepo } from '../repo.js';

export const compilePromptTool: Tool = {
  def: {
    name: 'compile_prompt',
    description: 'Transform a brief or vague user request into a comprehensive multi-phase execution blueprint with explicit invariants, verification criteria, and acceptance gates.',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Raw user instruction or goal to compile', required: true },
      { name: 'testCommand', type: 'string', description: 'Optional override for the verification test command', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPrompt = String(args.prompt || '');
    if (!rawPrompt.trim()) {
      throw new Error('prompt parameter is required');
    }

    const repo = detectRepo(ctx.cwd);
    const testCommand = args.testCommand ? String(args.testCommand) : repo.testCommand;

    const spec = promptCompiler.compile(rawPrompt, {
      testCommand,
      primaryLanguage: repo.language,
    });

    return spec.compiledMarkdownPrompt;
  },
};
