import React from 'react';
import { createRoot } from 'react-dom/client';
import Footer from '../Footer.jsx';
import FilmGrain from '../FilmGrain.jsx';
import { AnimatedContent, Reveal } from '../anim.jsx';

  const SKILLS = {
  'AI Architectures & Protocols': ['gpt-5-agent', 'o3-reasoning', 'deep-research', 'anthropic-research', 'cursor-workflow', 'devin-mode', 'github-copilot', 'vscode-copilot', 'gemini-learning', 'claude-design', 'hermes-workflow'],
  'System Integration': ['mcp-setup', 'acp-setup', 'mochi-architecture', 'core-harness', 'tools-design', 'memory-design', 'replication-design'],
  'Domain Engineering': ['rust-engineer', 'golang-pro', 'python-expert', 'typescript-master', 'frontend-craft', 'backend-architecture', 'docker-containerization', 'database-optimizer', 'performance-profiling', 'security-audit', 'tdd-workflow', 'code-refactoring', 'code-review', 'api-design', 'git-wizard'],
};

const ROLES = [
  ['lead', 'reasoning', 'Decomposes goals into DAGs, coordinates swarms, resolves blockers'],
  ['coder', 'coding', 'Full-stack implementation, surgical diffs, headless test verification'],
  ['reviewer', 'review', 'Read-only PR/diff inspection, SOLID/DRY audits, edge cases'],
  ['tester', 'fast', 'Test creation, bug reproduction, suite execution'],
  ['researcher', 'fast', 'AST/call-graph traversal, doc indexing, web research'],
  ['debugger', 'reasoning', 'Root-cause diagnosis, hypothesis testing, telemetry injection'],
  ['security', 'reasoning', 'OWASP auditing, threat modeling, secret-leak detection'],
  ['architect', 'reasoning', 'API contracts, distributed trade-offs, service boundaries'],
  ['devops', 'coding', 'Dockerfiles, K8s manifests, CI/CD, Terraform'],
  ['db_admin', 'reasoning', 'Schema migrations, index design, EXPLAIN analysis'],
  ['frontend', 'coding', 'UI components and interaction logic'],
  ['backend', 'coding', 'REST/GraphQL/gRPC APIs and concurrency'],
  ['performance', 'reasoning', 'Hotspot profiling, leak detection, Big-O optimization'],
  ['tech_writer', 'coding', 'ADRs, READMEs, Mermaid diagrams, API references'],
  ['qa_engineer', 'coding', 'Playwright/Cypress E2E, visual regression, smoke tests'],
  ['data_scientist', 'reasoning', 'Pandas/Polars wrangling, PyTorch/TensorFlow modeling'],
];

const TOOLS = {
  'Editing': [['edit', 'anchor-matched, whitespace-tolerant'], ['patch', 'multi-file *** Begin Patch, refuses ambiguity'], ['write', 'create/overwrite files'], ['delete', 'remove files/dirs'], ['replace_symbol', 'AST-driven whole-symbol rewrite'], ['rename_symbol', 'project-wide atomic rename'], ['search_replace_multi', 'batch replacements'], ['regex_replace', 'regex-driven edits']],
  'Code intelligence': [['get_function', 'extract a function by name'], ['find_callers', 'reverse call graph'], ['type_hierarchy', 'resolve inheritance'], ['find_references', 'all usages of a symbol'], ['find_definitions', 'locate declarations'], ['analyze_code', 'structure/complexity report'], ['read', 'with skeleton:true → AST outline, 85% fewer tokens']],
  'Execution': [['shell', 'with background jobs'], ['repl', 'stateful Node/Python/Shell'], ['search', 'N-API accelerated, sub-millisecond'], ['glob', 'async, hard-bounded walker'], ['inspect', 'runtime introspection']],
  'Agent & state': [['git', 'checkpoints, rollback'], ['memory', 'persistent project memory'], ['todo', 'task tracking'], ['skill', 'load SKILL.md workflows'], ['subagent', 'spawn any of 16 roles']],
};

const SIDEBAR = [
  ['Get started', [['install', 'Installation'], ['first-run', 'First run'], ['cli', 'CLI reference']]],
  ['Core concepts', [['architecture', 'Architecture'], ['roles', 'Agent roles'], ['tools', 'Native tools'], ['skills', 'Skills'], ['mcp-acp', 'MCP & ACP'], ['daemon', 'Daemon'], ['sessions', 'Sessions & traces'], ['safety', 'Permissions & safety']]],
  ['Reference', [['benchmarks.html', 'Benchmarks'], ['source.html', 'Source browser'], ['https://github.com/xanstomper/mochi/blob/main/docs/CAPABILITIES.md', 'Full capabilities ↗'], ['https://github.com/xanstomper/mochi/blob/main/docs/ARCHITECTURE.md', 'Architecture blueprint ↗']]],
];

function Docs() {
  const [toolTab, setToolTab] = React.useState('Editing');
  return (
    <>
      <FilmGrain />
      <div className="pagehead">
        <div className="wrap">
          <div className="pagehead-row">
            <div className="pagehead-col">
              <AnimatedContent direction="bottom" delay={0.1}>
                <div className="hero-eyebrow">
                  <span className="sparkle" />
                  DOCUMENTATION
                </div>
              </AnimatedContent>
              <h1 className="pagehead-title">Everything Mochi can do.</h1>
              <AnimatedContent direction="bottom" delay={0.5}>
                <p className="lede" style={{ marginTop: 16, maxWidth: 620 }}>
                  Installation, the 16 agent roles, every native tool, skills, MCP — the complete reference in one place.
                </p>
              </AnimatedContent>
            </div>
          </div>
        </div>
      </div>

      {/* Full docs */}
      <div className="wrap layout">
        <aside className="sidebar rv in">
          {SIDEBAR.map(([g, items]) => (
            <div className="grp" key={g}><h5>{g}</h5>
              {items.map(([href, label]) => (
                <a key={href} href={href.startsWith('http') || href.endsWith('.html') ? href : '#' + href} {...href.startsWith('http') && { target: '_blank', rel: 'noopener' }}>{label}</a>
              ))}
            </div>
          ))}
        </aside>

        <main className="doc-body">
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Documentation</h1>
          <p className="lede">Everything mochi can do, and exactly how. Mochi is an autonomous coding agent for the terminal with a zero-dependency Rust core, 16 agent roles, 30+ skills, AST-native tooling, and a persistent daemon.</p>

          <h2 id="install">Installation</h2>
          <Reveal as="div">
            <p>Requires Node 22+ or Bun. Mochi has zero runtime JavaScript dependencies.</p>
            <pre>{`# clone and build
git clone https://github.com/xanstomper/mochi.git
cd mochi
npm install && npm run build

# optional: standalone native binary (no runtime needed)
npm run build:bin`}</pre>
            <p>A memory regression gate (<code>npm run bench:memory</code>) runs in CI after every build and fails above 80 MB codegraph import / 95 MB runtime import — lazy-loading wins can't silently regress.</p>
          </Reveal>

          <h2 id="first-run">First run</h2>
          <pre>{`# interactive TUI
mochi

# one-shot headless run
mochi "add a rate limiter to the auth service"

# multi-agent swarm
mochi team "ship the payments refactor"`}</pre>
          <p>One-shot runs execute to completion with verification; <code>mochi trace &lt;goalId&gt;</code> replays the whole run afterwards.</p>

          <h2 id="cli">CLI reference</h2>
          <Reveal as="table">
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
                ['mochi skills', 'List all bundled and project skills'],
                ['mochi import-skills <src>', 'Adopt an external SKILL.md tree into ~/.mochi/skills'],
                ['mochi import-skills <src> --list', 'Dry-run: list discoverable skills without importing'],
                ['mochi import-skills <src> --update', 'Refresh a cached git clone before importing']].map(([c, d]) => (
                <tr key={c}><td><code>{c}</code></td><td>{d}</td></tr>
              ))}
            </tbody>
          </Reveal>

          <h2 id="architecture">Architecture</h2>
          <p>Mochi runs on a dual-engine core:</p>
          <Reveal as="ul">
            <li><strong>Rust core</strong> (<code>native/mochi_core</code>) — a zero-dependency compiled crate handling BPE tokenization (0.28 ms / 100k chars), compaction cut planning (0.12 ms on 250-turn transcripts), N-API workspace indexing (50k files in 3.8 ms), and agent-loop decisions.</li>
            <li><strong>TypeScript frontend</strong> — model I/O, tool execution, TUI rendering via direct ANSI (no webview, no Electron), persistence (SQLite+FTS5).</li>
            <li><strong>Parity-tested fallbacks</strong> — every native path has a TypeScript equivalent, so CI and cold installs work when the Rust binary is absent.</li>
          </Reveal>
          <p>Implemented systems include the event bus, model routing by capability profile, budget-aware fallback, codex-style multi-file patches with whitespace-tolerant matching, hook pipelines, speculative execution, credential pools, and multiple workspaces. See the <a href="https://github.com/xanstomper/mochi/blob/main/docs/ARCHITECTURE.md" target="_blank" rel="noopener">architecture blueprint</a>.</p>

          <h2 id="roles">Agent roles</h2>
          <p>Sixteen specialized subagents spawn via <code>subagent</code> or <code>mochi team</code>. Each role gets a capability profile and a scoped tool allowlist:</p>
          <Reveal as="table"><tbody>
            {ROLES.map(([r, t, d]) => (
              <tr key={r}><td><strong>{r}</strong></td><td><code>{t}</code></td><td>{d}</td></tr>
            ))}
          </tbody></Reveal>
          <p>Agent profiles are also user-definable from <code>.mochi/agents/*.md</code>.</p>

          <h2 id="tools">Native tools</h2>
          <div className="tabrow">
            {Object.keys(TOOLS).map(t => (
              <button key={t} className={'tabbtn' + (t === toolTab ? ' on' : '')} onClick={() => setToolTab(t)}>{t}</button>
            ))}
          </div>
          <Reveal as="table" key={toolTab} className="tbl" style={{ display: 'table' }}><tbody>
            {TOOLS[toolTab].map(([c, d]) => (
              <tr key={c}><td><code>{c}</code></td><td style={{ fontFamily: 'var(--sans)', whiteSpace: 'normal' }}>{d}</td></tr>
            ))}
          </tbody></Reveal>

          <h2 id="skills">Skills</h2>
          <p>Mochi bundles 30+ <code>SKILL.md</code> workflows, invoked via the <code>skill</code> tool or the command palette. Import your own trees with <code>mochi import-skills</code> — from local paths, agent aliases (<code>hermes:</code> → <code>~/.hermes/skills</code>), or remote git (<code>github:owner/repo</code>). Imports are origin-namespaced and non-destructive.</p>
          {Object.entries(SKILLS).map(([cat, list]) => (
            <Reveal as="div" key={cat} className="skill-cat">
              <h3>{cat}</h3>
              <div className="chips">
                {list.map(s => <code key={s} className="chip">{s}</code>)}
              </div>
            </Reveal>
          ))}

          <h2 id="mcp-acp">MCP &amp; ACP</h2>
          <p><strong>Model Context Protocol:</strong> connect any external MCP server (Postgres, GitHub, SQLite, Sentry) configured in <code>~/.mochi/config.json</code>:</p>
          <pre>{`{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres",
               "postgresql://localhost/mydb"]
    }
  }
}`}</pre>
          <p><strong>Agent Client Protocol:</strong> <code>mochi acp</code> runs a v1 stdio server, so editors and other clients can embed the same agent.</p>

          <h2 id="daemon">Daemon</h2>
          <pre>{`mochi daemon start --host 0.0.0.0   # port 8642
mochi daemon send "run the test suite"
mochi daemon cron add "0 9 * * *" "triage open issues"`}</pre>
          <p>The daemon exposes <code>start / status / jobs / send / approve / resume / cron / stop</code> over HTTP, so editors, scripts, and CI can drive the same long-lived agent.</p>

          <h2 id="sessions">Sessions &amp; traces</h2>
          <p>Every session is stored in SQLite with FTS5 full-text search (<code>mochi session search "compaction bug"</code>). Every goal run produces a durable trace with deep redaction — replay it with <code>mochi trace &lt;goalId&gt;</code>.</p>

          <h2 id="safety">Permissions &amp; safety</h2>
          <p>Six independent limiters — token, cost, time, tool, model, agent-count. Permissions run through safe / ask / auto, with git checkpoint and rollback underneath every destructive action. Live network tests are opt-in (<code>MOCHI_LIVE=1</code>); the default suite is deterministic and never touches the network.</p>

          <p style={{ marginTop: 40, paddingTop: 20, borderTop: '1.5px solid var(--line)', fontSize: 13.5, color: 'var(--muted)' }}>
            More: <a href="https://github.com/xanstomper/mochi/blob/main/docs/CAPABILITIES.md" target="_blank" rel="noopener">Complete capabilities reference</a> · <a href="https://github.com/xanstomper/mochi/blob/main/docs/CLI_REFERENCE.md" target="_blank" rel="noopener">CLI &amp; interface reference</a> · <a href="benchmarks.html">Benchmarks</a> · <a href="source.html">Source browser</a>
          </p>
        </main>
      </div>

      {/* Dark CTA banner */}
      <div className="wrap" style={{ padding: '0 24px 80px' }}>
        <div style={{
          background: 'linear-gradient(135deg, #1A1633 0%, #2D2460 100%)',
          borderRadius: 20,
          padding: '36px 40px',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 20,
        }}>
          <p style={{ color: 'rgba(255,255,255,.85)', fontSize: 16, margin: 0 }}>
            Want to stay updated? Follow us for the latest releases and announcements.
          </p>
          <a
            href="https://x.com/xanstomper"
            target="_blank"
            rel="noopener"
            className="btn btn-primary"
          >
            𝕏 Follow on X
          </a>
        </div>
      </div>

      <Footer />
    </>
  );
}
createRoot(document.getElementById('root')).render(<Docs />);
