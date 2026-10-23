// formatDuration(ms): "2m 5s" / "45s" / "1h 0m 3s" style strings.
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

// formatBytes(n): "2.0 KiB" style strings.
function formatBytes(n) {
  return `${(n / 1024).toFixed(1)} KiB`;
}

module.exports = { formatDuration, formatBytes };
