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
];
