// skills.ts: frontmatter parsing, discovery walk, dedup/precedence, prompt
// formatting, interactive search ranking, usage stats, staleness + conflicts.
// Fully offline and deterministic — every branch here is unit-testable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  validateSkillName,
  parseFrontmatter,
  loadSkillFile,
  discoverSkills,
  loadProjectSkills,
  formatSkillsForPrompt,
  searchSkills,
  skillUsagePath,
  loadSkillUsage,
  recordSkillUsage,
  usageBoostMap,
  staleSkills,
  skillConflicts,
  readSkillBody,
  bundledSkillsDir,
  defaultUserSkillsDir,
  additionalUserSkillDirs,
  loadAllSkills,
  lintSkillSource,
  type Skill,
} from './skills.js';

let root: string;
const mk = (): string => mkdtempSync(resolve(tmpdir(), 'mochi-skills-'));

beforeAll(() => { root = mk(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const skill = (name: string, description: string, path = `/tmp/${name}.md`): Skill => ({ name, description, path });

describe('validateSkillName', () => {
  it('accepts the spec charset and reports violations', () => {
    expect(validateSkillName('deploy-checklist')).toEqual([]);
    expect(validateSkillName('a1-b2')).toEqual([]);
    const long = validateSkillName('x'.repeat(65));
    expect(long.some((e) => e.includes('exceeds 64 chars'))).toBe(true);
    const bad = validateSkillName('Has Spaces_Underscore');
    expect(bad).toContain('name must be lowercase a-z, 0-9, hyphens only');
    expect(bad).toContain('name must be lowercase');
    expect(bad.length).toBe(2); // lowercase + charset; length fine
  });
});

describe('parseFrontmatter', () => {
  it('returns the raw text untouched when there is no frontmatter', () => {
    const raw = 'just some markdown\nwith lines\n';
    const r = parseFrontmatter(raw);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe(raw);
  });

  it('parses scalars, flags, quotes, and BOM-prefixed blocks', () => {
    const r = parseFrontmatter('\ufeff---\nname: "my-skill"\nenabled: true\ndisabled: false\ndescription: does the thing\n---\nBODY HERE\n');
    expect(r.frontmatter.name).toBe('my-skill'); // quotes stripped
    expect(r.frontmatter.enabled).toBe(true);
    expect(r.frontmatter.disabled).toBe(false);
    expect(r.frontmatter.description).toBe('does the thing');
    expect(r.body).toBe('BODY HERE\n');
  });

  it('projects inline and multiline lists', () => {
    const r = parseFrontmatter('---\nname: x\ntools: - read\n  - write\n  - \ntags:\n  - alpha\n  - "beta"\n---\nbody\n');
    expect(r.frontmatter.tools).toEqual(['read', 'write']); // inline head + follows, empty item dropped
    expect(r.frontmatter.tags).toEqual(['alpha', 'beta']); // list-start form, quotes stripped
  });

  it('skips unparseable lines (no colon, empty key)', () => {
    const r = parseFrontmatter('---\njust a comment line\n: orphan\nname: ok\n---\nb\n');
    expect(r.frontmatter).toEqual({ name: 'ok' });
  });

  it('strips only a matching pair of surrounding quotes', () => {
    const r = parseFrontmatter('---\nname: "my-skill"\nverification: echo "hello world"\n---\nB\n');
    expect(r.frontmatter.name).toBe('my-skill');
    // The old asymmetric strip removed this trailing quote.
    expect(r.frontmatter.verification).toBe('echo "hello world"');
  });

  it('parses YAML block scalars (folded >- and literal |)', () => {
    const folded = parseFrontmatter('---\nname: x\ndescription: >-\n  line one\n  line two\n  line three\n---\nB\n');
    expect(folded.frontmatter.description).toBe('line one line two line three');
    const literal = parseFrontmatter('---\ndescription: |\n  a\n  b\n---\nB\n');
    expect(literal.frontmatter.description).toBe('a\nb');
    // A block scalar must stop at the next unindented key.
    const multi = parseFrontmatter('---\ndescription: >-\n  hello\n  world\nallowed-tools: read,write\n---\nB\n');
    expect(multi.frontmatter.description).toBe('hello world');
    expect(multi.frontmatter['allowed-tools']).toBe('read,write');
  });
});

describe('lintSkillSource', () => {
  it('does not treat quoted frontmatter values as invalid slugs', () => {
    // Regression: skills lint re-parsed frontmatter with a raw regex that kept
    // the YAML quotes, so `name: "imagegen"` was wrongly reported as an invalid
    // slug (as discovered name `"imagegen"`).
    const raw = '---\nname: "imagegen"\ndescription: Generate images.\n---\n1. step one\n2. step two\n3. step three\n';
    const r = lintSkillSource(raw);
    expect(r.name).toBe('imagegen');
    expect(r.result.issues.some((i) => i.rule === 'slug-format')).toBe(false);
  });

  it('falls back to the provided name when frontmatter omits one', () => {
    const raw = '---\ndescription: no name here\n---\nbody\n';
    expect(lintSkillSource(raw, 'folder-name').name).toBe('folder-name');
  });
});

describe('loadSkillFile', () => {
  it('loads name, description, tools, and disable-model-invocation', () => {
    // The skill dir must match the frontmatter name (Agent Skills spec:
    // name↔directory match is a conformance rule, and loadSkillFile surfaces
    // spec violations as diagnostics). mkdtemp appends random chars, so the
    // skill root is a fixed-name child of a temp parent.
    const parent = mkdtempSync(join(root, 'lsf-'));
    const dir = join(parent, 'ship-it');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'SKILL.md');
    writeFileSync(p, '---\nname: ship-it\ndescription: how we ship\ntools: read, write shell\ndisable-model-invocation: true\n---\nbody\n');
    const { skill: s, diagnostics } = loadSkillFile(p);
    expect(s).toMatchObject({ name: 'ship-it', description: 'how we ship', disableModelInvocation: true });
    expect(s!.tools).toEqual(['read', 'write', 'shell']);
    expect(diagnostics).toEqual([]);
  });

  it('accepts tools as a real list and caps long descriptions', () => {
    const dir = mkdtempSync(join(root, 'lsf2-'));
    const p = join(dir, 'SKILL.md');
    writeFileSync(p, `---\nname: big\ndescription: ${'d'.repeat(2000)}\ntools:\n  - shell\n---\nb\n`);
    const { skill: s } = loadSkillFile(p);
    expect(s!.tools).toEqual(['shell']);
    expect(s!.description.length).toBe(1024);
  });

  it('falls back to the directory name and flags missing pieces', () => {
    const dir = mkdtempSync(join(root, 'lsf3-'));
    const named = join(dir, 'my-dir');
    mkdirSync(named);
    const p = join(named, 'skill.md');
    writeFileSync(p, '---\ndescription: has no name field\n---\nb\n');
    expect(loadSkillFile(p).skill!.name).toBe('my-dir');

    // No description → skipped with a diagnostic.
    writeFileSync(p, '---\nname: nameless\n---\nb\n');
    const nd = loadSkillFile(p);
    expect(nd.skill).toBeNull();
    expect(nd.diagnostics[0]).toContain('has no description');

    // Unreadable path → diagnostic, no throw.
    const missing = loadSkillFile(join(dir, 'nope', 'x.md'));
    expect(missing.skill).toBeNull();
    expect(missing.diagnostics[0]).toContain('cannot read');

    // Invalid name charset surfaces a diagnostic but still loads.
    const bad = join(dir, 'bad.md');
    writeFileSync(bad, '---\nname: Bad_Name\ndescription: d\n---\nb\n');
    const r = loadSkillFile(bad);
    expect(r.skill).not.toBeNull();
    expect(r.diagnostics.join(' ')).toContain('lowercase');
  });
});

describe('discoverSkills', () => {
  it('handles missing dirs, shallow depth, empty budget, and non-dirs', () => {
    expect(discoverSkills(join(root, 'does-not-exist'))).toEqual({ skills: [], diagnostics: [] });
    expect(discoverSkills(root, 7).skills).toEqual([]); // depth > 6
    const d = mkdtempSync(join(root, 'disc-'));
    expect(discoverSkills(d, 0, 0).skills).toEqual([]); // budget spent up front
    expect(discoverSkills(join(d, 'plain.md')).skills).toEqual([]); // ENOTDIR path: readdir fails
  });

  it('treats a directory with SKILL.md as a leaf (no recursion below)', () => {
    const d = mkdtempSync(join(root, 'leaf-'));
    mkdirSync(join(d, 'root-skill'));
    writeFileSync(join(d, 'root-skill', 'SKILL.md'), '---\nname: root-skill\ndescription: leaf\n---\nb\n');
    mkdirSync(join(d, 'root-skill', 'nested'));
    writeFileSync(join(d, 'root-skill', 'nested', 'other.md'), '---\nname: nested\ndescription: must not be found\n---\nb\n');
    const r = discoverSkills(d);
    expect(r.skills.map((s) => s.name)).toEqual(['root-skill']);
  });

  it('walks plain .md files, skips dotfiles/node_modules, and honors the entry budget', () => {
    const d = mkdtempSync(join(root, 'walk-'));
    writeFileSync(join(d, 'a.md'), '---\nname: alpha\ndescription: a\n---\nb\n');
    writeFileSync(join(d, 'b.md'), '---\nname: beta\ndescription: b\n---\nb\n');
    writeFileSync(join(d, 'c.md'), '---\nname: gamma\ndescription: c\n---\nb\n');
    writeFileSync(join(d, 'notes.txt'), 'ignored');
    mkdirSync(join(d, '.hidden'));
    writeFileSync(join(d, '.hidden', 'h.md'), '---\nname: hidden\ndescription: h\n---\nb\n');
    mkdirSync(join(d, 'node_modules'));
    writeFileSync(join(d, 'node_modules', 'n.md'), '---\nname: nmod\ndescription: n\n---\nb\n');
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 's.md'), '---\nname: subby\ndescription: s\n---\nb\n');

    const all = discoverSkills(d);
    const names = all.skills.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma', 'subby']); // hidden + node_modules + txt excluded
    // Budget of 2: exactly two .md files processed before the walk stops.
    expect(discoverSkills(d, 0, 2).skills).toHaveLength(2);
  });
});

describe('loadProjectSkills precedence + dedup', () => {
  it('lets project skills shadow user skills and counts the same file once', () => {
    const proj = mkdtempSync(join(root, 'proj-'));
    const user = mkdtempSync(join(root, 'user-'));
    mkdirSync(join(proj, '.mochi', 'skills', 'shared'), { recursive: true });
    writeFileSync(join(proj, '.mochi', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: from project\n---\np\n');
    mkdirSync(join(user, 'shared'), { recursive: true });
    writeFileSync(join(user, 'shared', 'SKILL.md'), '---\nname: shared\ndescription: from user\n---\nu\n');
    mkdirSync(join(user, 'only-user'), { recursive: true });
    writeFileSync(join(user, 'only-user', 'SKILL.md'), '---\nname: only-user\ndescription: u\n---\nu\n');

    const r = loadProjectSkills(proj, user, [join(proj, '.mochi', 'skills')]); // extraDirs repeats the project dir
    const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]));
    expect(byName.shared.path).toContain(join(proj, '.mochi', 'skills')); // project wins
    expect(byName['only-user']).toBeDefined();
    // Repeated dir → same file paths → deduped, no duplicates in output.
    expect(r.skills.filter((s) => s.name === 'shared')).toHaveLength(1);
  });
});

describe('formatSkillsForPrompt', () => {
  it('renders the XML block, filters disabled skills, and escapes markup', () => {
    expect(formatSkillsForPrompt([])).toBe('');
    const s: Skill[] = [
      skill('alpha', 'first <skill> & "quoted"'),
      skill('hidden', 'not advertised', '/x'),
    ];
    s[1].disableModelInvocation = true;
    const out = formatSkillsForPrompt(s);
    expect(out).toContain('<available_skills>');
    expect(out).toContain('first &lt;skill&gt; &amp; &quot;quoted&quot;');
    expect(out).not.toContain('hidden');
    // Positive limit truncates the visible list.
    const two: Skill[] = [skill('alpha', 'first'), skill('beta', 'second')];
    const limited = formatSkillsForPrompt(two, 1);
    expect(limited).toContain('alpha');
    expect(limited).not.toContain('beta');
  });
});

describe('searchSkills ranking', () => {
  const catalog: Skill[] = [
    skill('deploy', 'ships the build to production'),
    skill('deploy-preview', 'temporary preview environments'),
    skill('git-helper', 'does helper things for git'),
    skill('alpha', 'handles zebra migration between clusters'),
  ];

  it('returns nothing for blank queries', () => {
    expect(searchSkills(catalog, '   ')).toEqual([]);
  });

  it('ranks exact > prefix > substring > description', () => {
    const exact = searchSkills(catalog, 'deploy');
    expect(exact[0].skill.name).toBe('deploy');
    expect(exact[0].score).toBe(1);
    expect(exact[0].snippet).toBe('exact name match');
    expect(exact[1].score).toBe(0.9); // deploy-preview prefix
    expect(exact[1].snippet).toContain('name starts with');

    const sub = searchSkills(catalog, 'eploy');
    expect(sub[0].skill.name).toBe('deploy');
    expect(sub[0].score).toBeCloseTo(0.75);
    expect(sub[0].snippet).toContain('name contains');

    const desc = searchSkills(catalog, 'zebra');
    expect(desc[0].skill.name).toBe('alpha');
    expect(desc[0].score).toBeCloseTo(0.55);
    expect(desc[0].snippet).toContain('…');
  });

  it('falls back to token overlap and applies the usage boost', () => {
    const hits = searchSkills(catalog, 'helper stuff');
    expect(hits.some((h) => h.skill.name === 'git-helper')).toBe(true);
    const hit = hits.find((h) => h.skill.name === 'git-helper')!;
    expect(hit.snippet).toContain('shares');
    expect(hit.score).toBeGreaterThan(0);
    // Usage boost can push an exact match past 1.0.
    const boosted = searchSkills(catalog, 'deploy', { usageBoost: new Map([['deploy', 20]]) });
    expect(boosted[0].score).toBeGreaterThan(1);
  });

  it('honors the hit limit', () => {
    expect(searchSkills(catalog, 'deploy', { limit: 1 })).toHaveLength(1);
    expect(searchSkills(catalog, 'deploy')).toHaveLength(2);
  });
});

describe('skill usage stats', () => {
  it('records and reloads usage, filtering malformed entries', () => {
    const proj = mkdtempSync(join(root, 'usage-'));
    expect(skillUsagePath(proj)).toBe(join(proj, '.mochi', 'skill-usage.json'));
    expect(loadSkillUsage(proj).size).toBe(0); // missing file

    recordSkillUsage(proj, 'deploy');
    recordSkillUsage(proj, 'deploy', true);
    recordSkillUsage(proj, 'other', false);
    const m = loadSkillUsage(proj);
    // Unified registry: records also carry createdAt/lastUsedAt stamps.
    expect(m.get('deploy')).toEqual(expect.objectContaining({ loads: 2, wins: 1 }));
    expect(m.get('other')).toEqual(expect.objectContaining({ loads: 1, wins: 0 }));
    expect(m.get('deploy')?.lastUsedAt).toBeGreaterThan(0);

    // Malformed entries are dropped, corrupt files never throw.
    writeFileSync(skillUsagePath(proj), JSON.stringify({ bad: { loads: 'x' }, good: { loads: 1, wins: 0 } }));
    expect(loadSkillUsage(proj).size).toBe(1);
    writeFileSync(skillUsagePath(proj), 'not-json{');
    expect(loadSkillUsage(proj).size).toBe(0);
    expect(() => recordSkillUsage(proj, 'deploy')).not.toThrow(); // corrupt base: best-effort no-op
  });

  it('boosts only well-used skills that produced wins', () => {
    const m = new Map([
      ['a', { loads: 3, wins: 2 }],
      ['b', { loads: 2, wins: 2 }], // too few loads
      ['c', { loads: 9, wins: 0 }], // never won
    ]);
    expect([...usageBoostMap(m)]).toEqual([['a', 2]]);
  });
});

describe('staleSkills + skillConflicts + readSkillBody', () => {
  it('flags old updated stamps, old mtimes, and skips unreadable files', () => {
    const d = mkdtempSync(join(root, 'stale-'));
    const old = join(d, 'old.md');
    const fresh = join(d, 'fresh.md');
    const unstamped = join(d, 'unstamped.md');
    writeFileSync(old, '---\nname: old\ndescription: d\nupdated: 2020-01-01\n---\nb\n');
    writeFileSync(fresh, '---\nname: fresh\ndescription: d\nupdated: 2099-01-01\n---\nb\n');
    writeFileSync(unstamped, '---\nname: unstamped\ndescription: d\n---\nb\n');
    const past = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    utimesSync(unstamped, past, past);

    const out = staleSkills([
      skill('old', 'd', old),
      skill('fresh', 'd', fresh),
      skill('unstamped', 'd', unstamped),
      skill('ghost', 'd', join(d, 'missing.md')), // unreadable: skipped silently
    ]);
    expect(out.sort()).toEqual(['old', 'unstamped']);
  });

  it('surfaces near-twin skills and ignores distinct or empty-vocabulary ones', () => {
    const twins = [
      skill('release-checklist', 'step by step release checklist for the service'),
      skill('release-checklist-copy', 'step by step release checklist for the service'),
    ];
    const conflicts = skillConflicts([...twins, skill('deploy', 'ships builds to production clusters')]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].score).toBeGreaterThan(0.8);
    // Stopword-only vocabulary → empty token set → no conflict, no throw.
    expect(skillConflicts([skill('a', 'the of to'), skill('b', '')])).toEqual([]);
  });

  it('reads bodies directly, via the project fallback, or returns empty', () => {
    const proj = mkdtempSync(join(root, 'body-'));
    const direct = join(directDir(), 'SKILL.md');
    expect(readSkillBody(skill('x', 'd', direct), proj)).toContain('name: x');

    // Fallback: skill.path dead, file exists at <project>/.mochi/skills/<name>/SKILL.md
    mkdirSync(join(proj, '.mochi', 'skills', 'fallback-skill'), { recursive: true });
    writeFileSync(join(proj, '.mochi', 'skills', 'fallback-skill', 'SKILL.md'), 'FALLBACK BODY');
    expect(readSkillBody(skill('fallback-skill', 'd', '/nowhere/x.md'), proj)).toBe('FALLBACK BODY');

    expect(readSkillBody(skill('nothing', 'd', '/nowhere/y.md'), proj)).toBe('');
  });

  function directDir(): string {
    const d = mkdtempSync(join(root, 'read-'));
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'SKILL.md'), '---\nname: x\ndescription: d\n---\nDIRECT BODY\n');
    return join(d, 'sub');
  }
});

describe('directory resolution + loadAllSkills precedence', () => {
  it('resolves bundled/user/additional dirs safely', () => {
    const bundled = bundledSkillsDir();
    expect(bundled === null || existsSync(bundled)).toBe(true);

    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      process.env.HOME = join(root, 'fake-home');
      delete process.env.USERPROFILE;
      expect(defaultUserSkillsDir()).toBe(join(root, 'fake-home', '.mochi', 'skills'));
      expect(additionalUserSkillDirs()).toEqual([]); // none of the bridged dirs exist
      process.env.HOME = '';
      process.env.USERPROFILE = '';
      expect(defaultUserSkillsDir()).toBe(''); // no home at all
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    }
  });

  it('merges bundled < project < user with user winning name collisions', () => {
    const proj = mkdtempSync(join(root, 'all-proj-'));
    const user = mkdtempSync(join(root, 'all-user-'));
    mkdirSync(join(proj, '.mochi', 'skills', 'shared'), { recursive: true });
    writeFileSync(join(proj, '.mochi', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: project copy\n---\np\n');
    mkdirSync(join(proj, '.mochi', 'skills', 'proj-only'), { recursive: true });
    writeFileSync(join(proj, '.mochi', 'skills', 'proj-only', 'SKILL.md'), '---\nname: proj-only\ndescription: p\n---\np\n');
    mkdirSync(join(user, 'shared'), { recursive: true });
    writeFileSync(join(user, 'shared', 'SKILL.md'), '---\nname: shared\ndescription: user copy\n---\nu\n');
    mkdirSync(join(user, 'user-only'), { recursive: true });
    writeFileSync(join(user, 'user-only', 'SKILL.md'), '---\nname: user-only\ndescription: u\n---\nu\n');

    const r = loadAllSkills(proj, user);
    const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]));
    expect(byName.shared.path).toBe(join(user, 'shared', 'SKILL.md')); // user (added last) wins
    expect(byName['user-only']).toBeDefined();
    // Project skills that don't collide are present alongside the user ones.
    expect(byName['proj-only'].path).toContain(join(proj, '.mochi', 'skills'));
    // A project skill shadows a bundled skill of the same name.
    const bundled = bundledSkillsDir();
    if (bundled) {
      const firstBundled = discoverSkills(bundled).skills[0];
      if (firstBundled) {
        mkdirSync(join(proj, '.mochi', 'skills', firstBundled.name), { recursive: true });
        writeFileSync(join(proj, '.mochi', 'skills', firstBundled.name, 'SKILL.md'), `---\nname: ${firstBundled.name}\ndescription: project override\n---\np\n`);
        const again = loadAllSkills(proj, user);
        const overridden = again.skills.find((s) => s.name === firstBundled.name)!;
        expect(overridden.path).toContain(join(proj, '.mochi', 'skills')); // project > bundled
      }
    }
  });
});
