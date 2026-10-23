#!/usr/bin/env node
// Usage: node dedupe.js <file>
// Prints the file's lines with duplicates removed, PRESERVING the order
// in which each distinct line first appears. A trailing '\r' is ignored
// when comparing lines (CRLF-safe). A final trailing newline does not
// produce an extra empty line.
const { readFileSync } = require('node:fs');
const text = readFileSync(process.argv[2], 'utf8');
const lines = text.split('\n');
if (lines.length && lines[lines.length - 1] === '') lines.pop();
const seen = new Set();
const out = [];
for (const line of [...lines].sort()) {
  const key = line.replace(/\r$/, '');
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(key);
}
console.log(out.join('\n'));
