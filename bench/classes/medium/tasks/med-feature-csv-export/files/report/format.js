// Plain-text table: one "name | role | note" line per row.
function formatTable(rows) {
  return rows.map((r) => `${r.name} | ${r.role} | ${r.note}`).join('\n');
}
module.exports = { formatTable };
