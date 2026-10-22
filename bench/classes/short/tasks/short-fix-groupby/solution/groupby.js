// groupBy(items, keyFn): { key: [items...] } preserving encounter order.
// Every item belongs to exactly one group - including items whose key is
// 0, '' or false.
function groupBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    if (key === undefined) continue;
    (out[key] ??= []).push(item);
  }
  return out;
}
module.exports = { groupBy };
