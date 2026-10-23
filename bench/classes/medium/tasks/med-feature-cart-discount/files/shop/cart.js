class Cart {
  constructor() {
    this.items = [];
  }
  add(sku, priceCents, qty = 1) {
    this.items.push({ sku, priceCents, qty });
    return this;
  }
  subtotalCents() {
    return this.items.reduce((s, i) => s + i.priceCents * i.qty, 0);
  }
}
module.exports = { Cart };
