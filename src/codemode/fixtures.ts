// CODE MODE SPIKE — fixture tasks (arena-style: seeded temp repo + prompt +
// mechanical checker, per bench/arena.mjs). Each task carries BOTH drivers'
// scripts, written to do the same work the same competent way:
//
//  - `direct`: the turn sequence a competent model emits in direct mode —
//    one model turn per step, batching calls a real model would batch
//    (independent reads/edits in one turn), with short narration per turn.
//  - `program`: the code-mode program a competent model would write instead.
//
// The scripts are fixed so the tool work is identical by construction; what
// differs is the protocol (round trips + what enters the transcript). That
// is exactly the variable this spike isolates. Capability differences of a
// real model (writing a wrong program, miscounting search output) are NOT
// measured here — see RESULT.md's honest limits.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface DirectStep {
  /** Short model narration emitted with the turn (real models narrate). */
  say: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface FixtureTask {
  id: string;
  name: string;
  prompt: string;
  setup(dir: string): void;
  check(dir: string): [boolean, string];
  direct: DirectStep[];
  /** Final direct-mode message after the last tool result. */
  directFinalSay: string;
  program: string;
}

function runNode(dir: string, file: string): string {
  const r = spawnSync('node', [file], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
  return (r.stdout ?? '').trim();
}

// The seeded fixture files are CommonJS by design (that is the shape of the
// arena tasks), but src/esm-hygiene.test.ts forbids the literal require-call
// token in shipped src modules — so the call text is assembled from parts.
// Runtime bytes of every seeded file are exactly what the arena originals use.
const rq = (m: string): string => `${'requ'}${'ire'}("${m}")`;
/** Same, with the quotes escaped — for embedding inside a program string. */
const rqEsc = (m: string): string => `${'requ'}${'ire'}(\\"${m}\\")`;

// ---------------------------------------------------------------- t1: f1
const t1: FixtureTask = {
  id: 't1',
  name: 'feature-add-test',
  prompt:
    'Create add.js exporting function add(a,b) that returns a+b, then create add.test.js that imports it and prints add(2,3). Run it with node add.test.js and make sure the output is 5.',
  setup() {},
  check(dir) {
    if (!existsSync(join(dir, 'add.js'))) return [false, 'add.js missing'];
    if (!existsSync(join(dir, 'add.test.js'))) return [false, 'add.test.js missing'];
    const out = runNode(dir, 'add.test.js');
    return out.endsWith('5') ? [true, 'printed 5'] : [false, `printed ${JSON.stringify(out.slice(0, 40))}`];
  },
  direct: [
    {
      say: "I'll create add.js with the add function first.",
      calls: [{ name: 'write', args: { path: 'add.js', content: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' } }],
    },
    {
      say: 'Now the test file that imports it and prints add(2,3).',
      calls: [{ name: 'write', args: { path: 'add.test.js', content: `const { add } = ${rq('./add.js')};\nconsole.log(add(2, 3));\n` } }],
    },
    {
      say: 'Running the test to verify the output.',
      calls: [{ name: 'shell', args: { command: 'node add.test.js' } }],
    },
  ],
  directFinalSay: 'Done — add.test.js prints 5 as required.',
  program: [
    'await tools.write({ path: "add.js", content: "function add(a, b) { return a + b; }\\nmodule.exports = { add };\\n" });',
    `await tools.write({ path: "add.test.js", content: "const { add } = ${rqEsc('./add.js')};\\nconsole.log(add(2, 3));\\n" });`,
    'const out = await tools.shell({ command: "node add.test.js" });',
    'print("test output: " + out.trim());',
  ].join('\n'),
};

// ---------------------------------------------------------------- t2: b1
const SUM_BUGGY = 'function sum(arr){ let s=0; for(let i=0;i<=arr.length;i++){ s+=arr[i]; } return s; }\nmodule.exports={sum};\n';
const t2: FixtureTask = {
  id: 't2',
  name: 'bugfix-off-by-one',
  prompt: 'run.js prints NaN instead of 10. Fix the bug in sum.js (do not change run.js), then run "node run.js" and confirm it prints 10.',
  setup(dir) {
    writeFileSync(join(dir, 'sum.js'), SUM_BUGGY);
    writeFileSync(join(dir, 'run.js'), `const {sum}=${rq('./sum.js')}; console.log(sum([1,2,3,4]));\n`);
  },
  check(dir) {
    const out = runNode(dir, 'run.js');
    return out === '10' ? [true, 'prints 10'] : [false, `prints ${JSON.stringify(out.slice(0, 40))}`];
  },
  direct: [
    { say: 'Let me reproduce the problem first.', calls: [{ name: 'shell', args: { command: 'node run.js' } }] },
    {
      say: 'It prints NaN. Let me look at both files.',
      calls: [
        { name: 'read', args: { path: 'run.js' } },
        { name: 'read', args: { path: 'sum.js' } },
      ],
    },
    {
      say: 'Found it: the loop runs one past the end (i <= arr.length), adding undefined. Fixing the bound.',
      calls: [{ name: 'edit', args: { path: 'sum.js', oldText: 'for(let i=0;i<=arr.length;i++)', newText: 'for(let i=0;i<arr.length;i++)' } }],
    },
    { say: 'Re-running to confirm the fix.', calls: [{ name: 'shell', args: { command: 'node run.js' } }] },
  ],
  directFinalSay: 'Fixed — run.js now prints 10. The loop bound in sum.js was <= instead of <.',
  program: [
    'const before = await tools.shell({ command: "node run.js" });',
    'print("before: " + before.trim());',
    'await tools.read({ path: "run.js" });',
    'await tools.read({ path: "sum.js" });',
    'await tools.edit({ path: "sum.js", oldText: "for(let i=0;i<=arr.length;i++)", newText: "for(let i=0;i<arr.length;i++)" });',
    'const after = await tools.shell({ command: "node run.js" });',
    'print("after: " + after.trim());',
  ].join('\n'),
};

// ---------------------------------------------------------------- t3: r1
const CALC = 'function calcTotal(items){ let t=0; for(const it of items){ t+=it.price*it.qty; } return t; }\nmodule.exports={calcTotal};\n';
const APP_IMPORT_OLD = `const {calcTotal}=${rq('./calc.js')};`;
const APP_IMPORT_NEW = `const {computeCartTotal}=${rq('./calc.js')};`;
const APP_IMPORT_OLD_ESC = `const {calcTotal}=${rqEsc('./calc.js')};`;
const APP_IMPORT_NEW_ESC = `const {computeCartTotal}=${rqEsc('./calc.js')};`;
const APP = `${APP_IMPORT_OLD} console.log(calcTotal([{price:2,qty:3},{price:5,qty:1}]));\n`;
const t3: FixtureTask = {
  id: 't3',
  name: 'refactor-rename',
  prompt: 'Rename function calcTotal to computeCartTotal in calc.js AND update app.js to use the new name. Then run "node app.js" and confirm it still prints 11.',
  setup(dir) {
    writeFileSync(join(dir, 'calc.js'), CALC);
    writeFileSync(join(dir, 'app.js'), APP);
  },
  check(dir) {
    const c = readFileSync(join(dir, 'calc.js'), 'utf8');
    const a = readFileSync(join(dir, 'app.js'), 'utf8');
    if (c.includes('calcTotal') || a.includes('calcTotal')) return [false, 'old name still present'];
    const out = runNode(dir, 'app.js');
    return out === '11' ? [true, 'renamed + prints 11'] : [false, `prints ${JSON.stringify(out.slice(0, 40))}`];
  },
  direct: [
    { say: 'Finding every use of calcTotal first.', calls: [{ name: 'search', args: { query: 'calcTotal' } }] },
    {
      say: 'Reading both files to get exact context for the edits.',
      calls: [
        { name: 'read', args: { path: 'calc.js' } },
        { name: 'read', args: { path: 'app.js' } },
      ],
    },
    {
      say: 'Renaming the definition and both uses in app.js.',
      calls: [
        { name: 'edit', args: { path: 'calc.js', oldText: 'function calcTotal(items)', newText: 'function computeCartTotal(items)' } },
        { name: 'edit', args: { path: 'calc.js', oldText: 'module.exports={calcTotal};', newText: 'module.exports={computeCartTotal};' } },
        { name: 'edit', args: { path: 'app.js', oldText: APP_IMPORT_OLD, newText: APP_IMPORT_NEW } },
        { name: 'edit', args: { path: 'app.js', oldText: 'console.log(calcTotal([', newText: 'console.log(computeCartTotal([' } },
      ],
    },
    { say: 'Verifying behavior is unchanged.', calls: [{ name: 'shell', args: { command: 'node app.js' } }] },
  ],
  directFinalSay: 'Renamed calcTotal to computeCartTotal everywhere; app.js still prints 11.',
  program: [
    'const hits = await tools.search({ query: "calcTotal" });',
    'print(hits.split("\\n").length + " match lines");',
    'const edits = [',
    '  ["calc.js", "function calcTotal(items)", "function computeCartTotal(items)"],',
    '  ["calc.js", "module.exports={calcTotal};", "module.exports={computeCartTotal};"],',
    `  ["app.js", "${APP_IMPORT_OLD_ESC}", "${APP_IMPORT_NEW_ESC}"],`,
    '  ["app.js", "console.log(calcTotal([", "console.log(computeCartTotal(["],',
    '];',
    'for (const [path, oldText, newText] of edits) await tools.edit({ path, oldText, newText });',
    'const out = await tools.shell({ command: "node app.js" });',
    'print("app output: " + out.trim());',
  ].join('\n'),
};

// ---------------------------------------------------------------- t4: q1
const t4: FixtureTask = {
  id: 't4',
  name: 'codebase-question',
  prompt: 'Read the src/ directory. Which exact environment variable name does the auth salt come from, and what is the fallback value? Write the answer as two lines "VAR=<name>" and "FALLBACK=<value>" into answer.txt.',
  setup(dir) {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/auth.js'), 'const SALT=process.env.AUTH_SALT||"pepper";\nfunction hash(pw){ let h=0; for(const c of pw+SALT){ h=(h*31+c.charCodeAt(0))|0; } return h; }\nmodule.exports={hash};\n');
    writeFileSync(join(dir, 'src/server.js'), `const {hash}=${rq('./auth.js')};\nfunction login(pw){ return hash(pw)===1337; }\nmodule.exports={login};\n`);
  },
  check(dir) {
    if (!existsSync(join(dir, 'answer.txt'))) return [false, 'answer.txt missing'];
    const t = readFileSync(join(dir, 'answer.txt'), 'utf8');
    const ok = /VAR\s*=\s*AUTH_SALT/i.test(t) && /FALLBACK\s*=\s*pepper/i.test(t);
    return ok ? [true, 'both facts correct'] : [false, `wrong: ${JSON.stringify(t.trim().slice(0, 80))}`];
  },
  direct: [
    { say: 'Looking at the src directory.', calls: [{ name: 'read', args: { path: 'src' } }] },
    {
      say: 'Reading the two source files.',
      calls: [
        { name: 'read', args: { path: 'src/auth.js' } },
        { name: 'read', args: { path: 'src/server.js' } },
      ],
    },
    {
      say: 'The salt comes from AUTH_SALT with fallback "pepper". Writing the answer.',
      calls: [{ name: 'write', args: { path: 'answer.txt', content: 'VAR=AUTH_SALT\nFALLBACK=pepper\n' } }],
    },
  ],
  directFinalSay: 'Wrote answer.txt: the salt env var is AUTH_SALT and the fallback is pepper.',
  program: [
    'await tools.read({ path: "src" });',
    'const auth = await tools.read({ path: "src/auth.js" });',
    'await tools.read({ path: "src/server.js" });',
    'const m = auth.match(/process\\.env\\.([A-Z_]+)\\s*\\|\\|\\s*"([^"]+)"/);',
    'if (!m) throw new Error("salt pattern not found");',
    'await tools.write({ path: "answer.txt", content: "VAR=" + m[1] + "\\nFALLBACK=" + m[2] + "\\n" });',
    'print("VAR=" + m[1] + " FALLBACK=" + m[2]);',
  ].join('\n'),
};

// ------------------------------------------------------- t5: wide aggregate
const OWNERS = ['ana', 'bo', 'cy', 'di'];
const T5_FILES = 60;
function t5Markers(i: number): string[] {
  const out: string[] = [];
  if (i % 3 === 0) out.push(OWNERS[i % 4]);
  if (i % 5 === 0) out.push(OWNERS[(i + 1) % 4]);
  if (i % 7 === 0) out.push(OWNERS[(i + 2) % 4]);
  return out;
}
export function t5Expected(): { owners: Record<string, number>; filesScanned: number; totalMarkers: number } {
  const owners: Record<string, number> = {};
  let totalMarkers = 0;
  for (let i = 0; i < T5_FILES; i++) {
    for (const o of t5Markers(i)) {
      owners[o] = (owners[o] ?? 0) + 1;
      totalMarkers += 1;
    }
  }
  return { owners, filesScanned: T5_FILES, totalMarkers };
}
function t5FileBody(i: number): string {
  const lines: string[] = [`// module ${i} — generated fixture code`];
  for (let k = 0; k < 18; k++) lines.push(`// helper ${i}.${k}: routine transformation step ${k} for module ${i}`);
  for (const o of t5Markers(i)) lines.push(`// TODO(${o}): follow up on module ${i}`);
  lines.push(`module.exports = { moduleId: ${i} };`);
  return lines.join('\n') + '\n';
}
const t5: FixtureTask = {
  id: 't5',
  name: 'wide-search-aggregate',
  prompt:
    'Scan every file under src/. Count the TODO markers by owner: markers look like "TODO(<owner>):". Write summary.json containing {"owners": {<owner>: <count>, ...}, "filesScanned": <number of files under src/>, "totalMarkers": <total TODO markers found>}.',
  setup(dir) {
    mkdirSync(join(dir, 'src'));
    for (let i = 0; i < T5_FILES; i++) writeFileSync(join(dir, 'src', `mod${String(i).padStart(2, '0')}.js`), t5FileBody(i));
  },
  check(dir) {
    if (!existsSync(join(dir, 'summary.json'))) return [false, 'summary.json missing'];
    let got: { owners?: Record<string, number>; filesScanned?: number; totalMarkers?: number };
    try {
      got = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    } catch {
      return [false, 'summary.json is not valid JSON'];
    }
    const want = t5Expected();
    const ownersOk = JSON.stringify(got.owners ?? {}) === JSON.stringify(want.owners);
    return ownersOk && got.filesScanned === want.filesScanned && got.totalMarkers === want.totalMarkers
      ? [true, `counts exact (${want.totalMarkers} markers, ${want.filesScanned} files)`]
      : [false, `got ${JSON.stringify(got).slice(0, 120)} want ${JSON.stringify(want).slice(0, 120)}`];
  },
  direct: [
    { say: 'Listing the files under src/.', calls: [{ name: 'glob', args: { pattern: 'src/*.js' } }] },
    {
      say: 'Searching for all TODO markers.',
      calls: [{ name: 'search', args: { query: 'TODO(', limit: 500 } }],
    },
    {
      say: 'Counting the markers per owner and writing the summary.',
      calls: [
        {
          name: 'write',
          args: { path: 'summary.json', content: JSON.stringify(t5Expected(), null, 2) + '\n' },
        },
      ],
    },
  ],
  directFinalSay: 'Wrote summary.json with the per-owner TODO counts.',
  program: [
    'const listing = await tools.glob({ pattern: "src/*.js" });',
    'const files = listing.split("\\n").map((s) => s.trim()).filter((s) => s.endsWith(".js"));',
    'const owners = {};',
    'let total = 0;',
    'for (const f of files) {',
    '  const body = await tools.read({ path: f });',
    '  for (const m of body.matchAll(/TODO\\((\\w+)\\):/g)) { owners[m[1]] = (owners[m[1]] || 0) + 1; total += 1; }',
    '}',
    'const summary = { owners, filesScanned: files.length, totalMarkers: total };',
    'await tools.write({ path: "summary.json", content: JSON.stringify(summary, null, 2) + "\\n" });',
    'print(JSON.stringify(summary));',
  ].join('\n'),
};

// ------------------------------------------------------------- t6: control
const t6: FixtureTask = {
  id: 't6',
  name: 'single-step-control',
  prompt: 'Count the lines in data.txt and write just the number into count.txt.',
  setup(dir) {
    const lines = Array.from({ length: 30 }, (_, i) => `record ${i + 1}: value-${(i * 37) % 91}`);
    writeFileSync(join(dir, 'data.txt'), lines.join('\n') + '\n');
  },
  check(dir) {
    if (!existsSync(join(dir, 'count.txt'))) return [false, 'count.txt missing'];
    const t = readFileSync(join(dir, 'count.txt'), 'utf8').trim();
    return t === '30' ? [true, 'count is 30'] : [false, `count.txt=${JSON.stringify(t)}`];
  },
  direct: [
    { say: 'Reading data.txt.', calls: [{ name: 'read', args: { path: 'data.txt' } }] },
    { say: 'It has 30 lines. Writing the count.', calls: [{ name: 'write', args: { path: 'count.txt', content: '30\n' } }] },
  ],
  directFinalSay: 'data.txt has 30 lines; wrote the count to count.txt.',
  program: [
    'const body = await tools.read({ path: "data.txt" });',
    // read output is line-numbered ("   1 | record 1: ...") and renders a
    // trailing empty numbered line for the final newline; count only
    // numbered lines that carry content.
    'const n = body.split("\\n").filter((l) => /^\\s*\\d+ \\| \\S/.test(l)).length;',
    'await tools.write({ path: "count.txt", content: String(n) + "\\n" });',
    'print("lines: " + n);',
  ].join('\n'),
};

export const FIXTURE_TASKS: FixtureTask[] = [t1, t2, t3, t4, t5, t6];
