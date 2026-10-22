// Frozen verifier for hist-refactor-shared-block-scalar.
// Derived from git commit c3de878 (refactor(skills): one shared
// block-scalar parser for both frontmatter readers) and its test cases in
// src/skills/skill-manager.test.ts: a folded `>-` description comes out
// joined ("do a thing and another", from src/skills/skill-manager.test.ts),
// a literal `|` keeps newlines. Battery documents stay inside the scalar +
// block-scalar subset where the two parsers' semantics coincide by design,
// and require BOTH parsers to produce them (pre-change the manager returns
// the bare indicator string and leaks continuation lines as keys).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseSkillFrontmatter, parseManagerFrontmatter } = require('./frontmatter.js');

const fails = [];
const eq = (got, want, label) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

// The commit's own regression case, verbatim shape: folded block scalar.
const folded = '---\nname: x\ndescription: >-\n  do a thing\n  and another\nversion: 2\n---\nbody\n';
const foldedWant = { name: 'x', description: 'do a thing and another', version: '2' };
// Literal block scalar keeps its newlines.
const literal = '---\nname: x\ndescription: |\n  line a\n  line b\nversion: 2\n---\nbody\n';
const literalWant = { name: 'x', description: 'line a\nline b', version: '2' };
// Folded with a blank line: paragraph break survives as a newline.
const foldedPara = '---\ndescription: >\n  para one\n  still one\n\n  para two\nname: y\n---\nbody\n';
const foldedParaWant = { description: 'para one still one\npara two', name: 'y' };
// Indentation indicator `|2` is still a block scalar.
const indentIndicator = '---\nnotes: |2\n  alpha\n  beta\nname: z\n---\nbody\n';
const indentWant = { notes: 'alpha\nbeta', name: 'z' };
// A continuation line containing a colon is CONTENT, not a new key.
const colonContent = '---\ndescription: |\n  note: not a key\n  second line\nname: w\n---\nbody\n';
const colonWant = { description: 'note: not a key\nsecond line', name: 'w' };
// Plain scalars only — both parsers already agree (unchanged contract).
const plain = '---\nname: plain\ndescription: one line only\nversion: 3\n---\nbody\n';
const plainWant = { name: 'plain', description: 'one line only', version: '3' };
// Block scalar as the LAST key, running to the end of the frontmatter.
const blockAtEnd = '---\nname: v\ndescription: >-\n  trailing block\n  two lines\n---\nbody\n';
const blockAtEndWant = { name: 'v', description: 'trailing block two lines' };

const battery = [
  ['folded >-', folded, foldedWant],
  ['literal |', literal, literalWant],
  ['folded paragraph break', foldedPara, foldedParaWant],
  ['|2 indicator', indentIndicator, indentWant],
  ['colon inside block content', colonContent, colonWant],
  ['plain scalars', plain, plainWant],
  ['block at end', blockAtEnd, blockAtEndWant],
];

for (const [label, doc, want] of battery) {
  const loader = parseSkillFrontmatter(doc);
  eq(loader.frontmatter, want, `${label} — loader parser`);
  eq(loader.body, 'body\n', `${label} — loader body`);
  const manager = parseManagerFrontmatter(doc);
  if (manager === null) { fails.push(`${label} — manager parser returned null`); continue; }
  eq(manager.meta, want, `${label} — manager parser`);
  eq(manager.body, 'body\n', `${label} — manager body`);
  eq(manager.meta, loader.frontmatter, `${label} — both parsers AGREE`);
}

// Unchanged absence contracts: manager returns null without a frontmatter
// block; the loader returns the raw text as body with empty frontmatter.
if (parseManagerFrontmatter('no frontmatter here') !== null) {
  fails.push('manager parser must return null when there is no frontmatter block');
}
const bare = parseSkillFrontmatter('no frontmatter here');
eq(bare.frontmatter, {}, 'loader parser: empty frontmatter without a block');
eq(bare.body, 'no frontmatter here', 'loader parser: raw body without a block');

if (fails.length === 0) {
  console.log('PASS: both frontmatter parsers share one block-scalar reading — folded/literal/indicator/colon-content cases agree exactly, absence contracts unchanged');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
