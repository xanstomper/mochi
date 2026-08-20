// Plugin registry (spec 12-E): mochi plugin add|remove|list.
//
// A plugin is a directory under .mochi/plugins/ (project) or ~/.mochi/plugins/
// (user) containing a `plugin.json` manifest. The manifest declares metadata
// plus automation hooks, each a shell command that runs through the existing
// HookManager pipeline (before_tool/after_tool/before_edit/on_error/...).
// Hooks are merged into hooks.json on every mutation so the agent loop picks
// them up without code changes. TS automation hooks run via the plugin's own
// `node`/`bun` commands; Lua via `lua` when the plugin declares it.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookConfig, HookName } from './hooks.js';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  /** Shell commands (or arrays) keyed by HookName, same shape as hooks.json. */
  hooks?: Partial<Record<HookName, string | string[]>>;
  /** Command that runs when a plugin is loaded, e.g. "node ./activate.js". */
  activation?: string;
}

export interface PluginRecord {
  name: string;
  version: string;
  description: string;
  dir: string;
  scope: 'project' | 'user';
  hooks: HookName[];
}

const HOOK_KEYS: HookName[] = [
  'before_goal', 'after_goal', 'before_task', 'after_task', 'before_agent',
  'after_agent', 'before_tool', 'after_tool', 'before_edit', 'after_edit',
  'before_shell', 'after_shell', 'before_verify', 'after_verify', 'on_error',
  'on_checkpoint', 'on_rollback',
];

export function isHookName(s: string): s is HookName {
  return (HOOK_KEYS as string[]).includes(s);
}

/** Round-trip a plugin directory -> manifest. Throws on malformed manifests. */
export function readManifest(dir: string): PluginManifest {
  const file = resolve(dir, 'plugin.json');
  if (!existsSync(file)) throw new Error(`No plugin.json in ${dir}`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error(`Invalid plugin manifest: ${file} (missing name)`);
  }
  return raw as PluginManifest;
}

function defaultUserPluginsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || resolve('/tmp', 'mochi-home');
  return resolve(home, '.mochi', 'plugins');
}

export class PluginRegistry {
  constructor(
    private projectDir: string,
    private userPluginsDir: string = defaultUserPluginsDir(),
  ) {}

  /** project dir (checked first) wins over the user dir. */
  list(): PluginRecord[] {
    const out: PluginRecord[] = [];
    for (const [dir, scope] of [[this.projectDir, 'project'], [this.ensureUserDir(), 'user']] as const) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const p = resolve(dir, entry);
        if (!statSync(p).isDirectory()) continue;
        try {
          const manifest = readManifest(p);
          out.push({
            name: manifest.name,
            version: manifest.version,
            description: manifest.description ?? '',
            dir: p,
            scope,
            hooks: Object.keys(manifest.hooks ?? {}) as HookName[],
          });
        } catch {
          // skip malformed plugin dirs; don't crash the catalog
        }
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Is a plugin name present (project or user scope)? */
  has(name: string): boolean {
    return this.list().some((p) => p.name === name);
  }

  /** True when the plugin lives in the project scope dir. */
  isProjectScoped(name: string): boolean {
    if (!existsSync(this.projectDir)) return false;
    return existsSync(resolve(this.projectDir, name, 'plugin.json'));
  }

  /**
   * Install a plugin by copying `sourceDir` into the appropriate scope.
   * `name` defaults to the manifest name. Validates the manifest before
   * copying; rejects when the target already exists unless overwrite=true.
   */
  install(sourceDir: string, opts: { scope?: 'project' | 'user'; overwrite?: boolean } = {}): PluginRecord {
    const source = resolve(sourceDir);
    const manifest = readManifest(source);
    const name = manifest.name;
    // Default scope is project for the CLI; user scope is explicit (--user).
    const scope = opts.scope ?? 'project';
    const targetRoot = scope === 'user' ? this.ensureUserDir() : this.projectDir;
    const target = resolve(targetRoot, name);
    if (existsSync(target) && !opts.overwrite) {
      throw new Error(`Plugin "${name}" already installed (${target}). Use --force to overwrite.`);
    }
    mkdirSync(targetRoot, { recursive: true });
    // Removed target first so a stale copy never masks the new one.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    return { name, version: manifest.version, description: manifest.description ?? '', dir: target, scope, hooks: Object.keys(manifest.hooks ?? {}) as HookName[] };
  }

  remove(name: string): boolean {
    let removed = false;
    for (const scope of this.list().filter((p) => p.name === name)) {
      rmSync(scope.dir, { recursive: true, force: true });
      removed = true;
    }
    return removed;
  }

  /** The effective hooks.json content contributed by all installed plugins. */
  mergedHooks(): HookConfig {
    const out: HookConfig = {};
    for (const plugin of this.list()) {
      const manifest = readManifest(plugin.dir);
      if (!manifest.hooks) continue;
      for (const [hook, command] of Object.entries(manifest.hooks)) {
        if (!isHookName(hook)) continue;
        out[hook] = out[hook] ? [...toArray(out[hook]), ...toArray(command)] : toArray(command);
      }
    }
    return out;
  }

  /** Write merged plugin hooks into <workspace>/.mochi/hooks.json (appended). */
  syncToHooksFile(hooksFile: string, existing: HookConfig = {}): void {
    const merged: HookConfig = {};
    for (const [hook, command] of Object.entries(existing)) {
      if (isHookName(hook)) merged[hook] = toArray(command);
    }
    for (const [hook, chunks] of Object.entries(this.mergedHooks())) {
      merged[hook] = [...toArray(merged[hook] ?? []), ...toArray(chunks)];
    }
    mkdirSync(resolve(hooksFile, '..'), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify(merged, null, 2) + '\n');
  }

  get dir() {
    return this.projectDir;
  }

  private ensureUserDir(): string {
    mkdirSync(this.userPluginsDir, { recursive: true });
    return this.userPluginsDir;
  }

}

function toArray(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export const version = '0.1.0';