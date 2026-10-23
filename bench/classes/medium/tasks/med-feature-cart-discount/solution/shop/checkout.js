const { format } = require('./money.js');

// Render a plain-text receipt for the cart.
function checkout(cart) {
  const lines = cart.items.map(
    (i) => `${i.sku} x${i.qty} - ${format(i.priceCents * i.qty)}`,
  );
  if (cart.discountPct > 0) {
    lines.push(`DISCOUNT (${cart.discountPct}%): -${format(cart.discountCents())}`);
  }
  lines.push(`TOTAL ${format(cart.totalCents())}`);
  return lines.join('\n');
}
module.exports = { checkout };
