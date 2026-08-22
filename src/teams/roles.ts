import type { AgentProfile, AgentRole, ModelProfile } from '../types.js';

const ROLES: Record<AgentRole, AgentProfile> = {
  lead: {
    role: 'lead',
    name: 'Lead',
    defaultModel: 'reasoning',
    tools: ['read', 'search', 'glob', 'git', 'inspect', 'chameleon', 'fetch', 'web_search', 'web_crawl', 'think'],
    systemPrompt: `You are the Lead agent. Do not write code. Your job is to decompose goals, prioritize tasks, coordinate other agents, resolve conflicts, evaluate results, and re-plan when progress stalls.`,
  },
  coder: {
    role: 'coder',
    name: 'Coder',
    defaultModel: 'coding',
    tools: ['read', 'write', 'edit', 'delete', 'patch', 'shell', 'search', 'glob', 'git', 'inspect', 'chameleon', 'fetch', 'web_search', 'web_crawl', 'think', 'diff', 'tree'],
    systemPrompt: `You are a Coder agent. Write clean, minimal code. Prefer surgical edits: one precise edit for a single change, one patch call for multi-file changes, full writes only for new files. Run tests/build/typecheck after changes. For multi-step work, track progress with the todo tool; delegate large self-contained subtasks to a subagent.`,
  },
  reviewer: {
    role: 'reviewer',
    name: 'Reviewer',
    defaultModel: 'review',
    tools: ['read', 'search', 'glob', 'git', 'inspect'],
    systemPrompt: `You are a Reviewer agent. Inspect diffs, verify acceptance criteria, catch regressions, and request changes. Do not edit files.`,
  },
  tester: {
    role: 'tester',
    name: 'Tester',
    defaultModel: 'fast',
    tools: ['read', 'search', 'glob', 'shell', 'inspect'],
    systemPrompt: `You are a Tester agent. Run tests, reproduce failures, and report concise results. Do not write production code.`,
  },
  researcher: {
    role: 'researcher',
    name: 'Researcher',
    defaultModel: 'fast',
    tools: ['read', 'search', 'glob', 'get_function', 'find_callers', 'type_hierarchy', 'inspect', 'fetch', 'web_search', 'web_crawl', 'think'],
    systemPrompt: `You are a Researcher agent. Explore the codebase, find relevant files, summarize findings, and report minimal useful context. You have no edit tools; report findings, do not change code.`,
  },
  debugger: {
    role: 'debugger',
    name: 'Debugger',
    defaultModel: 'reasoning',
    tools: ['read', 'search', 'glob', 'get_function', 'find_callers', 'type_hierarchy', 'inspect', 'shell'],
    systemPrompt: `You are a Debugger agent. Trace errors, reproduce issues, identify root causes, and propose minimal fixes. Form one hypothesis at a time and test it before moving on.`,
  },
  security: {
    role: 'security',
    name: 'Security',
    defaultModel: 'reasoning',
    tools: ['read', 'search', 'glob', 'inspect'],
    systemPrompt: `You are a Security agent. Review code for vulnerabilities, unsafe input handling, credential leaks, and insecure defaults.`,
  },
  architect: {
    role: 'architect',
    name: 'Architect',
    defaultModel: 'reasoning',
    tools: ['read', 'search', 'glob', 'inspect', 'get_function', 'find_callers', 'type_hierarchy', 'chameleon'],
    systemPrompt: `You are an Architect agent. Design coherent changes, define interfaces, and ensure the implementation matches the design.`,
  },
};

export function getProfile(role: AgentRole): AgentProfile {
  return ROLES[role];
}

export function listRoles(): AgentRole[] {
  return Object.keys(ROLES) as AgentRole[];
}
