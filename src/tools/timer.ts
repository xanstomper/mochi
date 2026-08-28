// Native tool: timer
// Named stopwatches for performance profiling agent tasks within a session.

import type { Tool } from './types.js';

interface TimerEntry { start: number; laps: number[]; stopped?: number }
const TIMERS = new Map<string, TimerEntry>();

export const timerTool: Tool = {
  def: {
    name: 'timer',
    description: 'Start, stop, lap, reset, or list named stopwatches. Useful for profiling task durations.',
    parameters: [
      { name: 'action', type: 'string', description: "'start' | 'stop' | 'lap' | 'reset' | 'list'", required: true },
      { name: 'name', type: 'string', description: 'Timer name (required for all actions except list)', required: false },
    ],
    permission: 'read',
  },
  async execute(args) {
    const action = String(args.action || '').toLowerCase();
    const name = args.name ? String(args.name) : undefined;

    if (action === 'list') {
      if (!TIMERS.size) return 'No active timers.';
      return [...TIMERS.entries()].map(([n, t]) => {
        const elapsed = t.stopped ?? Date.now();
        const ms = elapsed - t.start;
        const lapsStr = t.laps.length ? `  laps: [${t.laps.map(l => `${l}ms`).join(', ')}]` : '';
        return `${n}: ${ms}ms ${t.stopped ? '(stopped)' : '(running)'}${lapsStr}`;
      }).join('\n');
    }

    if (!name) throw new Error('name parameter is required for action: ' + action);

    switch (action) {
      case 'start': {
        TIMERS.set(name, { start: Date.now(), laps: [] });
        return `Timer "${name}" started.`;
      }
      case 'stop': {
        const t = TIMERS.get(name);
        if (!t) return `Timer "${name}" not found.`;
        t.stopped = Date.now();
        return `Timer "${name}" stopped: ${t.stopped - t.start}ms`;
      }
      case 'lap': {
        const t = TIMERS.get(name);
        if (!t) return `Timer "${name}" not found.`;
        const lap = Date.now() - t.start;
        t.laps.push(lap);
        return `Lap ${t.laps.length} for "${name}": ${lap}ms`;
      }
      case 'reset': {
        TIMERS.delete(name);
        return `Timer "${name}" reset.`;
      }
      default:
        throw new Error(`Unknown timer action: ${action}. Use start|stop|lap|reset|list.`);
    }
  },
};
