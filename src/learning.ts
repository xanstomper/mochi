import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RecoveryRecord {
  pattern: string;
  strategy: string;
  attempts: number;
  successes: number;
}

export interface LearningState {
  records: RecoveryRecord[];
}

export const KNOWN_PATTERNS: { id: string; regex: RegExp; strategy: string }[] = [
  { id: 'TS2345', regex: /TS2345/i, strategy: 'Inspect inferred type, locate the expected interface, update the caller, rerun typecheck.' },
  { id: 'MODULE_NOT_FOUND', regex: /Cannot find module|MODULE_NOT_FOUND/i, strategy: 'Check import path, package install state, and tsconfig paths.' },
  { id: 'TEST_FAILURE', regex: /(test|spec).*(fail)|AssertionError/i, strategy: 'Read the first failing assertion, reproduce locally, fix the smallest failing behavior.' },
  { id: 'TIMEOUT', regex: /timeout|timed out/i, strategy: 'Identify blocking call, add timeout or cancellation, rerun with verbose output.' },
  { id: 'NETWORK', regex: /ECONNREFUSED|ENOTFOUND|network/i, strategy: 'Verify service availability, credentials, and retry policy.' },
];

export function classifyFailure(error: string): RecoveryRecord | undefined {
  for (const pattern of KNOWN_PATTERNS) {
    if (pattern.regex.test(error)) {
      return { pattern: pattern.id, strategy: pattern.strategy, attempts: 0, successes: 0 };
    }
  }
  return undefined;
}

export class LearningStore {
  private path: string;
  private state: LearningState;

  constructor(workspaceDir: string) {
    const dir = resolve(workspaceDir, 'state');
    this.path = resolve(dir, 'learning.json');
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
        this.state = { records: Array.isArray(parsed.records) ? parsed.records : [] };
      } catch {
        this.state = { records: [] };
      }
    } else {
      this.state = { records: [] };
    }
  }

  private save() {
    const dir = resolve(this.path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  private find(pattern: string, strategy: string): RecoveryRecord | undefined {
    return this.state.records.find((r) => r.pattern === pattern && r.strategy === strategy);
  }

  record(pattern: string, strategy: string, success: boolean) {
    const record = this.find(pattern, strategy);
    if (!record) {
      this.state.records.push({ pattern, strategy, attempts: 1, successes: success ? 1 : 0 });
    } else {
      record.attempts++;
      if (success) record.successes++;
    }
    this.save();
  }

  successRate(pattern: string, strategy: string): number {
    const record = this.find(pattern, strategy);
    if (!record || record.attempts === 0) return 0;
    return record.successes / record.attempts;
  }

  bestStrategy(pattern: string): RecoveryRecord | undefined {
    const records = this.state.records.filter((r) => r.pattern === pattern && r.attempts > 0);
    if (records.length === 0) return undefined;
    return records.sort((a, b) => this.successRate(b.pattern, b.strategy) - this.successRate(a.pattern, a.strategy))[0];
  }

  knownStrategies(): RecoveryRecord[] {
    return this.state.records.filter((r) => r.attempts > 0 && r.successes > 0);
  }
}
