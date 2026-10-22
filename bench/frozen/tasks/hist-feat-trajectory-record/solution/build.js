// Trajectory export CLI — structured record edition.
// Usage: node build.js <trace.jsonl> <runId> <out.json>
//
// Built on buildTrajectory (trajectory.js): the export is now a
// TrajectoryRecord — normalized steps, usage rollup, outcome, and failure
// taxonomy — not a raw dump of trace entries.
const { readFileSync, writeFileSync } = require('node:fs');
const { buildTrajectory } = require('./trajectory.js');

const [tracePath, runId, outPath] = process.argv.slice(2);
const entries = readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const record = buildTrajectory(entries, { runId });
writeFileSync(outPath, JSON.stringify(record, null, 2));
