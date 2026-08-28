// Native tool: compile_prompt
// Transforms small / vague prompts into high-density, multi-phase executable specifications.
// Supports four reasoning tiers:
//   low    — ultra-compact micro-dispatch directive (token economy, direct execution)
//   medium — streamlined invariant contract (safety-first, targeted 2-step plan)
//   high   — action multi-phase blueprint (3-phase: discovery → build → verify)
//   max    — full 7-pass architectural master specification (exhaustive invariant decomposition)

import type { Tool } from './types.js';
import { promptCompiler, type CompilerReasoningLevel } from '../prompt/prompt-compiler.js';
import { detectRepo } from '../repo.js';

const VALID_TIERS = new Set<string>(['low', 'medium', 'med', 'high', 'max', 'auto', 'off']);

export const compilePromptTool: Tool = {
  def: {
    name: 'compile_prompt',
    description:
      'Transform a brief or vague user request into a structured execution blueprint calibrated to the active reasoning tier. ' +
      'low=micro-dispatch (token-cheap, direct), medium=invariant contract (streamlined 2-step), ' +
      'high=action multi-phase (3-phase: discover/build/verify), max=full architectural master specification (5-phase, exhaustive).',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Raw user instruction or goal to compile', required: true },
      {
        name: 'reasoning',
        type: 'string',
        description: 'Reasoning tier to compile for: low | medium | high | max (defaults to max)',
        required: false,
      },
      { name: 'testCommand', type: 'string', description: 'Optional override for the verification test command', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPrompt = String(args.prompt || '');
    if (!rawPrompt.trim()) {
      throw new Error('prompt parameter is required');
    }

    const rawTier = args.reasoning ? String(args.reasoning).toLowerCase().trim() : 'max';
    const tier: CompilerReasoningLevel = VALID_TIERS.has(rawTier)
      ? (rawTier === 'med' ? 'medium' : rawTier as CompilerReasoningLevel)
      : 'max';

    const repo = detectRepo(ctx.cwd);
    const testCommand = args.testCommand ? String(args.testCommand) : repo.testCommand;

    const spec = promptCompiler.compile(rawPrompt, {
      reasoning: tier,
      testCommand,
      primaryLanguage: repo.language,
    });

    return spec.compiledMarkdownPrompt;
  },
};
