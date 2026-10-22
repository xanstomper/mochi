---
name: mochi-automation-surface
description: Use mochi's real automation surface — the headless browser tool with its persistent profile, the web fetch/search/crawl read tools, background tasks, daemon cron schedules, and the opt-in computer tool for desktop (X11) control. Use when the task says "open this page", "click/type into this site", "check what the page shows", "run this in the background", or "schedule this". There is no device/email/docs tool, no live-browser bridge, and no browser CLI subcommand — do not invent them.
---

# Mochi's automation surface (browser, fetch, background, cron, computer)

Mochi's automation is deliberately small: one real browser tool, three
read/fetch tools, a background-task tool, the daemon's cron, and one
opt-in desktop tool. This skill is the mochi-specific map — what each
piece actually does, its failure modes, and how to verify effects.

## 1. Tool selection

| Task shape | Tool | Why |
|---|---|---|
| Read a static page / docs / article | `fetch` | cheapest; no browser process at all |
| Search the web, then read results | `web_search`, then `fetch` | search first, fetch the one page that matters |
| Crawl a documentation site (same host) | `web_crawl` | bulk read without browser overhead |
| Dynamic/JS page: read rendered text, links, inputs | `browser` (`navigate`, `text`, `links`, `inputs`) | headless Chromium renders the page first |
| Click / type / fill / select / press / hover / scroll | `browser` | the only tool that can act on a page |
| Run JS in the page, probe DOM state | `browser` (`eval`) | returns the JSON-serialized result |
| Visual check of a page | `browser` (`screenshot`) | supporting evidence — pair with a DOM probe |
| Act on the desktop itself (native apps, OS dialogs) | `computer` (`click`, `type`, `key`, `screenshot`) | X11 pointer/keyboard injection; opt-in only — see the note below the table |
| Long-running shell work | `bg_task` tool, inspect via `mochi bg list` / `mochi bg logs <id>` | survives the turn; kill via `mochi bg kill <id>` |
| Recurring scheduled prompt | daemon cron: `mochi daemon cron add "<prompt>" --schedule "every 30m"` | requires the daemon running; list/remove via the same route |

Desktop control exists as exactly one tool: `computer` (Linux/X11 —
screenshots, pointer, keyboard). It is **off by default** under its own
permission tier, stricter than shell: it only runs after an explicit
opt-in (`permissions.computer=true` in config, or `MOCHI_COMPUTER=1` for
the session), it is never auto-approved, and headless runs deny it. If it
returns a permission denial, report that — do not hunt for another route
to the desktop. Every `computer` action ends with a fresh screenshot
saved under the workspace state dir; check it before the next action.

There are no `device`, `email`, `docs`, or `canvas` tools and no phone
control (no adb). If a task needs the user's phone, say so — don't reach
for a tool that doesn't exist.

## 2. How the browser tool actually works

- The `browser` tool shells out to `scripts/browser-driver.mjs` (plain
  node) once per call and parses the single JSON object it prints. There is
  no browser daemon, no port, and nothing to "probe" before calling — just
  call the tool.
- The driver loads the **globally installed** Playwright (resolved from
  `npm root -g`, or `$MOCHI_BROWSER_NODE_MODULES`). If Playwright isn't
  installed, calls fail with a `[browser exit …]` driver error — report
  that instead of retrying.
- It is **headless Chromium** (the driver supports `--headed`, but the tool
  doesn't expose it). There is no "live" backend attached to the user's own
  browser and no access to the user's existing browser session.
- **State persists across calls**: the driver launches a persistent context
  on a profile dir — default `~/.cache/mochi/browser-profile`, override
  with the `profile` arg or `$MOCHI_BROWSER_PROFILE`. Cookies/localStorage/
  logins done *in this browser* survive between calls, so multi-step flows
  (log in → navigate → act) work. There is no `mochi browser login`
  command; a login is just a `browser` flow you drive with
  navigate/type/click.
- Actions: `navigate|get`, `click`, `type`, `fill`, `press` (key),
  `scroll` (selector or pixels), `waitfor`, `select`, `hover`, `text`,
  `links`, `html`, `inputs`, `eval`, `screenshot`, `snap`. Prefix `url:` to
  open a page and act in one call.
- Each call is bounded (45s default tool timeout; navigation 30s). A hung
  page surfaces as a timeout/driver error, not a silent hang.

## 3. Verification pattern

After any browser action:

1. Assert the **effect**, not the action — re-read state with `text`,
   `inputs`, or an `eval` DOM probe (e.g. the submitted item is in the
   list, the URL changed, the toast text is present). A screenshot is
   supporting evidence, never the only proof.
2. Read the result's **console errors**: the driver collects page console
   errors/pageerrors and the tool surfaces them in the result even when
   the action "succeeded". A click that produced a page error didn't work.
3. For background work, confirm with `mochi bg list`; for cron, list jobs
   via `mochi daemon cron list` — don't promise a schedule exists until
   it's listed.

## Pitfalls

- Selector misses on dynamic pages: `waitfor` the element (or the state
  you need) before clicking instead of retrying the click blindly.
- Login walls, captchas, and 2FA: the browser is headless and unattended —
  it cannot receive a human's 2FA prompt. If a flow needs one, stop and
  tell the user; don't claim the form was submitted.
- Assuming the user's cookies: the persistent profile is mochi's own,
  starting empty. Being logged in on the user's daily browser means
  nothing here.
- Using `browser` where `fetch` or `shell`+curl suffices — a browser call
  costs a Chromium launch; plain reads don't need it.
- Cron confusion: cron jobs live in the daemon (`mochi daemon cron …`,
  daemon must be running). Editing files under `.mochi/` by hand does not
  create a job.

## When NOT to use this skill

- Writing Playwright **tests** — use the `browser-automation` skill; this
  one is for ad-hoc automation with mochi's built-in tools.
- Pure API work — if the service has an API or CLI, drive that from
  `shell` instead of automating its web UI.
