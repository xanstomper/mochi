// sumColumn(csvText, columnName): sum the numeric values of one column.
// The first row is a header. Blank lines are ignored; an empty cell is 0.
function sumColumn(csvText, columnName) {
  const lines = String(csvText).split('\n');
  const header = lines[0].split(',');
  const idx = header.indexOf(columnName);
  if (idx === -1) throw new Error(`no such column: ${columnName}`);
  let total = 0;
  for (const line of lines) {
    total += Number(line.split(',')[idx]);
  }
  return total;
}
module.exports = { sumColumn };
