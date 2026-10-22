// Canned solution: the block-scalar restructure from c3de878 (refactor
// (skills): one shared block-scalar parser for both frontmatter readers).
// The shared helpers are ported verbatim from the new src/skills/
// frontmatter.ts; the loader's inline copy is replaced by them, and the
// manager gains exactly the commit's block branch. Everything else about
// both parsers is unchanged.

// ---------------------------------------------------------------------------
// Shared YAML frontmatter helpers used by BOTH frontmatter parsers. Kept in
// one place so the two cannot drift — a previous split is exactly how block
// scalars went unhandled in one of them.
// ---------------------------------------------------------------------------

/** Does a frontmatter value look like a YAML block-scalar indicator?
 *  (`|`, `>-`, `|+`, `|2-`, `>2` …) */
const BLOCK_SCALAR_RE = /^([|>])[\d+-]*$/;

/** Fold a YAML folded-scalar (`>`) block: adjacent non-empty lines join
 *  with a space, blank lines become paragraph breaks. */
function foldBlockLines(lines) {
  let out = '';
  for (const l of lines) {
    if (l === '') { out += '\n'; continue; }
    if (out && !out.endsWith('\n')) out += ' ';
    out += l;
  }
  return out;
}

/**
 * Consume the indented continuation lines of a block scalar whose indicator
 * line is `lines[start]`. Returns the scalar text (chomping applied,
 * trimmed) and the index of the last consumed line.
 *
 * Imported Cursor / Antigravity / Hermes skills write long descriptions
 * this way; ignoring the continuation left the value as a bare `>-` and
 * broke skill retrieval (which is description-driven) and the
 * `<available_skills>` prompt.
 */
function readBlockScalar(lines, start, indicator) {
  const style = indicator[0];
  const collected = [];
  let i = start;
  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (next.trim() === '') { collected.push(''); i++; continue; }
    if (!/^\s/.test(next)) break;
    collected.push(next.replace(/^\s+/, ''));
    i++;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  let text = style === '|' ? collected.join('\n') : foldBlockLines(collected);
  if (!indicator.includes('+')) text = text.replace(/\n+$/, '');
  return { text: text.trim(), next: i };
}

// ---------------------------------------------------------------------------
// The skill loader's parser (src/skills/skills.ts).
// ---------------------------------------------------------------------------

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
    // consume the indented continuation lines via the shared reader.
    const block = BLOCK_SCALAR_RE.exec(value);
    if (block) {
      const { text, next } = readBlockScalar(lines, i, value);
      out[key] = text;
      i = next;
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

// ---------------------------------------------------------------------------
// The skill manager's parser (src/skills/skill-manager.ts).
// ---------------------------------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseManagerFrontmatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return null;
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // YAML block scalars (`|`, `>-`, `|+`, `|2-` …): consume the indented
    // continuation lines so multi-line descriptions survive (imported
    // Cursor/Antigravity/Hermes skills write them this way).
    if (BLOCK_SCALAR_RE.test(val)) {
      const { text: blockText, next } = readBlockScalar(lines, i, val);
      meta[key] = blockText;
      i = next;
      continue;
    }
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

module.exports = { parseSkillFrontmatter, parseManagerFrontmatter, BLOCK_SCALAR_RE, foldBlockLines, readBlockScalar };
