/**
 * SISPIS — Structured Intent Scaffolding & Pragmatic Information Synthesis (Cognitive Framework 2.0)
 * 
 * Output calibration gate: determines response structure (NO_DECISION, EXPLANATION, or SCHEMA)
 * based on task entropy, decision branching, and weighted intent.
 */

export type SispisMode = 'NO_DECISION' | 'EXPLANATION' | 'SCHEMA';

export interface SispisAssessment {
  mode: SispisMode;
  entropy: number; // 0.0 - 1.0 (complexity / ambiguity)
  decisionSpace: number; // Number of competing valid approaches
  intentWeight: number; // High-stakes vs routine
  userOverride?: 'simple' | 'structured' | 'deep';
  guidance: string;
}

/**
 * Calibrates the output format and cognitive depth.
 */
export function evaluateSispis(prompt: string, upstreamSignalsWeight = 0): SispisAssessment {
  const p = prompt.toLowerCase();

  // User explicit overrides
  let userOverride: SispisAssessment['userOverride'];
  if (/\b(just tell me|keep it simple|tldr|quick answer|no fluff)\b/.test(p)) {
    userOverride = 'simple';
    return {
      mode: 'NO_DECISION',
      entropy: 0.1,
      decisionSpace: 1,
      intentWeight: 0.1,
      userOverride,
      guidance: 'Output concise, direct factual answer without structural overhead.',
    };
  }

  if (/\b(deep dive|full analysis|architectural review|comprehensive)\b/.test(p)) {
    userOverride = 'deep';
    return {
      mode: 'SCHEMA',
      entropy: 0.9,
      decisionSpace: 3,
      intentWeight: 0.9,
      userOverride,
      guidance: 'Apply 5-section decision framework: Context, Alternatives, Invariants, Execution Plan, Verification.',
    };
  }

  // Calculate Entropy
  let entropy = 0.2;
  if (/\b(how should|which is better|tradeoffs|redesign|refactor|optimize|architecture)\b/.test(p)) entropy += 0.4;
  if (/\b(complex|distributed|database|security|concurrency|race condition)\b/.test(p)) entropy += 0.3;
  if (upstreamSignalsWeight > 1.0) entropy += 0.2;

  // Calculate Decision Space
  let decisionSpace = 1;
  if (/\b(or|vs|versus|alternative|either|choice|options)\b/.test(p) || entropy > 0.6) {
    decisionSpace = 2;
  }
  if (entropy > 0.8) decisionSpace = 3;

  let mode: SispisMode = 'NO_DECISION';
  if (entropy >= 0.7 && decisionSpace >= 2) {
    mode = 'SCHEMA';
  } else if (entropy >= 0.4 || upstreamSignalsWeight >= 0.5) {
    mode = 'EXPLANATION';
  }

  const guidance =
    mode === 'SCHEMA'
      ? 'Structure response around explicit decisions: 1) Objective, 2) Tradeoffs/Options, 3) Critical Invariants, 4) Execution Steps, 5) Proof of Correctness.'
      : mode === 'EXPLANATION'
      ? 'Provide clear technical reasoning with minimal formatting overhead.'
      : 'Deliver direct, concise solution without conversational filler.';

  return {
    mode,
    entropy: Math.min(1.0, entropy),
    decisionSpace,
    intentWeight: entropy * decisionSpace,
    guidance,
  };
}
