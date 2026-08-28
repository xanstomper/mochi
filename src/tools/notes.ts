// Native tool: notes
// Persistent session scratch-pad stored in .mochi/notes.json

import type { Tool } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

interface Note { id: string; content: string; tag?: string; createdAt: number }

function notesPath(cwd: string): string {
  return join(cwd, '.mochi', 'notes.json');
}

function loadNotes(cwd: string): Note[] {
  const p = notesPath(cwd);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

function saveNotes(cwd: string, notes: Note[]): void {
  const p = notesPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(notes, null, 2));
}

function genId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export const notesTool: Tool = {
  def: {
    name: 'notes',
    description: 'Persistent session scratch-pad. Add, list, get, delete, or clear notes stored in .mochi/notes.json.',
    parameters: [
      { name: 'action', type: 'string', description: "'add' | 'list' | 'get' | 'delete' | 'clear'", required: true },
      { name: 'id', type: 'string', description: 'Note ID (for get/delete)', required: false },
      { name: 'content', type: 'string', description: 'Note content (for add)', required: false },
      { name: 'tag', type: 'string', description: 'Tag to filter by (optional)', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const action = String(args.action || '').toLowerCase();

    switch (action) {
      case 'add': {
        if (!args.content) throw new Error('content is required for action=add');
        const notes = loadNotes(ctx.cwd);
        const note: Note = { id: genId(), content: String(args.content), tag: args.tag ? String(args.tag) : undefined, createdAt: Date.now() };
        notes.push(note);
        saveNotes(ctx.cwd, notes);
        return `Note added [${note.id}]${note.tag ? ` #${note.tag}` : ''}: ${note.content.slice(0, 80)}`;
      }
      case 'list': {
        const notes = loadNotes(ctx.cwd);
        const tag = args.tag ? String(args.tag) : undefined;
        const filtered = tag ? notes.filter(n => n.tag === tag) : notes;
        if (!filtered.length) return 'No notes found.';
        return filtered.map(n => `[${n.id}]${n.tag ? ` #${n.tag}` : ''} ${n.content.slice(0, 120)}`).join('\n');
      }
      case 'get': {
        if (!args.id) throw new Error('id is required for action=get');
        const notes = loadNotes(ctx.cwd);
        const note = notes.find(n => n.id === String(args.id));
        if (!note) return `Note not found: ${args.id}`;
        return `[${note.id}]${note.tag ? ` #${note.tag}` : ''}\n${note.content}`;
      }
      case 'delete': {
        if (!args.id) throw new Error('id is required for action=delete');
        const notes = loadNotes(ctx.cwd);
        const before = notes.length;
        const filtered = notes.filter(n => n.id !== String(args.id));
        saveNotes(ctx.cwd, filtered);
        return before > filtered.length ? `Deleted note ${args.id}.` : `Note not found: ${args.id}`;
      }
      case 'clear': {
        saveNotes(ctx.cwd, []);
        return 'All notes cleared.';
      }
      default:
        throw new Error(`Unknown notes action: ${action}. Use add|list|get|delete|clear.`);
    }
  },
};
