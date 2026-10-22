// Flat transfer fee: 25 cents, or the whole amount for tiny transfers.
const FEE_CENTS = 25;
const feeFor = (amountCents) => Math.min(FEE_CENTS, amountCents);
module.exports = { FEE_CENTS, feeFor };
