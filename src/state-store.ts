import type { UIRegion } from './stream-events.js';

type Listener = () => void;

export class StateStore<T extends Record<string, unknown>> {
  private state: T;
  private hotKeys = new Set<string>();
  private dirtyRegions = new Set<UIRegion>();
  private regionListeners = new Map<UIRegion, Listener[]>();
  private allListeners: Listener[] = [];
  private writes = 0;
  private notifications = 0;

  constructor(initial: T) {
    this.state = initial;
  }

  markHot(key: keyof T & string): void {
    this.hotKeys.add(key);
  }

  get<K extends keyof T & string>(key: K): T[K] {
    return this.state[key];
  }

  set<K extends keyof T & string>(key: K, value: T[K], region: UIRegion): void {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.writes++;
    this.dirtyRegions.add(region);
  }

  subscribeRegion(region: UIRegion, listener: Listener): () => void {
    const list = this.regionListeners.get(region) ?? [];
    list.push(listener);
    this.regionListeners.set(region, list);
    return () => {
      const current = this.regionListeners.get(region);
      if (!current) return;
      const i = current.indexOf(listener);
      if (i >= 0) current.splice(i, 1);
    };
  }

  subscribeAll(listener: Listener): () => void {
    this.allListeners.push(listener);
    return () => {
      const i = this.allListeners.indexOf(listener);
      if (i >= 0) this.allListeners.splice(i, 1);
    };
  }

  getDirty(): UIRegion[] {
    return [...this.dirtyRegions];
  }

  isDirty(region: UIRegion): boolean {
    return this.dirtyRegions.has(region);
  }

  flush(): void {
    const regions = [...this.dirtyRegions];
    this.dirtyRegions.clear();
    if (regions.length === 0) return;
    for (const region of regions) {
      const listeners = this.regionListeners.get(region);
      if (!listeners) continue;      for (const listener of listeners) {
        this.notifications++;
        listener();
      }
    }
    for (const listener of this.allListeners) {
      this.notifications++;
      listener();
    }
  }

  snapshot(): T {
    return this.state;
  }

  getStats() {
    return {
      writes: this.writes,
      notifications: this.notifications,
      hotKeys: this.hotKeys.size,
    };
  }
}
