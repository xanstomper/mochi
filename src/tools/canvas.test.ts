import { describe, it, expect } from 'vitest';
import {
  parseCanvasSections, normalizeNodes, normalizeEdges, renderCanvasHtml,
  buildExcalidrawScene, escapeHtml, slugify,
} from './canvas.js';

describe('canvas tool', () => {
  it('parses markdown phases and bullets', () => {
    const sections = parseCanvasSections(`# Ship it
## Research
- talk to users
- read the logs
## Build
1. write the tool
2. test it`);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ title: 'Ship it', items: [] });
    expect(sections[1].items).toEqual(['talk to users', 'read the logs']);
    expect(sections[2].items).toEqual(['write the tool', 'test it']);
  });

  it('normalizes loose node/edge input', () => {
    expect(normalizeNodes('[\"a\", {\"id\":\"b\",\"label\":\"B\"}]')).toEqual([
      { id: 'n1', label: 'a' },
      { id: 'b', label: 'B' },
    ]);
    expect(normalizeNodes(['x'])).toEqual([{ id: 'n1', label: 'x' }]);
    expect(normalizeEdges([{ source: 'a', target: 'b', label: 'then' }])).toEqual([{ from: 'a', to: 'b', label: 'then' }]);
    expect(normalizeEdges('not json')).toEqual([]);
  });

  it('renders a self-contained HTML plan with escaped content', () => {
    const html = renderCanvasHtml({
      title: 'Plan <script>', sections: parseCanvasSections('## One\n- do **it**'),
      nodes: [], edges: [], theme: 'dark',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Plan &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>it</strong>');
    expect(html).toContain('One');
    expect(html).toContain('Mochi visual plan');
    expect(html).not.toContain('https://cdn');
  });

  it('renders a node graph with arrows', () => {
    const html = renderCanvasHtml({
      title: 'Graph', sections: [], theme: 'light',
      nodes: normalizeNodes([{ id: 'a', label: 'Start' }, { id: 'b', label: 'Finish' }]),
      edges: normalizeEdges([{ from: 'a', to: 'b', label: 'go' }]),
    });
    expect(html).toContain('<svg');
    expect(html).toContain('marker id="arrow"');
    expect(html).toContain('>go</text>');
    expect(html).toContain('Start');
  });

  it('builds a valid Excalidraw scene', () => {
    const scene = JSON.parse(buildExcalidrawScene({
      title: 'Scene', sections: parseCanvasSections('## A\n- one\n## B\n- two'),
      nodes: [], edges: [], theme: 'dark',
    }));
    expect(scene.type).toBe('excalidraw');
    expect(scene.elements.length).toBeGreaterThanOrEqual(4);
    expect(scene.elements.some((e: { type: string }) => e.type === 'rectangle')).toBe(true);
    expect(scene.elements.some((e: { type: string }) => e.type === 'text')).toBe(true);
    expect(scene.appState.name).toBe('Scene');
  });

  it('escapes and slugs', () => {
    expect(escapeHtml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
    expect(slugify('My Plan: Phase 1!')).toBe('my-plan-phase-1');
    expect(slugify('***')).toBe('plan');
  });
});
