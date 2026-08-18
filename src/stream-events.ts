export type CompactEvent =
  | { type: 'text-delta'; messageId: string; text: string }
  | { type: 'tool-start'; messageId: string; toolCallId: string; name: string }
  | { type: 'tool-delta'; toolCallId: string; delta: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: 'finish'; reason: string }
  | { type: 'error'; message: string };

export type UIRegion =
  | 'message'
  | 'tool'
  | 'task-tree'
  | 'status-bar'
  | 'diff'
  | 'budget'
  | 'sidebar'
  | 'input'
  | 'all';

export interface DirtySet {
  regions: Set<UIRegion>;
  mark(region: UIRegion): void;
  clear(): void;
  has(region: UIRegion): boolean;
  isEmpty(): boolean;
}

export function createDirtySet(): DirtySet {
  const regions = new Set<UIRegion>();
  return {
    regions,
    mark(region) {
      regions.add(region);
    },
    clear() {
      regions.clear();
    },
    has(region) {
      return regions.has(region);
    },
    isEmpty() {
      return regions.size === 0;
    },
  };
}
