// Team role profiles: per-role tool + model assignments.
import { describe, it, expect } from 'vitest';
import { getProfile, listRoles } from './roles.js';
import type { AgentRole } from '../types.js';

const NO_EDIT_ROLES: AgentRole[] = ['lead', 'reviewer', 'researcher', 'security', 'architect'];
const EDIT_ROLES: AgentRole[] = ['coder', 'debugger', 'tester', 'devops', 'db_admin', 'frontend', 'backend', 'performance', 'tech_writer', 'qa_engineer', 'data_scientist'];

describe('team roles', () => {
  it('every role resolves a profile and the roster round-trips', () => {
    const roles = listRoles();
    expect(roles.length).toBeGreaterThanOrEqual(16);
    for (const r of roles) {
      const p = getProfile(r);
      expect(p.role).toBe(r);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.systemPrompt.length).toBeGreaterThan(40);
      expect(['fast', 'coding', 'reasoning', 'review']).toContain(p.defaultModel);
    }
  });

  it('non-coding roles cannot edit files', () => {
    for (const r of NO_EDIT_ROLES) {
      const tools = getProfile(r).tools;
      expect(tools).not.toContain('write');
      expect(tools).not.toContain('edit');
      expect(tools).not.toContain('patch');
    }
  });

  it('specialist roles that produce artifacts get edit tools', () => {
    // Testers write test files; debuggers add instrumentation; the seven
    // specialist roles (devops, db_admin, …) produce code artifacts by design.
    for (const r of EDIT_ROLES) {
      const tools = getProfile(r).tools;
      expect(tools, `${r} should have edit`).toContain('edit');
    }
  });

  it('pure review roles have no shell', () => {
    expect(getProfile('reviewer').tools).not.toContain('shell');
    expect(getProfile('security').tools).not.toContain('shell');
    expect(getProfile('architect').tools).not.toContain('shell');
  });

  it('coder can edit and run the shell; reviewer stays read-only', () => {
    const coder = getProfile('coder').tools;
    expect(coder).toEqual(expect.arrayContaining(['write', 'edit', 'patch', 'shell']));
    const reviewer = getProfile('reviewer').tools;
    expect(reviewer).not.toContain('shell');
    expect(reviewer).not.toContain('write');
  });

  it('model profiles match intent: lead/debugger reason, tester is fast', () => {
    expect(getProfile('lead').defaultModel).toBe('reasoning');
    expect(getProfile('debugger').defaultModel).toBe('reasoning');
    expect(getProfile('tester').defaultModel).toBe('fast');
    expect(getProfile('coder').defaultModel).toBe('coding');
  });
});