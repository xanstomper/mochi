// `mochi tools forged` — the Tool Forge audit + control surface.
//   mochi tools forged                 audit view (state, provenance, use)
//   mochi tools forged disable <name>  one-command disable (archived)
//   mochi tools forged evaluate        run the lifecycle evaluation now
//   mochi tools forged run [--min-runs N] [--max-forges N]
//                                      mine trajectories + synthesise + gate
// The audit view is the human's window into self-modification: every
// forged tool carries its provenance (the verifier-passed runs it was
// mined from), its probation/active state, and its invocation record.
import { loadConfigFile } from '../model/providers.js';
import { ALL_TOOLS_MAP, TOOL_ALIASES } from './index.js';
import {
  createModelSynthesizer, runForgePass, formatForgedToolsAudit,
  disableForgedTool, evaluateForgedToolLifecycle,
} from './tool-forge.js';

export interface ToolsCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi tools forged                  # audit view: every forged tool, its state + provenance
  mochi tools forged disable <name>   # disable a forged tool (bundle archived, recoverable)
  mochi tools forged evaluate         # run the promotion/trim lifecycle evaluation now
  mochi tools forged run [--min-runs 3] [--max-forges 2]
                                      # mine verifier-passed trajectories and forge new tools`;

function numFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export async function handleToolsCommand({ positional, flags, cwd }: ToolsCliArgs): Promise<void> {
  const sub = positional[1];
  if (sub !== 'forged') {
    console.log(USAGE);
    return;
  }
  const action = positional[2];

  if (!action || action === 'list') {
    console.log(formatForgedToolsAudit(cwd));
    return;
  }

  if (action === 'disable') {
    const name = positional[3];
    if (!name) {
      console.log('Usage: mochi tools forged disable <name>');
      return;
    }
    const ok = disableForgedTool(cwd, name);
    console.log(ok
      ? `Disabled forged tool '${name}' — bundle archived under .mochi/tools/.archive (recoverable by hand). It will not be advertised or executed again.`
      : `No live forged tool named '${name}' (unknown name, or already disabled).`);
    return;
  }

  if (action === 'evaluate') {
    const r = evaluateForgedToolLifecycle(cwd);
    console.log(`Forged-tool lifecycle evaluation:`);
    console.log(`  promoted: ${r.promoted.join(', ') || '(none)'}`);
    for (const t of r.trimmed) console.log(`  trimmed: ${t.name} — ${t.reason}`);
    if (r.trimmed.length === 0) console.log('  trimmed: (none)');
    console.log(`  probation stale: ${r.probationStale.join(', ') || '(none)'}`);
    return;
  }

  if (action === 'run') {
    const config = loadConfigFile();
    const builtinNames = new Set<string>([...ALL_TOOLS_MAP.keys(), ...Object.keys(TOOL_ALIASES)]);
    const minRuns = numFlag(flags, 'min-runs');
    const maxForges = numFlag(flags, 'max-forges');
    const result = await runForgePass(cwd, {
      synthesizer: createModelSynthesizer(config),
      builtinNames,
      ...(minRuns !== undefined ? { minRuns } : {}),
      ...(maxForges !== undefined ? { maxForges } : {}),
    });
    console.log(`Forge pass: ${result.candidatesFound} candidate(s) mined from verifier-passed trajectories.`);
    for (const name of result.forged) console.log(`  ✓ forged '${name}' — sandbox gate passed, born on probation.`);
    for (const d of result.discarded) console.log(`  ✗ discarded${d.name ? ` '${d.name}'` : ''} — ${d.reason}`);
    for (const s of result.skipped) console.log(`  · skipped — ${s.reason}`);
    if (result.forged.length === 0 && result.discarded.length === 0) {
      console.log('  Nothing to forge: no ≥4-step sequence repeats across ≥3 verifier-passed runs with stable argument shapes yet.');
    }
    return;
  }

  console.log(USAGE);
}
