import { describe, it, expect } from 'vitest';
import { chromeLayout } from './chrome.js';

describe('chromeLayout', () => {
  it('accounts every row exactly once (top + content + bottom = height)', () => {
    for (const h of [12, 18, 24, 34, 50]) {
      for (const w of [60, 100]) {
        const l = chromeLayout({ w, h, inputText: '', busy: false, topRows: 1 });
        expect(l.topRows + l.contentH + l.bottomRows).toBe(h);
      }
    }
  });

  it('reserves the busy line from the transcript, not the chrome', () => {
    const idle = chromeLayout({ w: 100, h: 34, inputText: '', busy: false, topRows: 1 });
    const busy = chromeLayout({ w: 100, h: 34, inputText: '', busy: true, topRows: 1 });
    expect(busy.availableH).toBe(idle.availableH - 1);
    expect(busy.contentH).toBe(idle.contentH);
  });

  it('composer grows with input but never exceeds a third of the height', () => {
    const one = chromeLayout({ w: 100, h: 34, inputText: 'hi', busy: false, topRows: 1 });
    const many = chromeLayout({ w: 100, h: 34, inputText: Array(40).fill('word').join(' '), busy: false, topRows: 1 });
    expect(many.composerRows).toBeGreaterThan(one.composerRows);
    expect(many.composerRows).toBeLessThanOrEqual(Math.floor(34 / 3) + 1);
    // Single-line input reserves exactly: top rule + 1 text + bottom.
    expect(one.composerRows).toBe(3);
  });

  it('never produces non-positive content on tiny terminals', () => {
    const l = chromeLayout({ w: 40, h: 8, inputText: 'x', busy: true, topRows: 1 });
    expect(l.contentH).toBeGreaterThanOrEqual(1);
    expect(l.availableH).toBeGreaterThanOrEqual(1);
    expect(l.chatMw).toBeGreaterThanOrEqual(24);
  });

  it('subagent panel rows carve out of the transcript, not the chrome (W3-4)', () => {
    const plain = chromeLayout({ w: 100, h: 34, inputText: '', busy: false, topRows: 1 });
    const withPanel = chromeLayout({ w: 100, h: 34, inputText: '', busy: false, topRows: 1, panelRows: 3 });
    expect(withPanel.contentH).toBe(plain.contentH - 3);
    expect(withPanel.bottomRows).toBe(plain.bottomRows);
    // Full accounting now includes the panel: top + content + panel + bottom = height.
    expect(withPanel.topRows + withPanel.contentH + 3 + withPanel.bottomRows).toBe(34);
  });

  it('zero panel rows is the identity (default omitted)', () => {
    const a = chromeLayout({ w: 100, h: 34, inputText: '', busy: false, topRows: 1 });
    const b = chromeLayout({ w: 100, h: 34, inputText: '', busy: false, topRows: 1, panelRows: 0 });
    expect(b.contentH).toBe(a.contentH);
  });
});
