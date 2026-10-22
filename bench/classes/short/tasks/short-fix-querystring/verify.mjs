// Class fixture verifier for short-fix-querystring. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { parseQuery } = require('./qs.js');
eq(parseQuery('a=1&a=2'), { a: ['1', '2'] }, 'repeated key collects');
eq(parseQuery('a=1&b=2&a=3'), { a: ['1', '3'], b: '2' }, 'interleaved repeats');
eq(parseQuery('q=hello+world'), { q: 'hello world' }, 'plus decodes to space');
eq(parseQuery('flag'), { flag: '' }, 'bare key maps to empty string');
eq(parseQuery('x=%26%3D'), { x: '&=' }, 'percent decoding');
eq(parseQuery(''), {}, 'empty query');
eq(parseQuery('a=1'), { a: '1' }, 'single value stays scalar');
console.log('PASS: query string contract holds');
