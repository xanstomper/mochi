// Class fixture verifier for med-feature-cart-discount. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { Cart } = require('./shop/cart.js');
const { checkout } = require('./shop/checkout.js');

const c1 = new Cart();
c1.add('WIDGET', 999, 1);
eq(c1.subtotalCents(), 999, 'subtotal');
c1.applyDiscount(10);
eq(c1.discountCents(), 100, 'discount rounds half-up (99.9 -> 100)');
eq(c1.totalCents(), 899, 'total after discount');
eq(checkout(c1), ['WIDGET x1 - $9.99', 'DISCOUNT (10%): -$1.00', 'TOTAL $8.99'].join('\n'), 'receipt with discount');

const c2 = new Cart();
c2.add('A', 250, 2).add('B', 333, 1);
c2.applyDiscount(15);
eq(c2.discountCents(), 125, 'discount 833 @ 15% = 124.95 -> 125');
eq(c2.totalCents(), 708, 'total 833 - 125');
eq(checkout(c2).includes('DISCOUNT (15%): -$1.25'), true, 'receipt discount line');
eq(checkout(c2).includes('TOTAL $7.08'), true, 'receipt total line');

const c3 = new Cart();
c3.add('A', 100, 1);
eq(c3.totalCents(), 100, 'no discount: total == subtotal');
eq(checkout(c3).includes('DISCOUNT'), false, 'no discount line when inactive');
c3.applyDiscount(0);
eq(checkout(c3).includes('DISCOUNT'), false, '0% is not active');

let threw = false;
try { new Cart().applyDiscount(101); } catch (e) { threw = e instanceof RangeError; }
eq(threw, true, 'pct > 100 throws RangeError');
threw = false;
try { new Cart().applyDiscount(-5); } catch (e) { threw = e instanceof RangeError; }
eq(threw, true, 'negative pct throws RangeError');
console.log('PASS: discounts work end to end');
