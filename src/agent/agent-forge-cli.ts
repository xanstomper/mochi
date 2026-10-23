// `mochi forge-agents` — the Agent Forge audit + control surface.
//   mochi forge-agents                    audit view (personas, state, provenance, ledger)
//   mochi forge-agents disable <name>     discard a persona (archived, recoverable by hand)
//   mochi forge-agents evaluate           run the promotion/discard lifecycle evaluation now
//   mochi forge-agents run [--max-forges N]
//                                         mine trajectories + synthesise + probe + persist
// The audit view is the human's window into spawn-persona self-modification:
// every forged persona carries its provenance (the verifier-passed runs it
// was mined from), its probation/active state, and its spawn ledger.
import { loadConfigFile } from '../model/providers.js';
import {
  listForgedPersonas, evaluateAgentForgeLifecycle, discardForgedPersona,
  runAgentForgePass, createModelAgentForgeSynthesizer,
} from './agent-forge.js';

export interface ForgeAgentsCliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  cwd: string;
}

const USAGE = `Usage:
  mochi forge-agents                    # audit view: every forged persona, its state + provenance
  mochi forge-agents disable <name>     # discard a forged persona (archived; recoverable by hand)
  mochi forge-agents evaluate           # run the promotion/discard lifecycle evaluation now
  mochi forge-agents run [--max-forges 2]
                                        # mine verifier-passed trajectories and forge new personas`;

function numFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

const STATE_MARK: Record<string, string> = { probation: '◆', active: '●', discarded: '✗', archived: '·' };

export async function handleForgeAgentsCommand({ positional, flags, cwd }: ForgeAgentsCliArgs): Promise<void> {
  const action = positional[1];

  if (!action || action === 'list') {
    const personas = listForgedPersonas(cwd);
    if (personas.length === 0) {
      console.log('No forged personas yet. Run `mochi forge-agents run` after a few verifier-passed runs that delegate subagents.');
      return;
    }
    console.log(`Forged spawn personas (${personas.length}) — resolve at spawn time as forged/<name>:\n`);
    for (const p of personas) {
      const mark = STATE_MARK[p.state] ?? '?';
      const tools = p.tools ? ` tools=[${p.tools.join(',')}]` : ' tools=(inherited)';
      console.log(`  ${mark} forged/${p.name}  ${p.state}  base=${p.basePreset}${tools}`);
      console.log(`      ${p.description}`);
      console.log(`      provenance: ${p.provenanceRunIds.length} verifier-passed run(s) [${p.provenanceRunIds.slice(0, 3).join(', ')}${p.provenanceRunIds.length > 3 ? ', …' : ''}]`);
      console.log(`      ledger: ${p.uses} use(s), ${p.helpful} helpful, ${p.regressions} regression(s)${p.avgTokenDelta != null ? `, avg token delta ${p.avgTokenDelta >= 0 ? '+' : ''}${Math.round(p.avgTokenDelta)}` : ''}\n`);
    }
    return;
  }

  if (action === 'disable') {
    const name = positional[2];
    if (!name) {
      console.log('Usage: mochi forge-agents disable <name>');
      return;
    }
    const ok = discardForgedPersona(cwd, name, 'disabled by operator');
    console.log(ok
      ? `Discarded forged persona '${name}' (state + reason recorded in the forge log). It will not resolve at spawn time again.`
      : `No live forged persona named '${name}' (unknown name, or already discarded).`);
    return;
  }

  if (action === 'evaluate') {
    const { promoted, trimmed } = evaluateAgentForgeLifecycle(cwd);
    console.log('Agent-forge lifecycle evaluation:');
    console.log(`  promoted: ${promoted.join(', ') || '(none)'}`);
    if (trimmed.length === 0) console.log('  trimmed: (none)');
    for (const name of trimmed) console.log(`  trimmed: forged/${name} — stale probation (never helpful within the window)`);
    return;
  }

  if (action === 'run') {
    const config = loadConfigFile();
    const maxForges = numFlag(flags, 'max-forges');
    const result = await runAgentForgePass(cwd, {
      synthesizer: createModelAgentForgeSynthesizer(config),
      ...(maxForges !== undefined ? { maxForges } : {}),
    });
    console.log(`Agent-forge pass: ${result.candidatesFound} delegation shape(s) mined from verifier-passed trajectories.`);
    for (const name of result.forged) console.log(`  ✓ forged '${name}' — static + probe gates passed, born on probation (forged/${name}).`);
    for (const d of result.discarded) console.log(`  ✗ discarded — ${d.reason}`);
    for (const s of result.skipped) console.log(`  · skipped — ${s.reason}`);
    if (result.forged.length === 0 && result.discarded.length === 0) {
      console.log('  Nothing to forge: no delegation shape repeats across ≥3 verifier-passed runs yet.');
    }
    return;
  }

  console.log(USAGE);
}
