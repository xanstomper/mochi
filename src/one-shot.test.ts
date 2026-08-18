import { describe, it, expect } from 'vitest';
import { classifyOneShot } from './one-shot.js';

describe('one-shot fast-path classifier', () => {
  it('routes pure knowledge questions to a direct answer', () => {
    const r = classifyOneShot({
      title: 'Explain how quicksort works',
      description: 'Give a concise explanation of quicksort.',
      acceptanceCriteria: [],
    });
    expect(r.kind).toBe('answer');
    expect(r.suggests).toContain('one turn');
  });

  it('routes summarize tasks to a single short-read path', () => {
    const r = classifyOneShot({
      title: 'Summarize the main module',
      description: 'What does src/agent/loop.ts do?',
      acceptanceCriteria: [],
    });
    expect(r.kind).toBe('summarize');
    expect(r.suggests).toContain('Summarize');
  });

  it('refuses tasks that need to write code', () => {
    const r = classifyOneShot({
      title: 'Add authentication to the API',
      description: 'Create a login endpoint and middleware.',
      acceptanceCriteria: ['login works'],
      verificationCommand: 'npm test',
    });
    expect(r.kind).toBe('not_one_shot');
    expect(r.suggests).toBeNull();
  });

  it('refuses when acceptance criteria are present even if phrased as a question', () => {
    const r = classifyOneShot({
      title: 'Explain the bug',
      description: 'Why does it crash?',
      acceptanceCriteria: ['test passes'],
    });
    expect(r.kind).toBe('not_one_shot');
  });

  it('routes short utterance commands like "say hello" to a direct answer', () => {
    const r = classifyOneShot({
      title: 'Say hello in exactly 3 words',
      description: 'Say hello in exactly 3 words.',
      acceptanceCriteria: [],
    });
    expect(r.kind).toBe('answer');
    expect(r.suggests).toContain('one turn');
  });

  it('does not route a real coding command that mentions creating a file', () => {
    const r = classifyOneShot({
      title: 'Create a hello program',
      description: 'Create a hello file that prints.',
      acceptanceCriteria: [],
    });
    expect(r.kind).toBe('not_one_shot');
  });

  it('refuses neutral tasks that are not questions (no marker)', () => {
    const r = classifyOneShot({
      title: 'Project setup',
      description: 'Initialize the repository layout.',
      acceptanceCriteria: [],
    });
    expect(r.kind).toBe('not_one_shot');
  });
});