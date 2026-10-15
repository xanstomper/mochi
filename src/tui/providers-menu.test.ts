// providersMenu with scripted UI fns (tools-menu pattern).
import { describe, it, expect } from 'vitest';
import { providersMenu, matchProviders, keyStateText, oauthLoginHint } from './providers-menu.js';
import { providerById } from '../model/providers.js';
import type { LineKind } from './state.js';

type Deps = Parameters<typeof providersMenu>[0];

function deps(over: Partial<Deps> & { activeProvider?: string; storedKey?: string; activeModel?: string } = {}): { d: Deps; lines: Array<{ kind: LineKind; text: string }>; persisted: Array<{ id: string; key: string; model: string }>; sources: string[]; cleared: { n: number }; state: { activeProvider: string; activeModel: string } } {
  const lines: Array<{ kind: LineKind; text: string }> = [];
  const persisted: Array<{ id: string; key: string; model: string }> = [];
  const sources: string[] = [];
  const cleared = { n: 0 };
  const { activeProvider = 'openai', storedKey = undefined, activeModel = '', ...rest } = over;
  const keys: Record<string, string> = storedKey ? { [activeProvider]: storedKey as string } : {};
  const state = { activeProvider, activeModel };
  return {
    d: {
      openMenu: async () => -1,
      push: (kind: LineKind, text: string) => { lines.push({ kind, text }); },
      scheduleRender: () => {},
      setMenuSelected: () => {},
      ask: async () => '',
      askSecret: async () => '',
      openUrl: async (url: string) => `Opened ${url}`,
      readState: () => ({ activeProvider: state.activeProvider, activeModel: state.activeModel }),
      storedKeyFor: (pid: string) => keys[pid],
      envLookup: () => undefined,
      getAmbientKey: async () => undefined,
      verifyKey: async () => ({ ok: true, message: 'verified' }),
      persistLogin: async (id: string, key: string, model: string, source: 'api-key' | 'oauth' = 'api-key') => {
        persisted.push({ id, key, model });
        sources.push(source);
        // Mirror app.ts: a login makes the provider active with the new key.
        state.activeProvider = id;
        keys[id] = key;
        state.activeModel = model;
        return `ok ${id}`;
      },
      switchProvider: async (id: string, model: string) => {
        persisted.push({ id: `${id}:switched`, key: '', model });
        state.activeProvider = id;
        state.activeModel = model;
        return `switched ${id}`;
      },
      persistCleared: async (pid: string) => { cleared.n++; delete keys[pid]; },
      ...rest,
    },
    lines,
    persisted,
    sources,
    cleared,
    state,
  };
}

describe('matchProviders', () => {
  it('sorts all on empty query, filters by substring', () => {
    expect(matchProviders(['qwen', 'ai21', 'openai'], '')).toEqual(['ai21', 'openai', 'qwen']);
    expect(matchProviders(['qwen', 'ai21', 'upstage'], 'ai')).toEqual(['ai21']);
    expect(matchProviders(['qwen'], 'zzz')).toEqual([]);
  });
});

describe('oauthLoginHint (only real local flows are offered)', () => {
  it('names the CLI command for github-models, huggingface, and antigravity, null elsewhere', () => {
    expect(oauthLoginHint(providerById('github-models')!)).toEqual({ label: 'Login with GitHub OAuth', command: 'gh auth login' });
    expect(oauthLoginHint(providerById('huggingface')!)).toEqual({ label: 'Login with Hugging Face', command: 'huggingface-cli login' });
    expect(oauthLoginHint(providerById('antigravity')!)).toEqual({ label: 'Login with Google Antigravity OAuth', command: 'mochi login antigravity' });
    expect(oauthLoginHint(providerById('openai')!)).toBeNull();
    expect(oauthLoginHint(providerById('upstage')!)).toBeNull();
  });
});

describe('keyStateText (never prints key material)', () => {
  it('reports env/file/missing without leaking values', () => {
    const p = providerById('openai')!;
    expect(keyStateText(p, 'openai', () => 'sk-real-secret', undefined)).toBe('key: env');
    const text = keyStateText(p, 'openai', () => undefined, 'sk-real-secret');
    expect(text).toBe('key: file');
    expect(text).not.toContain('sk-real-secret');
    expect(keyStateText(p, 'openai', () => undefined, undefined)).toBe('key: missing');
    expect(keyStateText(providerById('ollama')!, 'openai', () => undefined, undefined)).toBe('keyless local');
  });
});

describe('providersMenu', () => {
  it('exact id shows details then Done leaves without side effects', async () => {
    const calls: string[] = [];
    const { d, lines, persisted, cleared } = deps({
      openMenu: async (t: string) => { calls.push(t); return t.includes('key actions') ? 3 : -1; },
    });
    await providersMenu(d, '/providers upstage');
    expect(lines.some((l) => l.text.includes('Upstage (Solar)'))).toBe(true);
    expect(lines.some((l) => l.text.includes('solar-pro4'))).toBe(true);
    expect(lines.some((l) => l.text.includes('(default)'))).toBe(true);
    expect(lines.some((l) => l.text.includes('console.upstage.ai'))).toBe(true);
    expect(persisted).toEqual([]);
    expect(cleared.n).toBe(0);
  });

  it('shows the gh OAuth path for github-models', async () => {
    const { d, lines } = deps({ openMenu: async (t: string) => (t.includes('key actions') ? 4 : -1) });
    await providersMenu(d, '/providers github-models');
    expect(lines.some((l) => l.text.includes('gh auth login'))).toBe(true);
  });

  it('OAuth action lists the visible login item only where a real flow exists', async () => {
    const seen: string[][] = [];
    const gh = deps({ openMenu: async (_t: string, items: string[]) => { seen.push(items); return 4; } });
    await providersMenu(gh.d, '/providers github-models');
    expect(seen[0]).toHaveLength(5);
    expect(seen[0][1]).toContain('Login with GitHub OAuth');
    expect(seen[0][2]).toContain('Open key page');
    const plain = deps({ openMenu: async (_t: string, items: string[]) => { seen.push(items); return 3; } });
    await providersMenu(plain.d, '/providers upstage');
    expect(seen[1]).toHaveLength(4);
    expect(seen[1].some((i) => i.includes('OAuth'))).toBe(false);
  });

  it('OAuth action persists the CLI token after probing it', async () => {
    let n = 0;
    const { d, lines, persisted, sources } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 1 : 4) : 0),
      getAmbientKey: async () => 'ghp-oauth-token',
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers github-models');
    expect(persisted).toEqual([{ id: 'github-models', key: 'ghp-oauth-token', model: 'openai/gpt-4.1' }]);
    expect(sources).toEqual(['oauth']);
    expect(lines.some((l) => l.text.includes('OAuth token from local CLI auth'))).toBe(true);
    expect(lines.join('\n')).not.toContain('ghp-oauth-token');
  });

  it('OAuth action without CLI auth names the exact command, stores nothing', async () => {
    let n = 0;
    const { d, lines, persisted } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 1 : 4) : 0),
      getAmbientKey: async () => undefined,
    });
    await providersMenu(d, '/providers github-models');
    expect(persisted).toEqual([]);
    const err = lines.find((l) => l.kind === 'error');
    expect(err?.text).toContain('gh auth login');
  });

  it('OAuth wizard shows setup steps first and Back stores nothing', async () => {
    const menus: string[] = [];
    let n = 0;
    const { d, lines, persisted } = deps({
      openMenu: async (t: string) => { menus.push(t); return t.includes('key actions') ? (n++ === 0 ? 1 : 4) : 1; },
      getAmbientKey: async () => 'ghp-oauth-token',
    });
    await providersMenu(d, '/providers github-models');
    expect(menus).toContain('Login with GitHub OAuth');
    expect(lines.some((l) => l.text.includes('gh auth login'))).toBe(true);
    expect(persisted).toEqual([]);
  });

  it('nomatch errors honestly', async () => {
    const { d, lines } = deps();
    await providersMenu(d, '/providers zzz-nope');
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('error');
  });

  it('full menu selects a provider and shows details with ACTIVE badge', async () => {
    const seen: string[][] = [];
    const { d, lines } = deps({
      openMenu: async (_t: string, items: string[]) => { seen.push(items); return seen.length === 1 ? 0 : 2; },
    });
    await providersMenu(d, '/providers');
    expect(seen).toHaveLength(2);
    expect(seen[0].length).toBeGreaterThanOrEqual(36);
    expect(lines.some((l) => l.text.includes('Base URL:'))).toBe(true);
    expect(lines.some((l) => l.text.includes('Models ('))).toBe(true);
  });

  it('Esc closes the menu with no output', async () => {
    const { d, lines } = deps({ openMenu: async () => -1 });
    await providersMenu(d, '/providers');
    expect(lines).toHaveLength(0);
  });

  it('re-authenticate probes before storing and persists the chosen model', async () => {
    const menus: string[] = [];
    let n = 0;
    const { d, lines, persisted } = deps({
      openMenu: async (t: string) => { menus.push(t); return t.includes('key actions') ? (n++ === 0 ? 0 : 3) : 0; },
      askSecret: async () => 'sk-typed-key',
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers upstage');
    expect(persisted).toEqual([{ id: 'upstage', key: 'sk-typed-key', model: 'solar-pro4' }]);
    expect(lines.some((l) => l.text.includes('Verified key'))).toBe(true);
    expect(lines.join('\n')).not.toContain('sk-typed-key');
  });

  it('re-authenticate with a rejected key stores nothing', async () => {
    let n = 0;
    const { d, lines, persisted } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 3) : 0),
      askSecret: async () => 'sk-bad-key',
      verifyKey: async () => ({ ok: false, reason: 'auth', message: 'endpoint rejected the key (HTTP 401)' }),
    });
    await providersMenu(d, '/providers upstage');
    expect(persisted).toEqual([]);
    expect(lines.some((l) => l.kind === 'error' && l.text.includes('Not stored'))).toBe(true);
    expect(lines.join('\n')).not.toContain('sk-bad-key');
  });

  it('clear stored key persists the clear and guides back to re-auth', async () => {
    let n = 0;
    const { d, lines, cleared } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 2 : 3) : 0),
      activeProvider: 'openai',
      storedKey: 'sk-stored',
    });
    await providersMenu(d, '/providers openai');
    expect(cleared.n).toBe(1);
    expect(lines.some((l) => l.text.includes('Cleared stored key'))).toBe(true);
    expect(lines.join('\n')).not.toContain('sk-stored');
    // Panel re-renders live: the new card reads key: missing.
    expect(lines.filter((l) => l.text.includes('Key: key: missing')).length).toBeGreaterThanOrEqual(1);
  });

  it('clear with no stored key reports honestly and touches nothing', async () => {
    let n = 0;
    const { d, lines, cleared } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 2 : 3) : 0),
    });
    await providersMenu(d, '/providers openai');
    expect(cleared.n).toBe(0);
    expect(lines.some((l) => l.text.includes('No stored key'))).toBe(true);
  });

  it('typing a new key replaces the stored one (the reported bug)', async () => {
    let n = 0;
    const { d, lines, persisted } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 3) : 0),
      askSecret: async () => 'sk-brand-new-key',
      activeProvider: 'openai',
      storedKey: 'sk-stale-key',
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers openai');
    expect(persisted).toEqual([{ id: 'openai', key: 'sk-brand-new-key', model: 'gpt-5.4' }]);
    // Panel re-renders from live state: the new card reads key: file.
    expect(lines.filter((l) => l.text.includes('Key: key: file')).length).toBeGreaterThanOrEqual(1);
  });

  it('Enter with a stored key keeps it (no retype needed)', async () => {
    let n = 0;
    const { d, persisted } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 3) : 0),
      askSecret: async () => '',
      activeProvider: 'openai',
      storedKey: 'sk-kept-key',
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers openai');
    expect(persisted).toEqual([{ id: 'openai', key: 'sk-kept-key', model: 'gpt-5.4' }]);
  });

  it('re-auth keeps the current model instead of forcing a picker', async () => {
    let n = 0;
    const { d, persisted } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 3) : 0),
      askSecret: async () => 'sk-new-key',
      activeProvider: 'openai',
      activeModel: 'gpt-4o',
      storedKey: 'sk-old-key',
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers openai');
    expect(persisted).toEqual([{ id: 'openai', key: 'sk-new-key', model: 'gpt-4o' }]);
  });

  it('shows a probing line so the live check never looks dead', async () => {
    let n = 0;
    const { d, lines } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 3) : 0),
      askSecret: async () => 'sk-typed-key',
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers upstage');
    expect(lines.some((l) => l.text.includes('Probing key with Upstage'))).toBe(true);
  });

  it('OAuth token fills in when nothing is configured (github-models via gh)', async () => {
    let n = 0;
    const { d, lines, persisted } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 4) : 0),
      askSecret: async () => '',
      getAmbientKey: async (id: string) => (id === 'github-models' ? 'ghp-oauth-token' : undefined),
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers github-models');
    expect(persisted).toEqual([{ id: 'github-models', key: 'ghp-oauth-token', model: 'openai/gpt-4.1' }]);
    expect(lines.some((l) => l.text.includes('OAuth token from local CLI auth'))).toBe(true);
    expect(lines.join('\n')).not.toContain('ghp-oauth-token');
  });

  it('key entry uses the masked dialog, never the chat composer', async () => {
    let secret = 0;
    let plain = 0;
    let n = 0;
    const { d } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 3) : 0),
      ask: async () => { plain++; return 'x'; },
      askSecret: async () => { secret++; return 'sk-typed-key'; },
      verifyKey: async () => ({ ok: true, message: 'verified' }),
    });
    await providersMenu(d, '/providers upstage');
    expect(secret).toBe(1);
    expect(plain).toBe(0);
  });

  it('open-key-page action offers the verified console link', async () => {
    let opened: string[] = [];
    let n = 0;
    const { d, lines } = deps({
      // upstage actions: re-auth(0), open page(1), clear(2), Done(3)
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 1 : 3) : 0),
      openUrl: async (url: string) => { opened.push(url); return `Opened ${url}`; },
    });
    await providersMenu(d, '/providers upstage');
    expect(opened).toEqual(['https://console.upstage.ai/']);
    expect(lines.some((l) => l.text.includes('https://console.upstage.ai/'))).toBe(true);
  });

  it('details card prints the console link for link-backed providers', async () => {
    const { d, lines } = deps({ openMenu: async (t: string) => (t.includes('key actions') ? 3 : -1) });
    await providersMenu(d, '/providers openai');
    expect(lines.some((l) => l.text.includes('https://platform.openai.com/api-keys'))).toBe(true);
  });

  it('keyless local providers switch with no key prompt', async () => {
    let asked = 0;
    let n = 0;
    const { d, lines, persisted } = deps({
      openMenu: async (t: string) => (t.includes('key actions') ? (n++ === 0 ? 0 : 2) : 0),
      askSecret: async () => { asked++; return ''; },
    });
    await providersMenu(d, '/providers ollama');
    expect(asked).toBe(0);
    expect(persisted[0].id).toBe('ollama:switched');
    expect(persisted[0].model).toBe('llama3.1');
    expect(lines.some((l) => l.text.includes('needs no API key'))).toBe(true);
  });
});
