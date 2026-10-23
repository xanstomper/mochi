const { format } = require('./money.js');

// Render a plain-text receipt for the cart.
function checkout(cart) {
  const lines = cart.items.map(
    (i) => `${i.sku} x${i.qty} - ${format(i.priceCents * i.qty)}`,
  );
  lines.push(`TOTAL ${format(cart.subtotalCents())}`);
  return lines.join('\n');
}
module.exports = { checkout };
