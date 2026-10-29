// CLI argument parsing + flag → config overrides.
//
// Extracted from cli.ts so the flag contract is unit-testable without importing
// the entry point (cli.ts runs main() on import). Two real bugs lived here and
// went unnoticed because nothing could import this logic:
//   - `--base-url` was parsed under the literal key "base-url" but read as
//     `flags.baseUrl`, so the flag was silently ignored;
//   - `--model` set only `model.model` while the effective per-tier model is
//     `model.profiles[<tier>]`, so the default profiles overrode it.
import type { MochiConfig, ReasoningLevel } from './types.js';

const BOOLEAN_FLAGS = new Set([
  'p', 'print', 'auto', 'quiet', 'q', 'verbose', 'v', 'debug', 'h', 'help', 'version', 'offline', 'enhance', 'install', 'plan',
  'w', 'worktree',
  'y', 'yolo', 'dangerously-skip-permissions', 'force', 'user',
  'u', 'uncensored', 'admin',
  'strict', 'json', 'diff-only', 'auto-commit', 'repair', 'post',
  'warm',
]);

export function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      if (rest.length > 0) {
        flags[key] = rest.join('=');
      } else if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** CLI flag overrides plus the two UI-contract markers the permission layer
 *  reads without config hacks (typed — no loose casts at the boundary). */
export interface FlagOverrides extends Partial<MochiConfig> {
  __yolo?: boolean;
  __uncensored?: boolean;
  /** Set only when --uncensored/-u was explicitly passed THIS invocation,
   *  not when inherited from config/env — controls the one-time banner. */
  __uncensoredExplicit?: boolean;
}

export function configFromFlags(flags: Record<string, string | boolean>): FlagOverrides {
  const overrides: FlagOverrides = {};
  const model: Partial<MochiConfig['model']> = {};
  if (flags.provider) model.provider = String(flags.provider);
  if (flags.model) {
    const m = String(flags.model);
    model.model = m;
    // An explicit --model is a user pin: cost-per-solve routing measures
    // the run but must never second-guess the choice (ModelConfig.modelPinned).
    model.modelPinned = true;
    // The effective per-tier model comes from `model.profiles`, not
    // `model.model` (resolveModel/profile override in createRawProvider). The
    // default config fills every profile, so setting only `model.model` left
    // the tier profiles in place and silently discarded the user's --model.
    // Mirror `model-manager.setModel`, which sets every profile.
    model.profiles = { fast: m, coding: m, reasoning: m, review: m };
  }
  if (flags['api-key']) model.apiKey = String(flags['api-key']);
  // The arg parser stores `--base-url` under the literal key "base-url"; the
  // old `flags.baseUrl` read never matched, so the documented --base-url flag
  // was silently ignored (custom/proxy endpoints could not be selected).
  const baseUrlFlag = flags['base-url'] ?? flags.baseUrl;
  if (baseUrlFlag) model.baseUrl = String(baseUrlFlag);
  if (Object.keys(model).length) overrides.model = model as MochiConfig['model'];
  if (flags.safety) overrides.safety = { ...({} as MochiConfig['safety']), mode: String(flags.safety) as MochiConfig['safety']['mode'] };
  if (flags.auto) overrides.safety = { ...({} as MochiConfig['safety']), mode: 'auto' as const };
  if (flags['max-tokens'] || flags['max-cost'] || flags['max-model-calls'] || flags['max-tool-calls']) {
    overrides.safety = {
      ...(overrides.safety ?? ({} as MochiConfig['safety'])),
      ...(flags['max-tokens'] ? { maxTokens: Number(flags['max-tokens']) } : {}),
      ...(flags['max-cost'] ? { maxCostUsd: Number(flags['max-cost']) } : {}),
      ...(flags['max-model-calls'] ? { maxModelCalls: Number(flags['max-model-calls']) } : {}),
      ...(flags['max-tool-calls'] ? { maxToolCalls: Number(flags['max-tool-calls']) } : {}),
    };
  }
  if (flags.quiet) overrides.quiet = true;
  if (flags.verbose) overrides.verbose = true;
  if (flags.debug) overrides.debug = true;
  if (flags.reasoning) {
    const raw = String(flags.reasoning).toLowerCase();
    // `med` is a documented alias (help text + `mochi reasoning [low|med|…]`
    // + the compile-prompt tool all accept it) — map it instead of silently
    // degrading the flag to auto.
    const lvl = raw === 'med' ? 'medium' : raw;
    const valid: readonly string[] = ['low', 'medium', 'high', 'max', 'off', 'auto'];
    overrides.reasoning = (valid.includes(lvl) ? lvl : 'auto') as ReasoningLevel;
    if (lvl !== overrides.reasoning) console.error(`Unknown reasoning level "${raw}" — using auto.`);
  }
  // Plan mode: `--plan` (a dashed boolean; the bare `plan` subcommand
  // is positional and unaffected) makes every agent in the run research and
  // return a plan instead of editing files.
  if (flags.plan) overrides.planMode = true;
  // --uncensored / -u / --yolo / -y / --dangerously-skip-permissions: bypass all permission gates
  const explicitUncensored = flags.uncensored === true || flags.u === true;
  const isUncensored = explicitUncensored || process.env.MOCHI_UNCENSORED === '1';
  if (isUncensored) {
    overrides.safety = { ...(overrides.safety ?? {} as MochiConfig['safety']), mode: 'uncensored' as const };
    overrides.permissions = {
      read: true,
      write: true,
      shell: true,
      network: true,
      gitDestructive: true,
      admin: true,
    };
    overrides.__uncensored = true;
    if (explicitUncensored) overrides.__uncensoredExplicit = true;
    overrides.__yolo = true;
    process.env.MOCHI_UNCENSORED = '1';
  } else if (flags.yolo || flags.y || flags['dangerously-skip-permissions'] ||
      process.env.MOCHI_DANGEROUSLY_SKIP_PERMISSIONS === '1' ||
      process.env.MOCHI_YOLO === '1') {
    // MOCHI_YOLO=1 is the persistent admin switch (export it in .bashrc):
    // same as --yolo — auto-approve everything, no per-tool prompts.
    overrides.safety = { ...(overrides.safety ?? {} as MochiConfig['safety']), mode: 'auto' as const };
    overrides.__yolo = true;
  }
  return overrides;
}
