// formatBytes(n): human-readable byte count.
//   n < 1024          -> "N B"            (integer, no decimals)
//   otherwise         -> largest 1024-based unit (KiB, MiB, GiB, TiB)
//                        with ONE decimal, dropping a trailing ".0"
function formatBytes(n) {
  if (n < 1024) return `${Math.trunc(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  const rendered = v.toFixed(1).replace(/\.0$/, '');
  return `${rendered} ${units[u]}`;
}
module.exports = { formatBytes };
