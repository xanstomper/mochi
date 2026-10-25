// W3-1 recall harness ground truth: a FIXED set of natural-language queries
// over THIS repo, each with known target file(s). The set is deliberately
// frozen like a benchmark: changing queries or targets changes the recall
// numbers, so edits here must be called out in the report.
//
// Rules the set follows:
// - Queries are concept-level ("how does X work"), the way a user or agent
//   actually asks — not filename echoes.
// - Targets name files that genuinely own the answer (checked at test time).
export interface RecallQuery {
  id: string;
  query: string;
  targets: string[];
}

export const RECALL_QUERIES: RecallQuery[] = [
  { id: 'q01', query: 'Where does the agent implement the Agent Client Protocol JSON-RPC loop over stdio?', targets: ['src/acp.ts'] },
  { id: 'q02', query: 'Which table lists chat model providers with their base URLs and API key env vars?', targets: ['src/model/providers.ts'] },
  { id: 'q03', query: 'How are provider API keys stored and looked up securely on this machine?', targets: ['src/model/keyring.ts'] },
  { id: 'q04', query: 'How is the user config file discovered, merged with environment overrides, and defaulted?', targets: ['src/config.ts'] },
  { id: 'q05', query: 'Where is the persistent semantic code index built, chunked, and searched?', targets: ['src/repo/semantic-index.ts'] },
  { id: 'q06', query: 'How does the code choose between a real provider embedder and the local hashed fallback?', targets: ['src/repo/embeddings.ts'] },
  { id: 'q07', query: 'How does practice-task generation inject realistic bugs into a user\u2019s passing code?', targets: ['src/curriculum/curriculum.ts'] },
  { id: 'q08', query: 'Where do skills get verified by replaying their embedded check snippets?', targets: ['src/skills/skill-curator.ts'] },
  { id: 'q09', query: 'How are memory search results fused across keyword and vector signals?', targets: ['src/memory/unified-search.ts'] },
  { id: 'q10', query: 'How does the terminal UI draw colored output?', targets: ['src/tui/renderer.ts'] },
  { id: 'q11', query: 'How are streaming chat completion chunks serialized into the wire format?', targets: ['src/stream/sse-encode.ts'] },
  { id: 'q12', query: 'How does the background daemon schedule delayed runs?', targets: ['src/daemon/scheduler.ts'] },
  { id: 'q13', query: 'How are shell commands isolated from the host system?', targets: ['src/security/sandbox.ts'] },
  { id: 'q14', query: 'Where is the publish/subscribe event bus that components subscribe to?', targets: ['src/events.ts'] },
  { id: 'q15', query: 'How is token spend tracked against a cost cap?', targets: ['src/budget.ts'] },
  { id: 'q16', query: 'How does the agent pre-compute likely next steps while waiting on the model?', targets: ['src/agent/speculative.ts'] },
  { id: 'q17', query: 'Which fast path handles small tasks with fewer model round-trips?', targets: ['src/core/fastlane.ts'] },
  { id: 'q18', query: 'Where is the cached plan for a task stored and invalidated?', targets: ['src/core/plan-cache.ts'] },
  { id: 'q19', query: 'How does the startup health check detect and parse test results?', targets: ['src/health/health-scan.ts'] },
  { id: 'q20', query: 'How are lifecycle hooks registered and invoked?', targets: ['src/hooks.ts'] },
  { id: 'q21', query: 'How does the working directory wrapper track file reads and writes?', targets: ['src/workspace.ts'] },
  { id: 'q22', query: 'How are long-running goals resumed across restarts?', targets: ['src/goals/goal.ts'] },
  { id: 'q23', query: 'Where is agent session state persisted and reloaded?', targets: ['src/state/state-store.ts'] },
  { id: 'q24', query: 'How does the client discover and call tools on external MCP servers?', targets: ['src/mcp/index.ts'] },
  // --- P4 growth: 24 -> 60 queries, same construction rules (concept-level
  // natural-language questions over THIS repo, targets that genuinely own
  // the answer, no filename echoes). The 24-query block above stays
  // byte-identical; the freeze now covers all 60. Every-signal misses are
  // diagnosed in ~/campaign/hybrid-report.md, never dropped.
  { id: 'q25', query: 'How do model calls retry transient provider failures with exponential backoff and jitter?', targets: ['src/model/rate-limit.ts'] },
  { id: 'q26', query: 'How is the prompt-cache TTL tracked so the agent avoids cold-cache recomputation cost?', targets: ['src/model/kv-cache.ts'] },
  { id: 'q27', query: 'Where are per-session token usage records persisted to disk?', targets: ['src/model/usage.ts'] },
  { id: 'q28', query: 'How is a streaming response body decoded into server-sent event frames incrementally?', targets: ['src/model/sse.ts'] },
  { id: 'q29', query: 'How do provider circuit-breaker failures become a clean status line instead of raw error dumps?', targets: ['src/model/provider-failure.ts'] },
  { id: 'q30', query: 'How are multiple API keys per provider rotated when one gets throttled or rejected?', targets: ['src/model/credential-pool.ts'] },
  { id: 'q31', query: 'How does the tool detect upstream models that are missing from our provider table?', targets: ['src/model/model-refresh.ts'] },
  { id: 'q32', query: 'How are named immutable snapshots of working code saved and rolled back to?', targets: ['src/state/checkpoint-manager.ts'] },
  { id: 'q33', query: 'Where is the conversation transcript persisted so past sessions can be searched by content?', targets: ['src/state/session-store.ts'] },
  { id: 'q34', query: 'How is a file write made crash-safe so a kill mid-write never corrupts the target?', targets: ['src/core/atomic-fs.ts'] },
  { id: 'q35', query: 'How do alternative implementation patches race in parallel worktrees until verification picks a winner?', targets: ['src/core/branch-racer.ts'] },
  { id: 'q36', query: 'How does the scanner catch debug logging and leftover TODO debris a model added to a diff?', targets: ['src/core/diff-hygiene.ts'] },
  { id: 'q37', query: 'How is the first bad commit found by binary search without disturbing the user checkout?', targets: ['src/core/git-bisect.ts'] },
  { id: 'q38', query: 'Which deterministic classifier decides a task is trivial enough to skip the exploration loop?', targets: ['src/core/one-shot.ts'] },
  { id: 'q39', query: 'How are structural, co-change and read-telemetry signals fused into one predictive prefetch list?', targets: ['src/core/prefetch.ts'] },
  { id: 'q40', query: 'How do independent read-only tool calls execute in parallel while mutating ones stay sequential?', targets: ['src/core/tool-dispatcher.ts'] },
  { id: 'q41', query: 'How are the tests to run selected from the blast radius of the files a change touched?', targets: ['src/core/test-selection.ts'] },
  { id: 'q42', query: 'How are flaky tests detected, registered and kept from poisoning verification signals?', targets: ['src/core/flaky.ts'] },
  { id: 'q43', query: 'How is just a target function, its type dependencies and its callers sliced out of a file to save tokens?', targets: ['src/core/ast-slicer.ts'] },
  { id: 'q44', query: 'How do finished task outcomes drive durable memory consolidation across sessions?', targets: ['src/memory/consolidate.ts'] },
  { id: 'q45', query: 'How is old session state and trace data cleaned up so long-lived agents do not fill the disk?', targets: ['src/memory/retention.ts'] },
  { id: 'q46', query: 'Where does the stable human-editable project context that prefixes every run live?', targets: ['src/memory/project-memory.ts'] },
  { id: 'q47', query: 'How are the hypotheses tested during a failed task recorded durably for post-mortem analysis?', targets: ['src/observability/autopsy.ts'] },
  { id: 'q48', query: 'What does one verified-solved task cost, computed from exported trajectory records?', targets: ['src/observability/cost-per-solve.ts'] },
  { id: 'q49', query: 'How is a raw failure automatically distilled into a minimal validated reproduction?', targets: ['src/observability/repro-synth.ts'] },
  { id: 'q50', query: 'How are winning tool sequences mined from verified trajectories into draft skill macros?', targets: ['src/observability/workflow-induction.ts'] },
  { id: 'q51', query: 'How is a raw session compacted into structured memory without losing requirements and decisions?', targets: ['src/summary/compact.ts'] },
  { id: 'q52', query: 'How is a compaction summary probed so it cannot silently drop load-bearing facts?', targets: ['src/summary/verified-compaction.ts'] },
  { id: 'q53', query: 'How are raw events classified by importance and assembled into a structured summary document?', targets: ['src/summary/engine.ts'] },
  { id: 'q54', query: 'Where are child agent run results stored so a restarted parent can collect them?', targets: ['src/teams/subagent-runtime.ts'] },
  { id: 'q55', query: 'Which table defines the built-in multi-agent roles with their default models and tool access?', targets: ['src/teams/roles.ts'] },
  { id: 'q56', query: 'How are recurring agent jobs scheduled and persisted so they survive daemon restarts?', targets: ['src/daemon/cron.ts'] },
  { id: 'q57', query: 'How does journal-backed automation resume a run killed mid-flight exactly where it stopped?', targets: ['src/daemon/automation.ts'] },
  { id: 'q58', query: 'How does the task scheduler resolve dependencies and react to task completion events?', targets: ['src/goals/scheduler.ts'] },
  { id: 'q59', query: 'How is the autonomous skip-permissions mode implemented with granular tiers and audit logging?', targets: ['src/security/permission.ts'] },
  { id: 'q60', query: 'Where does the agent loop consult the interactive approval gate before a non-idempotent action?', targets: ['src/security/approval.ts'] },
];
