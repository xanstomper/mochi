import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { estimateCostUsd } from './budget.js';

export interface UsageRecord {
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolCalls: number;
  durationMs: number;
}

export interface UsageEntry {
  model: string;
  goal: string;
  usage: UsageRecord;
}

export interface UsageStoreData {
  entries: UsageEntry[];
}

export class UsageStore {
  private path: string;
  private data: UsageStoreData;

  constructor(workspaceDir: string) {
    const dir = resolve(workspaceDir, 'state');
    this.path = resolve(dir, 'usage.json');
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
        this.data = { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
      } catch {
        this.data = { entries: [] };
      }
    } else {
      this.data = { entries: [] };
    }
  }

  private save() {
    const dir = resolve(this.path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  record(model: string, goal: string, usage: Partial<UsageRecord>): void {
    this.data.entries.push({
      model,
      goal,
      usage: {
        modelCalls: usage.modelCalls ?? 0,
        tokensIn: usage.tokensIn ?? 0,
        tokensOut: usage.tokensOut ?? 0,
        costUsd: usage.costUsd ?? estimateCostUsd(usage.tokensOut ?? 0, model),
        toolCalls: usage.toolCalls ?? 0,
        durationMs: usage.durationMs ?? 0,
      },
    });
    if (this.data.entries.length > 500) {
      this.data.entries.splice(0, this.data.entries.length - 500);
    }
    this.save();
  }

  total(): UsageRecord {
    const t: UsageRecord = { modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, toolCalls: 0, durationMs: 0 };
    for (const e of this.data.entries) {
      t.modelCalls += e.usage.modelCalls;
      t.tokensIn += e.usage.tokensIn;
      t.tokensOut += e.usage.tokensOut;
      t.costUsd += e.usage.costUsd;
      t.toolCalls += e.usage.toolCalls;
      t.durationMs += e.usage.durationMs;
    }
    return t;
  }

  summary(): string {
    const t = this.total();
    return [
      `model calls: ${t.modelCalls}`,
      `tokens in:   ${t.tokensIn.toLocaleString()}`,
      `tokens out:  ${t.tokensOut.toLocaleString()}`,
      `cost:        $${t.costUsd.toFixed(4)}`,
      `tool calls:  ${t.toolCalls}`,
      `time:        ${(t.durationMs / 1000).toFixed(1)}s`,
    ].join('\n');
  }

  recent(n = 5): string {
    const recent = this.data.entries.slice(-n).reverse();
    if (recent.length === 0) return 'No usage recorded yet.';
    return recent.map((e) => `[${e.model}] ${e.goal}: ${e.usage.costUsd.toFixed(4)} / ${e.usage.tokensOut} tokens`).join('\n');
  }
}