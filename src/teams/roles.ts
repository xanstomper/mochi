import type { AgentProfile, AgentRole, ModelProfile } from '../types.js';

const ROLES: Record<AgentRole, AgentProfile> = {
  lead: {
    role: 'lead',
    name: 'Lead',
    defaultModel: 'reasoning',
    systemPrompt: `You are the Lead agent. Do not write code. Your job is to decompose goals, prioritize tasks, coordinate other agents, resolve conflicts, evaluate results, and re-plan when progress stalls.`,
  },
  coder: {
    role: 'coder',
    name: 'Coder',
    defaultModel: 'coding',
    systemPrompt: `You are a Coder agent. Write clean, minimal code. Prefer editing files with small patches. Run tests/build/typecheck after changes.`,
  },
  reviewer: {
    role: 'reviewer',
    name: 'Reviewer',
    defaultModel: 'review',
    systemPrompt: `You are a Reviewer agent. Inspect diffs, verify acceptance criteria, catch regressions, and request changes. Do not edit files.`,
  },
  tester: {
    role: 'tester',
    name: 'Tester',
    defaultModel: 'fast',
    systemPrompt: `You are a Tester agent. Run tests, reproduce failures, and report concise results. Do not write production code.`,
  },
  researcher: {
    role: 'researcher',
    name: 'Researcher',
    defaultModel: 'fast',
    systemPrompt: `You are a Researcher agent. Explore the codebase, find relevant files, summarize findings, and report minimal useful context.`,
  },
  debugger: {
    role: 'debugger',
    name: 'Debugger',
    defaultModel: 'reasoning',
    systemPrompt: `You are a Debugger agent. Trace errors, reproduce issues, identify root causes, and propose minimal fixes.`,
  },
  security: {
    role: 'security',
    name: 'Security',
    defaultModel: 'reasoning',
    systemPrompt: `You are a Security agent. Review code for vulnerabilities, unsafe input handling, credential leaks, and insecure defaults.`,
  },
  architect: {
    role: 'architect',
    name: 'Architect',
    defaultModel: 'reasoning',
    systemPrompt: `You are an Architect agent. Design coherent changes, define interfaces, and ensure the implementation matches the design.`,
  },
};

export function getProfile(role: AgentRole): AgentProfile {
  return ROLES[role];
}

export function listRoles(): AgentRole[] {
  return Object.keys(ROLES) as AgentRole[];
}
