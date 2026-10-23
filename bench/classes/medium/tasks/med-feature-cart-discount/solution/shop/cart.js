class Cart {
  constructor() {
    this.items = [];
    this.discountPct = 0;
  }
  add(sku, priceCents, qty = 1) {
    this.items.push({ sku, priceCents, qty });
    return this;
  }
  subtotalCents() {
    return this.items.reduce((s, i) => s + i.priceCents * i.qty, 0);
  }
  applyDiscount(pct) {
    if (typeof pct !== 'number' || Number.isNaN(pct) || pct < 0 || pct > 100) {
      throw new RangeError(`discount pct out of range: ${pct}`);
    }
    this.discountPct = pct;
    return this;
  }
  discountCents() {
    if (this.discountPct <= 0) return 0;
    // Round half-up (amounts are non-negative, so Math.round is half-up).
    return Math.round((this.subtotalCents() * this.discountPct) / 100);
  }
  totalCents() {
    return this.subtotalCents() - this.discountCents();
  }
}
module.exports = { Cart };
