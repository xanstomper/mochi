import { describe, it, expect } from 'vitest';
import { THEMES, getTheme, getAllThemes, applyTheme, getCurrentTheme, themeSwatch } from './themes.js';
import { setTheme, T } from './view.js';

describe('mochi themes', () => {
  it('defines 15 unique themes', () => {
    expect(THEMES.length).toBe(15);
    const ids = new Set(THEMES.map((t) => t.id));
    expect(ids.size).toBe(15);
  });

  it('every theme has all required color tokens and description', () => {
    for (const theme of THEMES) {
      expect(theme.id).toBeTruthy();
      expect(theme.name).toBeTruthy();
      expect(theme.description).toBeTruthy();
      expect(theme.splashStops.length).toBeGreaterThanOrEqual(3);

      const c = theme.colors;
      expect(c.act).toContain('\x1b[');
      expect(c.plan).toContain('\x1b[');
      expect(c.success).toContain('\x1b[');
      expect(c.error).toContain('\x1b[');
      expect(c.warning).toContain('\x1b[');
      expect(c.gray).toContain('\x1b[');
      expect(c.grayDark).toContain('\x1b[');
      expect(c.fg).toContain('\x1b[');
      expect(c.bgUser).toContain('\x1b[');
      expect(c.rule).toContain('\x1b[');
      expect(c.pink).toContain('\x1b[');
      expect(c.magenta).toContain('\x1b[');
      expect(c.violet).toContain('\x1b[');
      expect(c.cyan).toContain('\x1b[');
      expect(c.lime).toContain('\x1b[');
      expect(c.orange).toContain('\x1b[');
      expect(c.teal).toContain('\x1b[');
    }
  });

  it('generates color swatches for each theme', () => {
    for (const theme of THEMES) {
      const sw = themeSwatch(theme);
      expect(sw).toContain('■');
    }
  });

  it('can look up themes by id or name', () => {
    expect(getTheme('cyber-void')?.name).toBe('Cyber Void');
    expect(getTheme('Vaporwave')?.id).toBe('vaporwave');
    expect(getTheme('solar-flare')?.name).toBe('Solar Flare');
    expect(getTheme('deep-sea')?.name).toBe('Deep Sea');
    expect(getTheme('retro-arcade')?.name).toBe('Retro Arcade');
    expect(getTheme('hacker-terminal')?.name).toBe('Hacker Terminal');
    expect(getTheme('midnight-jazz')?.name).toBe('Midnight Jazz');
  });

  it('dynamically switches theme and updates T palette in place', () => {
    const vapor = setTheme('vaporwave');
    expect(vapor.id).toBe('vaporwave');
    expect(T.act).toBe(vapor.colors.act);
    expect(T.bgUser).toBe(vapor.colors.bgUser);

    const solar = setTheme('solar-flare');
    expect(solar.id).toBe('solar-flare');
    expect(T.act).toBe(solar.colors.act);

    // Reset back to cyber-void
    setTheme('cyber-void');
    expect(getCurrentTheme().id).toBe('cyber-void');
  });

  it('persists chosen theme to disk and restores it across sessions', () => {
    applyTheme('retro-arcade');
    expect(process.env.MOCHI_THEME).toBe('retro-arcade');
    expect(getCurrentTheme().id).toBe('retro-arcade');

    // Reset to cyber-void for subsequent test runs
    applyTheme('cyber-void');
    expect(getCurrentTheme().id).toBe('cyber-void');
  });
});
