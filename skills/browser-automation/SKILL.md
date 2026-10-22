---
name: browser-automation
description: Automate real browsers for testing and scraping — Playwright-first flows, selector strategy, waiting discipline, and anti-flake patterns. Use when writing E2E tests, scraping a JS-rendered site, taking screenshots, or automating any browser workflow.
---

# Browser Automation Procedure

Flaky automation is worse than no automation. The discipline is: stable selectors, explicit waits, and deterministic data.

## 1. Playwright first (choose the tool by need)
- Playwright: multi-browser, auto-waiting, best-in-class network control — the default for tests and automation.
- Puppeteer: fine for Chrome-only scraping. Raw CDP: only when driving an already-running browser via the DevTools protocol.
- Never Selenium for new work — every capability it has, Playwright supersedes.

## 2. Selector strategy (in strict order of preference)
- `getByRole('button', { name: 'Submit' })` / `getByLabel` — accessible semantics survive redesigns and assert a11y for free.
- `getByText` for content; data-testid LAST (it's a contract you must maintain); CSS/XPath chains never (they encode layout, which changes).
- If a role selector can't find it, that's a finding: the element probably isn't accessible. Fix the markup, not the selector.

## 3. Waiting discipline (the anti-flake core)
- Auto-waiting is the default: Playwright's locators wait for actionable states. Never `waitForTimeout(3000)` — a hardcoded sleep is a race condition dressed as a fix.
- Wait for SIGNALS not durations: `expect(locator).toBeVisible()`, `waitForURL`, `waitForResponse` on the specific API call the UI triggers.
- Network-dependent flows: route/fulfill the API (mock at the protocol level) rather than waiting for real backends.

## 4. Determinism requirements
- Fixed data: seed the database or intercept APIs; tests must not depend on "a user named X exists" from a prior run.
- Timezone/locale pinned (`TZ=UTC`, fixed clock via `page.clock`); animations disabled (`reducedMotion: 'reduce'`); fonts preloaded before screenshot assertions.
- Parallel-safe: no test mutates shared state another test reads. One browser context per test (free isolation).

## 5. Verification patterns
- Assertions over screenshots for behavior; visual snapshots for REGRESSION (compare against baseline, not truth-from-scratch).
- Screenshots: full-page for layout review, element-scoped for components. Record video/trace on failure (`trace: 'on-first-retry'`) — the trace viewer is the debugger.
- Scrape flows: respect robots.txt and rate limits, cache raw HTML before parsing, and re-verify selectors monthly (sites rot).

## Pitfalls
- Testing through the UI what you could test via API: UI tests are for the INTEGRATION, not for data setup — seed via API/DB, act via UI, assert via UI.
- `page.$eval` one-offs that bypass locator retry semantics — the API you reach for determines your flake rate.
- Forgetting downloads/popups open new pages: the context listener must be registered BEFORE the triggering click.

## 6. Driving mochi's built-in `browser` tool instead
For ad-hoc automation (not test suites), mochi's own `browser` tool wraps a
persistent-profile driver. What survives across calls: cookies/localStorage
(via a storageState snapshot per profile — Chromium alone drops session
cookies) and the open TAB SET. What does NOT: unsubmitted page state —
pages reopen from their URLs, so typed-but-unsent form fields are lost
between calls. Consequences:
- Profiles: the `profile` arg is a NAME (slugs only; directory paths are
  refused — a profile is a credential store). `profiles` lists them,
  `revokeprofile` destroys a profile's logins, `forgetprofile` clears a
  revoked name. Reuse the same name to resume a login; first use mints
  the profile and the result says so. A result warning about an
  `ephemeral` fallback means that call's logins did NOT persist.
- Multi-action flows are ONE `batch` call: `command=batch` with
  `js='[{"command":"fill","args":["#user","alice"]}, …]'` — steps run in
  one live session and stop at the first failure. Single calls are for
  navigation, reads, and one-shot actions. `tabs` lists the tab set,
  `newtab [url]` opens one, `switchtab <index|url-part>` changes the
  active tab, `closetab` removes one.
- Reading: `extract [css]` returns main content as clean markdown plus
  the largest table as structured rows. `a11y [css]` returns the
  accessibility tree (roles/names/states) — more stable than DOM scrapes
  on dynamic pages. `netlog [n|clear]` returns the session's request log
  (method/URL/status) for verifying an action actually hit the API.
- Waiting: `waitfor` takes a selector, a load state (`networkidle`,
  `load`, `domcontentloaded`), `url:<part>`, `response:<url-part>` (the
  fetch a click triggers — wait for IT, not the DOM),
  `<css>::state:<visible|hidden|enabled|disabled>`, or
  `<css>::text:<substr>`. Waits are signal-shaped (per §3): wait for the
  signal the next step needs, never a bare `waitMs`.
- Frames and files: pass `frame` (iframe selector or name) to act inside
  an iframe (payment widgets); `upload <css> <path>` sets a file input;
  `download <css> [dest]` clicks a trigger and saves the resulting
  download — the tool registers the wait before the click, so the §5
  popup/download race is handled.
- Console errors and page errors ride along in every result — treat them
  as verification evidence, per the `mochi-automation-surface` skill's
  assert-the-effect rule.
