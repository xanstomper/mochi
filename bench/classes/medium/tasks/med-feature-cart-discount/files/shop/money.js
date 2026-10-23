// Money helpers. All amounts are integer cents.
const toCents = (dollars) => Math.round(dollars * 100);
const format = (cents) => `$${(cents / 100).toFixed(2)}`;
module.exports = { toCents, format };
