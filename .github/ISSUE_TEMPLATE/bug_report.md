name: Bug report
about: Report a bug in mochi
title: '[bug] '
labels: bug
assignees: ''

---

**Describe the bug**

A clear and concise description of what the bug is.

**To reproduce**

Steps to reproduce the behavior:

1. Run `mochi ...`
2. With model `...`
3. See error

**Expected behavior**

A clear and concise description of what you expected to happen.

**Actual behavior**

What actually happened. Include the full error message and stack trace if applicable.

**Environment**

- OS: [e.g. macOS 15, Ubuntu 24.04, Windows 11]
- Architecture: [e.g. arm64, x86_64]
- Mochi version: [output of `mochi --version`]
- Installation method: [brew, scoop, go install, npm, docker, curl]
- Terminal: [e.g. iTerm2, GNOME Terminal, Windows Terminal, Alacritty]
- `$TERM`: [e.g. xterm-256color]
- Locale: [e.g. en_US.UTF-8]

**Screenshots / recordings**

If applicable, add screenshots or a screen recording to help explain the problem.

**Additional context**

Add any other context about the problem here, such as your `MOCHI.json` (redact secrets) or session log.

**Logs**

If you can reproduce the bug, attach the log output:

```bash
mochi --debug 2>&1 | tee /tmp/mochi.log
```
