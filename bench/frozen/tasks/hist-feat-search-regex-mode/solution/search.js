// Canned solution: fallback search with opt-in regex mode, ported from
// src/tools/search.ts as of db8ad9b (feat(search): add regex mode to the
// search tool). validateRegex is the fix's own, verbatim apart from types;
// the matching core is the fixture's with the fix's mode branch: in regex
// mode the pattern is compiled raw, and an invalid or over-long pattern
// returns the error string (the tool's return contract) instead of throwing.
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAX_REGEX_PATTERN_CHARS = 512;

/** Validate a user-supplied regex: length cap + must compile. Returns an error string or null. */
function validateRegex(pattern) {
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
    return `Invalid regex: pattern is ${pattern.length} characters; maximum is ${MAX_REGEX_PATTERN_CHARS}.`;
  }
  try {
    // Compile once here so malformed patterns produce a tool error instead of
    // escaping from whichever search backend happens to run first.
    new RegExp(pattern);
    return null;
  } catch (e) {
    return `Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
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

/** Search `root` for `query`. opts.regex: interpret query as a regular
 *  expression (case-insensitive) instead of a literal string. In regex mode
 *  an invalid or over-long pattern RETURNS the 'Invalid regex: …' error
 *  string rather than a match array. */
function searchFiles(root, query, opts) {
  let re;
  if (opts && opts.regex) {
    const err = validateRegex(query);
    if (err) return err;
    re = new RegExp(query, 'i');
  } else {
    re = new RegExp(escapeRegex(query), 'i');
  }
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

module.exports = { searchFiles, validateRegex };
