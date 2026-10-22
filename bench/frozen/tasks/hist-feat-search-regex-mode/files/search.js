// Frozen-task fixture: the fallback text search from src/tools/search.ts as
// of db8ad9b^ (the parent of the regex-mode feature), reduced to its matching
// core and made synchronous for the frozen workdir. In the repo the same
// logic runs as the async fallback when no ripgrep binary is present: walk
// the tree (skipping node_modules and .git), test each line against a RegExp
// built from the query with every metacharacter ESCAPED (literal match,
// case-insensitive), and report relpath:line:text matches. There is no way
// to search by pattern: a query like 'foo\(' can only ever match the literal
// characters 'foo\('.
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

/** Search `root` for `query` literally (case-insensitive). Returns match
 *  strings 'relpath:line:text' in walk order. */
function searchFiles(root, query) {
  const re = new RegExp(escapeRegex(query), 'i');
  const matches = [];
  for (const file of walk(root, [])) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) matches.push(`${relative(root, file)}:${i + 1}:${lines[i]}`);
    }
  }
  return matches;
}

module.exports = { searchFiles };
