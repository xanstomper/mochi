import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  getFunctionSynapse,
  findCallers,
  hasSqlite,
  ensureParserLoaded,
  ensureLanguage,
  LANGUAGES,
  loadTreeSitter,
  getParserBackend,
} from './codegraph.js';

// node:sqlite exists only on Node >= 22.5; on older runtimes the codegraph
// degrades to "index unavailable" and these tests cannot assert anything.
const maybeDescribe = hasSqlite() ? describe : describe.skip;

maybeDescribe('codegraph multi-language indexing (tree-sitter default)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(`${tmpdir()}/mochi-cpg-ml-`);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('loads every supported grammar on demand', async () => {
    // Lazy loading (harness-v2 perf): nothing loads at import time; each
    // grammar initializes on first need. Exercise all of them explicitly.
    await ensureParserLoaded();
    for (const lang of LANGUAGES) {
      expect(await ensureLanguage(lang)).toBe(true);
    }
    const st = loadTreeSitter();
    expect(getParserBackend()).toBe('tree-sitter');
    expect(st.ok).toBe(true);
    expect(st.message).toContain('python');
    expect(st.message).toContain('rust');
    expect(st.message).toContain('go');
    expect(st.message).toContain('java');
    expect(st.message).toContain('cpp');
  });

  it('indexes Python symbols', async () => {
    await ensureParserLoaded();
    writeFileSync(resolve(cwd, 'app.py'), [
      'def greet(name):',
      '    return f"hi {name}"',
      '',
      'class Greeter:',
      '    def hello(self):',
      '        return "yo"',
    ].join('\n'));

    expect(await getFunctionSynapse(cwd, 'greet')).toContain('def greet');
    expect(await getFunctionSynapse(cwd, 'Greeter')).toContain('class Greeter');
    expect(await getFunctionSynapse(cwd, 'hello')).toContain('def hello');
  });

  it('indexes Rust symbols (fn/struct)', async () => {
    await ensureParserLoaded();
    mkdirSync(resolve(cwd, 'src'), { recursive: true });
    writeFileSync(resolve(cwd, 'src/lib.rs'), [
      'pub struct Point { x: i32 }',
      'impl Point {',
      '    pub fn dist(&self) -> i32 { self.x }',
      '}',
      'pub fn area(w: i32, h: i32) -> i32 { w * h }',
    ].join('\n'));

    expect(await getFunctionSynapse(cwd, 'Point')).toContain('struct Point');
    expect(await getFunctionSynapse(cwd, 'area')).toContain('fn area');
    expect(await getFunctionSynapse(cwd, 'dist')).toContain('fn dist');
  });

  it('skips polyglot build/cache dirs when indexing (venv, target, vendor, __pycache__)', async () => {
    await ensureParserLoaded();
    // Real source.
    writeFileSync(resolve(cwd, 'app.py'), 'def real_fn():\n    return 1\n');
    // The same-looking symbol inside junk dirs must NOT be indexed.
    mkdirSync(resolve(cwd, '.venv'), { recursive: true });
    writeFileSync(resolve(cwd, '.venv', 'site.py'), 'def real_fn():\n    return 999\n');
    mkdirSync(resolve(cwd, '__pycache__'), { recursive: true });
    writeFileSync(resolve(cwd, '__pycache__', 'app.cpython-312.pyc'), 'def real_fn():\n    return 999\n');
    mkdirSync(resolve(cwd, 'target'), { recursive: true });
    writeFileSync(resolve(cwd, 'target', 'lib.rs'), 'fn real_fn() {}\n');
    mkdirSync(resolve(cwd, 'vendor'), { recursive: true });
    writeFileSync(resolve(cwd, 'vendor', 'main.go'), 'func real_fn() {}\n');

    const hit = await getFunctionSynapse(cwd, 'real_fn');
    expect(hit).toContain('def real_fn');
    // If the walker descended into the junk dirs, the pyc/vendor/target rows
    // could shadow the real one; ensure the real source body wins.
    expect(hit).not.toContain('return 999');
  });

  it('indexes Go symbols (func, type)', async () => {
    await ensureParserLoaded();
    writeFileSync(resolve(cwd, 'main.go'), [
      'package main',
      '',
      'func add(a, b int) int { return a + b }',
      '',
      'type Rectangle struct {',
      '    W, H int',
      '}',
      '',
      'func (r Rectangle) Area() int { return r.W * r.H }',
    ].join('\n') + '\n');

    expect(await getFunctionSynapse(cwd, 'add')).toContain('func add');
    expect(await getFunctionSynapse(cwd, 'Rectangle')).toContain('struct');
    expect(await getFunctionSynapse(cwd, 'Area')).toContain('func');
  });

  it('indexes Java and C++ symbols in one repo', async () => {
    await ensureParserLoaded();
    writeFileSync(resolve(cwd, 'App.java'), 'public class App {\n  public int add(int a, int b) { return a + b; }\n}\n');
    writeFileSync(resolve(cwd, 'math.cpp'), 'struct Vec2 { double x, y; };\nclass Shape {\n  int sides() { return 3; }\n};\n');

    expect(await getFunctionSynapse(cwd, 'App')).toContain('class App');
    expect(await getFunctionSynapse(cwd, 'Shape')).toContain('class Shape');
    expect(await getFunctionSynapse(cwd, 'add')).toContain('int add');
  });

  it('indexes Ruby, PHP, and C# symbols in one repo', async () => {
    await ensureParserLoaded();
    writeFileSync(resolve(cwd, 'app.rb'), 'class Greeter\n  def hello\n    "hi"\n  end\nend\ndef top()\n  1\nend\n');
    writeFileSync(resolve(cwd, 'f.php'), '<?php\nfunction phpfn($x) { return $x * 2; }\nclass PhpCls { function m() {} }\n');
    writeFileSync(resolve(cwd, 'App.cs'), 'class CsCls {\n  int M() { return 1; }\n}\npublic class CsOther { public int N() => 2; }\n');

    expect(await getFunctionSynapse(cwd, 'Greeter')).toContain('class Greeter');
    expect(await getFunctionSynapse(cwd, 'hello')).toContain('def hello');
    expect(await getFunctionSynapse(cwd, 'phpfn')).toContain('function phpfn');
    expect(await getFunctionSynapse(cwd, 'PhpCls')).toContain('class PhpCls');
    expect(await getFunctionSynapse(cwd, 'CsCls')).toContain('class CsCls');
  });

  it('records call edges and resolves cross-file callers from the graph', async () => {
    await ensureParserLoaded();
    writeFileSync(resolve(cwd, 'dep.ts'), 'export function dep() { return 1; }\n');
    writeFileSync(resolve(cwd, 'a.ts'), 'import { dep } from "./dep";\nexport function callerA() { dep(); }\n');
    writeFileSync(resolve(cwd, 'b.ts'), 'import { dep } from "./dep";\nexport function callerB() { dep(); dep(); }\n');

    const callers = await findCallers(cwd, 'dep');
    // Graph edges attribute the call site with its enclosing caller symbol.
    expect(callers).toMatch(/called from callerA/);
    expect(callers).toMatch(/called from callerB/);
    // And the plain file:line fallback is still present.
    expect(callers).toMatch(/a\.ts:\d/);
  });

  it('resolves cross-file callers in python via the graph', async () => {
    await ensureParserLoaded();
    writeFileSync(resolve(cwd, 'lib.py'), 'def util():\n    return 1\n');
    writeFileSync(resolve(cwd, 'main.py'), 'from lib import util\ndef run():\n    util()\n');
    const callers = await findCallers(cwd, 'util');
    expect(callers).toMatch(/called from run/);
    expect(callers).toMatch(/main\.py:\d/);
  });
});

maybeDescribe('codegraph tsc fallback backend', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(`${tmpdir()}/mochi-cg-tsc-`);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('still indexes TS when MOCHI_CPG_BACKEND=tsc is forced', async () => {
    const prev = process.env.MOCHI_CPG_BACKEND;
    process.env.MOCHI_CPG_BACKEND = 'tsc';
    try {
      // Fresh module instance so the env is picked up at init time.
      const mod = await import('./codegraph.js?force-tsc=' + Date.now());
      await mod.ensureParserLoaded();
      expect(mod.getParserBackend()).toBe('tsc');
      writeFileSync(resolve(cwd, 'lib.ts'), 'export function tscFn(x: number): number { return x * 2; }\n');
      expect(await mod.getFunctionSynapse(cwd, 'tscFn')).toContain('function tscFn');
    } finally {
      if (prev === undefined) delete process.env.MOCHI_CPG_BACKEND;
      else process.env.MOCHI_CPG_BACKEND = prev;
    }
  });
});