import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('loads defaults (isolated from user config)', () => {
    const cfg = loadConfig({}, '/nonexistent/nowhere.json');
    expect(cfg.model.provider).toBe('opencode-zen');
    expect(cfg.safety.mode).toBe('ask');
    expect(cfg.projectDir).toBe('.mochi');
  });

  it('applies overrides', () => {
    const cfg = loadConfig({ model: { provider: 'openai', model: 'gpt-4o' } });
    expect(cfg.model.provider).toBe('openai');
    expect(cfg.model.model).toBe('gpt-4o');
  });
});
