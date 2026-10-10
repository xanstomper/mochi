import React from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';

function Docs() {
  return (
    <>
      <div className="wrap layout">
        <aside className="sidebar rv in">
          <div className="grp"><h5>Get started</h5>
            <a href="#install">Installation</a><a href="#first-run">First run</a><a href="#cli">CLI reference</a>
          </div>
          <div className="grp"><h5>Core concepts</h5>
            <a href="#architecture">Architecture</a><a href="#roles">Agent roles</a><a href="#tools">Native tools</a><a href="#daemon">Daemon</a><a href="#sessions">Sessions &amp; traces</a>
          </div>
          <div className="grp"><h5>Reference</h5>
            <a href="benchmarks.html">Benchmarks</a>
            <a href="https://github.com/xanstomper/mochi/blob/main/docs/CAPABILITIES.md" target="_blank" rel="noopener">Full capabilities</a>
            <a href="https://github.com/xanstomper/mochi/blob/main/docs/ARCHITECTURE.md" target="_blank" rel="noopener">Architecture blueprint</a>
          </div>
        </aside>

        <main className="doc-body">
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Documentation <Mochi size={44} mood="wink" className="mascot" /></h1>
          <p className="lede">Mochi — Minimal Orchestrative Coding Harness Intelligence — is an autonomous coding agent for the terminal. This page covers installation, core concepts, and the CLI. Deep dives live in the repo's <code>docs/</code>.</p>

          <h2 id="install">Installation</h2>
          <p>Requires Node 22+ or Bun. Mochi has zero runtime JavaScript dependencies.</p>
          <pre>{`# clone and build
git clone https://github.com/xanstomper/mochi.git
cd mochi
npm install && npm run build

# optional: standalone native binary (no runtime needed)
npm run build:bin`}</pre>
          <p>A memory regression gate (<code>npm run bench:memory</code>) runs in CI after every build and fails above 80 MB codegraph import / 95 MB runtime import — lazy-loading wins can't silently regress.</p>

          <h2 id="first-run">First run</h2>
          <pre>{`# interactive TUI
mochi

# one-shot headless run
mochi "add a rate limiter to the auth service"

# multi-agent swarm
mochi team "ship the payments refactor"`}</pre>
          <p>One-shot runs execute to completion with verification; <code>mochi trace &lt;goalId&gt;</code> replays the whole run afterwards.</p>

          <h2 id="cli">CLI reference</h2>
          <table>
            <tbody>
              {[['mochi', 'Launch the interactive terminal UI'], ['mochi "prompt"', 'TUI preloaded with a prompt'],
                ['mochi daemon start --host 0.0.0.0', 'Start background daemon on port 8642'],
                ['mochi daemon status', 'Daemon status and active jobs'],
                ['mochi daemon send "task"', 'Send a task to the running daemon'],
                ['mochi daemon jobs', 'List in-flight and completed jobs'],
                ['mochi daemon cron add|list|remove', 'Recurring agent jobs on a schedule'],
                ['mochi daemon stop', 'Stop the background daemon'],
                ['mochi team "goal"', 'Decompose and run across a role-diverse swarm'],
                ['mochi trace [goalId]', 'Replay a run end to end (deep redaction)'],
                ['mochi session list / search "q"', 'Full-text SQLite+FTS5 history search'],
                ['mochi termix --sessions 3', 'Split-pane agent workspace'],
                ['mochi acp', 'Agent Client Protocol v1 stdio server'],
                ['mochi doctor', 'Health check: workspace, tools, compilers'],
                ['mochi skills', 'List bundled and project skills']].map(([c, d]) => (
                <tr key={c}><td><code>{c}</code></td><td>{d}</td></tr>
              ))}
            </tbody>
          </table>
          <p>The TUI itself has a rounded input, live transcript, command palette, and status bar. Interactive slash commands and keybindings are in the <a href="https://github.com/xanstomper/mochi/blob/main/docs/CLI_REFERENCE.md" target="_blank" rel="noopener">full CLI reference</a>.</p>

          <h2 id="architecture">Architecture</h2>
          <p>Mochi is a dual-engine harness:</p>
          <ul>
            <li><strong>Rust core</strong> (<code>native/mochi_core</code>) — a zero-dependency compiled crate handling BPE tokenization (0.28 ms / 100k chars), compaction cut planning (0.12 ms on 250-turn transcripts), N-API workspace indexing (50k files in 3.8 ms), and agent-loop decisions.</li>
            <li><strong>TypeScript frontend</strong> — model I/O, tool execution, TUI rendering via direct ANSI (no webview, no Electron), persistence (SQLite+FTS5).</li>
            <li><strong>Parity-tested fallbacks</strong> — every native path has a TypeScript equivalent, so CI and cold installs work when the Rust binary is absent.</li>
          </ul>
          <p>Implemented systems include the event bus, model routing by capability profile, budget-aware fallback, codex-style multi-file patches with whitespace-tolerant matching, hook pipelines, speculative execution, credential pools, and multiple workspaces. See the <a href="https://github.com/xanstomper/mochi/blob/main/docs/ARCHITECTURE.md" target="_blank" rel="noopener">architecture blueprint</a>.</p>

          <h2 id="roles">Agent roles</h2>
          <p>Sixteen specialized subagents spawn via <code>subagent</code> or <code>mochi team</code>. Each role gets a capability profile and a scoped tool allowlist:</p>
          <table><tbody>
            {[['lead', 'reasoning', 'Decomposes goals into DAGs, coordinates swarms, resolves blockers'],
              ['coder', 'coding', 'Full-stack implementation, surgical diffs, headless test verification'],
              ['reviewer', 'review', 'Read-only PR/diff inspection, SOLID/DRY audits, edge cases'],
              ['tester', 'fast', 'Test creation, bug reproduction, suite execution'],
              ['researcher', 'fast', 'AST/call-graph traversal, doc indexing, web research'],
              ['debugger', 'reasoning', 'Root-cause diagnosis, hypothesis testing, telemetry injection'],
              ['security', 'reasoning', 'OWASP auditing, threat modeling, secret-leak detection'],
              ['architect', 'reasoning', 'API contracts, distributed trade-offs, service boundaries'],
              ['devops', 'coding', 'Dockerfiles, K8s manifests, CI/CD, Terraform'],
              ['db_admin', 'reasoning', 'Schema migrations, index design, EXPLAIN analysis'],
              ['frontend / backend', 'coding', 'UI components; REST/GraphQL/gRPC APIs and concurrency'],
              ['performance', 'reasoning', 'Hotspot profiling, leak detection, Big-O optimization'],
              ['tech_writer', 'coding', 'ADRs, READMEs, Mermaid diagrams, API references'],
              ['qa_engineer', 'coding', 'Playwright/Cypress E2E, visual regression, smoke tests'],
              ['data_scientist', 'reasoning', 'Pandas/Polars wrangling, PyTorch/TensorFlow modeling']].map(([r, t, d]) => (
              <tr key={r}><td><strong>{r}</strong></td><td><code>{t}</code></td><td>{d}</td></tr>
            ))}
          </tbody></table>
          <p>Agent profiles are also user-definable from <code>.mochi/agents/*.md</code>.</p>

          <h2 id="tools">Native tools</h2>
          <h3>Editing</h3>
          <p><code>edit</code> (anchor-matched, whitespace-tolerant), <code>patch</code> (multi-file <code>*** Begin Patch</code> format that refuses ambiguity rather than guessing), <code>write</code>, <code>delete</code>, <code>replace_symbol</code> (AST-driven whole-symbol rewrite), <code>rename_symbol</code> (project-wide atomic), <code>search_replace_multi</code>, <code>regex_replace</code>.</p>
          <h3>Code intelligence</h3>
          <p><code>get_function</code>, <code>find_callers</code>, <code>type_hierarchy</code>, <code>find_references</code>, <code>find_definitions</code>, <code>analyze_code</code>. <code>read</code> also supports <code>skeleton: true</code> for 85% token reduction on AST outlines.</p>
          <h3>Execution &amp; inspection</h3>
          <p><code>shell</code> (background jobs), <code>repl</code> (stateful Node/Python/Shell), <code>search</code> (N-API accelerated, sub-millisecond), <code>glob</code>, <code>inspect</code>, plus <code>git</code>, <code>memory</code>, <code>todo</code>, <code>skill</code>, <code>subagent</code>.</p>
          <p>Permissions run through a safe / ask / auto system with git checkpoint and rollback underneath.</p>

          <h2 id="daemon">Daemon</h2>
          <pre>{`mochi daemon start --host 0.0.0.0   # port 8642
mochi daemon send "run the test suite"
mochi daemon cron add "0 9 * * *" "triage open issues"`}</pre>
          <p>The daemon exposes <code>start / status / jobs / send / approve / resume / cron / stop</code> over HTTP, so editors, scripts, and CI can drive the same long-lived agent.</p>

          <h2 id="sessions">Sessions &amp; traces</h2>
          <p>Every session is stored in SQLite with FTS5 full-text search (<code>mochi session search "compaction bug"</code>). Every goal run produces a durable trace with deep redaction — replay it with <code>mochi trace &lt;goalId&gt;</code>.</p>

          <p style={{ marginTop: 40, paddingTop: 20, borderTop: '1.5px solid var(--line)', fontSize: 13.5, color: 'var(--muted)' }}>
            More: <a href="https://github.com/xanstomper/mochi/blob/main/docs/CAPABILITIES.md" target="_blank" rel="noopener">Complete capabilities reference</a> · <a href="https://github.com/xanstomper/mochi/blob/main/docs/CLI_REFERENCE.md" target="_blank" rel="noopener">CLI &amp; interface reference</a> · <a href="benchmarks.html">Benchmarks</a>
          </p>
        </main>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Docs />);
