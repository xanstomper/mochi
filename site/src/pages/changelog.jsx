import React from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';

const RELEASES = [
  {
    ver: '0.11.1', latest: true, date: 'freeze-fix release',
    items: [
      ['Fixed the second live hard freeze: ', 'glob', '\'s unbounded synchronous directory walk. One broad glob from $HOME blocked the event loop for minutes. The walker is now async and hard-bounded (24 depth / 25k entries / 3s budget), skips heavyweight dirs, never follows symlinked directories, and surfaces truncation honestly instead of returning silent partial results.'],
      ['Reasoning-stream loops now caught by the repetition guard.', '', ' Reasoning chunks bypassed the phrase/repetition tracker; a looping model triggered failover instead of flooding the transcript.'],
      ['Fixed duplicated/stomped tool cards.', '', ' Two compounding defects — tool:called firing from both the loop and the executor, and a pending-card lookup deleted before read — made interleaved tool calls overwrite each other\'s cards. Routing now captures absolute line ids and collapses duplicate re-emits.'],
      ['Finished the TUI render harness', '', ' (src/tui/render-harness.ts): typed, v2, covering reasoning floods, tool bursts, and post-cap trim churn — 0 events above 100 ms.'],
      ['Regression tests for glob walk bounds, tool-card routing, collapse rules, and trim accounting.', '', ''],
    ],
  },
  {
    ver: '0.11.0', date: 'reliability overhaul',
    items: [
      ['The agent can no longer hang, freeze, or spin on token-draining loops.', '', ' Cumulative repeated-tool breaker (mutating-tools-only, so legit read-before-edit workflows survive), hard 3-minute stall guard on silent provider holds, SIGKILL fallback after SIGTERM on abort, subagent timeout fence, and event-layer rejection safety.'],
      ['Fast, lean defaults.', '', ' Default reasoning lowered max → medium: a chat reply dropped from ~30 s / 139k tokens to ~2 s / 7k tokens. Suite green at 763/763.'],
      ['TUI: Cline-style tool cards and a post-turn summary card', '', ' — every call framed with status, args, and first output; turn completion shows duration, tool count, files touched, tokens used.'],
      ['Coordinated visual language:', '', ' 2-space grid gutter with role-colored markers; all themes redesigned around semantic role colors with a single source of truth.'],
      ['The npm package now actually ships its runtime.', '', ' A files whitelist (dist, native/bin) fixed installs — verified by packing, clean-room install, and running the real bin. 693 files in the tarball instead of 1243.'],
      ['Live network tests are opt-in', '', ' (MOCHI_LIVE=1): default runs are deterministic and never touch the network. Full suite: 855 passed, 4 skipped, 0 failures.'],
      ['Consolidated duplicated Wikipedia lookups', '', ' into src/wiki.ts — byte-identical behavior, 48 fewer duplicated lines, new 10-test suite.'],
      ['Real shared SSE encoder', '', ' (src/sse-encode.ts) — production and tests emit identical bytes, verified with 8 round-trip tests.'],
      ['Toolchain consistency: Node 22-only CI matrix, .nvmrc, engine-strict, and a tarball guard that fails if compiled output is missing.', '', ''],
    ],
  },
  {
    ver: '0.10.7', date: 'interactive reasoning control',
    items: [
      ['Interactive /reasoning command', '', ' with menu selector — switch between low, medium, high, and max compute mid-session; active level shown live in the TUI status bar.'],
    ],
  },
];

function Changelog() {
  return (
    <>
      <div className="pagehead">
        <div className="wrap">
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 14 }}>Changelog <Mochi size={46} mood="blink" className="mascot bob" /></h1>
          <p>Every release, in the maintainers' own words. The full, unabridged history lives in the repo's <a href="https://github.com/xanstomper/mochi/blob/main/CHANGELOG.md" target="_blank" rel="noopener">CHANGELOG.md</a>.</p>
        </div>
      </div>
      <div className="wrap" style={{ paddingBottom: 88 }}>
        {RELEASES.map(r => (
          <article className="rel rv" key={r.ver}>
            <div className="ver"><h2>{r.ver}</h2>{r.latest && <span className="latest">latest</span>}</div>
            <div className="date">{r.date}</div>
            <ul>
              {r.items.map(([b, code, rest], i) => (
                <li key={i}><b>{b}</b>{code && <code>{code}</code>}{rest}</li>
              ))}
            </ul>
          </article>
        ))}
        <p className="rv" style={{ maxWidth: 720, paddingTop: 28, fontSize: 14, color: 'var(--muted)' }}>
          Older releases and full technical detail: <a href="https://github.com/xanstomper/mochi/blob/main/CHANGELOG.md" target="_blank" rel="noopener">CHANGELOG.md in the repo</a>.
        </p>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Changelog />);
