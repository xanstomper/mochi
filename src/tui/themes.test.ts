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
    expect(getTheme('sakura')?.name).toBe('Sakura Bloom');
    expect(getTheme('Cyberpunk 2077')?.id).toBe('cyberpunk');
    expect(getTheme('dracula')?.name).toBe('Dracula');
    expect(getTheme('nord')?.name).toBe('Nordic Frost');
    expect(getTheme('monokai')?.name).toBe('Monokai Pro');
    expect(getTheme('matrix')?.name).toBe('Matrix Phosphor');
    expect(getTheme('matcha')?.name).toBe('Matcha Latte');
  });

  it('dynamically switches theme and updates T palette in place', () => {
    const sakura = setTheme('sakura');
    expect(sakura.id).toBe('sakura');
    expect(T.act).toBe(sakura.colors.act);
    expect(T.bgUser).toBe(sakura.colors.bgUser);

    const cyberpunk = setTheme('cyberpunk');
    expect(cyberpunk.id).toBe('cyberpunk');
    expect(T.act).toBe(cyberpunk.colors.act);

    // Reset back to classic
    setTheme('classic');
    expect(getCurrentTheme().id).toBe('classic');
  });

  it('persists chosen theme to disk and restores it across sessions', () => {
    applyTheme('cyberpunk');
    expect(process.env.MOCHI_THEME).toBe('cyberpunk');
    expect(getCurrentTheme().id).toBe('cyberpunk');

    // Reset to classic for subsequent test runs
    applyTheme('classic');
    expect(getCurrentTheme().id).toBe('classic');
  });
});
