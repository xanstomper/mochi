// Plaintext-key hygiene for the user config file (P3 gun 3, config-side only).
//
// The codebase owns a proper keyring (src/model/keyring.ts): one stored key
// per provider in a mode-600 `auth.json` next to the config file. A
// config.json that still carries raw provider key material in plaintext
// undermines that: the file is world-readable per its umask, gets copied into
// dotfile backups, and ships in whatever support bundle includes it.
//
// Fix shape is deliberately CONFIG-SIDE ONLY: when the config file contains
// raw key material, Mochi warns ONCE per process at startup, naming the
// offending FIELD PATHS — never the values — and points at the keyring path.
// Nothing is moved, rewritten, or deleted here; migrating a key is the user's
// explicit action (`mochi auth login <provider>`, then remove the field).
//
// Field-name signal reuses the codebase's own key-shape convention from
// redactObject (src/security/security.ts): api[_]key|token|secret|password|
// authorization. The one exclusion: `mcpServers.<id>.env.*` — arbitrary env
// for MCP servers legitimately lives in config.json (the keyring does not
// serve MCP process env), so flagging it would be pure noise.

const KEY_FIELD_NAME = /api[_]?key|client[_]?secret|token|secret|password|authorization/i;

/** Field paths in a parsed config object that hold raw key material.
 *  Pure: returns paths only — values are never read into the result. */
export function plaintextKeyFieldPaths(cfg: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string, mcpEnv: boolean): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, `${path}[${i}]`, mcpEnv));
      return;
    }
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      const underMcpEnv = mcpEnv || (k === 'env' && path.startsWith('mcpServers'));
      if (typeof val === 'string' && val.length > 0 && !underMcpEnv && KEY_FIELD_NAME.test(k)) {
        out.push(childPath);
      } else if (val !== null && typeof val === 'object') {
        walk(val, childPath, underMcpEnv);
      }
    }
  };
  walk(cfg, '', false);
  return out;
}

let warnedThisProcess = false;

/** Test hook: reset the once-per-process latch. */
export function resetPlaintextKeyWarning(): void {
  warnedThisProcess = false;
}

/** Startup warning: one precise message per process naming the offending
 *  field paths (never values) and documenting the keyring path. `write`
 *  defaults to console.error — stderr, so stdout stays machine-readable. */
export function warnPlaintextKeysOnce(
  cfg: unknown,
  configPath: string,
  keyringPath: string,
  write: (line: string) => void = console.error,
): void {
  if (warnedThisProcess) return;
  const paths = plaintextKeyFieldPaths(cfg);
  if (paths.length === 0) return;
  warnedThisProcess = true;
  const where = paths.length === 1 ? `field "${paths[0]}"` : `${paths.length} fields: ${paths.map((p) => `"${p}"`).join(', ')}`;
  write(
    `[mochi] plaintext key warning: ${configPath} stores raw key material in ${where} ` +
    `(values are never printed). Store provider keys in the keyring instead — ` +
    `run \`mochi auth login <provider>\` (keyring: ${keyringPath}, mode 600), ` +
    `then remove the field from config.json.`,
  );
}
