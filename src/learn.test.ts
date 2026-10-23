// `mochi learn` — fixture-repo tests. The fixture is a real (tiny) npm
// repo whose test command works and whose build command is BROKEN: the
// learned skill must assert the test command as VERIFIED, mark the build
// UNVERIFIED with its failure as evidence, leave the repo tree untouched
// (verification runs in a scratch copy), and flip claims correctly on
// re-learn — including a loud REGRESSED demotion when a previously
// verified command breaks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  learnRepo, learnedSkillName, learnedSkillPath, parseLearnClaims,
  type CommandClaim,
} from './learn.js';
import { parseFrontmatter } from './skills/skill-manager.js';
import { runSkillDoctor } from './skills/skill-curator.js';

const BUILD_BROKEN = `import { writeFileSync } from 'node:fs';\nwriteFileSync('built.txt', 'built\\n');\nconsole.log('build step ran');\nprocess.exit(1);\n`;
const BUILD_FIXED = `import { writeFileSync } from 'node:fs';\nwriteFileSync('built.txt', 'built\\n');\nconsole.log('build ok');\n`;
const TEST_OK = `console.log('tests ok');\n`;
const TEST_BROKEN = `console.log('tests failing');\nprocess.exit(1);\n`;

let base: string;
let proj: string;

function makeFixture(): void {
  proj = join(base, 'fixture-app');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    version: '1.0.0',
    scripts: {
      build: 'node build.mjs',
      test: 'node test-check.mjs',
      lint: 'node lint.mjs',
    },
  }, null, 2));
  writeFileSync(join(proj, 'tsconfig.json'), '{ "compilerOptions": { "target": "ES2022" } }\n');
  writeFileSync(join(proj, 'build.mjs'), BUILD_BROKEN);
  writeFileSync(join(proj, 'test-check.mjs'), TEST_OK);
  writeFileSync(join(proj, 'lint.mjs'), `console.log('lint ok');\n`);
  writeFileSync(join(proj, 'src', 'greeter.ts'),
    `export function greet(name: string): string { return 'hello ' + name; }\n`);
  writeFileSync(join(proj, 'src', 'index.ts'),
    `import { greet } from './greeter.js';\nexport function main(): string { return greet('world'); }\n`);
}

/** Hash the repo tree (source only: .mochi state and .git excluded). */
function treeHash(dir: string): string {
  const h = createHash('sha256');
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.mochi' || e.name === '.git' || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) {
        h.update(p.slice(dir.length));
        h.update(readFileSync(p));
      }
    }
  };
  visit(dir);
  return h.digest('hex');
}

function cmdClaim(result: Awaited<ReturnType<typeof learnRepo>>, label: string): CommandClaim {
  const c = result.claims.find((x): x is CommandClaim => x.kind === 'command' && x.label === label);
  expect(c, `claim ${label}`).toBeDefined();
  return c!;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mochi-learn-test-'));
  makeFixture();
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('mochi learn', () => {
  it('verifies the working test command, marks the broken build UNVERIFIED with evidence, and does not mutate the repo', async () => {
    const before = treeHash(proj);
    const r = await learnRepo(proj, { commandTimeoutMs: 60_000 });
    expect(r.ok, r.error).toBe(true);
    expect(r.skillName).toBe('repo-fixture-app-architecture');
    expect(r.skillPath).toBe(learnedSkillPath(proj, r.skillName));
    expect(existsSync(r.skillPath!)).toBe(true);

    const test = cmdClaim(r, 'test');
    expect(test.status).toBe('verified');
    expect(test.exitCode).toBe(0);
    const build = cmdClaim(r, 'build');
    expect(build.status).toBe('unverified');
    expect(build.exitCode).toBe(1);
    expect(build.reason).toContain('exited with code 1');
    expect(build.evidence).toContain('build step ran');
    expect(cmdClaim(r, 'lint').status).toBe('verified');

    // The build DID run (it writes built.txt) — but in the scratch copy.
    expect(existsSync(join(proj, 'built.txt'))).toBe(false);
    expect(treeHash(proj)).toBe(before);

    // Skill body: statuses asserted in prose + machine-readable claims.
    const md = readFileSync(r.skillPath!, 'utf8');
    const pf = parseFrontmatter(md);
    expect(pf?.meta.name).toBe(learnedSkillName('fixture-app'));
    expect(md).toContain('UNVERIFIED');
    const stored = parseLearnClaims(md);
    expect(stored?.version).toBe(1);
    expect(stored?.claims.find((c) => c.label === 'test')?.status).toBe('verified');
    expect(stored?.claims.find((c) => c.label === 'build')?.status).toBe('unverified');

    // Module map came from the codegraph: src module with the fixture symbols.
    const srcModule = r.modules.find((m) => m.dir === 'src');
    expect(srcModule, 'src module in map').toBeDefined();
    expect(srcModule!.keySymbols).toContain('greet');

    // Entrypoint claim: src/index.ts is a conventional entry point.
    const entry = r.claims.find((c) => c.kind === 'entrypoint' && c.label === 'src/index.ts');
    expect(entry?.status).toBe('verified');
  });

  it('re-learn after fixing the build flips it to verified and bumps the version', async () => {
    const first = await learnRepo(proj, { commandTimeoutMs: 60_000 });
    expect(first.ok, first.error).toBe(true);
    expect(cmdClaim(first, 'build').status).toBe('unverified');

    writeFileSync(join(proj, 'build.mjs'), BUILD_FIXED);
    const second = await learnRepo(proj, { commandTimeoutMs: 60_000 });
    expect(second.ok, second.error).toBe(true);
    expect(second.version).toBe(2);
    expect(cmdClaim(second, 'build').status).toBe('verified');
    const change = second.changes.find((c) => c.label === 'build' && c.kind === 'status-changed');
    expect(change).toBeDefined();
    expect(change!.from).toBe('unverified');
    expect(change!.to).toBe('verified');
    expect(change!.regression).toBe(false);
    const md = readFileSync(second.skillPath!, 'utf8');
    expect(md).toContain('Changes since the previous learn');
    expect(parseLearnClaims(md)?.version).toBe(2);
  });

  it('demotes a previously verified command loudly (REGRESSED) when it breaks', async () => {
    const first = await learnRepo(proj, { commandTimeoutMs: 60_000 });
    expect(cmdClaim(first, 'test').status).toBe('verified');

    writeFileSync(join(proj, 'test-check.mjs'), TEST_BROKEN);
    const second = await learnRepo(proj, { commandTimeoutMs: 60_000 });
    expect(second.ok, second.error).toBe(true);
    expect(cmdClaim(second, 'test').status).toBe('unverified');
    const change = second.changes.find((c) => c.label === 'test' && c.kind === 'status-changed');
    expect(change?.regression).toBe(true);
    const md = readFileSync(second.skillPath!, 'utf8');
    expect(md).toContain('REGRESSED');
  });

  it('Skill Doctor replay of the learned skill verification snippet passes', async () => {
    const r = await learnRepo(proj, { commandTimeoutMs: 60_000 });
    expect(r.ok, r.error).toBe(true);
    // The snippet replays only VERIFIED commands (test + lint here; the
    // broken build is excluded by construction).
    const report = runSkillDoctor(proj, {
      autoArchive: false, executeSnippets: true, timeoutMs: 60_000, maxConsecutiveFailures: 99,
    });
    const failure = report.failures.find((f) => f.name === r.skillName);
    expect(failure, JSON.stringify(report.failures)).toBeUndefined();
    expect(report.healthy).toBeGreaterThanOrEqual(1);
  });

  it('with verification disabled, claims are recorded unverified and nothing is executed', async () => {
    const before = treeHash(proj);
    const r = await learnRepo(proj, { verify: false });
    expect(r.ok, r.error).toBe(true);
    expect(cmdClaim(r, 'test').status).toBe('unverified');
    expect(cmdClaim(r, 'test').reason).toContain('not run');
    expect(cmdClaim(r, 'build').exitCode).toBeNull();
    expect(existsSync(join(proj, 'built.txt'))).toBe(false);
    expect(treeHash(proj)).toBe(before);
  });
});
