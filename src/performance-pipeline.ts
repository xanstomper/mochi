import { FastEventBus } from './fast-events.js';
import { StreamParser } from './stream-parser.js';
import { StateStore } from './state-store.js';
import { BatchScheduler } from './scheduler.js';
import { AnsiRenderer } from './tui/renderer.js';
import type { CompactEvent, UIRegion } from './stream-events.js';

export interface PipelineState {
  message: string;
  toolOutput: string;
  taskTree: string;
  statusBar: string;
  diff: string;
  budget: string;
  [key: string]: unknown;
}

export interface PipelineStats {
  parser: ReturnType<StreamParser['getStats']> & { parseMs?: number };
  bus: ReturnType<FastEventBus['getStats']>;
  state: ReturnType<StateStore<PipelineState>['getStats']> & { stateMs?: number };
  scheduler: ReturnType<BatchScheduler['getStats']>;
  renderer: ReturnType<AnsiRenderer['getStats']>;
}

export class PerformancePipeline {
  readonly bus = new FastEventBus();
  readonly scheduler = new BatchScheduler();
  readonly renderer: AnsiRenderer;
  readonly store: StateStore<PipelineState>;
  private parser: StreamParser;
  private parserMs = 0;
  private stateMs = 0;

  constructor(messageId: string) {
    this.parser = new StreamParser(messageId);
    this.renderer = new AnsiRenderer(() => {});
    this.store = new StateStore<PipelineState>({
      message: '',
      toolOutput: '',
      taskTree: '',
      statusBar: '',
      diff: '',
      budget: '',
    });
    for (const key of ['message', 'toolOutput', 'taskTree', 'statusBar', 'diff', 'budget'] as const) {
      this.store.markHot(key);
    }
    this.wire();
  }

  private wire(): void {
    this.bus.on('text-delta', (event) => {
      if (event.type !== 'text-delta') return;
      this.store.set('message', this.store.get('message') + event.text, 'message');
    });
    this.bus.on('tool-delta', (event) => {
      if (event.type !== 'tool-delta') return;
      this.store.set('toolOutput', this.store.get('toolOutput') + event.delta, 'tool');
    });
    this.bus.on('finish', () => {
      this.store.set('statusBar', 'finished', 'status-bar');
    });
    this.bus.on('error', () => {
      this.store.set('statusBar', 'error', 'status-bar');
    });
  }

  write(chunk: string): void {
    const start = performance.now();
    const events = this.parser.write(chunk);
    this.parserMs += performance.now() - start;
    this.emitBatched(events);
  }

  end(): void {
    const events = this.parser.end();
    this.emitBatched(events);
  }

  private emitBatched(events: CompactEvent[]): void {
    const start = performance.now();
    this.bus.batch(() => {
      for (const event of events) this.bus.emit(event);
    });
    this.stateMs += performance.now() - start;
    const dirty = this.store.getDirty();
    this.store.flush();
    for (const region of dirty) this.renderer.render(region);
    this.renderer.flush();
  }

  markRegion(region: UIRegion): void {
    this.renderer.render(region);
  }

  render(): void {
    this.renderer.flush();
  }

  getStats(): PipelineStats {
    return {
      parser: { ...this.parser.getStats(), parseMs: this.parserMs } as PipelineStats['parser'],
      bus: this.bus.getStats(),
      state: { ...this.store.getStats(), stateMs: this.stateMs } as PipelineStats['state'],
      scheduler: this.scheduler.getStats(),
      renderer: this.renderer.getStats(),
    };
  }
}
