import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import { Reveal } from '../anim.jsx';

const REPO = 'xanstomper/mochi';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW = (p) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${p}`;
const SKIP = p => /(^|\/)(node_modules|\.git|target|dist|native\/bin|docs\/assets)(\/|$)/.test(p) || /-test\.ts$|\.test\.ts$|\.png$|\.jpg$|\.gif$|\.ico$|\.lock$/.test(p);

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// naive but effective: highlight keywords/strings/comments via token spans
function hl(code) {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span style="color:#C4B49F">$1</span>')
    .replace(/'([^'\n]*)'/g, '<span style="color:#8FBC8F">\'$1\'</span>')
    .replace(/"([^"\n]*)"/g, '<span style="color:#8FBC8F">"$1"</span>')
    .replace(/\b(const|let|var|function|return|if|else|for|while|import|from|export|class|new|await|async|type|interface|extends|implements|try|catch|throw|fn|pub|use|struct|enum|impl|match|mut|package|def|self)\b/g, '<span style="color:#D97A93;font-weight:600">$1</span>');
}

function Source() {
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState(null);
  const [path, setPath] = useState(null);
  const [code, setCode] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch(API).then(r => r.json()).then(j => {
      if (!j.tree) throw new Error(j.message || 'tree fetch failed');
      setTree(j.tree.filter(t => t.type === 'blob' && !SKIP(t.path)));
    }).catch(e => setErr(String(e)));
  }, []);

  const open = (p) => {
    setPath(p); setCode(null);
    fetch(RAW(p)).then(r => r.text()).then(setCode).catch(e => setErr(String(e)));
    history.replaceState(null, '', '#src');
  };

  const files = tree ? tree.filter(t => t.path.toLowerCase().includes(filter.toLowerCase())) : [];
  const dirs = tree ? [...new Set(tree.map(t => t.path.split('/').slice(0, -1).join('/')).filter(Boolean))].sort() : [];

  return (
    <>
      <div className="pagehead">
        <div className="wrap">
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 14 }}>Source <Mochi size={46} mood="happy" className="mascot bob" /></h1>
          <p>Browse the entire mochi repository — all {tree ? tree.length : '…'} tracked files — right here. Click any file to read it. <a href={`https://github.com/${REPO}`} target="_blank" rel="noopener">Open on GitHub ↗</a></p>
        </div>
      </div>

      <div className="wrap srcwrap">
        {err && <div className="src-err">GitHub API error: {err} — rate limits reset hourly; try again or use the GitHub link above.</div>}
        {!tree && !err && <div className="src-loading">Loading repository tree…</div>}

        {tree && (
          <div className="src-grid">
            <aside className="src-side">
              <input className="src-filter" placeholder="filter files…" value={filter} onChange={e => setFilter(e.target.value)} autoFocus />
              <div className="src-list">
                <div className="src-dirroot">/ ({tree.length} files)</div>
                {dirs.map(d => <div className="src-dir" key={d}>{d}/</div>)}
                {files.map(f => (
                  <button key={f.path} className={'src-file' + (path === f.path ? ' on' : '')} onClick={() => open(f.path)}>
                    {f.path.split('/').pop()}
                    <span>{bytes(f.size)}</span>
                  </button>
                ))}
              </div>
            </aside>
            <section className="src-view" id="src">
              {path ? (
                <>
                  <div className="src-path">{path}</div>
                  {code === null
                    ? <div className="src-loading">loading…</div>
                    : <pre className="src-code"><code dangerouslySetInnerHTML={{ __html: hl(code) }} /></pre>}
                </>
              ) : (
                <div className="src-empty">
                  <Mochi size={90} className="bob" />
                  <p>Pick a file on the left — every .ts, .rs, .md file in the repo reads here.</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Source />);
