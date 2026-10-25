import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import Footer from '../Footer.jsx';
import EngineeringGridBackground from '../EngineeringGridBackground.jsx';
import { AnimatedContent } from '../anim.jsx';
import {
  IconRocket, IconTerminal, IconUsers, IconWrench,
  IconBox, IconGlobe, IconSearch, IconCheck, IconShield,
} from '../icons.jsx';

const DOC_CARDS = [
  { icon: IconRocket, title: 'Quickstart & Installation', desc: 'Single-binary setup, curl installer, package managers, and build from source.', link: '#install' },
  { icon: IconTerminal, title: 'CLI & TUI Reference', desc: 'All CLI flags, interactive terminal mode, 22 slash commands, and hotkey bindings.', link: '#cli' },
  { icon: IconUsers, title: '16 Specialist Roles', desc: 'Goal decomposition, directed acyclic graphs (DAGs), and role-diverse swarms.', link: '#roles' },
  { icon: IconWrench, title: '30+ Deterministic Tools', desc: 'AST editing, unified diff patch, Ripgrep, native LSP, and Bubblewrap sandbox.', link: '#tools' },
  { icon: IconBox, title: 'Skills Runtime & MCP', desc: 'Dynamic ~/.mochi/skills/ injection, hermes skill import, and MCP/ACP stdio servers.', link: '#skills' },
  { icon: IconGlobe, title: 'Daemon API & CI/CD', desc: 'Port 8642 background daemon, REST & JSON-RPC endpoints, and headless workflows.', link: '#daemon' },
];

const ROLES = [
  ['lead', 'reasoning', 'Decomposes goals into directed acyclic graphs (DAGs), coordinates swarms, resolves blockers, and manages task dependencies.'],
  ['coder', 'coding', 'Full-stack software engineering, AST-guided surgical diffs, headless compiler/linter hooks, and test-driven fixes.'],
  ['reviewer', 'review', 'Read-only PR and diff inspection, SOLID/DRY principle audits, edge-case analysis, and cyclomatic complexity gates.'],
  ['tester', 'fast', 'Automated test suite creation, regression reproducer generation, vitest/pytest execution, and coverage analysis.'],
  ['researcher', 'fast', 'Abstract syntax tree (AST) traversal, call-graph indexing, documentation lookup, and external web research.'],
  ['debugger', 'reasoning', 'Root-cause analysis, hypothesis-driven testing, runtime telemetry injection, and core dump dissection.'],
  ['security', 'reasoning', 'OWASP vulnerability scanning, threat modeling, dependency supply-chain audit, and secret-leak detection.'],
  ['architect', 'reasoning', 'API contract specification, distributed system trade-off modeling, schema migrations, and service boundaries.'],
  ['devops', 'coding', 'Containerization (Docker/Podman), CI/CD workflows, Kubernetes manifests, and infrastructure-as-code (Terraform).'],
  ['frontend', 'coding', 'UI component systems, Tailwind/CSS architecture, responsive layouts, web accessibility (a11y), and state management.'],
  ['backend', 'coding', 'REST/GraphQL/gRPC API microservices, database queries, ACID transaction safety, and high-concurrency loops.'],
  ['performance', 'reasoning', 'Hotspot profiling, memory leak detection, heap-snapshot analysis, algorithmic optimization, and cache tuning.'],
  ['data', 'coding', 'Data engineering pipelines, SQL optimization, schema ETL scripts, and analytical metric aggregation.'],
  ['docs', 'fast', 'Technical documentation authoring, OpenAPI/Swagger specifications, changelog synthesis, and user guides.'],
  ['mobile', 'coding', 'React Native and native mobile application logic, layout adaptation, platform lifecycle handling, and build tuning.'],
  ['qa', 'fast', 'End-to-end integration flows, browser automation verification, smoke tests, and user-story acceptance criteria.'],
];

const SLASH_COMMANDS = [
  ['/help', 'Display interactive command cheat-sheet and available tools.'],
  ['/clear', 'Clear visible transcript lines while preserving execution context.'],
  ['/new', 'Start a completely fresh session (clears checkpoints, memory, and state).'],
  ['/sessions', 'Interactive session switcher and full-text history browser.'],
  ['/rename', 'Rename the active session for organized transcript tracking.'],
  ['/export', 'Export current session transcript to structured JSON on disk.'],
  ['/import', 'Import and replay a historical session transcript.'],
  ['/model', 'Interactive model and provider selector (OpenCode, Claude, GPT, Ollama).'],
  ['/theme', 'Interactive 15-theme live preview and switcher with instant redraw.'],
  ['/doctor', 'Run full environment health check on workspace, compilers, and tools.'],
  ['/usage', 'Display real-time token usage, cost expenditure, and cache hit efficiency.'],
  ['/init', 'Scaffold project MOCHI.md configuration file in the repository root.'],
  ['/branch', 'Inspect active git status, modified files, and working branch.'],
  ['/commit', 'Create an atomic git checkpoint commit with automated message.'],
  ['/run <cmd>', 'Execute a sandboxed shell command directly in the active workspace.'],
  ['/test', 'Detect and execute the workspace test suite (vitest, jest, cargo, pytest).'],
  ['/review', 'Run automated read-only code review on current unstaged modifications.'],
  ['/diff', 'Display colorized git diff of pending code changes before writing.'],
  ['/rollback', 'Revert modifications back to the last known-good git checkpoint.'],
  ['/yolo', 'Toggle autonomous auto-approval mode for all tool calls.'],
  ['/stop', 'Interrupt current in-flight agent turn, tool call, or thinking stream.'],
  ['/exit', 'Safely shut down Mochi session and persist state to SQLite.'],
];

const TOOLS = {
  'File Editing': [
    ['edit', 'Anchor-matched, whitespace-tolerant multi-file editing with atomic rollbacks.'],
    ['patch', 'Standard multi-file *** Begin Patch unified diff applicator.'],
    ['write', 'Atomic file creation or full overwrite with directory auto-scaffolding.'],
    ['delete', 'Safe removal of files and directories within approved workspace boundaries.'],
    ['replace_symbol', 'AST-driven whole-symbol, function, and interface refactoring.'],
  ],
  'Code Intelligence': [
    ['get_function', 'Extract function, class, or method declaration by name via Tree-sitter AST.'],
    ['find_callers', 'Reverse call-graph traversal across all project files and modules.'],
    ['find_references', 'Locate all symbol usages, definitions, and occurrences.'],
    ['read', 'Reads file with skeleton:true mode for AST outlines, reducing tokens by 85%.'],
  ],
  'Execution & Sandbox': [
    ['shell', 'Sandboxed command execution via Bubblewrap (bwrap) with background jobs.'],
    ['search', 'Ripgrep-accelerated sub-millisecond keyword and regex search.'],
    ['glob', 'Asynchronous, hard-bounded file pattern matching avoiding node_modules.'],
  ],
  'Agent State & MCP': [
    ['git', 'Atomic checkpoints, staging, commits, and zero-loss rollback engine.'],
    ['memory', 'Persistent vector and key-value engineering memory across session runs.'],
    ['skill', 'Dynamic SKILL.md runtime loading, discovery, and prompt injection.'],
    ['subagent', 'Spawn any of 16 specialized roles concurrently in isolated scopes.'],
  ],
};

const SIDEBAR = [
  ['Get Started', [
    ['install', 'Installation & Binaries'],
    ['cli', 'CLI & Flags Reference'],
    ['slash-commands', '22 Slash Commands'],
  ]],
  ['Core Architecture', [
    ['roles', '16 Specialist Roles & Swarms'],
    ['tools', '30+ Native Tools'],
    ['sandbox', 'Bubblewrap Sandboxing'],
    ['skills', 'Skills Runtime & MCP'],
    ['daemon', 'HTTP Daemon & ACP Server'],
  ]],
  ['Ecosystem', [
    ['https://github.com/xanstomper/mochi', 'GitHub Repository ↗'],
    ['https://github.com/xanstomper/mochi/releases', 'Release Binaries ↗'],
  ]],
];

export default function Docs() {
  const [toolTab, setToolTab] = useState('File Editing');
  const [searchQuery, setSearchQuery] = useState('');
  const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/mochi') ? '/mochi' : '';

  const filteredCards = DOC_CARDS.filter(c =>
    !searchQuery || c.title.toLowerCase().includes(searchQuery.toLowerCase()) || c.desc.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      <EngineeringGridBackground />
      <div className="pagehead">
        <div className="wrap">
          <div className="pagehead-row">
            <div className="pagehead-col">
              <AnimatedContent direction="bottom" delay={0.1}>
                <div className="hero-eyebrow">
                  <span className="sparkle" />
                  DOCUMENTATION & REFERENCE
                </div>
              </AnimatedContent>

              <h1 className="hero-title">
                Read the <span className="accent-title">Docs.</span>
              </h1>

              <AnimatedContent direction="bottom" delay={0.2}>
                <p className="hero-sub" style={{ maxWidth: 640 }}>
                  Everything you need to master Mochi: zero-dependency binary installation, 16 specialist roles, 30+ native tools, Bubblewrap sandboxing, and autonomous swarm orchestration.
                </p>
              </AnimatedContent>

              {/* Interactive Search bar */}
              <AnimatedContent direction="bottom" delay={0.3}>
                <div className="doc-search-bar">
                  <IconSearch size={18} className="text-muted" />
                  <input
                    type="text"
                    placeholder="Search docs, slash commands, tools, flags..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                  <span className="doc-search-badge">⌘ K</span>
                </div>
              </AnimatedContent>
            </div>

            {/* Custom Docs Mascot: Scholar Mochi with reading glasses and open guidebook */}
            <AnimatedContent direction="right" delay={0.2}>
              <div className="subpage-mascot-wrap">
                <div className="subpage-doodle">easy setup & quickstart!</div>
                <Mochi variant="docs" size={360} />
              </div>
            </AnimatedContent>
          </div>

          {/* 6 Category Launchers */}
          <div className="grid3" style={{ marginTop: 44, marginBottom: 56 }}>
            {filteredCards.map((card, i) => {
              const IconComp = card.icon;
              return (
                <AnimatedContent key={card.title} direction="bottom" delay={i * 0.06}>
                  <a href={card.link} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                    <div className="card-icon-box">
                      <IconComp size={22} />
                    </div>
                    <h3 className="card-title">
                      <span>{card.title}</span>
                      <span className="card-arrow">→</span>
                    </h3>
                    <p className="card-desc">{card.desc}</p>
                  </a>
                </AnimatedContent>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Documentation Two-Column Grid */}
      <div className="doc-wrap">
        <div className="wrap">
          <div className="doc-grid">
            {/* Sticky Sidebar */}
            <aside className="doc-sidebar">
              {SIDEBAR.map(([groupTitle, items]) => (
                <div key={groupTitle} className="doc-sidebar-group">
                  <div className="doc-sidebar-title">{groupTitle}</div>
                  {items.map(([id, label]) => {
                    const isExternal = id.startsWith('http');
                    return (
                      <a
                        key={id}
                        href={isExternal ? id : `#${id}`}
                        target={isExternal ? '_blank' : undefined}
                        rel={isExternal ? 'noopener' : undefined}
                        className="doc-nav-item"
                      >
                        {label}
                      </a>
                    );
                  })}
                </div>
              ))}
            </aside>

            {/* Documentation Content */}
            <main className="doc-content">
              {/* Section 1: Installation */}
              <section id="install" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">INSTALLATION</span>
                    <h2 className="doc-section-title">Installation & Quickstart</h2>
                    <p className="doc-section-desc">
                      Mochi is distributed as a self-contained, single-file binary with zero runtime dependencies.
                    </p>
                  </div>

                  <div className="doc-table-card" style={{ padding: '24px 28px' }}>
                    <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>One-Line Curl Installer (Linux & macOS)</h3>
                    <div className="code-block" style={{ background: '#12111A', borderRadius: 12, padding: '16px 20px', overflowX: 'auto', marginBottom: 16 }}>
                      <code>curl -fsSL https://xanstomper.github.io/mochi/install.sh | bash</code>
                    </div>
                    <p style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                      Installs Mochi into <code>~/.local/bin/mochi</code> and configures shell completion for zsh and bash automatically.
                    </p>
                  </div>
                </AnimatedContent>
              </section>

              {/* Section 2: CLI Flags */}
              <section id="cli" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">CLI REFERENCE</span>
                    <h2 className="doc-section-title">Command Line Interface</h2>
                    <p className="doc-section-desc">
                      Launch Mochi interactively in the terminal or execute headless scripted workflows.
                    </p>
                  </div>

                  <div className="doc-table-card">
                    <table className="doc-table">
                      <thead>
                        <tr>
                          <th style={{ width: '28%' }}>Flag</th>
                          <th style={{ width: '22%' }}>Type</th>
                          <th>Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td><code>-p, --prompt &lt;text&gt;</code></td>
                          <td>string</td>
                          <td>Autonomous single-shot execution prompt without opening interactive TUI.</td>
                        </tr>
                        <tr>
                          <td><code>--auto</code></td>
                          <td>boolean</td>
                          <td>Autonomous auto-approval mode for tool executions within approved boundaries.</td>
                        </tr>
                        <tr>
                          <td><code>--model &lt;id&gt;</code></td>
                          <td>string</td>
                          <td>Override default model (e.g. <code>claude-3-5-sonnet</code>, <code>gpt-4o</code>, <code>zen</code>).</td>
                        </tr>
                        <tr>
                          <td><code>--workspace &lt;path&gt;</code></td>
                          <td>path</td>
                          <td>Set working directory boundary for tool execution and file modifications.</td>
                        </tr>
                        <tr>
                          <td><code>--sandbox</code></td>
                          <td>boolean</td>
                          <td>Enable strict Bubblewrap (bwrap) unprivileged namespace isolation.</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </AnimatedContent>
              </section>

              {/* Section 3: 22 Slash Commands */}
              <section id="slash-commands" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">INTERACTIVE TUI</span>
                    <h2 className="doc-section-title">22 Built-in Slash Commands</h2>
                    <p className="doc-section-desc">
                      Full control over active session state, model routing, git checkpoints, and diagnostic probes.
                    </p>
                  </div>

                  <div className="doc-table-card">
                    <table className="doc-table">
                      <thead>
                        <tr>
                          <th style={{ width: '25%' }}>Command</th>
                          <th>Functionality & Scope</th>
                        </tr>
                      </thead>
                      <tbody>
                        {SLASH_COMMANDS.map(([cmd, desc]) => (
                          <tr key={cmd}>
                            <td><span className="doc-code-pill">{cmd}</span></td>
                            <td style={{ fontSize: 14 }}>{desc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </AnimatedContent>
              </section>

              {/* Section 4: 16 Specialist Roles */}
              <section id="roles" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">MULTI-AGENT SWARMS</span>
                    <h2 className="doc-section-title">16 Specialist Roles</h2>
                    <p className="doc-section-desc">
                      Autonomous DAG swarms dispatched dynamically according to project task requirements.
                    </p>
                  </div>

                  <div className="doc-table-card">
                    <table className="doc-table">
                      <thead>
                        <tr>
                          <th style={{ width: '18%' }}>Role</th>
                          <th style={{ width: '18%' }}>Model Tier</th>
                          <th>Specialization & Capabilities</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ROLES.map(([name, tier, desc]) => (
                          <tr key={name}>
                            <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--purple-dark)' }}>
                              {name}
                            </td>
                            <td>
                              <span style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11.5,
                                padding: '2px 8px',
                                borderRadius: 6,
                                background: tier === 'reasoning' ? 'var(--purple-lighter)' : tier === 'coding' ? '#E0F2FE' : '#F3F4F6',
                                color: tier === 'reasoning' ? 'var(--purple-dark)' : tier === 'coding' ? '#0284C7' : '#4B5563',
                                fontWeight: 600,
                              }}>
                                {tier}
                              </span>
                            </td>
                            <td style={{ fontSize: 14 }}>{desc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </AnimatedContent>
              </section>

              {/* Section 5: 30+ Native Tools */}
              <section id="tools" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">DETERMINISTIC TOOLS</span>
                    <h2 className="doc-section-title">30+ Native Tools</h2>
                    <p className="doc-section-desc">
                      Fast, cache-friendly tool suite bounded by strict workspace isolation.
                    </p>
                  </div>

                  {/* Tool category tabs */}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
                    {Object.keys(TOOLS).map(cat => (
                      <button
                        key={cat}
                        onClick={() => setToolTab(cat)}
                        className={`filter-pill ${toolTab === cat ? 'active' : ''}`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>

                  <div className="doc-table-card">
                    <table className="doc-table">
                      <thead>
                        <tr>
                          <th style={{ width: '25%' }}>Tool</th>
                          <th>Description & Specifications</th>
                        </tr>
                      </thead>
                      <tbody>
                        {TOOLS[toolTab].map(([tool, desc]) => (
                          <tr key={tool}>
                            <td><span className="doc-code-pill">{tool}</span></td>
                            <td style={{ fontSize: 14 }}>{desc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </AnimatedContent>
              </section>

              {/* Section 6: Bubblewrap Sandboxing */}
              <section id="sandbox" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">SECURITY ENFORCEMENT</span>
                    <h2 className="doc-section-title">Bubblewrap Hardware Sandboxing</h2>
                    <p className="doc-section-desc">
                      Unprivileged user namespaces isolate shell and compiler tasks from host credentials.
                    </p>
                  </div>

                  <div className="doc-table-card" style={{ padding: '26px 30px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 20 }}>
                      <div style={{ background: 'var(--purple-lighter)', borderRadius: 14, padding: '18px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 4 }}>&lt; 1.8 ms</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--purple-dark)' }}>STARTUP OVERHEAD</div>
                      </div>
                      <div style={{ background: '#E0F2FE', borderRadius: 14, padding: '18px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: 26, fontWeight: 800, color: '#0284C7', marginBottom: 4 }}>100% MASKED</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#0284C7' }}>~/.ssh & ~/.aws</div>
                      </div>
                      <div style={{ background: '#DCFCE7', borderRadius: 14, padding: '18px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: 26, fontWeight: 800, color: '#16A34A', marginBottom: 4 }}>READ-ONLY</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#16A34A' }}>/usr /bin /lib</div>
                      </div>
                    </div>
                    <p style={{ fontSize: 14.5, color: 'var(--ink-soft)', lineHeight: 1.65 }}>
                      Bubblewrap (bwrap) creates isolated user and mount namespaces without requiring root privileges. If prompt-injection payloads attempt to execute unauthorized network exfiltration or credential harvesting, the sandbox terminates execution immediately.
                    </p>
                  </div>
                </AnimatedContent>
              </section>

              {/* Section 7: Skills & MCP */}
              <section id="skills" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">EXTENSIBILITY</span>
                    <h2 className="doc-section-title">Skills Runtime & Model Context Protocol</h2>
                    <p className="doc-section-desc">
                      Dynamically inject custom instructions, scripts, and MCP stdio/HTTP servers.
                    </p>
                  </div>

                  <div className="doc-table-card" style={{ padding: '24px 28px' }}>
                    <p style={{ fontSize: 14.5, color: 'var(--ink-soft)', lineHeight: 1.65, marginBottom: 14 }}>
                      Mochi automatically indexes all skill definitions inside <code>~/.mochi/skills/</code> and <code>~/.hermes/skills/</code>. Each skill provides a <code>SKILL.md</code> manifest defining triggers, environment requirements, and workflow logic.
                    </p>
                    <div className="code-block" style={{ background: '#12111A', borderRadius: 12, padding: '16px 20px', overflowX: 'auto' }}>
                      <code>mochi --skill geovision-geolocate --prompt "audit and geolocate evidence.jpg"</code>
                    </div>
                  </div>
                </AnimatedContent>
              </section>

              {/* Section 8: Daemon API */}
              <section id="daemon" className="doc-section">
                <AnimatedContent direction="bottom">
                  <div className="doc-section-head">
                    <span className="section-tag">SYSTEM DAEMON</span>
                    <h2 className="doc-section-title">HTTP Daemon & CI/CD Server</h2>
                    <p className="doc-section-desc">
                      Persistent background service on port 8642 for headless automated operations.
                    </p>
                  </div>

                  <div className="doc-table-card" style={{ padding: '24px 28px' }}>
                    <p style={{ fontSize: 14.5, color: 'var(--ink-soft)', lineHeight: 1.65, marginBottom: 14 }}>
                      Run Mochi in background daemon mode for webhooks, GitHub Actions, and external orchestration:
                    </p>
                    <div className="code-block" style={{ background: '#12111A', borderRadius: 12, padding: '16px 20px', overflowX: 'auto', marginBottom: 16 }}>
                      <code>mochi daemon start --port 8642</code>
                    </div>
                    <p style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                      Exposes standard REST endpoints and Agent Client Protocol (ACP) JSON-RPC streams for remote terminal multiplexing.
                    </p>
                  </div>
                </AnimatedContent>
              </section>
            </main>
          </div>
        </div>
      </div>

      <Footer />
    </>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Docs />);
}
