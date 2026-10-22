// Class fixture verifier for short-fix-palindrome. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { isPalindrome } = require('./palindrome.js');
eq(isPalindrome('A man, a plan, a canal: Panama'), true, 'panama');
eq(isPalindrome("No 'x' in Nixon"), true, 'nixon');
eq(isPalindrome('RaceCar'), true, 'racecar case');
eq(isPalindrome('Was it a car or a cat I saw?'), true, 'car or cat');
eq(isPalindrome('hello'), false, 'hello');
eq(isPalindrome('12321'), true, 'digits palindrome');
eq(isPalindrome('1231'), false, 'digits non-palindrome');
eq(isPalindrome(''), true, 'empty');
console.log('PASS: palindrome contract holds');
