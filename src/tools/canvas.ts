// Visual canvas plans.
//
// "Plan this visually" should produce something you can actually look at, not
// a wall of markdown. This tool renders a self-contained whiteboard-style HTML
// page (no CDN, no runtime deps), a matching `.excalidraw` scene you can drag
// into excalidraw.com, and — optionally — uploads the scene to a real
// Excalidraw canvas in the browser and screenshots the result.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from './types.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import { runArgv } from '../exec.js';
import { browserCall, initBrowserSession } from '../browser/session.js';
import { browserOptions } from '../browser/options.js';

export interface CanvasSection {
  title: string;
  items: string[];
}

export interface CanvasNode {
  id: string;
  label: string;
  description?: string;
  column?: number;
}

export interface CanvasEdge {
  from: string;
  to: string;
  label?: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Markdown -> columns. `## Heading` starts a section; bullets become items. */
export function parseCanvasSections(markdown: string): CanvasSection[] {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections: CanvasSection[] = [];
  let current: CanvasSection | undefined;
  const ensure = (title: string) => {
    current = { title: title.trim() || 'Plan', items: [] };
    sections.push(current);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) { ensure(h2[1]); continue; }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) { ensure(h1[1]); continue; }
    const bullet = /^[-*+]\s+(.+)$/.exec(line) ?? /^\d+[.)]\s+(.+)$/.exec(line);
    const item = bullet ? bullet[1] : line;
    if (!current) ensure('Plan');
    current!.items.push(item.trim());
  }
  return sections.filter((s) => s.title || s.items.length);
}

export function normalizeNodes(input: unknown): CanvasNode[] {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((n, i) => {
    if (typeof n === 'string') return { id: `n${i + 1}`, label: n };
    const o = (n ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? `n${i + 1}`),
      label: String(o.label ?? o.title ?? `Node ${i + 1}`),
      description: o.description ? String(o.description) : undefined,
      column: typeof o.column === 'number' ? o.column : undefined,
    };
  });
}

export function normalizeEdges(input: unknown): CanvasEdge[] {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return { from: String(o.from ?? o.source ?? ''), to: String(o.to ?? o.target ?? ''), label: o.label ? String(o.label) : undefined };
  }).filter((e) => e.from && e.to);
}

function layoutNodes(nodes: CanvasNode[], edges: CanvasEdge[]): Map<string, { x: number; y: number; w: number; h: number }> {
  const layers = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) if (incoming.has(e.to)) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  const queue = (roots.length ? roots : nodes.slice(0, 1)).map((n) => ({ id: n.id, depth: 0 }));
  while (queue.length) {
    const cur = queue.shift()!;
    const depth = Math.max(layers.get(cur.id) ?? 0, cur.depth);
    layers.set(cur.id, depth);
    if (depth > 8) continue;
    for (const e of edges) {
      if (e.from !== cur.id) continue;
      const target = byId.get(e.to);
      if (!target) continue;
      if ((layers.get(target.id) ?? -1) < depth + 1) queue.push({ id: target.id, depth: depth + 1 });
    }
  }
  for (const n of nodes) {
    if (!layers.has(n.id)) {
      layers.set(n.id, n.column ?? 0);
    } else if (n.column !== undefined) {
      layers.set(n.id, n.column);
    }
  }
  const perLayer = new Map<number, number>();
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of nodes) {
    const col = layers.get(n.id) ?? 0;
    const row = perLayer.get(col) ?? 0;
    perLayer.set(col, row + 1);
    out.set(n.id, { x: 60 + col * 280, y: 70 + row * 130, w: 220, h: 92 });
  }
  return out;
}

function renderGraphSvg(nodes: CanvasNode[], edges: CanvasEdge[]): string {
  if (!nodes.length) return '';
  const pos = layoutNodes(nodes, edges);
  const width = Math.max(900, ...[...pos.values()].map((p) => p.x + p.w + 60));
  const height = Math.max(300, ...[...pos.values()].map((p) => p.y + p.h + 50));
  const lines = edges.map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    const label = e.label ? `<text x="${mx}" y="${(y1 + y2) / 2 - 8}" class="edge-label">${escapeHtml(e.label)}</text>` : '';
    return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" class="edge"/>${label}`;
  }).join('');
  const boxes = nodes.map((n) => {
    const p = pos.get(n.id)!;
    return `<g class="node">
      <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="14"/>
      <text x="${p.x + 16}" y="${p.y + 30}" class="node-title">${escapeHtml(n.label).slice(0, 42)}</text>
      ${n.description ? `<text x="${p.x + 16}" y="${p.y + 54}" class="node-desc">${escapeHtml(n.description).slice(0, 60)}</text>` : ''}
    </g>`;
  }).join('');
  return `<section class="graph"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Plan graph">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>
    ${lines}${boxes}
  </svg></section>`;
}

export interface CanvasRenderInput {
  title: string;
  subtitle?: string;
  sections: CanvasSection[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  theme?: 'dark' | 'light';
  excalidrawName?: string;
}

/** Self-contained, print-friendly visual plan. No external assets. */
export function renderCanvasHtml(input: CanvasRenderInput): string {
  const dark = input.theme !== 'light';
  const c = dark
    ? { bg: '#0a0a0f', panel: 'rgba(20,20,31,.86)', ink: '#f2f0ff', muted: '#9b98b8', line: 'rgba(168,130,255,.22)', accent: '#a882ff', accent2: '#55e6c1' }
    : { bg: '#f7f5ff', panel: 'rgba(255,255,255,.9)', ink: '#17142b', muted: '#5c5878', line: 'rgba(90,60,180,.16)', accent: '#6b3fd4', accent2: '#0f9b78' };
  const arrow = '<div class="flow-arrow" aria-hidden="true">→</div>';
  const columns = input.sections.map((_, i) => i).join(',');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(input.title)}</title>
<style>
  :root{color-scheme:${dark ? 'dark' : 'light'};}
  *{box-sizing:border-box}
  body{margin:0;background:${c.bg};color:${c.ink};font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;
    background-image:radial-gradient(circle at 12% 0%,rgba(168,130,255,.16),transparent 42%),radial-gradient(circle at 88% 8%,rgba(85,230,193,.10),transparent 38%),
    linear-gradient(${c.line} 1px,transparent 1px),linear-gradient(90deg,${c.line} 1px,transparent 1px);
    background-size:auto,auto,32px 32px,32px 32px;}
  .wrap{max-width:1500px;margin:0 auto;padding:44px 32px 64px}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;border-bottom:1px solid ${c.line};padding-bottom:22px;margin-bottom:30px}
  .kicker{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:${c.accent};font-weight:700}
  h1{font-size:clamp(28px,4vw,46px);line-height:1.08;margin:8px 0 0;letter-spacing:-.02em}
  .sub{color:${c.muted};margin-top:8px;max-width:820px}
  .meta{text-align:right;color:${c.muted};font-size:12px;white-space:nowrap}
  .meta strong{display:block;color:${c.ink};font-size:18px}
  .flow{display:flex;align-items:stretch;gap:6px;overflow-x:auto;padding-bottom:10px}
  .flow-arrow{align-self:center;color:${c.accent};font-size:22px;opacity:.65;flex:0 0 auto}
  .card{flex:1 1 250px;min-width:240px;background:${c.panel};border:1px solid ${c.line};border-radius:18px;padding:20px 20px 16px;
    box-shadow:0 18px 50px rgba(0,0,0,${dark ? '.35' : '.08'});backdrop-filter:blur(8px);position:relative;overflow:hidden}
  .card:before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,${c.accent},${c.accent2})}
  .card-num{font-size:11px;font-weight:800;color:${c.accent};letter-spacing:.14em}
  .card h2{font-size:17px;margin:6px 0 12px;letter-spacing:-.01em}
  .card ul{margin:0;padding-left:18px}
  .card li{margin:7px 0;color:${c.ink}}
  .card li::marker{color:${c.accent2}}
  code{background:rgba(168,130,255,.14);padding:1px 5px;border-radius:5px;font-size:.9em}
  .graph{margin-top:34px;background:${c.panel};border:1px solid ${c.line};border-radius:18px;padding:8px}
  .graph svg{width:100%;height:auto;display:block}
  .edge{fill:none;stroke:${c.accent};stroke-width:2;marker-end:url(#arrow);opacity:.75}
  .edge-label{fill:${c.muted};font-size:12px;text-anchor:middle}
  .node rect{fill:${dark ? 'rgba(30,28,48,.92)' : '#fff'};stroke:${c.line};stroke-width:1.5}
  .node-title{fill:${c.ink};font-size:14px;font-weight:650}
  .node-desc{fill:${c.muted};font-size:12px}
  footer{margin-top:36px;padding-top:18px;border-top:1px solid ${c.line};display:flex;justify-content:space-between;color:${c.muted};font-size:12px}
  @media print{body{background:#fff;color:#111}.card,.graph{box-shadow:none;background:#fff;border-color:#ddd}.flow{overflow:visible}}
  @media (max-width:760px){.flow{flex-direction:column}.flow-arrow{transform:rotate(90deg);align-self:flex-start;margin-left:24px}header{flex-direction:column;align-items:flex-start}.meta{text-align:left}}
</style></head>
<body><div class="wrap">
  <header>
    <div>
      <div class="kicker">Mochi visual plan</div>
      <h1>${inline(input.title)}</h1>
      ${input.subtitle ? `<div class="sub">${inline(input.subtitle)}</div>` : ''}
    </div>
    <div class="meta"><strong>${input.sections.length || input.nodes.length}</strong>${input.sections.length ? ' phases' : ' nodes'}<br/>${new Date().toLocaleString()}</div>
  </header>
  ${input.sections.length ? `<section class="flow" data-columns="${columns}">${input.sections.map((s, i) => `
    <article class="card" style="--i:${i}">
      <div class="card-num">${String(i + 1).padStart(2, '0')}</div>
      <h2>${inline(s.title)}</h2>
      <ul>${s.items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>
    </article>${i < input.sections.length - 1 ? arrow : ''}`).join('')}</section>` : ''}
  ${renderGraphSvg(input.nodes, input.edges)}
  <footer><span>Generated by Mochi${input.excalidrawName ? ` · scene: ${escapeHtml(input.excalidrawName)}` : ''}</span><span>Self-contained · print to PDF</span></footer>
</div></body></html>`;
}

export function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';
}

/** Excalidraw scene from sections (cards in a row) or explicit nodes. */
export function buildExcalidrawScene(input: CanvasRenderInput): string {
  const elements: Array<Record<string, unknown>> = [];
  const nodes = input.nodes.length
    ? input.nodes
    : input.sections.map((s, i) => ({ id: `s${i + 1}`, label: s.title, description: s.items.slice(0, 3).join(' · '), column: i }));
  // Sections are a left-to-right pipeline: connect consecutive phases so the
  // Excalidraw scene reads as a flow, not a row of disconnected boxes.
  const edges = input.nodes.length
    ? input.edges
    : input.sections.slice(1).map((_, i) => ({ from: `s${i + 1}`, to: `s${i + 2}` }));
  const positions = layoutNodes(nodes, edges);
  let seed = 1;
  const base = {
    angle: 0, strokeColor: '#a882ff', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
    frameId: null, roundness: { type: 3 }, seed: 0, version: 1, versionNonce: 0,
    isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
  };
  for (const n of nodes) {
    const p = positions.get(n.id)!;
    const id = `r-${n.id}`;
    elements.push({ ...base, id, type: 'rectangle', x: p.x, y: p.y, width: p.w, height: p.h, seed: seed++, versionNonce: seed, backgroundColor: '#1e1c30' });
    elements.push({
      ...base, id: `t-${n.id}`, type: 'text', x: p.x + 14, y: p.y + 18, width: p.w - 28, height: 24,
      text: n.label.slice(0, 60), fontSize: 16, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
      baseline: 20, containerId: null, originalText: n.label.slice(0, 60), autoResize: true, lineHeight: 1.25,
      seed: seed++, versionNonce: seed, strokeColor: '#f2f0ff',
    });
  }
  for (const e of edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    elements.push({
      ...base, id: `a-${e.from}-${e.to}`, type: 'arrow', x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      points: [[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: 'arrow', seed: seed++, versionNonce: seed,
    });
  }
  return JSON.stringify({
    type: 'excalidraw', version: 2, source: 'mochi-canvas',
    elements, appState: { viewBackgroundColor: '#0a0a0f', gridSize: 20, name: input.title }, files: {},
  }, null, 2);
}

async function openPath(path: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') await runArgv('cmd.exe', ['/d', '/s', '/c', 'start', '', path], { timeoutMs: 5000 });
    else if (process.platform === 'darwin') await runArgv('open', [path], { timeoutMs: 5000 });
    else await runArgv('xdg-open', [path], { timeoutMs: 5000 });
    return true;
  } catch { return false; }
}

export const canvasTool: Tool = {
  def: {
    name: 'canvas',
    description:
      'Turn a plan into a VISUAL canvas. Renders a polished, self-contained whiteboard-style HTML page with phase columns and/or a node graph, ' +
      'writes a matching .excalidraw scene, opens it in the user\'s browser (unless open:false), and can publish the scene to excalidraw.com ' +
      'and screenshot it (publish:true). Provide `content` markdown (## phases with bullets) or explicit `nodes`/`edges`. ' +
      'Use for visual plans, architecture diagrams, roadmaps, flowcharts, and "draw/map/show me" requests.',
    parameters: [
      { name: 'title', type: 'string', description: 'Plan title', required: true },
      { name: 'content', type: 'string', description: 'Markdown plan: ## phase headings with - bullets (recommended)', required: false },
      { name: 'nodes', type: 'array', description: 'Optional nodes: [{id,label,description,column}]', required: false },
      { name: 'edges', type: 'array', description: 'Optional edges: [{from,to,label}]', required: false },
      { name: 'subtitle', type: 'string', description: 'Short subtitle', required: false },
      { name: 'theme', type: 'string', description: 'dark (default) | light', required: false },
      { name: 'open', type: 'boolean', description: 'Open the HTML in the user browser (default true)', required: false },
      { name: 'publish', type: 'boolean', description: 'Upload the scene to excalidraw.com and screenshot (default false)', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const title = String(args.title ?? '').trim() || 'Untitled plan';
    const sections = parseCanvasSections(String(args.content ?? ''));
    const nodes = normalizeNodes(args.nodes);
    const edges = normalizeEdges(args.edges);
    if (!sections.length && !nodes.length) {
      return '[canvas] ERROR: provide `content` markdown (## phases with bullets) or `nodes`';
    }
    const stateDir = mochiStateDir(ctx.cwd);
    const outDir = join(stateDir, 'canvas');
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = slugify(title);
    const htmlPath = join(outDir, `${slug}-${stamp}.html`);
    const scenePath = join(outDir, `${slug}-${stamp}.excalidraw`);
    const sceneName = `${slug}.excalidraw`;
    const theme = String(args.theme ?? 'dark') === 'light' ? 'light' : 'dark';
    const input: CanvasRenderInput = { title, subtitle: args.subtitle ? String(args.subtitle) : undefined, sections, nodes, edges, theme, excalidrawName: sceneName };
    const html = renderCanvasHtml(input);
    const scene = buildExcalidrawScene(input);
    atomicWriteFileSync(htmlPath, html);
    atomicWriteFileSync(scenePath, scene);

    const lines = [`[canvas] ok`, `title: ${title}`, `html: ${htmlPath}`, `excalidraw: ${scenePath}`];
    if (sections.length) lines.push(`phases: ${sections.length} (${sections.reduce((n, s) => n + s.items.length, 0)} items)`);
    if (nodes.length) lines.push(`nodes: ${nodes.length}, edges: ${edges.length}`);
    const shouldOpen = args.open !== false && process.env.MOCHI_CANVAS_OPEN !== '0';
    if (shouldOpen) {
      const ok = await openPath(htmlPath);
      lines.push(ok ? `opened: ${htmlPath}` : 'opened: failed (no desktop opener; open the file manually)');
    }

    if (args.publish === true) {
      const session = browserOptions(ctx.cwd);
      try {
        await initBrowserSession(session);
        const nav = await browserCall(session, 'navigate', { url: 'https://excalidraw.com', timeoutMs: 45_000 }, 60_000);
        if (nav.ok === false) {
          lines.push(`publish: failed (${String(nav.error ?? 'could not open excalidraw')})`);
        } else {
          const b64 = Buffer.from(scene, 'utf8').toString('base64');
          const script = `(async()=>{const bin=atob(${JSON.stringify(b64)});const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);const file=new File([bytes],${JSON.stringify(sceneName)},{type:'application/json'});const dt=new DataTransfer();dt.items.add(file);const target=document.querySelector('.excalidraw')||document.body;for(const t of ['dragenter','dragover','drop']){target.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt}));}return 'dropped';})()`;
          const dropped = await browserCall(session, 'evaluate', { expression: script }, 30_000);
          if (dropped.ok === false) {
            lines.push(`publish: failed (${String(dropped.error ?? 'drop failed')})`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
            const shotPath = join(outDir, `${slug}-${stamp}.png`);
            const shot = await browserCall(session, 'screenshot', { path: shotPath, fullPage: false }, 45_000);
            lines.push(shot.ok === false ? `publish: scene dropped, screenshot failed (${String(shot.error ?? '')})` : `published: excalidraw.com · screenshot: ${shotPath}`);
          }
        }
      } catch (err) {
        lines.push(`publish: failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    lines.push('note: the .excalidraw file can be dragged onto excalidraw.com any time.');
    return lines.join('\n');
  },
};
