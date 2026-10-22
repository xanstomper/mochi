// Frozen verifier for hist-feat-search-regex-mode.
// Derived from git commit db8ad9b (feat(search): add regex mode to the
// search tool) and its tests in src/tools/search.test.ts (findFunction:
// alternation over call shapes; findRegex: identifier families, lookahead,
// error surfacing).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { searchFiles, validateRegex } = require('./search.js');

const root = join(process.cwd(), 'corpus');
const fails = [];
const has = (matches, text) => Array.isArray(matches) && matches.some((m) => m.includes(text));
const lacks = (matches, text) => Array.isArray(matches) && !matches.some((m) => m.includes(text));

// Literal mode (unchanged contract): a parenthesis in the query is literal.
let m = searchFiles(root, 'foo(bar');
if (!has(m, 'call foo(bar);')) fails.push('literal: exact "foo(bar" line not found');
if (!lacks(m, 'call fooXbar);')) fails.push('literal: query still acts like a pattern (fooXbar matched)');
m = searchFiles(root, 'a.c');
if (!has(m, '"a.c"') || !lacks(m, '"abc"')) fails.push('literal: "." must stay literal (a.c matched abc or missed a.c)');

// Regex mode: alternation over call shapes.
m = searchFiles(root, 'foo\\(|bar\\(', { regex: true });
if (!has(m, 'call foo(alpha);')) fails.push('regex: foo(alpha) not matched');
if (!has(m, 'call bar(beta);')) fails.push('regex: bar(beta) not matched');
if (!lacks(m, 'call baz(gamma);')) fails.push('regex: baz(gamma) wrongly matched');

// Regex mode: identifier family via \w+.
m = searchFiles(root, 'get\\w+', { regex: true });
if (!has(m, 'getUser')) fails.push('regex: get\\w+ did not match getUser');
if (!lacks(m, 'setUser')) fails.push('regex: get\\w+ wrongly matched setUser');

// Regex mode: lookahead works (a supported JS RegExp capability here).
m = searchFiles(root, 'foo(?=bar)', { regex: true });
if (!has(m, '"foobar"')) fails.push('regex: lookahead did not match foobar');
if (!lacks(m, '"foobaz"')) fails.push('regex: lookahead wrongly matched foobaz');

// Errors are returned strings, never thrown.
let err;
try { err = searchFiles(root, '[', { regex: true }); } catch (e) { err = `THREW: ${e.message}`; }
if (typeof err !== 'string' || !err.startsWith('Invalid regex:')) fails.push(`invalid pattern not surfaced as an 'Invalid regex:' string (got ${JSON.stringify(err)})`);
try { err = searchFiles(root, 'x'.repeat(513), { regex: true }); } catch (e) { err = `THREW: ${e.message}`; }
if (typeof err !== 'string' || !err.includes('maximum is 512')) fails.push(`over-long pattern not rejected with the 512 maximum stated (got ${JSON.stringify(err)})`);
if (typeof validateRegex !== 'function' || validateRegex('ok.*') !== null || typeof validateRegex('[') !== 'string') {
  fails.push('validateRegex export missing or misbehaving');
}

if (fails.length === 0) {
  console.log('PASS: regex mode matches patterns (alternation, \\w+, lookahead), literal mode unchanged, pattern errors returned as Invalid regex strings');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
