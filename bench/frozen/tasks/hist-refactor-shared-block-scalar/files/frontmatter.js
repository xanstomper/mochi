// Frozen-task fixture: BOTH of mochi's hand-rolled YAML frontmatter parsers
// as of c3de878^ (the parent of the shared block-scalar restructure), ported
// from src/skills/skills.ts (the loader's parseFrontmatter) and
// src/skills/skill-manager.ts (the manager's parseFrontmatter), types
// stripped. The two grew apart: the loader learned YAML block scalars
// (inline, below) when imported skills needed them; the manager — which
// backs the importer, Claude interop, and the curator — never did, so a
// skill it imports with a `description: >-` block keeps the literal string
// ">-" as its description and loses the text entirely.

/** Fold a YAML folded-scalar (`>`) block: adjacent non-empty lines join
 *  with a space, blank lines become paragraph breaks. (Loader's copy.) */
function foldBlockLines(lines) {
  let out = '';
  for (const l of lines) {
    if (l === '') { out += '\n'; continue; }
    if (out && !out.endsWith('\n')) out += ' ';
    out += l;
  }
  return out;
}

/** The skill loader's parser (src/skills/skills.ts): returns
 *  { frontmatter, body }; no frontmatter → { frontmatter: {}, body: raw }. */
function parseSkillFrontmatter(raw) {
  const m = /^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const yaml = m[1];
  const body = (m[2] ?? '').replace(/^\r?\n/, '');
  const out = {};
  const lines = yaml.split(/\r?\n/);
  let lastArrayKey = undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s+/.test(line) && lastArrayKey) {
      const item = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '');
      if (item) out[lastArrayKey].push(item);
      continue;
    }
    lastArrayKey = undefined;
    const idx = line.search(/:\s*/);
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    // YAML block scalars (`key: |`, `key: >-`, `key: |+`, `key: |2-` …):
    // consume the indented continuation lines. Imported Cursor /
    // Antigravity / Hermes skills write long descriptions this way, and
    // dropping the continuation left the description as a bare `>-`, which
    // broke skill retrieval + the prompt.
    const block = /^([|>])[\d+-]*$/.exec(value);
    if (block) {
      const collected = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === '') { collected.push(''); i++; continue; }
        if (!/^\s/.test(next)) break;
        collected.push(next.replace(/^\s+/, ''));
        i++;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      let text = block[1] === '|' ? collected.join('\n') : foldBlockLines(collected);
      if (!value.endsWith('+')) text = text.replace(/\n+$/, '');
      out[key] = text.trim();
      continue;
    }
    if (value === 'true' || value === 'false') {
      out[key] = value === 'true';
    } else if (value.startsWith('- ')) {
      const arr = [value.slice(2).trim().replace(/^["']|["']$/g, '')];
      out[key] = arr;
      lastArrayKey = key;
    } else if (value === '') {
      // A key with no inline value is an array/list start (items follow).
      out[key] = [];
      lastArrayKey = key;
    } else {
      out[key] = value.replace(/^["']|["']$/g, '').trim();
    }
  }
  return { frontmatter: out, body };
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** The skill manager's parser (src/skills/skill-manager.ts): returns
 *  { meta, body } or null when there is no frontmatter block. */
function parseManagerFrontmatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body: m[2]?.replace(/^\n/, '') ?? '' };
}

module.exports = { parseSkillFrontmatter, parseManagerFrontmatter };
