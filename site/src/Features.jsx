// Clickable feature cards -> detail modal. Content = real repo facts.
import { useEffect, useState } from 'react';
import { Reveal } from './anim.jsx';

export const FEATURES = [
  {
    k: 'ENGINE', h: 'Compiled Rust core', tag: 'native/mochi_core',
    how: 'A zero-dependency Rust crate compiled to a native Node addon (N-API). It owns the hot paths: BPE tokenization, budget arithmetic, compaction cut planning, and agent-loop decisions. TypeScript calls across the boundary only at turn boundaries — never per token — so per-turn overhead is microseconds, not milliseconds.',
    facts: ['BPE tokenization: 0.28 ms per 100k chars', 'Compaction planning: 0.12 ms on 250-turn transcripts', 'Workspace indexing via N-API: 50k files in 3.8 ms', 'Every native path has a parity-tested TS fallback'],
  },
  {
    k: 'ORCHESTRATION', h: 'Goals → DAGs → teams', tag: 'mochi team',
    how: 'A goal given to mochi is decomposed into a task DAG: nodes with dependencies, each assigned to a specialized subagent role. The lead agent maps scope, coders implement in parallel with scoped tool allowlists, testers verify headlessly, and an outcome judge refuses to report done until checks pass. Roles, dependencies, and verification gates are all visible in the run trace.',
    facts: ['16 built-in roles with per-role tool allowlists', 'Independent verifiers + outcome judge before "done"', 'mochi team "goal" runs the whole swarm in one command', 'Every DAG node replayable via mochi trace'],
  },
  {
    k: 'RUNTIME', h: 'Persistent daemon', tag: 'mochi daemon',
    how: 'One background process (default port 8642) owns the agent loop. Jobs, approvals, resume, and cron schedules go over HTTP, so anything that can speak HTTP — a script, an editor, CI, a phone — can drive the same long-lived agent. Sessions survive terminal closes; work resumes where it stopped.',
    facts: ['start / status / jobs / send / approve / resume / cron / stop', 'Recurring jobs: mochi daemon cron add "0 9 * * *" "…"', 'Drive from scripts, editors, or CI over HTTP', 'Survives terminal close — sessions are durable'],
  },
  {
    k: 'CONTEXT', h: 'Adaptive context engine', tag: 'src/context.ts',
    how: 'Every turn is budgeted. Compaction planning decides what stays in the window and what gets summarized before the model ever sees an overflow. Project memory persists engineering facts across sessions, and retrieval spans files, AST symbols, and git history — so the agent reads less but knows more.',
    facts: ['Token budgets with pre-emptive compaction planning', 'Project memory survives across sessions', 'Retrieval across files, symbols, and git history', 'Fidelity-tested: context.test.ts, compaction-fidelity suites'],
  },
  {
    k: 'INTELLIGENCE', h: 'AST-native tooling', tag: 'tree-sitter codegraph',
    how: 'A tree-sitter codegraph covers 15 languages. The agent can find callers, resolve type hierarchies, and rewrite or rename symbols project-wide without anchor drift — edits are structural, not string matching. read with skeleton:true returns an AST outline at 85% fewer tokens.',
    facts: ['15 languages indexed', 'replace_symbol / rename_symbol — atomic, whole-symbol rewrites', 'find_callers, type_hierarchy, find_references, find_definitions', 'read skeleton:true → 85% token reduction'],
  },
  {
    k: 'SAFETY', h: 'Budgets & checkpoints', tag: 'safe / ask / auto',
    how: 'Six independent limiters — token, cost, time, tool, model, and agent-count — cap every run. Permissions run through safe / ask / auto, and every destructive action sits on a git checkpoint with one-command rollback. The agent physically cannot run away with your repo.',
    facts: ['Token, cost, time, tool, model, agent limits', 'safe / ask / auto permission modes', 'Git checkpoint + rollback under destructive actions', 'Subagent timeout fences and stall guards'],
  },
  {
    k: 'OBSERVABILITY', h: 'Deep run traces', tag: 'mochi trace',
    how: 'Every goal run is durable and replayable end-to-end: each agent turn, tool call, diff, and decision recorded with deep redaction of secrets. Full-text session search (SQLite + FTS5) means "what did it do last Tuesday" is one command: mochi session search.',
    facts: ['mochi trace <goalId> replays any run', 'Deep redaction on all recorded content', 'SQLite + FTS5 full-text session search', 'Diff-level visibility into every change'],
  },
  {
    k: 'MODELS', h: 'Provider-agnostic', tag: 'any OpenAI-compatible endpoint',
    how: 'Point mochi at any OpenAI-compatible API. Capability routing picks fast / coding / reasoning / review models per task; budget-aware fallback fails over mid-run without losing context; multi-key rotation spreads load. The agent loop never depends on a single vendor.',
    facts: ['Any OpenAI-compatible endpoint', 'Capability-based routing per task type', 'Budget-aware fallback keeps runs alive', 'Multi-key rotation built in'],
  },
  {
    k: 'LEARNING', h: 'Harness that learns', tag: 'project memory',
    how: 'When the agent recovers from a failure — a flaky test, a wrong assumption, a build quirk — the successful strategy is recorded to local project memory and reused next time. Same project, smarter agent, every session, with zero cloud round-trips.',
    facts: ['Successful recovery strategies recorded locally', 'Reused automatically in later sessions', 'All learning stays on your machine', 'Curated via the memory tool, searchable'],
  },
];

export function FeatureModal({ f, onClose }) {
  useEffect(() => {
    const esc = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        <span className="k">{f.k}</span>
        <h3 style={{ fontSize: 22, fontWeight: 800, margin: '4px 0 4px' }}>{f.h}</h3>
        <code style={{ display: 'inline-block', marginBottom: 16 }}>{f.tag}</code>
        <p style={{ marginBottom: 18 }}>{f.how}</p>
        <h4 style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 10 }}>How it works in mochi</h4>
        <ul className="modal-list">
          {f.facts.map(x => <li key={x}>{x}</li>)}
        </ul>
        <a className="btn soft" style={{ marginTop: 22 }} href={`https://github.com/xanstomper/mochi/search?q=${encodeURIComponent(f.tag)}`} target="_blank" rel="noopener">Find it in the source →</a>
      </div>
    </div>
  );
}

export function FeatureGrid() {
  const [open, setOpen] = useState(null);
  return (
    <>
      <div className="grid3 feat-grid">
        {FEATURES.map((f, i) => (
          <Reveal as="button" className="card feat-card" delay={i % 3} key={i} onClick={() => setOpen(f)}>
            <span className="k">{f.k}</span>
            <h3><span className="dot"></span>{f.h}</h3>
            <p>{f.how.split('.')[0]}.</p>
            <span className="more">click to see how it works <b>→</b></span>
          </Reveal>
        ))}
      </div>
      {open && <FeatureModal f={open} onClose={() => setOpen(null)} />}
    </>
  );
}
