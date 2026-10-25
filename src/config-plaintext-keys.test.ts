// Fixture-config tests for the plaintext-key hygiene warning (P3 gun 3).
//
// Every value below is FAKE fixture material (`sk-fixture-…`) — the warning
// must never carry a value anyway, and the tests assert exactly that: the
// emitted line names FIELD PATHS and the keyring path, never the key text.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  plaintextKeyFieldPaths,
  warnPlaintextKeysOnce,
  resetPlaintextKeyWarning,
} from './config-plaintext-keys.js';
import { loadConfigFile } from './model/providers.js';

const FAKE_KEY = 'sk-fixture-not-a-real-key-000';

describe('plaintextKeyFieldPaths', () => {
  it('finds key-shaped fields and reports their PATHS only', () => {
    const cfg = {
      model: {
        provider: 'openai',
        apiKey: FAKE_KEY,
        failover: [
          { provider: 'opencode-zen', apiKey: 'sk-fixture-failover-111' },
          { provider: 'gemini' },
        ],
        nested: { clientSecret: 'fixture-secret-222' },
      },
    };
    expect(plaintextKeyFieldPaths(cfg)).toEqual([
      'model.apiKey',
      'model.failover[0].apiKey',
      'model.nested.clientSecret',
    ]);
  });

  it('skips mcpServers env (legitimately file-based) and empty values', () => {
    const cfg = {
      model: { apiKey: '' },
      mcpServers: {
        sqlite: { command: 'uvx', env: { API_TOKEN: 'fixture-mcp-env' } },
        lazy: { command: 'python3', env: { SECRET: 'fixture' } },
      },
      customAuth: { authorization: 'fixture-header' },
    };
    expect(plaintextKeyFieldPaths(cfg)).toEqual(['customAuth.authorization']);
  });

  it('returns [] for a config with no key material', () => {
    expect(plaintextKeyFieldPaths({ model: { provider: 'openai' }, telemetry: false })).toEqual([]);
  });
});

describe('warnPlaintextKeysOnce', () => {
  it('warns once per process naming fields + keyring path, never the value', () => {
    resetPlaintextKeyWarning();
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const cfg = { model: { apiKey: FAKE_KEY } };
    warnPlaintextKeysOnce(cfg, '/fixture/config.json', '/fixture/auth.json', write);
    warnPlaintextKeysOnce(cfg, '/fixture/config.json', '/fixture/auth.json', write);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('"model.apiKey"');
    expect(lines[0]).toContain('/fixture/auth.json');
    expect(lines[0]).toContain('mochi auth login');
    // The whole point: no key material in the message — ever.
    expect(lines[0]).not.toContain(FAKE_KEY);
  });

  it('stays silent for a clean config', () => {
    resetPlaintextKeyWarning();
    const lines: string[] = [];
    warnPlaintextKeysOnce({ model: { provider: 'openai' } }, '/fixture/config.json', '/fixture/auth.json', (l) => lines.push(l));
    expect(lines).toEqual([]);
  });
});

describe('fixture config file end-to-end (loadConfigFile)', () => {
  it('warns once naming the field when the fixture config holds a raw key', () => {
    resetPlaintextKeyWarning();
    const dir = mkdtempSync(join(tmpdir(), 'mochi-plaintext-keys-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ model: { provider: 'openai', apiKey: FAKE_KEY } }));
    process.env.MOCHI_CONFIG_PATH = path;
    const captured: string[] = [];
    const originalError = console.error;
    console.error = (line: unknown) => captured.push(String(line));
    try {
      const cfg = loadConfigFile();
      expect(cfg.model?.apiKey).toBe(FAKE_KEY); // fix is warning-only: value untouched
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain('"model.apiKey"');
      expect(captured[0]).toContain(join(dir, 'auth.json'));
      expect(captured.join('\n')).not.toContain(FAKE_KEY);
      // Second load in the same process: still silent (warns once).
      loadConfigFile();
      expect(captured.length).toBe(1);
    } finally {
      console.error = originalError;
      delete process.env.MOCHI_CONFIG_PATH;
      resetPlaintextKeyWarning();
    }
  });
});
