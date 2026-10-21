// Device automation — phones, emulators, and the desktop.
//
// A general agent that can only touch files is half an agent. This tool drives
// Android through `adb` (taps, swipes, typing, UI dumps, app launch, install,
// logcat), iOS simulators through `xcrun simctl`, and the Linux desktop through
// `xdotool`/`scrot`/`wmctrl`. Everything is argv-based through the central exec
// policy (timeouts, SIGKILL, output caps); no shell interpolation of user text.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tool } from './types.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import { runArgv, type ExecResult } from '../exec.js';

export type DevicePlatform = 'android' | 'desktop' | 'ios';

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

/** Parse `adb devices -l` (pure, unit-tested). */
export function parseAdbDevices(output: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const line of String(output).split('\n')) {
    const m = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload)\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const model = /\bmodel:(\S+)/.exec(m[3] ?? '')?.[1]?.replace(/_/g, ' ');
    out.push({ serial: m[1], state: m[2], ...(model ? { model } : {}) });
  }
  return out;
}

const KEYCODES: Record<string, number> = {
  home: 3, back: 4, call: 5, endcall: 6, up: 19, down: 20, left: 21, right: 22,
  center: 23, volumeup: 24, volumedown: 25, power: 26, camera: 27, clear: 28,
  tab: 61, space: 62, enter: 66, delete: 67, backspace: 67, escape: 111, esc: 111,
  forward_del: 112, menu: 82, notification: 83, search: 84, play: 126, pause: 127,
  wakeup: 224, sleep: 223, brightness_up: 221, brightness_down: 220,
};

/** Resolve a key name (home/back/enter/…) or pass a raw keycode (pure). */
export function resolveKeyCode(key: string): number | null {
  const k = String(key).trim();
  if (/^\d+$/.test(k)) {
    const n = Number(k);
    return Number.isFinite(n) ? n : null;
  }
  return KEYCODES[k.toLowerCase().replace(/[\s_-]+/g, '')] ?? null;
}

/** `adb shell input text` encoding: spaces become %s. Android's `input`
 *  replaces only the literal two-character sequence `%s`; a bare `%` is
 *  passed through, so do NOT double it. */
export function escapeInputText(text: string): string {
  return String(text).replace(/ /g, '%s');
}

/** Quote one argument for the REMOTE POSIX shell that `adb shell` invokes.
 *  argv-array safety only covers the local process; without this, typing a
 *  message containing `;`, `$()`, or quotes would execute on the device. */
function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** XML UI dump -> compact actionable refs (pure, unit-tested). */
export function parseUiDump(xml: string, limit = 120): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(xml))) && out.length < limit) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const text = (attrs.text || attrs['content-desc'] || '').trim();
    const clickable = attrs.clickable === 'true';
    if (!text && !clickable) continue;
    out.push({
      text: text.slice(0, 140),
      class: (attrs.class || '').split('.').pop(),
      clickable,
      bounds: attrs.bounds,
      resourceId: attrs['resource-id'] || undefined,
    });
  }
  return out;
}

async function which(bin: string): Promise<boolean> {
  try {
    const r = await runArgv(process.platform === 'win32' ? 'where' : 'which', [bin], { timeoutMs: 4000, maxOutput: 4096 });
    return r.code === 0 && Boolean(r.stdout.trim());
  } catch {
    return false;
  }
}

async function adb(args: string[], serial?: string, timeoutMs = 30_000): Promise<ExecResult> {
  return runArgv('adb', [...(serial ? ['-s', serial] : []), ...args], { timeoutMs, maxOutput: 2_000_000 });
}

function textOf(r: ExecResult): string {
  const s = `${r.stdout}${r.stderr}`.trim();
  return s || `(exit ${r.code ?? '?'})`;
}

function failure(r: ExecResult): string | null {
  if (r.timedOut) return 'command timed out';
  if (r.code !== 0) return textOf(r).slice(0, 800);
  return null;
}

function shotPath(cwd: string, tag: string): string {
  const dir = join(mochiStateDir(cwd), 'device');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
}

async function androidDevices(): Promise<AdbDevice[]> {
  try {
    const r = await adb(['devices', '-l'], undefined, 10_000);
    return parseAdbDevices(r.stdout);
  } catch {
    return [];
  }
}

async function pickSerial(requested?: string): Promise<string | undefined> {
  if (requested) return requested;
  const devices = await androidDevices();
  return devices.find((d) => d.state === 'device')?.serial ?? devices[0]?.serial;
}

async function androidAction(action: string, args: Record<string, unknown>, cwd: string): Promise<string> {
  const serial = await pickSerial(args.serial ? String(args.serial) : undefined);
  const needsDevice = !['devices', 'status'].includes(action);
  if (needsDevice && !serial) return '[device android] ERROR: no adb device. Connect one (adb devices) or start an emulator.';
  const n = (v: unknown, d = 0) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.round(x) : d;
  };
  switch (action) {
    case 'status':
    case 'devices': {
      const devices = await androidDevices();
      return devices.length
        ? [`[device android] ${devices.length} device(s)`, ...devices.map((d) => `• ${d.serial} ${d.state}${d.model ? ` (${d.model})` : ''}`)].join('\n')
        : '[device android] no devices. `adb devices` is available but nothing is attached.';
    }
    case 'screenshot': {
      const remote = '/sdcard/mochi-device-shot.png';
      const local = args.path ? resolve(cwd, String(args.path)) : shotPath(cwd, 'android');
      const cap = await adb(['shell', 'screencap', '-p', remote], serial, 20_000);
      const capErr = failure(cap);
      if (capErr) return `[device android] screenshot ERROR: ${capErr}`;
      const pull = await adb(['pull', remote, local], serial, 30_000);
      await adb(['shell', 'rm', '-f', remote], serial, 8000);
      const err = failure(pull);
      if (err) return `[device android] screenshot ERROR: ${err}`;
      return `[device android] screenshot: ${local}`;
    }
    case 'tap': {
      const r = await adb(['shell', 'input', 'tap', String(n(args.x)), String(n(args.y))], serial);
      const err = failure(r);
      return err ? `[device android] tap ERROR: ${err}` : `[device android] tapped (${n(args.x)}, ${n(args.y)})${serial ? ` on ${serial}` : ''}`;
    }
    case 'swipe': {
      const dur = Math.max(0, Math.min(n(args.durationMs, 300), 10_000));
      const r = await adb(['shell', 'input', 'swipe', String(n(args.x1)), String(n(args.y1)), String(n(args.x2)), String(n(args.y2)), String(dur)], serial);
      const err = failure(r);
      return err ? `[device android] swipe ERROR: ${err}` : `[device android] swiped (${n(args.x1)},${n(args.y1)}) → (${n(args.x2)},${n(args.y2)}) in ${dur}ms`;
    }
    case 'text': {
      const text = String(args.text ?? '');
      if (!text) return '[device android] ERROR: text is required';
      const r = await adb(['shell', 'input', 'text', shQuote(escapeInputText(text))], serial, 20_000);
      const err = failure(r);
      if (err) return `[device android] text ERROR: ${err}`;
      return `[device android] typed ${text.length} chars${/[^\x20-\x7e\n]/.test(text) ? ' (non-ASCII may need the ADBKeyboard IME)' : ''}`;
    }
    case 'key': {
      const code = resolveKeyCode(String(args.key ?? args.code ?? ''));
      if (code === null) return `[device android] ERROR: unknown key "${String(args.key ?? '')}". Use a name (home/back/enter/tab/power/volumeup) or a numeric keycode.`;
      const r = await adb(['shell', 'input', 'keyevent', String(code)], serial);
      const err = failure(r);
      return err ? `[device android] key ERROR: ${err}` : `[device android] keyevent ${args.key ?? code} (${code})`;
    }
    case 'ui':
    case 'snapshot': {
      const remote = '/sdcard/mochi-window-dump.xml';
      const dump = await adb(['shell', 'uiautomator', 'dump', remote], serial, 30_000);
      const derr = failure(dump);
      if (derr) return `[device android] ui ERROR: ${derr}`;
      const cat = await adb(['shell', 'cat', remote], serial, 20_000);
      await adb(['shell', 'rm', '-f', remote], serial, 8000);
      const nodes = parseUiDump(cat.stdout, Math.max(1, Math.min(n(args.limit, 120), 400)));
      return [`[device android] ui: ${nodes.length} node(s)`, ...nodes.map((x) => JSON.stringify(x))].join('\n');
    }
    case 'apps': {
      const r = await adb(['shell', 'pm', 'list', 'packages', args.all === true ? '' : '-3'].filter(Boolean), serial, 30_000);
      const err = failure(r);
      if (err) return `[device android] apps ERROR: ${err}`;
      const pkgs = r.stdout.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
      return [`[device android] ${pkgs.length} package(s)`, ...pkgs.slice(0, 300)].join('\n');
    }
    case 'launch': {
      const pkg = String(args.package ?? args.app ?? '').trim();
      if (!pkg) return '[device android] ERROR: package is required';
      const r = await adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], serial, 20_000);
      const err = failure(r);
      return err ? `[device android] launch ERROR: ${err}` : `[device android] launched ${pkg}`;
    }
    case 'shell': {
      const cmd = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : String(args.command ?? '').split(/\s+/).filter(Boolean);
      if (!cmd.length) return '[device android] ERROR: command/args required';
      const r = await adb(['shell', ...cmd], serial, Math.min(n(args.timeoutMs, 30_000) || 30_000, 300_000));
      return `[device android] shell ${cmd.join(' ')}\n${textOf(r).slice(0, 20_000)}`;
    }
    case 'install': {
      const apk = String(args.path ?? '').trim();
      if (!apk) return '[device android] ERROR: path is required';
      if (!existsSync(resolve(cwd, apk))) return `[device android] ERROR: no such file: ${apk}`;
      const r = await adb(['install', '-r', resolve(cwd, apk)], serial, 180_000);
      const err = failure(r);
      return err ? `[device android] install ERROR: ${err}` : `[device android] installed ${apk}\n${textOf(r).slice(0, 1000)}`;
    }
    case 'push':
    case 'pull': {
      const local = String(args.local ?? args.path ?? '').trim();
      const remote = String(args.remote ?? '').trim();
      if (!local || !remote) return `[device android] ERROR: ${action} requires local and remote paths`;
      const r = await adb([action, resolve(cwd, local), remote], serial, 120_000);
      const err = failure(r);
      return err ? `[device android] ${action} ERROR: ${err}` : `[device android] ${action} ok\n${textOf(r).slice(0, 1000)}`;
    }
    case 'logcat': {
      const lines = Math.max(1, Math.min(n(args.lines, 200), 5000));
      const extra = args.filter ? ['-e', String(args.filter)] : [];
      const r = await adb(['logcat', '-d', '-t', String(lines), ...extra], serial, 40_000);
      const err = failure(r);
      if (err) return `[device android] logcat ERROR: ${err}`;
      return `[device android] logcat (${lines} lines)\n${r.stdout.slice(-30_000)}`;
    }
    default:
      return `[device android] ERROR: unsupported action "${action}"`;
  }
}

async function desktopAction(action: string, args: Record<string, unknown>, cwd: string): Promise<string> {
  const hasXdo = await which('xdotool');
  const hasScrot = await which('scrot');
  const hasWmctrl = await which('wmctrl');
  if (action === 'status' || action === 'devices') {
    const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '(none)';
    let geometry = '';
    if (hasXdo) {
      try {
        const g = await runArgv('xdotool', ['getdisplaygeometry'], { timeoutMs: 5000 });
        geometry = g.stdout.trim();
      } catch { /* ignore */ }
    }
    return [
      '[device desktop]',
      `display: ${display}${geometry ? ` · ${geometry.replace(/\s+/g, 'x')}` : ''}`,
      `xdotool: ${hasXdo ? 'yes' : 'no'} · scrot: ${hasScrot ? 'yes' : 'no'} · wmctrl: ${hasWmctrl ? 'yes' : 'no'}`,
      hasXdo ? '' : 'Install: sudo apt install xdotool scrot wmctrl',
    ].filter(Boolean).join('\n');
  }
  if (!hasXdo) return '[device desktop] ERROR: xdotool is not installed (sudo apt install xdotool)';
  const n = (v: unknown, d = 0) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.round(x) : d;
  };
  switch (action) {
    case 'screenshot': {
      if (!hasScrot) return '[device desktop] ERROR: scrot is not installed (sudo apt install scrot)';
      const local = args.path ? resolve(cwd, String(args.path)) : shotPath(cwd, 'desktop');
      const r = await runArgv('scrot', ['-o', local], { timeoutMs: 15_000 });
      return r.code === 0 ? `[device desktop] screenshot: ${local}` : `[device desktop] screenshot ERROR: ${textOf(r).slice(0, 600)}`;
    }
    case 'tap':
    case 'click': {
      const r = await runArgv('xdotool', ['mousemove', String(n(args.x)), String(n(args.y)), 'click', String(n(args.button, 1) || 1)], { timeoutMs: 8000 });
      return r.code === 0 ? `[device desktop] clicked (${n(args.x)}, ${n(args.y)})` : `[device desktop] click ERROR: ${textOf(r).slice(0, 600)}`;
    }
    case 'swipe':
    case 'drag': {
      const dur = Math.max(0, Math.min(n(args.durationMs, 300), 10_000));
      const steps = Math.max(1, Math.min(Math.round(dur / 20), 50));
      const x1 = n(args.x1), y1 = n(args.y1), x2 = n(args.x2), y2 = n(args.y2);
      const r = await runArgv('xdotool', [
        'mousemove', String(x1), String(y1), 'mousedown', '1',
        ...Array.from({ length: steps }, (_, i) => ['mousemove', String(Math.round(x1 + ((x2 - x1) * (i + 1)) / steps)), String(Math.round(y1 + ((y2 - y1) * (i + 1)) / steps))]).flat(),
        'mouseup', '1',
      ], { timeoutMs: 20_000 });
      return r.code === 0 ? `[device desktop] dragged (${x1},${y1}) → (${x2},${y2})` : `[device desktop] drag ERROR: ${textOf(r).slice(0, 600)}`;
    }
    case 'text':
    case 'type': {
      const text = String(args.text ?? '');
      if (!text) return '[device desktop] ERROR: text is required';
      const r = await runArgv('xdotool', ['type', '--clearmodifiers', '--delay', String(Math.max(0, Math.min(n(args.delayMs, 10), 200))), text], { timeoutMs: 60_000 });
      return r.code === 0 ? `[device desktop] typed ${text.length} chars` : `[device desktop] type ERROR: ${textOf(r).slice(0, 600)}`;
    }
    case 'key': {
      const key = String(args.key ?? args.combo ?? '').trim();
      if (!key) return '[device desktop] ERROR: key is required (e.g. "ctrl+l", "Return", "alt+Tab")';
      const r = await runArgv('xdotool', ['key', '--clearmodifiers', key], { timeoutMs: 8000 });
      return r.code === 0 ? `[device desktop] key ${key}` : `[device desktop] key ERROR: ${textOf(r).slice(0, 600)}`;
    }
    case 'windows':
    case 'list': {
      if (!hasWmctrl) return '[device desktop] ERROR: wmctrl is not installed (sudo apt install wmctrl)';
      const r = await runArgv('wmctrl', ['-l'], { timeoutMs: 8000 });
      return `[device desktop] windows\n${textOf(r).slice(0, 8000)}`;
    }
    case 'focus': {
      if (!hasWmctrl) return '[device desktop] ERROR: wmctrl is not installed';
      const title = String(args.title ?? args.text ?? '').trim();
      if (!title) return '[device desktop] ERROR: title is required';
      const r = await runArgv('wmctrl', ['-a', title], { timeoutMs: 8000 });
      return r.code === 0 ? `[device desktop] focused "${title}"` : `[device desktop] focus ERROR: ${textOf(r).slice(0, 600)}`;
    }
    case 'active': {
      const r = await runArgv('xdotool', ['getactivewindow', 'getwindowname'], { timeoutMs: 8000 });
      return `[device desktop] active window: ${textOf(r).slice(0, 500)}`;
    }
    case 'open': {
      const target = String(args.path ?? args.url ?? '').trim();
      if (!target) return '[device desktop] ERROR: path/url is required';
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const r = await runArgv(opener, [target], { timeoutMs: 10_000 });
      return r.code === 0 ? `[device desktop] opened ${target}` : `[device desktop] open ERROR: ${textOf(r).slice(0, 600)}`;
    }
    default:
      return `[device desktop] ERROR: unsupported action "${action}"`;
  }
}

async function iosAction(action: string, args: Record<string, unknown>, cwd: string): Promise<string> {
  const simctl = await which('xcrun');
  if (!simctl) return '[device ios] ERROR: xcrun/simctl not available (macOS + Xcode required)';
  const n = (v: unknown, d = 0) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.round(x) : d;
  };
  const device = args.device ? String(args.device) : 'booted';
  if (action === 'status' || action === 'devices') {
    const r = await runArgv('xcrun', ['simctl', 'list', 'devices', 'booted'], { timeoutMs: 15_000 });
    return `[device ios] booted simulators\n${textOf(r).slice(0, 8000)}`;
  }
  if (action === 'screenshot') {
    const local = args.path ? resolve(cwd, String(args.path)) : shotPath(cwd, 'ios');
    const r = await runArgv('xcrun', ['simctl', 'io', device, 'screenshot', local], { timeoutMs: 20_000 });
    return r.code === 0 ? `[device ios] screenshot: ${local}` : `[device ios] screenshot ERROR: ${textOf(r).slice(0, 600)}`;
  }
  if (action === 'open' || action === 'launch') {
    const target = String(args.url ?? args.package ?? '').trim();
    if (!target) return '[device ios] ERROR: url/bundle id is required';
    const r = await runArgv('xcrun', ['simctl', 'openurl', device, target], { timeoutMs: 15_000 });
    return r.code === 0 ? `[device ios] opened ${target}` : `[device ios] open ERROR: ${textOf(r).slice(0, 600)}`;
  }
  if (action === 'tap') {
    // simctl has no tap; AppleScript can click at screen coordinates on macOS.
    if (process.platform !== 'darwin') return '[device ios] ERROR: tap requires macOS';
    const script = `tell application "System Events" to click at {${n(args.x)}, ${n(args.y)}}`;
    const r = await runArgv('osascript', ['-e', script], { timeoutMs: 15_000 });
    return r.code === 0 ? `[device ios] tapped (${n(args.x)},${n(args.y)})` : `[device ios] tap ERROR: ${textOf(r).slice(0, 600)}`;
  }
  return `[device ios] ERROR: unsupported action "${action}". Use status|screenshot|open|tap.`;
}

export const deviceTool: Tool = {
  def: {
    name: 'device',
    description:
      'Control real devices and the desktop. Android via adb: status/devices, screenshot, tap, swipe, text, key, ui (uiautomator dump), ' +
      'apps, launch, shell, install, push, pull, logcat. Desktop via xdotool/scrot/wmctrl: screenshot, tap/click, drag, type, key, windows, ' +
      'focus, active, open. iOS simulator via simctl: status, screenshot, open, tap. Use for "tap my phone", "what is on screen", ' +
      '"install this APK", "click that desktop button", "type into the app", mobile QA, and GUI automation outside the browser.',
    parameters: [
      { name: 'action', type: 'string', description: 'status | screenshot | tap | swipe | text | key | ui | apps | launch | shell | install | push | pull | logcat | windows | focus | active | open', required: true },
      { name: 'platform', type: 'string', description: 'auto (default) | android | desktop | ios', required: false },
      { name: 'serial', type: 'string', description: 'Android device serial (default: first attached)', required: false },
      { name: 'x', type: 'number', description: 'Tap X', required: false },
      { name: 'y', type: 'number', description: 'Tap Y', required: false },
      { name: 'x1', type: 'number', description: 'Swipe start X', required: false },
      { name: 'y1', type: 'number', description: 'Swipe start Y', required: false },
      { name: 'x2', type: 'number', description: 'Swipe end X', required: false },
      { name: 'y2', type: 'number', description: 'Swipe end Y', required: false },
      { name: 'durationMs', type: 'integer', description: 'Swipe duration in ms', required: false },
      { name: 'text', type: 'string', description: 'Text to type', required: false },
      { name: 'key', type: 'string', description: 'Key name (home/back/enter/tab/power/volumeup) or xdotool combo (ctrl+l)', required: false },
      { name: 'package', type: 'string', description: 'Android package to launch', required: false },
      { name: 'command', type: 'string', description: 'Android shell command (action:shell)', required: false },
      { name: 'args', type: 'array', description: 'Android shell argv (preferred over command)', required: false },
      { name: 'path', type: 'string', description: 'Screenshot path / APK path / local file', required: false },
      { name: 'remote', type: 'string', description: 'Remote device path (push/pull)', required: false },
      { name: 'local', type: 'string', description: 'Local path (push/pull)', required: false },
      { name: 'title', type: 'string', description: 'Window title (desktop focus)', required: false },
      { name: 'url', type: 'string', description: 'URL to open', required: false },
      { name: 'lines', type: 'integer', description: 'Logcat lines (default 200)', required: false },
      { name: 'filter', type: 'string', description: 'Logcat regex filter', required: false },
    ],
    permission: 'shell',
    dangerous: true,
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'status').toLowerCase();
    let platform = String(args.platform ?? 'auto').toLowerCase();
    try {
      if (platform === 'auto') {
        const androidOnly = new Set(['apps', 'ui', 'snapshot', 'launch', 'install', 'push', 'pull', 'logcat']);
        const desktopOnly = new Set(['windows', 'list', 'focus', 'active', 'drag']);
        const devices = await androidDevices();
        const attached = devices.some((d) => d.state === 'device');
        if (process.platform === 'darwin' && androidOnly.has(action) === false && desktopOnly.has(action) === false && !attached) {
          platform = 'desktop';
        } else if (androidOnly.has(action)) {
          platform = 'android';
        } else if (desktopOnly.has(action)) {
          platform = 'desktop';
        } else if (attached) {
          platform = 'android';
        } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
          platform = 'desktop';
        } else if (await which('adb')) {
          platform = 'android';
        } else {
          platform = 'desktop';
        }
      }
      if (platform === 'android') return await androidAction(action, args, ctx.cwd);
      if (platform === 'ios') return await iosAction(action, args, ctx.cwd);
      if (platform === 'desktop') return await desktopAction(action, args, ctx.cwd);
      return `[device] ERROR: unknown platform "${platform}"`;
    } catch (err) {
      return `[device ${platform}] ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
