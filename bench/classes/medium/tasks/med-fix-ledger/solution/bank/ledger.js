const accounts = require('./accounts.js');
const { feeFor } = require('./fees.js');

// transfer(from, to, amountCents): the sender pays amount + fee, the
// receiver gains amount, the fee is burned.
function transfer(from, to, amountCents) {
  const fee = feeFor(amountCents);
  accounts.debit(from, amountCents + fee);
  accounts.credit(to, amountCents);
}
module.exports = { transfer };
