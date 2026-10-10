// MCH-66: side index of evicted/truncated tool outputs. When shrinkOldToolOutputs
// or addMessage folding truncates a tool result, the FULL text is archived here
// (bounded ring buffer, persisted to .mochi/tool-output-archive.json). The
// recall_output tool lets the model retrieve the full original text by id
// without re-running the tool — semantic retrieval of evicted content.

import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

export interface ToolOutputArchiveEntry {
  id: string;
  tool: string;
  ts: number;
  /** Full original output text. */
  text: string;
  /** First line(s) of the output — shown in list results. */
  preview: string;
  chars: number;
}

const MAX_ENTRIES = 200;
const MAX_ENTRY_CHARS = 200_000;

/** Monotonic counter so ids sort chronologically. */
let counter = 0;

function archivePath(workspaceDir: string): string {
  return join(workspaceDir, '.mochi', 'tool-output-archive.json');
}

function loadEntries(workspaceDir: string): ToolOutputArchiveEntry[] {
  try {
    const p = archivePath(workspaceDir);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEntries(workspaceDir: string, entries: ToolOutputArchiveEntry[]): void {
  try {
    mkdirSync(join(workspaceDir, '.mochi'), { recursive: true });
    writeFileSync(archivePath(workspaceDir), JSON.stringify(entries), 'utf8');
  } catch {
    /* disk full / read-only — archive is best-effort */
  }
}

/**
 * Archive a full tool output. Call when a tool result is about to be
 * truncated or folded. Returns the archive id for the recall_output tool.
 */
export function archiveToolOutput(workspaceDir: string, tool: string, text: string): string | null {
  if (typeof text !== 'string' || text.length < 1000) return null; // not worth indexing
  const entries = loadEntries(workspaceDir);
  counter = Math.max(counter, entries.length);
  const id = `out-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  entries.push({
    id,
    tool,
    ts: Date.now(),
    text: text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS) : text,
    preview: text.slice(0, 160).replace(/\n/g, ' '),
    chars: text.length,
  });
  // Ring buffer: keep newest MAX_ENTRIES.
  while (entries.length > MAX_ENTRIES) entries.shift();
  saveEntries(workspaceDir, entries);
  return id;
}

/** Retrieve the full text of an archived output by id (prefix match ok). */
export function recallArchivedOutput(workspaceDir: string, id: string): ToolOutputArchiveEntry | null {
  const entries = loadEntries(workspaceDir);
  const hit = entries.find((e) => e.id === id) ?? entries.find((e) => e.id.startsWith(id));
  return hit ?? null;
}

/** List recent archived outputs (newest last). */
export function listArchivedOutputs(workspaceDir: string, limit = 20): ToolOutputArchiveEntry[] {
  return loadEntries(workspaceDir).slice(-limit);
}

/** Count of archived outputs (for tests / status line). */
export function archivedOutputCount(workspaceDir: string): number {
  return loadEntries(workspaceDir).length;
}

/** Remove the archive file (tests). */
export function clearArchivedOutputs(workspaceDir: string): void {
  try {
    const p = archivePath(workspaceDir);
    if (existsSync(p)) writeFileSync(p, '[]', 'utf8');
  } catch { /* ignore */ }
}
