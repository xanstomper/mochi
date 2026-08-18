#!/usr/bin/env node
import { PerformancePipeline } from '../performance-pipeline.js';

const W = 78;
const H = 24;

const REGION = {
  title: 1,
  goal: 4,
  message: 8,
  messageH: 4,
  task: 13,
  taskH: 4,
  status: 19,
  statusH: 2,
};

let running = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hide = () => process.stdout.write('\x1b[?25l');
const show = () => process.stdout.write('\x1b[?25h');

function cursor(y: number) {
  return `\x1b[${y};1H`;
}

function patch(text: string, top: number, height: number, bg: string): string {
  const lines = text.split('\n');
  let out = '';
  for (let i = 0; i < height; i++) {
    out += cursor(top + i);
    const content = (lines[i] ?? '').slice(0, W);
    out += bg + content.padEnd(W) + '\x1b[0m';
  }
  return out;
}

function box(): string {
  const tl = '╭'; const tr = '╮'; const bl = '╰'; const br = '╯';
  const h = '─'.repeat(W - 2);
  const v = '│';
  const blank = v + ' '.repeat(W - 2) + v;
  const lines: string[] = [];
  lines.push(tl + h + tr);
  for (let i = 1; i < H - 1; i++) lines.push(blank);
  lines.push(bl + h + br);
  // header
  const title = ' MOCHI ' + '· terminal agent · '.padEnd(W - 16) + '0.4.0 ';
  lines[1] = v + title.padEnd(W - 2).slice(0, W - 2) + v;
  lines[3] = v + (' Goal ' + '─'.repeat(W - 8)).padEnd(W - 2) + v;
  lines[4] = v;
  return lines.join('\n');
}

function frame(text: string, top: number, height: number) {
  const lines = text.split('\n');
  let out = '';
  for (let i = 0; i < height; i++) {
    out += cursor(top + i);
    const content = (lines[i] ?? '').slice(0, W - 4);
    out += '\x1b[K' + content.padEnd(W - 4);
  }
  return out;
}

function draw(): string {
  let out = box() + '\n';
  out += cursor(REGION.goal) + '  Inspect repository · Trace stream · Render dashboard · Verify';
  return out;
}

function wrap(s: string, w: number): string[] {
  if (s.length <= w) return [s];
  const out: string[] = [];
  while (s.length > w) {
    out.push(s.slice(0, w));
    s = s.slice(w);
  }
  out.push(s);
  return out.slice(0, 3);
}

const demo = [
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Mochi is now running ' } }] }) + '\n',
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'a real dashboard TUI' } }] }) + '\n',
  'data: ' + JSON.stringify({ choices: [{ delta: { content: ' streamed through the incremental parser → compact events → FastEventBus → batched state → dirty-region renderer. Each frame only repaints the dirty region, exactly like the perf model.' } }] }) + '\n',
];

async function run() {
  setRaw(true);
  process.stdout.write('\x1b[?1049h');
  hide();
  process.stdout.write(draw());

  const pipeline = new PerformancePipeline('demo');
  const tasks = ['✓ Inspect repository', '✓ Trace stream', '◐ Render dashboard', '○ Verify'] as string[];

  process.stdin.on('data', (key) => {
    const s = key.toString();
    if (s === 'q' || s === 'Q' || s === '\u0003') running = false;
  });

  process.stdout.write(frame('  Streaming output...', REGION.message, REGION.messageH));
  await sleep(300);

  let i = 0;
  // Write the demonstration stream once, end to end.
  for (const chunk of demo) {
    pipeline.write(chunk);
    const msgLines = wrap(pipeline.store.get('message'), W - 6);
    process.stdout.write(frame(msgLines.join('\n'), REGION.message, REGION.messageH));
    await sleep(60);
    i++;
  }
  pipeline.end();

  // Animate live status / task state without re-streaming text.
  const phases = ['full', 'reduced', 'cheap', 'verify', 'exhausted'];
  while (running) {
    const msgLines = wrap(pipeline.store.get('message'), W - 6);
    process.stdout.write(frame(msgLines.join('\n'), REGION.message, REGION.messageH));

    const taskText = tasks.join('\n');
    process.stdout.write(frame(taskText, REGION.task, REGION.taskH));

    const st = pipeline.getStats();
    const status = ` events=${st.bus.totalEvents}  parser=${st.parser.parseCount}  frames=${st.renderer.frames}  q to quit `;
    process.stdout.write(frame(status, REGION.status, REGION.statusH));

    await sleep(140);
    if (i++ > 300) running = false;
  }

  process.stdout.write(frame(' stream complete.  q to quit ', REGION.status + 1, REGION.statusH));
  show();
  setRaw(false);
  await sleep(800);
  process.stdout.write('\x1b[0m\x1b[?1049l' + cursor(1));
}

function setRaw(v: boolean) {
  try {
    process.stdin.setRawMode(v);
  } catch {}
}

run();