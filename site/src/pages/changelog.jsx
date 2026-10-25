import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import Footer from '../Footer.jsx';
import EngineeringGridBackground from '../EngineeringGridBackground.jsx';
import { AnimatedContent } from '../anim.jsx';
import { IconSearch } from '../icons.jsx';
import { RELEASES } from '../changelog-data.js';

const FILTER_TAGS = ['All', 'LATEST', 'PERF', 'SECURITY', 'TUI', 'RUST CORE', 'MODELS & MCP', 'DAEMON'];

// Helper to format inline markdown code and bold
function formatItem(text) {
  const parts = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let match;
  let lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      parts.push(
        <strong key={match.index} style={{ color: '#111116', fontWeight: 700 }}>
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`')) {
      parts.push(
        <code key={match.index} className="timeline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length ? parts : text;
}

export default function Changelog() {
  const [activeTag, setActiveTag] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeVersion, setActiveVersion] = useState(RELEASES[0]?.version || 'v0.22.1 (Current)');

  // Default to expanding ALL 35 releases so every detail is immediately documented
  const [expandedVersions, setExpandedVersions] = useState(() => {
    const all = {};
    RELEASES.forEach((r) => {
      all[r.version] = true;
    });
    return all;
  });

  const toggleExpand = (ver) => {
    setExpandedVersions((prev) => ({ ...prev, [ver]: !prev[ver] }));
  };

  const expandAll = () => {
    const all = {};
    RELEASES.forEach((r) => {
      all[r.version] = true;
    });
    setExpandedVersions(all);
  };

  const collapseAll = () => {
    setExpandedVersions({});
  };

  const filteredReleases = RELEASES.filter((rel) => {
    const matchesTag =
      activeTag === 'All' ||
      rel.tag.toLowerCase().includes(activeTag.toLowerCase()) ||
      rel.categories.some((c) => c.name.toLowerCase().includes(activeTag.toLowerCase()));

    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !searchQuery ||
      rel.version.toLowerCase().includes(q) ||
      rel.title.toLowerCase().includes(q) ||
      rel.categories.some(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.items.some((item) => item.toLowerCase().includes(q))
      );

    return matchesTag && matchesSearch;
  });

  const scrollToRelease = (ver) => {
    setActiveVersion(ver);
    const element = document.getElementById('rel-' + ver.replace(/[^a-zA-Z0-9]/g, '-'));
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <>
      <EngineeringGridBackground />
      <div style={{ maxWidth: 1560, margin: '0 auto', padding: '120px 4vw 80px' }}>
        {/* Header Hero Row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: 40, alignItems: 'center', marginBottom: 40 }}>
          <div>
            <AnimatedContent direction="bottom" delay={0.1}>
              <div className="hero-eyebrow-clean">
                <span className="sparkle-star">✦</span>
                COMPLETE PRODUCTION RELEASE HISTORY (35 RELEASES)
              </div>
            </AnimatedContent>

            <h1 className="hero-title" style={{ marginBottom: 18 }}>
              What’s New <span className="accent-title">in Mochi.</span>
            </h1>

            <AnimatedContent direction="bottom" delay={0.2}>
              <p className="hero-sub" style={{ maxWidth: 760, marginBottom: 28, fontSize: 17, color: '#69697A' }}>
                Complete technical changelog documenting all 35 releases from v0.22 down to v0.1.0. Every architectural change, native Rust N-API commit, Bubblewrap namespace isolation, and memory reduction shipped in source.
              </p>
            </AnimatedContent>

            {/* Filter Pills & Expand Actions */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
              <div className="filter-pills" style={{ margin: 0 }}>
                {FILTER_TAGS.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setActiveTag(tag)}
                    className={`filter-pill ${activeTag === tag ? 'active' : ''}`}
                  >
                    {tag}
                  </button>
                ))}
              </div>

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  onClick={expandAll}
                  style={{
                    padding: '8px 14px',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    background: '#ffffff',
                    border: '1.5px solid rgba(138, 103, 246, 0.25)',
                    borderRadius: 10,
                    cursor: 'pointer',
                    color: '#8A67F6',
                    fontWeight: 700,
                  }}
                >
                  Expand All (35)
                </button>
                <button
                  onClick={collapseAll}
                  style={{
                    padding: '8px 14px',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    background: '#ffffff',
                    border: '1.5px solid var(--line)',
                    borderRadius: 10,
                    cursor: 'pointer',
                    color: '#69697A',
                    fontWeight: 600,
                  }}
                >
                  Collapse All
                </button>
              </div>
            </div>

            {/* Live Search Bar */}
            <div className="doc-search-bar" style={{ maxWidth: '100%', marginBottom: 10 }}>
              <IconSearch size={18} className="text-muted" />
              <input
                type="text"
                placeholder="Search all 35 releases (e.g. bwrap, MCP, multi-tab, prompt cache, AST, PSS)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 14 }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Builder Mascot with hardhat */}
          <AnimatedContent direction="right" delay={0.2}>
            <div className="subpage-mascot-wrap">
              <div className="subpage-doodle">all 35 releases documented!</div>
              <Mochi variant="changelog" size={380} />
            </div>
          </AnimatedContent>
        </div>

        {/* Sticky Horizontal Version Quick-Jump Bar */}
        <div
          style={{
            position: 'sticky',
            top: 76,
            zIndex: 30,
            background: 'rgba(255, 255, 255, 0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(138, 103, 246, 0.16)',
            borderRadius: 16,
            padding: '10px 14px',
            marginBottom: 36,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflowX: 'auto',
            boxShadow: '0 4px 20px rgba(138, 103, 246, 0.08)',
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 800, color: '#8A67F6', textTransform: 'uppercase', whiteSpace: 'nowrap', paddingRight: 6 }}>
            QUICK JUMP ({filteredReleases.length}):
          </span>
          {filteredReleases.map((rel) => {
            const isActive = activeVersion === rel.version;
            return (
              <button
                key={rel.version}
                onClick={() => scrollToRelease(rel.version)}
                style={{
                  background: isActive ? '#8A67F6' : '#FAF8FC',
                  color: isActive ? '#ffffff' : '#111116',
                  border: isActive ? '1px solid #8A67F6' : '1px solid rgba(138, 103, 246, 0.14)',
                  borderRadius: 8,
                  padding: '5px 10px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s ease',
                }}
              >
                {rel.version.split(' ')[0]}
              </button>
            );
          })}
        </div>

        {/* Full-Width Left-Aligned Timeline Cards */}
        <div className="timeline-full">
          {filteredReleases.length === 0 ? (
            <div style={{ background: '#ffffff', borderRadius: 24, padding: 60, textAlign: 'center', border: '1.5px solid var(--line)' }}>
              <h3 style={{ fontSize: 22, color: '#111116', marginBottom: 8 }}>No matching releases found</h3>
              <p style={{ color: 'var(--muted)', fontSize: 15 }}>Try clearing your search query or switching to the 'All' tag.</p>
            </div>
          ) : (
            filteredReleases.map((rel) => {
              const isExpanded = expandedVersions[rel.version] !== false;
              const anchorId = 'rel-' + rel.version.replace(/[^a-zA-Z0-9]/g, '-');
              return (
                <div
                  key={rel.version}
                  id={anchorId}
                  className="timeline-entry"
                  style={{ marginBottom: 28, paddingLeft: 0, scrollMarginTop: 150 }}
                >
                  <div
                    className="timeline-content"
                    style={{
                      padding: '32px 36px',
                      background: '#ffffff',
                      borderRadius: 24,
                      border: '1.5px solid rgba(138, 103, 246, 0.20)',
                      boxShadow: 'var(--shadow-card)',
                    }}
                  >
                    {/* Header bar */}
                    <div
                      className="timeline-head"
                      style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}
                      onClick={() => toggleExpand(rel.version)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <span className="timeline-version" style={{ fontSize: 16, fontWeight: 850, color: '#111116' }}>
                          {rel.version}
                        </span>
                        <span
                          className="timeline-badge"
                          style={{
                            background:
                              rel.tag === 'LATEST' || rel.tag === 'NEXT'
                                ? '#059669'
                                : rel.tag === 'SECURITY'
                                ? '#DC2626'
                                : rel.tag === 'RUST CORE'
                                ? '#D97706'
                                : '#8A67F6',
                            color: '#ffffff',
                            fontWeight: 700,
                            padding: '4px 10px',
                            borderRadius: 6,
                            fontSize: 11,
                          }}
                        >
                          {rel.tag}
                        </span>
                        <span className="timeline-date" style={{ color: '#69697A', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
                          {rel.date}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontSize: 12, color: '#8A67F6', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                          {isExpanded ? 'Collapse' : 'Expand Details'}
                        </span>
                        <span style={{ fontSize: 22, color: '#8A67F6', fontWeight: 800 }}>
                          {isExpanded ? '−' : '+'}
                        </span>
                      </div>
                    </div>

                    <h3
                      className="timeline-title"
                      style={{ cursor: 'pointer', marginTop: 16, marginBottom: 14, fontSize: 22, fontWeight: 850, color: '#111116' }}
                      onClick={() => toggleExpand(rel.version)}
                    >
                      {rel.title}
                    </h3>

                    {isExpanded && (
                      <div className="timeline-body" style={{ marginTop: 22, borderTop: '1px solid rgba(138, 103, 246, 0.12)', paddingTop: 20 }}>
                        {rel.categories.map((cat) => (
                          <div key={cat.name} style={{ marginBottom: 24 }}>
                            <div
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                fontWeight: 800,
                                color: '#8A67F6',
                                textTransform: 'uppercase',
                                letterSpacing: '.06em',
                                marginBottom: 12,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                              }}
                            >
                              <span>✦</span>
                              <span>{cat.name}</span>
                            </div>

                            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                              {cat.items.map((item, idx) => (
                                <li
                                  key={idx}
                                  style={{
                                    position: 'relative',
                                    paddingLeft: 22,
                                    marginBottom: 10,
                                    fontSize: 14.5,
                                    lineHeight: 1.68,
                                    color: '#2D283E',
                                  }}
                                >
                                  <span
                                    style={{
                                      position: 'absolute',
                                      left: 0,
                                      top: 2,
                                      color: '#8A67F6',
                                      fontWeight: 800,
                                      fontSize: 14,
                                    }}
                                  >
                                    →
                                  </span>
                                  {formatItem(item)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      <Footer />
    </>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Changelog />);
}
