import { PerformancePipeline } from './performance-pipeline.js';

function sse(payload: object) {
  return `data: ${JSON.stringify(payload)}\n`;
}

export interface PerfReport {
  parserMs: number;
  busMs: number;
  stateMs: number;
  renderMs: number;
  totalMs: number;
  events: number;
  chunks: number;
  bytes: number;
}

export function benchmarkStream(chunks = 10_000): PerfReport {
  const pipeline = new PerformancePipeline('bench');
  const payload = sse({ choices: [{ delta: { content: 'x' } }] });
  const start = performance.now();
  let bytes = 0;

  for (let i = 0; i < chunks; i++) {
    pipeline.write(payload);
    bytes += payload.length;
  }
  pipeline.end();

  const totalMs = performance.now() - start;
  const stats = pipeline.getStats();
  return {
    parserMs: stats.parser.parseMs ?? 0,
    busMs: stats.bus.averageDispatchMs * stats.bus.totalEvents,
    stateMs: stats.state.stateMs ?? 0,
    renderMs: stats.renderer.averageFrameMs * stats.renderer.frames,
    totalMs,
    events: stats.bus.totalEvents,
    chunks,
    bytes,
  };
}

export function formatPerfReport(report: PerfReport): string {
  const pct = (v: number) => `${((v / report.totalMs) * 100).toFixed(1)}%`;
  return [
    'Mochi performance pipeline',
    `chunks:      ${report.chunks.toLocaleString()}`,
    `bytes:       ${report.bytes.toLocaleString()}`,
    `events:      ${report.events.toLocaleString()}`,
    '',
    `parser:      ${report.parserMs.toFixed(2)}ms (${pct(report.parserMs)})`,
    `event bus:   ${report.busMs.toFixed(2)}ms (${pct(report.busMs)})`,
    `state:       ${report.stateMs.toFixed(2)}ms (${pct(report.stateMs)})`,
    `renderer:    ${report.renderMs.toFixed(2)}ms (${pct(report.renderMs)})`,
    '──────────────────────────────',
    `total:       ${report.totalMs.toFixed(2)}ms`,
    `per chunk:   ${(report.totalMs / report.chunks).toFixed(4)}ms`,
  ].join('\n');
}
