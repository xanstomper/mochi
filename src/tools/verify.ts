import type { Tool } from './types.js';
import { detectRepo } from '../repo/repo.js';
import { runShellString } from '../exec.js';
import { maybeRedact } from '../security/security.js';
import { planVerificationTests, recordSelectionRun } from '../core/test-selection.js';

// Run project verification commands (test, build, typecheck, lint) with
// smart command injection and result summarization.
// Central policy: runs through exec.ts runShellString (timeout + SIGKILL,
// output cap) and redacts secrets from output before returning to the model.
export const verifyTool: Tool = {
  def: {
    name: 'verify',
    description:
      'Run a verification command (test, build, typecheck, lint) and return a structured summary. ' +
      'Automatically detects the appropriate command for the project type. For tests, by default ' +
      'runs the blast-radius subset for the files you changed (fast feedback), labeled PARTIAL in ' +
      'the output — a partial pass is not a suite verdict. Run with scope:"all" for the whole ' +
      'suite before you consider the task done.',
    parameters: [
      { name: 'command', type: 'string', description: 'Verification command to run (e.g. "test", "build", "typecheck", "lint")', required: false },
      { name: 'target', type: 'string', description: 'Specific test file or path to target (e.g. "src/foo.test.ts")', required: false },
      { name: 'scope', type: 'string', description: 'For tests: "auto" (default; related tests only when safe), "related" (force targeted), "all" (whole suite).', required: false },
      { name: 'timeout', type: 'integer', description: 'Timeout in seconds (default: 120)', required: false },
    ],
    permission: 'shell',
    dangerous: true,
  },
  async execute(args, ctx) {
    const repo = detectRepo(ctx.cwd);
    const cmdType = String(args.command ?? 'test');
    const target = args.target ? String(args.target) : undefined;
    const timeoutSec = Math.min(Math.max(5, args.timeout ? Number(args.timeout) : 120), 600);

    // Determine the actual command to run based on project type
    let cmd: string;
    if (cmdType === 'auto' || !cmdType) {
      cmd = repo.testCommand || 'echo "No test command detected"';
    } else if (cmdType === 'test') {
      cmd = repo.testCommand || 'npm test -- --run';
    } else if (cmdType === 'build') {
      cmd = repo.buildCommand || 'npm run build';
    } else if (cmdType === 'typecheck') {
      cmd = repo.typecheckCommand || 'npx tsc --noEmit';
    } else if (cmdType === 'lint') {
      cmd = repo.lintCommand || 'npx eslint .';
    } else {
      cmd = cmdType;
    }

    // If a target is specified, try to incorporate it
    if (target && (cmdType === 'test' || cmd.includes('test'))) {
      cmd = `${cmd} ${target.includes('--') ? '' : '-- '}${target}`.trim();
    }

    // Changed-file-aware narrowing: when the caller didn't pin a target and
    // this is a test run, substitute the blast-radius subset command so the
    // loop gets feedback in seconds instead of the whole suite. Never narrows
    // when a target was given or scope is "all"; the policy planner falls
    // back to the full suite on large diffs, low confidence, and on a
    // cadence of periodic full runs. A narrowed run is labeled PARTIAL in
    // its output — the label is what lands in the trajectory, so no
    // downstream consumer can mistake it for certification evidence.
    let scopeNote = '';
    let planScope: 'targeted' | 'full' | null = null;
    const scope = String(args.scope ?? 'auto').toLowerCase();
    if (!target && scope !== 'all' && (cmdType === 'test' || cmdType === 'auto') && repo.testCommand) {
      try {
        const plan = await planVerificationTests(ctx.cwd, repo, repo.testCommand, {
          forceTargeted: scope === 'related',
        });
        planScope = plan.scope;
        if (plan.scope === 'targeted' && plan.command) {
          cmd = plan.command;
          scopeNote = `[PARTIAL] ${plan.reason} — this is a SUBSET of the suite, recorded as PARTIAL wherever it lands. It is feedback only, never certification evidence. Run verify with scope:"all" (or the full test command) before you finish.\n`;
        } else if (plan.scope === 'full') {
          scopeNote = `[FULL] ${plan.reason} — running the whole suite.\n`;
        }
      } catch {
        /* selection is best-effort; the full suite stands */
        planScope = null;
      }
    }

    const start = Date.now();
    try {
      const r = await runShellString(cmd, {
        cwd: ctx.cwd,
        timeoutMs: timeoutSec * 1000,
        maxOutput: 512 * 1024,
        env: { ...process.env, AI_AGENT: 'mochi' },
      });
      const duration = Date.now() - start;
      if (planScope) {
        try {
          recordSelectionRun(ctx.cwd, planScope);
        } catch { /* cadence state is best-effort */ }
      }
      const output = maybeRedact(`${r.stdout}${r.stderr ? `\n[stderr]:\n${r.stderr}` : ''}`).slice(0, 8000);
      if ((r.code ?? 1) === 0) {
        if (planScope === 'targeted') {
          return `${scopeNote}[PARTIAL PASS] Verification PASSED for the targeted subset only — NOT a full-suite verdict (${Math.round(duration / 1000)}s)\n${output}`;
        }
        return `${scopeNote}[PASS] Verification PASSED (${Math.round(duration / 1000)}s)\n${output}`;
      }
      const note = r.timedOut ? ' (timed out, SIGKILLed)' : '';
      return `${scopeNote}[FAIL] Verification FAILED (exit ${r.code ?? 1}${note}, ${Math.round(duration / 1000)}s)\n${output}`;
    } catch (err) {
      return `[ERR] Verification ERROR: ${maybeRedact(err instanceof Error ? err.message : String(err))}`;
    }
  },
};
