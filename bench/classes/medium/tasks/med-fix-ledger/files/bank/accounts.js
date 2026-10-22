// In-memory account balances (integer cents).
const balances = new Map();
function createAccount(id, openingCents) {
  balances.set(id, openingCents);
}
function balance(id) {
  if (!balances.has(id)) throw new Error(`unknown account: ${id}`);
  return balances.get(id);
}
function debit(id, cents) {
  const b = balance(id);
  if (b < cents) throw new Error(`insufficient funds in ${id}`);
  balances.set(id, b - cents);
}
function credit(id, cents) {
  balances.set(id, balance(id) + cents);
}
function reset() {
  balances.clear();
}
module.exports = { createAccount, balance, debit, credit, reset };
