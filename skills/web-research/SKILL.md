---
name: web-research
description: Gather information from multiple live web sources with mochi's built-in browser tool — extract clean page content, compare sources in tabs, and cite every claim. Use for current facts, prices, docs, news, or any question a single page cannot answer alone.
---

# Web Research With The Built-In Browser

The generic `research` skill covers search strategy; this one covers driving
mochi's own `browser` tool to pull evidence off real pages and turn it into a
cited answer. One page is a claim — research means corroboration.

## 1. Plan before opening anything
- Write the questions the answer must settle, and what a good source for each looks like (official docs, vendor page, primary data, reputable reporting).
- Prefer primary sources. A blog summarizing a changelog is a lead, not evidence — open the changelog.

## 2. Extract, don't scrape raw HTML
- `browser navigate` to the source, then `browser extract` — it returns the main content as clean markdown-ish text (nav/aside/scripts stripped) and, for data pages, the largest table as structured rows.
- Use `extract` with a selector when only one section matters (article body, results table, pricing grid).
- `text` is the fallback for odd layouts; `html` is the last resort (token-expensive, noisy).

## 3. Work sources in parallel tabs
- `browser newtab <url>` per source, `browser tabs` to see the set, `browser switchtab <index|url-part>` to revisit one.
- Tabs and login state persist across calls, so a source you opened ten steps ago is still there — don't re-navigate and lose your place.
- Close dead ends with `closetab` so the tab list stays a map of your live evidence.

## 4. Wait for the page you actually need
- JS-heavy pages: `waitfor networkidle` before extracting, or `waitfor <selector>` for the specific element that carries the data.
- After a search/filter interaction, `waitfor url:<part>` confirms the route changed before you extract the wrong results page.
- If the extract comes back as a shell ("Loading…", empty app root), the data wasn't there yet — wait on a signal, not on `waitMs` guesses.

## 5. Corroborate and cite
- Every load-bearing claim needs two independent sources, or one primary source. Note where sources disagree instead of averaging them.
- Cite as you go: claim → URL → what the page showed. Record the page title and the access date for time-sensitive facts (prices, versions, availability).
- A page that failed to load, a paywall, or a login wall is a finding — say so, don't silently substitute a weaker source.

## Pitfalls
- Extracting before the page settles: the most common cause of "the site has no data" is reading the loading shell.
- Trusting the first result's snippet instead of opening it — snippets are stale, truncated, and sometimes about a different product version.
- Losing provenance: if you can't point at the tab/URL a number came from, it doesn't go in the answer.
