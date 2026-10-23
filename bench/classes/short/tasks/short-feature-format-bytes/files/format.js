// formatBytes(n): human-readable byte count.
//   n < 1024          -> "N B"            (integer, no decimals)
//   otherwise         -> largest 1024-based unit (KiB, MiB, GiB, TiB)
//                        with ONE decimal, dropping a trailing ".0"
// Examples: 0 -> "0 B", 512 -> "512 B", 1024 -> "1 KiB",
//           1536 -> "1.5 KiB", 1048576 -> "1 MiB", 2621440 -> "2.5 MiB"
function formatBytes(n) {
  return ''; // TODO: implement
}
module.exports = { formatBytes };
