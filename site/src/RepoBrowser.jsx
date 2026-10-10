// Shared repo browser — used on the Source page (full) and homepage (compact window).
import React, { useEffect, useState } from 'react';
import Mochi from './Mascot.jsx';

const REPO = 'xanstomper/mochi';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const TREE = `${API}/git/trees/${BRANCH}?recursive=1`;
const RAW = (p) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${p}`;
const SKIP = p => /(^|\/)(node_modules|\.git|target|dist|native\/bin|\.mochi)(\/|$)/.test(p)
  || /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|lock)$/.test(p);

const ICONS = {
  rs: ['#B7410E', 'RS'], ts: ['#3178C6', 'TS'], tsx: ['#3178C6', 'TS'], js: ['#B8A038', 'JS'],
  jsx: ['#B8A038', 'JS'], json: ['#8A8A8A', '{}'], md: ['#5E4B3C', 'MD'], css: ['#663399', 'CSS'],
  sh: ['#4A5532', '$'], toml: ['#9C6B4F', 'T'], yml: ['#9C6B4F', 'Y'], yaml: ['#9C6B4F', 'Y'],
  html: ['#C76A4A', '<>'], nix: ['#7B93A8', 'N'], mjs: ['#B8A038', 'MJ'],
};
const icon = (p) => {
  const ext = p.split('.').pop();
  const [c, t] = ICONS[ext] || ['#8A6F5B', ext.slice(0, 2).toUpperCase()];
  return <span className="f-icon" style={{ background: c + '22', color: c }}>{t}</span>;
};

function hl(code) {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const kw = 'const|let|var|function|return|if|else|for|while|import|from|export|class|new|await|async|type|interface|extends|implements|try|catch|throw|fn|pub|use|struct|enum|impl|match|mut|package|def|self|describe|it|test';
  return esc
    .replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span class="cm">$1</span>')
    .replace(/("[^"\n]*"|'[^'\n]*')/g, '<span class="str">$1</span>')
    .replace(new RegExp('\\b(' + kw + ')\\b', 'g'), '<span class="kw">$1</span>');
}

const bytes = n => n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

function nest(files) {
  const root = {};
  for (const f of files) {
    let cur = root;
    const parts = f.path.split('/');
    parts.forEach((p, i) => {
      if (i === parts.length - 1) (cur.__files = cur.__files || []).push(f);
      else cur = cur[p] = cur[p] || {};
    });
  }
  return root;
}

function Branch({ node, name, path, depth, sel, onOpen, collapsed, toggle }) {
  const dirs = Object.keys(node).filter(k => k !== '__files');
  const files = node.__files || [];
  const isRoot = depth === 0;
  const open = !collapsed.has(path) || isRoot;
  return (
    <div>
      {!isRoot && (
        <button className={'src-dir' + (open ? ' opn' : '')} style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => toggle(path)}>
          <span className="chev">▸</span>{name}/<em>{files.length + dirs.length}</em>
        </button>
      )}
      {open && (
        <div>
          {dirs.sort().map(d => <Branch key={d} node={node[d]} name={d} path={path + d + '/'} depth={depth + 1}
            sel={sel} onOpen={onOpen} collapsed={collapsed} toggle={toggle} />)}
          {files.sort((a, b) => a.path.localeCompare(b.path)).map(f => (
            <button key={f.path} className={'src-file' + (sel === f.path ? ' on' : '')}
              style={{ paddingLeft: 10 + (depth + 1) * 14 }}
              onClick={() => onOpen(f.path)}>
              {icon(f.path)}
              <span className="fname">{f.path.split('/').pop()}</span>
              <span className="fsize">{bytes(f.size)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// compact=true renders a shorter, windowed version for the homepage
export default function RepoBrowser({ compact = false }) {
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);
  const [code, setCode] = useState(null);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState(new Set());
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    fetch(TREE).then(r => r.json()).then(j => {
      if (!j.tree) throw new Error(j.message || 'tree fetch failed');
      setTree(j.tree.filter(t => t.type === 'blob' && !SKIP(t.path)));
    }).catch(e => setErr(String(e)));
    if (!compact) fetch(API).then(r => r.json()).then(j => setMeta({ stars: j.stargazers_count, forks: j.forks_count, issues: j.open_issues_count, size: j.size, pushed: j.pushed_at })).catch(() => {});
  }, []);

  const open = (p) => { setSel(p); setCode(null); fetch(RAW(p)).then(r => r.text()).then(setCode).catch(e => setErr(String(e))); };
  const toggle = (p) => setCollapsed(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const all = tree || [];
  const filtered = filter ? all.filter(t => t.path.toLowerCase().includes(filter.toLowerCase())) : null;

  return (
    <div className={'rb' + (compact ? ' rb-compact' : '')}>
      {meta && (
        <div className="repo-meta">
          <span>★ {meta.stars}</span><span>⑂ {meta.forks}</span><span>◉ {meta.issues} issues</span>
          <span>{(meta.size / 1024).toFixed(1)} MB</span><span>pushed {new Date(meta.pushed).toLocaleDateString()}</span>
          <code>{BRANCH}</code>
        </div>
      )}
      {err && <div className="src-err">GitHub API error: {err} — retry shortly or <a href={`https://github.com/${REPO}`} target="_blank" rel="noopener">browse on GitHub ↗</a></div>}
      {!tree && !err && <div className="src-loading"><Mochi size={compact ? 56 : 80} className="bob" />Loading repository tree…</div>}
      {tree && (
        <>
        <div className="rb-chrome">{tree.length} files · {REPO} · {BRANCH}</div>
        <div className="src-grid">
          <aside className="src-side">
            <input className="src-filter" placeholder="filter files…" value={filter} onChange={e => setFilter(e.target.value)} />
            <div className={'src-list' + (compact ? ' src-list-short' : '')}>
              {filter ? (
                filtered.map(f => (
                  <button key={f.path} className={'src-file' + (sel === f.path ? ' on' : '')} onClick={() => open(f.path)}>
                    {icon(f.path)}<span className="fname">{f.path}</span><span className="fsize">{bytes(f.size)}</span>
                  </button>
                ))
              ) : (
                <Branch node={nest(all)} name="" path="" depth={0} sel={sel} onOpen={open} collapsed={collapsed} toggle={toggle} />
              )}
            </div>
          </aside>
          <section className="src-view">
            {sel ? (
              <>
                <div className="src-path">{sel}</div>
                {code === null ? <div className="src-loading">loading…</div>
                  : <pre className="src-code"><code dangerouslySetInnerHTML={{ __html: hl(code) }} /></pre>}
              </>
            ) : (
              <div className="src-empty">
                <Mochi size={compact ? 70 : 90} className="bob" />
                <p>Pick a file — every source file in the repo reads right here.</p>
              </div>
            )}
          </section>
        </div>
        </>
      )}
    </div>
  );
}
