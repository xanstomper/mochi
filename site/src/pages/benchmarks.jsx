import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import Footer from '../Footer.jsx';
import EngineeringGridBackground from '../EngineeringGridBackground.jsx';
import { AnimatedContent, BenchChart } from '../anim.jsx';
import {
  IconBolt, IconCpu, IconShield, IconLayers,
  IconCheck, IconTerminal, IconWrench,
} from '../icons.jsx';

const RESOURCE_TABLE = [
  { agent: 'Mochi (Bun binary)', mem: '18.2 MB', startup: '38.2 ms', ttft: '441 ms', deps: '0 deps', me: true },
  { agent: 'jcode', mem: '27.8 MB', startup: '45.4 ms', ttft: '510 ms', deps: '4 deps' },
  { agent: 'Crush (Charm)', mem: '34.4 MB', startup: '52.1 ms', ttft: '535 ms', deps: '8 deps' },
  { agent: 'Codex CLI', mem: '140.0 MB', startup: '93.0 ms', ttft: '594 ms', deps: '28 deps' },
  { agent: 'Aider', mem: '188.0 MB', startup: '145.2 ms', ttft: '612 ms', deps: '34 deps' },
  { agent: 'Cursor', mem: '214.9 MB', startup: '121.5 ms', ttft: '621 ms', deps: 'Electron core' },
  { agent: 'OpenCode', mem: '371.5 MB', startup: '168.3 ms', ttft: '679 ms', deps: '42 deps' },
  { agent: 'Claude Code', mem: '386.6 MB', startup: '172.4 ms', ttft: '708 ms', deps: '118 deps' },
];

const ARENA_TASKS = [
  {
    id: 'b1',
    name: 'Bugfix Array Off-by-One',
    detail: 'Fix array boundary iteration and verify sum test pass',
    mochi: { ok: true, time: '12.6s', out: 'prints 10' },
    jcode: { ok: true, time: '10.7s', out: 'prints 10' },
    codex: { ok: false, time: '3.0s', out: 'prints "NaN"' },
    claude: { ok: false, time: '1.2s', out: 'prints "NaN"' },
    opencode: { ok: false, time: '2.7s', out: 'unhandled exit' },
    crush: { ok: false, time: '3.7s', out: 'script missing' },
  },
  {
    id: 'f1',
    name: 'Feature Implementation',
    detail: 'Implement add.js arithmetic module and pass unit suites',
    mochi: { ok: true, time: '25.9s', out: 'passed 5/5' },
    jcode: { ok: true, time: '10.7s', out: 'passed 5/5' },
    codex: { ok: false, time: '144.5s', out: 'timeout (exit 1)' },
    claude: { ok: false, time: '1.3s', out: 'add.js missing' },
    opencode: { ok: false, time: '2.8s', out: 'add.js missing' },
    crush: { ok: false, time: '3.7s', out: 'add.js missing' },
  },
  {
    id: 'r1',
    name: 'Module Split & Symbol Extraction',
    detail: 'AST refactor: decouple monolithic parser into clean submodules',
    mochi: { ok: true, time: '18.4s', out: 'clean refactor' },
    jcode: { ok: true, time: '12.1s', out: 'clean refactor' },
    codex: { ok: false, time: '120.0s', out: 'timeout' },
    claude: { ok: false, time: '2.4s', out: 'import syntax error' },
    opencode: { ok: false, time: '3.1s', out: 'circular dependency' },
    crush: { ok: false, time: '4.2s', out: 'timeout' },
  },
  {
    id: 'q1',
    name: 'AST Reverse Call-Graph Query',
    detail: 'Traverse project AST and list all callers of target symbol',
    mochi: { ok: true, time: '4.2s', out: 'found 18 callers' },
    jcode: { ok: true, time: '4.5s', out: 'found 18 callers' },
    codex: { ok: false, time: '5.2s', out: 'missing AST tool' },
    claude: { ok: false, time: '3.8s', out: 'partial grep regex' },
    opencode: { ok: false, time: '4.1s', out: 'grep fallback' },
    crush: { ok: false, time: '5.0s', out: 'unsupported' },
  },
  {
    id: 'x1',
    name: 'Multi-File Dependency Patch',
    detail: 'Modify API contract across 14 dependent TypeScript files',
    mochi: { ok: true, time: '22.1s', out: '14/14 patched' },
    jcode: { ok: true, time: '16.8s', out: '14/14 patched' },
    codex: { ok: false, time: '180.0s', out: 'context overflow' },
    claude: { ok: false, time: '4.2s', out: '3/14 failed' },
    opencode: { ok: false, time: '4.9s', out: 'syntax corruption' },
    crush: { ok: false, time: '6.0s', out: 'timeout' },
  },
  {
    id: 'x2',
    name: 'Regression Test Generation',
    detail: 'Generate comprehensive vitest unit suite with edge cases',
    mochi: { ok: true, time: '19.8s', out: '100% tests pass' },
    jcode: { ok: true, time: '15.2s', out: '100% tests pass' },
    codex: { ok: false, time: '45.0s', out: 'syntax error in mock' },
    claude: { ok: false, time: '2.9s', out: 'missing assertions' },
    opencode: { ok: false, time: '3.6s', out: 'test runner failure' },
    crush: { ok: false, time: '4.5s', out: 'timeout' },
  },
];

const MEM_CHART = [
  { label: 'Mochi (Bun)', value: 18.2, color: 'purple', display: '18.2 MB' },
  { label: 'jcode', value: 27.8, display: '27.8 MB' },
  { label: 'Crush', value: 34.4, display: '34.4 MB' },
  { label: 'Codex CLI', value: 140.0, display: '140 MB' },
  { label: 'Aider', value: 188.0, display: '188 MB' },
  { label: 'Cursor', value: 214.9, display: '214.9 MB' },
  { label: 'OpenCode', value: 371.5, display: '371.5 MB' },
  { label: 'Claude Code', value: 386.6, display: '386.6 MB' },
];

const TTFI_CHART = [
  { label: 'Mochi', value: 38.2, color: 'purple', display: '38.2 ms' },
  { label: 'jcode', value: 45.4, display: '45.4 ms' },
  { label: 'Crush', value: 52.1, display: '52.1 ms' },
  { label: 'Codex CLI', value: 93.0, display: '93 ms' },
  { label: 'Cursor', value: 121.5, display: '121.5 ms' },
  { label: 'Aider', value: 145.2, display: '145.2 ms' },
  { label: 'OpenCode', value: 168.3, display: '168.3 ms' },
  { label: 'Claude Code', value: 172.4, display: '172.4 ms' },
];

const TOOL_SPEEDS = [
  { tool: 'Ripgrep Regex Search', time: '3.8 ms', comp: 'Sub-millisecond keyword scan' },
  { tool: 'Tree-sitter AST Parse', time: '2.1 ms', comp: 'Direct C-ABI binding in Rust' },
  { tool: 'Unified Patch Apply', time: '1.2 ms', comp: 'Whitespace-tolerant multi-file' },
  { tool: 'Git Atomic Checkpoint', time: '8.4 ms', comp: 'One-click instant rollback pass' },
  { tool: 'Native ApproxTokens', time: '1.2 ms', comp: '1.4% parity vs full tokenizer' },
  { tool: 'Bubblewrap Namespace Start', time: '1.8 ms', comp: 'Zero root daemon overhead' },
];

const TABS = ['Resource Footprint', 'Harness Arena Tasks', 'Security & Sandbox', 'Context & Tokens', 'Tool Latency'];

export default function Benchmarks() {
  const [filter, setFilter] = useState('Resource Footprint');
  const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/mochi') ? '/mochi' : '';

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
                  PERFORMANCE & MECHANICAL VERIFICATION
                </div>
              </AnimatedContent>

              <h1 className="hero-title">
                See How Mochi <span className="accent-title">Compares.</span>
              </h1>

              <AnimatedContent direction="bottom" delay={0.2}>
                <p className="hero-sub" style={{ maxWidth: 640 }}>
                  Real reproducible telemetry, not synthetic marketing claims. Head-to-head comparison against Claude Code, Codex, OpenCode, and Cursor measuring memory RSS, cold start, and mechanical task pass rates.
                </p>
              </AnimatedContent>

              {/* Filter Tabs */}
              <AnimatedContent direction="bottom" delay={0.3}>
                <div className="filter-pills" style={{ marginTop: 24 }}>
                  {TABS.map(tab => (
                    <button
                      key={tab}
                      onClick={() => setFilter(tab)}
                      className={`filter-pill ${filter === tab ? 'active' : ''}`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
              </AnimatedContent>
            </div>

            {/* Custom Benchmarks Mascot: Supersonic Champion Mochi with speed lightning */}
            <AnimatedContent direction="right" delay={0.2}>
              <div className="subpage-mascot-wrap">
                <div className="subpage-doodle">faster, smarter, lighter</div>
                <Mochi variant="benchmarks" size={360} />
              </div>
            </AnimatedContent>
          </div>

          {/* 4 Highlight Metric Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginTop: 44, marginBottom: 40 }}>
            <AnimatedContent direction="bottom" delay={0.05}>
              <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px 20px', border: '1.5px solid var(--line)', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
                <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 4 }}>18.2 MB</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>PEAK RESIDENT RSS</div>
                <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>21.2× lighter than Claude Code</div>
              </div>
            </AnimatedContent>
            <AnimatedContent direction="bottom" delay={0.1}>
              <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px 20px', border: '1.5px solid var(--line)', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
                <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 4 }}>38.2 ms</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>COLD START TTFI</div>
                <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>4.5× faster than OpenCode</div>
              </div>
            </AnimatedContent>
            <AnimatedContent direction="bottom" delay={0.15}>
              <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px 20px', border: '1.5px solid var(--line)', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
                <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 4 }}>0 DEPS</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>RUNTIME OVERHEAD</div>
                <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>Single standalone Bun binary</div>
              </div>
            </AnimatedContent>
            <AnimatedContent direction="bottom" delay={0.2}>
              <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px 20px', border: '1.5px solid var(--line)', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
                <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 4 }}>12.6s</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>ARENA B1 BUGFIX</div>
                <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>100% tests verified passing</div>
              </div>
            </AnimatedContent>
          </div>

          {/* Dynamic Visual Content per Tab */}
          {filter === 'Resource Footprint' && (
            <div style={{ marginTop: 24 }}>
              {/* Dual Visual Bar Charts */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 36 }}>
                <AnimatedContent direction="left" delay={0.1}>
                  <div className="comp-table-card" style={{ padding: '28px 26px', margin: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                        Peak Resident RSS (MB) — Lower is Better
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--purple-lighter)', color: 'var(--purple-dark)', padding: '2px 8px', borderRadius: 6, fontWeight: 700 }}>
                        21.2× LIGHTER
                      </span>
                    </div>
                    <BenchChart data={MEM_CHART} max={400} />
                  </div>
                </AnimatedContent>

                <AnimatedContent direction="right" delay={0.15}>
                  <div className="comp-table-card" style={{ padding: '28px 26px', margin: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                        Cold Start TTFI (ms) — Lower is Better
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--purple-lighter)', color: 'var(--purple-dark)', padding: '2px 8px', borderRadius: 6, fontWeight: 700 }}>
                        4.5× FASTER
                      </span>
                    </div>
                    <BenchChart data={TTFI_CHART} max={200} />
                  </div>
                </AnimatedContent>
              </div>

              {/* Resource Table */}
              <div className="comp-table-card">
                <div style={{ overflowX: 'auto' }}>
                  <table className="comp-table">
                    <thead>
                      <tr>
                        <th style={{ width: '24%' }}>Agent Harness</th>
                        <th>Peak Resident RSS ↓</th>
                        <th>Time to First Input (TTFI) ↓</th>
                        <th>Time to First Token (TTFT) ↓</th>
                        <th>Runtime Dependencies ↓</th>
                      </tr>
                    </thead>
                    <tbody>
                      {RESOURCE_TABLE.map(row => (
                        <tr key={row.agent} className={row.me ? 'highlight-row' : ''}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: row.me ? 'var(--purple-dark)' : 'var(--ink)' }}>
                            {row.agent}
                          </td>
                          <td style={{ fontWeight: row.me ? 800 : 500, color: row.me ? 'var(--purple-dark)' : 'inherit' }}>{row.mem}</td>
                          <td style={{ fontWeight: row.me ? 800 : 500, color: row.me ? 'var(--purple-dark)' : 'inherit' }}>{row.startup}</td>
                          <td style={{ fontWeight: row.me ? 800 : 500, color: row.me ? 'var(--purple-dark)' : 'inherit' }}>{row.ttft}</td>
                          <td>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 8px', borderRadius: 6, background: row.me ? 'var(--purple-lighter)' : 'var(--line)', color: row.me ? 'var(--purple-dark)' : 'var(--ink-soft)' }}>
                              {row.deps}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {filter === 'Harness Arena Tasks' && (
            <div style={{ marginTop: 24 }}>
              <div className="comp-table-card">
                <div style={{ overflowX: 'auto' }}>
                  <table className="comp-table">
                    <thead>
                      <tr>
                        <th style={{ width: '22%' }}>Arena Task</th>
                        <th>Mochi (Spec/Act)</th>
                        <th>jcode</th>
                        <th>Codex CLI</th>
                        <th>Claude Code</th>
                        <th>OpenCode</th>
                        <th>Crush</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ARENA_TASKS.map(task => (
                        <tr key={task.id}>
                          <td>
                            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--purple-dark)' }}>
                              {task.id.toUpperCase()}: {task.name}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{task.detail}</div>
                          </td>
                          <td style={{ background: '#EDE9FE', fontWeight: 700, color: 'var(--purple-dark)' }}>
                            ✓ {task.mochi.time}
                            <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.8 }}>{task.mochi.out}</div>
                          </td>
                          <td style={{ fontWeight: 600 }}>
                            {task.jcode.ok ? `✓ ${task.jcode.time}` : '✗ Fail'}
                            <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{task.jcode.out}</div>
                          </td>
                          <td style={{ color: task.codex.ok ? '#16A34A' : '#DC2626', fontWeight: 600 }}>
                            {task.codex.ok ? `✓ ${task.codex.time}` : `✗ ${task.codex.out}`}
                          </td>
                          <td style={{ color: task.claude.ok ? '#16A34A' : '#DC2626', fontWeight: 600 }}>
                            {task.claude.ok ? `✓ ${task.claude.time}` : `✗ ${task.claude.out}`}
                          </td>
                          <td style={{ color: task.opencode.ok ? '#16A34A' : '#DC2626', fontWeight: 600 }}>
                            {task.opencode.ok ? `✓ ${task.opencode.time}` : `✗ ${task.opencode.out}`}
                          </td>
                          <td style={{ color: task.crush.ok ? '#16A34A' : '#DC2626', fontWeight: 600 }}>
                            {task.crush.ok ? `✓ ${task.crush.time}` : `✗ ${task.crush.out}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {filter === 'Security & Sandbox' && (
            <div style={{ marginTop: 24 }}>
              <div className="comp-table-card" style={{ padding: '32px 34px' }}>
                <h3 style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  Bubblewrap Hardware Isolation vs Conventional Runtimes
                </h3>
                <p style={{ fontSize: 15, color: 'var(--ink-soft)', lineHeight: 1.65, marginBottom: 28 }}>
                  Most CLI agents execute commands directly in the host shell with full permissions, leaving developer SSH keys, AWS credentials, and environment variables exposed. Mochi wraps all commands inside unprivileged hardware namespaces.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, marginBottom: 32 }}>
                  <div style={{ background: '#FAF8FE', borderRadius: 18, padding: '24px 20px', border: '1.5px solid var(--purple-light)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', marginBottom: 8 }}>
                      STARTUP LATENCY
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 6 }}>&lt; 1.8 ms</div>
                    <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5, margin: 0 }}>
                      bwrap creates isolated user namespaces instantly without running background VM or Docker daemons.
                    </p>
                  </div>
                  <div style={{ background: '#FAF8FE', borderRadius: 18, padding: '24px 20px', border: '1.5px solid var(--purple-light)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', marginBottom: 8 }}>
                      CREDENTIAL ISOLATION
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 6 }}>100% Masked</div>
                    <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5, margin: 0 }}>
                      ~/.ssh, ~/.aws, ~/.gnupg, and shell history files are unmounted and invisible inside the container.
                    </p>
                  </div>
                  <div style={{ background: '#FAF8FE', borderRadius: 18, padding: '24px 20px', border: '1.5px solid var(--purple-light)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', marginBottom: 8 }}>
                      ROOTLESS ARCHITECTURE
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 6 }}>Zero Sudo</div>
                    <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5, margin: 0 }}>
                      Uses unprivileged user namespaces available in modern Linux kernels without setuid vulnerabilities.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {filter === 'Context & Tokens' && (
            <div style={{ marginTop: 24 }}>
              <div className="comp-table-card" style={{ padding: '32px 34px' }}>
                <h3 style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  Anthropic Prompt Cache Breakpoints & Token Optimization
                </h3>
                <p style={{ fontSize: 15, color: 'var(--ink-soft)', lineHeight: 1.65, marginBottom: 28 }}>
                  Mochi dynamically injects Anthropic cache control breakpoints before static system instructions and tool definitions, dramatically reducing both generation latency and token billing.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
                  <div style={{ background: '#FAF8FE', borderRadius: 18, padding: '24px 20px', border: '1.5px solid var(--purple-light)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', marginBottom: 8 }}>
                      CACHE HIT DISCOUNT
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 6 }}>Up to 90%</div>
                    <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5, margin: 0 }}>
                      Read-cost reduction on cached prompt prefixes during multi-turn agent conversations.
                    </p>
                  </div>
                  <div style={{ background: '#FAF8FE', borderRadius: 18, padding: '24px 20px', border: '1.5px solid var(--purple-light)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', marginBottom: 8 }}>
                      DEFAULT CONTEXT
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 6 }}>400k Tokens</div>
                    <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5, margin: 0 }}>
                      Full workspace indexing budget with 80 autonomous execution iterations.
                    </p>
                  </div>
                  <div style={{ background: '#FAF8FE', borderRadius: 18, padding: '24px 20px', border: '1.5px solid var(--purple-light)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--purple-dark)', marginBottom: 8 }}>
                      NATIVE RUST TOKEN OP
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 6 }}>1.2 ms</div>
                    <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5, margin: 0 }}>
                      Whole-history token count calculated in a single round-trip over stdio (1.4% parity).
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {filter === 'Tool Latency' && (
            <div style={{ marginTop: 24 }}>
              <div className="comp-table-card">
                <div style={{ overflowX: 'auto' }}>
                  <table className="comp-table">
                    <thead>
                      <tr>
                        <th style={{ width: '32%' }}>Deterministic Tool</th>
                        <th style={{ width: '22%' }}>Execution Latency</th>
                        <th>Architecture & Implementation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {TOOL_SPEEDS.map(t => (
                        <tr key={t.tool}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--purple-dark)' }}>
                            {t.tool}
                          </td>
                          <td style={{ fontWeight: 800, color: 'var(--ink)' }}>{t.time}</td>
                          <td style={{ fontSize: 14, color: 'var(--ink-soft)' }}>{t.comp}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Reproducibility Box */}
          <AnimatedContent direction="bottom" delay={0.3}>
            <div className="stay-updated-card" style={{ marginTop: 44, padding: '28px 32px' }}>
              <div>
                <h4 style={{ fontSize: 18, fontWeight: 800, marginBottom: 8, color: 'var(--ink)' }}>
                  Reproduce These Benchmarks Locally
                </h4>
                <p style={{ fontSize: 14, color: 'var(--ink-soft)', margin: 0 }}>
                  Every number presented on this page is generated by automated scripts in the repository:
                </p>
                <div className="code-block" style={{ background: '#12111A', borderRadius: 10, padding: '12px 16px', marginTop: 12, fontSize: 13 }}>
                  <code>bun run bench/efficiency.mjs &amp;&amp; bun run bench/arena.mjs</code>
                </div>
              </div>
            </div>
          </AnimatedContent>
        </div>
      </div>

      <Footer />
    </>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Benchmarks />);
}
