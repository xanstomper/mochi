---
name: mochi-automation-surface
description: Use mochi's native browser, computer, device, email, docs, canvas, and schedule tools against real targets — when to choose the live Celeste bridge over headless, how to probe the NDJSON browser daemon with `--once`, when to fall back to adb/xdotool, and the verification pattern for each. Use when the task says "drive the user's browser", "open this app", "send this email", "type into this Doc", or any automation that needs the user's logged-in state.
---

# Mochi's automation surface (browser, computer, device, email, docs, canvas, schedule)

Mochi ships real, working automation tools — but choosing the right backend and
knowing the failure mode of each is what separates a working flow from a
10-token retry spiral. This skill is the mochi-specific map on top of the
generic `browser-automation` skill.

## 1. Tool selection matrix

| Task shape | Tool | Backend | Why |
|---|---|---|---|
| Read a page (HTML/text/links/inputs/console) | `browser` | `auto` or `headless` | headless is fine — cookies not needed |
| Click / type / fill / select on a page you're logged into | `browser` | `live` (Celeste) | only `live` can see the user's cookies |
| Drive the user's visible Brave tab interactively | `browser` | `live` | explicit ops: navigation + getURLs |
| Screenshot what's on the desktop right now | `computer` | native | gnome-screenshot fallback inside the tool |
| Tap a button on a phone | `device` | adb | desktop tools can't reach a phone |
| Move a desktop window to the front | `device` | xdotool/wmctrl | cheaper than `computer` click |
| Edit a real Google Doc the user owns | `docs` | keystroke-driven on the live browser | docs are keyboard-driven — use the live backend |
| Send an email from the user's Gmail | `email` | `mochi browser login` first, then send | persistent profile is required |
| Render a visual plan | `canvas` | local HTML + excalidraw | no live browser needed |
| Schedule a recurring job | `schedule` or `cron` | HTTP daemon or local | pick one — don't both |
| Run a shell command on the host | `shell` | exec policy gate | reuse, never `device.shell` |

Default to `auto` for `browser` unless you specifically need the user's
cookies — `auto` uses live for read-shaped commands and headless as a
fallback. Never silently retarget a click/typing between browsers.

## 2. Probe the browser daemon BEFORE driving it

The browser daemon is NDJSON over stdin/stdout, not HTTP. Probing it the wrong
way hangs forever (the docs warn about this):

```bash
echo '{"cmd":"browser.status","args":{}}' | node scripts/browser-daemon.mjs --once
```

Returns within ~200ms the engines, profile, and live-bridge state. Use this
to confirm `live` is ready before issuing a `browser` tool call that depends
on it. `mochi browser status` is the human-readable wrapper.

The health check is fast and free — never skip it on first task entry.

## 3. Live vs headless decision tree

```
Need cookies / logged-in state?
  ├─ NO  → headless (cheaper, isolated, parallelizable)
  └─ YES → is Celeste daemon reachable at :9126?
              ├─ NO  → refuse the task; tell the user to start Celeste
              └─ YES → use live backend; one in-flight tab at a time
```

A live selector miss is a finding, not a reason to fall back to headless —
re-check the selector, wait for the right state, retry. Silent retargeting to
a different browser is a hard refusal in `auto`.

## 4. Computer / device hygiene

- Screenshot first, click second — coordinates are a guess without it.
- For desktop xdotool: `device` with action `focus` is cheaper than
  `computer` with click — choose the cheaper tool.
- Android adb: `input` is faster than `tap`+`swipe`+`text` for multi-step
  sequences. Batch where possible.
- iOS simulators: `simctl` only — the `device` tool maps the verb cleanly.

## 5. Email / docs: verify signed-in state first

`mochi browser login https://accounts.google.com` opens a real headed browser
**once** and writes the persistent profile. Until that profile exists, both
`email` and `docs` will return an actionable sign-in error rather than
failing silently. Always check `mochi browser status` → "persistent profile:
exists" before promising to send a doc or email.

## 6. Schedule — pick one

`mochi cron add …` writes to `.mochi/cron.json` locally; `mochi daemon cron
add …` writes via HTTP. Concurrent writes to both can lose jobs. Pick the
one that matches how the daemon was started and stick to it.

`timeoutMs` is real — a hung job gets an abort signal, not a stale lock.
`paused` is sticky; `mochi cron resume <id>` to re-enable.

## 7. Verification pattern (the part mochi infers correctly)

After any automation:

1. Assert the side effect, not the action — confirm the email landed in
   Sent, the Doc has the new paragraph, the phone app is foreground. A
   screenshot proves action; an API/DOM probe proves effect.
2. Run `mochi browser status` after `live` ops to confirm no orphan tabs.
3. Run `mochi bg list` after scheduling anything to confirm the job exists.

## Pitfalls

- Probing the browser daemon with curl against the wrong port (NDJSON, not
  HTTP) hangs and eventually deadlocks the PTY. Use the `--once` flag.
- Using `computer` to move a desktop window when `device focus` would do —
  `computer` allocates a screen-capture session that you then keep warm.
- Sending email without `mochi browser login` first — the action fails
  silently with a useless error. Probe before promising.
- `mochi cron add` and `mochi daemon cron add` racing each other on the
  same job name — the JSON file gets clobbered.
- `device` with `xdotool` while Wayland is active — Wayland has no global
  keystroke channel; `device` will silently no-op or fail. Check
  `echo $XDG_SESSION_TYPE` first if the user mentions Wayland.
- Live ops that block on a selector waiting for a human input (a captcha,
  a 2FA prompt) — the daemon will time out after 30s and detach the
  debugger. Don't promise "I filled it" until the post-condition is
  asserted.

## When NOT to use this skill

- Writing **tests** with Playwright — use `browser-automation` instead;
  this skill is for ad-hoc live automation, not assertion flows.
- Browser-only scraping where headless suffices and you're not logged in —
  skip Celeste entirely, use `browser` with `backend: "headless"`.
- Tasks that don't need automation at all — don't reach for `browser` when
  `curl` or `shell` will do it faster.
