const { ROWS } = require('./data.js');
const { formatTable } = require('./format.js');

function csvField(value) {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatCsv(rows) {
  const lines = ['name,role,note'];
  for (const r of rows) lines.push([r.name, r.role, r.note].map(csvField).join(','));
  return lines.join('\n');
}

if (process.argv.includes('--csv')) {
  console.log(formatCsv(ROWS));
} else {
  console.log(formatTable(ROWS));
}
