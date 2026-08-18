import type { UIRegion } from '../stream-events.js';

export interface RenderStats {
  frames: number;
  regionsRendered: number;
  lastFrameMs: number;
  maxFrameMs: number;
  averageFrameMs: number;
}

export interface Renderer {
  render(region: UIRegion): void;
  flush(): void;
  getStats(): RenderStats;
}

/**
 * Minimal ANSI renderer.
 *
 * Only renders dirty regions. This is intentionally tiny: OpenTUI can replace
 * it later without changing the performance pipeline above it.
 */
export class AnsiRenderer implements Renderer {
  private dirty = new Set<UIRegion>();
  private stats: RenderStats = {
    frames: 0,
    regionsRendered: 0,
    lastFrameMs: 0,
    maxFrameMs: 0,
    averageFrameMs: 0,
  };

  constructor(private write: (text: string) => void = process.stdout.write.bind(process.stdout)) {}

  render(region: UIRegion): void {
    this.dirty.add(region);
  }

  flush(): void {
    if (this.dirty.size === 0) return;
    const start = performance.now();
    const regions = [...this.dirty];
    this.dirty.clear();

    // In this renderer, all dirty regions are emitted in one frame.
    for (const region of regions) {
      this.stats.regionsRendered++;
      switch (region) {
        case 'message':
        case 'tool':
        case 'task-tree':
        case 'status-bar':
        case 'diff':
        case 'budget':
        case 'sidebar':
        case 'input':
        case 'all':
          break;
      }
    }

    this.write('\x1b[?25l');
    this.write('');
    this.write('\x1b[?25h');

    const elapsed = performance.now() - start;
    this.stats.frames++;
    this.stats.lastFrameMs = elapsed;
    this.stats.maxFrameMs = Math.max(this.stats.maxFrameMs, elapsed);
    this.stats.averageFrameMs =
      (this.stats.averageFrameMs * (this.stats.frames - 1) + elapsed) / this.stats.frames;
  }

  getStats(): RenderStats {
    return { ...this.stats };
  }
}
