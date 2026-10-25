// Shared YAML frontmatter helpers used by BOTH frontmatter parsers
// (`skills.ts` and `skill-manager.ts`). Kept in one place so the two cannot
// drift — a previous split is exactly how block scalars went unhandled in one
// of them.

/** Does a frontmatter value look like a YAML block-scalar indicator?
 *  (`|`, `>-`, `|+`, `|2-`, `>2` …) */
export const BLOCK_SCALAR_RE = /^([|>])[\d+-]*$/;

/** Strip a SINGLE pair of matching surrounding quotes only. The old
 *  `replace(/^["']|["']$/g, '')` stripped from each end independently, so a
 *  value like `echo "hello world"` lost its trailing quote (and `"foo` its
 *  leading one). */
export function stripMatchingQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Fold a YAML folded-scalar (`>`) block: adjacent non-empty lines join with a
 *  space, blank lines become paragraph breaks. */
export function foldBlockLines(lines: string[]): string {
  let out = '';
  for (const l of lines) {
    if (l === '') { out += '\n'; continue; }
    if (out && !out.endsWith('\n')) out += ' ';
    out += l;
  }
  return out;
}

/** Parse a small YAML-ish frontmatter block. Handles scalar strings, flags, and
 *  `- item` arrays (projecting both inline and multiline lists). Not a full YAML
 *  parser (enough for the Agent Skills spec). Lives here (with the other shared
 *  frontmatter helpers) so the AAIF conformance validator can reuse the ONE
 *  canonical parser without importing skills.ts (which imports this module's
 *  consumers) — a second parser is exactly how quoted scalars once drifted. */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string | boolean | string[] | Record<string, string>>; body: string } {
  const m = /^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const yaml = m[1];
  const body = (m[2] ?? '').replace(/^\r?\n/, '');
  const out: Record<string, string | boolean | string[] | Record<string, string>> = {};
  const lines = yaml.split(/\r?\n/);
  let lastArrayKey: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s+/.test(line) && lastArrayKey) {
      const item = stripMatchingQuotes(line.replace(/^\s*-\s*/, '').trim());
      if (item) (out[lastArrayKey] as string[]).push(item);
      continue;
    }
    lastArrayKey = undefined;
    const idx = line.search(/:\s*/);
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    // YAML block scalars (`key: |`, `key: >-`, `key: |+`, `key: |2-` …): consume
    // the indented continuation lines. Imported Cursor/Antigravity/Hermes skills
    // write long descriptions this way, and dropping the continuation left the
    // description as a bare `>-`, which broke skill retrieval + the prompt.
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
      const arr = [stripMatchingQuotes(value.slice(2).trim())];
      out[key] = arr;
      lastArrayKey = key;
    } else if (value === '') {
      // A key with no inline value: either a `- item` list follows (existing
      // behavior) or an indented `subkey: value` map follows. The spec's
      // `metadata` field is a map of string keys to string values, and skills
      // in the wild (and in the bundled catalog) write it indented — hoisting
      // those sub-keys to top level corrupted both the map and the key set.
      const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim() !== '');
      if (nextNonEmpty !== undefined && /^\s+-\s+/.test(nextNonEmpty)) {
        out[key] = [];
        lastArrayKey = key;
      } else if (nextNonEmpty !== undefined && /^\s+[^\s].*:\s*/.test(nextNonEmpty)) {
        const map: Record<string, string> = {};
        let j = i + 1;
        let mapIndent = -1;
        for (; j < lines.length; j++) {
          const ml = lines[j];
          if (ml.trim() === '') continue;
          const mm = /^(\s*)([^\s][^:]*):\s*(.*)$/.exec(ml);
          if (!mm) break;
          const indent = mm[1].length;
          if (mapIndent < 0) mapIndent = indent;
          if (indent < mapIndent) break; // dedent: map ended
          map[mm[2].trim()] = stripMatchingQuotes(mm[3].trim());
        }
        out[key] = map;
        i = j - 1;
      } else {
        out[key] = [];
        lastArrayKey = key;
      }
    } else {
      out[key] = stripMatchingQuotes(value).trim();
    }
  }
  return { frontmatter: out, body };
}

/**
 * Consume the indented continuation lines of a block scalar whose indicator
 * line is `lines[start]`. Returns the scalar text (chomping applied, trimmed)
 * and the index of the last consumed line.
 *
 * Imported Cursor / Antigravity / Hermes skills write long descriptions this
 * way; ignoring the continuation left the value as a bare `>-` and broke skill
 * retrieval (which is description-driven) and the `<available_skills>` prompt.
 */
export function readBlockScalar(
  lines: string[],
  start: number,
  indicator: string,
): { text: string; next: number } {
  const style = indicator[0];
  const collected: string[] = [];
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
