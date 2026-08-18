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
    const entries = this.entries(kind);
    if (!kind) {
      // Preserve legacy grouping: `# <kind>s` section headers.
      const sections: string[] = [];
      for (const k of Object.keys(this.files) as MemoryEntry['kind'][]) {
        const group = entries.filter((e) => e.kind === k);
        if (group.length) sections.push(`# ${k}s\n` + group.map((e) => entryToMarkdown(e)).join('\n').trim());
      }
      const project = entries.find((e) => e.source === 'project.md');
      if (sections.length === 0 && project) sections.unshift(project.body);
      return sections.join('\n\n');
    }
    return entries.map((e) => entryToMarkdown(e)).join('\n').trim();
  }

  /** Return the individual memory entries (plus the optional project.md blurb).
   *  Index-based so callers can select a subset of *relevant* entries rather than
   *  dumping every memory into every packet. */
  entries(kind?: MemoryEntry['kind']): MemoryEntry[] {
    this.ensure();
    const kinds = kind ? [kind] : (Object.keys(this.files) as MemoryEntry['kind'][]);
    const result: MemoryEntry[] = [];
    for (const k of kinds) {
      const file = this.files[k];
      if (!existsSync(file)) continue;
      const content = readFileSync(file, 'utf8');
      for (const block of content.split(/^## /m).slice(1)) {
        const lines = block.split('\n');
        const header = lines[0].trim();
        const body = lines.slice(1).filter((l) => !l.startsWith('Updated:')).join('\n').trim();
        if (!header) continue;
        result.push({ kind: k, title: header, body, updatedAt: 0 });
      }
    }
    // project.md is not a kind-category entry; emit it as a single "project"
    // blob (weighted to always be carried) so callers keep the project facts
    // alongside per-entry memories.
    const projectPath = resolve(this.dir, '..', 'project.md');
    if (!kind && existsSync(projectPath)) {
      const project = readFileSync(projectPath, 'utf8').trim();
      if (project) result.unshift({ kind: 'decision', title: 'project overview', body: project, source: 'project.md', updatedAt: 0 });
    }
    return result;
  }

  summary(): string {
    return this.load().split('\n').slice(0, 80).join('\n');
  }
}
