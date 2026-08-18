import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MemoryEntry {
  kind: 'decision' | 'architecture' | 'convention' | 'failure';
  title: string;
  body: string;
  source?: string;
  updatedAt: number;
}

function entryToMarkdown(e: MemoryEntry): string {
  const lines = [
    `## ${e.kind}: ${e.title}`,
    e.body,
    e.source ? `Source: ${e.source}` : null,
    `Updated: ${new Date(e.updatedAt).toISOString()}`,
  ].filter(Boolean);
  return lines.join('\n') + '\n';
}

export class MemoryStore {
  private dir: string;
  private files: Record<MemoryEntry['kind'], string>;

  constructor(workspaceDir: string) {
    this.dir = resolve(workspaceDir, 'memory');
    this.files = {
      decision: resolve(this.dir, 'decisions.md'),
      architecture: resolve(this.dir, 'architecture.md'),
      convention: resolve(this.dir, 'conventions.md'),
      failure: resolve(this.dir, 'failures.md'),
    };
  }

  ensure() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    for (const file of Object.values(this.files)) {
      if (!existsSync(file)) writeFileSync(file, '');
    }
  }

  add(entry: Omit<MemoryEntry, 'updatedAt'> & { updatedAt?: number }) {
    this.ensure();
    const file = this.files[entry.kind];
    const normalized: MemoryEntry = {
      ...entry,
      updatedAt: entry.updatedAt ?? Date.now(),
    };
    const existing = readFileSync(file, 'utf8');
    const header = `## ${entry.kind}: ${entry.title}`;
    if (existing.includes(header)) return false;
    writeFileSync(file, existing + entryToMarkdown(normalized));
    return true;
  }

  addDecision(title: string, body: string, source?: string) {
    return this.add({ kind: 'decision', title, body, source });
  }

  addArchitecture(title: string, body: string, source?: string) {
    return this.add({ kind: 'architecture', title, body, source });
  }

  addConvention(title: string, body: string, source?: string) {
    return this.add({ kind: 'convention', title, body, source });
  }

  addFailure(title: string, body: string, source?: string) {
    return this.add({ kind: 'failure', title, body, source });
  }

  load(kind?: MemoryEntry['kind']): string {
    this.ensure();
    const kinds = kind ? [kind] : (Object.keys(this.files) as MemoryEntry['kind'][]);
    const sections = kinds
      .map((k) => {
        const file = this.files[k];
        if (!existsSync(file)) return '';
        const content = readFileSync(file, 'utf8').trim();
        return content ? `# ${k}s\n${content}` : '';
      })
      .filter(Boolean);
    const projectPath = resolve(this.dir, '..', 'project.md');
    if (!kind && existsSync(projectPath)) {
      const project = readFileSync(projectPath, 'utf8').trim();
      if (project) sections.unshift(project);
    }
    return sections.join('\n\n');
  }

  summary(): string {
    return this.load().split('\n').slice(0, 80).join('\n');
  }
}
