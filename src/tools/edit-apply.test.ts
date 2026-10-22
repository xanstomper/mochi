// tools/edit-apply.ts: the strategy ladder — exact → normalized → relaxed →
// anchored — with uniqueness proofs, conflation refusal, and near-miss
// diagnostics on failure.
import { describe, it, expect } from 'vitest';
import { applyEdit } from './edit-apply.js';

const CHECKOUT_HEAD = 'export function checkout(cart: Cart): number {';
const CHECKOUT_TAIL = '  return chargeCard(total, cart.payment);';

describe('applyEdit strategy ladder', () => {
  it('applies an exact unique match and records one attempt', () => {
    const res = applyEdit('const a = 1;\nconst b = 2;\n', 'a = 1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strategy).toBe('exact');
      expect(res.attempts).toHaveLength(1);
    }
  });

  it('reports exact ambiguity with candidate sites instead of guessing', () => {
    const res = applyEdit('const v = 1;\nconst v = 2;\n', 'const v =');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failureKind).toBe('ambiguous');
      expect(res.sites.map((s) => s.startLine)).toEqual([1, 2]);
    }
  });

  it('applies whitespace drift via the normalized strategy', () => {
    const res = applyEdit('function x() {\n    return 1;\n}\n', '  function x() {\n    return 1;\n  }');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.strategy).toBe('normalized');
  });

  it('applies quote drift via the relaxed strategy', () => {
    // Short lines with dense drift (quote change + dropped semicolon on
    // every line) sit below the tolerant stage's per-line similarity
    // threshold, so the classification must come from the relaxed scan.
    const res = applyEdit(
      'a = "x";\nb = "y";\nc = "z";\n',
      "a = 'x'\nb = 'y'\nc = 'z'",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.strategy).toBe('relaxed');
  });

  it('anchored: applies when middle lines went stale but anchors hold', () => {
    const content = [
      CHECKOUT_HEAD,
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      CHECKOUT_TAIL,
      '}',
      '',
    ].join('\n');
    const needle = [
      CHECKOUT_HEAD,
      '  const subtotal = price * qty;',
      '  const total = subtotal - discount;',
      CHECKOUT_TAIL,
      '}',
    ].join('\n');
    const res = applyEdit(content, needle);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strategy).toBe('anchored');
      expect(content.slice(res.start, res.end)).toContain('applyDiscount');
    }
  });

  it('anchored: tolerates a line inserted inside the block (span grows)', () => {
    const content = [
      CHECKOUT_HEAD,
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      "  log('checkout', cart.id);",
      '  const total = applyDiscount(subtotal, cart.coupon);',
      CHECKOUT_TAIL,
      '}',
      '',
    ].join('\n');
    const needle = [
      CHECKOUT_HEAD,
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      CHECKOUT_TAIL,
      '}',
    ].join('\n');
    const res = applyEdit(content, needle);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strategy).toBe('anchored');
      // The replaced span covers the inserted line too.
      expect(content.slice(res.start, res.end)).toContain("log('checkout'");
    }
  });

  it('anchored: tolerates a line deleted from the block (span shrinks)', () => {
    const content = [
      CHECKOUT_HEAD,
      '  const total = applyDiscount(subtotal, cart.coupon);',
      CHECKOUT_TAIL,
      '}',
      '',
    ].join('\n');
    const needle = [
      CHECKOUT_HEAD,
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      CHECKOUT_TAIL,
      '}',
    ].join('\n');
    const res = applyEdit(content, needle);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.strategy).toBe('anchored');
  });

  it('anchored: refuses a conflated needle whose line lives verbatim in a twin function', () => {
    const content = [
      'export function priceRetail(item: Item): number {',
      '  const base = item.cost * 1.4;',
      '  const taxed = base * TAX_RATE;',
      '  return round2(taxed);',
      '}',
      'export function priceWholesale(item: Item): number {',
      '  const base = item.cost * 1.15;',
      '  const taxed = base * TAX_RATE;',
      '  return round2(taxed);',
      '}',
      '',
    ].join('\n');
    const needle = [
      'export function priceWholesale(item: Item): number {',
      '  const base = item.cost * 1.4;', // retail's margin, inside wholesale's block
      '  const taxed = base * TAX_RATE;',
      '  return round2(applyMemberDiscount(taxed));',
      '}',
    ].join('\n');
    const res = applyEdit(content, needle);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failureKind).toBe('ambiguous');
      expect(res.note).toMatch(/verbatim at line 2/);
    }
  });

  it('anchored: refuses when two regions match equally well', () => {
    const block = [
      'function handler(req: Req): void {',
      '  const data = parseBody(req);',
      '  save(data);',
      '}',
    ].join('\n');
    const content = `${block}\n${block}\n`;
    const needle = [
      'function handler(req: Req): void {',
      '  const data = parseBodyOld(req);',
      '  save(data);',
      '}',
    ].join('\n');
    const res = applyEdit(content, needle);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failureKind).toBe('ambiguous');
  });

  it('not-found carries near misses with the first diverging line', () => {
    // Every needle line differs from its counterpart (renamed function,
    // renamed variable, changed body) — below even the tolerant stage's
    // threshold when several lines drift at once, and the first/last
    // lines are not verbatim anchors.
    const content = [
      'export function alpha(input: number): number {',
      '  const doubled = input * 2;',
      '  return doubled + 1;',
      '}',
      '',
    ].join('\n');
    const needle = [
      'export function beta(value: string): string {',
      '  const parsed = parseInput(value);',
      '  return renderOutput(parsed);',
      '}',
    ].join('\n');
    const res = applyEdit(content, needle);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failureKind).toBe('not-found');
      expect(res.nearMisses.length).toBeGreaterThan(0);
      expect(res.nearMisses[0].startLine).toBe(1);
      expect(res.nearMisses[0].divergence?.needleLine).toBe(1);
      expect(res.nearMisses[0].divergence?.expected).toContain('beta');
      expect(res.nearMisses[0].divergence?.actual).toContain('alpha');
      expect(res.attempts.map((a) => a.strategy)).toEqual(['exact', 'normalized', 'relaxed', 'anchored']);
    }
  });

  it('anchored: applies when the first (anchor) line itself drifted, via interior anchors', () => {
    // The needle's first line carries a transposed-letter typo, so it is
    // not a verbatim anchor anywhere. A twin function with a similar shape
    // keeps the legacy tolerant stage out (its margin rule sees two good
    // windows); unique interior lines must anchor the span instead.
    const content = [
      'export function computeTotalPrice(items: Item[]): number {',
      '  const total = items.reduce(sumPrices, 0);',
      '  return total;',
      '}',
      'export function computeTotalPriceV2(items: Item[]): number {',
      '  const total = items.reduce(sumPricesV2, 0);',
      '  return total * 2;',
      '}',
      '',
    ].join('\n');
    const needle = [
      'export function computeTotalPirce(items: Item[]): number {',
      '  const total = items.reduce(sumPrices, 0);',
      '  return total;',
      '}',
    ].join('\n');
    const res = applyEdit(content, needle);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strategy).toBe('anchored');
      expect(content.slice(res.start, res.end)).toContain('computeTotalPrice(items');
      expect(content.slice(res.start, res.end)).not.toContain('V2');
    }
  });

  it('anchored single-line: a heavily drifted line is refused, with the true line as near miss', () => {
    const content = 'const a = computeAlpha();\nconst b = computeBeta();\nreturn finalize(a, b);\n';
    const res = applyEdit(content, 'return finalize(a, b, extra);');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failureKind).toBe('not-found');
      expect(res.nearMisses[0]?.startLine).toBe(3);
    }
  });
});
