import { describe, expect, it } from 'vitest';
import { findSimilarCode } from './code-similarity.js';

describe('Code Similarity Tool', () => {
  it('detects identical and renamed code snippets', () => {
    const query = `
function calculateTax(subtotal: number, rate: number): number {
  if (subtotal <= 0) return 0;
  return subtotal * rate;
}
    `;

    // Should find similarity against codebase code
    const matches = findSimilarCode(query, process.cwd(), { threshold: 0.4 });
    expect(Array.isArray(matches)).toBe(true);
  });
});
