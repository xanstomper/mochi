// Trajectory export CLI — today's behavior.
// Usage: node build.js <trace.jsonl> <runId> <out.json>
//
// Today's export (pre-feature status quo): the trace JSONL is dumped into
// the output file essentially raw — a { runId, exportedAt, entries } wrapper
// around the unprocessed entries. Nothing downstream (dashboards, SFT data
// prep, failure analysis) can consume that shape directly: there are no
// normalized steps, no usage rollup, no outcome, no failure taxonomy.
const { readFileSync, writeFileSync } = require('node:fs');

const [tracePath, runId, outPath] = process.argv.slice(2);
const entries = readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
writeFileSync(outPath, JSON.stringify({ runId, exportedAt: new Date().toISOString(), entries }, null, 2));
