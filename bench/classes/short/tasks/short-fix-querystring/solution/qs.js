// parseQuery(qs): parse a URL query string (without the leading '?').
// Repeated keys collect into an array, in order. '+' means space.
// A key with no '=' maps to ''.
function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const pair of String(qs).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    const val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (Array.isArray(out[key])) out[key].push(val);
      else out[key] = [out[key], val];
    } else {
      out[key] = val;
    }
  }
  return out;
}
module.exports = { parseQuery };
