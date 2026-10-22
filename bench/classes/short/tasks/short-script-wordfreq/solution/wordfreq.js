#!/usr/bin/env node
// Usage: node wordfreq.js <file>
// Prints one "word count" line per distinct word, sorted by count
// descending, then word ascending. Words are case-insensitive sequences
// of letters/digits; anything else is a separator.
const { readFileSync } = require('node:fs');
const text = readFileSync(process.argv[2], 'utf8');
const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
const counts = new Map();
for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
const rows = [...counts.entries()];
rows.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
for (const [w, c] of rows) console.log(`${w} ${c}`);
