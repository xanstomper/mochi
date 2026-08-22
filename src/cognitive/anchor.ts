/**
 * ANCHOR — Operational Persistence System (Cognitive Framework 2.0)
 * 
 * Preserves execution continuity across turns, context compression, and tool loops.
 * Prevents operational drift, state corruption, and lost conclusions.
 */

export type EpistemicClass = 'Verified' | 'Observed' | 'Inferred' | 'Speculative' | 'Unknown';

export interface EpistemicClaim {
  id: string;
  claim: string;
  classification: EpistemicClass;
  source?: string;
  verifiedAt?: number;
}

export interface OperationalCheckpoint {
  id: string;
  timestamp: number;
  facts: string[];
  assumptions: string[];
  hypotheses: string[];
  unknowns: string[];
  blocked: string[];
  rejectedApproaches: string[];
  decisions: string[];
  openTasks: string[];
}

export class AnchorEngine {
  private claims: Map<string, EpistemicClaim> = new Map();
  private checkpoints: OperationalCheckpoint[] = [];
  private rejected: Set<string> = new Set();
  private claimCounter = 0;

  /**
   * Records or updates a claim with strict epistemic classification.
   */
  recordClaim(text: string, classification: EpistemicClass, source?: string): EpistemicClaim {
    const id = `EC-${++this.claimCounter}`;
    const claim: EpistemicClaim = {
      id,
      claim: text,
      classification,
      source,
      verifiedAt: classification === 'Verified' ? Date.now() : undefined,
    };
    this.claims.set(id, claim);
    return claim;
  }

  /**
   * Promotes an inferred claim to verified based on evidence.
   */
  verifyClaim(id: string, evidence: string): boolean {
    const c = this.claims.get(id);
    if (!c) return false;
    c.classification = 'Verified';
    c.source = evidence;
    c.verifiedAt = Date.now();
    return true;
  }

  /**
   * Records a failed or rejected approach so the agent never repeats it.
   */
  rejectApproach(approach: string, reason: string): void {
    this.rejected.add(`${approach} (Reason: ${reason})`);
  }

  isApproachRejected(approach: string): boolean {
    return [...this.rejected].some((r) => r.toLowerCase().includes(approach.toLowerCase()));
  }

  /**
   * Creates a graduated state checkpoint.
   */
  createCheckpoint(data: Partial<OperationalCheckpoint> = {}): OperationalCheckpoint {
    const cp: OperationalCheckpoint = {
      id: `CP-${this.checkpoints.length + 1}`,
      timestamp: Date.now(),
      facts: data.facts ?? [],
      assumptions: data.assumptions ?? [],
      hypotheses: data.hypotheses ?? [],
      unknowns: data.unknowns ?? [],
      blocked: data.blocked ?? [],
      rejectedApproaches: [...this.rejected, ...(data.rejectedApproaches ?? [])],
      decisions: data.decisions ?? [],
      openTasks: data.openTasks ?? [],
    };
    this.checkpoints.push(cp);
    return cp;
  }

  /**
   * Renders compact ANCHOR continuity context for prompt injection.
   */
  renderContinuityContext(): string {
    const lines: string[] = ['# ANCHOR State Continuity'];

    if (this.rejected.size > 0) {
      lines.push('## Rejected Approaches (Do Not Retry):');
      for (const r of this.rejected) lines.push(`- [REJECTED] ${r}`);
    }

    const verified = [...this.claims.values()].filter((c) => c.classification === 'Verified');
    if (verified.length > 0) {
      lines.push('## Verified Facts:');
      for (const v of verified) lines.push(`- [VERIFIED] ${v.claim} (${v.source || 'test'})`);
    }

    const inferred = [...this.claims.values()].filter((c) => c.classification === 'Inferred');
    if (inferred.length > 0) {
      lines.push('## Working Inferences (Require Validation):');
      for (const inf of inferred) lines.push(`- [INFERRED] ${inf.claim}`);
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }
}
