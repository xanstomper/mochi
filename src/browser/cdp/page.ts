// Per-page CDP session semantics: the layer between the raw protocol client
// and the tool surface.
//
// Owns, for ONE attached page target:
//  - the accessibility-tree snapshot with STABLE REF IDS: every interactive
//    AX node gets an `e<N>` ref mapped to its `backendDOMNodeId`; actions
//    resolve refs back through the DOM domain (scrollIntoViewIfNeeded /
//    getBoxModel) and inject real input events. This is the token-light page
//    representation — no raw HTML dumps by default.
//  - dialog auto-handling (alert/confirm/beforeunload dismissed, RECORDED —
//    the handling shows up in the next result, never silently swallowed).
//  - the labeled evidence buffer: console errors, uncaught exceptions,
//    failed network requests, HTTP >= 400 responses, dialogs. The tool drains
//    it onto every snapshot/action result so page-state claims are grounded
//    in observed evidence.
//  - waits: network-idle (Network-domain request accounting), selector
//    (DOM.querySelector polling), text (AX-tree scan polling), ms.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CdpClient } from './client.js';

export interface AxElement {
  ref?: string;
  role: string;
  name: string;
  value?: string;
  depth: number;
  /** True on the node that currently has keyboard focus (carried into the
   *  shared a11y tree so a handoff can bring the focused node across). */
  focused?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: AxElement[];
  /** ref -> backendDOMNodeId (actions resolve refs through this). */
  refMap: Map<string, number>;
  /** Plain-text page content assembled from AX names/values (capped). */
  text: string;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
  fullPage: boolean;
}

export type WaitKind = 'network-idle' | 'selector' | 'text' | 'ms';

/** Roles that receive stable refs (interaction targets). Text/heading nodes
 *  render context lines WITHOUT refs — refs on everything is what bloats
 *  other tools' snapshots. */
const REF_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'slider', 'spinbutton', 'switch', 'img',
]);

const MAX_SNAPSHOT_NODES = 240;
const MAX_TEXT_CHARS = 6000;

/** AX tree node shape (the fields this module reads). */
interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: unknown };
  value?: { value?: unknown };
  /** Focus arrives here on some protocol versions… */
  focused?: { value?: unknown };
  /** …and in the properties list on others (measured on chrome-headless-shell
   *  156: properties:[{name:'focused', value:{value:true}}]). */
  properties?: Array<{ name?: unknown; value?: { value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** True when an AX node reports keyboard focus (either field shape). */
function axFocused(n: AxNode): boolean {
  if (n.focused?.value === true) return true;
  return Array.isArray(n.properties)
    && n.properties.some((p) => p?.name === 'focused' && p.value?.value === true);
}

interface Rect { x: number; y: number; width: number; height: number }

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

export class CdpPage {
  private readonly refMap = new Map<string, number>();
  private readonly evidence: string[] = [];
  private readonly dialogLog: string[] = [];
  private inflight = 0;
  private lastNetworkActivity = Date.now();
  private disposers: Array<() => void> = [];
  private closed = false;

  private constructor(
    readonly client: CdpClient,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  /** Attach in flatten mode, enable the domains we live on, wire handlers. */
  static async attach(client: CdpClient, targetId: string): Promise<CdpPage> {
    const sessionId = await client.attach(targetId);
    const page = new CdpPage(client, sessionId, targetId);
    page.wire();
    await Promise.all([
      page.send('Page.enable'),
      page.send('Runtime.enable'),
      page.send('Network.enable'),
    ]).catch((err: unknown) => {
      throw new Error(`CDP page setup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return page;
  }

  private send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.client.send(method, params, { sessionId: this.sessionId, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  // ---------------------------------------------------------------- events

  private wire(): void {
    const on = (method: string, handler: (params: Record<string, unknown>) => void): void => {
      this.disposers.push(this.client.on(method, handler, this.sessionId));
    };
    // Dialogs: auto-dismiss (never accept a confirm/beforeunload on the
    // model's behalf) and RECORD the handling.
    on('Page.javascriptDialogOpening', (params) => {
      const type = str(params.type) || 'dialog';
      const message = str(params.message).slice(0, 300);
      this.dialogLog.push(`${type}: ${message}`);
      void this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => { /* gone */ });
    });
    on('Runtime.consoleAPICalled', (params) => {
      const type = str(params.type);
      if (type !== 'error' && type !== 'warning') return;
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args
        .map((a) => {
          const o = a as { description?: unknown; value?: unknown };
          return str(o.description ?? o.value);
        })
        .join(' ')
        .slice(0, 300);
      if (text) this.evidence.push(`console ${type}: ${text}`);
    });
    on('Runtime.exceptionThrown', (params) => {
      const d = (params.exceptionDetails ?? {}) as { text?: unknown; exception?: { description?: unknown; value?: unknown } };
      const text = str(d.exception?.description ?? d.exception?.value ?? d.text).slice(0, 300);
      this.evidence.push(`uncaught exception: ${text || 'unknown'}`);
    });
    on('Network.requestWillBeSent', () => {
      this.inflight++;
      this.lastNetworkActivity = Date.now();
    });
    on('Network.loadingFinished', () => {
      this.inflight = Math.max(0, this.inflight - 1);
      this.lastNetworkActivity = Date.now();
    });
    on('Network.loadingFailed', (params) => {
      this.inflight = Math.max(0, this.inflight - 1);
      const errText = str(params.errorText) || 'failed';
      this.evidence.push(`network failed: ${errText}${params.canceled ? ' (canceled)' : ''}`);
    });
    on('Network.responseReceived', (params) => {
      this.inflight = Math.max(0, this.inflight - 1);
      const res = (params.response ?? {}) as { status?: unknown; url?: unknown };
      const status = Number(res.status ?? 0);
      if (status >= 400) {
        this.evidence.push(`HTTP ${status}: ${str(res.url).slice(0, 200)}`);
      }
    });
  }

  /** Labeled evidence block (console/network/dialogs) accumulated since the
   *  last drain, plus the dialog log. Clears the buffers. */
  drainEvidence(): string[] {
    const lines = [...this.evidence];
    this.evidence.length = 0;
    for (const d of this.dialogLog.splice(0)) {
      const [type, ...rest] = d.split(': ');
      lines.push(`dialog auto-dismissed (${type}): ${rest.join(': ')}`);
    }
    return lines;
  }

  get alive(): boolean { return !this.closed; }

  // ---------------------------------------------------------------- snapshot

  /** Accessibility.getFullAXTree walk → flat ref-id'd elements + text. */
  async snapshot(): Promise<PageSnapshot> {
    const ax = await this.send('Accessibility.getFullAXTree', {}, 20_000);
    const nodes = (Array.isArray(ax.nodes) ? ax.nodes : []) as AxNode[];
    const byId = new Map<string, AxNode>();
    for (const n of nodes) byId.set(n.nodeId, n);
    const parentOf = new Map<string, string>();
    for (const n of nodes) {
      for (const c of n.childIds ?? []) parentOf.set(c, n.nodeId);
    }
    // Depth-first from the roots, skipping ignored nodes but keeping their
    // (non-ignored) descendants — ignored wrappers wrap real content.
    const roots = nodes.filter((n) => !parentOf.has(n.nodeId));
    const elements: AxElement[] = [];
    const textParts: string[] = [];
    this.refMap.clear();
    let refCounter = 0;
    let textBudget = MAX_TEXT_CHARS;
    const visit = (n: AxNode, depth: number): void => {
      if (elements.length >= MAX_SNAPSHOT_NODES || textBudget <= 0) return;
      if (!n.ignored) {
        const role = str(n.role?.value) || 'generic';
        const name = str(n.name?.value);
        let ref: string | undefined;
        if (n.backendDOMNodeId !== undefined && REF_ROLES.has(role)) {
          ref = `e${++refCounter}`;
          this.refMap.set(ref, n.backendDOMNodeId);
        }
        if (ref || role !== 'generic' || name) {
          const focused = axFocused(n);
          elements.push({ role, name: name.slice(0, 200), depth, ...(ref ? { ref } : {}), ...(focused ? { focused: true } : {}) });
        }
        const value = str(n.value?.value);
        const label = name || value;
        if (label && textBudget > 0) {
          const line = `${'  '.repeat(Math.min(depth, 6))}${label}`;
          textParts.push(line.slice(0, 300));
          textBudget -= line.length + 1;
        }
      }
      for (const cid of n.childIds ?? []) {
        const child = byId.get(cid);
        if (child) visit(child, n.ignored ? depth : depth + 1);
      }
    };
    for (const r of roots) visit(r, 0);

    let url = '';
    let title = '';
    try {
      const meta = await this.send('Runtime.evaluate', {
        expression: '({ u: location.href, t: document.title })',
        returnByValue: true,
      }, 5000);
      const value = meta.result as { value?: { u?: unknown; t?: unknown } } | undefined;
      url = str(value?.value?.u);
      title = str(value?.value?.t);
    } catch { /* crashed/closed target — fields stay empty */ }
    return { url, title, elements, refMap: this.refMap, text: textParts.join('\n') };
  }

  // ---------------------------------------------------------------- actions

  private backendIdFor(ref: string): number {
    const id = this.refMap.get(ref);
    if (id === undefined) {
      throw new Error(`unknown or stale ref "${ref}" — take a fresh snapshot; refs are per-snapshot`);
    }
    return id;
  }

  /** Resolve a backend node to a viewport rect via the DOM domain (with a
   *  requestNode fallback for older protocol builds). */
  private async nodeRect(backendNodeId: number): Promise<Rect> {
    try {
      const box = await this.send('DOM.getBoxModel', { backendNodeId });
      return this.rectFromBox(box);
    } catch (err) {
      if (!(err instanceof Error) || !/backendNodeId/i.test(err.message)) throw err;
      const node = await this.send('DOM.requestNode', { backendNodeId });
      const nodeId = Number(node.nodeId);
      const box = await this.send('DOM.getBoxModel', { nodeId });
      return this.rectFromBox(box);
    }
  }

  private rectFromBox(box: Record<string, unknown>): Rect {
    const model = (box.model ?? {}) as { content?: number[] };
    const q = model.content ?? [];
    if (q.length < 8) throw new Error('DOM.getBoxModel returned no content quad (element not rendered?)');
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs), x2 = Math.max(...xs);
    const y = Math.min(...ys), y2 = Math.max(...ys);
    return { x, y, width: x2 - x, height: y2 - y };
  }

  private async mousePressAt(x: number, y: number, clickCount = 1): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  }

  /** click(ref): scroll the node into view, then real mouse press/release at
   *  its center. Returns the point clicked. */
  async click(ref: string, opts: { double?: boolean } = {}): Promise<{ x: number; y: number }> {
    const backendId = this.backendIdFor(ref);
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: backendId }).catch(() => { /* offscreen is fine */ });
    const rect = await this.nodeRect(backendId);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await this.mousePressAt(x, y, opts.double ? 2 : 1);
    return { x, y };
  }

  /** type(ref, text): focus via a real click, optionally clear with a Ctrl+A
   *  / Delete chord, then Input.insertText (composes like a real IME-less
   *  keyboard, firing the page's own input events). */
  async type(ref: string, text: string, opts: { clear?: boolean } = {}): Promise<void> {
    const backendId = this.backendIdFor(ref);
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: backendId }).catch(() => { /* offscreen is fine */ });
    const rect = await this.nodeRect(backendId);
    await this.mousePressAt(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
    if (opts.clear) await this.clearFocusedValue();
    if (text) await this.send('Input.insertText', { text });
  }

  private async clearFocusedValue(): Promise<void> {
    const chord = async (key: string, code: string, vk: number, modifiers = 0, extra: Record<string, unknown> = {}): Promise<void> => {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, autoRepeat: false, ...extra });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    };
    await chord('a', 'KeyA', 65, 2); // Control+A
    await chord('Delete', 'Delete', 46);
  }

  /** key(name): dispatch a named key chord (Enter, Escape, Tab, arrows,
   *  printable single characters, Control/Alt/Shift/Meta+X chords). */
  async key(rawName: string): Promise<string> {
    const name = rawName.trim();
    if (!name) throw new Error('key: name required (e.g. Enter, Escape, Tab, Control+A)');
    const parts = name.split('+').map((p) => p.trim()).filter(Boolean);
    let modifiers = 0;
    let base = parts.pop() as string;
    for (const part of parts) {
      const p = part.toLowerCase();
      if (p === 'ctrl' || p === 'control') modifiers |= 2;
      else if (p === 'alt' || p === 'option') modifiers |= 1;
      else if (p === 'shift') modifiers |= 8;
      else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') modifiers |= 4;
      else throw new Error(`key: unknown modifier "${part}"`);
    }
    const special = SPECIAL_KEYS[base.toLowerCase()];
    const vk = special?.vk ?? (base.length === 1 ? base.toUpperCase().charCodeAt(0) : 0);
    const code = special?.code ?? (base.length === 1 ? `Key${base.toUpperCase()}` : '');
    const keyName = special?.key ?? base;
    const text = special?.text ?? (base.length === 1 && modifiers === 0 ? base : undefined);
    if (text !== undefined) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers, text });
    } else {
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
    return name;
  }

  /** scroll: mouseWheel at the given node (or viewport center). */
  async scroll(opts: { direction?: string; amount?: number; ref?: string } = {}): Promise<{ x: number; y: number; deltaY: number; deltaX: number }> {
    const amount = Number(opts.amount ?? 500) || 500;
    const direction = String(opts.direction ?? 'down').toLowerCase();
    let x = 0, y = 0;
    if (opts.ref) {
      const rect = await this.nodeRect(this.backendIdFor(opts.ref));
      x = Math.round(rect.x + rect.width / 2);
      y = Math.round(rect.y + rect.height / 2);
    } else {
      try {
        const metrics = await this.send('Page.getLayoutMetrics');
        const vp = (metrics.cssVisualViewport ?? metrics.visualViewport ?? {}) as { width?: number; height?: number };
        x = Math.round(Number(vp.width ?? 800) / 2);
        y = Math.round(Number(vp.height ?? 600) / 2);
      } catch {
        x = 400; y = 300;
      }
    }
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    return { x, y, deltaX, deltaY };
  }

  /** eval(js): Runtime.evaluate with awaitPromise+returnByValue. The TOOL
   *  layer permission-gates this; the page layer just runs it. */
  async evalJs(expression: string): Promise<unknown> {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, 30_000);
    const details = res.exceptionDetails as { exception?: { description?: unknown; value?: unknown }; text?: unknown } | undefined;
    if (details) {
      throw new Error(`page eval failed: ${str(details.exception?.description ?? details.exception?.value ?? details.text).slice(0, 400)}`);
    }
    const result = res.result as { value?: unknown } | undefined;
    return result?.value;
  }

  /** screenshot: PNG via Page.captureScreenshot, written to disk. */
  async screenshot(opts: { path: string; fullPage?: boolean }): Promise<ScreenshotResult> {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      ...(opts.fullPage ? { captureBeyondViewport: true } : {}),
    }, 20_000);
    const data = str(res.data);
    if (!data) throw new Error('screenshot returned no data (target closed?)');
    mkdirSync(dirname(opts.path), { recursive: true });
    const buf = Buffer.from(data, 'base64');
    writeFileSync(opts.path, buf);
    return { path: opts.path, bytes: buf.length, fullPage: opts.fullPage === true };
  }

  /** wait for network-idle | selector | text | ms. */
  async wait(kind: WaitKind, opts: { ms?: number; selector?: string; text?: string; timeoutMs?: number } = {}): Promise<string> {
    const timeoutMs = Number(opts.timeoutMs ?? 10_000) || 10_000;
    const deadline = Date.now() + timeoutMs;
    switch (kind) {
      case 'ms': {
        const ms = Math.min(Number(opts.ms ?? 0) || 0, timeoutMs);
        await new Promise((r) => setTimeout(r, ms));
        return `waited ${ms}ms`;
      }
      case 'network-idle': {
        // Idle = no inflight requests for 500ms.
        while (Date.now() < deadline) {
          if (this.inflight === 0 && Date.now() - this.lastNetworkActivity >= 500) {
            return 'network idle (no inflight requests for 500ms)';
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`network not idle after ${timeoutMs}ms (${this.inflight} inflight request(s))`);
      }
      case 'selector': {
        const selector = opts.selector ?? '';
        if (!selector) throw new Error('wait selector: selector required');
        while (Date.now() < deadline) {
          const doc = await this.send('DOM.getDocument', { depth: 0 }).catch(() => null);
          if (doc) {
            const root = doc.root as { nodeId?: unknown } | undefined;
            const rootId = Number(root?.nodeId ?? 0);
            const found = await this.send('DOM.querySelector', { nodeId: rootId, selector }).catch(() => null);
            if (found && Number(found.nodeId) !== 0) return `selector matched: ${selector}`;
          }
          await new Promise((r) => setTimeout(r, 120));
        }
        throw new Error(`selector "${selector}" not found within ${timeoutMs}ms`);
      }
      case 'text': {
        const needle = opts.text ?? '';
        if (!needle) throw new Error('wait text: text required');
        while (Date.now() < deadline) {
          const ax = await this.send('Accessibility.getFullAXTree', {}).catch(() => null);
          const nodes = (Array.isArray((ax as { nodes?: unknown })?.nodes) ? (ax as { nodes: AxNode[] }).nodes : []);
          const hit = nodes.some((n) => str(n.name?.value).includes(needle) || str(n.value?.value).includes(needle));
          if (hit) return `text found: "${needle.slice(0, 80)}"`;
          await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(`text "${needle.slice(0, 80)}" not found within ${timeoutMs}ms`);
      }
      default:
        throw new Error(`wait: unknown kind "${String(kind)}"`);
    }
  }

  /** Navigate and wait for the load event (never returns before the page
   *  commits; errors carry the loader's own message). */
  async navigate(url: string, timeoutMs = 30_000): Promise<{ url: string }> {
    const res = await this.send('Page.navigate', { url }, Math.max(5_000, timeoutMs));
    if (res.errorText) {
      throw new Error(`navigation failed: ${str(res.errorText)}`);
    }
    return { url };
  }

  /** Close this page (browser-level Target.closeTarget). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const d of this.disposers.splice(0)) d();
    await this.client.send('Target.closeTarget', { targetId: this.targetId }).catch(() => { /* already gone */ });
  }
}

/** Named-key map: key name → CDP dispatch fields. */
const SPECIAL_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
};
